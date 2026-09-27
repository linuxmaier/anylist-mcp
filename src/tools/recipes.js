import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";
import { normalizeRecipe } from "../recipe-normalizer.js";

// AnyList stores prepTime/cookTime in seconds; the tool speaks minutes.
const formatMinutes = (seconds) => `${Math.round(seconds / 60)} min`;
const toSeconds = (minutes) => Math.round(minutes * 60);

// Dropped from an index line's main ingredients (still searchable with the ingredient filter).
const PANTRY_STAPLES = [/\bsalt$/, /^(freshly )?(ground )?(black )?pepper$/, /\bsalt and (freshly )?(ground )?(black )?pepper$/, /\bwater$/, /^(extra[- ]virgin )?(olive|vegetable|canola|neutral|cooking) oil$/, /^oil$/, /\b(cooking|oil) spray$/, /^ice$/];
const MAX_MAIN_INGREDIENTS = 8;

// "Today" in the server's local time zone; toISOString() would give the UTC date.
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MAX_INGREDIENT_CHARS = 40;
const NUMBER = String.raw`(?:\d+(?:[./]\d+)?|[¼½¾⅓⅔⅛]|one|two|three|four|five|six|eight|ten|twelve|a|an)`;
const UNIT = String.raw`(?:pounds?|lbs?|oz|ounces?|cups?|tablespoons?|tbsp|teaspoons?|tsp|cans?|jars?|packages?|heads?|pieces?|cloves?|sticks?|sprigs?|bunch(?:es)?|pinch(?:es)?|dash(?:es)?|grams?|g|kg|ml|inch(?:es)?|quarts?|pints?|heaping|packed|small|medium|large)`;
// Leading quantity and unit AnyList sometimes leaves in the name: "2 pounds", "14 oz can", "one 1-inch piece of", "about 1 to 2 cups".
const LEADING_QUANTITY = new RegExp(String.raw`^(?:about\s+)?(?:${NUMBER}(?![\s-]*(?:percent|%))[\s-]+(?:to\s+)?)+(?:${UNIT}\b[\s.-]*)*(?:of\s+)?`);
// Where an amount or alternative starts mid-name: "egg plus 1 yolk", "cumin - 1.5 tsp", "milk or 1/2 cup cream".
const AMOUNT_TAIL = /\s+(?:\+|plus\b|(?:or|-)\s+(?:about\s+)?[\d¼½¾⅓⅔⅛])/;
// A ", " clause starting with one of these is prep or a qualifier, not part of the name.
const TRAILING_CLAUSE = /^(?:plus|for|such as|like|store-bought|homemade|preferably|about|depending|recipe|if|at|from|halved|chopped|minced|diced|sliced|trimmed|smashed|peeled|grated|crushed|cut|divided|to taste|optional|lightly|finely|roughly|coarsely|thinly|very|softened|melted|browned|cold|straight|separated|stemmed|seeded|quartered|rinsed|picked|toasted|hulled|split|crumbled|pressed|drained|beaten|ends|gills|back|white and green|[\d¼½¾⅓⅔⅛])/;

/** Display form of an ingredient name (no quantity or prep notes), or null for a section heading or a bare amount. */
export function displayIngredientName(raw) {
  // "; …", "(…)" and "* …" are always asides. Commas can be part of the name ("boneless, skinless chicken thighs").
  let n = raw.split(/[;(*]/)[0].toLowerCase().replace(/\s*,\s*/g, ', ').trim().replace(/,$/, '');
  if (n.endsWith(':') || /^for the\b/.test(n)) return null;
  n = n.replace(/^[^:]*:\s*/, '') // "toppings: chopped chives"
    .replace(/^(?:\+|plus)\s+/, '') // a continuation line: "plus 2 teaspoons kasuri methi"
    .replace(LEADING_QUANTITY, '')
    .replace(/^of\s+/, '')
    .split(AMOUNT_TAIL)[0]
    .replace(/,$/, '');
  const parts = n.split(', ');
  const cut = parts.findIndex((p, i) => i > 0 && TRAILING_CLAUSE.test(p));
  const name = (cut === -1 ? parts : parts.slice(0, cut)).join(', ').trim();
  return /[a-z]/.test(name) ? name : null;
}

const truncate = (s) => s.length > MAX_INGREDIENT_CHARS ? `${s.slice(0, MAX_INGREDIENT_CHARS - 1).trimEnd()}…` : s;

function mainIngredients(names) {
  const main = [];
  for (const raw of names) {
    const n = displayIngredientName(raw);
    if (!n || PANTRY_STAPLES.some(re => re.test(n))) continue;
    const shown = truncate(n);
    if (main.includes(shown)) continue;
    main.push(shown);
    if (main.length === MAX_MAIN_INGREDIENTS) break;
  }
  return main;
}

export function register(server, getClient) {
  const { elicitRequiredField, elicitConfirmation } = createElicitationHelpers(server);

  server.registerTool("recipes", {
    title: "Recipes",
    description: `Manage AnyList recipes. Actions:
- list: Browse recipes (returns summaries: name, rating, times, servings). Use 'search' to filter.
- get: Get full recipe details (ingredients, steps) by recipe_id or name
- create: Create a new recipe
- update: Partially update an existing recipe by recipe_id or name (only the fields you pass change; the rest are preserved)
- delete: Delete a recipe by recipe_id or name
If a name matches more than one recipe, get/update/delete fail and list each match's id; retry with recipe_id.
- import_url: Import a recipe from a website URL (parses ingredients, steps, etc.)
- normalize: Preview/parse a recipe from a URL or raw text without saving (set save=true to also save)
- index: One compact line per recipe for meal planning: times, servings, collections, last/next planned date, up to 8 main ingredients, id. Filters (all optional, combined): search, ingredient, collection, max_total_minutes, not_planned_since.`,
    inputSchema: {
      action: z.enum(["list", "get", "create", "update", "delete", "import_url", "normalize", "index"]).describe("The recipe action to perform"),
      name: z.string().optional().describe("Recipe name (required for create; get, update and delete take this or recipe_id)"),
      recipe_id: z.string().optional().describe("Recipe ID (get, update, delete). Takes precedence over name."),
      search: z.string().optional().describe("Search query to filter recipes by name (list, index)"),
      ingredient: z.string().optional().describe("Keep recipes with an ingredient whose name contains this (index only)"),
      collection: z.string().optional().describe("Keep recipes in a collection whose name contains this (index only)"),
      max_total_minutes: z.number().optional().describe("Keep recipes whose prep + cook time is at most this many minutes; recipes with no times are excluded (index only)"),
      not_planned_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD. Keep recipes with no meal-plan event on or after this date, future ones included (index only)"),
      ingredients: z.array(z.object({
        name: z.string().describe("Ingredient name, e.g. 'flour'"),
        quantity: z.string().describe("Quantity with unit, e.g. '2 cups'"),
      })).optional().describe("Ingredients with name and quantity (create, update). On update, replaces the entire ingredient list."),
      steps: z.array(z.string()).optional().describe("Preparation steps in order (create, update). On update, replaces the entire step list."),
      note: z.string().optional().describe("Recipe notes (create, update)"),
      source_name: z.string().optional().describe("Source name (create, update)"),
      source_url: z.string().optional().describe("Source URL (create, update)"),
      prep_time: z.number().optional().describe("Prep time in minutes (create, update)"),
      cook_time: z.number().optional().describe("Cook time in minutes (create, update)"),
      servings: z.string().optional().describe("Servings, e.g. '4' or '4-6' (create, update)"),
      url: z.string().optional().describe("URL to import recipe from (import_url, normalize)"),
      text: z.string().optional().describe("Raw recipe text to parse (normalize only)"),
      save: z.boolean().optional().describe("If true, also save normalized recipe to AnyList (normalize only, default false)"),
    }
  }, async (params) => {
    const { action, name, recipe_id, search, ingredient, collection, max_total_minutes, not_planned_since, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings, url, text: recipeText, save: saveRecipe } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list": {
          const recipes = await client.getRecipes(search || null);
          if (recipes.length === 0) return textResponse(search ? `No recipes found matching "${search}".` : "No recipes found.");
          const list = recipes.map(r => {
            const parts = [`- **${r.name}**`];
            if (r.rating) parts.push(`⭐${r.rating}`);
            if (r.prepTime) parts.push(`prep: ${formatMinutes(r.prepTime)}`);
            if (r.cookTime) parts.push(`cook: ${formatMinutes(r.cookTime)}`);
            if (r.servings) parts.push(`serves: ${r.servings}`);
            parts.push(`(id: ${r.identifier})`);
            return parts.join(' | ');
          }).join('\n');
          return textResponse(`Recipes (${recipes.length}):\n${list}`);
        }
        case "index": {
          // Sequential: both refresh the same anylist-js user-data cache.
          const recipes = await client.getRecipeIndex();
          const events = await client.getMealPlanEvents();
          const today = localToday();
          const planned = new Map(); // recipeId -> { last, next, latest }
          for (const e of events) {
            if (!e.recipeId) continue;
            const p = planned.get(e.recipeId) || {};
            if (e.date <= today) { if (!p.last || e.date > p.last) p.last = e.date; }
            else if (!p.next || e.date < p.next) p.next = e.date;
            if (!p.latest || e.date > p.latest) p.latest = e.date;
            planned.set(e.recipeId, p);
          }

          let results = recipes;
          let untimed = 0;
          if (search) {
            const q = search.toLowerCase();
            results = results.filter(r => r.name && r.name.toLowerCase().includes(q));
          }
          if (ingredient) {
            const q = ingredient.toLowerCase();
            results = results.filter(r => r.ingredientNames.some(n => n.toLowerCase().includes(q)));
          }
          if (collection) {
            const q = collection.toLowerCase();
            results = results.filter(r => r.collections.some(c => c.toLowerCase().includes(q)));
          }
          if (max_total_minutes !== undefined) {
            const timed = results.filter(r => r.prepTime || r.cookTime);
            untimed = results.length - timed.length;
            results = timed.filter(r => ((r.prepTime || 0) + (r.cookTime || 0)) / 60 <= max_total_minutes);
          }
          if (not_planned_since) {
            results = results.filter(r => !(planned.get(r.identifier)?.latest >= not_planned_since));
          }

          const filters = [
            search && `name~"${search}"`,
            ingredient && `ingredient~"${ingredient}"`,
            collection && `collection~"${collection}"`,
            max_total_minutes !== undefined && `≤${max_total_minutes} min`,
            not_planned_since && `not planned since ${not_planned_since}`,
          ].filter(Boolean);
          let header = `Recipe index: ${results.length} recipe${results.length === 1 ? '' : 's'}`;
          if (filters.length) header += ` (${filters.join(', ')})`;
          if (untimed) header += `; ${untimed} without times excluded`;
          if (results.length === 0) return textResponse(`${header}. No recipes match.`);

          const lines = results.map(r => {
            const parts = [`- ${r.name}`];
            if (r.rating) parts.push(`⭐${r.rating}`);
            if (r.prepTime || r.cookTime) parts.push(`${Math.round((r.prepTime || 0) / 60)}+${Math.round((r.cookTime || 0) / 60)} min`);
            if (r.servings) parts.push(/serv/i.test(r.servings) ? r.servings : `serves ${r.servings}`);
            if (r.collections.length) parts.push(r.collections.join(', '));
            const p = planned.get(r.identifier);
            if (p?.last) parts.push(`last ${p.last}`);
            if (p?.next) parts.push(`next ${p.next}`);
            const main = mainIngredients(r.ingredientNames);
            if (main.length) parts.push(main.join(' · '));
            parts.push(`id:${r.identifier}`);
            return parts.join(' | ');
          });
          return textResponse(`${header}. Times are prep+cook.\n${lines.join('\n')}`);
        }
        case "get": {
          let getRecipeName = name;
          if (!recipe_id && !getRecipeName) getRecipeName = await elicitRequiredField("name", "Which recipe would you like to view?");
          const recipe = await client.getRecipeDetails({ id: recipe_id, name: getRecipeName });
          let text = `# ${recipe.name}\n\nID: ${recipe.identifier}\n`;
          if (recipe.sourceName) text += `Source: ${recipe.sourceName}\n`;
          if (recipe.sourceUrl) text += `URL: ${recipe.sourceUrl}\n`;
          if (recipe.rating) text += `Rating: ${'⭐'.repeat(recipe.rating)}\n`;
          if (recipe.prepTime) text += `Prep: ${formatMinutes(recipe.prepTime)}\n`;
          if (recipe.cookTime) text += `Cook: ${formatMinutes(recipe.cookTime)}\n`;
          if (recipe.servings) text += `Servings: ${recipe.servings}\n`;
          if (recipe.createdAt) text += `Created: ${recipe.createdAt}\n`;
          if (recipe.note) text += `\nNotes: ${recipe.note}\n`;
          if (recipe.ingredients.length > 0) {
            text += `\n## Ingredients\n`;
            recipe.ingredients.forEach(i => {
              text += `- ${i.rawIngredient || [i.quantity, i.name, i.note].filter(Boolean).join(' ')}\n`;
            });
          }
          if (recipe.preparationSteps.length > 0) {
            text += `\n## Steps\n`;
            recipe.preparationSteps.forEach((s, idx) => { text += `${idx + 1}. ${s}\n`; });
          }
          return textResponse(text);
        }
        case "create": {
          let recipeName = name;
          if (!recipeName) recipeName = await elicitRequiredField("name", "What should the recipe be called?");
          const existingRecipes = await client.getRecipes(recipeName);
          const exactMatches = existingRecipes.filter(r => r.name.toLowerCase() === recipeName.toLowerCase());
          if (exactMatches.length > 1) {
            const ids = exactMatches.map(r => `- id: ${r.identifier}`).join('\n');
            return errorResponse(`${exactMatches.length} recipes are already named "${recipeName}", so it's unclear which to overwrite. Use update or delete with recipe_id instead:\n${ids}`);
          }
          const exactMatch = exactMatches[0];
          if (exactMatch) {
            const confirmed = await elicitConfirmation(`Recipe "${exactMatch.name}" already exists. Overwrite?`);
            if (!confirmed) return textResponse(`Cancelled — recipe "${exactMatch.name}" was not overwritten.`);
            await client.deleteRecipe({ id: exactMatch.identifier });
          }
          const result = await client.createRecipe({
            name: recipeName,
            ingredients: (ingredients || []).map(i => ({
              name: i.name,
              quantity: i.quantity,
              rawIngredient: `${i.quantity} ${i.name}`.trim(),
            })),
            preparationSteps: steps || [],
            note: note || null,
            sourceName: source_name || null,
            sourceUrl: source_url || null,
            prepTime: prep_time ? toSeconds(prep_time) : null,
            cookTime: cook_time ? toSeconds(cook_time) : null,
            servings: servings || null,
          });
          return textResponse(`Created recipe "${result.name}"`);
        }
        case "update": {
          let updateRecipeName = name;
          if (!recipe_id && !updateRecipeName) updateRecipeName = await elicitRequiredField("name", "Which recipe would you like to update?");
          // Build a partial patch: only fields the caller actually provided.
          // ingredients/steps, when present, replace the whole array (see client.updateRecipe).
          const fields = {};
          if (ingredients !== undefined) {
            fields.ingredients = ingredients.map(i => ({
              name: i.name,
              quantity: i.quantity,
              rawIngredient: `${i.quantity} ${i.name}`.trim(),
            }));
          }
          if (steps !== undefined) fields.preparationSteps = steps;
          if (note !== undefined) fields.note = note;
          if (source_name !== undefined) fields.sourceName = source_name;
          if (source_url !== undefined) fields.sourceUrl = source_url;
          if (prep_time !== undefined) fields.prepTime = toSeconds(prep_time);
          if (cook_time !== undefined) fields.cookTime = toSeconds(cook_time);
          if (servings !== undefined) fields.servings = servings;
          if (Object.keys(fields).length === 0) {
            return errorResponse('Action "update" requires at least one field to change (ingredients, steps, note, source_name, source_url, prep_time, cook_time, or servings).');
          }
          const updated = await client.updateRecipe({ id: recipe_id, name: updateRecipeName }, fields);
          return textResponse(`Updated recipe "${updated.name}"`);
        }
        case "delete": {
          let deleteRecipeName = name;
          if (!recipe_id && !deleteRecipeName) deleteRecipeName = await elicitRequiredField("name", "Which recipe would you like to delete?");
          const deleted = await client.deleteRecipe({ id: recipe_id, name: deleteRecipeName });
          return textResponse(`Deleted recipe "${deleted.name}" (id: ${deleted.identifier})`);
        }
        case "import_url": {
          let importUrl = url;
          if (!importUrl) importUrl = await elicitRequiredField("url", "What URL would you like to import a recipe from?");
          const result = await client.importRecipeFromUrl(importUrl);
          let importText = `Imported recipe "${result.name}"\n`;
          importText += `- ${result.ingredientCount} ingredients, ${result.stepCount} steps\n`;
          if (result.source) importText += `- Source: ${result.source}\n`;
          if (result.sourceUrl) importText += `- URL: ${result.sourceUrl}\n`;
          if (result.method) importText += `- Method: ${result.method}\n`;
          return textResponse(importText);
        }
        case "normalize": {
          if (!url && !recipeText) {
            throw new Error('Action "normalize" requires either "url" or "text" parameter');
          }
          const input = {};
          if (url) input.url = url;
          if (recipeText) input.text = recipeText;
          const normalized = await normalizeRecipe(input);

          let output = `# ${normalized.name}\n\n`;
          if (normalized.sourceName) output += `Source: ${normalized.sourceName}\n`;
          if (normalized.sourceUrl) output += `URL: ${normalized.sourceUrl}\n`;
          if (normalized.prepTime) output += `Prep: ${formatMinutes(normalized.prepTime)}\n`;
          if (normalized.cookTime) output += `Cook: ${formatMinutes(normalized.cookTime)}\n`;
          if (normalized.servings) output += `Servings: ${normalized.servings}\n`;
          if (normalized.note) output += `Note: ${normalized.note}\n`;
          output += `\n## Ingredients (${normalized.ingredients.length})\n`;
          normalized.ingredients.forEach(i => { output += `- ${i.rawIngredient}\n`; });
          output += `\n## Steps (${normalized.preparationSteps.length})\n`;
          normalized.preparationSteps.forEach((s, idx) => { output += `${idx + 1}. ${s}\n`; });

          if (saveRecipe) {
            const created = await client.createRecipe({
              name: normalized.name,
              ingredients: normalized.ingredients,
              preparationSteps: normalized.preparationSteps,
              note: normalized.note,
              sourceName: normalized.sourceName,
              sourceUrl: normalized.sourceUrl,
              prepTime: normalized.prepTime,
              cookTime: normalized.cookTime,
              servings: normalized.servings,
            });
            output += `\n✅ Saved to AnyList as "${created.name}"`;
          }
          return textResponse(output);
        }
      }
    } catch (error) {
      return errorResponse(`Recipes ${action} failed: ${error.message}`);
    }
  });
}
