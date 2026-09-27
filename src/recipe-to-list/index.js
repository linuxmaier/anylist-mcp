// Turn recipe ingredients into recipe-linked list items the way the AnyList
// app does, so items merge with the ones the app creates.
//
// Ported from aioanylist at commit 8df7f406335a (https://github.com/BookCatKid/aioanylist):
// src/aioanylist/derived.py (ingredient_to_item_ingredient, normalized_raw_package_size,
// recipe_list_item_identifier, same_recipe_ingredient) and identifiers.py (uuid5_hex).
// aioanylist is: MIT License. Copyright (c) 2026 aioanylist contributors.

import { createHash } from 'node:crypto';
import { stemWords } from './stem.js';
import {
  normalizeUnit,
  normalizeUnitsInText,
  parseQuantityAndPackageSize,
  singularizeUnitsInText,
  splitQuantityPrefix,
} from './quantity.js';

/** RFC 4122 UUIDv5, in AnyList's compact 32-hex form. `namespace` is 32 hex chars. */
export function uuid5Hex(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error(`Invalid UUID namespace "${namespace}"`);
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.subarray(0, 16).toString('hex');
}

/**
 * PBItemPackageSize.normalizedRawPackageSize: normalize units in the quantity
 * prefix of rawPackageSize and keep the remainder as is.
 */
export function normalizedRawPackageSize(pkg) {
  const raw = pkg?.rawPackageSize || '';
  if (!raw) return '';
  const [prefix, remainder] = splitQuantityPrefix(raw);
  if (!prefix) return raw;
  const normalized = normalizeUnitsInText(prefix);
  return remainder ? `${normalized} ${remainder}`.trim() : normalized;
}

/**
 * The list-item ID the app derives for a PBItemIngredient: same stemmed name,
 * unit and package size on the same list means the same item.
 */
export function itemIdentifier(itemIngredient, listId) {
  const packageKey = normalizedRawPackageSize(itemIngredient.packageSizePb).toLowerCase();
  const unitKey = normalizeUnit(itemIngredient.quantityPb?.unit || '').toLowerCase();
  const name = (itemIngredient.ingredient?.name || '').toLowerCase();
  const stemmed = stemWords(name.split(' ')).join(' ');
  return uuid5Hex(`ALName::${stemmed}::ALQuantityUnit::${unitKey}::ALPackageSize::${packageKey}`, listId);
}

/** Whether two PBItemIngredients are the same recipe (or event) ingredient. */
export function sameItemIngredient(a, b) {
  return (a.ingredient?.identifier || '') === (b.ingredient?.identifier || '')
    && (a.recipeId || '') === (b.recipeId || '')
    && (a.eventId || '') === (b.eventId || '');
}

// Normalized units whose price is per unit rather than per item (aioanylist
// services/shopping.py _PRICE_QUANTITY_UNITS).
const PRICE_QUANTITY_UNITS = new Set(['cup', 'fl oz', 'oz', 'tbsp', 'tsp', 'g', 'mg', 'l', 'dl', 'ml',
  'slice', 'clove', 'pinch', 'drop', 'dash', 'inch']);

/**
 * The full ListItem (as a plain object) the app sends for an ingredient that
 * isn't on the list yet. Quantity lives in `ingredients`, not on the item.
 */
export function newListItem(itemIngredient, { identifier, listId, userId }) {
  const item = {
    identifier,
    listId,
    name: itemIngredient.ingredient?.name || '-',
    userId,
    ingredients: [itemIngredient],
  };
  if (itemIngredient.packageSizePb) item.packageSizePb = itemIngredient.packageSizePb;
  const unit = itemIngredient.quantityPb?.unit;
  if (unit && PRICE_QUANTITY_UNITS.has(normalizeUnit(unit).toLowerCase())) {
    item.priceQuantityShouldOverrideItemQuantity = true;
  }
  return item;
}

const stemmedTokens = text => stemWords((text || '').toLowerCase().split(/[^\p{L}]+/u));

/**
 * Build a matcher for `exclude` entries: an ingredient name is excluded by the
 * first entry whose stemmed words all appear among the name's stemmed words, so
 * "salt" matches "Kosher salt" and "black pepper" matches "Freshly ground black
 * pepper". Entries with no words match nothing.
 * @param {string[]} excludes
 * @returns {(name: string) => string | undefined} the matching entry, if any
 */
export function excludeMatcher(excludes) {
  const entries = excludes
    .map(entry => ({ entry, tokens: stemmedTokens(entry) }))
    .filter(e => e.tokens.length > 0);
  return name => {
    const have = new Set(stemmedTokens(name));
    return entries.find(e => e.tokens.every(t => have.has(t)))?.entry;
  };
}

/**
 * The favorite or recent item the app would copy properties from onto a new
 * recipe item: same stemmed name and package size. Favorites win; the most
 * recent item wins among recents (aioanylist _saved_item_for_recipe_ingredient).
 * @param {object} itemIngredient
 * @param {Array<{ name: string, packageSizePb?: object }>} favorites
 * @param {Array<{ name: string, packageSizePb?: object }>} recents - oldest first
 */
export function findSavedItem(itemIngredient, favorites, recents) {
  const words = name => stemWords((name || '').toLowerCase().split(' ')).join(' ');
  const wantedName = words(itemIngredient.ingredient?.name);
  const wantedPackage = normalizedRawPackageSize(itemIngredient.packageSizePb);
  return [...favorites, ...[...recents].reverse()].find(c =>
    words(c.name) === wantedName && normalizedRawPackageSize(c.packageSizePb) === wantedPackage);
}

/**
 * PBIngredient.toItemIngredientWithRecipeAndEvent, for an unscaled recipe.
 * Returns a plain PBItemIngredient object.
 * @param {object} ingredient - PBIngredient (identifier, name, quantity, note, rawIngredient)
 * @param {{ identifier: string, name: string }} recipe
 * @param {{ identifier: string, date: string }} [event] - meal-plan event
 */
export function toItemIngredient(ingredient, recipe, event = null) {
  const out = {
    ingredient: {
      identifier: ingredient.identifier,
      rawIngredient: ingredient.rawIngredient,
      name: ingredient.name,
      quantity: ingredient.quantity,
      note: ingredient.note,
    },
    recipeId: recipe.identifier,
    recipeName: recipe.name || '',
  };
  if (event) {
    out.eventId = event.identifier || '';
    out.eventDate = event.date || '';
  }
  const parsed = parseQuantityAndPackageSize(ingredient.quantity || '');
  if (parsed?.quantityPb) out.quantityPb = parsed.quantityPb;
  if (parsed?.packageSizePb) {
    // The app stores package fields singularized ("15 oz. can", not "cans").
    const pkg = { ...parsed.packageSizePb };
    for (const field of ['unit', 'packageType', 'rawPackageSize']) {
      if (pkg[field]) pkg[field] = singularizeUnitsInText(pkg[field]);
    }
    out.packageSizePb = pkg;
  }
  return out;
}
