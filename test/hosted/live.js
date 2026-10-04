/**
 * Live check of hosted mode against real AnyList: the hosted server with a
 * test signing key (Cloudflare can't be in front locally) and a real,
 * WebSocket-less AnyList client with its own token cache. Read-only, on the
 * list in ANYLIST_LIST_NAME (Test List).
 *
 *   scripts/with-anylist-creds.sh npm run test:hosted-live
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedServer } from '../../src/hosted/app.js';
import { createAccessVerifier } from '../../src/hosted/access-jwt.js';
import { createAccountRegistry, parseAccounts } from '../../src/hosted/accounts.js';
import { TEAM, AUD, makeKey, makeToken } from './jwt-helpers.js';

const listName = process.env.ANYLIST_LIST_NAME || 'Test List';
assert.equal(listName, 'Test List', 'live hosted checks run only against Test List');

const { accounts, errors } = parseAccounts({
  ANYLIST_ACCOUNTS: 'owner',
  ANYLIST_OWNER_EMAIL: 'owner@example.com',
  ANYLIST_OWNER_USERNAME: process.env.ANYLIST_USERNAME,
  ANYLIST_OWNER_PASSWORD: process.env.ANYLIST_PASSWORD,
  ANYLIST_OWNER_LIST: listName,
});
assert.deepEqual(errors, [], 'run through scripts/with-anylist-creds.sh');

const tokenDir = mkdtempSync(path.join(tmpdir(), 'anylist-hosted-live-'));
const key = makeKey('live');
const registry = createAccountRegistry(accounts, { tokenDir });
const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchCerts: async () => [key.jwk] });
const hosted = createHostedServer({ verifier, registry, version: 'live' });
await new Promise(resolve => hosted.server.listen(0, '127.0.0.1', resolve));

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${name}: ${err.message}`);
  }
}

try {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hosted.server.address().port}/mcp`), {
    requestInit: { headers: { 'Cf-Access-Jwt-Assertion': makeToken(key, { claims: { email: 'OWNER@example.com' } }) } },
  });
  const client = new Client({ name: 'hosted-live', version: '0' });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.content[0].text;
  };

  await check('health_check logs in without a WebSocket', async () => {
    assert.match(await call('health_check', {}), new RegExp(`found list: "${listName}"`));
    const anylist = registry.clientFor(accounts[0]).client;
    assert.equal(anylist.ws, undefined);
  });

  await check('token cache goes to the account\'s own file', async () => {
    assert.deepEqual(readdirSync(tokenDir), ['owner.anylist_credentials']);
  });

  await check('list_items reads the list (37 fixture items or more)', async () => {
    const text = await call('shopping_read', { action: 'list_items', include_checked: true });
    const count = Number(text.match(/\((\d+) items\)/)?.[1]);
    assert.ok(count >= 37, text.slice(0, 200));
  });

  await check('a second call fetches fresh lists (no WebSocket)', async () => {
    const anylist = registry.clientFor(accounts[0]).client;
    const before = anylist.lists;
    await call('shopping_read', { action: 'list_items' });
    assert.notEqual(anylist.lists, before, 'lists were not refetched');
  });

  await check('meal_plan_read and recipes_read work with the account\'s default list', async () => {
    await call('meal_plan_read', { action: 'list_labels' });
    await call('recipes_read', { action: 'list' });
  });

  await client.close();
} finally {
  await hosted.closeSessions();
  hosted.server.close();
  await registry.closeAll();
  rmSync(tokenDir, { recursive: true, force: true });
}

console.log(failed ? `${failed} failed` : 'All hosted live checks passed');
process.exit(failed ? 1 : 0);
