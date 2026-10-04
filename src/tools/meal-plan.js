import { z } from "zod";
import { textResponse, errorResponse, tierActions, READ, WRITE, DELETE } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  const eventFields = {
    title: z.string().optional().describe("Event title (create_event: use this OR recipe_id; update_event: \"\" clears it, only if the event still has a recipe)"),
    recipe_id: z.string().optional().describe("Recipe ID to link (\"\" unlinks it on update_event, only if the event still has a title)"),
    label_id: z.string().optional().describe("Label ID for meal type (\"\" clears it on update_event)"),
    details: z.string().optional().describe("Additional notes (\"\" clears them on update_event)"),
  };

  async function run(action, params) {
    const { date, start_date, end_date, title, recipe_id, label_id, details, event_id } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list_events": {
          let events = await client.getMealPlanEvents();
          if (start_date) events = events.filter(e => e.date >= start_date);
          if (end_date) events = events.filter(e => e.date <= end_date);
          if (events.length === 0) return textResponse("No meal plan events found.");
          events.sort((a, b) => a.date.localeCompare(b.date));
          const list = events.map(e => {
            const parts = [`- **${e.date}**`];
            if (e.title) parts.push(e.title);
            if (e.recipeName) parts.push(`📖 ${e.recipeName}`);
            if (e.labelName) parts.push(`[${e.labelName}]`);
            if (e.details) parts.push(`— ${e.details}`);
            parts.push(`(id: ${e.identifier})`);
            return parts.join(' ');
          }).join('\n');
          return textResponse(`Meal Plan (${events.length} events):\n${list}`);
        }
        case "list_labels": {
          const labels = await client.getMealPlanLabels();
          if (labels.length === 0) return textResponse("No meal plan labels found.");
          const list = labels.map(l => `- **${l.name}** (${l.hexColor || 'no color'}) — id: ${l.identifier}`).join('\n');
          return textResponse(`Meal Plan Labels:\n${list}`);
        }
        case "create_event": {
          let eventDate = date;
          if (!eventDate) eventDate = await elicitRequiredField("date", "What date for the meal plan event? (YYYY-MM-DD)");
          const result = await client.createMealPlanEvent({
            date: eventDate,
            title: title || null,
            recipeId: recipe_id || null,
            labelId: label_id || null,
            details: details || null,
          });
          return textResponse(`Created meal plan event for ${result.date}`);
        }
        case "update_event": {
          let eventId = event_id;
          if (!eventId) eventId = await elicitRequiredField("event_id", "Which event ID should be updated?");
          if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return errorResponse(`Invalid date "${date}". Use YYYY-MM-DD.`);
          }
          const changes = { date, title, recipeId: recipe_id, labelId: label_id, details };
          if (Object.values(changes).every(v => v === undefined)) {
            return errorResponse("Nothing to update. Pass at least one of date, title, recipe_id, label_id, details.");
          }
          const result = await client.updateMealPlanEvent(eventId, changes);
          return textResponse(`Updated meal plan event ${result.identifier} (${result.date})`);
        }
        case "delete_event": {
          let eventId = event_id;
          if (!eventId) eventId = await elicitRequiredField("event_id", "Which event ID should be deleted?");
          await client.deleteMealPlanEvent(eventId);
          return textResponse(`Deleted meal plan event ${eventId}`);
        }
      }
    } catch (error) {
      return errorResponse(`Meal plan ${action} failed: ${error.message}`);
    }
  }

  const read = tierActions(["list_events", "list_labels"], run, "The meal plan read action to perform");
  const write = tierActions(["create_event", "update_event"], run, "The meal plan write action to perform");

  server.registerTool("meal_plan_read", {
    title: "Meal Plan: Read",
    description: `Read the AnyList meal planning calendar. Never changes anything. Actions:
- list_events: Show meal plan events (sorted by date), optionally between start_date and end_date
- list_labels: Show available labels (Breakfast, Lunch, Dinner, etc.) with IDs`,
    annotations: READ,
    inputSchema: {
      action: read.action,
      start_date: z.string().optional().describe("Filter events on or after this date, YYYY-MM-DD (list_events only)"),
      end_date: z.string().optional().describe("Filter events on or before this date, YYYY-MM-DD (list_events only)"),
    }
  }, read.handler);

  server.registerTool("meal_plan_write", {
    title: "Meal Plan: Add & Change",
    description: `Add or change AnyList meal plan events. Deleting is a separate tool (meal_plan_delete). Actions:
- create_event: Add a meal plan event for a date
- update_event: Change an existing event in place (keeps its ID). Only the fields given are changed; pass "" to clear one`,
    annotations: WRITE,
    inputSchema: {
      action: write.action,
      date: z.string().optional().describe("Date in YYYY-MM-DD format (required for create_event; new date for update_event)"),
      event_id: z.string().optional().describe("Event ID (required for update_event)"),
      ...eventFields,
    }
  }, write.handler);

  server.registerTool("meal_plan_delete", {
    title: "Meal Plan: Delete Event",
    description: "Permanently delete one AnyList meal plan event by its ID (from meal_plan_read list_events).",
    annotations: DELETE,
    inputSchema: {
      event_id: z.string().describe("ID of the event to delete"),
    }
  }, params => run("delete_event", params));
}
