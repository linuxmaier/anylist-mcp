// Categorize a new list item the way the AnyList app does: classify its name
// to a grocery tag with AnyList's tag data, then map the tag's root category to
// a category in each of the list's category groups, honouring the list's
// per-item categorization rules (#20).
//
// Ported from aioanylist at commit 8df7f406335a (https://github.com/BookCatKid/aioanylist):
// src/aioanylist/categorization.py (Categorizer.classify_with, English path),
// normalization.py (remove_diacritics, range_of_word_or_phrase,
// canonical_category_match_id), and services/shopping.py
// (_category_assignments_for_new_item, prepare_item_for_add,
// _default_category_group). aioanylist is: MIT License. Copyright (c) 2026
// aioanylist contributors.

import { englishStem } from './stem.js';
import { uuid5Hex } from './index.js';

// Namespaces of the app's deterministic category-group and assignment IDs.
const CATEGORY_GROUP_NAMESPACE = 'f656a81f0e0a419aa45121f4f2eac51b';
const CATEGORY_ASSIGNMENT_NAMESPACE = '08e5c5bdcd694454a1ffd611b6d9abc0';

// Root categories the classifier never returns as a "common parent".
const SYSTEM_ROOT_CATEGORIES = new Set(['baby', 'bakery', 'beverages', 'breakfast-and-cereal',
  'condiments-oils-and-salad-dressings', 'cooking-and-baking', 'dairy', 'deli', 'frozen-foods',
  'grains-pasta-and-side-dishes', 'health-and-personal-care', 'household-and-cleaning', 'meat',
  'pet-supplies', 'produce', 'seafood', 'snacks-cookies-and-candy', 'soups-and-canned-goods',
  'wine-beer-spirits', 'other']);
const GENERIC_PRODUCE_PARENTS = new Set(['fruit', 'vegetables', 'fresh-fruit', 'fresh-vegetables']);

// Characters NFKD doesn't fold the way the app's table does.
const EXTRA_FOLD = {
  Æ: 'AE', æ: 'ae', Œ: 'OE', œ: 'oe', Ø: 'O', ø: 'o', Đ: 'D', đ: 'd', Ł: 'L', ł: 'l',
  Þ: 'TH', þ: 'th', Ð: 'D', ð: 'd', ß: 's', ẞ: 'S', Ƶ: 'Z', ƶ: 'z', ı: 'i', ſ: 'l',
};

export function removeDiacritics(text) {
  if (/^[\x00-\x7f]*$/.test(text)) return text;
  const folded = [...text].map(ch => EXTRA_FOLD[ch] ?? ch).join('');
  return folded.normalize('NFKD').replace(/\p{M}/gu, '');
}

// Python's [\W_]: anything but a letter, digit or combining mark, plus "_".
const isBoundaryChar = ch => /[^\p{L}\p{N}\p{M}]|_/u.test(ch);
const boundaryBefore = (text, i) => i === 0 || isBoundaryChar(text[i - 1]);
const boundaryAfter = (text, end) => end === text.length - 1 || isBoundaryChar(text[end + 1]);

// How many characters of text and pattern match at these positions; English
// search treats "&" and "and" (or its partial forms) as equal.
function consume(text, ti, pattern, pi) {
  if (text[ti] === pattern[pi]) return [1, 1];
  if (pattern[pi] === '&' && text.startsWith('and', ti)) return [3, 1];
  if (text[ti] === '&') {
    for (const token of ['and', 'an', 'a']) {
      if (pattern.startsWith(token, pi)) return [1, token.length];
    }
  }
  return [0, 0];
}

/** `pattern` occurs in `text` as whole words (range_of_word_or_phrase with both boundaries). */
export function containsWordOrPhrase(text, pattern) {
  if (!text || !pattern) return false;
  for (let start = 0; start < text.length; start++) {
    let ti = start;
    let pi = 0;
    while (ti < text.length && pi < pattern.length) {
      const [tc, pc] = consume(text, ti, pattern, pi);
      if (tc === 0) break;
      ti += tc;
      pi += pc;
    }
    if (pi === pattern.length && boundaryBefore(text, start) && boundaryAfter(text, ti - 1)) return true;
  }
  return false;
}

/** The categoryMatchId of a category with this name (canonical_category_match_id). */
export function canonicalCategoryMatchId(name) {
  return removeDiacritics(name || '').toLowerCase()
    .replace(/['‘’‚‛]/g, "'")
    .replace(/[\-֊־᐀᠆‐‑‒–—―⸗⸚⸺⸻〜〰゠︱︲﹘﹣－]/g, '-')
    .trim()
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const tokenize = text => removeDiacritics(text.toLowerCase()).split(/[ ,():/\-]/).filter(p => p.trim());

const parentsOf = (tagData, tag) => {
  const out = new Set(tagData.impliedTags[tag] || []);
  const root = tagData.tags[tag]?.rootCategory;
  if (root) out.add(root);
  return out;
};

/**
 * The grocery tag AnyList gives an item name (Categorizer.classify_with,
 * English), or null.
 * @param {string} text
 * @param {{ tags: object, impliedTags: object, tagKeywordsIndex: object }} tagData
 */
export function classifyItemName(text, tagData) {
  if (!text) return null;
  const originalTokens = tokenize(text);
  const stems = originalTokens.map(englishStem);
  const stemmedText = stems.join(' ');
  const uniqueStems = [...new Set(stems)];
  if (uniqueStems.length === 0) return null;

  const votes = new Map();
  for (const stem of uniqueStems) {
    for (const tag of tagData.tagKeywordsIndex[stem] || []) votes.set(tag, (votes.get(tag) || 0) + 1);
  }
  if (votes.size === 0) return null;

  // Each tag can require (1) or forbid (-1) keyword expressions.
  let candidates = [...votes.keys()].filter(tag => {
    for (const [expr, required] of Object.entries(tagData.tags[tag]?.keywords || {})) {
      if (!required) continue;
      const present = expr.split('|').some(keyword => containsWordOrPhrase(stemmedText, keyword));
      if ((required === 1 && !present) || (required === -1 && present)) return false;
    }
    return true;
  });
  if (candidates.length === 1) return candidates[0];

  const lowered = text.toLowerCase();
  const exact = candidates.find(tag => tag.replaceAll('-', ' ') === lowered);
  if (exact) return exact;

  if (candidates.length > 0) {
    const maxVote = Math.max(...candidates.map(tag => votes.get(tag)));
    candidates = candidates.filter(tag => votes.get(tag) === maxVote);
  }
  if (candidates.includes('seeds') && originalTokens.includes('seeded')) {
    candidates = candidates.filter(tag => tag !== 'seeds');
  }
  if (candidates.length === 1) return candidates[0];

  // Prefer a single specific non-produce root where the tag is not merely under spices/herbs.
  const specific = candidates.filter(tag => {
    const root = tagData.tags[tag]?.rootCategory;
    return root && root !== 'produce' && !parentsOf(tagData, tag).has('spices-and-herbs');
  });
  if (specific.length === 1) return specific[0];
  if (specific.length > 0) candidates = specific;

  // Remove less-specific candidates if another candidate implies them.
  const candidateSet = new Set(candidates);
  const lessSpecific = new Set();
  for (const child of candidates) {
    for (const parent of parentsOf(tagData, child)) {
      if (parent !== child && candidateSet.has(parent)) lessSpecific.add(parent);
    }
  }
  candidates = candidates.filter(tag => !lessSpecific.has(tag));
  if (candidates.length === 1) return candidates[0];

  let common = null;
  for (const tag of candidates) {
    const parents = parentsOf(tagData, tag);
    common = common === null ? parents : new Set([...common].filter(p => parents.has(p)));
    if (common.size === 0) break;
  }
  if (common && common.size > 0) {
    const left = [...common].filter(p => !SYSTEM_ROOT_CATEGORIES.has(p) && !GENERIC_PRODUCE_PARENTS.has(p));
    if (left.length === 1) return left[0];
  }
  return null;
}

/** The match ID of a list category: its system category, else one derived from its name. */
const categoryMatchIdOf = category => category.systemCategory || canonicalCategoryMatchId(category.name);

/**
 * The list's selected category group: the one in its settings, else the app's
 * default (the group with the list's deterministic ID, else the first by name).
 */
function selectedGroup(groups, listId, selectedGroupId) {
  const byId = id => groups.find(g => g.identifier === id);
  const preferred = (selectedGroupId && byId(selectedGroupId)) || byId(uuid5Hex(listId, CATEGORY_GROUP_NAMESPACE));
  if (preferred) return preferred;
  return [...groups].sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())
    || a.identifier.localeCompare(b.identifier))[0];
}

/**
 * The category fields the app gives a new recipe item called `name`
 * (ShoppingList.zL plus prepare_item_for_add; for recipe items the app leaves
 * the legacy `category` field unset). In each category group, a
 * categorization rule for the name wins; otherwise the category whose system
 * category is the tag's root category (none, if the group has no such
 * category); otherwise, with no tag, the group's default category.
 * @param {string} name
 * @param {string|null} tag - from classifyItemName; null when the list's
 *   generic grocery categorization is off or the name has no tag
 * @param {object|null} tagData - for the tag's root category
 * @param {{ listId: string, groups: object[], rules: object[], selectedGroupId?: string }} list -
 *   PBListCategoryGroup and PBListCategorizationRule objects
 * @returns {{ priceMatchupTag?: string, categoryAssignments: object[], categoryMatchId: string }}
 */
export function categorizeNewItem(name, tag, tagData, { listId, groups, rules, selectedGroupId }) {
  const lowered = name.toLowerCase();
  const matchingRules = rules.filter(r => (r.itemName || '').toLowerCase() === lowered);
  const rootCategory = (tag && tagData?.tags[tag]?.rootCategory) || null;
  const useGeneric = matchingRules.length !== groups.length && rootCategory !== null;

  const categoryAssignments = [];
  for (const group of groups) {
    const rule = matchingRules.findLast(r => r.categoryGroupId === group.identifier);
    let categoryId;
    if (rule) {
      categoryId = rule.categoryId;
    } else if (useGeneric) {
      categoryId = (group.categories || []).find(c => c.systemCategory === rootCategory)?.identifier;
    } else {
      categoryId = group.defaultCategoryId;
    }
    if (!categoryId) continue;
    categoryAssignments.push({
      identifier: uuid5Hex(group.identifier, CATEGORY_ASSIGNMENT_NAMESPACE),
      categoryGroupId: group.identifier,
      categoryId,
    });
  }

  let categoryMatchId = 'other';
  const group = groups.length > 0 ? selectedGroup(groups, listId, selectedGroupId) : null;
  const assignment = group && categoryAssignments.find(a => a.categoryGroupId === group.identifier);
  const category = assignment && (group.categories || []).find(c => c.identifier === assignment.categoryId);
  if (category) categoryMatchId = categoryMatchIdOf(category);

  return {
    ...(tag ? { priceMatchupTag: tag } : {}),
    categoryAssignments,
    categoryMatchId,
  };
}
