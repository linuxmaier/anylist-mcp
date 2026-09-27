import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/recipe-collections.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('recipe_collections tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('list', () => {
    it('returns empty message when no collections', async () => {
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('No recipe collections'));
    });

    it('lists collections with recipe names', async () => {
      client._collections.push({ name: 'Weeknight', recipeCount: 2, recipeNames: ['Pasta', 'Salad'] });
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('Weeknight'));
      assert.ok(result.content[0].text.includes('Pasta'));
    });

    it('shows each collection id', async () => {
      client._collections.push(
        { identifier: 'c-1', name: 'Main Dishes', recipeCount: 0, recipeNames: [] },
        { identifier: 'c-2', name: 'Main Dishes', recipeCount: 0, recipeNames: [] },
      );
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('id: c-1'));
      assert.ok(result.content[0].text.includes('id: c-2'));
    });
  });

  describe('create', () => {
    it('creates a collection', async () => {
      const result = await handlers.recipe_collections({ action: 'create', name: 'Quick Meals' });
      assert.ok(result.content[0].text.includes('Created recipe collection "Quick Meals"'));
    });

    it('creates collection with recipes', async () => {
      await handlers.recipe_collections({ action: 'create', name: 'Favs', recipe_names: ['Pasta'] });
      assert.equal(client._collections[client._collections.length - 1].recipeNames[0], 'Pasta');
    });

    it('passes recipe_ids through', async () => {
      await handlers.recipe_collections({ action: 'create', name: 'Favs', recipe_ids: ['r-2'] });
      assert.deepEqual(client._collections[client._collections.length - 1].recipeIds, ['r-2']);
    });
  });

  describe('delete', () => {
    it('deletes an existing collection', async () => {
      client._collections.push({ name: 'Old Collection', recipeCount: 0, recipeNames: [] });
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Old Collection' });
      assert.ok(result.content[0].text.includes('Deleted recipe collection'));
      assert.equal(client._collections.length, 0);
    });

    it('returns error for non-existent collection', async () => {
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Nope' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });

    it('deletes nothing when the name matches multiple collections', async () => {
      client._collections.push({ identifier: 'c-1', name: 'Main Dishes' }, { identifier: 'c-2', name: 'Main Dishes' });
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Main Dishes' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('c-1'));
      assert.ok(result.content[0].text.includes('c-2'));
      assert.equal(client._collections.length, 2);
    });

    it('deletes only the collection named by collection_id', async () => {
      client._collections.push({ identifier: 'c-1', name: 'Main Dishes' }, { identifier: 'c-2', name: 'Main Dishes' });
      const result = await handlers.recipe_collections({ action: 'delete', collection_id: 'c-2' });
      assert.ok(result.content[0].text.includes('Deleted recipe collection "Main Dishes" (id: c-2)'));
      assert.deepEqual(client._collections.map(c => c.identifier), ['c-1']);
    });
  });
});
