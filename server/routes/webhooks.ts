import { Router } from "express";
import { db } from "../db";
import { removeMember, purgeSite, upsertMemberFromUser } from "../services/access";
import { webflowClient } from "../services/webflow-client";

const router = Router();

/** Resolves the site id from the query string we registered, or from the payload. */
function siteOf(req: { query: Record<string, unknown>; body?: any }): string | null {
  const q = req.query.site;
  if (typeof q === "string" && q) return q;
  const p = req.body?.payload?.siteId;
  return typeof p === "string" && p ? p : null;
}

function isActive(siteId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`).get(siteId);
}

async function syncUser(req: any, res: any): Promise<void> {
  const siteId = siteOf(req);
  const userId = req.body?.payload?.id || req.body?.payload?.userId;
  if (!siteId || !userId || !isActive(siteId)) {
    res.status(400).json({ error: "Malformed or unknown-site user webhook" });
    return;
  }
  res.status(200).json({ received: true });
  try {
    // Always re-fetch: webhook payloads may omit access groups.
    const user = await webflowClient.getUser(siteId, String(userId));
    upsertMemberFromUser(siteId, user);
  } catch (err) {
    console.error("[webhooks] user sync failed", err);
  }
}

router.post("/member-created", syncUser);
router.post("/member-updated", syncUser);

router.post("/member-deleted", (req, res) => {
  const siteId = siteOf(req);
  const userId = req.body?.payload?.id || req.body?.payload?.userId;
  if (!siteId || !userId) {
    res.status(400).json({ error: "Malformed member-deleted payload" });
    return;
  }
  removeMember(siteId, String(userId));
  res.status(200).json({ ok: true });
});

/**
 * Uninstall: revoke the OAuth token (best effort) and purge every app-owned table for the site.
 * Native Webflow members/access groups are owned by Webflow and are not touched.
 */
router.post("/app-uninstalled", async (req, res) => {
  const siteId = siteOf(req);
  if (!siteId) {
    res.status(400).json({ error: "Missing siteId" });
    return;
  }
  const row = db.prepare(`SELECT access_token FROM installations WHERE site_id = ?`).get(siteId) as { access_token: string } | undefined;
  if (row) {
    try {
      await fetch("https://api.webflow.com/oauth/revoke_authorization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.WEBFLOW_CLIENT_ID || "",
          client_secret: process.env.WEBFLOW_CLIENT_SECRET || "",
          access_token: row.access_token,
        }),
      });
    } catch (err) {
      console.error("[webhooks/app-uninstalled] revoke failed (token is deleted locally regardless)", err);
    }
  }
  purgeSite(siteId);
  res.status(200).json({ ok: true });
});

export default router;
