/**
 * Maps the email Cloudflare Access verified to that person's AnyList account
 * (#25). Configured from the environment (SOPS secrets on home-server):
 *
 *   ANYLIST_ACCOUNTS=andrew,hanna
 *   ANYLIST_ANDREW_EMAIL=...       the address they sign in to Access with
 *   ANYLIST_ANDREW_USERNAME=...    AnyList login
 *   ANYLIST_ANDREW_PASSWORD=...
 *   ANYLIST_ANDREW_LIST=...        default list; meal-plan and recipe tools need one too
 *
 * Errors name variables, never their values.
 */
import path from "node:path";
import AnyListClient from "../anylist-client.js";

const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ accounts: Array<{ name: string, email: string, username: string, password: string, defaultListName: string }>, errors: string[] }}
 */
export function parseAccounts(env) {
  const errors = [];
  const names = (env.ANYLIST_ACCOUNTS || "").split(",").map(n => n.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) errors.push("ANYLIST_ACCOUNTS is not set");

  const accounts = [];
  const seenEmails = new Set();
  for (const name of new Set(names)) {
    if (!NAME.test(name)) {
      errors.push(`ANYLIST_ACCOUNTS: "${name}" must be lowercase letters, digits and _`);
      continue;
    }
    const prefix = `ANYLIST_${name.toUpperCase()}_`;
    const get = key => (env[prefix + key] || "").trim();
    const missing = ["EMAIL", "USERNAME", "PASSWORD", "LIST"].filter(key => !get(key));
    for (const key of missing) errors.push(`${prefix}${key} is not set`);
    if (missing.length) continue;

    const email = get("EMAIL").toLowerCase();
    if (seenEmails.has(email)) {
      errors.push(`${prefix}EMAIL is the same as another account's`);
      continue;
    }
    seenEmails.add(email);
    accounts.push({
      name,
      email,
      username: get("USERNAME"),
      // Passwords aren't trimmed: leading or trailing spaces may be real.
      password: env[prefix + "PASSWORD"],
      defaultListName: get("LIST"),
    });
  }
  return { accounts, errors };
}

/**
 * One AnyListClient per account, created on first use and kept for the
 * life of the process.
 *
 * Clients run without anylist-js's WebSocket: it keeps the auth token in a
 * static field, so with two accounts in one process a reconnect could
 * authenticate as the other account. Without it, connect() fetches lists on
 * every call (#19).
 */
export function createAccountRegistry(accounts, { tokenDir, createClient } = {}) {
  const byEmail = new Map(accounts.map(a => [a.email, a]));
  const clients = new Map();
  const makeClient = createClient || (account => new AnyListClient({
    username: account.username,
    password: account.password,
    defaultListName: account.defaultListName,
    credentialsFile: path.join(tokenDir, `${account.name}.anylist_credentials`),
    webSocket: false,
  }));

  return {
    /** The account for a verified email, or null. */
    accountFor(email) {
      return byEmail.get(String(email).toLowerCase()) || null;
    },
    clientFor(account) {
      if (!clients.has(account.name)) clients.set(account.name, makeClient(account));
      return clients.get(account.name);
    },
    async closeAll() {
      for (const client of clients.values()) {
        try { await client.disconnect?.(); } catch { /* shutting down */ }
      }
      clients.clear();
    },
  };
}
