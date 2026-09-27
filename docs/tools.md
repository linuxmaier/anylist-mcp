# Tool Reference

Functionality is organized into **5 domain-grouped tools**. Every domain tool takes an `action` enum plus action-specific parameters.

```json
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Milk", "quantity": 2 } }
```

---

## `health_check`

Tests the connection to AnyList and verifies access to the target list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `list_name` | string | No | List to test (defaults to configured default) |

---

## `shopping`

Manage shopping lists and items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `list_name` | string | No | Target list (defaults to configured default) |
| `name` | string | For item actions | Item name |
| `quantity` | number | No | Item quantity (add_item only, default 1) |
| `notes` | string | No | Item notes (add_item only) |
| `include_checked` | boolean | No | Include checked-off items (list_items only) |
| `include_notes` | boolean | No | Include item notes in output (list_items only) |
| `store_name` | string | No | Filter items by store (add_items, set_item_category only) |
| `category` | string | No | Category for item (add_item only) |
| `recipe_id` | string | No | Recipe to add (add_recipe; takes precedence over `name`) |
| `meal_plan_event_id` | string | No | Meal plan event to link the items to (add_recipe; without a recipe, adds the event's recipe) |
| `exclude` | string[] | No | Pantry staples to skip (add_recipe); see below |

**Actions:**

```json
// List all shopping lists with item counts
{ "name": "shopping", "arguments": { "action": "list_lists" } }

// List items on a list, grouped by category
{ "name": "shopping", "arguments": { "action": "list_items", "list_name": "Costco", "include_notes": true } }

// Add an item
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Eggs", "quantity": 2, "notes": "organic", "store": "Costco"} }

// Check off an item (supports partial name matching)
{ "name": "shopping", "arguments": { "action": "check_item", "name": "Eggs" } }

// Uncheck a checked-off item (supports partial matching against checked items)
{ "name": "shopping", "arguments": { "action": "uncheck_item", "name": "Eggs" } }

// Delete an item permanently
{ "name": "shopping", "arguments": { "action": "delete_item", "name": "Eggs" } }

// Get favorite items for a list
{ "name": "shopping", "arguments": { "action": "get_favorites" } }

// Get recently added items for a list
{ "name": "shopping", "arguments": { "action": "get_recents" } }

// Set store for an item
{ "name": "shopping", "arguments": { "action": "set_item_store", "name": "Milk", "store_name": "Costco" } }

// Set category for an item

// Add a recipe's ingredients as recipe-linked items, the way the AnyList app does
{ "name": "shopping", "arguments": { "action": "add_recipe", "recipe_id": "d9b05093be274f7ea1222912ebb1dd84", "exclude": ["Kosher salt"] } }
```

`add_recipe` works like "Add to List" in the AnyList app:

- Each ingredient becomes an item that shows its recipe in the app. Headings are skipped.
- An `exclude` entry skips every ingredient whose name contains all of the entry's words, ignoring case and plurals (words are stemmed). `"salt"` skips "Kosher salt" and "Salt and ground black pepper"; `"black pepper"` skips "Freshly ground black pepper"; `"oil"` skips "neutral oil". Broad entries catch more: `"pepper"` also skips "red bell peppers". Each skipped line names the entry that matched.
- Item IDs are derived from the stemmed ingredient name, unit and package size, as the app derives them. So an ingredient that is already on the list, from any recipe, gains a second recipe link instead of becoming a duplicate item, and a checked-off one is unchecked.
- A new item takes its category from a favorite or recent item with the same name, if there is one; the server doesn't categorize recipe items.
- Scaled recipes (a recipe or meal-plan event scale factor other than 1) are refused for now.

The output lists one line per ingredient: `added`, `merged` (into an item already on the list, named after the arrow if it differs), `revived` (was checked off), `already linked` or `skipped (exclude: <entry>)`.

---

## `recipes`

Manage AnyList recipes, including URL import and text parsing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `name` | string | For most actions | Recipe name |
| `search` | string | No | Filter recipes by name (list, index) |
| `ingredient` | string | No | Keep recipes with an ingredient whose name contains this (index only) |
| `collection` | string | No | Keep recipes in a collection whose name contains this (index only) |
| `max_total_minutes` | number | No | Prep + cook at most this; recipes without times are excluded (index only) |
| `not_planned_since` | string | No | `YYYY-MM-DD`; keep recipes with no meal-plan event on or after this date, future ones included (index only) |
| `ingredients` | array | No | `[{ name, quantity }]` (create, update — replaces list on update) |
| `steps` | string[] | No | Preparation steps (create, update — replaces list on update) |
| `note` | string | No | Recipe notes (create, update) |
| `source_name` | string | No | Source attribution (create, update) |
| `source_url` | string | No | Source URL (create, update) |
| `prep_time` | number | No | Prep time in minutes (create, update) |
| `cook_time` | number | No | Cook time in minutes (create, update) |
| `servings` | string | No | e.g. `"4"` or `"4-6"` (create, update) |
| `url` | string | For import/normalize | URL to fetch recipe from |
| `text` | string | For normalize | Raw recipe text to parse |
| `save` | boolean | No | Save normalized result to AnyList (normalize only) |

**Actions:**

```json
// Browse all recipes (summaries: name, rating, times, servings)
{ "name": "recipes", "arguments": { "action": "list" } }

// Search recipes
{ "name": "recipes", "arguments": { "action": "list", "search": "chicken" } }

// Planning index — one line per recipe: times (prep+cook), servings, collections,
// last (latest event up to today) / next (earliest future event), up to 8 main
// ingredients (pantry staples like salt, pepper, water and oil left out), id
{ "name": "recipes", "arguments": { "action": "index" } }
{ "name": "recipes", "arguments": { "action": "index", "ingredient": "chicken", "max_total_minutes": 45, "not_planned_since": "2026-08-01" } }

// Get full details — ingredients and steps
{ "name": "recipes", "arguments": { "action": "get", "name": "Chicken Tikka Masala" } }

// Create a recipe
{ "name": "recipes", "arguments": {
    "action": "create",
    "name": "Simple Pasta",
    "ingredients": [
      { "name": "spaghetti", "quantity": "1 lb" },
      { "name": "garlic cloves", "quantity": "2" },
      { "name": "olive oil", "quantity": "1/4 cup" }
    ],
    "steps": ["Boil pasta", "Sauté garlic in oil", "Toss together"],
    "servings": "4"
} }

// Partially update a recipe — only the fields you pass change; the rest
// (identifier, note, photos, collection membership, meal-plan links) are kept.
// ingredients and steps, when provided, replace the whole array.
{ "name": "recipes", "arguments": { "action": "update", "name": "Simple Pasta", "servings": "6", "note": "Doubled the garlic" } }

// Delete a recipe
{ "name": "recipes", "arguments": { "action": "delete", "name": "Simple Pasta" } }

// Import a recipe from a website URL
{ "name": "recipes", "arguments": { "action": "import_url", "url": "https://..." } }

// Parse and preview a recipe without saving (set save=true to also save)
{ "name": "recipes", "arguments": { "action": "normalize", "url": "https://..." } }
{ "name": "recipes", "arguments": { "action": "normalize", "text": "Pasta\n\n1 lb spaghetti\n\n1. Boil pasta", "save": true } }
```

---

## `meal_plan`

Manage the AnyList meal planning calendar.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `date` | string | For create | Date in `YYYY-MM-DD` format |
| `title` | string | No | Event title (use this or `recipe_id`) |
| `recipe_id` | string | No | Link an existing recipe by ID |
| `label_id` | string | No | Meal type label ID (get from `list_labels`) |
| `details` | string | No | Additional notes |
| `event_id` | string | For update/delete | Event ID (from `list_events`) |

`update_event` changes only the fields you pass and keeps the event's ID. Pass `""` to clear `title`, `recipe_id`, `label_id` or `details`; an event must keep a title or a recipe.

**Actions:**

```json
// View all meal plan events, sorted by date
{ "name": "meal_plan", "arguments": { "action": "list_events" } }

// Get available labels (Breakfast, Lunch, Dinner, etc.) with their IDs
{ "name": "meal_plan", "arguments": { "action": "list_labels" } }

// Schedule a meal
{ "name": "meal_plan", "arguments": {
    "action": "create_event",
    "date": "2025-02-15",
    "title": "Pizza Night",
    "label_id": "<id from list_labels>"
} }

// Move an event to another day and change its label (other fields unchanged)
{ "name": "meal_plan", "arguments": {
    "action": "update_event",
    "event_id": "<id>",
    "date": "2025-02-17",
    "label_id": "<id from list_labels>"
} }

// Delete an event
{ "name": "meal_plan", "arguments": { "action": "delete_event", "event_id": "<id>" } }
```

---

## `recipe_collections`

Organize recipes into named collections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list`, `create`, `delete`, `add_recipes`, or `remove_recipes` |
| `name` | string | For create | Collection name. `delete`, `add_recipes` and `remove_recipes` take this or `collection_id` |
| `collection_id` | string | No | Collection ID; takes precedence over `name` |
| `recipe_names` | string[] | No | Recipes by name (`create`, `add_recipes`, `remove_recipes`) |
| `recipe_ids` | string[] | No | Recipes by ID (`create`, `add_recipes`, `remove_recipes`) |

A name that matches more than one collection or recipe makes the action fail and list each match's ID. `add_recipes` skips recipes already in the collection. `remove_recipes` only takes recipes out of the collection and never deletes them.

**Actions:**

```json
// List all collections
{ "name": "recipe_collections", "arguments": { "action": "list" } }

// Create a collection
{ "name": "recipe_collections", "arguments": {
    "action": "create",
    "name": "Weeknight Dinners",
    "recipe_names": ["Simple Pasta", "Chicken Tikka Masala"]
} }

// Add recipes to an existing collection
{ "name": "recipe_collections", "arguments": {
    "action": "add_recipes",
    "collection_id": "<collection id from list>",
    "recipe_names": ["Lemon Chicken"]
} }

// Take a recipe out of a collection (the recipe itself is kept)
{ "name": "recipe_collections", "arguments": {
    "action": "remove_recipes",
    "name": "Weeknight Dinners",
    "recipe_names": ["Simple Pasta"]
} }
```

---

## Typical multi-step interaction

1. **Browse recipes** — `recipes` → `list`
2. **Get details** — `recipes` → `get` with `name`
3. **Plan the meal** — `meal_plan` → `create_event` with date and title
4. **Add ingredients** — `shopping` → `add_item` for each ingredient
