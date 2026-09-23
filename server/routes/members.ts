import crypto from "crypto";
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { requireAdmin, requireMember, signMemberSession } from "../services/auth";
import { webflowClient } from "../services/webflow-client";
import {
  TierRow,
  daysActive,
  getMember,
  listTierRows,
  overrideAccessGroups,
  reconcileAll,
  setMemberTier,
  tierFromRow,
  upsertMemberFromUser,
} from "../services/access";
import { ProfileFieldDef, SessionInfo } from "../../shared/types";

const router = Router();

// ---------- helpers ----------

interface ProfileFieldRow {
  id: string;
  site_id: string;
  key: string;
  label: string;
  type: "text" | "textarea" | "select";
  options_json: string;
  directory_visible: number;
  filterable: number;
  sort_order: number;
}

function fieldFromRow(r: ProfileFieldRow): ProfileFieldDef {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    options: JSON.parse(r.options_json) as string[],
    directoryVisible: !!r.directory_visible,
    filterable: !!r.filterable,
    sortOrder: r.sort_order,
  };
}

function listFields(siteId: string): ProfileFieldRow[] {
  return db.prepare(`SELECT * FROM profile_fields WHERE site_id = ? ORDER BY sort_order ASC, label ASC`).all(siteId) as ProfileFieldRow[];
}

function isActiveSite(siteId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`).get(siteId);
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function syncInBackground(siteId: string): void {
  reconcileAll(siteId).catch((e) => console.error("[members] background reconcile failed", e));
}

// ---------- public: session ----------

const sessionCache = new Map<string, { expires: number; body: SessionInfo }>();

/**
 * Resolves the visitor from their Webflow member token (x-member-token header), mirrors them locally,
 * and returns a short-lived signed app session token used as the Bearer for all other runtime calls.
 */
router.get("/session", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const siteId = String(req.query.site || "");
  const memberToken = String(req.headers["x-member-token"] || "");
  if (!siteId || !memberToken || !isActiveSite(siteId)) {
    res.json({ authenticated: false } as SessionInfo);
    return;
  }
  const cacheKey = siteId + ":" + crypto.createHash("sha256").update(memberToken).digest("hex");
  const hit = sessionCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    res.json(hit.body);
    return;
  }
  try {
    const user = await webflowClient.getSessionUser(siteId, memberToken);
    const member = upsertMemberFromUser(siteId, user);
    const tiers = listTierRows(siteId);
    const tier = tiers.find((t) => t.id === member.tier_id) || null;
    const body: SessionInfo = {
      authenticated: true,
      sessionToken: signMemberSession(siteId, member.id),
      member: {
        id: member.id,
        name: member.name,
        email: member.email,
        tierId: member.tier_id,
        tierSlug: tier ? tier.slug : null,
        daysActive: daysActive(member),
      },
    };
    sessionCache.set(cacheKey, { expires: Date.now() + 30000, body });
    if (sessionCache.size > 2000) sessionCache.clear();
    res.json(body);
  } catch {
    res.json({ authenticated: false } as SessionInfo);
  }
});

// ---------- public: member self-service portal ----------

router.get("/portal/me", requireMember, (req, res) => {
  const { siteId, memberId } = req.member!;
  const member = getMember(siteId, memberId);
  if (!member) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  const ext = db.prepare(`SELECT fields_json FROM member_profile_extensions WHERE site_id = ? AND member_id = ?`).get(siteId, memberId) as
    | { fields_json: string }
    | undefined;
  const opt = db.prepare(`SELECT opted_in, approved FROM directory_opt_ins WHERE site_id = ? AND member_id = ?`).get(siteId, memberId) as
    | { opted_in: number; approved: number }
    | undefined;
  const pending = db
    .prepare(`SELECT id, to_tier_id, created_at FROM tier_change_requests WHERE site_id = ? AND member_id = ? AND status = 'pending'`)
    .get(siteId, memberId) as { id: string; to_tier_id: string; created_at: string } | undefined;
  res.json({
    member: { id: member.id, name: member.name, email: member.email, tierId: member.tier_id, joinedAt: member.joined_at },
    tiers: listTierRows(siteId).map(tierFromRow),
    fields: listFields(siteId).map(fieldFromRow),
    values: ext ? (JSON.parse(ext.fields_json) as Record<string, string>) : {},
    directory: { optedIn: !!opt?.opted_in, approved: !!opt?.approved },
    pendingRequest: pending ? { id: pending.id, toTierId: pending.to_tier_id, createdAt: pending.created_at } : null,
  });
});

router.put("/portal/profile", requireMember, (req, res) => {
  const { siteId, memberId } = req.member!;
  const input = (req.body && typeof req.body.values === "object" && req.body.values) || {};
  const defs = listFields(siteId);
  const clean: Record<string, string> = {};
  for (const d of defs) {
    if (!(d.key in input)) continue;
    const v = String(input[d.key] ?? "").slice(0, d.type === "textarea" ? 2000 : 300);
    if (d.type === "select" && v !== "" && !(JSON.parse(d.options_json) as string[]).includes(v)) {
      res.status(400).json({ error: `Invalid value for ${d.label}` });
      return;
    }
    clean[d.key] = v;
  }
  const existing = db.prepare(`SELECT fields_json FROM member_profile_extensions WHERE site_id = ? AND member_id = ?`).get(siteId, memberId) as
    | { fields_json: string }
    | undefined;
  const merged = { ...(existing ? (JSON.parse(existing.fields_json) as Record<string, string>) : {}), ...clean };
  db.prepare(
    `INSERT INTO member_profile_extensions (site_id, member_id, fields_json, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(site_id, member_id) DO UPDATE SET fields_json = excluded.fields_json, updated_at = datetime('now')`
  ).run(siteId, memberId, JSON.stringify(merged));
  res.json({ values: merged });
});

router.put("/portal/directory", requireMember, (req, res) => {
  const { siteId, memberId } = req.member!;
  const optedIn = req.body && req.body.optedIn ? 1 : 0;
  // Opting out clears approval so a later opt-in must be re-approved by the site owner.
  db.prepare(
    `INSERT INTO directory_opt_ins (site_id, member_id, opted_in, approved, updated_at) VALUES (?, ?, ?, 0, datetime('now'))
     ON CONFLICT(site_id, member_id) DO UPDATE SET opted_in = excluded.opted_in,
       approved = CASE WHEN excluded.opted_in = 1 THEN directory_opt_ins.approved ELSE 0 END, updated_at = datetime('now')`
  ).run(siteId, memberId, optedIn);
  const row = db.prepare(`SELECT opted_in, approved FROM directory_opt_ins WHERE site_id = ? AND member_id = ?`).get(siteId, memberId) as {
    opted_in: number;
    approved: number;
  };
  res.json({ directory: { optedIn: !!row.opted_in, approved: !!row.approved } });
});

/**
 * Tier change request. No payment processing happens here: this only records a pending request.
 * Hook point for billing: verify payment BEFORE inserting the row (or auto-approve by calling
 * setMemberTier(..., "request_approval", "billing") once your payment provider confirms).
 */
router.post("/portal/tier-request", requireMember, (req, res) => {
  const { siteId, memberId } = req.member!;
  const member = getMember(siteId, memberId);
  const toTierId = String(req.body?.toTierId || "");
  const target = listTierRows(siteId).find((t) => t.id === toTierId);
  if (!member || !target) {
    res.status(400).json({ error: "Unknown tier" });
    return;
  }
  if (member.tier_id === target.id) {
    res.status(400).json({ error: "You are already on this tier" });
    return;
  }
  const pending = db
    .prepare(`SELECT 1 FROM tier_change_requests WHERE site_id = ? AND member_id = ? AND status = 'pending'`)
    .get(siteId, memberId);
  if (pending) {
    res.status(409).json({ error: "You already have a pending request" });
    return;
  }
  const id = uuid();
  db.prepare(`INSERT INTO tier_change_requests (id, site_id, member_id, from_tier_id, to_tier_id) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    siteId,
    memberId,
    member.tier_id,
    target.id
  );
  res.status(201).json({ pendingRequest: { id, toTierId: target.id } });
});

router.delete("/portal/tier-request", requireMember, (req, res) => {
  const { siteId, memberId } = req.member!;
  const info = db
    .prepare(`DELETE FROM tier_change_requests WHERE site_id = ? AND member_id = ? AND status = 'pending'`)
    .run(siteId, memberId);
  res.json({ ok: info.changes > 0 });
});

// ---------- admin: tiers ----------

router.get("/admin/tiers", requireAdmin, (req, res) => {
  res.json({ tiers: listTierRows(req.admin!.siteId).map(tierFromRow) });
});

router.get("/admin/access-groups", requireAdmin, async (req, res) => {
  try {
    const r = await webflowClient.listAccessGroups(req.admin!.siteId);
    res.json({ accessGroups: r.accessGroups || [] });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Webflow request failed" });
  }
});

router.post("/admin/tiers", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const name = String(req.body?.name || "").trim();
  const slug = slugify(String(req.body?.slug || name));
  if (!name || !slug) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (db.prepare(`SELECT 1 FROM tiers WHERE site_id = ? AND slug = ?`).get(siteId, slug)) {
    res.status(409).json({ error: "A tier with this slug already exists" });
    return;
  }
  const id = uuid();
  db.prepare(`INSERT INTO tiers (id, site_id, name, slug, rank, native_group_slug) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    siteId,
    name,
    slug,
    Math.floor(Number(req.body?.rank) || 0),
    req.body?.nativeGroupSlug ? String(req.body.nativeGroupSlug) : null
  );
  syncInBackground(siteId);
  res.status(201).json({ tier: tierFromRow(db.prepare(`SELECT * FROM tiers WHERE id = ?`).get(id) as TierRow) });
});

router.put("/admin/tiers/:id", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const name = String(req.body?.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const info = db
    .prepare(`UPDATE tiers SET name = ?, rank = ?, native_group_slug = ? WHERE id = ? AND site_id = ?`)
    .run(name, Math.floor(Number(req.body?.rank) || 0), req.body?.nativeGroupSlug ? String(req.body.nativeGroupSlug) : null, req.params.id, siteId);
  if (!info.changes) {
    res.status(404).json({ error: "Tier not found" });
    return;
  }
  syncInBackground(siteId);
  res.json({ tier: tierFromRow(db.prepare(`SELECT * FROM tiers WHERE id = ?`).get(req.params.id) as TierRow) });
});

router.delete("/admin/tiers/:id", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const info = db.prepare(`DELETE FROM tiers WHERE id = ? AND site_id = ?`).run(req.params.id, siteId);
  if (info.changes) syncInBackground(siteId);
  res.status(info.changes ? 200 : 404).json({ ok: info.changes > 0 });
});

// ---------- admin: profile / directory fields ----------

router.get("/admin/profile-fields", requireAdmin, (req, res) => {
  res.json({ fields: listFields(req.admin!.siteId).map(fieldFromRow) });
});

function parseFieldInput(b: any): { error?: string; label: string; type: string; options: string[] } {
  const label = String(b?.label || "").trim();
  const type = String(b?.type || "text");
  const options = Array.isArray(b?.options) ? b.options.map((o: unknown) => String(o).trim()).filter(Boolean) : [];
  if (!label) return { error: "label is required", label, type, options };
  if (!["text", "textarea", "select"].includes(type)) return { error: "type must be text | textarea | select", label, type, options };
  if (type === "select" && options.length === 0) return { error: "select fields need at least one option", label, type, options };
  return { label, type, options };
}

router.post("/admin/profile-fields", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const p = parseFieldInput(req.body);
  const key = String(req.body?.key || "").trim();
  if (p.error || !/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
    res.status(400).json({ error: p.error || "key must be lowercase letters, digits or underscores (max 32, starts with a letter)" });
    return;
  }
  if (db.prepare(`SELECT 1 FROM profile_fields WHERE site_id = ? AND key = ?`).get(siteId, key)) {
    res.status(409).json({ error: "A field with this key already exists" });
    return;
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO profile_fields (id, site_id, key, label, type, options_json, directory_visible, filterable, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, siteId, key, p.label, p.type, JSON.stringify(p.options), req.body?.directoryVisible ? 1 : 0, req.body?.filterable ? 1 : 0, Math.floor(Number(req.body?.sortOrder) || 0));
  res.status(201).json({ field: fieldFromRow(db.prepare(`SELECT * FROM profile_fields WHERE id = ?`).get(id) as ProfileFieldRow) });
});

router.put("/admin/profile-fields/:id", requireAdmin, (req, res) => {
  const p = parseFieldInput(req.body);
  if (p.error) {
    res.status(400).json({ error: p.error });
    return;
  }
  const info = db
    .prepare(
      `UPDATE profile_fields SET label = ?, type = ?, options_json = ?, directory_visible = ?, filterable = ?, sort_order = ? WHERE id = ? AND site_id = ?`
    )
    .run(p.label, p.type, JSON.stringify(p.options), req.body?.directoryVisible ? 1 : 0, req.body?.filterable ? 1 : 0, Math.floor(Number(req.body?.sortOrder) || 0), req.params.id, req.admin!.siteId);
  if (!info.changes) {
    res.status(404).json({ error: "Field not found" });
    return;
  }
  res.json({ field: fieldFromRow(db.prepare(`SELECT * FROM profile_fields WHERE id = ?`).get(req.params.id) as ProfileFieldRow) });
});

router.delete("/admin/profile-fields/:id", requireAdmin, (req, res) => {
  const info = db.prepare(`DELETE FROM profile_fields WHERE id = ? AND site_id = ?`).run(req.params.id, req.admin!.siteId);
  res.status(info.changes ? 200 : 404).json({ ok: info.changes > 0 });
});

// ---------- admin: members ----------

router.get("/admin/members", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const q = `%${String(req.query.q || "").trim()}%`;
  const tier = String(req.query.tier || "");
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = 25;
  const where = `m.site_id = ? AND (m.email LIKE ? OR m.name LIKE ?) ${tier ? "AND m.tier_id = ?" : ""}`;
  const params: unknown[] = [siteId, q, q];
  if (tier) params.push(tier);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM members m WHERE ${where}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT m.id, m.email, m.name, m.status, m.tier_id, m.access_groups_json, m.joined_at,
              t.name AS tier_name,
              COALESCE(d.opted_in, 0) AS opted_in, COALESCE(d.approved, 0) AS approved,
              (SELECT COUNT(*) FROM tier_change_requests r WHERE r.site_id = m.site_id AND r.member_id = m.id AND r.status = 'pending') AS pending
       FROM members m
       LEFT JOIN tiers t ON t.id = m.tier_id
       LEFT JOIN directory_opt_ins d ON d.site_id = m.site_id AND d.member_id = m.id
       WHERE ${where}
       ORDER BY m.joined_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
  res.json({
    page,
    pageSize,
    total,
    members: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      status: r.status,
      tierId: r.tier_id,
      tierName: r.tier_name,
      accessGroups: JSON.parse(r.access_groups_json) as string[],
      joinedAt: r.joined_at,
      directoryOptedIn: !!r.opted_in,
      directoryApproved: !!r.approved,
      pendingRequests: r.pending,
    })),
  });
});

router.post("/admin/members/bulk-tier", requireAdmin, async (req, res) => {
  const siteId = req.admin!.siteId;
  const ids: string[] = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String) : [];
  const tierId: string | null = req.body?.tierId ? String(req.body.tierId) : null;
  if (ids.length === 0 || ids.length > 200) {
    res.status(400).json({ error: "Select between 1 and 200 members" });
    return;
  }
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      await setMemberTier(siteId, id, tierId, "bulk", "admin", `Bulk change of ${ids.length} members`);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : "failed" });
    }
  }
  res.json({ results });
});

router.put("/admin/members/:id/access-groups", requireAdmin, async (req, res) => {
  const slugs: string[] = Array.isArray(req.body?.accessGroups) ? req.body.accessGroups.map(String) : [];
  try {
    const m = await overrideAccessGroups(req.admin!.siteId, req.params.id, slugs, "admin");
    res.json({ tierId: m.tier_id, accessGroups: JSON.parse(m.access_groups_json) as string[] });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "override failed" });
  }
});

router.post("/admin/members/:id/directory-approval", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  if (!getMember(siteId, req.params.id)) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  db.prepare(
    `INSERT INTO directory_opt_ins (site_id, member_id, opted_in, approved, updated_at) VALUES (?, ?, 0, ?, datetime('now'))
     ON CONFLICT(site_id, member_id) DO UPDATE SET approved = excluded.approved, updated_at = datetime('now')`
  ).run(siteId, req.params.id, req.body?.approved ? 1 : 0);
  res.json({ ok: true });
});

router.post("/admin/reconcile", requireAdmin, async (req, res) => {
  try {
    res.json(await reconcileAll(req.admin!.siteId));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "reconcile failed" });
  }
});

// ---------- admin: tier-change requests + audit ----------

router.get("/admin/requests", requireAdmin, (req, res) => {
  const status = String(req.query.status || "pending");
  const rows = db
    .prepare(
      `SELECT r.id, r.member_id, r.from_tier_id, r.to_tier_id, r.status, r.created_at, r.decided_at, m.email, m.name,
              ft.name AS from_name, tt.name AS to_name
       FROM tier_change_requests r
       JOIN members m ON m.site_id = r.site_id AND m.id = r.member_id
       LEFT JOIN tiers ft ON ft.id = r.from_tier_id
       LEFT JOIN tiers tt ON tt.id = r.to_tier_id
       WHERE r.site_id = ? AND r.status = ? ORDER BY r.created_at DESC LIMIT 200`
    )
    .all(req.admin!.siteId, status) as Array<Record<string, any>>;
  res.json({
    requests: rows.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      memberEmail: r.email,
      memberName: r.name,
      fromTierId: r.from_tier_id,
      fromTierName: r.from_name,
      toTierId: r.to_tier_id,
      toTierName: r.to_name,
      status: r.status,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    })),
  });
});

router.post("/admin/requests/:id/decision", requireAdmin, async (req, res) => {
  const siteId = req.admin!.siteId;
  const reqRow = db.prepare(`SELECT * FROM tier_change_requests WHERE id = ? AND site_id = ?`).get(req.params.id, siteId) as
    | { id: string; member_id: string; to_tier_id: string; status: string }
    | undefined;
  if (!reqRow || reqRow.status !== "pending") {
    res.status(404).json({ error: "Pending request not found" });
    return;
  }
  const approve = !!req.body?.approve;
  try {
    if (approve) await setMemberTier(siteId, reqRow.member_id, reqRow.to_tier_id, "request_approval", "admin", `Request ${reqRow.id} approved`);
    db.prepare(`UPDATE tier_change_requests SET status = ?, decided_at = datetime('now'), decided_by = 'admin' WHERE id = ?`).run(
      approve ? "approved" : "rejected",
      reqRow.id
    );
    res.json({ ok: true, status: approve ? "approved" : "rejected" });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "decision failed" });
  }
});

router.get("/admin/audit", requireAdmin, (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = 50;
  const rows = db
    .prepare(
      `SELECT a.id, a.member_id, a.member_email, a.source, a.actor, a.detail, a.created_at,
              (SELECT name FROM tiers WHERE id = a.from_tier_id) AS from_name,
              (SELECT name FROM tiers WHERE id = a.to_tier_id) AS to_name
       FROM audit_log a WHERE a.site_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`
    )
    .all(req.admin!.siteId, pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
  res.json({
    page,
    entries: rows.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      memberEmail: r.member_email,
      fromTier: r.from_name,
      toTier: r.to_name,
      source: r.source,
      actor: r.actor,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  });
});

export default router;
