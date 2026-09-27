import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { register } from '../../src/tools/recipes.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('recipes tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('list', () => {
    it('returns empty message when no recipes', async () => {
      const result = await handlers.recipes({ action: 'list' });
      assert.ok(result.content[0].text.includes('No recipes found'));
    });

    it('lists recipes with metadata and id', async () => {
      client._recipes.push({ identifier: 'r-abc', name: 'Pasta', rating: 5, prepTime: 10, cookTime: 20, servings: '4' });
      const result = await handlers.recipes({ action: 'list' });
      assert.ok(result.content[0].text.includes('Pasta'));
      assert.ok(result.content[0].text.includes('⭐5'));
      assert.ok(result.content[0].text.includes('r-abc'));
    });

    it('filters by search query', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Salad' });
      const result = await handlers.recipes({ action: 'list', search: 'pasta' });
      assert.ok(result.content[0].text.includes('Pasta'));
      assert.ok(!result.content[0].text.includes('Salad'));
    });
  });

  describe('index', () => {
    // Local date offset from today, as YYYY-MM-DD (matches the tool's local "today").
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const ings = (...names) => names.map(name => ({ name }));
    const lineFor = (text, name) => text.split('\n').find(l => l.startsWith(`- ${name} |`));

    beforeEach(() => {
      client._recipes.push(
        { identifier: 'r-pasta', name: 'Pasta', prepTime: 900, cookTime: 2700, servings: '4',
          ingredients: ings('ground beef', 'kosher salt', 'Onion', 'extra-virgin olive oil', 'crushed tomatoes; or passata', 'onion', 'water', 'freshly ground black pepper', 'coarse salt and pepper', 'vegetable oil spray', 'boneless, skinless chicken thighs') },
        { identifier: 'r-curry', name: 'Curry', prepTime: 1200, cookTime: 3600, servings: 'Serves 4 to 6',
          ingredients: ings('chicken thighs', 'garam masala', 'heavy cream') },
        { identifier: 'r-salad', name: 'Salad', ingredients: ings('lettuce', 'red bell pepper') },
        { identifier: 'r-soup', name: 'Soup', servings: '6 servings', ingredients: [] },
        { identifier: 'r-many', name: 'Many', cookTime: 600,
          ingredients: ings('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j') },
      );
      client._collections.push(
        { identifier: 'c-1', name: 'Main Dishes', recipeIds: ['r-pasta', 'r-curry'] },
        { identifier: 'c-2', name: 'Instant Pot', recipeIds: ['r-curry'] },
      );
      client._events.push(
        { identifier: 'e-1', date: day(-30), recipeId: 'r-pasta' },
        { identifier: 'e-2', date: day(-3), recipeId: 'r-pasta' },
        { identifier: 'e-3', date: day(0), recipeId: 'r-curry' },
        { identifier: 'e-4', date: day(10), recipeId: 'r-curry' },
        { identifier: 'e-5', date: day(4), recipeId: 'r-curry' },
        { identifier: 'e-6', date: day(-1), title: 'Leftovers', recipeId: null },
      );
    });

    it('returns one compact line per recipe with times, servings, collections and id', async () => {
      const text = (await handlers.recipes({ action: 'index' })).content[0].text;
      assert.ok(text.startsWith('Recipe index: 5 recipes. Times are prep+cook.'));
      assert.equal(text.split('\n').length, 6);
      assert.equal(lineFor(text, 'Soup'), '- Soup | 6 servings | id:r-soup');
      const pasta = lineFor(text, 'Pasta');
      assert.ok(pasta.includes('| 15+45 min |'));
      assert.ok(pasta.includes('| serves 4 |'));
      assert.ok(pasta.includes('| Main Dishes |'));
      assert.ok(pasta.endsWith('| id:r-pasta'));
      assert.ok(lineFor(text, 'Curry').includes('| Serves 4 to 6 |'));
      assert.ok(lineFor(text, 'Curry').includes('| Main Dishes, Instant Pot |'));
      assert.equal(lineFor(text, 'Salad'), '- Salad | lettuce, red bell pepper | id:r-salad');
    });

    it('shows the latest past event as last and the earliest future event as next', async () => {
      const text = (await handlers.recipes({ action: 'index' })).content[0].text;
      const pasta = lineFor(text, 'Pasta');
      assert.ok(pasta.includes(`| last ${day(-3)} |`));
      assert.ok(!pasta.includes('next '));
      const curry = lineFor(text, 'Curry');
      assert.ok(curry.includes(`| last ${day(0)} |`), 'an event dated today counts as last');
      assert.ok(curry.includes(`| next ${day(4)} |`));
      assert.ok(!lineFor(text, 'Salad').includes('last '));
    });

    it('strips pantry staples and notes, dedupes, and caps main ingredients at 8', async () => {
      const text = (await handlers.recipes({ action: 'index' })).content[0].text;
      assert.ok(lineFor(text, 'Pasta').includes('| ground beef, onion, crushed tomatoes, boneless, skinless chicken thighs |'));
      assert.ok(lineFor(text, 'Salad').includes('red bell pepper'), 'bell pepper is not a staple');
      assert.ok(lineFor(text, 'Many').includes('| a, b, c, d, e, f, g, h |'));
    });

    it('filters by ingredient across all ingredients, including staples and ones not shown', async () => {
      let text = (await handlers.recipes({ action: 'index', ingredient: 'Salt' })).content[0].text;
      assert.ok(lineFor(text, 'Pasta'));
      assert.ok(!lineFor(text, 'Curry'));
      text = (await handlers.recipes({ action: 'index', ingredient: 'j' })).content[0].text;
      assert.ok(text.startsWith('Recipe index: 1 recipe (ingredient~"j")'));
      assert.ok(lineFor(text, 'Many'));
    });

    it('filters by collection name', async () => {
      const text = (await handlers.recipes({ action: 'index', collection: 'instant' })).content[0].text;
      assert.ok(lineFor(text, 'Curry'));
      assert.ok(!lineFor(text, 'Pasta'));
    });

    it('filters by max_total_minutes and counts recipes without times', async () => {
      const text = (await handlers.recipes({ action: 'index', max_total_minutes: 60 })).content[0].text;
      assert.ok(text.includes('; 2 without times excluded'));
      assert.ok(lineFor(text, 'Pasta'));
      assert.ok(lineFor(text, 'Many'));
      assert.ok(!lineFor(text, 'Curry'));
      assert.ok(!lineFor(text, 'Salad'));
    });

    it('not_planned_since keeps never-planned and older recipes and drops future-scheduled ones', async () => {
      const text = (await handlers.recipes({ action: 'index', not_planned_since: day(-7) })).content[0].text;
      assert.ok(!lineFor(text, 'Pasta'), 'planned 3 days ago');
      assert.ok(!lineFor(text, 'Curry'), 'scheduled in the future');
      assert.ok(lineFor(text, 'Salad'));
      assert.ok(lineFor(text, 'Many'));
      const older = (await handlers.recipes({ action: 'index', not_planned_since: day(-2) })).content[0].text;
      assert.ok(lineFor(older, 'Pasta'), 'last planned before the date');
    });

    it('combines filters and reports no matches', async () => {
      const result = await handlers.recipes({ action: 'index', collection: 'main', ingredient: 'lettuce' });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes('No recipes match.'));
    });
  });

  describe('get', () => {
    it('returns full recipe details with id', async () => {
      client._recipes.push({
        identifier: 'r-xyz',
        name: 'Pasta',
        ingredients: [{ rawIngredient: '2 cups flour' }],
        preparationSteps: ['Boil water', 'Cook pasta'],
      });
      const result = await handlers.recipes({ action: 'get', name: 'Pasta' });
      assert.ok(result.content[0].text.includes('# Pasta'));
      assert.ok(result.content[0].text.includes('r-xyz'));
      assert.ok(result.content[0].text.includes('2 cups flour'));
      assert.ok(result.content[0].text.includes('Boil water'));
    });

    it('returns error for non-existent recipe', async () => {
      const result = await handlers.recipes({ action: 'get', name: 'Nope' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });

    it('returns error listing ids when the name matches multiple recipes', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'pasta' });
      const result = await handlers.recipes({ action: 'get', name: 'Pasta' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('r-1'));
      assert.ok(result.content[0].text.includes('r-2'));
    });

    it('gets a recipe by recipe_id, which wins over name', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Salad' });
      const result = await handlers.recipes({ action: 'get', recipe_id: 'r-2', name: 'Pasta' });
      assert.ok(result.content[0].text.includes('# Salad'));
    });
  });

  describe('create', () => {
    it('creates a recipe', async () => {
      const result = await handlers.recipes({ action: 'create', name: 'New Recipe' });
      assert.ok(result.content[0].text.includes('Created recipe "New Recipe"'));
      assert.equal(client._recipes.length, 1);
    });

    it('creates recipe with all fields', async () => {
      await handlers.recipes({
        action: 'create',
        name: 'Full Recipe',
        ingredients: [{ name: 'sugar', quantity: '1 cup' }],
        steps: ['Mix well'],
        note: 'Delicious',
        prep_time: 5,
        cook_time: 30,
        servings: '4',
      });
      assert.equal(client._recipes[0].name, 'Full Recipe');
    });
  });

  describe('create (existing name)', () => {
    it('refuses to overwrite when the name already matches multiple recipes', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Pasta' });
      const result = await handlers.recipes({ action: 'create', name: 'Pasta' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('r-1'));
      assert.ok(result.content[0].text.includes('r-2'));
      assert.equal(client._recipes.length, 2);
    });
  });

  describe('import_url', () => {
    it('imports a recipe from a URL', async () => {
      client._pendingImport = {
        name: 'Chicken Tikka Masala',
        ingredientCount: 12,
        stepCount: 6,
        source: 'AllRecipes',
        sourceUrl: 'https://example.com/recipe',
      };
      const result = await handlers.recipes({ action: 'import_url', url: 'https://example.com/recipe' });
      assert.ok(result.content[0].text.includes('Imported recipe "Chicken Tikka Masala"'));
      assert.ok(result.content[0].text.includes('12 ingredients'));
      assert.ok(result.content[0].text.includes('6 steps'));
      assert.ok(result.content[0].text.includes('AllRecipes'));
    });

    it('returns error when URL cannot be parsed', async () => {
      client._pendingImport = null;
      const result = await handlers.recipes({ action: 'import_url', url: 'https://bad-site.com' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Could not parse'));
    });
  });

  describe('update', () => {
    it('updates only the provided fields and preserves the rest', async () => {
      client._recipes.push({
        identifier: 'r-keep',
        name: 'Pasta',
        note: 'original note',
        servings: '4',
        rating: 5,
        ingredients: [{ rawIngredient: '1 lb spaghetti' }],
        preparationSteps: ['Boil'],
      });
      const result = await handlers.recipes({ action: 'update', name: 'Pasta', note: 'updated note' });
      assert.ok(result.content[0].text.includes('Updated recipe "Pasta"'));
      const r = client._recipes[0];
      assert.equal(r.note, 'updated note');
      // Untouched fields survive.
      assert.equal(r.identifier, 'r-keep');
      assert.equal(r.servings, '4');
      assert.equal(r.rating, 5);
      assert.deepEqual(r.preparationSteps, ['Boil']);
    });

    it('replaces the entire ingredient list when ingredients are provided', async () => {
      client._recipes.push({
        identifier: 'r-1',
        name: 'Pasta',
        ingredients: [{ rawIngredient: '1 lb spaghetti' }, { rawIngredient: '2 cloves garlic' }],
      });
      await handlers.recipes({
        action: 'update',
        name: 'Pasta',
        ingredients: [{ name: 'penne', quantity: '1 lb' }],
      });
      assert.equal(client._recipes[0].ingredients.length, 1);
      assert.equal(client._recipes[0].ingredients[0].name, 'penne');
    });

    it('returns error when no fields are provided', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' });
      const result = await handlers.recipes({ action: 'update', name: 'Pasta' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('at least one field'));
    });

    it('returns error for non-existent recipe', async () => {
      const result = await handlers.recipes({ action: 'update', name: 'Nope', note: 'x' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });

    it('returns error when the name matches multiple recipes', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Pasta' });
      const result = await handlers.recipes({ action: 'update', name: 'Pasta', note: 'x' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('2 recipes are named "Pasta"'));
      assert.ok(result.content[0].text.includes('r-1'));
      assert.ok(result.content[0].text.includes('r-2'));
      assert.equal(client._recipes[0].note, undefined);
      assert.equal(client._recipes[1].note, undefined);
    });

    it('updates the recipe named by recipe_id when names are duplicated', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Pasta' });
      const result = await handlers.recipes({ action: 'update', recipe_id: 'r-2', note: 'x' });
      assert.ok(result.content[0].text.includes('Updated recipe "Pasta"'));
      assert.equal(client._recipes[0].note, undefined);
      assert.equal(client._recipes[1].note, 'x');
    });
  });

  describe('delete', () => {
    it('deletes an existing recipe', async () => {
      client._recipes.push({ name: 'Old Recipe' });
      const result = await handlers.recipes({ action: 'delete', name: 'Old Recipe' });
      assert.ok(result.content[0].text.includes('Deleted recipe'));
      assert.equal(client._recipes.length, 0);
    });

    it('returns error for non-existent recipe', async () => {
      const result = await handlers.recipes({ action: 'delete', name: 'Nope' });
      assert.equal(result.isError, true);
    });

    it('deletes nothing when the name matches multiple recipes', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Pasta' });
      const result = await handlers.recipes({ action: 'delete', name: 'Pasta' });
      assert.equal(result.isError, true);
      assert.equal(client._recipes.length, 2);
    });

    it('deletes only the recipe named by recipe_id', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Pasta' });
      const result = await handlers.recipes({ action: 'delete', recipe_id: 'r-2' });
      assert.ok(result.content[0].text.includes('Deleted recipe "Pasta" (id: r-2)'));
      assert.deepEqual(client._recipes.map(r => r.identifier), ['r-1']);
    });
  });

  // AnyList stores prepTime/cookTime in seconds; the tool speaks minutes.
  describe('prep/cook time units', () => {
    it('list shows stored seconds as minutes', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Chili', prepTime: 900, cookTime: 5400 });
      const text = (await handlers.recipes({ action: 'list' })).content[0].text;
      assert.ok(text.includes('prep: 15 min'), text);
      assert.ok(text.includes('cook: 90 min'), text);
    });

    it('get shows stored seconds as minutes', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Chili', prepTime: 900, cookTime: 5400 });
      const text = (await handlers.recipes({ action: 'get', name: 'Chili' })).content[0].text;
      assert.match(text, /^Prep: 15 min$/m);
      assert.match(text, /^Cook: 90 min$/m);
    });

    it('create stores minutes as seconds', async () => {
      await handlers.recipes({ action: 'create', name: 'Chili', prep_time: 15, cook_time: 90 });
      assert.equal(client._recipes[0].prepTime, 900);
      assert.equal(client._recipes[0].cookTime, 5400);
    });

    it('update stores minutes as seconds', async () => {
      client._recipes.push({ identifier: 'r-1', name: 'Chili', prepTime: 60, cookTime: 60 });
      await handlers.recipes({ action: 'update', name: 'Chili', prep_time: 15, cook_time: 90 });
      assert.equal(client._recipes[0].prepTime, 900);
      assert.equal(client._recipes[0].cookTime, 5400);
    });

    describe('normalize', () => {
      let server;
      let url;

      before(async () => {
        server = http.createServer((req, res) => {
          const recipe = {
            '@type': 'Recipe',
            name: 'Chili',
            recipeIngredient: ['1 can beans'],
            recipeInstructions: ['Simmer'],
            prepTime: 'PT15M',
            cookTime: 'PT1H30M',
          };
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<script type="application/ld+json">${JSON.stringify(recipe)}</script>`);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/chili`;
      });

      after(() => server.close());

      it('previews times in minutes and saves them in seconds', async () => {
        const text = (await handlers.recipes({ action: 'normalize', url, save: true })).content[0].text;
        assert.match(text, /^Prep: 15 min$/m);
        assert.match(text, /^Cook: 90 min$/m);
        assert.equal(client._recipes[0].prepTime, 900);
        assert.equal(client._recipes[0].cookTime, 5400);
      });
    });
  });
});
