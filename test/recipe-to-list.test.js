/**
 * Tests for src/recipe-to-list: the stemmer, quantity parser and list-item IDs.
 *
 * Vectors marked "aioanylist" are ported from aioanylist's tests at commit
 * 8df7f406335a (tests/test_parsing.py, test_derived.py, test_identifiers.py,
 * test_normalization.py; MIT License, Copyright (c) 2026 aioanylist contributors).
 * Where the AnyList app does something else, the app wins; those vectors are
 * kept and marked "DIVERGENCE", with the fixture evidence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { englishStem, stemWords } from '../src/recipe-to-list/stem.js';
import {
  normalizeUnit,
  parseLeadingAmount,
  parseQuantityAndPackageSize,
  splitQuantityPrefix,
} from '../src/recipe-to-list/quantity.js';
import {
  itemIdentifier,
  normalizedRawPackageSize,
  sameItemIngredient,
  toItemIngredient,
  uuid5Hex,
} from '../src/recipe-to-list/index.js';
import fixture from './fixtures/recipe-list-items.json' with { type: 'json' };
import stemmer from './fixtures/stemmer-vectors.json' with { type: 'json' };

// Drop null/empty fields, so a decoded protobuf and a plain object compare equal.
const clean = o => (o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) : {});

describe('englishStem', () => {
  it('matches snowballstemmer 2.2.0 on the committed vectors', () => {
    const wrong = Object.entries(stemmer.vectors)
      .filter(([word, stem]) => englishStem(word) !== stem)
      .map(([word, stem]) => `${word}: got ${englishStem(word)}, want ${stem}`);
    assert.deepEqual(wrong, []);
    assert.ok(Object.keys(stemmer.vectors).length > 300);
  });

  it('aioanylist: basics', () => {
    assert.equal(englishStem('skies'), 'sky');
    assert.equal(englishStem('running'), 'run');
    assert.equal(englishStem('news'), 'news');
  });

  it('DIVERGENCE from aioanylist: "eed" outside R1 is kept (the app keys "mustard seeds" as "mustard seed")', () => {
    // aioanylist falls through to the "ed" rule and returns "se".
    assert.equal(englishStem('seeds'), 'seed');
  });

  it('DIVERGENCE from aioanylist: a marked Y is a consonant, and steps 2-4 use the longest suffix', () => {
    assert.equal(englishStem('annoyance'), 'annoy'); // aioanylist: annoyanc
    assert.equal(englishStem('agreement'), 'agreement'); // aioanylist: agreem
  });

  it('stemWords drops empty words from double spaces', () => {
    assert.deepEqual(stemWords('green  chiles'.split(' ')), ['green', 'chile']);
  });
});

describe('quantity parsing', () => {
  it('aioanylist: a mixed fraction is not a range', () => {
    const [amount, rest] = parseLeadingAmount('2-1/2 lb.');
    assert.deepEqual(amount, { raw: '2-1/2', isRange: false });
    assert.equal(rest.trim(), 'lb.');
  });

  it('aioanylist: a true range', () => {
    const [amount, rest] = parseLeadingAmount('1/2 to 3/4 cups');
    assert.equal(amount.isRange, true);
    assert.equal(amount.raw, '1/2 - 3/4');
    assert.equal(rest.trim(), 'cups');
  });

  it('aioanylist: normalized units match the app tables', () => {
    const cases = [['cups', 'cup'], ['jars', 'jar'], ['tasse', 'Tasse'], ['becher', 'becher'],
      ['pfund', 'Pfund'], ['Dosen', 'can'], ['gläser', 'glas'], ['oz t', 'troy oz'], ['T', 'Tbsp'],
      ['liter', 'L'], ['tbsp.', 'Tbsp'], ['c.', 'cup']];
    for (const [unit, want] of cases) assert.equal(normalizeUnit(unit), want, unit);
  });

  it('aioanylist: the quantity text excludes a parsed package size', () => {
    const cans = parseQuantityAndPackageSize('2 cans (28 Ounce)');
    assert.deepEqual(cans.quantityPb, { amount: '2', unit: 'cans', rawQuantity: '2 cans' });
    assert.equal(cans.packageSizePb.rawPackageSize.toLowerCase(), '28 ounce');

    const bottle = parseQuantityAndPackageSize('1 12-ounce bottle');
    assert.equal(bottle.quantityPb.rawQuantity, '1');
    // DIVERGENCE from aioanylist ("12-ounce bottle"): the app rebuilds the package
    // text from its parts, as it stores "(4.5-oz.) cans" as "4.5 oz. can".
    assert.equal(bottle.packageSizePb.rawPackageSize, '12 ounce bottle');
  });

  it('DIVERGENCE from aioanylist: the app stores "2 (15-oz.) cans" as 2 × "15 oz. can"', () => {
    // toItemIngredient singularizes "cans"; the golden fixture tests that step.
    assert.deepEqual(parseQuantityAndPackageSize('2 (15-oz.) cans'), {
      quantityPb: { amount: '2', rawQuantity: '2' },
      packageSizePb: { size: '15', unit: 'oz.', packageType: 'cans', rawPackageSize: '15 oz. cans' },
    });
  });

  it('DIVERGENCE from aioanylist: a trailing dot stays on the unit, as in the app', () => {
    assert.deepEqual(parseQuantityAndPackageSize('1 1/2 c.'), {
      quantityPb: { amount: '1 1/2', unit: 'c.', rawQuantity: '1 1/2 c.' },
    });
  });

  it('keeps size words as the unit and the whole text as rawQuantity', () => {
    assert.deepEqual(parseQuantityAndPackageSize('1 medium'), {
      quantityPb: { amount: '1', unit: 'medium', rawQuantity: '1 medium' },
    });
    assert.equal(parseQuantityAndPackageSize(''), null);
    assert.equal(parseQuantityAndPackageSize('a pinch'), null);
  });

  it('aioanylist: every entry of the app\'s quantity corpus parses', () => {
    const corpus = ['1 pound', '3/4 pound', '2¼ pounds', '2-1/2 lb.', '1 lb', '2lbs', '2lbs.', '0.5lbs',
      '¼lb', '2 - 3lb', '2  lbs', '1 lb.', '1/2 cup', '3/4 cup', '1 / 2 cup', '1/2 to 3 / 4 cups',
      '⅖ to ⅞ cups', '1 to 1 ½ cup', '1/2-3/4 cups', '.35-.45 cups', '¼ – ½ cup',
      '1/4 cup (1/2 Stick Or 4 Tablespoons)', '1 (6-oz can)', '2 (6 ounce) cans', '1 (28 ounce) can',
      '1 – 28 ounce can', '1 can (28 Ounce)', '2 cans (28 Ounce)', '1 can', '2 cans', '2 to 3 cans',
      '16 ounces', '½ oz', '¹/₉ oz', '¹⁄₂ oz', '2 tablespoons', '1 tablespoon', '4 tablespoons',
      '3 tbsps', '3 - 4 tablespoons', '2 Tbsp.', '5 Tbs.', '1-1/2 Tbs.', '1 Tbl', '1/2 teaspoon',
      '1 1/2 teaspoons', '1/2 tsp', '1 teaspoon', '2-4 teaspoons', '12-ounce bottle', '12-oz bottle',
      '12', '1', '2 or 3', '10–12', '1 bunch', '1 large', '6-7 large', '3 parts', '2 cloves',
      '3 dashes', '3 to 4 medium', '3 medium', '1 box', '1 pkg. (12 oz)', '50 g (1.8oz)', '3-5 Drops',
      '.35 ounces (10 grams, about 2 teaspoons)', '1 stick (1/2 cup)', '1 head', '1/2 small head',
      '4 bars', '2 medium ears', '1 12-ounce bottle', '2 12 ounce jars', '1 5–6-pound', '1 1.5 L',
      '1 can small', '6 inch sprig', '4 6-inch sprigs', '1 Small pkg', '1 (16 oz) tub', '3 in piece',
      '60 3-inch pieces'];
    const unparsed = corpus.filter(raw => parseQuantityAndPackageSize(raw) === null);
    assert.deepEqual(unparsed, []);
  });

  it('aioanylist: quantity prefixes take repeated units but give back a trailing size word', () => {
    assert.deepEqual(splitQuantityPrefix('1/2 small head cabbage'), ['1/2 small head', 'cabbage']);
    assert.deepEqual(splitQuantityPrefix('1 large tomato'), ['1', 'large tomato']);
    assert.deepEqual(splitQuantityPrefix('12 ounces jars tomatoes'), ['12 ounces jars', 'tomatoes']);
  });
});

describe('list-item identifiers', () => {
  const listId = '11111111111141118111111111111111';
  const itemIngredient = (name, unit, rawPackageSize) => ({
    ingredient: { identifier: 'i', name },
    recipeId: 'r',
    quantityPb: { amount: '2', unit },
    ...(rawPackageSize ? { packageSizePb: { rawPackageSize } } : {}),
  });

  it('aioanylist: uuid5 matches the app\'s compact vector', () => {
    assert.equal(uuid5Hex('allrecipes', '6d86f27f66474ca6a540fcf62af29e59'), 'f4162f7b63975202a148ee6a39ed58ad');
  });

  it('aioanylist: IDs are deterministic and namespaced by list', () => {
    const ing = itemIngredient('Chopped Onions', 'cup');
    assert.equal(itemIdentifier(ing, listId), itemIdentifier(ing, listId));
    assert.notEqual(itemIdentifier(ing, listId), itemIdentifier(ing, '22222222222242228222222222222222'));
  });

  it('aioanylist: IDs use the app\'s unit and package normalization', () => {
    const ing = itemIngredient('Beans', 'Dosen', '12 ounces jars');
    assert.equal(normalizedRawPackageSize(ing.packageSizePb), '12 oz jar');
    assert.equal(itemIdentifier(ing, listId),
      uuid5Hex('ALName::bean::ALQuantityUnit::can::ALPackageSize::12 oz jar', listId));
  });

  it('DIVERGENCE from aioanylist: a dot after a unit stays in the package key ("4.5 oz. can")', () => {
    assert.equal(normalizedRawPackageSize({ rawPackageSize: '4.5 oz. can' }), '4.5 oz. can');
    assert.equal(normalizedRawPackageSize({ rawPackageSize: '28 ounce can' }), '28 oz can');
  });

  it('shared ingredients from two recipes get the same ID; a different unit does not', () => {
    const a = { ...itemIngredient('yellow onions', 'cup'), recipeId: 'a' };
    const b = { ...itemIngredient('Yellow onion', 'cups'), recipeId: 'b' };
    const c = itemIngredient('yellow onions', 'lb');
    assert.equal(itemIdentifier(a, listId), itemIdentifier(b, listId));
    assert.notEqual(itemIdentifier(a, listId), itemIdentifier(c, listId));
  });

  it('sameItemIngredient compares ingredient, recipe and event', () => {
    const a = itemIngredient('x', 'cup');
    assert.equal(sameItemIngredient(a, { ...a, quantityPb: {} }), true);
    assert.equal(sameItemIngredient(a, { ...a, recipeId: 'other' }), false);
    assert.equal(sameItemIngredient(a, { ...a, eventId: 'e' }), false);
  });
});

describe('golden fixture: items the AnyList app added from two recipes', () => {
  const recipeOf = id => fixture.recipes.find(r => r.identifier === id);

  it('has the expected shape', () => {
    assert.equal(fixture.items.length, 37);
    assert.ok(fixture.items.every(i => i.ingredients.length === 1));
  });

  for (const item of fixture.items) {
    const appIngredient = item.ingredients[0];
    it(`${item.name}: same ID and quantity split as the app`, () => {
      // From the app's own PBItemIngredient: tests stemming, units and uuid5.
      assert.equal(itemIdentifier(appIngredient, fixture.listId), item.identifier);
      // From the recipe text: tests the parser too.
      const ours = toItemIngredient(appIngredient.ingredient, recipeOf(appIngredient.recipeId));
      assert.deepEqual(clean(ours.quantityPb), clean(appIngredient.quantityPb));
      assert.deepEqual(clean(ours.packageSizePb), clean(appIngredient.packageSizePb));
      assert.equal(ours.recipeId, appIngredient.recipeId);
      assert.equal(ours.recipeName, appIngredient.recipeName);
      assert.equal(itemIdentifier(ours, fixture.listId), item.identifier);
    });
  }
});

describe('toItemIngredient', () => {
  it('links a meal-plan event when given', () => {
    const out = toItemIngredient({ identifier: 'i', name: 'rice', quantity: '1 cup' },
      { identifier: 'r', name: 'Rice' }, { identifier: 'e', date: '2026-10-01' });
    assert.equal(out.eventId, 'e');
    assert.equal(out.eventDate, '2026-10-01');
    assert.deepEqual(out.quantityPb, { amount: '1', unit: 'cup', rawQuantity: '1 cup' });
  });

  it('has no quantity for an ingredient without one', () => {
    const out = toItemIngredient({ identifier: 'i', name: 'Kosher salt', quantity: '' }, { identifier: 'r', name: 'R' });
    assert.equal(out.quantityPb, undefined);
    assert.equal(out.packageSizePb, undefined);
  });
});
