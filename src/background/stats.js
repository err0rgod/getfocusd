/**
 * GetFocusd — insights bookkeeping (ARCHITECTURE.md §4 stats schema).
 *
 * All functions mutate the persisted `stats` object via the storage layer.
 * The service worker is single-threaded per event and every call site awaits
 * the full read-modify-write before yielding to the next event, so no
 * interleaving can lose an update.
 *
 * @module background/stats
 */

import * as storage from "./storage.js";
import { dateKey } from "../shared/utils.js";

/**
 * In-memory debounce for attempt counting: a flurry of blocked-page reloads
 * (or the user hammering the blocked site) should count once per domain per
 * window, not once per request. Lost on SW restart — acceptable, since the
 * debounce only exists to dampen noise, not to guarantee exactness.
 * @type {Map<string, number>} domain -> last counted timestamp (ms)
 */
const lastAttemptTs = new Map();

/** Debounce window for RECORD_ATTEMPT: one count per domain per 30 s. */
const ATTEMPT_DEBOUNCE_MS = 30_000;

/** Upper bound for stored active-time seconds per domain per day (sanity cap). */
const MAX_DAY_SEC = 86400;

/**
 * Record a blocked-page load for a domain, debounced to at most one count per
 * domain per 30 s (in-memory). Increments stats.attempts[todayKey][domain].
 *
 * @param {string} domain normalized domain
 * @returns {Promise<number>} today's count for this domain after recording
 */
export async function recordAttempt(domain) {
  const now = Date.now();
  const last = lastAttemptTs.get(domain) ?? 0;
  const today = dateKey(now);

  const stats = await storage.getStats();
  const dayAttempts = stats.attempts[today] ?? (stats.attempts[today] = {});

  if (now - last >= ATTEMPT_DEBOUNCE_MS) {
    lastAttemptTs.set(domain, now);
    dayAttempts[domain] = (dayAttempts[domain] ?? 0) + 1;
    await storage.saveStats(stats);
  }
  return dayAttempts[domain] ?? 0;
}

/**
 * Record a block that reached expiry untouched (ARCHITECTURE.md §7a):
 * bump completedCount, add its whole planned duration to completedMinutes,
 * and mark today in completedDays (the streak source).
 *
 * @param {{createdAt:number, expiresAt:number}} block the completed block
 * @returns {Promise<void>}
 */
export async function recordCompletion(block) {
  const stats = await storage.getStats();
  stats.completedCount += 1;
  stats.completedMinutes += Math.round((block.expiresAt - block.createdAt) / 60000);
  const today = dateKey();
  stats.completedDays[today] = (stats.completedDays[today] ?? 0) + 1;
  await storage.saveStats(stats);
}

/**
 * Record a block/session/budget ended early via the unlock barrier.
 * @returns {Promise<void>}
 */
export async function recordEarlyUnlock() {
  const stats = await storage.getStats();
  stats.earlyUnlocks += 1;
  await storage.saveStats(stats);
}

/**
 * Record a completed Pomodoro work phase (ARCHITECTURE.md §7c): adds the
 * phase's minutes to today's focus tally and the all-time total. Called per
 * completed work phase so partial sessions still count.
 *
 * @param {number} minutes minutes in the completed work phase
 * @returns {Promise<void>}
 */
export async function recordWorkPhaseComplete(minutes) {
  const stats = await storage.getStats();
  const today = dateKey();
  stats.focusMinutesByDay[today] = (stats.focusMinutesByDay[today] ?? 0) + minutes;
  stats.focusMinutesTotal += minutes;
  await storage.saveStats(stats);
}

/**
 * Add active-viewing seconds for a domain today (ARCHITECTURE.md §7b).
 * Recorded for every domain (budget or not) to power insights. Stored value
 * is capped at MAX_DAY_SEC so a runaway heartbeat can't inflate the count.
 *
 * @param {string} domain normalized domain
 * @param {number} sec seconds of active viewing to add
 * @returns {Promise<number>} today's accumulated seconds for this domain
 */
export async function addTimeSec(domain, sec) {
  const stats = await storage.getStats();
  const today = dateKey();
  const dayMap = stats.timeSec[today] ?? (stats.timeSec[today] = {});
  const next = Math.min(MAX_DAY_SEC, (dayMap[domain] ?? 0) + Math.max(0, sec | 0));
  dayMap[domain] = next;
  await storage.saveStats(stats);
  return next;
}

/**
 * Drop attempt and time-tracking entries older than `keepDays` (default 35,
 * ARCHITECTURE.md §7a). Date keys are lexicographically sortable ("yyyyMmDd"),
 * so the cutoff is a plain string comparison.
 *
 * @param {number} [keepDays=35] number of recent days to keep
 * @returns {Promise<void>}
 */
export async function pruneOldStats(keepDays = 35) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffKey = dateKey(cutoff.getTime());

  const stats = await storage.getStats();
  let changed = false;
  for (const map of [stats.attempts, stats.timeSec]) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      if (key < cutoffKey) {
        delete map[key];
        changed = true;
      }
    }
  }
  if (changed) await storage.saveStats(stats);
}

// Back-compat alias: older call sites imported `pruneAttempts`. Kept so those
// imports keep working while pruning now covers timeSec too.
export { pruneOldStats as pruneAttempts };
