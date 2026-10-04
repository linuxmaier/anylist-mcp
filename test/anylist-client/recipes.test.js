/**
 * Tests for recipe operations: getRecipes, getRecipeDetails, createRecipe, deleteRecipe
 *
 * Also investigates the create→get race condition: a recipe that reports
 * "Created" but cannot be found in the immediately-following getRecipes call.
 */
import { createConnectedClient, makeRunner, printSuiteResults } from './helpers.js';

const RECIPE = `🧪 Test Recipe ${Date.now()}`;
const RECIPE_INGREDIENTS = ['1 cup testing', '2 tbsp assertions'];
const RECIPE_STEPS = ['Mix ingredients', 'Verify results'];

export async function runRecipesTests() {
  console.log('\n📖 Recipes');
  const { test, results } = makeRunner();

  const client = await createConnectedClient();

  // ── getRecipes ─────────────────────────────────────────────────────────

  await test('getRecipes returns array of recipe summaries', async () => {
    const recipes = await client.getRecipes();
    if (!Array.isArray(recipes)) throw new Error('getRecipes() should return an array');
    if (recipes.length > 0) {
      const r = recipes[0];
      if (typeof r.identifier !== 'string') throw new Error('Recipe should have identifier string');
      if (typeof r.name !== 'string') throw new Error('Recipe should have name string');
      if (typeof r.ingredientCount !== 'number') throw new Error('Recipe should have ingredientCount number');
      if (typeof r.stepCount !== 'number') throw new Error('Recipe should have stepCount number');
    }
  });

  await test('getRecipes with search filters by name (case-insensitive)', async () => {
    const all = await client.getRecipes();
    if (all.length === 0) {
      console.log('    (skipped — no recipes in account)');
      return;
    }
    const firstName = all[0].name;
    const partial = firstName.slice(0, 3).toLowerCase();
    const filtered = await client.getRecipes(partial);
    if (!Array.isArray(filtered)) throw new Error('Filtered result should be an array');
    const allMatch = filtered.every(r => r.name.toLowerCase().includes(partial));
    if (!allMatch) throw new Error('All filtered recipes should match the search query');
  });

  // ── createRecipe ──────────────────────────────────────────────────────

  await test('createRecipe returns identifier and name', async () => {
    const result = await client.createRecipe({
      name: RECIPE,
      ingredients: RECIPE_INGREDIENTS.map(i => ({ rawIngredient: i })),
      preparationSteps: RECIPE_STEPS,
    });
    if (!result.identifier) throw new Error('createRecipe should return identifier');
    if (result.name !== RECIPE) throw new Error(`Expected name "${RECIPE}", got "${result.name}"`);
  });

  await test('created recipe appears in getRecipes immediately after creation', async () => {
    // This test intentionally checks the cache/sync behavior.
    // If this fails, createRecipe has a post-save sync issue.
    const recipes = await client.getRecipes();
    const found = recipes.find(r => r.name === RECIPE);
    if (!found) throw new Error(`Recipe "${RECIPE}" not found in getRecipes() after creation`);
  });

  // ── getRecipeDetails ──────────────────────────────────────────────────

  await test('getRecipeDetails returns full recipe with ingredients and steps', async () => {
    const recipe = await client.getRecipeDetails({ name: RECIPE });
    if (recipe.name !== RECIPE) throw new Error(`Expected name "${RECIPE}", got "${recipe.name}"`);
    if (!Array.isArray(recipe.ingredients)) throw new Error('ingredients should be an array');
    if (!Array.isArray(recipe.preparationSteps)) throw new Error('preparationSteps should be an array');
    if (recipe.ingredients.length !== RECIPE_INGREDIENTS.length) {
      throw new Error(`Expected ${RECIPE_INGREDIENTS.length} ingredients, got ${recipe.ingredients.length}`);
    }
    if (recipe.preparationSteps.length !== RECIPE_STEPS.length) {
      throw new Error(`Expected ${RECIPE_STEPS.length} steps, got ${recipe.preparationSteps.length}`);
    }
    // Verify ingredient structure
    const ing = recipe.ingredients[0];
    if (!('rawIngredient' in ing)) throw new Error('Ingredient should have rawIngredient field');
  });

  await test('getRecipeDetails ingredient rawIngredient matches what was saved', async () => {
    const recipe = await client.getRecipeDetails({ name: RECIPE });
    const rawIngredients = recipe.ingredients.map(i => i.rawIngredient);
    for (const expected of RECIPE_INGREDIENTS) {
      if (!rawIngredients.includes(expected)) {
        throw new Error(`Expected ingredient "${expected}" not found in ${JSON.stringify(rawIngredients)}`);
      }
    }
  });

  // ── ingredient identifiers (#21) ─────────────────────────────────────

  // getRecipeDetails doesn't return ingredient identifiers, so read the
  // stored recipe from anylist-js directly.
  const storedIngredients = async () => {
    const recipes = await client.client.getRecipes();
    return recipes.find(r => r.name === RECIPE).ingredients.map(i => i.toJSON());
  };

  let createdIds = [];
  await test('createRecipe gives every ingredient its own identifier', async () => {
    const ingredients = await storedIngredients();
    createdIds = ingredients.map(i => i.identifier);
    if (!createdIds.every(id => /^[0-9a-f]{32}$/.test(id || ''))) throw new Error(`Missing identifiers: ${JSON.stringify(createdIds)}`);
    if (new Set(createdIds).size !== createdIds.length) throw new Error(`Duplicate identifiers: ${JSON.stringify(createdIds)}`);
  });

  await test('updateRecipe keeps identifiers of unchanged ingredients and adds new ones', async () => {
    await client.updateRecipe({ name: RECIPE }, { ingredients: [RECIPE_INGREDIENTS[0], '3 tsp more assertions'] });
    const ids = (await storedIngredients()).map(i => i.identifier);
    if (ids[0] !== createdIds[0]) throw new Error(`Unchanged ingredient lost its identifier: ${ids[0]} != ${createdIds[0]}`);
    if (!/^[0-9a-f]{32}$/.test(ids[1] || '') || createdIds.includes(ids[1])) throw new Error(`Edited ingredient should get a new identifier, got ${ids[1]}`);
  });

  await test('getRecipeDetails throws for non-existent recipe', async () => {
    let threw = false;
    try {
      await client.getRecipeDetails({ name: '🚫 No Such Recipe' });
    } catch (e) {
      threw = true;
      if (!e.message.includes('not found')) throw new Error(`Expected "not found", got: ${e.message}`);
    }
    if (!threw) throw new Error('Should have thrown for non-existent recipe');
  });

  // ── createRecipe with optional fields ────────────────────────────────

  const RECIPE_FULL = `🧪 Test Recipe Full ${Date.now()}`;
  await test('createRecipe stores optional fields (note, sourceName, sourceUrl, prepTime, cookTime, servings)', async () => {
    const result = await client.createRecipe({
      name: RECIPE_FULL,
      ingredients: [{ rawIngredient: '1 cup water' }],
      preparationSteps: ['Boil water'],
      note: 'A test note',
      sourceName: 'Test Source',
      sourceUrl: 'https://example.com/recipe',
      prepTime: 10,
      cookTime: 20,
      servings: '2',
    });
    if (!result.identifier) throw new Error('createRecipe should return identifier');

    const recipe = await client.getRecipeDetails({ name: RECIPE_FULL });
    if (recipe.note !== 'A test note') throw new Error(`Expected note "A test note", got "${recipe.note}"`);
    if (recipe.sourceName !== 'Test Source') throw new Error(`Expected sourceName "Test Source", got "${recipe.sourceName}"`);
    if (recipe.sourceUrl !== 'https://example.com/recipe') throw new Error(`Expected sourceUrl mismatch`);
    if (recipe.prepTime !== 10) throw new Error(`Expected prepTime 10, got ${recipe.prepTime}`);
    if (recipe.cookTime !== 20) throw new Error(`Expected cookTime 20, got ${recipe.cookTime}`);
    if (recipe.servings !== '2') throw new Error(`Expected servings "2", got "${recipe.servings}"`);
  });

  // ── deleteRecipe ──────────────────────────────────────────────────────

  await test('deleteRecipe removes recipe from account', async () => {
    await client.deleteRecipe({ name: RECIPE });
    const recipes = await client.getRecipes();
    const found = recipes.find(r => r.name === RECIPE);
    if (found) throw new Error(`Recipe "${RECIPE}" should be gone after deleteRecipe`);
  });

  await test('deleteRecipe throws for non-existent recipe', async () => {
    let threw = false;
    try {
      await client.deleteRecipe({ name: '🚫 No Such Recipe' });
    } catch (e) {
      threw = true;
      if (!e.message.includes('not found')) throw new Error(`Expected "not found", got: ${e.message}`);
    }
    if (!threw) throw new Error('Should have thrown for non-existent recipe');
  });

  // Cleanup
  try { await client.deleteRecipe({ name: RECIPE_FULL }); } catch {}

  await client.disconnect();
  return printSuiteResults('Recipes', results());
}
