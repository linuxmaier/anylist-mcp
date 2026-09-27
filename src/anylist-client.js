import AnyList from '../anylist-js/lib/index.js';
import uuid from '../anylist-js/lib/uuid.js';
import FormData from 'form-data';
import { normalizeRecipe } from './recipe-normalizer.js';

/**
 * Pick exactly one item (anything with `identifier` and `name`) by id or name.
 *
 * An `id` wins over a `name` when both are given. A name matches
 * case-insensitively; if it matches more than one item this throws, listing
 * each match's id plus `describe(item)`, rather than picking one silently.
 *
 * @param {Array<{identifier: string, name: string}>} items
 * @param {{ id?: string, name?: string }} ref
 * @param {string} kind - singular label for messages, e.g. "Recipe"
 * @param {(item: object) => string} [describe] - detail that tells duplicates apart
 */
export function resolveOne(items, { id, name } = {}, kind, describe = () => '') {
  if (id) {
    const item = items.find(i => i.identifier === id);
    if (!item) throw new Error(`${kind} with id "${id}" not found`);
    return item;
  }
  if (!name) throw new Error(`${kind} id or name is required`);
  const matches = items.filter(i => i.name && i.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) throw new Error(`${kind} "${name}" not found`);
  if (matches.length > 1) {
    const lines = matches.map(m => {
      const detail = describe(m);
      return `- id: ${m.identifier}${detail ? ` (${detail})` : ''}`;
    });
    throw new Error(`${matches.length} ${kind.toLowerCase()}s are named "${name}". Retry with one of these ids:\n${lines.join('\n')}`);
  }
  return matches[0];
}

function describeRecipe(r) {
  const parts = [];
  if (r.sourceName) parts.push(`source: ${r.sourceName}`);
  const ts = r.creationTimestamp || r.timestamp;
  if (ts) parts.push(`created: ${new Date(ts * 1000).toISOString().slice(0, 10)}`);
  parts.push(`${r.ingredients ? r.ingredients.length : 0} ingredients`);
  return parts.join(', ');
}

function describeCollection(recipes) {
  return c => {
    const ids = c.recipeIds || [];
    const names = ids.slice(0, 3).map(id => {
      const r = recipes.find(r => r.identifier === id);
      return r ? r.name : id;
    });
    return `${ids.length} recipes${names.length ? `: ${names.join(', ')}${ids.length > 3 ? ', ...' : ''}` : ''}`;
  };
}

class AnyListClient {
  /**
   * @param {{ username?: string, password?: string, defaultListName?: string }} [credentials]
   *   Optional credentials. Falls back to ANYLIST_USERNAME / ANYLIST_PASSWORD / ANYLIST_LIST_NAME
   *   environment variables when not provided (stdio mode).
   */
  constructor({ username, password, defaultListName } = {}) {
    this.client = null;
    this.targetList = null;
    this._username = username || null;
    this._password = password || null;
    this.defaultListName = defaultListName || null;
  }

  async connect(listName = null) {
    const username = this._username || process.env.ANYLIST_USERNAME;
    const password = this._password || process.env.ANYLIST_PASSWORD;
    const targetListName = listName || this.defaultListName || process.env.ANYLIST_LIST_NAME;

    if (!username || !password) {
      const error = new Error('Missing AnyList credentials. Provide username and password.');
      console.error(error.message);
      throw error;
    }

    if (!targetListName) {
      const error = new Error('No list name provided and no default list configured');
      console.error(error.message);
      throw error;
    }

    // If already connected to the same list, skip reconnection
    if (this.client && this.targetList && this.targetList.name === targetListName) {
      return true;
    }

    try {
      // Create AnyList client if not already authenticated
      if (!this.client) {
        this.client = new AnyList({
          email: username,
          password: password
        });

        // Authenticate
        console.error('Connecting to AnyList...');
        await this.client.login();
        console.error('Successfully authenticated with AnyList');

        await this.client.getLists();
      }

      // Find the target list
      console.error(`Looking for list: "${targetListName}"`);
      this.targetList = this.client.getListByName(targetListName);

      if (!this.targetList) {
        const error = new Error(`List "${targetListName}" not found. Available lists: ${this.getAvailableListNames().join(', ')}`);
        console.error(error.message);
        throw error;
      }

      console.error(`Connected to list: "${this.targetList.name}"`);

      return true;

    } catch (error) {
      const wrappedError = new Error(`Failed to connect to AnyList: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  getAvailableListNames() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => list.name);
  }

  getLists() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => ({
      name: list.name,
      uncheckedCount: list.items ? list.items.filter(item => !item.checked).length : 0
    }));
  }

  // Known limitation: quantity only sticks for NEW items (set via _encode during
  // creation, below). For an existing item we fall back to existingItem.save(),
  // which emits a `set-list-item-quantity` op — that handler does NOT populate
  // quantityPb.rawQuantity, so the AnyList apps render no quantity change even
  // though this server reports success. Fixing it needs a full `update-list-item`
  // op (see Item.assignToCustomCategory), which is unsafe until Item._encode
  // round-trips recipeId / rawIngredient / prices / photoIds. Workaround for
  // callers: delete the item and re-add it with the new quantity.
  async addItem(itemName, quantity = 1, notes = null, category = "other", store = null) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // First, check if item already exists
      const existingItem = this.targetList.getItemByName(itemName);

      if (existingItem) {
        // Item exists - check if it's checked (completed)

        if (existingItem.checked) {
          // Uncheck the item to make it active again
          existingItem.checked = false;
          existingItem.quantity = quantity; // Update quantity if needed
          if (notes !== null) {
            existingItem.details = notes;
          }

          console.error(`Unchecked existing item: ${existingItem.name}`);
          existingItem.save();
        } else {

          // Item already exists and is unchecked, no action needed
          console.error(`Item "${itemName}" already exists and is active`);
          existingItem.quantity = quantity;
          if (notes !== null) {
            existingItem.details = notes;
          }
          // Category not used if item already has a category

          existingItem.save();
        }
      } else {
        // Item doesn't exist, create new one
        const itemOptions = { name: itemName };
        if (notes !== null) {
          itemOptions.details = notes;
        }
        if (category !== "other") {
          itemOptions.categoryMatchId = category;
        }
        // Carry the quantity through creation so it lands in quantityPb.rawQuantity
        // (List.addItem encodes the item). Bare "1" is AnyList's default, so skip it.
        const rawQuantity = quantity == null ? "" : String(quantity).trim();
        if (rawQuantity !== "" && rawQuantity !== "1") {
          itemOptions.quantity = rawQuantity;
        }

        const newItem = this.client.createItem(itemOptions);
        await this.targetList.addItem(newItem);

        console.error(`Added new item: ${newItem.name}`);
      }

      if (store) {
        await this.setItemStore(itemName, store);
      }

    } catch (error) {
      const wrappedError = new Error(`Failed to add item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async deleteItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't delete it`);
        console.error(error.message);
        throw error;
      }

      await this.targetList.removeItem(existingItem);
      console.error(`Deleted item: ${existingItem.name}`);

    } catch (error) {
      const wrappedError = new Error(`Failed to delete item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async removeItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Find the item by name
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't check it`);
        console.error(error.message);
        throw error;
      }

      // Check the item (mark as completed) instead of deleting
      if (!existingItem.checked) {
        existingItem.checked = true;
        await existingItem.save();
        console.error(`Checked off item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already checked off`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to remove item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async uncheckItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't uncheck it`);
        console.error(error.message);
        throw error;
      }

      // Uncheck the item (mark as active again). No-op if already unchecked.
      if (existingItem.checked) {
        existingItem.checked = false;
        await existingItem.save();
        console.error(`Unchecked item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already unchecked`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to uncheck item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async getItems(includeChecked = false, includeNotes = false) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Get all items from the list
      const items = this.targetList.items || [];

      // Filter based on checked status
      const filteredItems = includeChecked
        ? items
        : items.filter(item => !item.checked);

      // Map to a clean format
      return filteredItems.map(item => {
        const result = {
          name: item.name,
          quantity: item.quantity ?? null,
          checked: item.checked || false,
          category: item.categoryMatchId || 'other'
        };
        if (includeNotes && item.details) {
          result.note = item.details;
        }
        const store = (this.targetList.stores || []).find(s => s.identifier === item.storeIds[0]);
        result.store = store ? store.name : null;
        
        return result;
      });
    } catch (error) {
      const wrappedError = new Error(`Failed to get items: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  _buildCategoryMap() {
    const categoryMap = {};
    try {
      // Access the raw user data from the client to get category groups
      const userData = this.client._userData;
      if (userData && userData.shoppingListsResponse && userData.shoppingListsResponse.categoryGroupResponses) {
        for (const groupResponse of userData.shoppingListsResponse.categoryGroupResponses) {
          if (groupResponse.categoryGroup && groupResponse.categoryGroup.categories) {
            for (const category of groupResponse.categoryGroup.categories) {
              if (category.identifier && category.name) {
                categoryMap[category.identifier] = category.name;
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Failed to build category map: ${error.message}`);
    }
    return categoryMap;
  }

  // ===== STORES =====

  getStores() {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    return this.targetList.stores || [];
  }

  async setItemStore(itemName, storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    let storeIds = [];
    if (storeName) {
      const store = this.targetList.findStoreByName(storeName);
      if (!store) {
        const available = (this.targetList.stores || []).map(s => s.name).join(', ') || 'none';
        throw new Error(`Store "${storeName}" not found. Available stores: ${available}`);
      }
      storeIds = [store.identifier];
    }
    await item.setStores(storeIds);
  }

  async createStore(storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    try {
      const store = await this.targetList.createStore(storeName);
      console.error(`Created store: ${store.name}`);
      return store;
    } catch (error) {
      throw new Error(`Failed to create store "${storeName}": ${error.message}`);
    }
  }

  async deleteStore(storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const store = this.targetList.findStoreByName(storeName);
    if (!store) {
      throw new Error(`Store "${storeName}" not found`);
    }
    try {
      await this.targetList.deleteStore(store.identifier);
      console.error(`Deleted store: ${storeName}`);
    } catch (error) {
      throw new Error(`Failed to delete store "${storeName}": ${error.message}`);
    }
  }

  // ===== RECIPES =====

  async getRecipes(searchQuery = null) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      let results = recipes.map(r => ({
        identifier: r.identifier,
        name: r.name,
        note: r.note || null,
        sourceName: r.sourceName || null,
        sourceUrl: r.sourceUrl || null,
        rating: r.rating || null,
        prepTime: r.prepTime || null,
        cookTime: r.cookTime || null,
        servings: r.servings || null,
        ingredientCount: r.ingredients ? r.ingredients.length : 0,
        stepCount: r.preparationSteps ? r.preparationSteps.length : 0,
      }));
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        results = results.filter(r => r.name && r.name.toLowerCase().includes(q));
      }
      return results;
    } catch (error) {
      throw new Error(`Failed to get recipes: ${error.message}`);
    }
  }

  /**
   * Every recipe with its ingredient names and collection names, for the planning index.
   * Ingredients without rawIngredient are section headings ("Dough", "For the Icing:") and are skipped.
   */
  async getRecipeIndex() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const userData = await this.client._getUserData();
      const collections = userData.recipeDataResponse.recipeCollections || [];
      return recipes.map(r => ({
        identifier: r.identifier,
        name: r.name,
        rating: r.rating || null,
        prepTime: r.prepTime || null,
        cookTime: r.cookTime || null,
        servings: r.servings || null,
        ingredientNames: (r.ingredients || [])
          .filter(i => i.rawIngredient)
          .map(i => i.name || i.rawIngredient),
        // Collection names can repeat ("Main Dishes" twice); list each name once.
        collections: [...new Set(collections
          .filter(c => (c.recipeIds || []).includes(r.identifier))
          .map(c => c.name))],
      }));
    } catch (error) {
      throw new Error(`Failed to get recipe index: ${error.message}`);
    }
  }

  /** @param {{ id?: string, name?: string }} ref - recipe id or name (id wins) */
  async getRecipeDetails(ref) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = resolveOne(recipes, ref, 'Recipe', describeRecipe);
      return {
        identifier: recipe.identifier,
        name: recipe.name,
        note: recipe.note || null,
        sourceName: recipe.sourceName || null,
        sourceUrl: recipe.sourceUrl || null,
        rating: recipe.rating || null,
        prepTime: recipe.prepTime || null,
        cookTime: recipe.cookTime || null,
        servings: recipe.servings || null,
        nutritionalInfo: recipe.nutritionalInfo || null,
        createdAt: recipe.creationTimestamp
          ? new Date(recipe.creationTimestamp * 1000).toISOString()
          : (recipe.timestamp ? new Date(recipe.timestamp * 1000).toISOString() : null),
        ingredients: recipe.ingredients ? recipe.ingredients.map(i => ({
          rawIngredient: i.rawIngredient || null,
          name: i.name || null,
          quantity: i.quantity || null,
          note: i.note || null,
        })) : [],
        preparationSteps: recipe.preparationSteps || [],
      };
    } catch (error) {
      throw new Error(`Failed to get recipe details: ${error.message}`);
    }
  }

  async importRecipeFromUrl(url) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Try AnyList's native web import first
    let nativeError = null;
    try {
      const result = await this.client.client.post('data/recipes/web-import?url=' + encodeURIComponent(url));
      const decoded = this.client.protobuf.PBRecipeWebImportResponse.decode(result.body);

      if (decoded.statusCode === 0 && decoded.recipe) {
        // Native import succeeded
        const recipe = await this.client.createRecipe({
          name: decoded.recipe.name,
          note: decoded.recipe.note || null,
          sourceName: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          prepTime: decoded.recipe.prepTime || null,
          cookTime: decoded.recipe.cookTime || null,
          servings: decoded.recipe.servings || null,
          nutritionalInfo: decoded.recipe.nutritionalInfo || null,
          rating: decoded.recipe.rating || null,
          ingredients: decoded.recipe.ingredients || [],
          preparationSteps: decoded.recipe.preparationSteps || [],
        });
        recipe.isNewRecipeFromWebImport = true;
        recipe.creationTimestamp = Date.now() / 1000;
        await recipe.save();
        console.error(`Imported recipe from URL (native): ${recipe.name}`);

        return {
          name: recipe.name,
          identifier: recipe.identifier,
          ingredientCount: decoded.recipe.ingredients?.length || 0,
          stepCount: decoded.recipe.preparationSteps?.length || 0,
          source: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          isPremiumUser: decoded.isPremiumUser,
          freeImportsRemaining: decoded.freeRecipeImportsRemainingCount,
          method: 'native',
        };
      }
      nativeError = decoded.siteSpecificHelpText || 'Native import returned no recipe';
    } catch (error) {
      nativeError = error.message;
    }

    // Fallback: use normalizer
    console.error(`Native import failed (${nativeError}), trying normalizer fallback...`);
    try {
      const normalized = await normalizeRecipe({ url });
      const created = await this.createRecipe({
        name: normalized.name,
        ingredients: normalized.ingredients,
        preparationSteps: normalized.preparationSteps,
        note: normalized.note,
        sourceName: normalized.sourceName,
        sourceUrl: normalized.sourceUrl || url,
        prepTime: normalized.prepTime,
        cookTime: normalized.cookTime,
        servings: normalized.servings,
      });
      console.error(`Imported recipe from URL (normalizer fallback): ${created.name}`);

      return {
        name: created.name,
        identifier: created.identifier,
        ingredientCount: normalized.ingredients.length,
        stepCount: normalized.preparationSteps.length,
        source: normalized.sourceName || null,
        sourceUrl: normalized.sourceUrl || url,
        method: 'normalizer',
      };
    } catch (fallbackError) {
      throw new Error(`Failed to import recipe from URL: native import failed (${nativeError}), normalizer also failed (${fallbackError.message})`);
    }
  }

  async createRecipe({ name, ingredients = [], preparationSteps = [], note = null, sourceName = null, sourceUrl = null, prepTime = null, cookTime = null, servings = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const nowSecs = Date.now() / 1000;
      const recipeObj = { name, creationTimestamp: nowSecs };
      if (note) recipeObj.note = note;
      if (sourceName) recipeObj.sourceName = sourceName;
      if (sourceUrl) recipeObj.sourceUrl = sourceUrl;
      if (prepTime) recipeObj.prepTime = prepTime;
      if (cookTime) recipeObj.cookTime = cookTime;
      if (servings) recipeObj.servings = servings;
      if (preparationSteps.length > 0) recipeObj.preparationSteps = preparationSteps;
      if (ingredients.length > 0) {
        recipeObj.ingredients = ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
        }));
      }
      const recipe = await this.client.createRecipe(recipeObj);
      await recipe.save();
      console.error(`Created recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to create recipe: ${error.message}`);
    }
  }

  /**
   * Partially update an existing recipe in place.
   *
   * Only the fields present in `fields` are changed; every other field
   * (identifier, note, photos, rating, timestamps, and any field not passed)
   * is carried over from the existing recipe. This is a real in-place update
   * (`save-recipe` on the same identifier), NOT a delete + recreate, so recipe
   * collection membership and meal-plan links that reference the recipe id
   * survive untouched.
   *
   * `ingredients` and `preparationSteps`, when provided, REPLACE the existing
   * array wholesale — they are not merged item-by-item.
   *
   * @param {{ id?: string, name?: string }} ref - recipe id or name (id wins)
   * @param {object} fields - subset of { note, sourceName, sourceUrl, prepTime,
   *   cookTime, servings, ingredients, preparationSteps }; keys with an
   *   `undefined` value are ignored.
   */
  async updateRecipe(ref, fields = {}) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const existing = resolveOne(recipes, ref, 'Recipe', describeRecipe);

      // Start from every existing field so nothing is lost on save, then
      // override only the provided fields. Existing ingredients are serialized
      // via toJSON() to preserve their identifiers and headings.
      const merged = {
        identifier: existing.identifier,
        name: existing.name,
        note: existing.note,
        sourceName: existing.sourceName,
        sourceUrl: existing.sourceUrl,
        prepTime: existing.prepTime,
        cookTime: existing.cookTime,
        servings: existing.servings,
        rating: existing.rating,
        nutritionalInfo: existing.nutritionalInfo,
        scaleFactor: existing.scaleFactor,
        paprikaIdentifier: existing.paprikaIdentifier,
        creationTimestamp: existing.creationTimestamp,
        photoIds: existing.photoIds,
        photoUrls: existing.photoUrls,
        preparationSteps: existing.preparationSteps,
        ingredients: existing.ingredients.map(i => i.toJSON()),
      };

      for (const key of ['note', 'sourceName', 'sourceUrl', 'prepTime', 'cookTime', 'servings', 'preparationSteps']) {
        if (fields[key] !== undefined) merged[key] = fields[key];
      }
      if (fields.ingredients !== undefined) {
        merged.ingredients = fields.ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
        }));
      }

      const recipe = await this.client.createRecipe(merged);
      await recipe.save();
      console.error(`Updated recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to update recipe: ${error.message}`);
    }
  }

  /** @param {{ id?: string, name?: string }} ref - recipe id or name (id wins) */
  async deleteRecipe(ref) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = resolveOne(recipes, ref, 'Recipe', describeRecipe);
      await recipe.delete();
      console.error(`Deleted recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to delete recipe: ${error.message}`);
    }
  }

  // ===== MEAL PLANNING =====

  async getMealPlanEvents() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      return events.map(e => ({
        identifier: e.identifier,
        date: e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date),
        title: e.title || null,
        details: e.details || null,
        labelName: e.label ? e.label.name : null,
        labelColor: e.label ? e.label.hexColor : null,
        recipeName: e.recipe ? e.recipe.name : null,
        recipeId: e.recipeId || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan events: ${error.message}`);
    }
  }

  async getMealPlanLabels() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.client.getMealPlanningCalendarEvents();
      return (this.client.mealPlanningCalendarEventLabels || []).map(l => ({
        identifier: l.identifier,
        name: l.name,
        hexColor: l.hexColor,
        sortIndex: l.sortIndex,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan labels: ${error.message}`);
    }
  }

  async createMealPlanEvent({ date, title = null, recipeId = null, labelId = null, details = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const eventObj = { date: new Date(`${date}T12:00:00`) };
      if (title) eventObj.title = title;
      if (recipeId) eventObj.recipeId = recipeId;
      if (labelId) eventObj.labelId = labelId;
      if (details) eventObj.details = details;
      const event = await this.client.createEvent(eventObj);
      await event.save();
      console.error(`Created meal plan event for ${date}`);
      return { identifier: event.identifier, date: date };
    } catch (error) {
      throw new Error(`Failed to create meal plan event: ${error.message}`);
    }
  }

  /**
   * Update an existing meal plan event in place (keeps its identifier).
   * Only fields that are not undefined are changed; an empty string clears a field.
   */
  async updateMealPlanEvent(eventId, { date, title, recipeId, labelId, details } = {}) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      // 'update-event' replaces the whole event, so start from the full stored
      // PBCalendarEvent. anylist-js's MealPlanningCalendarEvent is lossy: its
      // _encode() drops fields such as icon, isLeftover and eventListItems, and
      // it re-parses the date as UTC midnight but sends the local date. Its
      // save() also sends 'set-event-details', which only updates details.
      const userData = await this.client._getUserData(true);
      const { calendarId, events } = userData.mealPlanningCalendarResponse;
      const stored = events.find(e => e.identifier === eventId);
      if (!stored) {
        throw new Error(`Meal plan event "${eventId}" not found`);
      }
      const { PBCalendarEvent, PBCalendarOperation, PBCalendarOperationList } = this.client.protobuf;
      const event = PBCalendarEvent.decode(stored.toBuffer());
      const clearable = v => (v === '' ? null : v);
      if (date !== undefined) event.date = date;
      if (title !== undefined) event.title = clearable(title);
      if (recipeId !== undefined) event.recipeId = clearable(recipeId);
      if (labelId !== undefined) event.labelId = clearable(labelId);
      if (details !== undefined) event.details = clearable(details);
      if (!event.title && !event.recipeId) {
        throw new Error('Event must keep a title or a recipe');
      }

      const op = new PBCalendarOperation();
      op.setMetadata({ operationId: uuid(), handlerId: 'update-event', userId: this.client.uid });
      op.setCalendarId(calendarId);
      op.setUpdatedEvent(event);
      const ops = new PBCalendarOperationList();
      ops.setOperations([op]);
      const form = new FormData();
      form.append('operations', ops.toBuffer());
      await this.client.client.post('data/meal-planning-calendar/update', { body: form });
      console.error(`Updated meal plan event: ${eventId}`);
      return { identifier: event.identifier, date: event.date };
    } catch (error) {
      throw new Error(`Failed to update meal plan event: ${error.message}`);
    }
  }

  async deleteMealPlanEvent(eventId) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      const event = events.find(e => e.identifier === eventId);
      if (!event) {
        throw new Error(`Meal plan event "${eventId}" not found`);
      }
      await event.delete();
      console.error(`Deleted meal plan event: ${eventId}`);
    } catch (error) {
      throw new Error(`Failed to delete meal plan event: ${error.message}`);
    }
  }

  // ===== FAVORITES & RECENTS =====

  async getFavoriteItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const favList = this.client.getFavoriteItemsByListId(this.targetList.identifier);
      if (!favList || !favList.items) {
        return [];
      }
      return favList.items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get favorite items: ${error.message}`);
    }
  }

  async getRecentItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const items = this.client.getRecentItemsByListId(this.targetList.identifier);
      if (!items) {
        return [];
      }
      return items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get recent items: ${error.message}`);
    }
  }

  // ===== RECIPE COLLECTIONS =====

  async getRecipeCollections() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const recipes = await this.client.getRecipes();
      return collections.map(c => ({
        identifier: c.identifier,
        name: c.name,
        recipeCount: c.recipeIds ? c.recipeIds.length : 0,
        recipeNames: (c.recipeIds || []).map(id => {
          const r = recipes.find(r => r.identifier === id);
          return r ? r.name : id;
        }),
      }));
    } catch (error) {
      throw new Error(`Failed to get recipe collections: ${error.message}`);
    }
  }

  /**
   * @param {string} name - name of the new collection
   * @param {string[]} [recipeNames] - recipes to include by name; each must match exactly one recipe
   * @param {string[]} [recipeIds] - recipes to include by id
   */
  async createRecipeCollection(name, recipeNames = [], recipeIds = []) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const resolvedIds = [];
      if (recipeNames.length > 0 || recipeIds.length > 0) {
        const recipes = await this.client.getRecipes();
        const refs = [...recipeIds.map(id => ({ id })), ...recipeNames.map(n => ({ name: n }))];
        for (const ref of refs) {
          const r = resolveOne(recipes, ref, 'Recipe', describeRecipe);
          if (!resolvedIds.includes(r.identifier)) resolvedIds.push(r.identifier);
        }
      }
      const collection = this.client.createRecipeCollection({ name, recipeIds: resolvedIds });
      await collection.save();
      console.error(`Created recipe collection: ${name}`);
      return { identifier: collection.identifier, name: collection.name };
    } catch (error) {
      throw new Error(`Failed to create recipe collection: ${error.message}`);
    }
  }

  /** @param {{ id?: string, name?: string }} ref - collection id or name (id wins) */
  async deleteRecipeCollection(ref) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const recipes = await this.client.getRecipes();
      const raw = resolveOne(collections, ref, 'Recipe collection', describeCollection(recipes));
      const collection = this.client.createRecipeCollection(raw);
      await collection.delete();
      console.error(`Deleted recipe collection: ${raw.name}`);
      return { identifier: raw.identifier, name: raw.name };
    } catch (error) {
      throw new Error(`Failed to delete recipe collection: ${error.message}`);
    }
  }

  /**
   * Add existing recipes to an existing collection. Recipes already in it are skipped.
   * Every ref is resolved before anything is written.
   * @param {{ id?: string, name?: string }} collectionRef - collection id or name (id wins)
   * @param {Array<{ id?: string, name?: string }>} recipeRefs
   */
  async addRecipesToCollection(collectionRef, recipeRefs) {
    return this._changeCollectionRecipes('add', collectionRef, recipeRefs);
  }

  /**
   * Take recipes out of a collection. The recipes themselves are not deleted.
   * Recipes not in the collection are skipped. Every ref is resolved before anything is written.
   * @param {{ id?: string, name?: string }} collectionRef - collection id or name (id wins)
   * @param {Array<{ id?: string, name?: string }>} recipeRefs
   */
  async removeRecipesFromCollection(collectionRef, recipeRefs) {
    return this._changeCollectionRecipes('remove', collectionRef, recipeRefs);
  }

  async _changeCollectionRecipes(mode, collectionRef, recipeRefs) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      if (recipeRefs.length === 0) throw new Error('At least one recipe id or name is required');
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const recipes = await this.client.getRecipes();
      const raw = resolveOne(collections, collectionRef, 'Recipe collection', describeCollection(recipes));
      const resolved = [];
      for (const ref of recipeRefs) {
        const r = resolveOne(recipes, ref, 'Recipe', describeRecipe);
        if (!resolved.includes(r)) resolved.push(r);
      }

      const current = raw.recipeIds || [];
      const changed = resolved.filter(r => (mode === 'add') !== current.includes(r.identifier));
      const skipped = resolved.filter(r => !changed.includes(r));

      // AnyList reads recipeIds in these operations as the delta, not the whole
      // list: add sends one op with only the new ids, remove sends one op per
      // recipe. (anylist-js addRecipe/removeRecipe send the full list; don't use them.)
      const clone = recipeIds => this.client.createRecipeCollection({
        identifier: raw.identifier,
        timestamp: raw.timestamp,
        name: raw.name,
        collectionSettings: raw.collectionSettings,
        recipeIds,
      });
      if (mode === 'add' && changed.length > 0) {
        await clone(changed.map(r => r.identifier)).performOperation('add-recipes-to-collection');
      }
      if (mode === 'remove') {
        for (const r of changed) {
          await clone([r.identifier]).performOperation('remove-recipes-from-collection');
        }
      }
      console.error(`${mode === 'add' ? 'Added' : 'Removed'} ${changed.length} recipe(s) ${mode === 'add' ? 'to' : 'from'} collection: ${raw.name}`);
      return {
        identifier: raw.identifier,
        name: raw.name,
        changed: changed.map(r => r.name),
        skipped: skipped.map(r => r.name),
      };
    } catch (error) {
      throw new Error(`Failed to ${mode} collection recipes: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.teardown();
        console.error('Disconnected from AnyList');
      } catch (error) {
        const wrappedError = new Error(`Error during disconnect: ${error.message}`);
        console.error(wrappedError.message);
        throw wrappedError;
      }
    }
    this.client = null;
    this.targetList = null;
  }
}

export default AnyListClient;
