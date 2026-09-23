import { v4 as uuid } from "uuid";
import { db } from "../db";
import { WebflowUser, webflowClient } from "./webflow-client";
import { AuditSource, DenyAction, GateDecision, GateMode, Tier } from "../../shared/types";

// ---------- row types ----------

export interface TierRow {
  id: string;
  site_id: string;
  name: string;
  slug: string;
  rank: number;
  native_group_slug: string | null;
}

export interface MemberRow {
  site_id: string;
  id: string;
  email: string;
  name: string;
  status: string;
  tier_id: string | null;
  access_groups_json: string;
  joined_at: string;
  last_synced_at: string;
}

export interface RuleRow {
  id: string;
  site_id: string;
  element_id: string;
  page_path: string;
  label: string;
  mode: GateMode;
  tier_ids_json: string;
  min_days: number;
  deny_action: DenyAction;
  cta_text: string;
  cta_url: string;
  critical: number;
  protected_html: string;
}

export function tierFromRow(r: TierRow): Tier {
  return { id: r.id, siteId: r.site_id, name: r.name, slug: r.slug, rank: r.rank, nativeGroupSlug: r.native_group_slug };
}

export function listTierRows(siteId: string): TierRow[] {
  return db.prepare(`SELECT * FROM tiers WHERE site_id = ? ORDER BY rank ASC, name ASC`).all(siteId) as TierRow[];
}

export function getMember(siteId: string, memberId: string): MemberRow | undefined {
  return db.prepare(`SELECT * FROM members WHERE site_id = ? AND id = ?`).get(siteId, memberId) as MemberRow | undefined;
}

export function seedDefaultTiers(siteId: string): void {
  const count = (db.prepare(`SELECT COUNT(*) AS c FROM tiers WHERE site_id = ?`).get(siteId) as { c: number }).c;
  if (count > 0) return;
  const ins = db.prepare(`INSERT INTO tiers (id, site_id, name, slug, rank) VALUES (?, ?, ?, ?, ?)`);
  ins.run(uuid(), siteId, "Free", "free", 0);
  ins.run(uuid(), siteId, "Pro", "pro", 1);
  ins.run(uuid(), siteId, "Team", "team", 2);
}

// ---------- audit ----------

export function writeAudit(
  siteId: string,
  memberId: string,
  memberEmail: string,
  fromTierId: string | null,
  toTierId: string | null,
  source: AuditSource,
  actor: string,
  detail = ""
): void {
  db.prepare(
    `INSERT INTO audit_log (id, site_id, member_id, member_email, from_tier_id, to_tier_id, source, actor, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), siteId, memberId, memberEmail, fromTierId, toTierId, source, actor, detail);
}

// ---------- member mirroring ----------

function groupSlugs(user: WebflowUser): string[] {
  return (user.accessGroups || []).map((g) => g.slug).filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Chooses the tier implied by a member's native groups. If several tiers map to a held group,
 * the currently assigned tier wins when it is among them; otherwise the lowest-ranked match.
 */
function deriveTier(tiers: TierRow[], slugs: string[], currentTierId: string | null): string | null {
  const matches = tiers.filter((t) => t.native_group_slug && slugs.includes(t.native_group_slug));
  if (matches.length === 0) {
    // No mapped group held: fall back to the unmapped lowest tier (e.g. "Free") if one exists.
    const unmapped = tiers.filter((t) => !t.native_group_slug);
    return unmapped.length ? unmapped[0].id : null;
  }
  if (currentTierId && matches.some((t) => t.id === currentTierId)) return currentTierId;
  return matches[0].id; // tiers are sorted ascending by rank
}

/** Upserts a Webflow user into the local mirror; records a "sync" audit row if the tier changed. */
export function upsertMemberFromUser(siteId: string, user: WebflowUser): MemberRow {
  const tiers = listTierRows(siteId);
  const existing = getMember(siteId, user.id);
  const slugs = groupSlugs(user);
  const tierId = deriveTier(tiers, slugs, existing?.tier_id ?? null);
  const email = String(user.data?.email || existing?.email || "");
  const name = String(user.data?.name || existing?.name || "");
  const joined = user.createdOn ? new Date(user.createdOn).toISOString() : existing?.joined_at || new Date().toISOString();

  db.prepare(
    `INSERT INTO members (site_id, id, email, name, status, tier_id, access_groups_json, joined_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(site_id, id) DO UPDATE SET
       email = excluded.email, name = excluded.name, status = excluded.status, tier_id = excluded.tier_id,
       access_groups_json = excluded.access_groups_json, joined_at = excluded.joined_at, last_synced_at = datetime('now')`
  ).run(siteId, user.id, email, name, user.status || "verified", tierId, JSON.stringify(slugs), joined);

  if ((existing?.tier_id ?? null) !== tierId) {
    writeAudit(siteId, user.id, email, existing?.tier_id ?? null, tierId, "sync", "system", "Derived from native access groups");
  }
  return getMember(siteId, user.id)!;
}

export function removeMember(siteId: string, memberId: string): void {
  db.prepare(`DELETE FROM members WHERE site_id = ? AND id = ?`).run(siteId, memberId);
}

// ---------- tier changes ----------

/** Native slugs to write when moving a member to `targetTier`: keep unmanaged groups, swap managed ones. */
function nextGroupSlugs(current: string[], tiers: TierRow[], target: TierRow | null): string[] {
  const managed = new Set(tiers.map((t) => t.native_group_slug).filter((s): s is string => !!s));
  const kept = current.filter((s) => !managed.has(s));
  if (target?.native_group_slug) kept.push(target.native_group_slug);
  return Array.from(new Set(kept));
}

/** Moves a member to a tier: PATCHes native Webflow groups, updates the mirror, writes the audit log. */
export async function setMemberTier(
  siteId: string,
  memberId: string,
  tierId: string | null,
  source: AuditSource,
  actor: string,
  detail = ""
): Promise<MemberRow> {
  const member = getMember(siteId, memberId);
  if (!member) throw new Error("Member not found");
  const tiers = listTierRows(siteId);
  const target = tierId ? tiers.find((t) => t.id === tierId) || null : null;
  if (tierId && !target) throw new Error("Tier not found");

  const user = await webflowClient.getUser(siteId, memberId);
  const slugs = nextGroupSlugs(groupSlugs(user), tiers, target);
  await webflowClient.updateUserAccessGroups(siteId, memberId, slugs);

  db.prepare(`UPDATE members SET tier_id = ?, access_groups_json = ?, last_synced_at = datetime('now') WHERE site_id = ? AND id = ?`).run(
    tierId,
    JSON.stringify(slugs),
    siteId,
    memberId
  );
  if (member.tier_id !== tierId) writeAudit(siteId, memberId, member.email, member.tier_id, tierId, source, actor, detail);
  return getMember(siteId, memberId)!;
}

/** Manual override: sets the exact native access-group slugs, then re-derives the tier. */
export async function overrideAccessGroups(siteId: string, memberId: string, slugs: string[], actor: string): Promise<MemberRow> {
  const member = getMember(siteId, memberId);
  if (!member) throw new Error("Member not found");
  const clean = Array.from(new Set(slugs.filter((s) => typeof s === "string" && s.length > 0)));
  await webflowClient.updateUserAccessGroups(siteId, memberId, clean);
  const tierId = deriveTier(listTierRows(siteId), clean, member.tier_id);
  db.prepare(`UPDATE members SET tier_id = ?, access_groups_json = ?, last_synced_at = datetime('now') WHERE site_id = ? AND id = ?`).run(
    tierId,
    JSON.stringify(clean),
    siteId,
    memberId
  );
  writeAudit(siteId, memberId, member.email, member.tier_id, tierId, "override", actor, `Access groups set to [${clean.join(", ")}]`);
  return getMember(siteId, memberId)!;
}

// ---------- reconciliation ----------

/**
 * Full re-sync of a site's members from Webflow. Intended to run on a schedule (see server/index.ts)
 * or on demand from the App Panel; also removes mirrored members that no longer exist in Webflow.
 */
export async function reconcileAll(siteId: string): Promise<{ synced: number; removed: number }> {
  const seen = new Set<string>();
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await webflowClient.listUsers(siteId, offset, limit);
    const users = page.users || [];
    for (const u of users) {
      upsertMemberFromUser(siteId, u);
      seen.add(u.id);
    }
    if (users.length < limit) break;
    offset += limit;
  }
  const local = db.prepare(`SELECT id FROM members WHERE site_id = ?`).all(siteId) as Array<{ id: string }>;
  let removed = 0;
  for (const m of local) {
    if (!seen.has(m.id)) {
      removeMember(siteId, m.id);
      removed++;
    }
  }
  return { synced: seen.size, removed };
}

export async function reconcileAllSites(): Promise<void> {
  const sites = db.prepare(`SELECT site_id FROM installations WHERE uninstalled_at IS NULL`).all() as Array<{ site_id: string }>;
  for (const s of sites) {
    try {
      await reconcileAll(s.site_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[reconcile] site ${s.site_id} failed`, err);
    }
  }
}

// ---------- gating evaluation ----------

export function daysActive(member: MemberRow): number {
  const ms = Date.now() - new Date(member.joined_at).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export function normalizePath(p: string): string {
  const noQuery = p.split("?")[0].split("#")[0];
  const trimmed = noQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

export function isAllowed(rule: RuleRow, member: MemberRow | null): boolean {
  if (!member) return false;
  const tierIds = JSON.parse(rule.tier_ids_json) as string[];
  if (rule.mode === "blur_cta") return true; // any signed-in member
  if (rule.mode === "tiers") return !!member.tier_id && tierIds.includes(member.tier_id);
  // after_days: optional tier restriction plus minimum membership age
  const tierOk = tierIds.length === 0 || (!!member.tier_id && tierIds.includes(member.tier_id));
  return tierOk && daysActive(member) >= rule.min_days;
}

export function decisionFor(rule: RuleRow, member: MemberRow | null): GateDecision {
  return {
    ruleId: rule.id,
    elementId: rule.element_id,
    critical: !!rule.critical,
    allowed: isAllowed(rule, member),
    denyAction: rule.mode === "blur_cta" ? "blur" : rule.deny_action,
    ctaText: rule.cta_text,
    ctaUrl: rule.cta_url,
  };
}

// ---------- uninstall ----------

/** Deletes the installation row; ON DELETE CASCADE purges every app table for the site. */
export function purgeSite(siteId: string): void {
  db.prepare(`DELETE FROM audit_log WHERE site_id = ?`).run(siteId);
  db.prepare(`DELETE FROM installations WHERE site_id = ?`).run(siteId);
}
