import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipe, isPublicAddress, fetchPolicy } from '../src/recipe-normalizer.js';
import http from 'node:http';

// The fixture servers listen on loopback, which real fetches refuse (#24).
const DEFAULT_POLICY = { ...fetchPolicy };
const allowLoopback = () => { fetchPolicy.isAllowed = a => a === '127.0.0.1' || isPublicAddress(a); };
const restorePolicy = () => Object.assign(fetchPolicy, DEFAULT_POLICY);

describe('Recipe Normalizer', () => {
  describe('text parsing', () => {
    it('parses recipe text with section headers', async () => {
      const text = `Chocolate Chip Cookies

Ingredients
2 cups flour
1 cup sugar
1/2 cup butter
2 eggs

Instructions
1. Mix dry ingredients
2. Cream butter and sugar
3. Combine and bake at 350F for 12 minutes`;

      const result = await normalizeRecipe({ text });
      assert.equal(result.name, 'Chocolate Chip Cookies');
      assert.equal(result.ingredients.length, 4);
      assert.equal(result.ingredients[0].rawIngredient, '2 cups flour');
      assert.equal(result.preparationSteps.length, 3);
      assert.ok(result.preparationSteps[0].includes('Mix dry ingredients'));
    });

    it('parses recipe text without headers (numbered steps)', async () => {
      const text = `Quick Salad
mixed greens
cherry tomatoes
olive oil
1. Toss greens in a bowl
2. Add tomatoes and drizzle with olive oil`;

      const result = await normalizeRecipe({ text });
      assert.equal(result.name, 'Quick Salad');
      assert.equal(result.ingredients.length, 3);
      assert.equal(result.preparationSteps.length, 2);
    });

    it('throws on empty text', async () => {
      await assert.rejects(() => normalizeRecipe({ text: '   ' }), /Empty recipe text/);
    });
  });

  describe('object normalization', () => {
    it('normalizes a partial recipe object', async () => {
      const result = await normalizeRecipe({
        recipe: {
          name: '  Test Recipe  ',
          ingredients: ['2 cups flour', '1 cup sugar'],
          steps: ['Mix together', 'Bake'],
          source: 'Mom',
        }
      });
      assert.equal(result.name, 'Test Recipe');
      assert.equal(result.ingredients.length, 2);
      assert.equal(result.preparationSteps.length, 2);
      assert.equal(result.sourceName, 'Mom');
    });

    it('handles ingredient objects', async () => {
      const result = await normalizeRecipe({
        recipe: {
          name: 'Test',
          ingredients: [
            { rawIngredient: '2 cups flour' },
            { quantity: '1 cup', name: 'sugar' },
          ],
        }
      });
      assert.equal(result.ingredients[0].rawIngredient, '2 cups flour');
      assert.equal(result.ingredients[1].rawIngredient, '1 cup sugar');
    });
  });

  describe('input validation', () => {
    it('throws when no input provided', async () => {
      await assert.rejects(() => normalizeRecipe({}), /requires at least one/);
    });

    it('throws when null provided', async () => {
      await assert.rejects(() => normalizeRecipe(null), /requires at least one/);
    });
  });

  describe('JSON-LD parsing (via HTML string)', () => {
    it('normalizes schema.org-like recipe object', async () => {
      const result = await normalizeRecipe({
        recipe: {
          name: 'Pasta Carbonara',
          ingredients: ['200g spaghetti', '100g pancetta', '2 eggs', '50g parmesan'],
          preparationSteps: ['Boil pasta', 'Fry pancetta', 'Mix eggs and cheese', 'Combine all'],
          prepTime: '10 min',
          cookTime: '20 min',
          servings: '4',
          sourceUrl: 'https://example.com/carbonara',
        }
      });
      assert.equal(result.name, 'Pasta Carbonara');
      assert.equal(result.ingredients.length, 4);
      assert.equal(result.preparationSteps.length, 4);
      assert.equal(result.servings, '4');
    });
  });
});

describe('Recipe Normalizer URL fetch limits', () => {
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        res.end();
      } else if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const chunk = 'x'.repeat(1024 * 1024);
        for (let i = 0; i < 6; i++) res.write(chunk);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    allowLoopback();
  });

  after(() => { server.close(); restorePolicy(); });

  it('rejects non-http(s) schemes', async () => {
    await assert.rejects(normalizeRecipe({ url: 'file:///etc/passwd' }), /Unsupported URL scheme/);
  });

  it('stops following redirect loops', async () => {
    await assert.rejects(normalizeRecipe({ url: `${base}/loop` }), /Too many redirects/);
  });

  it('rejects oversized responses', async () => {
    await assert.rejects(normalizeRecipe({ url: `${base}/huge` }), /Response too large/);
  });
});

describe('Recipe Normalizer JSON-LD durations', () => {
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => {
      const recipe = {
        '@context': 'https://schema.org',
        '@type': 'Recipe',
        name: 'Timed Recipe',
        recipeIngredient: ['1 cup rice'],
        recipeInstructions: ['Cook the rice'],
        prepTime: 'PT15M',
        cookTime: 'PT1H30M',
      };
      if (req.url === '/seconds') {
        recipe.prepTime = 'PT45S';
        recipe.cookTime = 'PT0M';
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><script type="application/ld+json">${JSON.stringify(recipe)}</script></head></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    allowLoopback();
  });

  after(() => { server.close(); restorePolicy(); });

  it('returns prep/cook times in seconds (AnyList storage unit)', async () => {
    const result = await normalizeRecipe({ url: `${base}/minutes` });
    assert.equal(result.prepTime, 900);
    assert.equal(result.cookTime, 5400);
  });

  it('includes the seconds component and treats zero durations as absent', async () => {
    const result = await normalizeRecipe({ url: `${base}/seconds` });
    assert.equal(result.prepTime, 45);
    assert.equal(result.cookTime, null);
  });
});

describe('Recipe Normalizer address blocking (#24)', () => {
  it('classifies addresses', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPublicAddress(a), true, a);
    }
    for (const a of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
      '::ffff:127.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', 'not-an-ip',
    ]) {
      assert.equal(isPublicAddress(a), false, a);
    }
  });

  for (const url of [
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5:8000/mcp',
    'http://[::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://0x7f.1/',       // URL normalizes this to 127.0.0.1
    'http://2130706433/',   // and this
  ]) {
    it(`refuses the literal address in ${url}`, async () => {
      await assert.rejects(normalizeRecipe({ url }), /not a public internet address/);
    });
  }

  const stubLookup = answers => (hostname, options, callback) => callback(null, answers[hostname] || []);
  afterEach(restorePolicy);

  it('refuses a hostname that resolves to a private address', async () => {
    fetchPolicy.lookup = stubLookup({ 'recipes.example': [{ address: '10.0.0.7', family: 4 }] });
    await assert.rejects(normalizeRecipe({ url: 'http://recipes.example/' }),
      /Refusing to fetch from recipes\.example/);
  });

  it('refuses a hostname with one public and one private address', async () => {
    fetchPolicy.lookup = stubLookup({ 'mixed.example': [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.10', family: 4 },
    ] });
    await assert.rejects(normalizeRecipe({ url: 'http://mixed.example/' }), /not a public internet address/);
  });

  it('refuses a hostname with no addresses', async () => {
    fetchPolicy.lookup = stubLookup({});
    await assert.rejects(normalizeRecipe({ url: 'http://empty.example/' }), /not a public internet address/);
  });

  describe('redirects', () => {
    let server;
    let base;
    before(async () => {
      server = http.createServer((req, res) => {
        const targets = {
          '/to-private': 'http://10.0.0.1/recipe',
          '/to-metadata': 'http://169.254.169.254/latest/meta-data/',
          '/to-internal-name': 'http://internal.example/recipe',
        };
        res.writeHead(302, { Location: targets[req.url] || '/' });
        res.end();
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    beforeEach(allowLoopback);
    after(() => server.close());

    it('refuses a redirect to a private address', async () => {
      await assert.rejects(normalizeRecipe({ url: `${base}/to-private` }), /not a public internet address/);
    });

    it('refuses a redirect to the metadata service', async () => {
      await assert.rejects(normalizeRecipe({ url: `${base}/to-metadata` }), /not a public internet address/);
    });

    it('refuses a redirect to a name that resolves privately', async () => {
      fetchPolicy.lookup = stubLookup({ 'internal.example': [{ address: '172.20.0.3', family: 4 }] });
      await assert.rejects(normalizeRecipe({ url: `${base}/to-internal-name` }),
        /Refusing to fetch from internal\.example/);
    });
  });
});
