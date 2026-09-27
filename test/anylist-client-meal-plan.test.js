// Pin a west-of-UTC zone: anylist-js parses stored dates as UTC midnight,
// which is the previous local day here.
process.env.TZ = 'America/Chicago';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';

const localDate = d => [
  d.getFullYear(),
  String(d.getMonth() + 1).padStart(2, '0'),
  String(d.getDate()).padStart(2, '0'),
].join('-');

// Mimics a MealPlanningCalendarEvent loaded from the server. performOperation()
// records the handler and the local date, which is what anylist-js sends.
function loadedEvent(fields) {
  return {
    ...fields,
    date: new Date(fields.date),
    saved: null,
    async performOperation(handlerId) {
      this.saved = { ...this, handlerId, date: localDate(this.date) };
    },
  };
}

describe('AnyListClient.updateMealPlanEvent', () => {
  let client;
  let event;

  beforeEach(() => {
    event = loadedEvent({ identifier: 'e1', date: '2099-06-15', title: 'Tacos', recipeId: 'r1', labelId: 'l1', details: 'spicy' });
    client = new AnyListClient();
    client.client = { getMealPlanningCalendarEvents: async () => [event] };
  });

  it('preserves fields that are not given, including the date', async () => {
    const result = await client.updateMealPlanEvent('e1', { labelId: 'l2' });
    assert.deepEqual(result, { identifier: 'e1', date: '2099-06-15' });
    assert.equal(event.saved.handlerId, 'update-event');
    const { identifier, date, title, recipeId, labelId, details } = event.saved;
    assert.deepEqual({ identifier, date, title, recipeId, labelId, details },
      { identifier: 'e1', date: '2099-06-15', title: 'Tacos', recipeId: 'r1', labelId: 'l2', details: 'spicy' });
  });

  it('moves the event to the given date', async () => {
    await client.updateMealPlanEvent('e1', { date: '2099-06-17' });
    assert.equal(event.saved.date, '2099-06-17');
    assert.equal(event.saved.identifier, 'e1');
  });

  it('clears fields given as ""', async () => {
    await client.updateMealPlanEvent('e1', { labelId: '', details: '', title: '' });
    assert.equal(event.saved.labelId, null);
    assert.equal(event.saved.details, null);
    assert.equal(event.saved.title, null);
    assert.equal(event.saved.recipeId, 'r1');
  });

  it('refuses to leave the event with neither title nor recipe', async () => {
    await assert.rejects(client.updateMealPlanEvent('e1', { title: '', recipeId: '' }), /title or a recipe/);
    assert.equal(event.saved, null);
  });

  it('throws for an unknown event', async () => {
    await assert.rejects(client.updateMealPlanEvent('nope', { title: 'x' }), /not found/);
  });
});
