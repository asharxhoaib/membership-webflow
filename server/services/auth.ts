import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db";

const SIGNING_SECRET = process.env.APP_SIGNING_SECRET || "change-me-in-production";
const SESSION_TTL_SEC = 60 * 60;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: { siteId: string };
      member?: { siteId: string; memberId: string };
    }
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function hmac(data: string): string {
  return crypto.createHmac("sha256", SIGNING_SECRET).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Signed, short-lived token identifying a verified member of a site. */
export function signMemberSession(siteId: string, memberId: string): string {
  const payload = b64url(JSON.stringify({ s: siteId, m: memberId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC }));
  return `${payload}.${hmac(payload)}`;
}

export function verifyMemberSession(token: string): { siteId: string; memberId: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { s: string; m: string; exp: number };
    if (!parsed.s || !parsed.m || parsed.exp < Date.now() / 1000) return null;
    return { siteId: parsed.s, memberId: parsed.m };
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

/** Populates req.member when a valid bearer session is present; never rejects. */
export function optionalMember(req: Request, _res: Response, next: NextFunction): void {
  const t = bearerToken(req);
  if (t) {
    const v = verifyMemberSession(t);
    if (v) req.member = { siteId: v.siteId, memberId: v.memberId };
  }
  next();
}

export function requireMember(req: Request, res: Response, next: NextFunction): void {
  optionalMember(req, res, () => {
    if (!req.member) {
      res.status(401).json({ error: "Member session required" });
      return;
    }
    next();
  });
}

/** App Panel auth: x-site-id + x-admin-token issued at install time. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const siteId = String(req.headers["x-site-id"] || "");
  const token = String(req.headers["x-admin-token"] || "");
  if (!siteId || !token) {
    res.status(401).json({ error: "Missing admin credentials" });
    return;
  }
  const row = db
    .prepare(`SELECT admin_token FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`)
    .get(siteId) as { admin_token: string } | undefined;
  if (!row || !safeEqual(row.admin_token, token)) {
    res.status(403).json({ error: "Invalid admin credentials" });
    return;
  }
  req.admin = { siteId };
  next();
}

/** The runtime scripts live on the published site's origin, so public endpoints allow any origin (auth is bearer-token based, no cookies). */
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-member-token, x-site-id, x-admin-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}
