// English (Porter2 / Snowball 2.x) stemmer, which the AnyList web client applies to
// each word of an ingredient name when it derives a list-item ID.
//
// Based on aioanylist's src/aioanylist/stemming.py at commit 8df7f406335a
// (https://github.com/BookCatKid/aioanylist; MIT License, Copyright (c) 2026
// aioanylist contributors), corrected to the Snowball algorithm
// (https://snowballstem.org/algorithms/english/stemmer.html): a marked "Y" is a
// consonant, steps 1b-4 pick the longest suffix before checking its region, and
// "eed" outside R1 is left alone. The app stems "seeds" to "seed", as Snowball does.
// Verified against snowballstemmer 2.2.0 (Snowball 3.0 changed some rules).

const isVowel = ch => 'aeiouy'.includes(ch);
const EXCEPTION1 = {
  skis: 'ski', skies: 'sky', dying: 'die', lying: 'lie', tying: 'tie', idly: 'idl',
  gently: 'gentl', ugly: 'ugli', early: 'earli', only: 'onli', singly: 'singl',
  sky: 'sky', news: 'news', howe: 'howe', atlas: 'atlas', cosmos: 'cosmos',
  bias: 'bias', andes: 'andes',
};
const EXCEPTION2 = new Set(['inning', 'outing', 'canning', 'herring', 'earring', 'proceed', 'exceed', 'succeed']);
const R1_SPECIAL = ['gener', 'commun', 'arsen'];
const DOUBLES = ['bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt'];
const STEP2 = {
  tional: 'tion', enci: 'ence', anci: 'ance', abli: 'able', entli: 'ent', izer: 'ize',
  ization: 'ize', ational: 'ate', ation: 'ate', ator: 'ate', alism: 'al', aliti: 'al',
  alli: 'al', fulness: 'ful', ousli: 'ous', ousness: 'ous', iveness: 'ive', iviti: 'ive',
  biliti: 'ble', bli: 'ble', ogi: 'og', fulli: 'ful', lessli: 'less', li: '',
};
const STEP3 = {
  tional: 'tion', ational: 'ate', alize: 'al', icate: 'ic', iciti: 'ic', ical: 'ic',
  ful: '', ness: '', ative: '',
};
const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment',
  'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'ion'];

/** The longest of `suffixes` that `word` ends with, or undefined. */
const longestSuffix = (word, suffixes) => suffixes
  .filter(s => word.endsWith(s))
  .reduce((best, s) => (best === undefined || s.length > best.length ? s : best), undefined);
const containsVowel = text => [...text].some(isVowel);

function markYs(word) {
  const chars = [...word];
  if (chars[0] === 'y') chars[0] = 'Y';
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] === 'y' && isVowel(chars[i - 1])) chars[i] = 'Y';
  }
  return chars.join('');
}

// R1 starts after the first non-vowel that follows a vowel; R2 is R1 applied to R1.
function regions(word) {
  const after = start => {
    for (let i = start + 1; i < word.length; i++) {
      if (isVowel(word[i - 1]) && !isVowel(word[i])) return i + 1;
    }
    return word.length;
  };
  const special = R1_SPECIAL.find(p => word.startsWith(p));
  const r1 = special ? special.length : after(0);
  return [r1, after(r1)];
}

// A short syllable ends the word: non-vowel, vowel, non-vowel other than w/x/Y;
// or, for a two-letter word, vowel then non-vowel.
function endsWithShortSyllable(word) {
  if (word.length === 2) return isVowel(word[0]) && !isVowel(word[1]);
  if (word.length < 3) return false;
  const [a, b, c] = word.slice(-3);
  return !isVowel(a) && isVowel(b) && !isVowel(c) && !'wxY'.includes(c);
}

export function englishStem(raw) {
  let word = raw.toLowerCase();
  if (word.length <= 2) return word;
  if (Object.hasOwn(EXCEPTION1, word)) return EXCEPTION1[word];

  if (word.startsWith("'")) word = word.slice(1);
  word = markYs(word);
  const [r1, r2] = regions(word);
  const inR1 = suffix => word.length - suffix.length >= r1;
  const inR2 = suffix => word.length - suffix.length >= r2;
  const replace = (suffix, by) => { word = word.slice(0, word.length - suffix.length) + by; };

  // Step 0
  const s0 = longestSuffix(word, ["'s'", "'s", "'"]);
  if (s0) replace(s0, '');

  // Step 1a
  const s1a = longestSuffix(word, ['sses', 'ied', 'ies', 'us', 'ss', 's']);
  if (s1a === 'sses') {
    replace(s1a, 'ss');
  } else if (s1a === 'ied' || s1a === 'ies') {
    replace(s1a, word.length > 4 ? 'i' : 'ie');
  } else if (s1a === 's') {
    // Delete if a vowel appears before the letter preceding the s.
    if (containsVowel(word.slice(0, -2))) replace(s1a, '');
  }

  if (EXCEPTION2.has(word)) return word;

  // Step 1b
  const s1b = longestSuffix(word, ['eed', 'eedly', 'ed', 'edly', 'ing', 'ingly']);
  if (s1b === 'eed' || s1b === 'eedly') {
    if (inR1(s1b)) replace(s1b, 'ee');
  } else if (s1b && containsVowel(word.slice(0, -s1b.length))) {
    replace(s1b, '');
    if (['at', 'bl', 'iz'].some(s => word.endsWith(s))) {
      word += 'e';
    } else if (DOUBLES.some(s => word.endsWith(s))) {
      word = word.slice(0, -1);
    } else if (r1 >= word.length && endsWithShortSyllable(word)) {
      word += 'e';
    }
  }

  // Step 1c
  if (word.length > 2 && 'yY'.includes(word.at(-1)) && !isVowel(word.at(-2))) {
    replace('y', 'i');
  }

  // Step 2
  const s2 = longestSuffix(word, Object.keys(STEP2));
  if (s2 && inR1(s2)) {
    const before = word.at(-s2.length - 1) || '';
    if (s2 === 'ogi') {
      if (before === 'l') replace(s2, 'og');
    } else if (s2 === 'li') {
      if ('cdeghkmnrt'.includes(before) && before) replace(s2, '');
    } else {
      replace(s2, STEP2[s2]);
    }
  }

  // Step 3
  const s3 = longestSuffix(word, Object.keys(STEP3));
  if (s3 && inR1(s3) && (s3 !== 'ative' || inR2(s3))) replace(s3, STEP3[s3]);

  // Step 4
  const s4 = longestSuffix(word, STEP4);
  if (s4 && inR2(s4)) {
    if (s4 !== 'ion' || ['s', 't'].includes(word.at(-4))) replace(s4, '');
  }

  // Step 5
  if (word.endsWith('e')) {
    const base = word.slice(0, -1);
    if (base.length >= r2 || (base.length >= r1 && !endsWithShortSyllable(base))) word = base;
  } else if (word.endsWith('ll') && word.length - 1 >= r2) {
    word = word.slice(0, -1);
  }

  return word.replaceAll('Y', 'y');
}

/** Stem each non-empty word. */
export function stemWords(words) {
  return words.filter(w => w !== '').map(englishStem);
}
