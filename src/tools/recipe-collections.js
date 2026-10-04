import { z } from "zod";
import { textResponse, errorResponse, tierActions, READ, WRITE, DELETE } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  async function run(action, params) {
    const { name, collection_id, recipe_names, recipe_ids } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list": {
          const collections = await client.getRecipeCollections();
          if (collections.length === 0) return textResponse("No recipe collections found.");
          const list = collections.map(c => `- **${c.name}** (id: ${c.identifier}, ${c.recipeCount} recipes)${c.recipeCount > 0 ? ': ' + c.recipeNames.join(', ') : ''}`).join('\n');
          return textResponse(`Recipe Collections (${collections.length}):\n${list}`);
        }
        case "create": {
          let collectionName = name;
          if (!collectionName) collectionName = await elicitRequiredField("name", "What should the collection be called?");
          const result = await client.createRecipeCollection(collectionName, recipe_names || [], recipe_ids || []);
          return textResponse(`Created recipe collection "${result.name}"`);
        }
        case "delete": {
          let deleteCollectionName = name;
          if (!collection_id && !deleteCollectionName) deleteCollectionName = await elicitRequiredField("name", "Which collection would you like to delete?");
          const deleted = await client.deleteRecipeCollection({ id: collection_id, name: deleteCollectionName });
          return textResponse(`Deleted recipe collection "${deleted.name}" (id: ${deleted.identifier})`);
        }
        case "add_recipes":
        case "remove_recipes": {
          const recipeRefs = [...(recipe_ids || []).map(id => ({ id })), ...(recipe_names || []).map(n => ({ name: n }))];
          const adding = action === "add_recipes";
          const result = adding
            ? await client.addRecipesToCollection({ id: collection_id, name }, recipeRefs)
            : await client.removeRecipesFromCollection({ id: collection_id, name }, recipeRefs);
          const lines = [];
          if (result.changed.length > 0) lines.push(`${adding ? "Added to" : "Removed from"} "${result.name}" (id: ${result.identifier}): ${result.changed.join(', ')}`);
          if (result.skipped.length > 0) lines.push(`${adding ? "Already in" : "Not in"} "${result.name}", skipped: ${result.skipped.join(', ')}`);
          return textResponse(lines.join("\n"));
        }
      }
    } catch (error) {
      return errorResponse(`Recipe collections ${action} failed: ${error.message}`);
    }
  }

  const read = tierActions(["list"], run, "The collection read action to perform");
  const write = tierActions(["create", "add_recipes", "remove_recipes"], run, "The collection write action to perform");
  const recipeRefs = {
    recipe_names: z.array(z.string()).optional().describe("Recipe names. Each must match exactly one recipe."),
    recipe_ids: z.array(z.string()).optional().describe("Recipe IDs"),
  };

  server.registerTool("recipe_collections_read", {
    title: "Recipe Collections: Read",
    description: `Read AnyList recipe collections. Never changes anything. Actions:
- list: Show all collections with ids, recipe counts and names`,
    annotations: READ,
    inputSchema: {
      action: read.action,
    }
  }, read.handler);

  server.registerTool("recipe_collections_write", {
    title: "Recipe Collections: Add & Change",
    description: `Create AnyList recipe collections and change which recipes they hold. Deleting a collection is a separate tool (recipe_collections_delete). Actions:
- create: Create a new collection, optionally with recipes (by recipe_ids or recipe_names)
- add_recipes: Add existing recipes (recipe_ids and/or recipe_names) to a collection (collection_id or name). Recipes already in it are skipped.
- remove_recipes: Take recipes (recipe_ids and/or recipe_names) out of a collection (collection_id or name). The recipes themselves are not deleted.
If a name matches more than one collection or recipe, the action fails and lists each match's id; retry with the id.`,
    annotations: WRITE,
    inputSchema: {
      action: write.action,
      name: z.string().optional().describe("Collection name (required for create; add_recipes and remove_recipes take this or collection_id)"),
      collection_id: z.string().optional().describe("Collection ID (add_recipes, remove_recipes). Takes precedence over name."),
      ...recipeRefs,
    }
  }, write.handler);

  server.registerTool("recipe_collections_delete", {
    title: "Recipe Collections: Delete",
    description: "Permanently delete one AnyList recipe collection by collection_id or name. The recipes in it are not deleted. If the name matches more than one collection, this fails and lists each match's id; retry with collection_id.",
    annotations: DELETE,
    inputSchema: {
      name: z.string().optional().describe("Collection name"),
      collection_id: z.string().optional().describe("Collection ID. Takes precedence over name."),
    }
  }, params => run("delete", params));
}
