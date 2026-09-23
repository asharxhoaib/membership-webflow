-- membership-webflow: local persistence schema.
-- Every table is scoped by site_id. Deleting an installations row cascades to all app data (uninstall purge).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  site_id        TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  admin_token    TEXT NOT NULL,              -- shared secret the App Panel sends as x-admin-token
  installed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at TEXT
);

-- App-level tiers. Each tier maps to at most one native Webflow access group (many tiers may share one group).
CREATE TABLE IF NOT EXISTS tiers (
  id                 TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL,
  rank               INTEGER NOT NULL DEFAULT 0,   -- higher = more access
  native_group_slug  TEXT,                          -- Webflow access group slug (nullable = unmapped)
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, slug)
);

-- Local mirror of Webflow site users.
CREATE TABLE IF NOT EXISTS members (
  site_id            TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,                 -- Webflow user id
  email              TEXT NOT NULL DEFAULT '',
  name               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'verified',
  tier_id            TEXT REFERENCES tiers(id) ON DELETE SET NULL,
  access_groups_json TEXT NOT NULL DEFAULT '[]',    -- native access group slugs
  joined_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, id)
);
CREATE INDEX IF NOT EXISTS idx_members_site_email ON members(site_id, email);

-- Definitions of app-managed custom profile fields.
CREATE TABLE IF NOT EXISTS profile_fields (
  id                 TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  key                TEXT NOT NULL,
  label              TEXT NOT NULL,
  type               TEXT NOT NULL DEFAULT 'text',   -- text | textarea | select
  options_json       TEXT NOT NULL DEFAULT '[]',     -- for select
  directory_visible  INTEGER NOT NULL DEFAULT 0,
  filterable         INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(site_id, key)
);

CREATE TABLE IF NOT EXISTS member_profile_extensions (
  site_id     TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, member_id),
  FOREIGN KEY (site_id, member_id) REFERENCES members(site_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS directory_opt_ins (
  site_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  opted_in   INTEGER NOT NULL DEFAULT 0,
  approved   INTEGER NOT NULL DEFAULT 0,           -- site owner approval
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, member_id),
  FOREIGN KEY (site_id, member_id) REFERENCES members(site_id, id) ON DELETE CASCADE
);

-- mode: tiers | blur_cta | after_days ; deny_action: hide | blur | cta
CREATE TABLE IF NOT EXISTS gating_rules (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  element_id     TEXT NOT NULL,                    -- stable generated id stored in data-gate-id
  page_path      TEXT NOT NULL DEFAULT '*',        -- '/pricing' or '*' for every page
  label          TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL,
  tier_ids_json  TEXT NOT NULL DEFAULT '[]',
  min_days       INTEGER NOT NULL DEFAULT 0,
  deny_action    TEXT NOT NULL DEFAULT 'hide',
  cta_text       TEXT NOT NULL DEFAULT '',
  cta_url        TEXT NOT NULL DEFAULT '',
  critical       INTEGER NOT NULL DEFAULT 0,       -- server-verified content delivery
  protected_html TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, element_id)
);

CREATE TABLE IF NOT EXISTS tier_change_requests (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  from_tier_id TEXT,
  to_tier_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT,
  decided_by   TEXT,
  FOREIGN KEY (site_id, member_id) REFERENCES members(site_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_requests_site_status ON tier_change_requests(site_id, status);

-- Append-only; deliberately not FK-linked so history survives member deletion.
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  member_email TEXT NOT NULL DEFAULT '',
  from_tier_id TEXT,
  to_tier_id   TEXT,
  source       TEXT NOT NULL,                      -- request_approval | override | bulk | sync
  actor        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_site_time ON audit_log(site_id, created_at);
