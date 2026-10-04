/**
 * Unit tests for how AnyListClient tracks its target list (#19): anylist-js
 * replaces `lists` with new objects on every refresh, so the client must look
 * the list up by identifier rather than keep the old object.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';

const LIST_ID = 'list-1';

function fakeList(names, { identifier = LIST_ID, name = 'Groceries' } = {}) {
  return {
    identifier,
    name,
    stores: [],
    items: names.map(n => ({ name: n, checked: false, storeIds: [] })),
    getItemByName(itemName) { return this.items.find(i => i.name === itemName); },
  };
}

function makeClient() {
  const fake = {
    ws: { readyState: 1 }, // WebSocket open
    lists: [fakeList(['milk'])],
    getListsCalls: 0,
    // What the server returns on the next fetch
    serverLists: null,
    async getLists() {
      this.getListsCalls++;
      if (this.serverLists) this.lists = this.serverLists;
      return this.lists;
    },
    getListByName(name) { return this.lists.find(l => l.name === name); },
  };
  const client = new AnyListClient({ username: 'test', password: 'test' });
  client.client = fake;
  return { client, fake };
}

describe('AnyListClient target list', () => {
  let client;
  let fake;
  beforeEach(async () => {
    ({ client, fake } = makeClient());
    await client.connect('Groceries');
  });

  it('sees items from a WebSocket refresh that replaced the list objects', async () => {
    // What anylist-js does on 'refresh-shopping-lists': new List objects
    fake.lists = [fakeList(['milk', 'eggs'])];

    await client.connect('Groceries');
    assert.deepEqual((await client.getItems()).map(i => i.name), ['milk', 'eggs']);
    assert.ok(client.targetList.getItemByName('eggs'));
    assert.equal(fake.getListsCalls, 0, 'no fetch needed while the WebSocket is open');
  });

  it('fetches lists when the WebSocket is down', async () => {
    fake.ws.readyState = 3; // CLOSED: anylist-js gave up reconnecting
    fake.serverLists = [fakeList(['milk', 'bread'])];

    await client.connect('Groceries');
    assert.equal(fake.getListsCalls, 1);
    assert.deepEqual((await client.getItems()).map(i => i.name), ['milk', 'bread']);
  });

  it('fetches lists when there is no WebSocket', async () => {
    delete fake.ws;
    fake.serverLists = [fakeList(['tea'])];

    await client.connect('Groceries');
    assert.equal(fake.getListsCalls, 1);
    assert.deepEqual((await client.getItems()).map(i => i.name), ['tea']);
  });

  it('looks the list up again by name after it was renamed in the app', async () => {
    fake.lists = [fakeList([], { name: 'Weekly' }), fakeList(['flour'], { identifier: 'list-2', name: 'Groceries' })];

    await client.connect('Groceries');
    assert.equal(client.targetList.identifier, 'list-2');
  });

  it('keeps the last list seen if it is missing from a refresh', () => {
    fake.lists = [];
    assert.equal(client.targetList.identifier, LIST_ID);
  });

  it('is null until connected and after it is cleared', () => {
    assert.equal(new AnyListClient().targetList, null);
    client.targetList = null;
    assert.equal(client.targetList, null);
  });
});
