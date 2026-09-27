// End-to-end checks for HTTP-mode CSRF, cookie, escaping and rate-limit protections.
// Needs the optional HTTP dependencies: run with `npm run test:http` after a full `npm ci`.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { escapeHtml } from '../../src/http/security.js';

const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let dataDir;

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('HTTP server did not start');
}

// Loads /login and returns the session cookie, the CSRF token and the raw Set-Cookie header
async function getLoginPage() {
  const res = await fetch(`${BASE}/login`);
  const setCookie = res.headers.getSetCookie()[0] ?? '';
  const html = await res.text();
  const token = html.match(/name="_csrf" value="([0-9a-f]{64})"/)?.[1];
  return { cookie: setCookie.split(';')[0], token, setCookie };
}

function postForm(urlPath, cookie, fields) {
  return fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('HTTP mode security', () => {
  before(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'anylist-mcp-http-test-'));
    writeFileSync(path.join(dataDir, 'allowed-emails.txt'), 'allowed@example.com\n');
    server = spawn(process.execPath, ['src/http/index.js'], {
      env: {
        PATH: process.env.PATH,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        SERVER_SECRET_KEY: randomBytes(32).toString('hex'),
        SESSION_SECRET: randomBytes(32).toString('hex'),
        BASE_URL: BASE,
      },
      stdio: 'ignore',
    });
    await waitForHealth();
  });

  after(() => {
    server?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('escapes HTML in template values', () => {
    assert.equal(escapeHtml(`<script>alert("x")</script>&'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
  });

  it('login page embeds a CSRF token and sets a SameSite=Lax, HttpOnly cookie', async () => {
    const { token, setCookie } = await getLoginPage();
    assert.match(token ?? '', /^[0-9a-f]{64}$/);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /HttpOnly/i);
  });

  it('rejects form POSTs without a CSRF token', async () => {
    const { cookie } = await getLoginPage();
    for (const route of ['/auth/login', '/auth/register', '/auth/google', '/oauth/consent', '/setup']) {
      const res = await postForm(route, cookie, { email: 'allowed@example.com', password: 'x' });
      assert.equal(res.status, 403, route);
    }
  });

  it('rejects a CSRF token from a different session', async () => {
    const first = await getLoginPage();
    const second = await getLoginPage();
    const res = await postForm('/auth/login', second.cookie, { _csrf: first.token, email: 'a@example.com', password: 'x' });
    assert.equal(res.status, 403);
  });

  it('accepts a matching CSRF token', async () => {
    const { cookie, token } = await getLoginPage();
    const res = await postForm('/auth/login', cookie, { _csrf: token, email: 'nobody@example.com', password: 'wrong-password' });
    assert.equal(res.status, 200); // re-renders the login page with an error
    assert.match(await res.text(), /name="_csrf"/);
  });

  it('rate-limits login attempts', async () => {
    const { cookie, token } = await getLoginPage();
    let status;
    for (let i = 0; i < 12 && status !== 429; i++) {
      status = (await postForm('/auth/login', cookie, { _csrf: token, email: 'nobody@example.com', password: 'wrong' })).status;
    }
    assert.equal(status, 429);
  });

  it('rate-limits the OAuth token endpoint', async () => {
    let status;
    for (let i = 0; i < 35 && status !== 429; i++) {
      status = (await postForm('/oauth/token', '', { grant_type: 'refresh_token', refresh_token: 'nope' })).status;
    }
    assert.equal(status, 429);
  });
});
