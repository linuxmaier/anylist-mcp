import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  server.registerTool("recipe_collections", {
    title: "Recipe Collections",
    description: `Manage AnyList recipe collections. Actions:
- list: Show all collections with ids, recipe counts and names
- create: Create a new collection, optionally with recipes (by recipe_ids or recipe_names)
- delete: Delete a collection by collection_id or name
If a name matches more than one collection or recipe, the action fails and lists each match's id; retry with the id.`,
    inputSchema: {
      action: z.enum(["list", "create", "delete"]).describe("The collection action to perform"),
      name: z.string().optional().describe("Collection name (required for create; delete takes this or collection_id)"),
      collection_id: z.string().optional().describe("Collection ID (delete). Takes precedence over name."),
      recipe_names: z.array(z.string()).optional().describe("Recipe names to include (create only). Each must match exactly one recipe."),
      recipe_ids: z.array(z.string()).optional().describe("Recipe IDs to include (create only)"),
    }
  }, async (params) => {
    const { action, name, collection_id, recipe_names, recipe_ids } = params;
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
      }
    } catch (error) {
      return errorResponse(`Recipe collections ${action} failed: ${error.message}`);
    }
  });
}
