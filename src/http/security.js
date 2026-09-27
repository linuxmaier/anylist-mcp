import { randomBytes, timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";

// ── CSRF (synchronizer token stored in the session) ───────────────────────────

/** Returns this session's CSRF token, creating it on first use. Pass it to views as `csrfToken`. */
export function csrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

/** Rejects form POSTs whose `_csrf` field doesn't match the session's token. */
export function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const received = req.body?._csrf;
  if (
    typeof expected === "string" &&
    typeof received === "string" &&
    received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return next();
  }
  console.log(`[csrf] rejected ${req.method} ${req.path} ip=${req.ip}`);
  res.status(403).send("Invalid or missing CSRF token. Reload the page and try again.");
}

// ── HTML escaping for {{value}} template substitutions ────────────────────────

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ── Rate limiting (per client IP; `trust proxy` makes req.ip the tunnel client) ─

const limiterDefaults = { standardHeaders: "draft-8", legacyHeaders: false };

/** Credential-checking forms: password login/registration, Google sign-in, AnyList setup. */
export const authLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many attempts. Try again in 15 minutes.",
});

/** OAuth protocol endpoints called by MCP clients. */
export const oauthLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: "rate_limited", error_description: "Too many requests" },
});
