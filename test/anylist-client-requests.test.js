/**
 * How many requests AnyListClient makes (#44). A real anylist-js instance
 * talks to a local HTTP server standing in for AnyList, so the request guard's
 * got hooks, the snapshot and the protobuf decoding all run for real.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import AnyList from '../anylist-js/lib/index.js';
import AnyListClient from '../src/anylist-client.js';
import { RequestGuard, DOWNLOAD_LIMIT, DOWNLOAD_WINDOW_MS } from '../src/request-guard.js';

const LIST_ID = '11111111111141118111111111111111';

describe('AnyListClient request volume', () => {
  let server;
  let base;
  let hits; // request paths, in order
  let respond; // (path) => { status, headers, body } | null for the default
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
        events: [{ identifier: 'e-1', calendarId: 'cal-1', date: '2099-01-01', title: 'zz-mcp-test', recipeId: 'r-chili' }],
        labels: [],
      },
    }).toBuffer();
  }

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push(req.url);
        const custom = respond(req.url);
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
    assert.match(summary, /requests since start: 2 \(full-account downloads: 1, /);
    assert.match(summary, /in the last 10 min: 1 of 20/);
    assert.doesNotMatch(summary, /milk|eggs|Chili/);
  });
});
