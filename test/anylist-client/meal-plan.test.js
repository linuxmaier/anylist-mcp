/**
 * Tests for meal planning: getMealPlanEvents, getMealPlanLabels,
 * createMealPlanEvent, deleteMealPlanEvent
 */
import { createConnectedClient, makeRunner, printSuiteResults } from './helpers.js';

// Use a future date unlikely to conflict with real events
const TEST_DATE = '2099-01-15';

export async function runMealPlanTests() {
  console.log('\n🗓️  Meal Plan');
  const { test, results } = makeRunner();

  const client = await createConnectedClient();

  // ── getMealPlanEvents ───────────────────────────────────────────────

  await test('getMealPlanEvents returns array', async () => {
    const events = await client.getMealPlanEvents();
    if (!Array.isArray(events)) throw new Error('getMealPlanEvents() should return an array');
    if (events.length > 0) {
      const e = events[0];
      if (typeof e.identifier !== 'string') throw new Error('Event should have identifier string');
      if (typeof e.date !== 'string') throw new Error('Event should have date string');
    }
  });

  await test('getMealPlanEvents event date is YYYY-MM-DD format', async () => {
    const events = await client.getMealPlanEvents();
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    for (const e of events) {
      if (!datePattern.test(e.date)) throw new Error(`Event date "${e.date}" is not YYYY-MM-DD format`);
    }
  });

  // ── getMealPlanLabels ───────────────────────────────────────────────

  await test('getMealPlanLabels returns array', async () => {
    const labels = await client.getMealPlanLabels();
    if (!Array.isArray(labels)) throw new Error('getMealPlanLabels() should return an array');
    if (labels.length > 0) {
      const l = labels[0];
      if (typeof l.identifier !== 'string') throw new Error('Label should have identifier string');
      if (typeof l.name !== 'string') throw new Error('Label should have name string');
    }
  });

  // ── createMealPlanEvent ─────────────────────────────────────────────

  let createdEventId = null;

  await test('createMealPlanEvent returns identifier and date', async () => {
    const result = await client.createMealPlanEvent({
      date: TEST_DATE,
      title: '🧪 Integration Test Meal',
    });
    if (!result.identifier) throw new Error('createMealPlanEvent should return identifier');
    if (result.date !== TEST_DATE) throw new Error(`Expected date "${TEST_DATE}", got "${result.date}"`);
    createdEventId = result.identifier;
  });

  await test('created event appears in getMealPlanEvents', async () => {
    if (!createdEventId) throw new Error('No event was created in previous test');
    const events = await client.getMealPlanEvents();
    const found = events.find(e => e.identifier === createdEventId);
    if (!found) throw new Error(`Event "${createdEventId}" not found after creation`);
    if (found.date !== TEST_DATE) throw new Error(`Expected date "${TEST_DATE}", got "${found.date}"`);
  });

  await test('createMealPlanEvent with recipe links recipeId', async () => {
    const recipes = await client.getRecipes();
    if (recipes.length === 0) {
      console.log('    (skipped — no recipes in account)');
      return;
    }
    // Use a different future date to avoid conflict
    const DATE2 = '2099-01-16';
    const recipe = recipes[0];
    const result = await client.createMealPlanEvent({
      date: DATE2,
      recipeId: recipe.identifier,
    });
    if (!result.identifier) throw new Error('Should return identifier');

    const events = await client.getMealPlanEvents();
    const found = events.find(e => e.identifier === result.identifier);
    if (!found) throw new Error('Event with recipe not found after creation');
    if (found.recipeId !== recipe.identifier && found.recipeName !== recipe.name) {
      throw new Error(`Expected linked recipe "${recipe.name}"`);
    }

    // Cleanup this extra event
    try { await client.deleteMealPlanEvent(result.identifier); } catch {}
  });

  // ── updateMealPlanEvent ─────────────────────────────────────────────

  await test('updateMealPlanEvent moves event, changes label, keeps ID and recipe', async () => {
    const recipes = await client.getRecipes();
    const labels = await client.getMealPlanLabels();
    if (recipes.length === 0 || labels.length < 2) {
      console.log('    (skipped — needs a recipe and two labels)');
      return;
    }
    const FROM = '2099-01-17';
    const TO = '2099-01-19';
    const recipe = recipes[0];
    const { identifier } = await client.createMealPlanEvent({
      date: FROM, title: '🧪 Update Test', recipeId: recipe.identifier, labelId: labels[0].identifier,
    });
    const find = async () => (await client.getMealPlanEvents()).find(e => e.identifier === identifier);
    try {
      const result = await client.updateMealPlanEvent(identifier, { date: TO, labelId: labels[1].identifier });
      if (result.identifier !== identifier) throw new Error('update should return the same identifier');
      let found = await find();
      if (!found) throw new Error('Event not found under its original ID after update');
      if (found.date !== TO) throw new Error(`Expected date "${TO}", got "${found.date}"`);
      if (found.labelName !== labels[1].name) throw new Error(`Expected label "${labels[1].name}", got "${found.labelName}"`);
      if (found.recipeId !== recipe.identifier) throw new Error('Recipe link lost after update');
      if (found.title !== '🧪 Update Test') throw new Error('Title changed although not given');

      // Updating only the title must not shift the date (UTC/local bug in anylist-js)
      await client.updateMealPlanEvent(identifier, { title: '🧪 Update Test 2' });
      found = await find();
      if (found.date !== TO) throw new Error(`Title-only update moved date to "${found.date}"`);
      if (found.title !== '🧪 Update Test 2') throw new Error(`Expected new title, got "${found.title}"`);

      // "" clears label and title; the recipe keeps the event valid
      await client.updateMealPlanEvent(identifier, { labelId: '', title: '' });
      found = await find();
      if (found.labelName) throw new Error(`Label should be cleared, got "${found.labelName}"`);
      if (found.title) throw new Error(`Title should be cleared, got "${found.title}"`);
      if (found.recipeId !== recipe.identifier) throw new Error('Recipe link lost after clearing');
    } finally {
      try { await client.deleteMealPlanEvent(identifier); } catch {}
    }
  });

  await test('created and moved events go last on their date (orderAddedSortIndex)', async () => {
    const DAY = '2099-01-22';
    const OTHER = '2099-01-23';
    const raw = async id => (await client.client._getUserData(true))
      .mealPlanningCalendarResponse.events.find(e => e.identifier === id);
    const ids = [];
    try {
      for (const [date, title] of [[DAY, '🧪 Sort A'], [DAY, '🧪 Sort B'], [OTHER, '🧪 Sort C']]) {
        ids.push((await client.createMealPlanEvent({ date, title })).identifier);
      }
      const [a, b, c] = await Promise.all(ids.map(raw));
      if (!(b.orderAddedSortIndex > a.orderAddedSortIndex)) {
        throw new Error(`Second event on ${DAY} should sort after the first: ${a.orderAddedSortIndex}, ${b.orderAddedSortIndex}`);
      }
      await client.updateMealPlanEvent(c.identifier, { date: DAY });
      const moved = await raw(c.identifier);
      if (moved.date !== DAY) throw new Error(`Move failed: ${moved.date}`);
      if (!(moved.orderAddedSortIndex > b.orderAddedSortIndex)) {
        throw new Error(`Moved event should sort last on ${DAY}: ${moved.orderAddedSortIndex} <= ${b.orderAddedSortIndex}`);
      }
    } finally {
      for (const id of ids) { try { await client.deleteMealPlanEvent(id); } catch {} }
    }
  });

  await test('updateMealPlanEvent keeps labelSortIndex and recipeScaleFactor', async () => {
    const recipes = await client.getRecipes();
    const labels = await client.getMealPlanLabels();
    if (recipes.length === 0 || labels.length === 0) {
      console.log('    (skipped — needs a recipe and a label)');
      return;
    }
    // Created through anylist-js directly: the wrapper has no way to set these fields.
    const event = await client.client.createEvent({
      date: new Date('2099-01-21T12:00:00'), recipeId: recipes[0].identifier,
      labelId: labels[0].identifier, recipeScaleFactor: 2,
    });
    event.labelSortIndex = 5;
    await event.save();
    const raw = async () => (await client.client._getUserData(true))
      .mealPlanningCalendarResponse.events.find(e => e.identifier === event.identifier);
    try {
      const before = await raw();
      if (!before) throw new Error('Created event not found');
      if (before.labelSortIndex !== 5 || before.recipeScaleFactor !== 2) {
        throw new Error(`Server did not store the fixture values: labelSortIndex=${before.labelSortIndex}, recipeScaleFactor=${before.recipeScaleFactor}`);
      }
      await client.updateMealPlanEvent(event.identifier, { title: '🧪 Preserve Test' });
      const after = await raw();
      if (after.title !== '🧪 Preserve Test') throw new Error(`Title not updated: "${after.title}"`);
      if (after.labelSortIndex !== 5) throw new Error(`labelSortIndex lost: ${after.labelSortIndex}`);
      if (after.recipeScaleFactor !== 2) throw new Error(`recipeScaleFactor lost: ${after.recipeScaleFactor}`);
      if (after.date !== '2099-01-21') throw new Error(`Date changed: ${after.date}`);
    } finally {
      try { await client.deleteMealPlanEvent(event.identifier); } catch {}
    }
  });

  await test('updateMealPlanEvent throws for non-existent event', async () => {
    let threw = false;
    try {
      await client.updateMealPlanEvent('non-existent-id-🚫', { title: 'x' });
    } catch (e) {
      threw = true;
      if (!e.message.includes('not found')) throw new Error(`Expected "not found", got: ${e.message}`);
    }
    if (!threw) throw new Error('Should have thrown for non-existent event');
  });

  // ── deleteMealPlanEvent ─────────────────────────────────────────────

  await test('deleteMealPlanEvent removes event', async () => {
    if (!createdEventId) throw new Error('No event was created to delete');
    await client.deleteMealPlanEvent(createdEventId);
    const events = await client.getMealPlanEvents();
    const found = events.find(e => e.identifier === createdEventId);
    if (found) throw new Error(`Event "${createdEventId}" should be gone after deletion`);
  });

  await test('deleteMealPlanEvent throws for non-existent event', async () => {
    let threw = false;
    try {
      await client.deleteMealPlanEvent('non-existent-id-🚫');
    } catch (e) {
      threw = true;
      if (!e.message.includes('not found')) throw new Error(`Expected "not found", got: ${e.message}`);
    }
    if (!threw) throw new Error('Should have thrown for non-existent event');
  });

  await client.disconnect();
  return printSuiteResults('Meal Plan', results());
}
