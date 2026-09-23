import crypto from "crypto";
import { Router } from "express";
import { db } from "../db";
import { webflowClient } from "../services/webflow-client";
import { reconcileAll, seedDefaultTiers } from "../services/access";

const router = Router();

const CLIENT_ID = process.env.WEBFLOW_CLIENT_ID || "";
const CLIENT_SECRET = process.env.WEBFLOW_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback";
const SCOPES = process.env.WEBFLOW_SCOPES || "sites:read,users:read,users:write";
const APP_BASE_URL = process.env.APP_PUBLIC_URL || "http://localhost:3000";

/** Step 1: redirect the installer to Webflow's authorization screen. */
router.get("/authorize", (_req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.split(",").join(" "),
  });
  res.redirect(`https://webflow.com/oauth/authorize?${params.toString()}`);
});

/** Step 2: exchange the code, persist the installation, register webhooks, seed tiers, kick off first sync. */
router.get("/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    const tokenRes = await fetch("https://api.webflow.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      res.status(502).send(`Token exchange failed: ${body}`);
      return;
    }

    const tokenJson = (await tokenRes.json()) as { access_token: string; scope?: string };

    const sitesRes = await fetch("https://api.webflow.com/v2/sites", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const sitesJson = (await sitesRes.json()) as { sites: Array<{ id: string }> };
    const siteId = sitesJson.sites?.[0]?.id;

    if (!siteId) {
      res.status(502).send("No site returned for this installation");
      return;
    }

    const adminToken = crypto.randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO installations (site_id, access_token, scopes, admin_token, installed_at, uninstalled_at)
       VALUES (?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(site_id) DO UPDATE SET access_token = excluded.access_token, scopes = excluded.scopes,
         admin_token = excluded.admin_token, uninstalled_at = NULL`
    ).run(siteId, tokenJson.access_token, tokenJson.scope || SCOPES, adminToken);

    seedDefaultTiers(siteId);

    // Member-related triggers keep the local mirror current; the site id rides along in the query string.
    const q = `?site=${encodeURIComponent(siteId)}`;
    await webflowClient.registerWebhook(siteId, "user_account_added", `${APP_BASE_URL}/webhooks/member-created${q}`);
    await webflowClient.registerWebhook(siteId, "user_account_updated", `${APP_BASE_URL}/webhooks/member-updated${q}`);
    await webflowClient.registerWebhook(siteId, "user_account_deleted", `${APP_BASE_URL}/webhooks/member-deleted${q}`);
    await webflowClient.registerWebhook(siteId, "app_uninstall", `${APP_BASE_URL}/webhooks/app-uninstalled${q}`);

    // Initial mirror; do not block or fail the install if it errors.
    reconcileAll(siteId).catch((e) => console.error("[oauth] initial reconcile failed", e));

    // The admin token is handed to the App Panel once via the redirect; the panel keeps it in sessionStorage.
    res.redirect(`/designer-extension/index.html?installed=1&site=${siteId}&token=${adminToken}`);
  } catch (err) {
    res.status(500).send(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

export default router;
