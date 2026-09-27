/**
 * Shared test infrastructure for tool-level tests.
 *
 * createMockServer() — returns a minimal MCP server stub that captures
 *   registerTool() calls, plus the resulting handlers map.
 *
 * MockAnyListClient — in-memory client that owns its own state arrays.
 *   Call client.reset() (or create a fresh instance) in beforeEach.
 */

import { resolveOne } from '../../src/anylist-client.js';

export function createMockServer() {
  const handlers = {};
  const server = {
    registerTool: (name, _schema, handler) => {
      handlers[name] = handler;
      // Return a stub registeredTool so callers can call .update() without error.
      return { update: () => {} };
    },
    // elicitation.js calls server.server.getClientCapabilities() to detect support.
    // Returning null means elicitation is disabled; missing-param paths throw instead.
    server: { getClientCapabilities: () => null },
  };
  return { server, handlers };
}

export class MockAnyListClient {
  constructor() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this.defaultListName = null;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
  }

  reset() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
  }

  async connect(listName = null) {
    const name = listName || process.env.ANYLIST_LIST_NAME || 'Test List';
    this._connected = true;
    const items = this._items;
    this.targetList = {
      name,
      identifier: 'list-123',
      items,
      getItemByName: (n) => items.find(i => i.name.toLowerCase() === n.toLowerCase()) || null,
    };
    this.client = {};
    return true;
  }

  getLists() { return this._lists; }
  getStores() { return this._stores || []; }

  async addItem(name, qty, notes, category, store = null) {
    this._items.push({ name, quantity: qty, notes, category, store });
  }

  async removeItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't check it`);
    this._items[idx].checked = true;
  }

  async uncheckItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't uncheck it`);
    this._items[idx].checked = false;
  }

  async deleteItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't delete it`);
    this._items.splice(idx, 1);
  }

  async getItems(includeChecked = false, includeNotes = false, includeStore = false) {
    let items = [...this._items];
    if (!includeChecked) items = items.filter(i => !i.checked);
    return items.map(i => ({
      name: i.name,
      quantity: i.quantity || 1,
      checked: i.checked || false,
      category: i.category || 'other',
      ...(includeNotes && i.notes ? { note: i.notes } : {}),
      ...(includeStore && i.store ? { store: i.store } : {}),
    }));
  }

  async setItemStore(name, store) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    item.store = store || null;
  }

  async getFavoriteItems() { return this._favorites; }
  async getRecentItems() { return this._recents; }

  async getRecipes(search = null) {
    let r = [...this._recipes];
    if (search) r = r.filter(x => x.name.toLowerCase().includes(search.toLowerCase()));
    return r;
  }

  async getRecipeIndex() {
    return this._recipes.map(r => ({
      identifier: r.identifier,
      name: r.name,
      rating: r.rating || null,
      prepTime: r.prepTime || null,
      cookTime: r.cookTime || null,
      servings: r.servings || null,
      ingredientNames: (r.ingredients || []).map(i => i.name),
      collections: this._collections.filter(c => (c.recipeIds || []).includes(r.identifier)).map(c => c.name),
    }));
  }

  async getRecipeDetails(ref) {
    const r = resolveOne(this._recipes, ref, 'Recipe');
    return { ...r, ingredients: r.ingredients || [], preparationSteps: r.preparationSteps || [] };
  }

  async createRecipe(opts) {
    this._recipes.push(opts);
    return { identifier: 'r-1', name: opts.name };
  }

  async updateRecipe(ref, fields = {}) {
    const r = resolveOne(this._recipes, ref, 'Recipe');
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) r[key] = value;
    }
    return { identifier: r.identifier, name: r.name };
  }

  async deleteRecipe(ref) {
    const r = resolveOne(this._recipes, ref, 'Recipe');
    this._recipes.splice(this._recipes.indexOf(r), 1);
    return { identifier: r.identifier, name: r.name };
  }

  async importRecipeFromUrl(url) {
    if (!this._pendingImport) throw new Error('Could not parse recipe from URL. The site may not be supported.');
    const imp = this._pendingImport;
    this._recipes.push({ identifier: 'r-imported', name: imp.name, ...imp });
    return {
      name: imp.name,
      identifier: 'r-imported',
      ingredientCount: imp.ingredientCount || 0,
      stepCount: imp.stepCount || 0,
      source: imp.source || null,
      sourceUrl: imp.sourceUrl || url,
    };
  }

  async getMealPlanEvents() { return [...this._events]; }
  async getMealPlanLabels() { return [...this._labels]; }

  async createMealPlanEvent(opts) {
    this._events.push(opts);
    return { identifier: 'e-1', date: opts.date };
  }

  async updateMealPlanEvent(id, changes) {
    const event = this._events.find(e => e.identifier === id);
    if (!event) throw new Error(`Meal plan event "${id}" not found`);
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) event[k] = v === '' ? null : v;
    }
    return { identifier: id, date: event.date };
  }

  async deleteMealPlanEvent(id) {
    const idx = this._events.findIndex(e => e.identifier === id);
    if (idx === -1) throw new Error(`Meal plan event "${id}" not found`);
    this._events.splice(idx, 1);
  }

  async getRecipeCollections() { return [...this._collections]; }

  async createRecipeCollection(name, recipeNames = [], recipeIds = []) {
    const c = { identifier: 'c-1', name, recipeCount: recipeNames.length + recipeIds.length, recipeNames, recipeIds };
    this._collections.push(c);
    return c;
  }

  async deleteRecipeCollection(ref) {
    const c = resolveOne(this._collections, ref, 'Recipe collection');
    this._collections.splice(this._collections.indexOf(c), 1);
    return { identifier: c.identifier, name: c.name };
  }

  async addRecipesToCollection(collectionRef, recipeRefs) {
    return this._changeCollectionRecipes(true, collectionRef, recipeRefs);
  }

  async removeRecipesFromCollection(collectionRef, recipeRefs) {
    return this._changeCollectionRecipes(false, collectionRef, recipeRefs);
  }

  _changeCollectionRecipes(adding, collectionRef, recipeRefs) {
    if (recipeRefs.length === 0) throw new Error('At least one recipe id or name is required');
    const c = resolveOne(this._collections, collectionRef, 'Recipe collection');
    const recipes = recipeRefs.map(ref => resolveOne(this._recipes, ref, 'Recipe'));
    c.recipeIds = c.recipeIds || [];
    const changed = recipes.filter(r => adding !== c.recipeIds.includes(r.identifier));
    const skipped = recipes.filter(r => !changed.includes(r));
    c.recipeIds = adding
      ? [...c.recipeIds, ...changed.map(r => r.identifier)]
      : c.recipeIds.filter(id => !changed.some(r => r.identifier === id));
    return { identifier: c.identifier, name: c.name, changed: changed.map(r => r.name), skipped: skipped.map(r => r.name) };
  }
}
