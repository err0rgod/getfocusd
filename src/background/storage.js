/**
 * GetFocusd — storage layer.
 *
 * Thin async wrappers around chrome.storage.local that enforce the
 * ARCHITECTURE.md §4 schema and lazy-initialize defaults. Storage is the
 * single source of truth for the whole extension; the live DNR ruleset is
 * reconciled against it on service-worker start (see blocker.reconcileRules).
 *
 * @module background/storage
 */

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_FOCUS,
  DEFAULT_DELAYS,
  RULE_ID_START,
} from "../shared/constants.js";

/** Default shape for the `stats` key (ARCHITECTURE.md §4, extended in v2). */
function defaultStats() {
  return {
    attempts: {},
    completedCount: 0,
    completedMinutes: 0,
    completedDays: {},
    earlyUnlocks: 0,
    timeSec: {},
    focusMinutesByDay: {},
    focusMinutesTotal: 0,
  };
}

/** Default shape for the `meta` key (ARCHITECTURE.md §4). */
function defaultMeta() {
  return { nextRuleId: RULE_ID_START };
}

/**
 * Read one top-level key, lazy-initializing it with `fallback` when absent.
 * Deep-clones the fallback so callers can never mutate the shared template.
 *
 * @param {string} key one of STORAGE_KEYS
 * @param {*} fallback value written when the key is missing
 * @returns {Promise<*>} the stored (or freshly initialized) value
 */
async function getKey(key, fallback) {
  const stored = await chrome.storage.local.get(key);
  if (stored[key] === undefined) {
    const value = structuredClone(fallback);
    await chrome.storage.local.set({ [key]: value });
    return value;
  }
  return stored[key];
}

/**
 * Read the settings object, creating it with DEFAULT_SETTINGS if missing.
 * @returns {Promise<typeof DEFAULT_SETTINGS>} settings (ARCHITECTURE.md §4)
 */
export async function getSettings() {
  return getKey(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
}

/**
 * Read the active-blocks map (key = String(ruleId)).
 * @returns {Promise<Object<string, {id:number, domain:string, reason:string, createdAt:number, expiresAt:number}>>}
 */
export async function getBlocks() {
  return getKey(STORAGE_KEYS.BLOCKS, {});
}

/**
 * Read the schedules map (key = String(ruleId)).
 * @returns {Promise<Object<string, {id:number, name:string, domains:string[], days:number[], startMin:number, endMin:number, enabled:boolean, active:boolean}>>}
 */
export async function getSchedules() {
  return getKey(STORAGE_KEYS.SCHEDULES, {});
}

/**
 * Read the focus (Pomodoro) config + live session, creating it with
 * DEFAULT_FOCUS if missing.
 * @returns {Promise<typeof DEFAULT_FOCUS>} focus object (ARCHITECTURE.md §4)
 */
export async function getFocus() {
  return getKey(STORAGE_KEYS.FOCUS, DEFAULT_FOCUS);
}

/**
 * Read the budgets map (key = String(ruleId)).
 * @returns {Promise<Object<string, {id:number, domain:string, dailyMin:number, usedSecByDay:Object<string, number>, blockedToday:boolean, createdAt:number}>>}
 */
export async function getBudgets() {
  return getKey(STORAGE_KEYS.BUDGETS, {});
}

/**
 * Read the mindful-pause delays config, creating it with DEFAULT_DELAYS if missing.
 * @returns {Promise<typeof DEFAULT_DELAYS>} delays object (ARCHITECTURE.md §4)
 */
export async function getDelays() {
  return getKey(STORAGE_KEYS.DELAYS, DEFAULT_DELAYS);
}

/**
 * Read the stats object, creating it with defaults if missing. Also back-fills
 * any sub-fields absent on a pre-v2 install (migration: v1 stats lacked
 * timeSec / focusMinutesByDay / focusMinutesTotal).
 * @returns {Promise<{attempts:Object<string, Object<string, number>>, completedCount:number, completedMinutes:number, completedDays:Object<string, number>, earlyUnlocks:number, timeSec:Object<string, Object<string, number>>, focusMinutesByDay:Object<string, number>, focusMinutesTotal:number}>}
 */
export async function getStats() {
  const stats = await getKey(STORAGE_KEYS.STATS, defaultStats());
  // Migrate older stored objects in-place so every consumer can assume the
  // full v2 shape. Persist only when something was actually missing.
  let changed = false;
  for (const [k, v] of Object.entries(defaultStats())) {
    if (stats[k] === undefined) {
      stats[k] = v;
      changed = true;
    }
  }
  if (changed) await saveStats(stats);
  return stats;
}

/**
 * Read the meta object (rule-id allocator state).
 * @returns {Promise<{nextRuleId:number}>}
 */
export async function getMeta() {
  return getKey(STORAGE_KEYS.META, defaultMeta());
}

/**
 * Persist the settings object.
 * @param {typeof DEFAULT_SETTINGS} settings full settings object
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/**
 * Persist the active-blocks map.
 * @param {Object<string, *>} blocks map keyed by String(ruleId)
 * @returns {Promise<void>}
 */
export async function saveBlocks(blocks) {
  await chrome.storage.local.set({ [STORAGE_KEYS.BLOCKS]: blocks });
}

/**
 * Persist the schedules map.
 * @param {Object<string, *>} schedules map keyed by String(ruleId)
 * @returns {Promise<void>}
 */
export async function saveSchedules(schedules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SCHEDULES]: schedules });
}

/**
 * Persist the focus (Pomodoro) config + session.
 * @param {typeof DEFAULT_FOCUS} focus full focus object
 * @returns {Promise<void>}
 */
export async function saveFocus(focus) {
  await chrome.storage.local.set({ [STORAGE_KEYS.FOCUS]: focus });
}

/**
 * Persist the budgets map.
 * @param {Object<string, *>} budgets map keyed by String(ruleId)
 * @returns {Promise<void>}
 */
export async function saveBudgets(budgets) {
  await chrome.storage.local.set({ [STORAGE_KEYS.BUDGETS]: budgets });
}

/**
 * Persist the mindful-pause delays config.
 * @param {typeof DEFAULT_DELAYS} delays delays object
 * @returns {Promise<void>}
 */
export async function saveDelays(delays) {
  await chrome.storage.local.set({ [STORAGE_KEYS.DELAYS]: delays });
}

/**
 * Persist the stats object.
 * @param {*} stats stats object (ARCHITECTURE.md §4)
 * @returns {Promise<void>}
 */
export async function saveStats(stats) {
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
}

/**
 * Allocate the next DNR rule id. Returns the current `nextRuleId` and
 * persists `nextRuleId + 1` in a single read+write round-trip.
 *
 * Note: the service worker is single-threaded per event, and all call sites
 * fully await this before touching storage again, so no interleaving can
 * double-allocate an id.
 *
 * @returns {Promise<number>} the allocated rule id (>= RULE_ID_START)
 */
export async function allocateRuleId() {
  const meta = await getMeta();
  const id = meta.nextRuleId;
  meta.nextRuleId = id + 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.META]: meta });
  return id;
}

/**
 * Fill any missing top-level keys with their defaults and migrate existing
 * installs to the v2 shape. Idempotent — safe to call on every install and
 * service-worker start. `getStats()` performs the stats sub-field migration.
 * @returns {Promise<void>}
 */
export async function ensureInitialized() {
  await getSettings();
  await getBlocks();
  await getSchedules();
  await getFocus();
  await getBudgets();
  await getDelays();
  await getStats();
  await getMeta();
}
