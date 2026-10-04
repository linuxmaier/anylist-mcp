// Regenerate test/fixtures/tag-data-extract.json: the slice of AnyList's tag
// data that classifying the golden fixture's item names touches, so the golden
// categorization test runs offline (#20). Fetches TAG_DATA_URL (www.anylist.com,
// public, no credentials).
//
//   node scripts/extract-tag-fixture.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { TAG_DATA_URL } from '../src/tag-data.js';
import { removeDiacritics } from '../src/recipe-to-list/categorize.js';
import { englishStem } from '../src/recipe-to-list/stem.js';

const fixtureUrl = new URL('../test/fixtures/recipe-list-items.json', import.meta.url);
const outUrl = new URL('../test/fixtures/tag-data-extract.json', import.meta.url);

const response = await fetch(TAG_DATA_URL, { redirect: 'error' });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const full = await response.json();
const { items } = JSON.parse(readFileSync(fixtureUrl, 'utf8'));

// The same tokenizing as classifyItemName.
const stems = new Set(items.flatMap(i =>
  removeDiacritics(i.name.toLowerCase()).split(/[ ,():/\-]/).filter(p => p.trim()).map(englishStem)));

const tagKeywordsIndex = {};
const tags = new Set();
for (const stem of [...stems].sort()) {
  if (!full.tagKeywordsIndex[stem]) continue;
  tagKeywordsIndex[stem] = full.tagKeywordsIndex[stem];
  for (const tag of tagKeywordsIndex[stem]) tags.add(tag);
}
// A tag can also come back as a common parent, so keep the parents' entries.
for (const tag of [...tags]) for (const parent of full.impliedTags[tag] || []) tags.add(parent);
const pick = (source, fields = v => v) => Object.fromEntries([...tags].sort()
  .filter(t => source[t]).map(t => [t, fields(source[t])]));

writeFileSync(outUrl, JSON.stringify({
  _source: `Extract of ${TAG_DATA_URL} (last-modified ${response.headers.get('last-modified')}): `
    + 'only the entries that classifying recipe-list-items.json touches. Regenerate with scripts/extract-tag-fixture.mjs.',
  // Only the fields classifyItemName reads.
  tags: pick(full.tags, ({ rootCategory, keywords }) => ({ rootCategory, keywords })),
  impliedTags: pick(full.impliedTags),
  tagKeywordsIndex,
}, null, 2) + '\n');
console.log(`${Object.keys(tagKeywordsIndex).length} stems, ${tags.size} tags`);
