// Pin a west-of-UTC zone, where anylist-js's Date-based event model shifts
// dates back a day. The update path must not depend on it.
process.env.TZ = 'America/Chicago';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';
import AnyListClient from '../src/anylist-client.js';

// Every PBCalendarEvent field set, including the ones anylist-js's _encode() drops.
const FIXTURE = {
  identifier: 'e1',
  logicalTimestamp: 42,
  calendarId: 'cal1',
  eventType: 1,
  title: 'Tacos',
  details: 'spicy',
  icon: { iconName: 'taco', tintHexColor: 'FF9335' },
  recipeId: 'r1',
  labelId: 'l1',
  isLeftover: true,
  orderAddedSortIndex: 3,
  labelSortIndex: 2,
  recipeScaleFactor: 1.5,
  eventListItems: [{ identifier: 'li1', name: 'tortillas', details: 'corn' }],
  date: '2099-06-15',
  templateId: 't1',
  templateDayId: 'td1',
};

describe('AnyListClient.updateMealPlanEvent', () => {
  let client;
  let pb;
  let stored;
  let posted;

  // Decodes the operation list out of the multipart form that was posted.
  const sentOperation = () => {
    const body = posted.body;
    const start = body.indexOf('\r\n\r\n') + 4;
    const end = body.lastIndexOf(`\r\n--${posted.boundary}--`);
    const ops = pb.PBCalendarOperationList.decode(body.subarray(start, end));
    assert.equal(ops.operations.length, 1);
    return ops.operations[0];
  };

  beforeEach(() => {
    posted = null;
    const anylist = new AnyList({ email: 'test', password: 'test', credentialsFile: '/nonexistent' });
    pb = anylist.protobuf;
    stored = new pb.PBCalendarEvent(FIXTURE);
    anylist.uid = 'u1';
    anylist._getUserData = async () => ({ mealPlanningCalendarResponse: { calendarId: 'cal1', events: [stored] } });
    anylist.client = {
      post: async (url, { body }) => { posted = { url, body: body.getBuffer(), boundary: body.getBoundary() }; },
    };
    client = new AnyListClient();
    client.client = anylist;
  });

  it('sends update-event with every field not given unchanged', async () => {
    const result = await client.updateMealPlanEvent('e1', { title: 'Burritos' });
    assert.deepEqual(result, { identifier: 'e1', date: '2099-06-15' });
    assert.equal(posted.url, 'data/meal-planning-calendar/update');

    const op = sentOperation();
    assert.equal(op.metadata.handlerId, 'update-event');
    assert.equal(op.calendarId, 'cal1');

    const expected = new pb.PBCalendarEvent({ ...FIXTURE, title: 'Burritos' });
    assert.ok(op.updatedEvent.toBuffer().equals(expected.toBuffer()), 'encoded event differs beyond the title');
    const e = op.updatedEvent;
    assert.equal(e.icon.iconName, 'taco');
    assert.equal(e.isLeftover, true);
    assert.equal(e.eventListItems[0].name, 'tortillas');
    assert.equal(e.labelSortIndex, 2);
    assert.equal(e.eventType, 1);
    assert.equal(e.templateId, 't1');
    assert.equal(e.recipeScaleFactor, 1.5);
    assert.equal(e.date, '2099-06-15');
  });

  it('does not modify the cached stored event', async () => {
    const before = stored.toBuffer();
    await client.updateMealPlanEvent('e1', { title: 'Burritos', date: '2099-06-17' });
    assert.ok(stored.toBuffer().equals(before));
  });

  it('moves the event to the given date', async () => {
    await client.updateMealPlanEvent('e1', { date: '2099-06-17' });
    const e = sentOperation().updatedEvent;
    assert.equal(e.date, '2099-06-17');
    assert.equal(e.identifier, 'e1');
    assert.ok(e.toBuffer().equals(new pb.PBCalendarEvent({ ...FIXTURE, date: '2099-06-17' }).toBuffer()));
  });

  it('clears fields given as ""', async () => {
    await client.updateMealPlanEvent('e1', { labelId: '', details: '', title: '' });
    const e = sentOperation().updatedEvent;
    assert.equal(e.labelId, null);
    assert.equal(e.details, null);
    assert.equal(e.title, null);
    assert.equal(e.recipeId, 'r1');
  });

  it('refuses to leave the event with neither title nor recipe', async () => {
    await assert.rejects(client.updateMealPlanEvent('e1', { title: '', recipeId: '' }), /title or a recipe/);
    assert.equal(posted, null);
  });

  it('throws for an unknown event', async () => {
    await assert.rejects(client.updateMealPlanEvent('nope', { title: 'x' }), /not found/);
    assert.equal(posted, null);
  });
});
