export type GateMode = "tiers" | "blur_cta" | "after_days";
export type DenyAction = "hide" | "blur" | "cta";

export interface Tier {
  id: string;
  siteId: string;
  name: string;
  slug: string;
  rank: number;
  nativeGroupSlug: string | null;
}

export interface GatingRule {
  id: string;
  siteId: string;
  elementId: string;
  pagePath: string;
  label: string;
  mode: GateMode;
  tierIds: string[];
  minDays: number;
  denyAction: DenyAction;
  ctaText: string;
  ctaUrl: string;
  critical: boolean;
  protectedHtml: string;
}

/** What /api/gating/rules returns per rule (protected HTML is never included). */
export interface GateDecision {
  ruleId: string;
  elementId: string;
  critical: boolean;
  allowed: boolean;
  denyAction: DenyAction;
  ctaText: string;
  ctaUrl: string;
}

export interface SessionInfo {
  authenticated: boolean;
  sessionToken?: string;
  member?: {
    id: string;
    name: string;
    email: string;
    tierId: string | null;
    tierSlug: string | null;
    daysActive: number;
  };
}

export interface ProfileFieldDef {
  id: string;
  key: string;
  label: string;
  type: "text" | "textarea" | "select";
  options: string[];
  directoryVisible: boolean;
  filterable: boolean;
  sortOrder: number;
}

export type AuditSource = "request_approval" | "override" | "bulk" | "sync";
