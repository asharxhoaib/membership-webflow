import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { optionalMember, requireAdmin } from "../services/auth";
import { RuleRow, decisionFor, getMember, normalizePath } from "../services/access";

const router = Router();

function ruleToJson(r: RuleRow) {
  return {
    id: r.id,
    elementId: r.element_id,
    pagePath: r.page_path,
    label: r.label,
    mode: r.mode,
    tierIds: JSON.parse(r.tier_ids_json) as string[],
    minDays: r.min_days,
    denyAction: r.deny_action,
    ctaText: r.cta_text,
    ctaUrl: r.cta_url,
    critical: !!r.critical,
    protectedHtml: r.protected_html,
  };
}

// ---------- public (runtime) ----------

/** Per-page gating decisions for the current visitor. Protected HTML is never included. */
router.get("/gating/rules", optionalMember, (req, res) => {
  const siteId = String(req.query.site || req.member?.siteId || "");
  const page = normalizePath(String(req.query.page || "/"));
  if (!siteId) {
    res.status(400).json({ error: "site is required" });
    return;
  }
  const member = req.member && req.member.siteId === siteId ? getMember(siteId, req.member.memberId) || null : null;
  const rules = db
    .prepare(`SELECT * FROM gating_rules WHERE site_id = ? AND (page_path = '*' OR page_path = ?)`)
    .all(siteId, page) as RuleRow[];
  res.setHeader("Cache-Control", "no-store");
  res.json({ decisions: rules.map((r) => decisionFor(r, member)) });
});

/** Server-verified critical mode: content is only returned after tier verification. */
router.get("/gated-content/:ruleId", optionalMember, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const rule = db.prepare(`SELECT * FROM gating_rules WHERE id = ?`).get(req.params.ruleId) as RuleRow | undefined;
  if (!rule || !rule.critical) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const member = req.member && req.member.siteId === rule.site_id ? getMember(rule.site_id, req.member.memberId) || null : null;
  if (!decisionFor(rule, member).allowed) {
    res.status(403).json({ error: "Not permitted" });
    return;
  }
  res.json({ html: rule.protected_html });
});

// ---------- admin (App Panel) ----------

router.get("/admin/gating", requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM gating_rules WHERE site_id = ? ORDER BY created_at DESC`).all(req.admin!.siteId) as RuleRow[];
  res.json({ rules: rows.map(ruleToJson) });
});

interface RuleInput {
  elementId?: string;
  pagePath?: string;
  label?: string;
  mode?: string;
  tierIds?: string[];
  minDays?: number;
  denyAction?: string;
  ctaText?: string;
  ctaUrl?: string;
  critical?: boolean;
  protectedHtml?: string;
}

function validate(b: RuleInput): string | null {
  if (!["tiers", "blur_cta", "after_days"].includes(String(b.mode))) return "mode must be tiers | blur_cta | after_days";
  if (b.denyAction && !["hide", "blur", "cta"].includes(b.denyAction)) return "denyAction must be hide | blur | cta";
  if (b.mode === "tiers" && (!Array.isArray(b.tierIds) || b.tierIds.length === 0)) return "tiers mode needs at least one tier";
  if (b.mode === "after_days" && !(Number(b.minDays) >= 0)) return "minDays must be >= 0";
  if (b.ctaUrl && !/^(https?:\/\/|\/)/.test(b.ctaUrl)) return "ctaUrl must be http(s) or a relative path";
  return null;
}

router.post("/admin/gating", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const b = req.body as RuleInput;
  const err = validate(b);
  if (err || !b.elementId) {
    res.status(400).json({ error: err || "elementId is required" });
    return;
  }
  const exists = db.prepare(`SELECT 1 FROM gating_rules WHERE site_id = ? AND element_id = ?`).get(siteId, b.elementId);
  if (exists) {
    res.status(409).json({ error: "A rule already exists for this element; edit it instead" });
    return;
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO gating_rules (id, site_id, element_id, page_path, label, mode, tier_ids_json, min_days, deny_action, cta_text, cta_url, critical, protected_html)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    siteId,
    b.elementId,
    b.pagePath ? (b.pagePath === "*" ? "*" : normalizePath(b.pagePath)) : "*",
    b.label || "",
    b.mode,
    JSON.stringify(b.tierIds || []),
    Math.floor(Number(b.minDays) || 0),
    b.mode === "blur_cta" ? "blur" : b.denyAction || "hide",
    b.ctaText || "",
    b.ctaUrl || "",
    b.critical ? 1 : 0,
    b.critical ? b.protectedHtml || "" : ""
  );
  res.status(201).json({ rule: ruleToJson(db.prepare(`SELECT * FROM gating_rules WHERE id = ?`).get(id) as RuleRow) });
});

router.put("/admin/gating/:id", requireAdmin, (req, res) => {
  const siteId = req.admin!.siteId;
  const b = req.body as RuleInput;
  const err = validate(b);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const info = db
    .prepare(
      `UPDATE gating_rules SET page_path = ?, label = ?, mode = ?, tier_ids_json = ?, min_days = ?, deny_action = ?,
         cta_text = ?, cta_url = ?, critical = ?, protected_html = ?
       WHERE id = ? AND site_id = ?`
    )
    .run(
      b.pagePath ? (b.pagePath === "*" ? "*" : normalizePath(b.pagePath)) : "*",
      b.label || "",
      b.mode,
      JSON.stringify(b.tierIds || []),
      Math.floor(Number(b.minDays) || 0),
      b.mode === "blur_cta" ? "blur" : b.denyAction || "hide",
      b.ctaText || "",
      b.ctaUrl || "",
      b.critical ? 1 : 0,
      b.critical ? b.protectedHtml || "" : "",
      req.params.id,
      siteId
    );
  if (info.changes === 0) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json({ rule: ruleToJson(db.prepare(`SELECT * FROM gating_rules WHERE id = ?`).get(req.params.id) as RuleRow) });
});

router.delete("/admin/gating/:id", requireAdmin, (req, res) => {
  const info = db.prepare(`DELETE FROM gating_rules WHERE id = ? AND site_id = ?`).run(req.params.id, req.admin!.siteId);
  res.status(info.changes ? 200 : 404).json({ ok: info.changes > 0 });
});

export default router;
