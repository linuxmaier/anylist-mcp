/**
 * The hosted server end to end over real HTTP, with an MCP SDK client, a
 * test signing key, and mock AnyList clients (no network, no credentials).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedServer } from '../../src/hosted/app.js';
import { createAccessVerifier } from '../../src/hosted/access-jwt.js';
import { createAccountRegistry, parseAccounts } from '../../src/hosted/accounts.js';
import { MockAnyListClient } from '../tools/helpers.js';
import { TEAM, AUD, makeKey, makeToken } from './jwt-helpers.js';

const key = makeKey('key-1');
const strangerKey = makeKey('key-x');

const { accounts } = parseAccounts({
  ANYLIST_ACCOUNTS: 'andrew,hanna',
  ANYLIST_ANDREW_EMAIL: 'andrew@example.com',
  ANYLIST_ANDREW_USERNAME: 'a', ANYLIST_ANDREW_PASSWORD: 'a', ANYLIST_ANDREW_LIST: 'Groceries',
  ANYLIST_HANNA_EMAIL: 'hanna@example.com',
  ANYLIST_HANNA_USERNAME: 'h', ANYLIST_HANNA_PASSWORD: 'h', ANYLIST_HANNA_LIST: 'Groceries',
});

describe('hosted server', () => {
  let hosted;
  let base;
  const mocks = {};

  before(async () => {
    const registry = createAccountRegistry(accounts, {
      createClient: account => {
        const mock = new MockAnyListClient();
        mock._items = [{ name: `${account.name}'s item`, quantity: 1, checked: false }];
        mocks[account.name] = mock;
        return mock;
      },
    });
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchCerts: async () => [key.jwk] });
    hosted = createHostedServer({ verifier, registry, version: '0.0.0-test' });
    await new Promise(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${hosted.server.address().port}`;
  });

  after(async () => {
    await hosted.closeSessions();
    hosted.server.close();
  });

  const tokenFor = email => makeToken(key, { claims: { email } });

  async function connect(email, token = tokenFor(email)) {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { 'Cf-Access-Jwt-Assertion': token } },
    });
    const client = new Client({ name: 'hosted-test', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  }

  const post = (body, headers = {}) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  };

  it('answers /healthz without a JWT', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  it('lists the tools for a signed-in account', async () => {
    const { client } = await connect('andrew@example.com');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['health_check', 'meal_plan', 'recipe_collections', 'recipes', 'shopping']);
    await client.close();
  });

  it('routes each person to their own AnyList account', async () => {
    const andrew = await connect('ANDREW@example.com');
    const hanna = await connect('hanna@example.com');
    const items = async c => (await c.client.callTool({ name: 'shopping', arguments: { action: 'list_items' } })).content[0].text;
    assert.match(await items(andrew), /andrew's item/);
    assert.doesNotMatch(await items(andrew), /hanna's item/);
    assert.match(await items(hanna), /hanna's item/);
    await andrew.client.close();
    await hanna.client.close();
  });

  it('refuses /mcp without a JWT', async () => {
    const res = await post(initialize);
    assert.equal(res.status, 403);
  });

  it('refuses a JWT signed by another key', async () => {
    const res = await post(initialize, { 'Cf-Access-Jwt-Assertion': makeToken(strangerKey, { header: { kid: 'key-1' } }) });
    assert.equal(res.status, 403);
  });

  it('refuses a valid JWT for someone without an account', async () => {
    const res = await post(initialize, { 'Cf-Access-Jwt-Assertion': tokenFor('stranger@example.com') });
    assert.equal(res.status, 403);
  });

  it("won't let one account use another's session", async () => {
    const { client, transport } = await connect('andrew@example.com');
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      'Cf-Access-Jwt-Assertion': tokenFor('hanna@example.com'),
      'Mcp-Session-Id': transport.sessionId,
      'Mcp-Protocol-Version': '2025-06-18',
    });
    assert.equal(res.status, 404);
    await client.close();
  });

  it('answers 404 for an unknown session, so clients start over', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      'Cf-Access-Jwt-Assertion': tokenFor('andrew@example.com'),
      'Mcp-Session-Id': 'no-such-session',
    });
    assert.equal(res.status, 404);
  });

  it('rejects malformed and oversized bodies', async () => {
    const auth = { 'Cf-Access-Jwt-Assertion': tokenFor('andrew@example.com') };
    assert.equal((await post('{not json', auth)).status, 400);
    assert.equal((await post('x'.repeat(1024 * 1024 + 1), auth)).status, 413);
  });

  it('survives a request target that is not a valid URL', async () => {
    const net = await import('node:net');
    const { port } = hosted.server.address();
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      socket.on('data', d => { data += d; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  it('answers 404 elsewhere', async () => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/sse`)).status, 404);
  });
});
