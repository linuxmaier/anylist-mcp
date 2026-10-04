/**
 * Verifies the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) on every
 * hosted request (#25). cloudflared checks it too, but other containers on
 * the platform network can reach this server without going through
 * cloudflared, and this server writes to shared household data.
 *
 * RS256 only, with Node's crypto. Signing keys come from the team's
 * `/cdn-cgi/access/certs`, the only outbound destination this adds.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";

const CLOCK_SKEW_SECONDS = 60;
const MIN_REFETCH_MS = 5 * 60 * 1000; // after a successful fetch, for an unknown key id
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export class AccessJwtError extends Error {}

/** Checks the team domain is an https Cloudflare Access URL and returns it without a trailing slash. */
export function normalizeTeamDomain(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ACCESS_TEAM_DOMAIN must be a URL like https://<team>.cloudflareaccess.com");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.pathname !== "/") {
    throw new Error("ACCESS_TEAM_DOMAIN must be a URL like https://<team>.cloudflareaccess.com");
  }
  return url.origin;
}

async function fetchCertsFrom(teamDomain) {
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Access certs request returned HTTP ${res.status}`);
  const body = await res.json();
  return body.keys || [];
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * @param {{ teamDomain: string, aud: string, fetchCerts?: () => Promise<object[]>, now?: () => number }} options
 *   `fetchCerts` and `now` are for tests.
 * @returns {{ verify(token: string): Promise<object> }} resolves to the claims, or rejects with AccessJwtError
 */
export function createAccessVerifier({ teamDomain, aud, fetchCerts, now = () => Date.now() }) {
  const issuer = normalizeTeamDomain(teamDomain);
  const loadCerts = fetchCerts || (() => fetchCertsFrom(issuer));
  let keys = new Map();
  let nextFetchAllowed = 0;
  let inflight = null;

  async function refresh() {
    if (!inflight) {
      inflight = (async () => {
        try {
          const jwks = await loadCerts();
          const next = new Map();
          for (const jwk of jwks) {
            if (jwk.kid && jwk.kty === "RSA") next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
          }
          keys = next;
          nextFetchAllowed = now() + MIN_REFETCH_MS;
        } catch (err) {
          nextFetchAllowed = now() + RETRY_AFTER_FAILURE_MS;
          throw err;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  }

  async function keyFor(kid) {
    if (!keys.has(kid) && (inflight || now() >= nextFetchAllowed)) {
      try {
        await refresh();
      } catch (err) {
        console.error(`[access] could not fetch signing keys: ${err.message}`);
      }
    }
    return keys.get(kid);
  }

  async function verify(token) {
    if (typeof token !== "string" || token.length === 0) throw new AccessJwtError("missing Access JWT");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AccessJwtError("malformed Access JWT");

    let header;
    let claims;
    try {
      header = decodeSegment(parts[0]);
      claims = decodeSegment(parts[1]);
    } catch {
      throw new AccessJwtError("malformed Access JWT");
    }
    if (header.alg !== "RS256") throw new AccessJwtError("unexpected JWT algorithm");
    if (typeof header.kid !== "string") throw new AccessJwtError("JWT has no key id");

    const key = await keyFor(header.kid);
    if (!key) throw new AccessJwtError("unknown JWT signing key");
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verifySignature("RSA-SHA256", signed, key, Buffer.from(parts[2], "base64url"))) {
      throw new AccessJwtError("bad JWT signature");
    }

    const nowSeconds = now() / 1000;
    if (claims.iss !== issuer) throw new AccessJwtError("wrong JWT issuer");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) throw new AccessJwtError("wrong JWT audience");
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
      throw new AccessJwtError("expired JWT");
    }
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
      throw new AccessJwtError("JWT not yet valid");
    }
    if (typeof claims.email !== "string" || claims.email.length === 0) {
      throw new AccessJwtError("JWT has no email");
    }
    return claims;
  }

  return { verify };
}
