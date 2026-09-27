/**
 * Unit tests for AnyListClient's recipe/collection lookup, run against a fake
 * anylist-js client (no network, no credentials). The fixtures deliberately
 * contain duplicate names, as real accounts do.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';

const ing = () => ({ toJSON() { return {}; } });

function fakeRecipe(fields, log) {
  return {
    ingredients: [],
    ...fields,
    async delete() { log.push(['delete-recipe', this.identifier]); },
    async save() { log.push(['save-recipe', this.identifier]); },
  };
}

function makeClient() {
  const log = [];
  const recipes = [
    fakeRecipe({ identifier: 'r-1', name: 'Pan-Seared Chicken', sourceName: 'Serious Eats', creationTimestamp: 1700000000 }, log),
    fakeRecipe({ identifier: 'r-2', name: 'pan-seared chicken', ingredients: [ing(), ing()], creationTimestamp: 1750000000 }, log),
    fakeRecipe({ identifier: 'r-3', name: 'Rice' }, log),
  ];
  const collections = [
    { identifier: 'c-1', name: 'Main Dishes', recipeIds: ['r-1'] },
    { identifier: 'c-2', name: 'Main Dishes', recipeIds: [] },
    { identifier: 'c-3', name: 'Sides', recipeIds: ['r-3'] },
  ];
  const fake = {
    async getRecipes() { return recipes; },
    async _getUserData() { return { recipeDataResponse: { recipeCollections: collections } }; },
    async createRecipe(obj) { return fakeRecipe(obj, log); },
    createRecipeCollection(obj) {
      return {
        identifier: obj.identifier || 'c-new',
        name: obj.name,
        recipeIds: obj.recipeIds,
        async save() { log.push(['save-collection', obj.name, obj.recipeIds]); },
        async delete() { log.push(['delete-collection', obj.identifier]); },
        async performOperation(handlerId) { log.push([handlerId, obj.identifier, obj.recipeIds]); },
      };
    },
  };
  const client = new AnyListClient();
  client.client = fake;
  return { client, log };
}

describe('AnyListClient recipe lookup', () => {
  let client;
  let log;
  beforeEach(() => ({ client, log } = makeClient()));

  it('get: a duplicate name errors and lists each id with details', async () => {
    await assert.rejects(client.getRecipeDetails({ name: 'Pan-Seared Chicken' }), err => {
      assert.match(err.message, /2 recipes are named "Pan-Seared Chicken"/);
      assert.match(err.message, /id: r-1 \(source: Serious Eats, created: 2023-11-14, 0 ingredients\)/);
      assert.match(err.message, /id: r-2 \(created: 2025-06-15, 2 ingredients\)/);
      return true;
    });
  });

  it('get: an id picks the right copy and wins over a conflicting name', async () => {
    const r = await client.getRecipeDetails({ id: 'r-2', name: 'Rice' });
    assert.equal(r.identifier, 'r-2');
  });

  it('get: a unique name still works', async () => {
    const r = await client.getRecipeDetails({ name: 'rice' });
    assert.equal(r.identifier, 'r-3');
  });

  it('get: an unknown id is not found', async () => {
    await assert.rejects(client.getRecipeDetails({ id: 'nope' }), /Recipe with id "nope" not found/);
  });

  it('update: a duplicate name errors and saves nothing', async () => {
    await assert.rejects(client.updateRecipe({ name: 'Pan-Seared Chicken' }, { note: 'x' }), /r-1[\s\S]*r-2/);
    assert.deepEqual(log, []);
  });

  it('update: an id updates that copy', async () => {
    const r = await client.updateRecipe({ id: 'r-2' }, { note: 'x' });
    assert.equal(r.identifier, 'r-2');
    assert.deepEqual(log, [['save-recipe', 'r-2']]);
  });

  it('delete: a duplicate name errors and deletes nothing', async () => {
    await assert.rejects(client.deleteRecipe({ name: 'Pan-Seared Chicken' }), /2 recipes are named/);
    assert.deepEqual(log, []);
  });

  it('delete: an id deletes only that copy', async () => {
    const r = await client.deleteRecipe({ id: 'r-1' });
    assert.deepEqual(r, { identifier: 'r-1', name: 'Pan-Seared Chicken' });
    assert.deepEqual(log, [['delete-recipe', 'r-1']]);
  });
});

describe('AnyListClient collection lookup', () => {
  let client;
  let log;
  beforeEach(() => ({ client, log } = makeClient()));

  it('delete: a duplicate name errors, lists ids with recipe counts, and deletes nothing', async () => {
    await assert.rejects(client.deleteRecipeCollection({ name: 'main dishes' }), err => {
      assert.match(err.message, /2 recipe collections are named "main dishes"/);
      assert.match(err.message, /id: c-1 \(1 recipes: Pan-Seared Chicken\)/);
      assert.match(err.message, /id: c-2 \(0 recipes\)/);
      return true;
    });
    assert.deepEqual(log, []);
  });

  it('delete: an id deletes only that collection', async () => {
    const c = await client.deleteRecipeCollection({ id: 'c-2' });
    assert.deepEqual(c, { identifier: 'c-2', name: 'Main Dishes' });
    assert.deepEqual(log, [['delete-collection', 'c-2']]);
  });

  it('create: an ambiguous recipe name errors and creates nothing', async () => {
    await assert.rejects(client.createRecipeCollection('New', ['Pan-Seared Chicken']), /2 recipes are named/);
    assert.deepEqual(log, []);
  });

  it('create: an unknown recipe name errors instead of being dropped', async () => {
    await assert.rejects(client.createRecipeCollection('New', ['Rice', 'Nope']), /Recipe "Nope" not found/);
    assert.deepEqual(log, []);
  });

  it('create: recipe ids and names resolve to ids, without duplicates', async () => {
    await client.createRecipeCollection('New', ['rice'], ['r-2', 'r-3']);
    assert.deepEqual(log, [['save-collection', 'New', ['r-2', 'r-3']]]);
  });
});

describe('AnyListClient collection membership', () => {
  let client;
  let log;
  beforeEach(() => ({ client, log } = makeClient()));

  it('add: an ambiguous collection name errors, lists both ids, and writes nothing', async () => {
    await assert.rejects(client.addRecipesToCollection({ name: 'Main Dishes' }, [{ name: 'Rice' }]), err => {
      assert.match(err.message, /2 recipe collections are named "Main Dishes"/);
      assert.match(err.message, /id: c-1/);
      assert.match(err.message, /id: c-2/);
      return true;
    });
    assert.deepEqual(log, []);
  });

  it('add: one ambiguous or unknown recipe writes nothing', async () => {
    await assert.rejects(client.addRecipesToCollection({ id: 'c-2' }, [{ name: 'Rice' }, { name: 'Pan-Seared Chicken' }]), /2 recipes are named/);
    await assert.rejects(client.addRecipesToCollection({ id: 'c-2' }, [{ name: 'Rice' }, { name: 'Nope' }]), /Recipe "Nope" not found/);
    assert.deepEqual(log, []);
  });

  it('add: sends one op carrying only the new ids and skips ones already present', async () => {
    const r = await client.addRecipesToCollection({ id: 'c-1' }, [{ id: 'r-1' }, { id: 'r-2' }, { name: 'rice' }, { id: 'r-3' }]);
    assert.deepEqual(log, [['add-recipes-to-collection', 'c-1', ['r-2', 'r-3']]]);
    assert.deepEqual(r, { identifier: 'c-1', name: 'Main Dishes', changed: ['pan-seared chicken', 'Rice'], skipped: ['Pan-Seared Chicken'] });
  });

  it('add: nothing is sent when every recipe is already present', async () => {
    const r = await client.addRecipesToCollection({ name: 'Sides' }, [{ name: 'Rice' }]);
    assert.deepEqual(log, []);
    assert.deepEqual(r.changed, []);
    assert.deepEqual(r.skipped, ['Rice']);
  });

  it('add: at least one recipe is required', async () => {
    await assert.rejects(client.addRecipesToCollection({ id: 'c-1' }, []), /At least one recipe/);
  });

  it('remove: sends one op per recipe, each with only that id, and skips absent ones', async () => {
    const r = await client.removeRecipesFromCollection({ name: 'Sides' }, [{ id: 'r-3' }, { id: 'r-1' }]);
    assert.deepEqual(log, [['remove-recipes-from-collection', 'c-3', ['r-3']]]);
    assert.deepEqual(r, { identifier: 'c-3', name: 'Sides', changed: ['Rice'], skipped: ['Pan-Seared Chicken'] });
  });

  it('remove: several recipes become several single-id ops and no recipe is deleted', async () => {
    const userData = await client.client._getUserData();
    userData.recipeDataResponse.recipeCollections[0].recipeIds.push('r-3');
    await client.removeRecipesFromCollection({ id: 'c-1' }, [{ id: 'r-1' }, { id: 'r-3' }]);
    assert.deepEqual(log, [
      ['remove-recipes-from-collection', 'c-1', ['r-1']],
      ['remove-recipes-from-collection', 'c-1', ['r-3']],
    ]);
  });
});

describe('AnyListClient recipe index', () => {
  let client;
  beforeEach(() => {
    const collections = [
      { identifier: 'c-1', name: 'Main Dishes', recipeIds: ['r-1'] },
      { identifier: 'c-2', name: 'Main Dishes', recipeIds: ['r-1'] },
      { identifier: 'c-3', name: 'Quick', recipeIds: ['r-1', 'r-2'] },
    ];
    const recipes = [
      { identifier: 'r-1', name: 'Pizza', prepTime: 600, servings: '4', ingredients: [
        { rawIngredient: null, name: 'Dough' },
        { rawIngredient: '2 cups bread flour', name: 'bread flour' },
        { rawIngredient: '1 cup mozzarella' },
      ] },
      { identifier: 'r-2', name: 'Rice' },
    ];
    client = new AnyListClient();
    client.client = {
      async getRecipes() { return recipes; },
      async _getUserData() { return { recipeDataResponse: { recipeCollections: collections } }; },
    };
  });

  it('skips heading ingredients, falls back to rawIngredient, and lists each collection name once', async () => {
    const [pizza, rice] = await client.getRecipeIndex();
    assert.deepEqual(pizza.ingredientNames, ['bread flour', '1 cup mozzarella']);
    assert.deepEqual(pizza.collections, ['Main Dishes', 'Quick']);
    assert.equal(pizza.prepTime, 600);
    assert.equal(pizza.cookTime, null);
    assert.deepEqual(rice.ingredientNames, []);
    assert.deepEqual(rice.collections, ['Quick']);
  });
});
