# Tool Reference

Each area (shopping, recipes, meal plan, recipe collections) is split into three tools by what they can do, so an MCP client can grant permissions per tool:

| Tier | Tools | Annotations | Suggested client permission |
|------|-------|-------------|-----------------------------|
| **read** | `shopping_read`, `recipes_read`, `meal_plan_read`, `recipe_collections_read`, `health_check` | `readOnlyHint: true` | Always allow |
| **write** | `shopping_write`, `recipes_write`, `meal_plan_write`, `recipe_collections_write` | `readOnlyHint: false`, `destructiveHint: false` | Needs approval (or Always allow) |
| **delete** | `shopping_delete`, `recipes_delete`, `meal_plan_delete`, `recipe_collections_delete` | `destructiveHint: true` | Needs approval or Blocked |

A `*_read` tool never changes anything. Only a `*_delete` tool removes a whole item, recipe, event or collection; each removes exactly one. `*_write` tools add and change things. Note that `recipes_write` `update` replaces the whole ingredient or step list when you pass one, and `recipe_collections_write` `remove_recipes` takes recipes out of a collection without deleting them.

Read and write tools take an `action` plus action-specific parameters; delete tools take only what identifies the thing to delete:

```json
{ "name": "shopping_write", "arguments": { "action": "add_item", "name": "Milk", "quantity": 2 } }
{ "name": "shopping_delete", "arguments": { "name": "Milk" } }
```

`recipes_read` and `recipes_write` are marked `openWorldHint: true`, because `normalize`, `normalize_and_save` and `import_url` fetch the recipe URL you give them (public addresses only).

---

## `health_check` (read)

Tests the connection to AnyList and verifies access to the target list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `list_name` | string | No | List to test (defaults to configured default) |

---

## Shopping

### `shopping_read`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list_lists`, `list_items`, `get_favorites`, `get_recents`, `list_stores` |
| `list_name` | string | No | Target list (defaults to configured default) |
| `include_checked` | boolean | No | Include checked-off items (list_items only) |
| `include_notes` | boolean | No | Include item notes in output (list_items only) |

```json
// List all shopping lists with item counts
{ "name": "shopping_read", "arguments": { "action": "list_lists" } }

// List items on a list, grouped by category
{ "name": "shopping_read", "arguments": { "action": "list_items", "list_name": "Costco", "include_notes": true } }

// Favorite and recently added items, and the list's stores
{ "name": "shopping_read", "arguments": { "action": "get_favorites" } }
{ "name": "shopping_read", "arguments": { "action": "get_recents" } }
{ "name": "shopping_read", "arguments": { "action": "list_stores" } }
```

### `shopping_write`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `add_item`, `add_items`, `check_item`, `uncheck_item`, `set_item_store`, `add_recipe` |
| `list_name` | string | No | Target list (defaults to configured default) |
| `name` | string | For item actions | Item name; recipe name for add_recipe |
| `quantity` | number or string | No | Item quantity, e.g. `2` or `"500 g"` (add_item only, default 1) |
| `notes` | string | No | Item notes (add_item only) |
| `category` | string | No | Category for the item (add_item only) |
| `store_name` | string | No | Store for the item (add_item, set_item_store; omit to clear on set_item_store) |
| `items` | array | For add_items | Item names, or objects with `name`, `quantity`, `notes`, `category`, `store_name` |
| `recipe_id` | string | No | Recipe to add (add_recipe; takes precedence over `name`) |
| `meal_plan_event_id` | string | No | Meal plan event to link the items to (add_recipe; without a recipe, adds the event's recipe) |
| `exclude` | string[] | No | Pantry staples to skip (add_recipe); see below |

```json
// Add an item, or several at once
{ "name": "shopping_write", "arguments": { "action": "add_item", "name": "Eggs", "quantity": 2, "notes": "organic", "store_name": "Costco" } }
{ "name": "shopping_write", "arguments": { "action": "add_items", "items": ["Milk", { "name": "Bananas", "category": "produce" }] } }

// Check off an item, or uncheck a checked-off one (partial names match)
{ "name": "shopping_write", "arguments": { "action": "check_item", "name": "Eggs" } }
{ "name": "shopping_write", "arguments": { "action": "uncheck_item", "name": "Eggs" } }

// Set or clear an item's store
{ "name": "shopping_write", "arguments": { "action": "set_item_store", "name": "Milk", "store_name": "Costco" } }

// Add a recipe's ingredients as recipe-linked items, the way the AnyList app does
{ "name": "shopping_write", "arguments": { "action": "add_recipe", "recipe_id": "d9b05093be274f7ea1222912ebb1dd84", "exclude": ["Kosher salt"] } }
```

`add_recipe` works like "Add to List" in the AnyList app:

- Each ingredient becomes an item that shows its recipe in the app. Headings are skipped.
- An `exclude` entry skips every ingredient whose name contains all of the entry's words, ignoring case and plurals (words are stemmed). `"salt"` skips "Kosher salt" and "Salt and ground black pepper"; `"black pepper"` skips "Freshly ground black pepper"; `"oil"` skips "neutral oil". Broad entries catch more: `"pepper"` also skips "red bell peppers". Each skipped line names the entry that matched.
- Item IDs are derived from the stemmed ingredient name, unit and package size, as the app derives them. So an ingredient that is already on the list, from any recipe, gains a second recipe link instead of becoming a duplicate item, and a checked-off one is unchecked.
- A new item is categorized like the app does it: by its name, using AnyList's grocery tag data and the list's own categorization rules. A favorite or recent item with the same name still sets the category, if there is one.
- Scaled recipes (a recipe or meal-plan event scale factor other than 1) are refused for now.

The output lists one line per ingredient: `added`, `merged` (into an item already on the list, named after the arrow if it differs), `revived` (was checked off), `already linked` or `skipped (exclude: <entry>)`.

### `shopping_delete`

Permanently removes one item. To complete an item, use `shopping_write` `check_item` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Item name (a partial name matching several items asks which one, or fails) |
| `list_name` | string | No | Target list (defaults to configured default) |

```json
{ "name": "shopping_delete", "arguments": { "name": "Eggs" } }
```

---

## Recipes

If a name matches more than one recipe, the action fails and lists each match's ID; retry with `recipe_id`.

### `recipes_read`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list`, `get`, `index`, `normalize` |
| `name` / `recipe_id` | string | For get | Recipe name or ID (ID wins) |
| `search` | string | No | Filter recipes by name (list, index) |
| `ingredient` | string | No | Keep recipes with an ingredient whose name contains this (index only) |
| `collection` | string | No | Keep recipes in a collection whose name contains this (index only) |
| `max_total_minutes` | number | No | Prep + cook at most this; recipes without times are excluded (index only) |
| `not_planned_since` | string | No | `YYYY-MM-DD`; keep recipes with no meal-plan event on or after this date, future ones included (index only) |
| `url` / `text` | string | For normalize | Recipe URL, or raw recipe text |

```json
// Browse or search recipes (summaries: name, rating, times, servings)
{ "name": "recipes_read", "arguments": { "action": "list", "search": "chicken" } }

// Planning index — one line per recipe: times (prep+cook), servings, collections,
// last (latest event up to today) / next (earliest future event), up to 8 main
// ingredients (pantry staples like salt, pepper, water and oil left out), id
{ "name": "recipes_read", "arguments": { "action": "index", "ingredient": "chicken", "max_total_minutes": 45, "not_planned_since": "2026-08-01" } }

// Full details — ingredients and steps
{ "name": "recipes_read", "arguments": { "action": "get", "name": "Chicken Tikka Masala" } }

// Parse and preview a recipe without saving
{ "name": "recipes_read", "arguments": { "action": "normalize", "url": "https://..." } }
```

### `recipes_write`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `create`, `update`, `import_url`, `normalize_and_save` |
| `name` | string | For create | Recipe name; update takes this or `recipe_id` |
| `recipe_id` | string | No | Recipe ID (update; wins over `name`) |
| `ingredients` | array | No | `[{ name, quantity }]` (create, update — replaces the list on update) |
| `steps` | string[] | No | Preparation steps (create, update — replaces the list on update) |
| `note`, `source_name`, `source_url` | string | No | (create, update) |
| `prep_time`, `cook_time` | number | No | Minutes (create, update) |
| `servings` | string | No | e.g. `"4"` or `"4-6"` (create, update) |
| `url` / `text` | string | For import_url / normalize_and_save | Recipe URL, or raw recipe text (normalize_and_save) |

`create` fails if a recipe with that name already exists: use `update`, or delete it first with `recipes_delete`.

```json
// Create a recipe
{ "name": "recipes_write", "arguments": {
    "action": "create",
    "name": "Simple Pasta",
    "ingredients": [
      { "name": "spaghetti", "quantity": "1 lb" },
      { "name": "garlic cloves", "quantity": "2" }
    ],
    "steps": ["Boil pasta", "Sauté garlic in oil", "Toss together"],
    "servings": "4"
} }

// Partially update a recipe — only the fields you pass change; the rest
// (identifier, note, photos, collection membership, meal-plan links) are kept.
{ "name": "recipes_write", "arguments": { "action": "update", "name": "Simple Pasta", "servings": "6", "note": "Doubled the garlic" } }

// Import a recipe from a website, or parse and save one from text
{ "name": "recipes_write", "arguments": { "action": "import_url", "url": "https://..." } }
{ "name": "recipes_write", "arguments": { "action": "normalize_and_save", "text": "Pasta\n\n1 lb spaghetti\n\n1. Boil pasta" } }
```

### `recipes_delete`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` / `recipe_id` | string | One of them | Recipe name or ID (ID wins) |

```json
{ "name": "recipes_delete", "arguments": { "recipe_id": "<id>" } }
```

---

## Meal plan

### `meal_plan_read`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list_events`, `list_labels` |
| `start_date` / `end_date` | string | No | `YYYY-MM-DD` bounds (list_events only) |

```json
// Events, sorted by date
{ "name": "meal_plan_read", "arguments": { "action": "list_events", "start_date": "2025-02-10" } }

// Labels (Breakfast, Lunch, Dinner, etc.) with their IDs
{ "name": "meal_plan_read", "arguments": { "action": "list_labels" } }
```

### `meal_plan_write`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `create_event`, `update_event` |
| `date` | string | For create_event | `YYYY-MM-DD`; the new date on update_event |
| `event_id` | string | For update_event | Event ID (from `list_events`) |
| `title` | string | No | Event title (use this or `recipe_id`) |
| `recipe_id` | string | No | Link an existing recipe by ID |
| `label_id` | string | No | Meal type label ID (from `list_labels`) |
| `details` | string | No | Additional notes |

`update_event` changes only the fields you pass and keeps the event's ID. Pass `""` to clear `title`, `recipe_id`, `label_id` or `details`; an event must keep a title or a recipe. A new or moved event goes last on its day, as in the app.

```json
// Schedule a meal
{ "name": "meal_plan_write", "arguments": {
    "action": "create_event",
    "date": "2025-02-15",
    "title": "Pizza Night",
    "label_id": "<id from list_labels>"
} }

// Move an event to another day and change its label (other fields unchanged)
{ "name": "meal_plan_write", "arguments": {
    "action": "update_event",
    "event_id": "<id>",
    "date": "2025-02-17",
    "label_id": "<id from list_labels>"
} }
```

### `meal_plan_delete`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event_id` | string | Yes | Event ID (from `list_events`) |

```json
{ "name": "meal_plan_delete", "arguments": { "event_id": "<id>" } }
```

---

## Recipe collections

A name that matches more than one collection or recipe makes the action fail and list each match's ID.

### `recipe_collections_read`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list` |

```json
{ "name": "recipe_collections_read", "arguments": { "action": "list" } }
```

### `recipe_collections_write`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `create`, `add_recipes`, `remove_recipes` |
| `name` | string | For create | Collection name; `add_recipes` and `remove_recipes` take this or `collection_id` |
| `collection_id` | string | No | Collection ID; takes precedence over `name` |
| `recipe_names` | string[] | No | Recipes by name |
| `recipe_ids` | string[] | No | Recipes by ID |

`add_recipes` skips recipes already in the collection. `remove_recipes` only takes recipes out of the collection and never deletes them.

```json
// Create a collection
{ "name": "recipe_collections_write", "arguments": {
    "action": "create",
    "name": "Weeknight Dinners",
    "recipe_names": ["Simple Pasta", "Chicken Tikka Masala"]
} }

// Add recipes to, or take them out of, a collection
{ "name": "recipe_collections_write", "arguments": { "action": "add_recipes", "collection_id": "<id>", "recipe_names": ["Lemon Chicken"] } }
{ "name": "recipe_collections_write", "arguments": { "action": "remove_recipes", "name": "Weeknight Dinners", "recipe_names": ["Simple Pasta"] } }
```

### `recipe_collections_delete`

Deletes one collection. The recipes in it are kept.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` / `collection_id` | string | One of them | Collection name or ID (ID wins) |

```json
{ "name": "recipe_collections_delete", "arguments": { "collection_id": "<id>" } }
```

---

## Typical multi-step interaction

1. **Browse recipes** — `recipes_read` → `index` or `list`
2. **Get details** — `recipes_read` → `get` with `recipe_id`
3. **Plan the meal** — `meal_plan_write` → `create_event` with date and `recipe_id`
4. **Add ingredients** — `shopping_write` → `add_recipe` with `recipe_id` (and `meal_plan_event_id`)
