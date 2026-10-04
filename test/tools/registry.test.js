/**
 * The tool list is split into read / write / delete tiers so clients can
 * grant permissions per tool (#38): *_read never writes, and only *_delete
 * removes anything. These tests pin that split.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerAllTools } from '../../src/tools/index.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

const TIERS = {
  shopping: {
    read: ['list_lists', 'list_items', 'get_favorites', 'get_recents', 'list_stores'],
    write: ['add_item', 'add_items', 'check_item', 'uncheck_item', 'set_item_store', 'add_recipe'],
  },
  recipes: {
    read: ['list', 'get', 'index', 'normalize'],
    write: ['create', 'update', 'import_url', 'normalize_and_save'],
  },
  meal_plan: {
    read: ['list_events', 'list_labels'],
    write: ['create_event', 'update_event'],
  },
  recipe_collections: {
    read: ['list'],
    write: ['create', 'add_recipes', 'remove_recipes'],
  },
};

describe('tool tiers', () => {
  let handlers;
  let definitions;
  let client;
  let calls; // mock client methods called, other than connect and getters

  beforeEach(() => {
    const mock = new MockAnyListClient();
    calls = [];
    client = new Proxy(mock, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || prop === 'connect' || /^get/.test(prop)) return value;
        return (...args) => { calls.push(prop); return value.apply(target, args); };
      },
    });
    const mockServer = createMockServer();
    ({ handlers, definitions } = mockServer);
    registerAllTools(mockServer.server, () => Promise.resolve(client));
  });

  it('registers exactly the tier tools plus health_check', () => {
    const expected = ['health_check', ...Object.keys(TIERS).flatMap(c => [`${c}_read`, `${c}_write`, `${c}_delete`])];
    assert.deepEqual(Object.keys(definitions).sort(), expected.sort());
  });

  for (const [category, tiers] of Object.entries(TIERS)) {
    it(`${category}: each tier offers exactly its own actions`, () => {
      assert.deepEqual(definitions[`${category}_read`].inputSchema.action.options, tiers.read);
      assert.deepEqual(definitions[`${category}_write`].inputSchema.action.options, tiers.write);
      assert.equal(definitions[`${category}_delete`].inputSchema.action, undefined, 'delete tools take no action');
      assert.deepEqual(tiers.read.filter(a => tiers.write.includes(a)), []);
    });

    it(`${category}: annotations match the tier`, () => {
      const hints = name => {
        const { readOnlyHint, destructiveHint } = definitions[name].annotations;
        return { readOnlyHint, destructiveHint };
      };
      assert.deepEqual(hints(`${category}_read`), { readOnlyHint: true, destructiveHint: false });
      assert.deepEqual(hints(`${category}_write`), { readOnlyHint: false, destructiveHint: false });
      assert.deepEqual(hints(`${category}_delete`), { readOnlyHint: false, destructiveHint: true });
    });

    it(`${category}_read never calls anything that writes`, async () => {
      for (const action of tiers.read) {
        // Plausible arguments, so actions get past their checks; a "save" must be ignored.
        await handlers[`${category}_read`]({ action, name: 'x', recipe_id: 'x', text: 'x\n1 cup x\nmix', save: true });
      }
      assert.deepEqual(calls, []);
    });

    it(`${category}_read and ${category}_write refuse other tiers' actions`, async () => {
      const deleteAction = { shopping: 'delete_item', recipes: 'delete', meal_plan: 'delete_event', recipe_collections: 'delete' }[category];
      for (const action of [...tiers.write, deleteAction]) {
        const result = await handlers[`${category}_read`]({ action, name: 'x' });
        assert.equal(result.isError, true, `${category}_read ran ${action}`);
      }
      const result = await handlers[`${category}_write`]({ action: deleteAction, name: 'x' });
      assert.equal(result.isError, true, `${category}_write ran ${deleteAction}`);
      assert.deepEqual(calls, []);
    });
  }

  it('the write spy sees writes (control)', async () => {
    await handlers.shopping_write({ action: 'add_item', name: 'x' });
    assert.deepEqual(calls, ['addItem']);
  });

  it('health_check is read-only', () => {
    assert.equal(definitions.health_check.annotations.readOnlyHint, true);
  });

  it('only the recipe tools, which fetch recipe URLs, are open-world', () => {
    const open = Object.keys(definitions).filter(n => definitions[n].annotations.openWorldHint).sort();
    assert.deepEqual(open, ['recipes_read', 'recipes_write']);
  });
});
