// Starts the stdio server as an MCP client would and checks the tool list.
// Needs no AnyList credentials: listing tools doesn't log in.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expected = ["health_check",
  "meal_plan_delete", "meal_plan_read", "meal_plan_write",
  "recipe_collections_delete", "recipe_collections_read", "recipe_collections_write",
  "recipes_delete", "recipes_read", "recipes_write",
  "shopping_delete", "shopping_read", "shopping_write"];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
  env: { PATH: process.env.PATH },
  stderr: "ignore",
});
const client = new Client({ name: "smoke-stdio", version: "0.0.0" });

await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const names = tools.map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  console.error(`Unexpected tools: ${names.join(", ")}`);
  process.exit(1);
}
console.log(`stdio server OK: ${names.join(", ")}`);
