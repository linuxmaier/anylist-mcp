// Pin a west-of-UTC zone, where anylist-js's Date-based event model shifts
// dates back a day. The update path must not depend on it.
process.env.TZ = 'America/Chicago';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';
import AnyListClient, { refreshEventSortIndex } from '../src/anylist-client.js';

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
  let events;
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
    events = [stored];
    anylist.uid = 'u1';
    anylist._getUserData = async () => ({ mealPlanningCalendarResponse: { calendarId: 'cal1', events } });
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
    // A move goes last in its group (empty here) and loses its label position.
    assert.ok(e.toBuffer().equals(new pb.PBCalendarEvent({ ...FIXTURE, date: '2099-06-17', orderAddedSortIndex: 0, labelSortIndex: null }).toBuffer()));
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

  it('a calendar event moved to another date goes after that date\'s events', async () => {
    stored = new pb.PBCalendarEvent({ ...FIXTURE, eventType: 0 });
    events = [
      stored,
      new pb.PBCalendarEvent({ identifier: 'e2', eventType: 0, date: '2099-06-17', title: 'a', orderAddedSortIndex: 4 }),
      new pb.PBCalendarEvent({ identifier: 'e3', eventType: 0, date: '2099-06-17', title: 'b', orderAddedSortIndex: 7 }),
      new pb.PBCalendarEvent({ identifier: 'e4', eventType: 0, date: '2099-06-18', title: 'c', orderAddedSortIndex: 9 }),
    ];
    await client.updateMealPlanEvent('e1', { date: '2099-06-17' });
    const e = sentOperation().updatedEvent;
    assert.equal(e.orderAddedSortIndex, 8);
    assert.equal(e.labelSortIndex, null);
  });

  it('a title-only update keeps both sort indexes', async () => {
    events.push(new pb.PBCalendarEvent({ identifier: 'e2', eventType: 1, title: 'a', orderAddedSortIndex: 10 }));
    await client.updateMealPlanEvent('e1', { title: 'Burritos' });
    const e = sentOperation().updatedEvent;
    assert.equal(e.orderAddedSortIndex, 3);
    assert.equal(e.labelSortIndex, 2);
  });
});

describe('refreshEventSortIndex', () => {
  const others = [
    { identifier: 'a', eventType: 0, date: '2099-06-17', labelId: 'l1', orderAddedSortIndex: 2 },
    { identifier: 'b', eventType: 0, date: '2099-06-17', labelId: 'l2', orderAddedSortIndex: 5 },
    { identifier: 'q', eventType: 1, orderAddedSortIndex: 11 },
  ];

  it('a calendar event that changes label goes last on its day and loses labelSortIndex', () => {
    const old = { identifier: 'x', eventType: 0, date: '2099-06-17', labelId: 'l1', orderAddedSortIndex: 0, labelSortIndex: 3 };
    const event = { ...old, labelId: 'l2' };
    refreshEventSortIndex(event, old, [old, ...others]);
    assert.equal(event.orderAddedSortIndex, 6);
    assert.equal(event.labelSortIndex, null);
  });

  it('a queue event that changes label goes last in the queue and keeps labelSortIndex', () => {
    const old = { identifier: 'x', eventType: 1, labelId: 'l1', orderAddedSortIndex: 0, labelSortIndex: 3 };
    const event = { ...old, labelId: null };
    refreshEventSortIndex(event, old, [old, ...others]);
    assert.equal(event.orderAddedSortIndex, 12);
    assert.equal(event.labelSortIndex, 3);
  });

  it('an event with no others in its group gets 0', () => {
    const old = { identifier: 'x', eventType: 0, date: '2099-06-17', orderAddedSortIndex: 4, labelSortIndex: 1 };
    const event = { ...old, date: '2099-07-01' };
    refreshEventSortIndex(event, old, [old, ...others]);
    assert.equal(event.orderAddedSortIndex, 0);
    assert.equal(event.labelSortIndex, null);
  });

  it('an unchanged date and label leave the event alone', () => {
    const old = { identifier: 'x', eventType: 0, date: '2099-06-17', labelId: null, orderAddedSortIndex: 0, labelSortIndex: 3 };
    const event = { ...old, labelId: undefined, title: 'new' };
    refreshEventSortIndex(event, old, [old, ...others]);
    assert.equal(event.orderAddedSortIndex, 0);
    assert.equal(event.labelSortIndex, 3);
  });
});

describe('AnyListClient.createMealPlanEvent', () => {
  it('puts the new event after the events already on that date', async () => {
    let created;
    const client = new AnyListClient();
    client.client = {
      _getUserData: async () => ({ mealPlanningCalendarResponse: { events: [
        { identifier: 'a', eventType: 0, date: '2099-06-17', orderAddedSortIndex: 1 },
        { identifier: 'b', eventType: 0, date: '2099-06-18', orderAddedSortIndex: 6 },
      ] } }),
      createEvent: async obj => { created = obj; return { ...obj, identifier: 'new', async save() {} }; },
    };
    await client.createMealPlanEvent({ date: '2099-06-17', title: 'Soup' });
    assert.equal(created.orderAddedSortIndex, 2);
  });
});
