// AnyList's grocery tag data: the public static file the AnyList web client
// loads to categorize items (#20). Fetched from www.anylist.com only, held in
// memory per process (it isn't account-specific), and refreshed daily.

export const TAG_DATA_URL = 'https://www.anylist.com/static/webapp/data/tag_data.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const REQUIRED_KEYS = ['tags', 'impliedTags', 'tagKeywordsIndex'];

let cached = null; // { data, fetchedAt }
let inFlight = null;

async function fetchTagData(fetchImpl) {
  const response = await fetchImpl(TAG_DATA_URL, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const missing = REQUIRED_KEYS.filter(k => !data || typeof data[k] !== 'object');
  if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`);
  return { tags: data.tags, impliedTags: data.impliedTags, tagKeywordsIndex: data.tagKeywordsIndex };
}

/**
 * The tag data, or null if it can't be loaded (callers then skip
 * classification). A failed refresh keeps the previous copy.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [options] - for tests
 */
export async function getTagData({ fetchImpl = fetch, now = Date.now } = {}) {
  if (cached && now() - cached.fetchedAt < MAX_AGE_MS) return cached.data;
  inFlight ??= fetchTagData(fetchImpl)
    .then(data => {
      cached = { data, fetchedAt: now() };
      return data;
    })
    .catch(error => {
      console.error(`Could not load AnyList tag data (${error.message}); new items won't be categorized by name`);
      return cached?.data ?? null;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Forget the cached copy (tests). */
export function resetTagData() {
  cached = null;
  inFlight = null;
}
