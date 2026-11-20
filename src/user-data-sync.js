// Conditional sync of AnyList's aggregate `data/user-data/get` endpoint (#45).
//
// AnyList's web client sends this request with `timestamps`
// (PBUserDataClientTimestamps: one cursor per section of PBUserDataResponse)
// and `client_info`. The server answers 304 when nothing changed, otherwise
// with only the sections and records that changed, which the client merges
// into what it already holds. Everything here mirrors that client's request
// builder and its per-domain managers, read from
// https://www.anylist.com/static/webapp/js/app.min.js (SHA-256
// e25bf32bc6a8df21f9cab2d9bea7de580a125ff6643d91cd47898656273dd6f5, served
// 2026-11-20). aioanylist's state.py (MIT) follows the same managers, except
// for the shopping-list logical timestamp ID; the bundle wins.
//
// State keeps decoded protobuf records, so anylist-js and our own code keep
// working on the same objects as before. toUserDataResponse() rebuilds a
// full-response-shaped object from it.

/** A response that can't be merged; the caller falls back to one full fetch. */
export class SyncResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncResponseError';
  }
}

// The meal-plan response version this client understands (web client: 1).
const SUPPORTED_CALENDAR_RESPONSE_VERSION = 1;

export function createSyncState() {
  return {
    loaded: false,
    lists: new Map(), // id -> ShoppingList
    orderedListIds: [],
    listMeta: new Map(), // listId -> { logicalTimestamp, stores, storeFilters, groups, categories, rules }
    folders: null, // { rootFolderId, timestamps: Map(id -> timestamp) } (cursor only)
    recipes: null,
    calendar: null,
    calendarResponseVersion: 0,
    userCategoriesTimestamp: null, // cursor only
    categorizedItemsTimestamp: null, // cursor only
    listSettings: null, // { timestamp, defaultSettings, byList: Map(listId -> PBListSettings) }
    starterListSettingsTimestamp: null, // cursor only
    starter: { user: new Map(), recent: new Map(), favorite: new Map() },
    orderedStarterIdsTimestamp: null, // cursor only
    mobileAppSettingsTimestamp: null, // cursor only
  };
}

const upsert = (map, records) => {
  for (const record of records || []) {
    if (record && record.identifier) map.set(record.identifier, record);
  }
};
const remove = (map, ids) => {
  for (const id of ids || []) map.delete(id);
};

function listMetaFor(state, listId) {
  let meta = state.listMeta.get(listId);
  if (!meta) {
    meta = { logicalTimestamp: null, stores: new Map(), storeFilters: new Map(), groups: new Map(), categories: new Map(), rules: new Map() };
    state.listMeta.set(listId, meta);
  }
  return meta;
}

// ShoppingListManager.hQ
function mergeListResponse(state, response) {
  const listId = response.listId;
  if (!listId) return;
  const meta = listMetaFor(state, listId);
  meta.logicalTimestamp = response.logicalTimestamp;
  if (response.isFullSync) {
    for (const map of [meta.stores, meta.storeFilters, meta.groups, meta.categories, meta.rules]) map.clear();
  }
  upsert(meta.stores, response.stores);
  remove(meta.stores, response.deletedStoreIds);
  upsert(meta.storeFilters, response.storeFilters);
  remove(meta.storeFilters, response.deletedStoreFilterIds);
  for (const groupId of response.deletedCategoryGroupIds || []) {
    meta.groups.delete(groupId);
    for (const [id, category] of meta.categories) {
      if (category.categoryGroupId === groupId) meta.categories.delete(id);
    }
  }
  for (const groupResponse of response.categoryGroupResponses || []) {
    remove(meta.categories, groupResponse.deletedCategoryIds);
    const group = groupResponse.categoryGroup;
    if (!group) continue;
    upsert(meta.categories, group.categories);
    if (group.identifier) meta.groups.set(group.identifier, group);
  }
  remove(meta.rules, response.deletedCategorizationRuleIds);
  upsert(meta.rules, response.categorizationRules);
}

// ShoppingListManager.cQ
function mergeShoppingLists(state, response) {
  for (const list of response.newLists || []) {
    if (list.identifier) state.lists.set(list.identifier, list);
  }
  // Modified lists only replace lists the client already has.
  for (const list of response.modifiedLists || []) {
    if (state.lists.has(list.identifier)) state.lists.set(list.identifier, list);
  }
  for (const id of response.unknownIds || []) {
    state.lists.delete(id);
    state.listMeta.delete(id);
  }
  state.orderedListIds = [...(response.orderedIds || [])];
  for (const listResponse of response.listResponses || []) mergeListResponse(state, listResponse);
}

// ListFolderManager.DB (we keep only what the cursor needs)
function mergeFolders(state, response) {
  if (!response.listDataId || !response.rootFolderId) return;
  const folders = state.folders && !response.includesAllFolders ? state.folders : { timestamps: new Map() };
  folders.rootFolderId = response.rootFolderId;
  for (const folder of response.listFolders || []) {
    if (folder.identifier) folders.timestamps.set(folder.identifier, folder.timestamp);
  }
  remove(folders.timestamps, response.deletedFolderIds);
  state.folders = folders;
}

// RecipeManager.FX
function mergeRecipes(state, response, pb) {
  if (!response.recipeDataId) return;
  const data = state.recipes || { recipes: new Map(), collections: new Map(), collectionIds: [] };
  data.recipeDataId = response.recipeDataId;
  data.timestamp = response.timestamp;
  data.maxRecipeCount = response.maxRecipeCount;
  upsert(data.recipes, response.recipes);
  upsert(data.collections, response.recipeCollections);
  if (response.includesRecipeCollectionIds) {
    data.collectionIds = [...(response.recipeCollectionIds || [])];
    for (const id of [...data.collections.keys()]) {
      if (!data.collectionIds.includes(id)) data.collections.delete(id);
    }
  }
  if (response.allRecipesCollection) {
    data.allRecipesCollection = response.allRecipesCollection;
    const kept = new Set(response.allRecipesCollection.recipeIds || []);
    for (const id of [...data.recipes.keys()]) {
      if (!kept.has(id)) data.recipes.delete(id);
    }
    // Strip deleted recipes from every collection
    for (const [id, collection] of data.collections) {
      const recipeIds = collection.recipeIds || [];
      if (recipeIds.every(r => kept.has(r))) continue;
      const copy = pb.PBRecipeCollection.decode(collection.toBuffer());
      copy.recipeIds = recipeIds.filter(r => kept.has(r));
      data.collections.set(id, copy);
    }
  }
  data.pendingRecipeLinkRequests = response.pendingRecipeLinkRequests || [];
  data.recipeLinkRequestsToConfirm = response.recipeLinkRequestsToConfirm || [];
  data.linkedUsers = response.linkedUsers || [];
  state.recipes = data;
}

// MealPlanManager.Zq
function mergeCalendar(state, response) {
  const calendarId = response.calendarId;
  if (!calendarId) return;
  const version = response.responseVersion;
  if (!(version >= SUPPORTED_CALENDAR_RESPONSE_VERSION)) return;
  const full = !!response.isFullSync;
  if (state.calendar && state.calendar.calendarId !== calendarId && !full) return;
  let calendar = state.calendar;
  if (!calendar || calendar.calendarId !== calendarId || full) {
    calendar = { events: new Map(), labels: new Map(), templates: new Map(), templateEvents: new Map(), templateGroups: new Map() };
  }
  calendar.calendarId = calendarId;
  calendar.logicalTimestamp = response.logicalTimestamp;
  state.calendarResponseVersion = Math.min(version, SUPPORTED_CALENDAR_RESPONSE_VERSION);
  upsert(calendar.events, response.events);
  remove(calendar.events, response.deletedEventIds);
  upsert(calendar.templates, response.templates);
  remove(calendar.templates, response.deletedTemplateIds);
  upsert(calendar.templateEvents, response.templateEvents);
  remove(calendar.templateEvents, response.deletedTemplateEventIds);
  upsert(calendar.templateGroups, response.templateGroups);
  remove(calendar.templateGroups, response.deletedTemplateGroupIds);
  upsert(calendar.labels, response.labels);
  remove(calendar.labels, response.deletedLabelIds);
  state.calendar = calendar;
}

// ListSettingsManager.WI
function mergeListSettings(state, response) {
  const timestamp = response.timestamp;
  if (!timestamp) throw new SyncResponseError('list settings without a timestamp');
  const settings = state.listSettings || { defaultSettings: null, byList: new Map() };
  settings.timestamp = timestamp.timestamp;
  if (timestamp.identifier === 'all') {
    if ((response.settings || []).length > 0) settings.defaultSettings = null;
    settings.byList.clear();
  }
  for (const value of response.settings || []) {
    if (!value.listId) settings.defaultSettings = value;
    else settings.byList.set(value.listId, value);
  }
  state.listSettings = settings;
}

// StarterListsManager.AG
function mergeStarterBatch(map, batch) {
  if (batch.includesAllLists) map.clear();
  else remove(map, batch.unknownListIds);
  for (const response of batch.listResponses || []) {
    const list = response.starterList;
    if (list && list.identifier) map.set(list.identifier, list);
  }
}

/**
 * Merge one PBUserDataResponse into `state`, section by section, the way the
 * web client's UserDataManager.KZ does. Throws SyncResponseError if it can't.
 */
export function mergeUserData(state, response, pb) {
  if (response.shoppingListsResponse) mergeShoppingLists(state, response.shoppingListsResponse);
  if (response.listFoldersResponse) mergeFolders(state, response.listFoldersResponse);
  if (response.recipeDataResponse) mergeRecipes(state, response.recipeDataResponse, pb);
  if (response.mealPlanningCalendarResponse) mergeCalendar(state, response.mealPlanningCalendarResponse);
  if (response.userCategoriesResponse) state.userCategoriesTimestamp = response.userCategoriesResponse.timestamp;
  if (response.categorizedItemsResponse) {
    const timestamp = response.categorizedItemsResponse.timestamp;
    if (!timestamp) throw new SyncResponseError('categorized items without a timestamp');
    state.categorizedItemsTimestamp = timestamp.timestamp;
  }
  if (response.listSettingsResponse) mergeListSettings(state, response.listSettingsResponse);
  if (response.starterListSettingsResponse) {
    const timestamp = response.starterListSettingsResponse.timestamp;
    if (!timestamp) throw new SyncResponseError('starter list settings without a timestamp');
    state.starterListSettingsTimestamp = timestamp.timestamp;
  }
  const starter = response.starterListsResponse;
  if (starter) {
    if (starter.userListsResponse) mergeStarterBatch(state.starter.user, starter.userListsResponse);
    if (starter.recentItemListsResponse) mergeStarterBatch(state.starter.recent, starter.recentItemListsResponse);
    if (starter.favoriteItemListsResponse) mergeStarterBatch(state.starter.favorite, starter.favoriteItemListsResponse);
  }
  if (response.orderedStarterListIdsResponse) state.orderedStarterIdsTimestamp = response.orderedStarterListIdsResponse.timestamp;
  if (response.mobileAppSettingsResponse) state.mobileAppSettingsTimestamp = response.mobileAppSettingsResponse.timestamp;
  state.loaded = true;
}

const timestamp = (pb, identifier, value) => new pb.PBTimestamp({ identifier, timestamp: value });
const timestampList = (pb, records) => new pb.PBTimestampList({
  timestamps: [...records].map(r => timestamp(pb, r.identifier, r.timestamp)),
});

/**
 * The cursors for every section we've received (UserDataManager.VZ).
 * @param {string} userId - identifies the ordered-starter-lists cursor
 */
export function clientTimestamps(state, pb, userId) {
  const out = {
    shoppingListTimestamps: timestampList(pb, state.lists.values()),
    // ShoppingListManager.lQ/uQ: one logical cursor per list with metadata
    shoppingListLogicalTimestamps: new pb.PBLogicalTimestampList({
      timestamps: [...state.lists.keys()]
        .filter(id => state.listMeta.get(id)?.logicalTimestamp != null)
        .map(id => new pb.PBLogicalTimestamp({
          identifier: `ALShoppingListLogicalTimestampID-${id}`,
          logicalTimestamp: state.listMeta.get(id).logicalTimestamp,
          description: id,
        })),
    }),
    starterListTimestamps: timestampList(pb, state.starter.user.values()),
    recentItemTimestamps: timestampList(pb, state.starter.recent.values()),
    favoriteItemTimestamps: timestampList(pb, state.starter.favorite.values()),
  };
  if (state.folders) {
    out.listFolderTimestamps = new pb.PBListFolderTimestamps({
      rootFolderId: state.folders.rootFolderId,
      folderTimestamps: [...state.folders.timestamps].map(([id, ts]) => timestamp(pb, id, ts)),
    });
  }
  if (state.recipes) out.userRecipeDataTimestamp = timestamp(pb, state.recipes.recipeDataId, state.recipes.timestamp);
  if (state.calendar) {
    out.mealPlanningCalendarTimestamp = new pb.PBLogicalTimestamp({
      identifier: state.calendar.calendarId,
      logicalTimestamp: state.calendar.logicalTimestamp,
    });
  }
  if (state.userCategoriesTimestamp != null) out.userCategoriesTimestamp = new pb.PBTimestamp({ timestamp: state.userCategoriesTimestamp });
  if (state.categorizedItemsTimestamp != null) out.categorizedItemsTimestamp = timestamp(pb, 'last-categorized-item-timestamp', state.categorizedItemsTimestamp);
  if (state.listSettings) out.listSettingsTimestamp = timestamp(pb, 'list-settings-timestamp', state.listSettings.timestamp);
  if (state.starterListSettingsTimestamp != null) out.starterListSettingsTimestamp = timestamp(pb, 'list-settings-timestamp', state.starterListSettingsTimestamp);
  if (state.orderedStarterIdsTimestamp != null) out.orderedStarterListIdsTimestamp = timestamp(pb, userId, state.orderedStarterIdsTimestamp);
  if (state.mobileAppSettingsTimestamp != null) out.mobileAppSettingsTimestamp = timestamp(pb, 'mobile-app-settings-timestamp', state.mobileAppSettingsTimestamp);
  return new pb.PBUserDataClientTimestamps(out);
}

/** UserDataManager.JZ / MealPlanManager.iR */
export function clientInfo(state, pb) {
  return new pb.PBUserDataClientInfo({
    mealPlanningCalendarClientInfo: {
      supportedResponseVersion: SUPPORTED_CALENDAR_RESPONSE_VERSION,
      processedResponseVersion: state.calendarResponseVersion,
    },
  });
}

/**
 * What a full PBUserDataResponse would contain, rebuilt from `state`, for
 * anylist-js and src/anylist-client.js. Containers are plain objects; the
 * records in them are the decoded protobuf messages.
 */
export function toUserDataResponse(state) {
  const ordered = state.orderedListIds.filter(id => state.lists.has(id));
  const lists = [...ordered, ...[...state.lists.keys()].filter(id => !ordered.includes(id))].map(id => state.lists.get(id));
  const listResponses = [...state.listMeta].map(([listId, meta]) => ({
    listId,
    logicalTimestamp: meta.logicalTimestamp,
    stores: [...meta.stores.values()],
    storeFilters: [...meta.storeFilters.values()],
    categorizationRules: [...meta.rules.values()],
    categoryGroupResponses: [...meta.groups.values()].map(group => ({
      categoryGroup: {
        ...group,
        categories: [...meta.categories.values()].filter(c => c.categoryGroupId === group.identifier),
      },
    })),
  }));
  const batch = map => ({ listResponses: [...map.values()].map(starterList => ({ starterList })) });
  const recipes = state.recipes;
  const calendar = state.calendar;
  const settings = state.listSettings;
  return {
    shoppingListsResponse: { newLists: lists, orderedIds: lists.map(l => l.identifier), listResponses },
    starterListsResponse: {
      userListsResponse: batch(state.starter.user),
      recentItemListsResponse: batch(state.starter.recent),
      favoriteItemListsResponse: batch(state.starter.favorite),
    },
    recipeDataResponse: recipes
      ? {
        timestamp: recipes.timestamp,
        recipeDataId: recipes.recipeDataId,
        maxRecipeCount: recipes.maxRecipeCount,
        allRecipesCollection: recipes.allRecipesCollection || null,
        recipes: [...recipes.recipes.values()],
        recipeCollectionIds: recipes.collectionIds,
        recipeCollections: [...recipes.collections.values()],
      }
      : { recipeDataId: null, recipes: [], recipeCollections: [] },
    mealPlanningCalendarResponse: calendar
      ? {
        calendarId: calendar.calendarId,
        logicalTimestamp: calendar.logicalTimestamp,
        events: [...calendar.events.values()],
        labels: [...calendar.labels.values()],
      }
      : { calendarId: null, events: [], labels: [] },
    listSettingsResponse: {
      settings: settings ? [...(settings.defaultSettings ? [settings.defaultSettings] : []), ...settings.byList.values()] : [],
    },
  };
}
