/** Test signing keys and token builders for the hosted-mode tests. */
import { generateKeyPairSync, sign } from 'node:crypto';

export const TEAM = 'https://household.cloudflareaccess.com';
export const AUD = 'aud-tag-123';

export function makeKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token signed by `key`, with Access-like claims; `claims` and `header` override the defaults. */
export function makeToken(key, { claims = {}, header = {}, now = Date.now() } = {}) {
  const seconds = Math.floor(now / 1000);
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = b64({
    aud: [AUD],
    email: 'andrew@example.com',
    exp: seconds + 3600,
    iat: seconds,
    nbf: seconds,
    iss: TEAM,
    type: 'app',
    sub: 'user-1',
    ...claims,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}
