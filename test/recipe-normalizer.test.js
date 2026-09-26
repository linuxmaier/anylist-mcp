import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipe } from '../src/recipe-normalizer.js';
import http from 'node:http';

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
  });

  after(() => server.close());

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
