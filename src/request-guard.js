// Keeps this server's load on AnyList low (#44, #45). AnyList suspended the
// owner's account for heavy use: every read went through `data/user-data/get`,
// which downloaded the whole account (all lists, recipes and the meal plan),
// several times per tool call. The guard sits between anylist-js and the network:
//
// - Conditional sync (#45): after the first full fetch, `user-data/get` sends
//   the cursors of what we hold, the way AnyList's web client does, and gets
//   back 304 or only what changed (src/user-data-sync.js). A response that
//   can't be merged is replaced by one full fetch.
// - Snapshot: account reads reuse the last sync for up to READ_MAX_AGE_MS,
//   unless anything was written since. Overlapping reads share one sync.
// - Sync limit: at most DOWNLOAD_LIMIT account syncs per DOWNLOAD_WINDOW_MS.
// - Cooldown: after an HTTP 429, every request (login and token refresh too)
//   is refused locally until AnyList's Retry-After has passed. Nothing is
//   retried automatically.
// - Stats for health_check. They never include account contents or tokens.

import FormData from 'form-data';
import { SyncResponseError, createSyncState, mergeUserData, clientTimestamps, clientInfo, toUserDataResponse } from './user-data-sync.js';

export const READ_MAX_AGE_MS = 60_000;
// For reads whose result decides what gets written (e.g. merging onto an
// existing item, or cloning a stored event): only a snapshot this recent will do.
export const FRESH_MAX_AGE_MS = 5_000;
export const DOWNLOAD_LIMIT = 20;
export const DOWNLOAD_WINDOW_MS = 10 * 60_000;
// AnyList's restriction lasts about an hour when it gives no delay.
export const FALLBACK_COOLDOWN_MS = 60 * 60_000;

const USER_DATA_PATH = 'data/user-data/get';

export class AnyListBackoffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnyListBackoffError';
  }
}

/**
 * How long a 429 response asks us to wait, in ms: the longer of the
 * Retry-After header (seconds or an HTTP date) and a JSON body's
 * `retry_after` (seconds), or FALLBACK_COOLDOWN_MS if neither is usable.
 */
export function retryAfterMs({ headers = {}, body } = {}, now = Date.now()) {
  const delays = [];
  const header = headers['retry-after'];
  if (header != null && String(header).trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) delays.push(seconds * 1000);
    else {
      const at = Date.parse(header);
      if (!Number.isNaN(at)) delays.push(Math.max(0, at - now));
    }
  }
  try {
    const seconds = Number(JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body))?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) delays.push(seconds * 1000);
  } catch { /* not JSON */ }
  return delays.length > 0 ? Math.max(...delays) : FALLBACK_COOLDOWN_MS;
}

function untilText(at, now) {
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  const time = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `about ${minutes} min (until ${time})`;
}

function relativePath(url) {
  return String(url).replace(/^\/+/, '').split('?')[0];
}

/** One per AnyList account; survives re-logins, so a cooldown does too. */
export class RequestGuard {
  constructor({ now = Date.now } = {}) {
    this._now = now;
    this._cooldownUntil = 0;
    this._downloads = []; // start times within the window
    this.stats = { requests: 0, fullSyncs: 0, changedSyncs: 0, unchangedSyncs: 0, syncBytes: 0, recoveries: 0, snapshotReuses: 0, rateLimited: 0 };
    this._anylist = null;
  }

  /**
   * Route an anylist-js instance's requests and full-account reads through
   * this guard. Call before login(): List, Item and Recipe objects keep the
   * HTTP client they were built with.
   */
  install(anylist) {
    const hooks = { afterResponse: [response => this._afterResponse(response)] };
    anylist.authClient = this._gate(anylist.authClient.extend({ hooks }));
    anylist.client = this._gate(anylist.client.extend({ hooks }));

    this._anylist = anylist;
    this._state = createSyncState();
    this._fetchedAt = null;
    this._stale = false;
    this._inFlight = null;
    // anylist-js calls this with refreshCache=true from getLists(), getRecipes()
    // and getMealPlanningCalendarEvents(); false means any cached copy will do.
    anylist._getUserData = refreshCache => this.userData(refreshCache ? READ_MAX_AGE_MS : Infinity);
  }

  guards(anylist) {
    return this._anylist === anylist;
  }

  /** The full account data, synced only if no snapshot is recent enough. */
  async userData(maxAgeMs = READ_MAX_AGE_MS) {
    const snapshot = this._anylist._userData;
    if (this._inFlight) return this._inFlight;
    if (snapshot && (maxAgeMs === Infinity || (!this._stale && this._now() - this._fetchedAt <= maxAgeMs))) {
      this.stats.snapshotReuses++;
      return snapshot;
    }
    this._takeDownload();
    const startedAt = this._now();
    // A write while this is in flight sets _stale again, so the next read refetches.
    this._stale = false;
    this._inFlight = this._sync()
      .then(data => { this._fetchedAt = startedAt; return data; })
      .finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  /** Bring the sync state up to date and hand anylist-js a full-shaped response. */
  async _sync() {
    try {
      await this._syncOnce(this._state.loaded);
    } catch (error) {
      if (!(error instanceof SyncResponseError)) throw error;
      // The state may be half-merged: start over from one full fetch, once.
      const wasConditional = this._state.loaded;
      this._state = createSyncState();
      if (!wasConditional) throw error;
      console.error(`Rejected an AnyList sync response (${error.message}); fetching everything once`);
      this.stats.recoveries++;
      this._takeDownload();
      try {
        await this._syncOnce(false);
      } catch (retryError) {
        this._state = createSyncState();
        throw retryError;
      }
    }
    const anylist = this._anylist;
    anylist._userData = toUserDataResponse(this._state);
    anylist.calendarId = this._state.calendar?.calendarId ?? null;
    return anylist._userData;
  }

  async _syncOnce(conditional) {
    const anylist = this._anylist;
    const pb = anylist.protobuf;
    const form = new FormData();
    if (conditional) form.append('timestamps', clientTimestamps(this._state, pb, anylist.uid).toBuffer());
    form.append('client_info', clientInfo(this._state, pb).toBuffer());
    // A Buffer body (not a stream) can be resent by anylist-js's 401 retry
    const response = await anylist.client.post(USER_DATA_PATH, { body: form.getBuffer(), headers: form.getHeaders() });
    if (response.statusCode === 304) {
      if (!conditional) throw new SyncResponseError('304 without a snapshot');
      this.stats.unchangedSyncs++;
      return;
    }
    let decoded;
    try {
      decoded = pb.PBUserDataResponse.decode(response.body);
    } catch (error) {
      throw new SyncResponseError(`undecodable response: ${error.message}`);
    }
    if (conditional) this.stats.changedSyncs++;
    else this.stats.fullSyncs++;
    try {
      mergeUserData(this._state, decoded, pb);
    } catch (error) {
      throw error instanceof SyncResponseError ? error : new SyncResponseError(error.message);
    }
  }

  /** Throws instead of sending anything while AnyList has asked us to back off. */
  checkCooldown() {
    const now = this._now();
    if (now < this._cooldownUntil) {
      throw new AnyListBackoffError(`AnyList is rate-limiting this account, so no requests will be sent for ${untilText(this._cooldownUntil, now)}. Don't retry before then.`);
    }
  }

  summary() {
    const now = this._now();
    const recent = this._recentDownloads(now).length;
    const { requests, fullSyncs, changedSyncs, unchangedSyncs, recoveries, snapshotReuses, rateLimited } = this.stats;
    const mb = (this.stats.syncBytes / 1e6).toFixed(2);
    const lines = [
      `AnyList requests since start: ${requests}. Account syncs: ${fullSyncs} full, ${changedSyncs} changes only, ${unchangedSyncs} unchanged (304); ${mb} MB received; ${recoveries} recoveries. Snapshot reuses: ${snapshotReuses}. Rate-limited responses: ${rateLimited}.`,
      `Account syncs in the last ${DOWNLOAD_WINDOW_MS / 60_000} min: ${recent} of ${DOWNLOAD_LIMIT}.`,
    ];
    if (now < this._cooldownUntil) lines.push(`Rate-limit cooldown: ${untilText(this._cooldownUntil, now)}.`);
    return lines.join('\n');
  }

  _recentDownloads(now) {
    this._downloads = this._downloads.filter(t => now - t < DOWNLOAD_WINDOW_MS);
    return this._downloads;
  }

  _takeDownload() {
    this.checkCooldown();
    const now = this._now();
    const recent = this._recentDownloads(now);
    if (recent.length >= DOWNLOAD_LIMIT) {
      throw new AnyListBackoffError(`Paused AnyList syncs to avoid overloading AnyList: ${recent.length} account syncs in the last ${DOWNLOAD_WINDOW_MS / 60_000} min (limit ${DOWNLOAD_LIMIT}). Try again in ${untilText(recent[0] + DOWNLOAD_WINDOW_MS, now)}.`);
    }
    recent.push(now);
  }

  /** Wrap a got instance's post() (all anylist-js requests are POSTs). */
  _gate(instance) {
    const post = instance.post;
    instance.post = (url, options) => {
      this.checkCooldown();
      this.stats.requests++;
      const path = relativePath(url);
      // Any data/ request other than a sync may change the account: mark the
      // snapshot stale before sending, since even a failed request may have been applied.
      if (path !== USER_DATA_PATH && path.startsWith('data/')) this._stale = true;
      return post(url, options);
    };
    return instance;
  }

  _afterResponse(response) {
    if (response.statusCode === 429) {
      this.stats.rateLimited++;
      const until = this._now() + retryAfterMs(response, this._now());
      this._cooldownUntil = Math.max(this._cooldownUntil, until);
      console.error(`AnyList returned 429; backing off for ${untilText(this._cooldownUntil, this._now())}`);
    } else if (relativePath(response.request?.options?.url?.pathname ?? '') === USER_DATA_PATH) {
      this.stats.syncBytes += response.rawBody?.length ?? 0;
    }
    return response;
  }
}
