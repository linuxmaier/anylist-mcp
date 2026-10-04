/**
 * Tests for src/recipe-to-list/categorize.js: the item-name classifier (cases
 * ported from aioanylist tests/test_categorization.py), the category mapping,
 * and the golden fixture: the AnyList app's tag and category for each of the
 * 37 items it created on Test List.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCategoryMatchId,
  categorizeNewItem,
  classifyItemName,
  containsWordOrPhrase,
  removeDiacritics,
} from '../src/recipe-to-list/categorize.js';
import { uuid5Hex } from '../src/recipe-to-list/index.js';
import fixture from './fixtures/recipe-list-items.json' with { type: 'json' };
import testList from './fixtures/test-list-categories.json' with { type: 'json' };
import tagExtract from './fixtures/tag-data-extract.json' with { type: 'json' };

const miniTagData = () => ({
  tags: {
    apples: { rootCategory: 'produce', keywords: {} },
    'green-apples': { rootCategory: 'produce', keywords: { green: 1 } },
    seeds: { rootCategory: 'produce', keywords: {} },
    'spices-and-herbs': { rootCategory: 'cooking-and-baking', keywords: {} },
    basil: { rootCategory: 'produce', keywords: {} },
  },
  impliedTags: {
    'green-apples': ['apples', 'fruit'],
    basil: ['spices-and-herbs'],
  },
  tagKeywordsIndex: {
    appl: ['apples', 'green-apples'],
    green: ['green-apples'],
    seed: ['seeds'],
    basil: ['basil', 'spices-and-herbs'],
  },
});

describe('classifyItemName', () => {
  it('applies required keywords and prefers the more specific tag', () => {
    const d = miniTagData();
    assert.equal(classifyItemName('green apples', d), 'green-apples');
    assert.equal(classifyItemName('apples', d), 'apples');
  });

  it('drops the seeds candidate for "seeded"', () => {
    const d = miniTagData();
    d.tagKeywordsIndex.seed = ['seeds', 'apples'];
    assert.notEqual(classifyItemName('seeded', d), 'seeds');
  });

  it('removes an implied parent when a specific child survives', () => {
    const d = miniTagData();
    d.tagKeywordsIndex.green = ['green-apples', 'apples'];
    assert.equal(classifyItemName('green', d), 'green-apples');
  });

  it('a forbidden keyword removes a candidate', () => {
    const d = miniTagData();
    d.tags.apples.keywords = { green: -1 };
    d.tagKeywordsIndex.green = ['green-apples', 'apples'];
    assert.equal(classifyItemName('green apples', d), 'green-apples');
  });

  it('returns null for unknown words and empty names', () => {
    assert.equal(classifyItemName('zz-mcp-test widget', miniTagData()), null);
    assert.equal(classifyItemName('', miniTagData()), null);
  });

  it('falls back to a single common parent that is not a root category', () => {
    const d = miniTagData();
    d.tags.thyme = { rootCategory: 'produce', keywords: {} };
    d.impliedTags.thyme = ['spices-and-herbs'];
    d.tags.basil.rootCategory = 'produce';
    d.tagKeywordsIndex.herb = ['basil', 'thyme'];
    assert.equal(classifyItemName('herb', d), 'spices-and-herbs');
  });
});

describe('text helpers', () => {
  it('containsWordOrPhrase matches whole words and treats & as "and"', () => {
    assert.ok(containsWordOrPhrase('green appl', 'green'));
    assert.ok(!containsWordOrPhrase('evergreen appl', 'green'));
    assert.ok(containsWordOrPhrase('salt and pepper', 'salt & pepper'));
    assert.ok(containsWordOrPhrase('salt & pepper', 'salt and pepper'));
  });

  it('removeDiacritics folds accents and ligatures', () => {
    assert.equal(removeDiacritics('jalapeño crème'), 'jalapeno creme');
    assert.equal(removeDiacritics('Œufs'), 'OEufs');
  });

  it('canonicalCategoryMatchId matches the app', () => {
    assert.equal(canonicalCategoryMatchId('Breakfast & Cereal'), 'breakfast-and-cereal');
    assert.equal(canonicalCategoryMatchId("  Kids' Snacks — Misc. "), 'kids-snacks-misc');
  });
});

describe('categorizeNewItem', () => {
  const NS = '08e5c5bdcd694454a1ffd611b6d9abc0';
  const groups = [
    { identifier: 'g1', name: 'Store A', defaultCategoryId: 'g1-other', categories: [
      { identifier: 'g1-produce', systemCategory: 'produce', name: 'Produce' },
      { identifier: 'g1-other', systemCategory: 'other', name: 'Other' },
      { identifier: 'g1-custom', name: 'Costco Run' },
    ] },
    { identifier: 'g2', name: 'Store B', defaultCategoryId: 'g2-other', categories: [
      { identifier: 'g2-other', systemCategory: 'other', name: 'Other' },
    ] },
  ];
  const list = (extra = {}) => ({ listId: 'L', groups, rules: [], selectedGroupId: 'g1', ...extra });

  it('maps the tag\'s root category in each group, leaving a group without it unassigned', () => {
    const r = categorizeNewItem('apples', 'apples', miniTagData(), list());
    assert.equal(r.priceMatchupTag, 'apples');
    assert.equal(r.categoryMatchId, 'produce');
    assert.deepEqual(r.categoryAssignments, [
      { identifier: uuid5Hex('g1', NS), categoryGroupId: 'g1', categoryId: 'g1-produce' },
    ]);
  });

  it('gives an item with no tag each group\'s default category', () => {
    const r = categorizeNewItem('widget', null, miniTagData(), list());
    assert.equal(r.priceMatchupTag, undefined);
    assert.equal(r.categoryMatchId, 'other');
    assert.deepEqual(r.categoryAssignments.map(a => a.categoryId), ['g1-other', 'g2-other']);
  });

  it('a categorization rule for the name wins, and a custom category matches by name', () => {
    const rules = [{ categoryGroupId: 'g1', itemName: 'Apples', categoryId: 'g1-custom' }];
    const r = categorizeNewItem('apples', 'apples', miniTagData(), list({ rules }));
    assert.equal(r.categoryMatchId, 'costco-run');
    assert.equal(r.categoryAssignments[0].categoryId, 'g1-custom');
  });

  it('takes categoryMatchId from the selected group', () => {
    const r = categorizeNewItem('apples', 'apples', miniTagData(), list({ selectedGroupId: 'g2' }));
    assert.equal(r.categoryMatchId, 'other');
  });

  it('a list without category groups gets "other"', () => {
    const r = categorizeNewItem('apples', 'apples', miniTagData(), list({ groups: [] }));
    assert.deepEqual(r.categoryAssignments, []);
    assert.equal(r.categoryMatchId, 'other');
  });
});

describe('golden fixture: categories the AnyList app gave its 37 items', () => {
  const listCategories = {
    listId: testList.listId,
    groups: testList.categoryGroups,
    rules: testList.categorizationRules,
    selectedGroupId: testList.listCategoryGroupId,
  };

  it('pairs with the item fixture', () => {
    assert.equal(testList.listId, fixture.listId);
    assert.equal(fixture.items.length, 37);
  });

  for (const item of fixture.items) {
    it(`${item.name} → ${item.priceMatchupTag ?? '(no tag)'} / ${item.categoryMatchId}`, () => {
      const tag = classifyItemName(item.name, tagExtract);
      assert.equal(tag, item.priceMatchupTag);
      const r = categorizeNewItem(item.name, tag, tagExtract, listCategories);
      assert.equal(r.priceMatchupTag ?? null, item.priceMatchupTag);
      assert.equal(r.categoryMatchId, item.categoryMatchId);
      assert.deepEqual(r.categoryAssignments, item.categoryAssignments);
    });
  }
});
