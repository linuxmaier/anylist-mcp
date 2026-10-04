/**
 * Unit tests for AnyListClient.addRecipeToList, against a real anylist-js
 * instance with the network faked out: user data comes from fixtures and posted
 * operations are decoded back out of the multipart body.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';
import List from '../anylist-js/lib/list.js';
import Item from '../anylist-js/lib/item.js';
import AnyListClient from '../src/anylist-client.js';
import { itemIdentifier, toItemIngredient } from '../src/recipe-to-list/index.js';
import tagExtract from './fixtures/tag-data-extract.json' with { type: 'json' };

const LIST_ID = '11111111111141118111111111111111';

const chili = {
  identifier: 'r-chili',
  name: 'Chili',
  ingredients: [
    { identifier: 'i-h', name: 'Base', isHeading: true },
    { identifier: 'i-1', name: 'yellow onions', quantity: '2 cups', rawIngredient: '2 cups yellow onions' },
    { identifier: 'i-2', name: 'black beans', quantity: '2 (15-oz.) cans', rawIngredient: '2 (15-oz.) cans black beans' },
    { identifier: 'i-3', name: 'Kosher salt', quantity: '', rawIngredient: 'Kosher salt' },
  ],
};
const soup = {
  identifier: 'r-soup',
  name: 'Soup',
  ingredients: [
    { identifier: 's-1', name: 'yellow onion', quantity: '1 cup', rawIngredient: '1 cup yellow onion' },
    { identifier: 's-2', name: 'yellow onions', quantity: '3 cups', rawIngredient: '3 cups yellow onions' },
  ],
};

describe('AnyListClient.addRecipeToList', () => {
  let anylist;
  let pb;
  let client;
  let listItems; // raw ListItem fields on the list before the call
  let recents;
  let recipes;
  let events;
  let listResponse; // the list's category groups and rules
  let settings; // PBListSettings for the list
  let tagLoads;
  let posted;

  const idFor = (recipe, ingredientId) =>
    itemIdentifier(toItemIngredient(recipe.ingredients.find(i => i.identifier === ingredientId), recipe), LIST_ID);

  const sentOps = () => {
    assert.ok(posted, 'nothing was posted');
    const start = posted.body.indexOf('\r\n\r\n') + 4;
    const end = posted.body.lastIndexOf(`\r\n--${posted.boundary}--`);
    return pb.PBListOperationList.decode(posted.body.subarray(start, end)).operations;
  };

  beforeEach(() => {
    posted = null;
    listItems = [];
    recents = [];
    recipes = [chili, soup];
    events = [];
    listResponse = null;
    settings = null;
    tagLoads = 0;
    anylist = new AnyList({ email: 'test', password: 'test', credentialsFile: '/nonexistent' });
    pb = anylist.protobuf;
    anylist.uid = 'u1';
    anylist._getUserData = async () => ({
      recipeDataResponse: { recipes: recipes.map(r => new pb.PBRecipe(r)) },
      mealPlanningCalendarResponse: { events: events.map(e => new pb.PBCalendarEvent(e)) },
      shoppingListsResponse: { listResponses: listResponse ? [new pb.PBListResponse({ listId: LIST_ID, ...listResponse })] : [] },
      listSettingsResponse: { settings: settings ? [new pb.PBListSettings({ listId: LIST_ID, ...settings })] : [] },
    });
    anylist.getLists = async () => {
      const context = { client: anylist.client, protobuf: pb, uid: 'u1' };
      anylist.lists = [new List({ identifier: LIST_ID, listId: LIST_ID, name: 'Groceries',
        items: listItems.map(i => new pb.ListItem({ listId: LIST_ID, ...i })) }, context)];
      anylist.recentItems = { [LIST_ID]: recents.map(i => new Item(new pb.ListItem(i), context)) };
      anylist.favoriteItems = [];
      return anylist.lists;
    };
    anylist.client = {
      post: async (url, { body }) => {
        assert.equal(url, 'data/shopping-lists/update');
        posted = { body: body.getBuffer(), boundary: body.getBoundary() };
      },
    };
    client = new AnyListClient();
    client.client = anylist;
    client.targetList = { identifier: LIST_ID, name: 'Groceries' };
    client.getTagData = async () => { tagLoads++; return tagExtract; };
  });

  it('adds each ingredient as a recipe-linked item, skipping headings and exclusions', async () => {
    const result = await client.addRecipeToList({ name: 'chili' }, { exclude: ['SALT', 'butter'] });
    assert.deepEqual(result.results, [
      { name: 'yellow onions', outcome: 'added' },
      { name: 'black beans', outcome: 'added' },
      { name: 'Kosher salt', outcome: 'skipped', exclude: 'SALT' },
    ]);
    assert.deepEqual(result.unmatchedExcludes, ['butter']);

    const ops = sentOps();
    assert.equal(ops.length, 2);
    for (const op of ops) {
      assert.equal(op.metadata.handlerId, 'add-item-ingredient-to-list-item');
      assert.equal(op.listId, LIST_ID);
      assert.equal(op.listItem.identifier, op.listItemId);
      assert.equal(op.listItem.userId, 'u1');
      assert.equal(op.listItem.ingredients.length, 1);
      assert.equal(op.listItem.ingredients[0].recipeId, 'r-chili');
      assert.equal(op.listItem.ingredients[0].recipeName, 'Chili');
    }
    assert.equal(ops[0].listItemId, idFor(chili, 'i-1'));
    assert.equal(ops[0].listItem.name, 'yellow onions');
    assert.equal(ops[0].listItem.ingredients[0].quantityPb.rawQuantity, '2 cups');
    assert.equal(ops[0].listItem.priceQuantityShouldOverrideItemQuantity, true);
    assert.equal(ops[1].listItem.packageSizePb.rawPackageSize, '15 oz. can');
  });

  it('merges an ingredient already on the list from another recipe', async () => {
    const soupOnion = toItemIngredient(soup.ingredients[1], soup);
    listItems = [{ identifier: idFor(soup, 's-2'), name: 'yellow onions', ingredients: [soupOnion] }];
    assert.equal(idFor(soup, 's-2'), idFor(chili, 'i-1'), 'test setup: the two onions should share an item');

    const result = await client.addRecipeToList({ id: 'r-chili' });
    assert.deepEqual(result.results[0], { name: 'yellow onions', outcome: 'merged' });
    const op = sentOps()[0];
    assert.equal(op.metadata.handlerId, 'add-item-ingredient-to-list-item');
    assert.equal(op.listItemId, idFor(chili, 'i-1'));
    // A partial item: just the new link, nothing that would overwrite the item.
    assert.equal(op.listItem.name, null);
    assert.equal(op.listItem.ingredients.length, 1);
    assert.equal(op.listItem.ingredients[0].recipeId, 'r-chili');
  });

  it('revives a checked-off item and clears its overrides', async () => {
    listItems = [{
      identifier: idFor(chili, 'i-1'), name: 'yellow onions', checked: true,
      itemQuantityShouldOverrideIngredientQuantity: true,
      ingredients: [toItemIngredient(chili.ingredients[1], chili)],
    }];
    const result = await client.addRecipeToList({ id: 'r-chili' });
    assert.equal(result.results[0].outcome, 'revived');
    const ops = sentOps().filter(o => o.listItemId === idFor(chili, 'i-1'));
    assert.deepEqual(ops.map(o => o.metadata.handlerId), [
      'set-list-item-checked',
      'set-item-quantity-should-override-ingredient-quantity',
      'add-item-ingredient-to-list-item',
    ]);
    assert.equal(ops[0].updatedValue, 'n');
    assert.equal(ops[1].listItem.itemQuantityShouldOverrideIngredientQuantity, false);
  });

  it('reports an ingredient this recipe already linked', async () => {
    listItems = [{
      identifier: idFor(chili, 'i-1'), name: 'yellow onions',
      ingredients: [toItemIngredient(chili.ingredients[1], chili)],
    }];
    const result = await client.addRecipeToList({ id: 'r-chili' });
    assert.equal(result.results[0].outcome, 'already linked');
  });

  it('merges two ingredients of one recipe that map to the same item', async () => {
    const result = await client.addRecipeToList({ id: 'r-soup' });
    // "yellow onion" (1 cup) and "yellow onions" (3 cups) stem and normalize alike.
    assert.deepEqual(result.results, [
      { name: 'yellow onion', outcome: 'added' },
      { name: 'yellow onions', outcome: 'merged', item: 'yellow onion' },
    ]);
    const ops = sentOps();
    assert.equal(ops[0].listItemId, ops[1].listItemId);
    assert.equal(ops[1].listItem.name, null);
  });

  it('copies the category of a recent item with the same stemmed name', async () => {
    recents = [
      { identifier: 'old', listId: LIST_ID, name: 'Yellow Onion', categoryMatchId: 'dairy' },
      { identifier: 'new', listId: LIST_ID, name: 'yellow onion', categoryMatchId: 'produce',
        categoryAssignments: [{ identifier: 'a', categoryGroupId: 'g', categoryId: 'c-produce' }] },
    ];
    await client.addRecipeToList({ id: 'r-chili' });
    const [onions, beans] = sentOps();
    assert.equal(onions.listItem.categoryMatchId, 'produce');
    assert.equal(onions.listItem.categoryAssignments[0].categoryId, 'c-produce');
    assert.equal(beans.listItem.categoryMatchId, 'other');
  });

  describe('categorizing new items like the app (#20)', () => {
    const GROUP = 'g-store';
    const category = (id, systemCategory, name) => ({ identifier: id, categoryGroupId: GROUP, listId: LIST_ID, systemCategory, name });
    beforeEach(() => {
      settings = { genericGroceryAutocompleteEnabled: true, listCategoryGroupId: GROUP };
      listResponse = {
        categoryGroupResponses: [{ categoryGroup: {
          identifier: GROUP, listId: LIST_ID, defaultCategoryId: 'c-other',
          categories: [category('c-produce', 'produce', 'Produce'), category('c-canned', 'soups-and-canned-goods', 'Canned'),
            category('c-other', 'other', 'Other'), category('c-bulk', null, 'Bulk Bins')],
        } }],
        categorizationRules: [],
      };
    });
    const byName = ops => Object.fromEntries(ops.map(op => [op.listItem.name, op.listItem]));

    it('classifies each new item by name and maps it to the list\'s category', async () => {
      await client.addRecipeToList({ id: 'r-chili' });
      const items = byName(sentOps());
      assert.equal(items['yellow onions'].categoryMatchId, 'produce');
      assert.equal(items['yellow onions'].priceMatchupTag, 'yellow-onions');
      assert.deepEqual(items['yellow onions'].categoryAssignments.map(a => [a.categoryGroupId, a.categoryId]), [[GROUP, 'c-produce']]);
      assert.equal(items['black beans'].categoryMatchId, 'soups-and-canned-goods');
      assert.equal(tagLoads, 1);
    });

    it('a categorization rule for the item name wins', async () => {
      listResponse.categorizationRules = [{ identifier: 'r1', listId: LIST_ID, categoryGroupId: GROUP, itemName: 'Black Beans', categoryId: 'c-bulk' }];
      await client.addRecipeToList({ id: 'r-chili' });
      const beans = byName(sentOps())['black beans'];
      assert.equal(beans.categoryMatchId, 'bulk-bins');
      assert.equal(beans.categoryAssignments[0].categoryId, 'c-bulk');
    });

    it('a favorite or recent item\'s category still overrides the classification', async () => {
      recents = [{ identifier: 'r', listId: LIST_ID, name: 'yellow onion', categoryMatchId: 'other',
        categoryAssignments: [{ identifier: 'a', categoryGroupId: GROUP, categoryId: 'c-other' }] }];
      await client.addRecipeToList({ id: 'r-chili' });
      const onions = byName(sentOps())['yellow onions'];
      assert.equal(onions.categoryMatchId, 'other');
      assert.equal(onions.categoryAssignments[0].categoryId, 'c-other');
    });

    it('with generic categorization off, the tag data isn\'t loaded and items get the default category', async () => {
      settings.genericGroceryAutocompleteEnabled = false;
      await client.addRecipeToList({ id: 'r-chili' });
      const onions = byName(sentOps())['yellow onions'];
      assert.equal(tagLoads, 0);
      assert.equal(onions.priceMatchupTag, null);
      assert.equal(onions.categoryMatchId, 'other');
      assert.equal(onions.categoryAssignments[0].categoryId, 'c-other');
    });

    it('still adds the items when the tag data can\'t be loaded', async () => {
      client.getTagData = async () => null;
      const r = await client.addRecipeToList({ id: 'r-chili' });
      assert.deepEqual(r.results.map(x => x.outcome), ['added', 'added', 'added']);
      assert.equal(byName(sentOps())['yellow onions'].categoryMatchId, 'other');
    });
  });

  it('links a meal-plan event, taking the recipe from it', async () => {
    events = [{ identifier: 'e1', date: '2026-10-01', recipeId: 'r-chili' }];
    const result = await client.addRecipeToList({}, { eventId: 'e1' });
    assert.equal(result.recipe, 'Chili');
    const link = sentOps()[0].listItem.ingredients[0];
    assert.equal(link.eventId, 'e1');
    assert.equal(link.eventDate, '2026-10-01');
  });

  it('refuses scaled recipes, a mismatched event, and ambiguous names', async () => {
    events = [{ identifier: 'e1', date: '2026-10-01', recipeId: 'r-chili', recipeScaleFactor: 2 }];
    await assert.rejects(client.addRecipeToList({}, { eventId: 'e1' }), /scaled ×2 on this meal plan event/);
    await assert.rejects(client.addRecipeToList({ id: 'r-soup' }, { eventId: 'e1' }), /different recipe/);
    recipes = [chili, { ...chili, identifier: 'r-chili-2' }];
    await assert.rejects(client.addRecipeToList({ name: 'Chili' }), /2 recipes are named "Chili"/);
    recipes = [{ ...chili, scaleFactor: 0.5 }];
    await assert.rejects(client.addRecipeToList({ name: 'Chili' }), /scaled ×0.5;/);
    assert.equal(posted, null);
  });
});
