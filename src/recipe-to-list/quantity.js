// Quantity / package-size parsing and unit normalization, as the AnyList web
// client does it when turning a recipe ingredient into a list item.
//
// Ported (the subset needed for list-item IDs) from aioanylist at commit 8df7f406335a
// (https://github.com/BookCatKid/aioanylist): src/aioanylist/parsing/quantity.py,
// parsing/ingredient.py (split_quantity_prefix) and normalization.py
// (trim_whitespace_and_punctuation). aioanylist is:
//   MIT License. Copyright (c) 2026 aioanylist contributors.
// Numeric values (amount_as_float) are left out: only the raw text feeds item IDs.

const VULGAR = '½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞';
const SUPERS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUBS = '₀₁₂₃₄₅₆₇₈₉';
const DIGIT_SOURCES = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹०१२३४५६७८९';
const DASH_CLASS = '\\-֊־᐀᠆‐‑‒–—―⸗⸚⸺⸻〜〰゠︱︲﹘﹣－';

// Python's \w and \b are Unicode-aware; JavaScript's are ASCII-only even with /u.
const W = '[\\p{L}\\p{M}\\p{N}_]';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const unitKey = s => s.toLowerCase().replace(/[.\s]+/g, ' ').trim();
const stripChars = (s, chars) => {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
};
const rstripDots = s => s.replace(/\.+$/, '');

// Recognition table (JD): broader than the normalization table below.
const UNIT_MATCH_GROUPS = {
  'cup': ['cup', 'cups', 'c', 'tasse', 'tassen', 'tas', 'tasse/n', 'becher', 'be', 'bch'],
  'fl oz': ['fluid ounce', 'fluid ounces', 'fl oz'],
  'gal': ['gallon', 'gallons', 'gal'],
  'troy oz': ['troy ounce', 'troy ounces', 'oz t', 't oz'],
  'oz': ['ounce', 'ounces', 'oz'],
  'pt': ['pint', 'pints', 'pt'],
  'lb': ['pound', 'pounds', 'lb', 'lbs', 'pfund', 'pf'],
  'qt': ['quart', 'quarts', 'qt', 'qts'],
  'Tbsp': ['tablespoon', 'tablespoons', 'tbsp', 'tbs', 'tbl', 't', 'msk', 'ss', 'spsk', 'rkl', 'el', 'esslöffel'],
  'tsp': ['teaspoon', 'teaspoons', 'tsp', 'ts', 'tsk', 'tl', 'teelöffel'],
  'g': ['gram', 'grams', 'g', 'gr', 'gramm'],
  'kg': ['kilogram', 'kilograms', 'kg', 'kilogramm'],
  'mg': ['milligram', 'milligrams', 'mg'],
  'L': ['liter', 'liters', 'l'],
  'dl': ['deciliter', 'deciliters', 'dl'],
  'ml': ['milliliter', 'milliliters', 'ml', 'krm'],
  'in': ['inch', 'inches', 'in'],
};

// PBItemQuantity.normalizedUnit alias table (rP). Order matters: aliases are
// replaced one group at a time.
const UNIT_NORMALIZATION_GROUPS = {
  'cup': ['cup', 'cups', 'c'],
  'fl oz': ['fluid ounce', 'fluid ounces', 'fl oz'],
  'gal': ['gallon', 'gallons', 'gal'],
  'oz': ['ounce', 'ounces', 'oz'],
  'pt': ['pint', 'pints', 'pt'],
  'lb': ['pound', 'pounds', 'lb', 'lbs'],
  'qt': ['quart', 'quarts', 'qt', 'qts'],
  'troy oz': ['oz t', 't oz'],
  'Tbsp': ['tablespoon', 'tablespoons', 'tbsp', 'tbs', 'tbl', 't', 'msk', 'ss', 'spsk', 'el', 'rkl', 'esslöffel'],
  'tsp': ['teaspoon', 'teaspoons', 'tsp', 'ts', 'tsk', 'tl', 'teelöffel'],
  'g': ['gram', 'grams', 'g', 'gr', 'gramm'],
  'kg': ['kilogram', 'kilograms', 'kg', 'kilogramm'],
  'mg': ['milligram', 'milligrams', 'mg'],
  'L': ['liter', 'liters', 'l'],
  'dl': ['deciliter', 'deciliters', 'dl'],
  'ml': ['milliliter', 'milliliters', 'ml', 'krm'],
  'dozen': ['doz'],
  'Tasse': ['tasse', 'tassen', 'tas'],
  'Pfund': ['pfund', 'pf'],
  'can': ['dose', 'dosen', 'do'],
  'glas': ['glas', 'gläser', 'gl'],
};

const UNIT_LOOKUP = new Map();
for (const [canonical, aliases] of Object.entries(UNIT_NORMALIZATION_GROUPS)) {
  for (const alias of aliases) UNIT_LOOKUP.set(unitKey(alias), canonical);
}
const UNIT_MATCH_KEYS = new Set(Object.values(UNIT_MATCH_GROUPS).flat().map(unitKey));

const PACKAGE_WORDS = [
  'peck', 'pecks', 'bushel', 'bushels', 'bucket', 'buckets', 'slice', 'slices', 'doz', 'doz.',
  'dozen', 'clove', 'cloves', 'loaf', 'loaves', 'pinch', 'pinches', 'package', 'packages', 'pkg',
  'pkg.', 'can', 'cans', 'drop', 'drops', 'bunch', 'bunches', 'dash', 'dashes', 'carton', 'cartons',
  'each', 'piece', 'pieces', 'to taste', 'square', 'squares', 'tube', 'tubes', 'strip', 'strips',
  'stem', 'stems', 'stalk', 'stalks', 'sprig', 'sprigs', 'spear', 'spears', 'sprout', 'sprouts',
  'sheet', 'sheets', 'scoop', 'scoops', 'pouch', 'pouches', 'packet', 'packets', 'pack', 'packs',
  'leaf', 'leaves', 'glass', 'glasses', 'cube', 'cubes', 'container', 'containers', 'cone', 'cones',
  'box', 'boxes', 'bottle', 'bottles', 'block', 'blocks', 'bag', 'bags', 'part', 'parts', 'stick',
  'sticks', 'head', 'heads', 'bar', 'bars', 'ear', 'ears', 'jar', 'jars', 'tub', 'tubs', 'small',
  'medium', 'large', 'dose', 'dosen', 'glas', 'gläser', 'packung', 'packungen', 'päckchen', 'beutel',
  'flasche', 'flaschen', 'zehe', 'zehen', 'knolle', 'knollen', 'kopf', 'köpfe', 'bund', 'bünde',
  'blatt', 'blätter', 'spritzer', 'tropf', 'tropfen', 'prise', 'prisen', 'stück', 'stücke', 'stiel',
  'stiele', 'stange', 'stangen', 'würfel', 'etwas', 'nach belieben', 'viel', 'do.', 'gl.', 'pck',
  'pck.', 'pk', 'pk.', 'pckg', 'pckg.', 'btl', 'btl.', 'bt', 'bt.', 'fl', 'fl.', 'kn', 'kn.', 'bd',
  'bd.', 'bn', 'bn.', 'bl', 'bl.', 'spr', 'spr.', 'tr', 'tr.', 'pr', 'pr.', 'stk', 'stk.', 'st',
  'st.', 'stck', 'stck.', 'stg', 'stg.', 'wf', 'wf.', 'n. b.',
];
const PACKAGE_KEYS = new Set(PACKAGE_WORDS.map(p => rstripDots(p.toLowerCase())));

const SINGULAR_PLURAL = {
  peck: 'pecks', bushel: 'bushels', bucket: 'buckets', slice: 'slices', clove: 'cloves',
  loaf: 'loaves', pinch: 'pinches', package: 'packages', can: 'cans', drop: 'drops',
  bunch: 'bunches', dash: 'dashes', carton: 'cartons', piece: 'pieces', square: 'squares',
  tube: 'tubes', strip: 'strips', stem: 'stems', stalk: 'stalks', sprig: 'sprigs',
  spear: 'spears', sprout: 'sprouts', sheet: 'sheets', scoop: 'scoops', pouch: 'pouches',
  packet: 'packets', pack: 'packs', leaf: 'leaves', glass: 'glasses', cube: 'cubes',
  container: 'containers', cone: 'cones', box: 'boxes', bottle: 'bottles', block: 'blocks',
  bag: 'bags', part: 'parts', stick: 'sticks', head: 'heads', bar: 'bars', ear: 'ears',
  jar: 'jars', inch: 'inches', tub: 'tubs', cup: 'cups', ounce: 'ounces', gallon: 'gallons',
  pint: 'pints', pound: 'pounds', quart: 'quarts', tablespoon: 'tablespoons',
  teaspoon: 'teaspoons', gram: 'grams', kilogram: 'kilograms', milligram: 'milligrams',
  liter: 'liters', deciliter: 'deciliters', milliliter: 'milliliters', tasse: 'tassen',
  dose: 'dosen', flasche: 'flaschen', zehe: 'zehen', knolle: 'knollen', kopf: 'köpfe',
  bund: 'bünde', blatt: 'blätter', tropf: 'tropfen', prise: 'prisen', stück: 'stücke',
  stiel: 'stiele', stange: 'stangen',
};
// Longest plural first, so a shorter token can't steal part of a longer one.
const SINGULARIZERS = Object.entries(SINGULAR_PLURAL)
  .map(([singular, plural]) => [plural, singular])
  .sort((a, b) => b[0].length - a[0].length)
  .map(([plural, singular]) => [new RegExp(`(?<!${W})${escapeRegex(plural)}(?!${W})`, 'giu'), singular]);

// Divergence from aioanylist, matching the app: a dot after the alias is kept, so
// the package "4.5 oz. can" keys as "4.5 oz. can", not "4.5 oz can" (golden fixture).
const ALIAS_REPLACERS = Object.entries(UNIT_NORMALIZATION_GROUPS).flatMap(([canonical, aliases]) =>
  aliases.map(alias => [
    new RegExp(`(?<!${W})${escapeRegex(alias).replace(/ /g, '\\s+')}(?!${W})`, 'giu'),
    canonical,
  ]));

const UNIT_OR_PACKAGE_MATCHERS = [...new Set([...Object.values(UNIT_MATCH_GROUPS).flat(), ...PACKAGE_WORDS])]
  .sort((a, b) => b.length - a.length)
  // Divergence from aioanylist, matching the app: a trailing dot stays with the
  // unit ("1 tbsp." has unit "tbsp.").
  .map(candidate => new RegExp(`^${escapeRegex(candidate)}(?:\\.|${B})`, 'iu'));

const FRAC = `(?:\\d+\\s*[\\/⁄]\\s*\\d+|[${VULGAR}]|[${SUPERS}]+\\s*[\\/⁄]\\s*[${SUBS}]+)`;
const NUM = `(?:(?:(?:\\d+)?(?:\\s+|[${DASH_CLASS}])?${FRAC})|(?:\\d+(?:,\\d+)?(?:\\.\\d+)?|\\.\\d+))`;
const MIXED_PREFIX_RE = new RegExp(`^\\d+(?:\\s+|[${DASH_CLASS}])\\s*${FRAC}(?=$|\\s|[A-Za-z(])`, 'u');
const RANGE_RE = new RegExp(
  `^(${NUM})((?:\\s+(?:to|or)\\s+)|(?:\\s*[${DASH_CLASS}]\\s*))(${NUM})(?=$|\\s|[A-Za-z(])`, 'iu');
const SINGLE_RE = new RegExp(`^(${NUM})(?=$|\\s|[A-Za-z(\\-])`, 'iu');
const TRIM_CHARS_RE = new RegExp(`^[\\s,${DASH_CLASS}•]+|[\\s,${DASH_CLASS}•]+$`, 'gu');

export function normalizeDigits(text) {
  return text.replace(/[٠-٩۰-۹०-९]/g, ch => String(DIGIT_SOURCES.indexOf(ch) % 10));
}

export function trimWhitespaceAndPunctuation(text) {
  return text.replace(TRIM_CHARS_RE, '');
}

/**
 * Parse the amount at the start of `text` ("2", "1 1/2", "2-1/2", "1/2 to 3/4").
 * @returns {[{ raw: string, isRange: boolean } | null, string]} the amount and the rest
 */
export function parseLeadingAmount(text) {
  const value = normalizeDigits(text.trim());
  // "2-1/2" is a mixed fraction, not a range; test it before the range regex.
  let m = value.match(MIXED_PREFIX_RE);
  if (m) return [{ raw: m[0], isRange: false }, value.slice(m[0].length)];
  m = value.match(RANGE_RE);
  if (m) return [{ raw: `${m[1]} - ${m[3]}`, isRange: true }, value.slice(m[0].length)];
  m = value.match(SINGLE_RE);
  if (!m) return [null, value];
  return [{ raw: m[1], isRange: false }, value.slice(m[0].length)];
}

export function singularizeUnitsInText(text) {
  let value = text || '';
  for (const [re, singular] of SINGULARIZERS) value = value.replace(re, singular);
  return value;
}

/** PBItemQuantity.normalizedUnit: alias lookup, then singularize container words. */
export function normalizeUnit(unit) {
  const raw = unit.trim();
  return singularizeUnitsInText(UNIT_LOOKUP.get(unitKey(raw)) ?? raw);
}

/** Normalize every recognized unit alias inside `text`, then singularize. */
export function normalizeUnitsInText(text) {
  let value = text || '';
  for (const [re, canonical] of ALIAS_REPLACERS) value = value.replace(re, canonical);
  return singularizeUnitsInText(value);
}

function matchUnitOrPackage(rest) {
  const value = stripChars(rest, ' ,-');
  for (const re of UNIT_OR_PACKAGE_MATCHERS) {
    const m = value.match(re);
    if (m) return [value.slice(0, m[0].length).trim(), value.slice(m[0].length)];
  }
  return ['', value];
}

/** @returns {{ size: string, rawPackageSize: string, unit?: string, packageType?: string } | null} */
export function parsePackageSize(text, { requireUnit = true } = {}) {
  const raw = trimWhitespaceAndPunctuation(text);
  if (!raw) return null;
  let candidate = raw.trim();
  if (candidate.startsWith('(') && candidate.endsWith(')')) candidate = candidate.slice(1, -1).trim();
  const [amount, rest] = parseLeadingAmount(candidate);
  if (!amount) return null;
  const [unit, afterUnit] = matchUnitOrPackage(rest);
  let tail = afterUnit;
  if (requireUnit && !unit) return null;
  let packageType = '';
  // A container word after a measurement unit is the package type ("12 ounce jar").
  if (unit && UNIT_MATCH_KEYS.has(unitKey(unit))) {
    const [pt, tail2] = matchUnitOrPackage(tail);
    if (pt && PACKAGE_KEYS.has(rstripDots(pt.toLowerCase()))) {
      packageType = pt;
      tail = tail2;
    }
  }
  const out = { size: amount.raw };
  if (unit) out.unit = unit.trim();
  if (packageType) out.packageType = packageType.trim();
  // Divergence from aioanylist, matching the app: rawPackageSize is rebuilt from
  // the parts, so "4.5-oz." becomes "4.5 oz." (see the golden fixture).
  out.rawPackageSize = unit
    ? [out.size, out.unit, out.packageType].filter(Boolean).join(' ')
    : stripChars(candidate.slice(0, candidate.length - tail.length), ' ,-') || candidate;
  return out;
}

/**
 * Split a recipe quantity ("2 cans (28 oz)") into a PBItemQuantity and a
 * PBItemPackageSize, as plain objects.
 * @returns {{ quantityPb?: object, packageSizePb?: object } | null}
 */
export function parseQuantityAndPackageSize(text) {
  const raw = text.trim();
  if (!raw) return null;
  const [amount, afterAmount] = parseLeadingAmount(raw);
  if (!amount) return null;
  const rest = afterAmount.trim();

  let quantity = null;
  let pkg = null;
  const [unit, tail] = matchUnitOrPackage(rest);
  const parenthetical = (unit ? tail : rest).match(/\(([^()]*)\)/);

  if (unit) {
    const isMeasurement = UNIT_MATCH_KEYS.has(unitKey(unit));
    const isContainer = PACKAGE_KEYS.has(rstripDots(unit.toLowerCase()));
    if (isMeasurement || isContainer) {
      quantity = { amount: amount.raw, unit: unit.trim(), rawQuantity: `${amount.raw} ${unit.trim()}` };
    }
    if (parenthetical) {
      pkg = parsePackageSize(parenthetical[1]);
    } else if (isContainer) {
      // "2 12 ounce jars": the package size can precede the container.
      if (parseLeadingAmount(rest)[0]) pkg = parsePackageSize(rest);
    } else {
      // A package expression may follow a measurement: "1 cup 8 oz package".
      pkg = parsePackageSize(tail);
    }
  } else if (parenthetical) {
    // "1 (6-oz can)"
    quantity = { amount: amount.raw, rawQuantity: amount.raw };
    pkg = parsePackageSize(parenthetical[1]);
    // Divergence from aioanylist, matching the app: in "2 (15-oz.) cans" the
    // container after the parentheses is the package type ("15 oz. can").
    const [container] = matchUnitOrPackage(rest.slice(parenthetical.index + parenthetical[0].length));
    if (pkg && pkg.unit && !pkg.packageType && container && PACKAGE_KEYS.has(rstripDots(container.toLowerCase()))) {
      pkg.packageType = container;
      pkg.rawPackageSize = `${pkg.rawPackageSize} ${container}`;
    }
  } else {
    quantity = { amount: amount.raw, rawQuantity: amount.raw };
    const candidate = parsePackageSize(rest);
    if (candidate && rest) pkg = candidate;
  }

  // The full original text stays in rawQuantity only when no package size was parsed.
  if (quantity && !pkg) quantity.rawQuantity = raw;

  if (!quantity && !pkg) return null;
  const result = {};
  if (quantity) result.quantityPb = quantity;
  if (pkg) result.packageSizePb = pkg;
  return result;
}

// Adjacent unit/container tokens that belong to a quantity prefix (JD).
const PACKAGE_OR_UNIT_RE = new RegExp(
  '^(?:cups?|c\\.?|tassen?|tas\\.?|tasse/n|becher|be\\.?|bch\\.?|fluid ounces?|'
  + 'fl\\.?\\s*oz\\.?|gallons?|gal\\.?|troy ounces?|oz\\.?\\s*t\\.?|t\\.?\\s*oz\\.?|'
  + 'ounces?|oz\\.?|pints?|pt\\.?|pounds?|lbs?\\.?|pfund|pf\\.?|quarts?|qts?\\.?|'
  + 'tablespoons?|tbsps?\\.?|tbs?\\.?|tbl\\.?|t\\.?|msk\\.?|ss\\.?|spsk\\.?|rkl\\.?|'
  + 'el\\.?|esslöffel|teaspoons?|tsps?\\.?|ts?\\.?|tsk\\.?|tl\\.?|teelöffel|grams?|'
  + 'gr?\\.?|gramm|kilograms?|kg\\.?|kilogramm|milligrams?|mg\\.?|liters?|l\\.?|'
  + 'deciliters?|dl\\.?|milliliters?|ml\\.?|krm\\.?|pecks?|bushels?|buckets?|slices?|'
  + 'doz(?:en|\\.)?|cloves?|loaf|loaves|pinch(?:es)?|packages?|pkg\\.?|cans?|drops?|'
  + 'bunch(?:es)?|dash(?:es)?|cartons?|each|pieces?|to taste|squares?|tubes?|strips?|'
  + 'stems?|stalks?|sprigs?|spears?|sprouts?|sheets?|scoops?|pouch(?:es)?|packets?|'
  + 'packs?|leaf|leaves|glass(?:es)?|cubes?|containers?|cones?|box(?:es)?|bottles?|'
  + 'blocks?|bags?|parts?|sticks?|heads?|bars?|ears?|jars?|inches?|tubs?|small|medium|'
  + 'large|dosen?|do\\.?|glas|gläser|gl\\.?|packung(?:en)?|pck\\.?|pk\\.?|pckg\\.?|'
  + 'päckchen|beutel|btl\\.?|bt\\.?|flaschen?|fl\\.?|zehen?|knollen?|kn\\.?|kopf|köpfe|'
  + 'bund|bünde|bd\\.?|bn\\.?|blatt|blätter|bl\\.?|spritzer|spr?\\.?|tropf(?:en)?|tr\\.?|'
  + 'prisen?|prise\\(n\\)|pr\\.?|stücke?|stk\\.?|st\\.?|stck\\.?|stiele?|stangen?|stg\\.?|'
  + 'würfel|wf\\.?|etwas|nach belieben|n\\.\\s*b\\.|viel)(?=$|\\s|,)',
  'iu');
const TRAILING_SIZE_ADJECTIVE_RE = /(?:(?:small|medium|large)\s*)+$/i;

/**
 * Split "12 ounces jars tomatoes" into its quantity prefix and the rest.
 * @returns {[string, string]}
 */
export function splitQuantityPrefix(line) {
  const cleaned = stripChars(line, ' \t,-•–—');
  const [amount, rest] = parseLeadingAmount(cleaned);
  if (!amount) return ['', cleaned];
  let consumed = cleaned.slice(0, cleaned.length - rest.length);
  let remainder = rest;

  // Consume every adjacent unit/container token ("1/2 small head").
  for (;;) {
    const stripped = remainder.trimStart();
    const gap = remainder.slice(0, remainder.length - stripped.length);
    const token = stripped.match(PACKAGE_OR_UNIT_RE);
    if (!token) break;
    consumed += gap + token[0];
    remainder = stripped.slice(token[0].length);
  }

  // A parenthesized package expression stays part of the prefix.
  const parenthetical = remainder.match(/^\s*(\([^()]+\))/);
  if (parenthetical) {
    consumed += remainder.slice(0, parenthetical[0].length);
    remainder = remainder.slice(parenthetical[0].length);
  }

  consumed = trimWhitespaceAndPunctuation(consumed);
  remainder = trimWhitespaceAndPunctuation(remainder);
  // Only a trailing size adjective moves back to the ingredient side.
  const adjective = consumed.match(TRAILING_SIZE_ADJECTIVE_RE);
  if (adjective) {
    const moved = adjective[0].trim();
    consumed = trimWhitespaceAndPunctuation(consumed.slice(0, adjective.index));
    remainder = trimWhitespaceAndPunctuation(`${moved} ${remainder}`);
  }
  return [consumed, remainder];
}
