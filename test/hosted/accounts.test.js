import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccounts, createAccountRegistry } from '../../src/hosted/accounts.js';

const ENV = {
  ANYLIST_ACCOUNTS: 'andrew, Hanna',
  ANYLIST_ANDREW_EMAIL: 'Andrew@Example.com',
  ANYLIST_ANDREW_USERNAME: 'andrew-anylist@example.com',
  ANYLIST_ANDREW_PASSWORD: 'pw-andrew-secret',
  ANYLIST_ANDREW_LIST: 'Groceries',
  ANYLIST_HANNA_EMAIL: 'hanna@example.com',
  ANYLIST_HANNA_USERNAME: 'hanna-anylist@example.com',
  ANYLIST_HANNA_PASSWORD: ' pw with spaces ',
  ANYLIST_HANNA_LIST: 'Groceries',
};

describe('parseAccounts', () => {
  it('reads each account', () => {
    const { accounts, errors } = parseAccounts(ENV);
    assert.deepEqual(errors, []);
    assert.deepEqual(accounts.map(a => [a.name, a.email, a.defaultListName]), [
      ['andrew', 'andrew@example.com', 'Groceries'],
      ['hanna', 'hanna@example.com', 'Groceries'],
    ]);
    assert.equal(accounts[1].password, ' pw with spaces ');
  });

  it('reports every missing variable by name, never a value', () => {
    const env = { ...ENV, ANYLIST_HANNA_PASSWORD: '', ANYLIST_HANNA_LIST: undefined };
    const { accounts, errors } = parseAccounts(env);
    assert.deepEqual(errors, ['ANYLIST_HANNA_PASSWORD is not set', 'ANYLIST_HANNA_LIST is not set']);
    assert.deepEqual(accounts.map(a => a.name), ['andrew']);
    for (const e of errors) assert.ok(!e.includes('pw-andrew-secret'));
  });

  it('requires ANYLIST_ACCOUNTS', () => {
    assert.deepEqual(parseAccounts({}).errors, ['ANYLIST_ACCOUNTS is not set']);
  });

  it('rejects account names that would make odd variable names', () => {
    const { errors } = parseAccounts({ ANYLIST_ACCOUNTS: 'a-b' });
    assert.match(errors[0], /"a-b" must be/);
  });

  it('rejects two accounts with the same email', () => {
    const { errors } = parseAccounts({ ...ENV, ANYLIST_HANNA_EMAIL: 'ANDREW@example.com' });
    assert.deepEqual(errors, ['ANYLIST_HANNA_EMAIL is the same as another account\'s']);
  });
});

describe('createAccountRegistry', () => {
  const { accounts } = parseAccounts(ENV);

  it('maps emails case-insensitively and rejects unknown ones', () => {
    const registry = createAccountRegistry(accounts, { createClient: a => ({ name: a.name }) });
    assert.equal(registry.accountFor('ANDREW@example.com').name, 'andrew');
    assert.equal(registry.accountFor('someone@example.com'), null);
  });

  it('creates one client per account and reuses it', () => {
    let created = 0;
    const registry = createAccountRegistry(accounts, { createClient: a => { created++; return { name: a.name }; } });
    const andrew = registry.accountFor('andrew@example.com');
    assert.equal(registry.clientFor(andrew), registry.clientFor(andrew));
    assert.notEqual(registry.clientFor(andrew), registry.clientFor(registry.accountFor('hanna@example.com')));
    assert.equal(created, 2);
  });

  it('gives each account its own token cache and no WebSocket', () => {
    const registry = createAccountRegistry(accounts, { tokenDir: '/run/anylist' });
    const andrew = registry.clientFor(registry.accountFor('andrew@example.com'));
    const hanna = registry.clientFor(registry.accountFor('hanna@example.com'));
    assert.equal(andrew._credentialsFile, '/run/anylist/andrew.anylist_credentials');
    assert.equal(hanna._credentialsFile, '/run/anylist/hanna.anylist_credentials');
    assert.equal(andrew._webSocket, false);
    assert.equal(andrew.defaultListName, 'Groceries');
  });
});
