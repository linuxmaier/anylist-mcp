/**
 * The merge rules and cursors of src/user-data-sync.js (#45), on real
 * protobuf messages. Each case follows a rule of AnyList's web client.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';
import { createSyncState, mergeUserData, clientTimestamps, toUserDataResponse } from '../src/user-data-sync.js';

const pb = new AnyList({ email: 'test', password: 'test', credentialsFile: '/nonexistent' }).protobuf;
// Encode and decode, as if it came from the server
const response = fields => pb.PBUserDataResponse.decode(new pb.PBUserDataResponse(fields).toBuffer());

describe('mergeUserData', () => {
  let state;
  const merge = fields => mergeUserData(state, response(fields), pb);
  const full = () => toUserDataResponse(state);

  beforeEach(() => {
    state = createSyncState();
  });

  describe('shopping lists', () => {
    beforeEach(() => merge({
      shoppingListsResponse: {
        newLists: [
          { identifier: 'l1', name: 'One', timestamp: 1, items: [{ identifier: 'i1', name: 'milk' }] },
          { identifier: 'l2', name: 'Two', timestamp: 1 },
        ],
        orderedIds: ['l2', 'l1'],
        listResponses: [{
          listId: 'l1', isFullSync: true, logicalTimestamp: 5,
          stores: [{ identifier: 's1', name: 'Shop' }, { identifier: 's2', name: 'Other' }],
          categoryGroupResponses: [{ categoryGroup: { identifier: 'g1', name: 'Default', categories: [
            { identifier: 'c1', name: 'Dairy', categoryGroupId: 'g1' },
            { identifier: 'c2', name: 'Produce', categoryGroupId: 'g1' },
          ] } }],
          categorizationRules: [{ identifier: 'r1', itemName: 'milk', categoryId: 'c1' }],
        }],
      },
    }));

    it('holds lists in server order with their metadata', () => {
      const lists = full().shoppingListsResponse;
      assert.deepEqual(lists.newLists.map(l => l.name), ['Two', 'One']);
      const meta = lists.listResponses.find(r => r.listId === 'l1');
      assert.deepEqual(meta.stores.map(s => s.name), ['Shop', 'Other']);
      assert.deepEqual(meta.categoryGroupResponses[0].categoryGroup.categories.map(c => c.name), ['Dairy', 'Produce']);
      assert.equal(meta.categorizationRules[0].itemName, 'milk');
    });

    it('replaces a modified list but ignores a modified list it does not have', () => {
      merge({ shoppingListsResponse: { modifiedLists: [
        { identifier: 'l1', name: 'One', timestamp: 2, items: [{ identifier: 'i2', name: 'eggs' }] },
        { identifier: 'l9', name: 'Unknown', timestamp: 2 },
      ], orderedIds: ['l2', 'l1'] } });
      const lists = full().shoppingListsResponse.newLists;
      assert.deepEqual(lists.map(l => l.identifier), ['l2', 'l1']);
      assert.deepEqual(lists[1].items.map(i => i.name), ['eggs']);
    });

    it('drops a list and its metadata when the server no longer knows it', () => {
      merge({ shoppingListsResponse: { unknownIds: ['l1'], orderedIds: ['l2'] } });
      const lists = full().shoppingListsResponse;
      assert.deepEqual(lists.newLists.map(l => l.identifier), ['l2']);
      assert.deepEqual(lists.listResponses, []);
    });

    it('applies metadata deletions and upserts', () => {
      merge({ shoppingListsResponse: { orderedIds: ['l2', 'l1'], listResponses: [{
        listId: 'l1', logicalTimestamp: 6,
        deletedStoreIds: ['s2'],
        categoryGroupResponses: [{ categoryGroup: { identifier: 'g1', name: 'Default', categories: [
          { identifier: 'c3', name: 'Bakery', categoryGroupId: 'g1' },
        ] }, deletedCategoryIds: ['c2'] }],
        deletedCategorizationRuleIds: ['r1'],
      }] } });
      const meta = full().shoppingListsResponse.listResponses[0];
      assert.deepEqual(meta.stores.map(s => s.name), ['Shop']);
      assert.deepEqual(meta.categoryGroupResponses[0].categoryGroup.categories.map(c => c.name), ['Dairy', 'Bakery']);
      assert.deepEqual(meta.categorizationRules, []);
    });

    it('deletes the categories of a deleted category group', () => {
      merge({ shoppingListsResponse: { orderedIds: ['l2', 'l1'], listResponses: [{ listId: 'l1', logicalTimestamp: 6, deletedCategoryGroupIds: ['g1'] }] } });
      assert.deepEqual(full().shoppingListsResponse.listResponses[0].categoryGroupResponses, []);
      assert.equal(state.listMeta.get('l1').categories.size, 0);
    });

    it('starts the metadata over on a full sync', () => {
      merge({ shoppingListsResponse: { orderedIds: ['l2', 'l1'], listResponses: [{ listId: 'l1', isFullSync: true, logicalTimestamp: 9, stores: [{ identifier: 's3', name: 'New' }] }] } });
      const meta = full().shoppingListsResponse.listResponses[0];
      assert.deepEqual(meta.stores.map(s => s.name), ['New']);
      assert.deepEqual(meta.categoryGroupResponses, []);
    });
  });

  describe('recipes', () => {
    beforeEach(() => merge({ recipeDataResponse: {
      recipeDataId: 'rd', timestamp: 1,
      recipes: [{ identifier: 'r1', name: 'Chili' }, { identifier: 'r2', name: 'Soup' }],
      recipeCollections: [{ identifier: 'c1', name: 'Weeknight', recipeIds: ['r1', 'r2'] }, { identifier: 'c2', name: 'Old' }],
    } }));

    it('upserts recipes and keeps unchanged ones', () => {
      merge({ recipeDataResponse: { recipeDataId: 'rd', timestamp: 2, recipes: [{ identifier: 'r2', name: 'Tomato soup' }] } });
      assert.deepEqual(full().recipeDataResponse.recipes.map(r => r.name), ['Chili', 'Tomato soup']);
    });

    it('drops recipes missing from allRecipesCollection, also from collections', () => {
      merge({ recipeDataResponse: { recipeDataId: 'rd', timestamp: 2, allRecipesCollection: { identifier: 'all', recipeIds: ['r1'] } } });
      const recipes = full().recipeDataResponse;
      assert.deepEqual(recipes.recipes.map(r => r.name), ['Chili']);
      assert.deepEqual(recipes.recipeCollections.find(c => c.identifier === 'c1').recipeIds, ['r1']);
    });

    it('drops collections missing from an authoritative id list', () => {
      merge({ recipeDataResponse: { recipeDataId: 'rd', timestamp: 2, includesRecipeCollectionIds: true, recipeCollectionIds: ['c1'] } });
      assert.deepEqual(full().recipeDataResponse.recipeCollections.map(c => c.name), ['Weeknight']);
    });

    it('ignores a recipe response without a recipe data id', () => {
      merge({ recipeDataResponse: { recipes: [{ identifier: 'r3', name: 'Stray' }] } });
      assert.equal(full().recipeDataResponse.recipes.length, 2);
    });
  });

  describe('meal plan', () => {
    beforeEach(() => merge({ mealPlanningCalendarResponse: {
      calendarId: 'cal', isFullSync: true, logicalTimestamp: 1, responseVersion: 1,
      events: [{ identifier: 'e1', date: '2099-01-01' }, { identifier: 'e2', date: '2099-01-02' }],
      labels: [{ identifier: 'lab1', name: 'Dinner' }],
    } }));

    it('applies event and label deltas', () => {
      merge({ mealPlanningCalendarResponse: { calendarId: 'cal', logicalTimestamp: 2, responseVersion: 1,
        events: [{ identifier: 'e3', date: '2099-01-03' }], deletedEventIds: ['e1'], deletedLabelIds: ['lab1'] } });
      const calendar = full().mealPlanningCalendarResponse;
      assert.deepEqual(calendar.events.map(e => e.identifier), ['e2', 'e3']);
      assert.deepEqual(calendar.labels, []);
    });

    it('starts over on a full sync', () => {
      merge({ mealPlanningCalendarResponse: { calendarId: 'cal', isFullSync: true, logicalTimestamp: 3, responseVersion: 1, events: [{ identifier: 'e9', date: '2099-02-01' }] } });
      assert.deepEqual(full().mealPlanningCalendarResponse.events.map(e => e.identifier), ['e9']);
    });

    it('ignores a delta for another calendar, or without a supported response version', () => {
      merge({ mealPlanningCalendarResponse: { calendarId: 'other', logicalTimestamp: 2, responseVersion: 1, deletedEventIds: ['e1'] } });
      merge({ mealPlanningCalendarResponse: { calendarId: 'cal', logicalTimestamp: 2, deletedEventIds: ['e1'] } });
      const calendar = full().mealPlanningCalendarResponse;
      assert.equal(calendar.calendarId, 'cal');
      assert.equal(calendar.events.length, 2);
    });
  });

  it('applies list settings, with "all" replacing them', () => {
    merge({ listSettingsResponse: { timestamp: { identifier: 'all', timestamp: 1 }, settings: [{ identifier: 'd', listId: '' }, { identifier: 'x', listId: 'l1' }] } });
    merge({ listSettingsResponse: { timestamp: { identifier: 'list-settings-timestamp', timestamp: 2 }, settings: [{ identifier: 'y', listId: 'l2' }] } });
    assert.deepEqual(full().listSettingsResponse.settings.map(s => s.identifier), ['d', 'x', 'y']);
    merge({ listSettingsResponse: { timestamp: { identifier: 'all', timestamp: 3 }, settings: [{ identifier: 'z', listId: 'l3' }] } });
    assert.deepEqual(full().listSettingsResponse.settings.map(s => s.identifier), ['z']);
  });

  it('applies starter list batches', () => {
    merge({ starterListsResponse: { favoriteItemListsResponse: { includesAllLists: true, listResponses: [
      { starterList: { identifier: 'f1', listId: 'l1', timestamp: 1 } }, { starterList: { identifier: 'f2', listId: 'l2', timestamp: 1 } },
    ] } } });
    merge({ starterListsResponse: { favoriteItemListsResponse: { unknownListIds: ['f1'], listResponses: [] } } });
    const favorites = full().starterListsResponse.favoriteItemListsResponse.listResponses;
    assert.deepEqual(favorites.map(r => r.starterList.identifier), ['f2']);
    merge({ starterListsResponse: { favoriteItemListsResponse: { includesAllLists: true, listResponses: [] } } });
    assert.deepEqual(full().starterListsResponse.favoriteItemListsResponse.listResponses, []);
  });
});

describe('clientTimestamps', () => {
  it('sends no cursors for sections it has not received', () => {
    const ts = pb.PBUserDataClientTimestamps.decode(clientTimestamps(createSyncState(), pb, 'u1').toBuffer());
    assert.equal(ts.shoppingListTimestamps.timestamps.length, 0);
    assert.equal(ts.userRecipeDataTimestamp, null);
    assert.equal(ts.mealPlanningCalendarTimestamp, null);
    assert.equal(ts.listSettingsTimestamp, null);
  });

  it('builds each cursor the way the web client does', () => {
    const state = createSyncState();
    mergeUserData(state, response({
      shoppingListsResponse: {
        newLists: [{ identifier: 'l1', timestamp: 1.5 }, { identifier: 'l2', timestamp: 2.5 }],
        listResponses: [{ listId: 'l1', logicalTimestamp: 42 }],
      },
      listFoldersResponse: { listDataId: 'ld', rootFolderId: 'root', listFolders: [{ identifier: 'f1', timestamp: 3 }] },
      recipeDataResponse: { recipeDataId: 'rd', timestamp: 4 },
      mealPlanningCalendarResponse: { calendarId: 'cal', logicalTimestamp: 5, responseVersion: 1 },
      userCategoriesResponse: { identifier: 'uc', timestamp: 6 },
      categorizedItemsResponse: { timestamp: { identifier: 'all', timestamp: 7 } },
      listSettingsResponse: { timestamp: { identifier: 'all', timestamp: 8 } },
      starterListSettingsResponse: { timestamp: { identifier: 'all', timestamp: 9 } },
      starterListsResponse: { recentItemListsResponse: { listResponses: [{ starterList: { identifier: 'rc', timestamp: 10 } }] } },
      orderedStarterListIdsResponse: { timestamp: 11, identifiers: ['a'] },
      mobileAppSettingsResponse: { identifier: 'm', timestamp: 12 },
    }), pb);
    const ts = pb.PBUserDataClientTimestamps.decode(clientTimestamps(state, pb, 'user-1').toBuffer());
    assert.deepEqual(ts.shoppingListTimestamps.timestamps.map(t => [t.identifier, t.timestamp]), [['l1', 1.5], ['l2', 2.5]]);
    // Only lists with metadata have a logical cursor
    assert.deepEqual(ts.shoppingListLogicalTimestamps.timestamps.map(t => [t.identifier, t.logicalTimestamp.toNumber(), t.description]),
      [['ALShoppingListLogicalTimestampID-l1', 42, 'l1']]);
    assert.equal(ts.listFolderTimestamps.rootFolderId, 'root');
    assert.deepEqual(ts.listFolderTimestamps.folderTimestamps.map(t => [t.identifier, t.timestamp]), [['f1', 3]]);
    assert.deepEqual([ts.userRecipeDataTimestamp.identifier, ts.userRecipeDataTimestamp.timestamp], ['rd', 4]);
    assert.deepEqual([ts.mealPlanningCalendarTimestamp.identifier, ts.mealPlanningCalendarTimestamp.logicalTimestamp.toNumber()], ['cal', 5]);
    assert.deepEqual([ts.userCategoriesTimestamp.identifier, ts.userCategoriesTimestamp.timestamp], [null, 6]);
    assert.deepEqual([ts.categorizedItemsTimestamp.identifier, ts.categorizedItemsTimestamp.timestamp], ['last-categorized-item-timestamp', 7]);
    assert.deepEqual([ts.listSettingsTimestamp.identifier, ts.listSettingsTimestamp.timestamp], ['list-settings-timestamp', 8]);
    assert.deepEqual([ts.starterListSettingsTimestamp.identifier, ts.starterListSettingsTimestamp.timestamp], ['list-settings-timestamp', 9]);
    assert.deepEqual(ts.recentItemTimestamps.timestamps.map(t => [t.identifier, t.timestamp]), [['rc', 10]]);
    assert.deepEqual([ts.orderedStarterListIdsTimestamp.identifier, ts.orderedStarterListIdsTimestamp.timestamp], ['user-1', 11]);
    assert.deepEqual([ts.mobileAppSettingsTimestamp.identifier, ts.mobileAppSettingsTimestamp.timestamp], ['mobile-app-settings-timestamp', 12]);
  });
});
