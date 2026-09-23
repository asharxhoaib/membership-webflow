// Hand-rolled typed client for Webflow Data API v2 (Users / access groups / webhooks).
// Plain fetch with a per-site token-bucket limiter and 429 backoff.

import { db } from "../db";

const API_BASE = "https://api.webflow.com/v2";

export interface WebflowAccessGroupRef {
  id?: string;
  slug?: string;
  type?: string;
}

export interface WebflowUser {
  id: string;
  isEmailVerified?: boolean;
  status?: string;
  createdOn?: string;
  lastUpdated?: string;
  lastLogin?: string;
  accessGroups?: WebflowAccessGroupRef[];
  data?: { email?: string; name?: string; [k: string]: unknown };
}

export interface WebflowWebhook {
  id: string;
  triggerType: string;
  url: string;
}

export interface WebflowAccessGroup {
  id: string;
  name?: string;
  slug: string;
}

export class WebflowApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Webflow API error ${status}: ${JSON.stringify(body)}`);
  }
}

function getAccessToken(siteId: string): string {
  const row = db
    .prepare(`SELECT access_token FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`)
    .get(siteId) as { access_token: string } | undefined;
  if (!row) throw new Error(`No active installation for site ${siteId}`);
  return row.access_token;
}

/** Token-bucket limiter respecting Webflow's documented ~60 req/min per-site limit. */
class RateLimiter {
  private tokens = 60;
  private lastRefill = Date.now();

  private refill() {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60000;
    if (elapsedMin > 0) {
      this.tokens = Math.min(60, this.tokens + elapsedMin * 60);
      this.lastRefill = now;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / 60) * 60000;
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire();
  }
}

const limiters = new Map<string, RateLimiter>();
function limiterFor(siteId: string): RateLimiter {
  if (!limiters.has(siteId)) limiters.set(siteId, new RateLimiter());
  return limiters.get(siteId)!;
}

async function request<T>(
  siteId: string,
  method: string,
  urlPath: string,
  body?: unknown,
  tokenOverride?: string,
  retryCount = 0
): Promise<T> {
  await limiterFor(siteId).acquire();
  const token = tokenOverride || getAccessToken(siteId);

  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && retryCount < 3) {
    const retryAfterSec = Number(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, retryAfterSec * 1000 * Math.pow(2, retryCount)));
    return request<T>(siteId, method, urlPath, body, tokenOverride, retryCount + 1);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new WebflowApiError(res.status, errBody);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const webflowClient = {
  listUsers(
    siteId: string,
    offset = 0,
    limit = 100
  ): Promise<{ users: WebflowUser[]; pagination?: { total?: number; offset?: number; limit?: number } }> {
    return request(siteId, "GET", `/sites/${siteId}/users?offset=${offset}&limit=${limit}`);
  },

  getUser(siteId: string, userId: string): Promise<WebflowUser> {
    return request(siteId, "GET", `/sites/${siteId}/users/${userId}`);
  },

  /** Replaces the user's native access-group membership with the given group slugs. */
  updateUserAccessGroups(siteId: string, userId: string, groupSlugs: string[]): Promise<WebflowUser> {
    return request(siteId, "PATCH", `/sites/${siteId}/users/${userId}`, { accessGroups: groupSlugs });
  },

  listAccessGroups(siteId: string): Promise<{ accessGroups: WebflowAccessGroup[] }> {
    return request(siteId, "GET", `/sites/${siteId}/accessgroups`);
  },

  /**
   * Resolves the currently signed-in visitor from their Webflow member session token
   * (the visitor's own token is used as the bearer, not the app's install token).
   */
  getSessionUser(siteId: string, memberToken: string): Promise<WebflowUser> {
    return request(siteId, "GET", `/sites/${siteId}/users/me`, undefined, memberToken);
  },

  registerWebhook(siteId: string, triggerType: string, url: string): Promise<WebflowWebhook> {
    return request(siteId, "POST", `/sites/${siteId}/webhooks`, { triggerType, url });
  },

  listWebhooks(siteId: string): Promise<{ webhooks: WebflowWebhook[] }> {
    return request(siteId, "GET", `/sites/${siteId}/webhooks`);
  },

  deleteWebhook(siteId: string, webhookId: string): Promise<void> {
    return request(siteId, "DELETE", `/webhooks/${webhookId}`);
  },
};
