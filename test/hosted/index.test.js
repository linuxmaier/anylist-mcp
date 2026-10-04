/** Starts src/hosted/index.js as a process: config errors, then a clean start and shutdown. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../../src/hosted/index.js', import.meta.url));

function start(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { child, exited, output: () => output };
}

describe('hosted entry point', () => {
  it('refuses to start without config, naming each missing variable', async () => {
    const { exited, output } = start({
      ANYLIST_ACCOUNTS: 'andrew',
      ANYLIST_ANDREW_PASSWORD: 'do-not-print-me',
      ACCESS_TEAM_DOMAIN: 'https://example.com',
    });
    assert.equal(await exited, 1);
    for (const expected of [
      'ACCESS_TEAM_DOMAIN must be a URL like https://<team>.cloudflareaccess.com',
      'ACCESS_AUD is not set',
      'ANYLIST_ANDREW_EMAIL is not set',
      'ANYLIST_ANDREW_USERNAME is not set',
      'ANYLIST_ANDREW_LIST is not set',
      'ANYLIST_TOKEN_DIR is not set',
    ]) {
      assert.ok(output().includes(expected), `missing "${expected}" in:\n${output()}`);
    }
    assert.ok(!output().includes('do-not-print-me'));
  });

  it('starts, answers /healthz, and exits cleanly on SIGTERM', async () => {
    const tokenDir = mkdtempSync(path.join(tmpdir(), 'anylist-hosted-'));
    try {
      const { child, exited, output } = start({
        ACCESS_TEAM_DOMAIN: 'https://household.cloudflareaccess.com',
        ACCESS_AUD: 'aud',
        ANYLIST_ACCOUNTS: 'andrew',
        ANYLIST_ANDREW_EMAIL: 'andrew@example.com',
        ANYLIST_ANDREW_USERNAME: 'andrew',
        ANYLIST_ANDREW_PASSWORD: 'do-not-print-me',
        ANYLIST_ANDREW_LIST: 'Groceries',
        ANYLIST_TOKEN_DIR: tokenDir,
        PORT: '0',
      });
      // PORT=0 picks a free port; read it from the startup line
      let port;
      for (let i = 0; i < 100 && !port; i++) {
        port = output().match(/listening on port (\d+)/)?.[1];
        if (!port) await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(port, `server didn't start:\n${output()}`);
      assert.equal(port === '0', false);
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(await res.text(), 'ok');

      child.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.ok(!output().includes('do-not-print-me'));
      assert.match(output(), /Accounts: andrew/);
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });
});
