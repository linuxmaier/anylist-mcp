/**
 * Entry point for the hosted server (#25). Configuration comes from the
 * environment; see src/hosted/accounts.js and AGENTS.md ("Hosted mode").
 *
 *   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
 *   ACCESS_AUD          the Access application's AUD tag
 *   ANYLIST_ACCOUNTS    plus ANYLIST_<NAME>_EMAIL/_USERNAME/_PASSWORD/_LIST
 *   ANYLIST_TOKEN_DIR   writable directory for anylist-js token caches
 *   PORT                default 8000
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createAccessVerifier, normalizeTeamDomain } from "./access-jwt.js";
import { createAccountRegistry, parseAccounts } from "./accounts.js";
import { createHostedServer } from "./app.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

function loadConfig(env) {
  const errors = [];
  if (!env.ACCESS_TEAM_DOMAIN) {
    errors.push("ACCESS_TEAM_DOMAIN is not set");
  } else {
    try { normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN); } catch (err) { errors.push(err.message); }
  }
  if (!env.ACCESS_AUD) errors.push("ACCESS_AUD is not set");

  const { accounts, errors: accountErrors } = parseAccounts(env);
  errors.push(...accountErrors);

  const tokenDir = env.ANYLIST_TOKEN_DIR;
  if (!tokenDir) {
    errors.push("ANYLIST_TOKEN_DIR is not set");
  } else {
    try {
      if (!statSync(tokenDir).isDirectory()) throw new Error();
      accessSync(tokenDir, constants.W_OK);
    } catch {
      errors.push("ANYLIST_TOKEN_DIR is not a writable directory");
    }
  }

  const port = env.PORT ? Number(env.PORT) : 8000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push("PORT must be a port number");

  return { errors, accounts, tokenDir, port, teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD };
}

const config = loadConfig(process.env);
if (config.errors.length) {
  console.error("anylist-mcp hosted mode can't start:");
  for (const e of config.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const verifier = createAccessVerifier({ teamDomain: config.teamDomain, aud: config.aud });
const registry = createAccountRegistry(config.accounts, { tokenDir: config.tokenDir });
const { server, closeSessions } = createHostedServer({ verifier, registry, version });

server.listen(config.port, () => {
  console.error(`anylist-mcp ${version} (hosted) listening on port ${server.address().port}`);
  console.error(`Accounts: ${config.accounts.map(a => a.name).join(", ")}`);
  console.error(`Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
});

async function shutdown(signal) {
  console.error(`${signal} received, shutting down`);
  server.close();
  await closeSessions();
  await registry.closeAll();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
