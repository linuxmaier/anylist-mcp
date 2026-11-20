/**
 * How many requests AnyListClient makes (#44), and conditional sync (#45). A
 * real anylist-js instance talks to a local HTTP server standing in for
 * AnyList, so the request guard's got hooks, the snapshot, the multipart
 * request and the protobuf decoding all run for real.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import AnyList from '../anylist-js/lib/index.js';
import AnyListClient from '../src/anylist-client.js';
import { RequestGuard, DOWNLOAD_LIMIT, DOWNLOAD_WINDOW_MS } from '../src/request-guard.js';

const LIST_ID = '11111111111141118111111111111111';

/** The named parts of a multipart/form-data body. */
function parseMultipart(contentType, body) {
  const boundary = /boundary=(.+)$/.exec(contentType || '')?.[1];
  const parts = {};
  if (!boundary) return parts;
  const delimiter = Buffer.from(`--${boundary}`);
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(start + delimiter.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    const name = /name="([^"]+)"/.exec(part.subarray(0, headerEnd).toString())?.[1];
    if (name) parts[name] = part.subarray(headerEnd + 4);
    start = next;
  }
  return parts;
}

describe('AnyListClient request volume', () => {
  let server;
  let base;
  let hits; // request paths, in order
  let syncs; // multipart parts of each user-data/get request
  let respond; // (path, parts) => { status, headers, body } | null for the default
  let clock;
  let anylist;
  let client;

  const downloads = () => hits.filter(p => p === '/data/user-data/get').length;

  function userData(pb) {
    return new pb.PBUserDataResponse({
      shoppingListsResponse: {
        newLists: [{ identifier: LIST_ID, name: 'Groceries', items: [
          { identifier: 'item-milk', listId: LIST_ID, name: 'milk' },
        ] }],
      },
      starterListsResponse: {
        recentItemListsResponse: { listResponses: [] },
        favoriteItemListsResponse: { listResponses: [] },
      },
      recipeDataResponse: {
        recipeDataId: 'rd-1',
        recipes: [{ identifier: 'r-chili', name: 'Chili', ingredients: [
          { identifier: 'i-1', name: 'black beans', quantity: '2 cans', rawIngredient: '2 cans black beans' },
        ] }],
        recipeCollections: [{ identifier: 'c-1', name: 'Weeknight', recipeIds: [] }],
      },
      mealPlanningCalendarResponse: {
        calendarId: 'cal-1',
        isFullSync: true,
        logicalTimestamp: 7,
        responseVersion: 1,
        events: [{ identifier: 'e-1', calendarId: 'cal-1', date: '2099-01-01', title: 'zz-mcp-test', recipeId: 'r-chili' }],
        labels: [],
      },
    }).toBuffer();
  }

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        hits.push(req.url);
        const parts = parseMultipart(req.headers['content-type'], Buffer.concat(chunks));
        if (req.url === '/data/user-data/get') syncs.push(parts);
        const custom = respond(req.url, parts);
        if (custom) {
          res.writeHead(custom.status, custom.headers || {});
          return res.end(custom.body || '');
        }
        try {
          if (req.url === '/data/user-data/get') return res.end(userData(anylist.protobuf));
          res.end();
        } catch (error) {
          res.writeHead(500);
          res.end(error.message);
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
  });

  after(() => server.close());

  beforeEach(async () => {
    hits = [];
    syncs = [];
    respond = () => null;
    clock = Date.parse('2026-11-20T12:00:00Z');
    anylist = new AnyList({ email: 'test', password: 'test', credentialsFile: '/nonexistent' });
    // Point anylist-js's HTTP clients (and their hooks) at the local server
    anylist.authClient = anylist.authClient.extend({ prefixUrl: base });
    anylist.client = anylist.client.extend({ prefixUrl: base });
    anylist.clientId = 'client-1';
    anylist.accessToken = 'token';
    anylist.uid = 'u1';

    client = new AnyListClient({ username: 'test', password: 'test', defaultListName: 'Groceries' });
    client._guard = new RequestGuard({ now: () => clock });
    client._guard.install(anylist);
    client.client = anylist;
    client.getTagData = async () => null;
    await client.connect();
  });

  it('downloads the account once for a burst of reads', async () => {
    await client.connect();
    await client.getItems();
    await client.getRecipes('chili');
    await client.getRecipeDetails({ id: 'r-chili' });
    await client.getRecipeIndex();
    await client.getMealPlanEvents();
    await client.getRecipeCollections();
    await client.connect();
    assert.equal(downloads(), 1);
  });

  it('downloads again once the snapshot is a minute old', async () => {
    clock += 61_000;
    await client.connect();
    assert.equal(downloads(), 2);
  });

  it('shares one download between overlapping reads', async () => {
    clock += 61_000;
    await Promise.all([client.connect(), client.getRecipes(), client.getMealPlanEvents()]);
    assert.equal(downloads(), 2);
  });

  it('downloads again after a write, but not after the write itself', async () => {
    await client.addItem('eggs');
    assert.deepEqual(hits.slice(1), ['/data/shopping-lists/update']);
    await client.connect();
    await client.getItems();
    assert.equal(downloads(), 2);
  });

  it('adds a recipe to the list with one download in total', async () => {
    const result = await client.addRecipeToList({ id: 'r-chili' });
    assert.equal(result.results[0].outcome, 'added');
    assert.deepEqual(hits, ['/data/user-data/get', '/data/shopping-lists/update']);
  });

  it('refetches before a write that depends on what it read, if the snapshot is not seconds old', async () => {
    clock += 30_000;
    await client.connect(); // still within the read window
    assert.equal(downloads(), 1);
    await client.addRecipeToList({ id: 'r-chili' });
    assert.equal(downloads(), 2);
  });

  it('backs off after a 429 and sends nothing until Retry-After has passed', async () => {
    clock += 61_000;
    respond = () => ({ status: 429, headers: { 'retry-after': '120' } });
    await assert.rejects(client.connect(), /429/);
    const sent = hits.length;

    await assert.rejects(client.connect(), /rate-limiting this account/);
    await assert.rejects(client.addItem('eggs'), /rate-limiting this account/);
    assert.equal(hits.length, sent, 'nothing sent during the cooldown');
    assert.match(client.requestSummary(), /Rate-limit cooldown/);

    respond = () => null;
    clock += 121_000;
    await client.connect();
    assert.equal(hits.length, sent + 1);
  });

  it('refuses a download over the limit without sending it', async () => {
    for (let i = 1; i < DOWNLOAD_LIMIT; i++) {
      clock += 1_000;
      anylist._userData = null; // force a fetch without the snapshot
      await client.connect();
    }
    assert.equal(downloads(), DOWNLOAD_LIMIT);
    anylist._userData = null;
    await assert.rejects(client.connect(), err => err.message.includes(`limit ${DOWNLOAD_LIMIT}`));
    assert.equal(downloads(), DOWNLOAD_LIMIT);

    clock += DOWNLOAD_WINDOW_MS;
    await client.connect();
    assert.equal(downloads(), DOWNLOAD_LIMIT + 1);
  });

  it('reports request counts without account contents', async () => {
    await client.addItem('eggs');
    const summary = client.requestSummary();
    assert.match(summary, /requests since start: 2\. Account syncs: 1 full, 0 changes only, 0 unchanged \(304\)/);
    assert.match(summary, /in the last 10 min: 1 of 20/);
    assert.doesNotMatch(summary, /milk|eggs|Chili/);
  });

  describe('conditional sync (#45)', () => {
    const pb = () => anylist.protobuf;
    const delta = fields => ({ status: 200, body: new (pb().PBUserDataResponse)(fields).toBuffer() });
    const nextSync = async () => { clock += 61_000; await client.connect(); };

    it('sends only client_info first, then the cursors of what it holds', async () => {
      assert.deepEqual(Object.keys(syncs[0]), ['client_info']);
      const info = pb().PBUserDataClientInfo.decode(syncs[0].client_info);
      assert.equal(info.mealPlanningCalendarClientInfo.supportedResponseVersion, 1);
      assert.equal(info.mealPlanningCalendarClientInfo.processedResponseVersion, 0);

      respond = url => (url === '/data/user-data/get' ? { status: 304 } : null);
      await nextSync();
      assert.deepEqual(Object.keys(syncs[1]).sort(), ['client_info', 'timestamps']);
      const ts = pb().PBUserDataClientTimestamps.decode(syncs[1].timestamps);
      assert.deepEqual(ts.shoppingListTimestamps.timestamps.map(t => t.identifier), [LIST_ID]);
      assert.equal(ts.userRecipeDataTimestamp.identifier, 'rd-1');
      assert.equal(ts.mealPlanningCalendarTimestamp.identifier, 'cal-1');
      assert.equal(ts.mealPlanningCalendarTimestamp.logicalTimestamp.toNumber(), 7);
      assert.equal(pb().PBUserDataClientInfo.decode(syncs[1].client_info).mealPlanningCalendarClientInfo.processedResponseVersion, 1);
    });

    it('keeps the snapshot on 304', async () => {
      respond = url => (url === '/data/user-data/get' ? { status: 304 } : null);
      await nextSync();
      assert.deepEqual((await client.getItems()).map(i => i.name), ['milk']);
      assert.equal((await client.getMealPlanEvents()).length, 1);
      assert.match(client.requestSummary(), /1 full, 0 changes only, 1 unchanged \(304\)/);
    });

    it('merges a delta: a modified list, a deleted recipe and a deleted event', async () => {
      respond = url => (url === '/data/user-data/get' ? delta({
        shoppingListsResponse: {
          modifiedLists: [{ identifier: LIST_ID, name: 'Groceries', timestamp: 2, items: [
            { identifier: 'item-milk', listId: LIST_ID, name: 'milk' },
            { identifier: 'item-eggs', listId: LIST_ID, name: 'eggs' },
          ] }],
          orderedIds: [LIST_ID],
        },
        recipeDataResponse: { recipeDataId: 'rd-1', timestamp: 3, allRecipesCollection: { identifier: 'all', recipeIds: [] } },
        mealPlanningCalendarResponse: { calendarId: 'cal-1', logicalTimestamp: 8, responseVersion: 1, deletedEventIds: ['e-1'] },
      }) : null);
      await nextSync();
      assert.deepEqual((await client.getItems()).map(i => i.name), ['milk', 'eggs']);
      assert.deepEqual(await client.getRecipes(), []);
      assert.equal((await client.getMealPlanEvents()).length, 0);
      assert.match(client.requestSummary(), /1 full, 1 changes only, 0 unchanged/);
    });

    it('syncs changes only after a write', async () => {
      respond = url => (url === '/data/user-data/get' && syncs.length > 1 ? { status: 304 } : null);
      await client.addItem('eggs');
      await client.connect();
      assert.equal(syncs.length, 2);
      assert.ok(syncs[1].timestamps, 'the sync after a write is conditional');
    });

    it('replaces a response it cannot merge with one full fetch', async () => {
      respond = (url, parts) => (url === '/data/user-data/get' && parts.timestamps ? { status: 200, body: 'not protobuf' } : null);
      await nextSync();
      assert.equal(syncs.length, 3);
      assert.ok(syncs[1].timestamps);
      assert.equal(syncs[2].timestamps, undefined, 'the recovery fetch sends no cursors');
      assert.deepEqual((await client.getItems()).map(i => i.name), ['milk']);
      assert.match(client.requestSummary(), /1 recoveries/);
    });

    it('fails rather than loop when the recovery fetch fails too', async () => {
      respond = url => (url === '/data/user-data/get' ? { status: 200, body: 'not protobuf' } : null);
      clock += 61_000;
      await assert.rejects(client.connect(), /undecodable/);
      assert.equal(syncs.length, 3);
    });
  });
});
