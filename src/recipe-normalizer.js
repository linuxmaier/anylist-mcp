import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';

/**
 * Normalize a recipe from various input types into AnyList-compatible format.
 * @param {Object} input - { url?: string, text?: string, recipe?: object }
 * @returns {Promise<Object>} Normalized recipe object
 */
export async function normalizeRecipe(input) {
  if (!input || (!input.url && !input.text && !input.recipe)) {
    throw new Error('normalizeRecipe requires at least one of: url, text, recipe');
  }

  if (input.url) {
    return await normalizeFromUrl(input.url);
  }
  if (input.text) {
    return normalizeFromText(input.text);
  }
  if (input.recipe) {
    return normalizeFromObject(input.recipe);
  }
}

// ===== URL Parsing =====

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Recipe URLs come from a chat, so a link (or a prompt injection) could point the
// server at the machine it runs on or its network: loopback, the LAN, other
// containers, the tailnet, or a cloud metadata service. Only public addresses
// are fetched (#24).
const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) NON_PUBLIC.addSubnet(address, prefix, 'ipv6');
// IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked against the IPv4 ranges by BlockList.

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

class BlockedAddressError extends Error {
  constructor(host) {
    super(`Refusing to fetch from ${host}: it is not a public internet address`);
  }
}

/**
 * A `lookup` for http(s).get that resolves every address for the host and
 * fails unless all of them pass `isAllowed`. The socket then connects to an
 * address that was checked, so a second DNS answer can't swap it.
 */
function checkedLookup(isAllowed, resolve) {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (addresses.length === 0 || !addresses.every(a => isAllowed(a.address))) {
        return callback(new BlockedAddressError(hostname));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * Which addresses URL fetches may connect to, and how hostnames are resolved.
 * Only tests change these, to reach fixture servers on loopback.
 */
export const fetchPolicy = { isAllowed: isPublicAddress, lookup: dns.lookup };

async function fetchHtml(url, redirectsLeft = MAX_REDIRECTS) {
  const { isAllowed, lookup } = fetchPolicy;
  return new Promise((resolve, reject) => {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') {
      reject(new Error(`Unsupported URL scheme: ${protocol}`));
      return;
    }
    // Node skips `lookup` for IP literals, so check those here.
    const literal = hostname.replace(/^\[(.*)\]$/, '$1');
    if (net.isIP(literal) && !isAllowed(literal)) {
      reject(new BlockedAddressError(hostname));
      return;
    }
    const client = protocol === 'https:' ? https : http;
    const req = client.get(url, {
      lookup: checkedLookup(isAllowed, lookup),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchHtml(redirectUrl, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_HTML_BYTES) {
          req.destroy();
          reject(new Error(`Response too large fetching ${url}`));
        }
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function normalizeFromUrl(url) {
  const html = await fetchHtml(url);

  // 1. Try JSON-LD
  const jsonLd = extractJsonLd(html);
  if (jsonLd) {
    const recipe = parseSchemaRecipe(jsonLd, url);
    if (recipe) return recipe;
  }

  // 2. Try heuristic HTML parsing
  const heuristic = parseHeuristicHtml(html, url);
  if (heuristic && heuristic.name && (heuristic.ingredients.length > 0 || heuristic.preparationSteps.length > 0)) {
    return heuristic;
  }

  throw new Error(`Could not extract recipe from ${url}. No structured data or recognizable recipe pattern found.`);
}

function extractJsonLd(html) {
  const scriptRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      let data = JSON.parse(match[1].trim());
      // Handle @graph arrays
      if (data['@graph'] && Array.isArray(data['@graph'])) {
        const recipe = data['@graph'].find(item =>
          item['@type'] === 'Recipe' ||
          (Array.isArray(item['@type']) && item['@type'].includes('Recipe'))
        );
        if (recipe) return recipe;
      }
      // Handle arrays
      if (Array.isArray(data)) {
        const recipe = data.find(item =>
          item['@type'] === 'Recipe' ||
          (Array.isArray(item['@type']) && item['@type'].includes('Recipe'))
        );
        if (recipe) return recipe;
      }
      // Direct recipe
      if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) {
        return data;
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  return null;
}

function parseSchemaRecipe(schema, sourceUrl) {
  const name = cleanText(schema.name);
  if (!name) return null;

  const ingredients = parseSchemaIngredients(schema.recipeIngredient);
  const steps = parseSchemaSteps(schema.recipeInstructions);

  return {
    name,
    ingredients,
    preparationSteps: steps,
    note: cleanText(schema.description) || null,
    sourceName: extractDomain(sourceUrl),
    sourceUrl,
    prepTime: parseDuration(schema.prepTime) || null,
    cookTime: parseDuration(schema.cookTime) || null,
    servings: parseServings(schema.recipeYield) || null,
  };
}

function parseSchemaIngredients(recipeIngredient) {
  if (!recipeIngredient) return [];
  if (!Array.isArray(recipeIngredient)) recipeIngredient = [recipeIngredient];
  return recipeIngredient.map(i => ({ rawIngredient: cleanText(String(i)) })).filter(i => i.rawIngredient);
}

function parseSchemaSteps(instructions) {
  if (!instructions) return [];
  if (typeof instructions === 'string') {
    return instructions.split(/\n+/).map(s => cleanText(s)).filter(Boolean);
  }
  if (!Array.isArray(instructions)) instructions = [instructions];

  const steps = [];
  for (const item of instructions) {
    if (typeof item === 'string') {
      steps.push(cleanText(item));
    } else if (item.text) {
      steps.push(cleanText(item.text));
    } else if (item['@type'] === 'HowToSection' && Array.isArray(item.itemListElement)) {
      for (const sub of item.itemListElement) {
        if (typeof sub === 'string') steps.push(cleanText(sub));
        else if (sub.text) steps.push(cleanText(sub.text));
      }
    } else if (item.itemListElement && Array.isArray(item.itemListElement)) {
      for (const sub of item.itemListElement) {
        if (typeof sub === 'string') steps.push(cleanText(sub));
        else if (sub.text) steps.push(cleanText(sub.text));
      }
    }
  }
  return steps.filter(Boolean);
}

// Returns seconds, the unit AnyList stores prepTime/cookTime in.
function parseDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function parseServings(recipeYield) {
  if (!recipeYield) return null;
  if (Array.isArray(recipeYield)) recipeYield = recipeYield[0];
  return cleanText(String(recipeYield)) || null;
}

// ===== Heuristic HTML Parsing =====

function parseHeuristicHtml(html, sourceUrl) {
  const name = extractTitle(html);
  const ingredients = extractIngredients(html);
  const steps = extractSteps(html);

  return {
    name: name || 'Untitled Recipe',
    ingredients: ingredients.map(i => ({ rawIngredient: i })),
    preparationSteps: steps,
    note: null,
    sourceName: extractDomain(sourceUrl),
    sourceUrl,
    prepTime: null,
    cookTime: null,
    servings: null,
  };
}

function extractTitle(html) {
  // Try <h1>
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = cleanText(stripHtml(h1[1]));
    if (text && text.length < 200) return text;
  }
  // Try <title>
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    let text = cleanText(stripHtml(title[1]));
    // Remove site name suffix like " - Budget Bytes"
    text = text.replace(/\s*[-|–—]\s*[^-|–—]+$/, '').trim();
    if (text) return text;
  }
  return null;
}

function extractIngredients(html) {
  const ingredients = [];

  // Look for elements with ingredient-related class names
  const ingredientPatterns = [
    /class\s*=\s*["'][^"']*(?:recipe-ingredient|wprm-recipe-ingredient|ingredient-item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div|span|p)/gi,
    /class\s*=\s*["'][^"']*ingredient[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div|span|p)/gi,
  ];

  for (const pattern of ingredientPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const text = cleanText(stripHtml(match[1]));
      if (text && text.length > 2 && text.length < 200) {
        ingredients.push(text);
      }
    }
    if (ingredients.length > 0) return ingredients;
  }

  return ingredients;
}

function extractSteps(html) {
  const steps = [];

  // Look for elements with step/instruction/direction class names
  const stepPatterns = [
    /class\s*=\s*["'][^"']*(?:recipe-step|wprm-recipe-instruction|instruction-text|direction-text)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div|span|p)/gi,
    /class\s*=\s*["'][^"']*(?:instruction|direction|step)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div|span|p)/gi,
  ];

  for (const pattern of stepPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const text = cleanText(stripHtml(match[1]));
      if (text && text.length > 10) {
        steps.push(text);
      }
    }
    if (steps.length > 0) return steps;
  }

  return steps;
}

// ===== Text Parsing =====

function normalizeFromText(text) {
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('Empty recipe text provided');
  }


  let name = 'Untitled Recipe';
  let ingredientLines = [];
  let stepLines = [];

  // Try to find section headers
  const ingredientHeaderIdx = lines.findIndex(l => /^(ingredients|ingredient list)\s*:?\s*$/i.test(l));
  const stepHeaderIdx = lines.findIndex(l => /^(instructions|directions|steps|method|preparation)\s*:?\s*$/i.test(l));

  if (ingredientHeaderIdx >= 0 || stepHeaderIdx >= 0) {
    // Extract name from lines before first header
    const firstHeader = Math.min(
      ingredientHeaderIdx >= 0 ? ingredientHeaderIdx : Infinity,
      stepHeaderIdx >= 0 ? stepHeaderIdx : Infinity
    );
    if (firstHeader > 0) {
      name = lines[0];
    }

    if (ingredientHeaderIdx >= 0) {
      const end = stepHeaderIdx > ingredientHeaderIdx ? stepHeaderIdx : lines.length;
      ingredientLines = lines.slice(ingredientHeaderIdx + 1, end);
    }

    if (stepHeaderIdx >= 0) {
      const end = ingredientHeaderIdx > stepHeaderIdx ? ingredientHeaderIdx : lines.length;
      stepLines = lines.slice(stepHeaderIdx + 1, end);
    }
  } else {
    // No headers found — first line is name, rest are ingredients until we see numbered steps
    name = lines[0];
    const remaining = lines.slice(1);
    const firstNumbered = remaining.findIndex(l => /^\d+[\.\)]\s/.test(l));
    if (firstNumbered >= 0) {
      ingredientLines = remaining.slice(0, firstNumbered);
      stepLines = remaining.slice(firstNumbered);
    } else {
      ingredientLines = remaining;
    }
  }

  // Clean ingredient lines (remove bullets, dashes)
  const ingredients = ingredientLines
    .map(l => l.replace(/^[-•*]\s*/, '').trim())
    .filter(l => l.length > 1)
    .map(l => ({ rawIngredient: l }));

  // Clean step lines (remove numbering)
  const preparationSteps = stepLines
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l.length > 5);

  return {
    name,
    ingredients,
    preparationSteps,
    note: null,
    sourceName: null,
    sourceUrl: null,
    prepTime: null,
    cookTime: null,
    servings: null,
  };
}

// ===== Object Normalization =====

function normalizeFromObject(recipe) {
  const name = cleanText(recipe.name) || 'Untitled Recipe';

  let ingredients = [];
  if (Array.isArray(recipe.ingredients)) {
    ingredients = recipe.ingredients.map(i => {
      if (typeof i === 'string') return { rawIngredient: cleanText(i) };
      if (i.rawIngredient) return { rawIngredient: cleanText(i.rawIngredient) };
      const parts = [i.quantity, i.name, i.note].filter(Boolean).map(String);
      return { rawIngredient: cleanText(parts.join(' ')) };
    }).filter(i => i.rawIngredient);
  }

  let preparationSteps = [];
  if (Array.isArray(recipe.preparationSteps || recipe.steps || recipe.instructions)) {
    preparationSteps = (recipe.preparationSteps || recipe.steps || recipe.instructions)
      .map(s => cleanText(String(s)))
      .filter(Boolean);
  }

  return {
    name,
    ingredients,
    preparationSteps,
    note: cleanText(recipe.note || recipe.description) || null,
    sourceName: cleanText(recipe.sourceName || recipe.source) || null,
    sourceUrl: recipe.sourceUrl || recipe.url || null,
    prepTime: cleanText(String(recipe.prepTime || '')) || null,
    cookTime: cleanText(String(recipe.cookTime || '')) || null,
    servings: cleanText(String(recipe.servings || '')) || null,
  };
}

// ===== Utilities =====

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
