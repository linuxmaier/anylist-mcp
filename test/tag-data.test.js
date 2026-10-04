/**
 * Tests for src/tag-data.js with a fake fetch (no network).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTagData, resetTagData, TAG_DATA_URL } from '../src/tag-data.js';

const DATA = { tags: { a: {} }, impliedTags: {}, tagKeywordsIndex: { a: ['a'] }, normalizedDisplayNamesIndex: {} };
const DAY = 24 * 60 * 60 * 1000;

function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status === undefined, status: next.status ?? 200, json: async () => next };
  };
  fn.calls = calls;
  return fn;
}

describe('getTagData', () => {
  let time;
  const now = () => time;
  beforeEach(() => {
    resetTagData();
    time = 1_000_000;
  });

  it('fetches only AnyList\'s tag data URL, refusing redirects, and keeps the fields the classifier uses', async () => {
    const fetchImpl = fakeFetch(DATA);
    const data = await getTagData({ fetchImpl, now });
    assert.deepEqual(data, { tags: DATA.tags, impliedTags: {}, tagKeywordsIndex: DATA.tagKeywordsIndex });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, TAG_DATA_URL);
    assert.equal(new URL(TAG_DATA_URL).host, 'www.anylist.com');
    assert.equal(fetchImpl.calls[0].options.redirect, 'error');
  });

  it('serves the cached copy for a day, then refreshes', async () => {
    const fetchImpl = fakeFetch(DATA, { ...DATA, tags: { b: {} } });
    await getTagData({ fetchImpl, now });
    time += DAY - 1;
    assert.deepEqual((await getTagData({ fetchImpl, now })).tags, { a: {} });
    assert.equal(fetchImpl.calls.length, 1);
    time += 1;
    assert.deepEqual((await getTagData({ fetchImpl, now })).tags, { b: {} });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('shares one fetch between concurrent callers', async () => {
    const fetchImpl = fakeFetch(DATA);
    await Promise.all([getTagData({ fetchImpl, now }), getTagData({ fetchImpl, now })]);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('returns null when the first fetch fails, and retries on the next call', async () => {
    const fetchImpl = fakeFetch(new Error('offline'), { status: 500 }, { tags: {} }, DATA);
    assert.equal(await getTagData({ fetchImpl, now }), null);
    assert.equal(await getTagData({ fetchImpl, now }), null);
    assert.equal(await getTagData({ fetchImpl, now }), null, 'missing keys are rejected');
    assert.ok(await getTagData({ fetchImpl, now }));
  });

  it('keeps the old copy when a refresh fails', async () => {
    const fetchImpl = fakeFetch(DATA, new Error('offline'));
    await getTagData({ fetchImpl, now });
    time += DAY;
    assert.deepEqual((await getTagData({ fetchImpl, now })).tags, { a: {} });
  });
});
