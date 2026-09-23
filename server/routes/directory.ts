import { Router } from "express";
import { db } from "../db";

const router = Router();

const PAGE_SIZE = 12;

interface FieldRow {
  key: string;
  label: string;
  type: string;
  options_json: string;
  directory_visible: number;
  filterable: number;
}

/**
 * Public directory: only members who opted in AND were approved by the site owner.
 * Exposes name plus fields flagged directory_visible; email and tier are never returned.
 * Query: site, page, q (name/visible-field search), f_<key>=value (filterable fields only).
 */
router.get("/directory", (req, res) => {
  const siteId = String(req.query.site || "");
  if (!siteId || !db.prepare(`SELECT 1 FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`).get(siteId)) {
    res.status(400).json({ error: "Unknown site" });
    return;
  }
  const fields = db
    .prepare(`SELECT key, label, type, options_json, directory_visible, filterable FROM profile_fields WHERE site_id = ? ORDER BY sort_order ASC, label ASC`)
    .all(siteId) as FieldRow[];
  const visible = fields.filter((f) => f.directory_visible);
  const filterable = fields.filter((f) => f.filterable);

  const where: string[] = [`o.site_id = ?`, `o.opted_in = 1`, `o.approved = 1`];
  const params: unknown[] = [siteId];

  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const parts = [`LOWER(m.name) LIKE ?`];
    params.push(like);
    for (const f of visible) {
      parts.push(`LOWER(COALESCE(json_extract(e.fields_json, ?), '')) LIKE ?`);
      params.push("$." + f.key, like);
    }
    where.push(`(${parts.join(" OR ")})`);
  }
  for (const f of filterable) {
    const v = req.query["f_" + f.key];
    if (typeof v === "string" && v !== "") {
      where.push(`json_extract(e.fields_json, ?) = ?`);
      params.push("$." + f.key, v);
    }
  }

  const from = `FROM directory_opt_ins o
    JOIN members m ON m.site_id = o.site_id AND m.id = o.member_id
    LEFT JOIN member_profile_extensions e ON e.site_id = o.site_id AND e.member_id = o.member_id
    WHERE ${where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params) as { c: number }).c;
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const rows = db
    .prepare(`SELECT m.id, m.name, COALESCE(e.fields_json, '{}') AS fields_json ${from} ORDER BY m.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Array<{ id: string; name: string; fields_json: string }>;

  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    fields: visible.map((f) => ({ key: f.key, label: f.label })),
    filters: filterable.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.type === "select" ? (JSON.parse(f.options_json) as string[]) : [],
    })),
    members: rows.map((r) => {
      const all = JSON.parse(r.fields_json) as Record<string, string>;
      const out: Record<string, string> = {};
      for (const f of visible) if (all[f.key]) out[f.key] = all[f.key];
      return { id: r.id, name: r.name || "Member", fields: out };
    }),
  });
});

export default router;
