# membership-webflow

A Webflow App that extends Webflow Memberships with app-level tiers, per-element gating rules, a member self-service portal and a member directory.

- Backend: Node.js 20 + TypeScript (Express), SQLite (`better-sqlite3`), Webflow Data API v2
- Designer Extension (App Panel): plain JS in `designer-extension/`
- Site runtime: vanilla JS in `runtime/` (`gate.js`, `portal.js`, `directory.js`)

## Layout

```
server/            index.ts, db.ts, routes/{oauth,webhooks,gating,members,directory}.ts, services/{access,auth,webflow-client}.ts
designer-extension/ webflow.json, index.html, panel.css, panel.js
runtime/           gate.js, portal.js, directory.js
db/schema.sql      installations, tiers, members, profile_fields, member_profile_extensions,
                   directory_opt_ins, gating_rules, tier_change_requests, audit_log
shared/types.ts
```

## Tier to access-group mapping model

Webflow owns the native member `accessGroups`. The app layers **tiers** (Free / Pro / Team by default) on top:

- Each tier has a `rank` and an optional `native_group_slug`. Several tiers may map to the same native group (many:1); an unmapped tier is purely app-level.
- **Changing a tier** (`setMemberTier`) reads the member with `GET /v2/sites/{siteId}/users/{id}`, removes every group slug that any tier manages, adds the target tier's slug, keeps unrelated groups, and writes the result with `PATCH /v2/sites/{siteId}/users/{id}`. The local mirror and audit log are then updated.
- **Manual override** sets the exact native slug list, then re-derives the tier.
- **Inbound sync** (webhooks and `reconcileAll()`) derives the tier from a member's groups: a held mapped group wins (the current tier is kept when it still matches, otherwise the lowest-ranked match); with no mapped group the first unmapped tier is used. Tier changes found this way are logged with source `sync`.
- Editing tier mappings triggers a background re-sync.

## Members, webhooks and reconciliation

On install the app registers `user_account_added`, `user_account_updated`, `user_account_deleted` and `app_uninstall` webhooks. User webhooks re-fetch the user (payloads can omit groups) and upsert the local mirror.

`reconcileAll(siteId)` in `server/services/access.ts` pages through all site users, upserts them and removes mirrored members that no longer exist. It runs after install, from the App Panel ("Re-sync from Webflow"), and every `RECONCILE_INTERVAL_MIN` minutes for all active sites (`reconcileAllSites`). Schedule it as the safety net for missed webhooks.

## Gating-rule schema

Rules live in `gating_rules` and are keyed by a generated stable id written to the element as `data-gate-id` through the Designer API, so they survive republish.

| Field | Meaning |
| --- | --- |
| `elementId` | value of `data-gate-id` (unique per site) |
| `pagePath` | `/pricing` or `*` for every page |
| `mode` | `tiers` (visible to the listed tiers), `blur_cta` (any signed-in member sees it; others get blur + CTA), `after_days` (member active at least `minDays`, optionally restricted to `tierIds`) |
| `denyAction` | `hide`, `blur` or `cta` (forced to `blur` for `blur_cta`) |
| `ctaText`, `ctaUrl` | call to action shown for `blur` / `cta` |
| `critical` | server-verified delivery of `protectedHtml` |

Endpoints: `GET /api/gating/rules?site=&page=` (decisions only), `GET /api/gated-content/{ruleId}` (critical only, Bearer session), and `/api/admin/gating` CRUD for the panel.

## Runtime embeds

```html
<script src="https://YOUR-APP-HOST/runtime/gate.js" data-site="SITE_ID" defer></script>

<div data-membership-portal></div>
<script src="https://YOUR-APP-HOST/runtime/portal.js" data-site="SITE_ID" defer></script>

<div data-membership-directory></div>
<script src="https://YOUR-APP-HOST/runtime/directory.js" data-site="SITE_ID" defer></script>
```

**Member identity.** The scripts read the visitor's Webflow member token from `window.wfMemberToken`, then `localStorage` / a cookie named `wf-member-token` (override with `data-token-key`), or you can call `window.MembershipGate.setMemberToken(token)`. The token is sent as `x-member-token` to `GET /api/session?site=`, which resolves the user via `GET /v2/sites/{siteId}/users/me` with the visitor's own token, mirrors them, and returns a one-hour signed session token used as the Bearer for every other call. Confirm how your site exposes the member token; Webflow may keep it in an HTTP-only cookie that page scripts cannot read.

**Portal.** Members edit app-managed profile fields (`member_profile_extensions`), toggle directory opt-in, and file a tier-change request. Requests are stored as `pending` in `tier_change_requests`; **no payments are processed**. Billing hook point: in `POST /api/portal/tier-request` (`server/routes/members.ts`) verify payment before inserting the row, or call `setMemberTier(siteId, memberId, tierId, "request_approval", "billing")` once your provider confirms. The owner approves or rejects in the App Panel.

**Directory.** `GET /api/directory?site=&page=&q=&f_<key>=` returns members who opted in and were approved by the owner, showing only name and fields flagged "in directory". Email and tier are never returned. The endpoint is public by design.

## Runtime security note

Client-side gating is presentation, not protection: anything sent to the browser can be read from the DOM, the network tab or the page source, and a visitor can simply delete a `display:none` or blur style. The rule decisions endpoint therefore never contains protected content. Elements marked **sensitive** (`critical`) are stored server-side (`protected_html`), left empty in the published page, and only fetched from `/api/gated-content/{ruleId}` after the server verifies the member's session and tier. Denied critical elements never receive the content. The runtime also fails closed: gated elements stay hidden until a decision is applied, and remain hidden if rules cannot be loaded. Note that non-critical elements still ship their content in the page HTML; use critical mode for anything that must not leak. Public endpoints allow any origin because auth is bearer-token based (no cookies), so CORS gives no cross-site request risk.

## App Panel

Tabs: member table (search, tier filter, bulk tier change, per-member access-group override, directory approval), pending requests, gating rules (select a Designer element; the panel writes `data-gate-id` via the element custom-attribute API), tiers and mappings, directory fields, audit log. The panel authenticates with `x-site-id` + `x-admin-token`; the token is issued at install and passed once in the OAuth redirect.

Audit log entries (actor + timestamp) are written for request approvals, manual overrides, bulk changes and sync-driven changes.

## Uninstall

`app_uninstall` revokes the OAuth token (best effort) and deletes the installation row; `ON DELETE CASCADE` purges all app tables and the audit log is deleted explicitly. Native Webflow members and access groups belong to Webflow and are untouched.

## Local dev

1. `cp .env.example .env` and fill in the Webflow client id/secret.
2. `npm install`, then `npm run dev` (serves on `PORT`, default 3000). Run from the repo root; `db/schema.sql`, `designer-extension/` and `runtime/` are resolved from the working directory.
3. Expose the server with a tunnel and set `APP_PUBLIC_URL` and `WEBFLOW_REDIRECT_URI` to the public URL (webhooks need it).
4. Install via `/oauth/authorize`; you are redirected to the panel with the admin token.
5. Set `APP_SIGNING_SECRET` to a long random value outside local dev.

Webhook requests are identified by the `site` query parameter registered at install; add signature verification with your app's client secret before production use.
