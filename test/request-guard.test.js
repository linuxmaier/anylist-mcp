import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterMs, FALLBACK_COOLDOWN_MS } from '../src/request-guard.js';

describe('retryAfterMs', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');

  it('reads seconds from the Retry-After header', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': '120' } }, now), 120_000);
  });

  it('reads an HTTP date from the Retry-After header', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': 'Fri, 20 Nov 2026 12:05:00 GMT' } }, now), 300_000);
  });

  it('reads retry_after from a JSON body, as a buffer or a string', () => {
    assert.equal(retryAfterMs({ body: Buffer.from('{"retry_after": 90}') }, now), 90_000);
    assert.equal(retryAfterMs({ body: '{"retry_after": 30}' }, now), 30_000);
  });

  it('takes the longer of header and body', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': '120' }, body: '{"retry_after": 300}' }, now), 300_000);
    assert.equal(retryAfterMs({ headers: { 'retry-after': '600' }, body: '{"retry_after": 300}' }, now), 600_000);
  });

  it('falls back to an hour when no delay is usable', () => {
    assert.equal(retryAfterMs({}, now), FALLBACK_COOLDOWN_MS);
    assert.equal(retryAfterMs({ headers: { 'retry-after': 'soon' }, body: Buffer.from('<html>') }, now), FALLBACK_COOLDOWN_MS);
    assert.equal(retryAfterMs({ body: '{"retry_after": -5}' }, now), FALLBACK_COOLDOWN_MS);
  });

  it('treats a date in the past as no wait', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': 'Fri, 20 Nov 2026 11:00:00 GMT' } }, now), 0);
  });
});
