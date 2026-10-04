import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier, normalizeTeamDomain, AccessJwtError } from '../../src/hosted/access-jwt.js';
import { TEAM, AUD, makeKey, makeToken } from './jwt-helpers.js';

const key = makeKey('key-1');
const otherKey = makeKey('key-2');

describe('Access JWT verifier', () => {
  let now;
  let fetches;
  let certs;
  let verifier;

  beforeEach(() => {
    now = Date.now();
    fetches = 0;
    certs = [key.jwk];
    verifier = createAccessVerifier({
      teamDomain: TEAM,
      aud: AUD,
      now: () => now,
      fetchCerts: async () => { fetches++; return certs; },
    });
  });

  const rejects = (token, pattern) => assert.rejects(verifier.verify(token), err => {
    assert.ok(err instanceof AccessJwtError, `expected AccessJwtError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });

  it('accepts a valid token and returns its claims', async () => {
    const claims = await verifier.verify(makeToken(key, { now }));
    assert.equal(claims.email, 'andrew@example.com');
    assert.equal(fetches, 1);
  });

  it('accepts aud as a string', async () => {
    const claims = await verifier.verify(makeToken(key, { now, claims: { aud: AUD } }));
    assert.equal(claims.email, 'andrew@example.com');
  });

  it('caches the signing keys', async () => {
    await verifier.verify(makeToken(key, { now }));
    await verifier.verify(makeToken(key, { now }));
    assert.equal(fetches, 1);
  });

  it('rejects a wrong audience', () => rejects(makeToken(key, { now, claims: { aud: ['other-app'] } }), /audience/));
  it('rejects a wrong issuer', () => rejects(makeToken(key, { now, claims: { iss: 'https://evil.cloudflareaccess.com' } }), /issuer/));
  it('rejects an expired token', () => rejects(makeToken(key, { now, claims: { exp: Math.floor(now / 1000) - 120 } }), /expired/));
  it('rejects a token with no exp', () => rejects(makeToken(key, { now, claims: { exp: undefined } }), /expired/));
  it('rejects a token not valid yet', () => rejects(makeToken(key, { now, claims: { nbf: Math.floor(now / 1000) + 600 } }), /not yet valid/));
  it('rejects a token without an email', () => rejects(makeToken(key, { now, claims: { email: undefined } }), /no email/));

  it('allows a minute of clock skew', async () => {
    const claims = await verifier.verify(makeToken(key, { now, claims: { exp: Math.floor(now / 1000) - 30 } }));
    assert.ok(claims);
  });

  it('rejects a bad signature', () => {
    const [h, b] = makeToken(key, { now }).split('.');
    const forged = makeToken(otherKey, { now, header: { kid: 'key-1' } }).split('.')[2];
    return rejects(`${h}.${b}.${forged}`, /bad JWT signature/);
  });

  it('rejects a payload changed after signing', () => {
    const [h, , s] = makeToken(key, { now }).split('.');
    const body = Buffer.from(JSON.stringify({ aud: [AUD], email: 'hanna@example.com', exp: Math.floor(now / 1000) + 3600, iss: TEAM })).toString('base64url');
    return rejects(`${h}.${body}.${s}`, /bad JWT signature/);
  });

  it('rejects alg none', () => {
    const head = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url');
    const [, b] = makeToken(key, { now }).split('.');
    return rejects(`${head}.${b}.`, /algorithm/);
  });

  it('rejects HS256 (key confusion)', () => rejects(makeToken(key, { now, header: { alg: 'HS256' } }), /algorithm/));
  it('rejects a missing token', () => rejects(undefined, /missing/));
  it('rejects garbage', () => rejects('not-a-jwt', /malformed/));
  it('rejects undecodable segments', () => rejects('a.b.c', /malformed/));

  it('refetches once for an unknown key id, then rejects without refetching', async () => {
    await verifier.verify(makeToken(key, { now }));
    await rejects(makeToken(otherKey, { now }), /unknown JWT signing key/);
    // Within 5 minutes of a successful fetch, an unknown kid doesn't trigger another
    await rejects(makeToken(otherKey, { now }), /unknown JWT signing key/);
    assert.equal(fetches, 1);
  });

  it('picks up a rotated key after the refetch interval', async () => {
    await verifier.verify(makeToken(key, { now }));
    certs = [key.jwk, otherKey.jwk];
    now += 5 * 60 * 1000;
    const claims = await verifier.verify(makeToken(otherKey, { now }));
    assert.ok(claims);
    assert.equal(fetches, 2);
  });

  it('retries a failed key fetch after 30 seconds', async () => {
    let fail = true;
    verifier = createAccessVerifier({
      teamDomain: TEAM, aud: AUD, now: () => now,
      fetchCerts: async () => { fetches++; if (fail) throw new Error('network down'); return certs; },
    });
    await rejects(makeToken(key, { now }), /unknown JWT signing key/);
    await rejects(makeToken(key, { now }), /unknown JWT signing key/);
    assert.equal(fetches, 1);
    fail = false;
    now += 30 * 1000;
    assert.ok(await verifier.verify(makeToken(key, { now })));
    assert.equal(fetches, 2);
  });

  it('shares one fetch between concurrent requests', async () => {
    await Promise.all([1, 2, 3].map(() => verifier.verify(makeToken(key, { now }))));
    assert.equal(fetches, 1);
  });
});

describe('normalizeTeamDomain', () => {
  it('accepts the team URL, with or without a trailing slash', () => {
    assert.equal(normalizeTeamDomain('https://household.cloudflareaccess.com/'), TEAM);
    assert.equal(normalizeTeamDomain(TEAM), TEAM);
  });

  for (const bad of [
    'household.cloudflareaccess.com',
    'http://household.cloudflareaccess.com',
    'https://cloudflareaccess.com.evil.example',
    'https://household.cloudflareaccess.com/cdn-cgi/access/certs',
    'https://example.com',
  ]) {
    it(`rejects ${bad}`, () => assert.throws(() => normalizeTeamDomain(bad), /ACCESS_TEAM_DOMAIN/));
  }
});
