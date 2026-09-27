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
