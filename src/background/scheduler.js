/**
 * GetFocusd — tick engine (ARCHITECTURE.md §7a).
 *
 * A single repeating 1-minute alarm (`getfocusd:tick`, ALARM_TICK) drives
 * `runTick()`, which also runs immediately on service-worker start. Each tick
 * expires due blocks, flips schedules in/out of their windows, catches up a
 * missed focus-phase transition, resets day-rolled budgets, and prunes old
 * stats.
 *
 * @module background/scheduler
 */

import { ALARM_TICK } from "../shared/constants.js";
import { isScheduleActiveNow, scheduleWindowEnd } from "../shared/utils.js";
import * as storage from "./storage.js";
import * as blocker from "./blocker.js";
import * as stats from "./stats.js";
import * as budgets from "./budgets.js";
import * as focus from "./focus.js";

/** Alarm cadence: Chrome clamps MV3 repeating alarms to >= 1 minute. */
const TICK_PERIOD_MINUTES = 1;

/**
 * Fire a "block complete" notification when the user has them enabled.
 * @param {{domain:string}} block the completed block
 * @returns {Promise<void>}
 */
async function notifyComplete(block) {
  await chrome.notifications.create(`block-complete:${block.id}`, {
    type: "basic",
    iconUrl: "assets/icons/icon128.png",
    title: "GetFocusd",
    message: `Block complete: ${block.domain}`,
  });
}

/**
 * Run one scheduler tick (ARCHITECTURE.md §7a):
 *  1. Expire due blocks — remove DNR rule, delete record, count completion,
 *     optionally notify.
 *  2. Evaluate each enabled schedule — add its rule on inactive→active,
 *     remove it on active→inactive. Disabled schedules never have a live rule.
 *  3. Focus fallback — if a session's phase already ended, advance it (the
 *     exact phase alarm is primary; this catches phases missed during sleep).
 *  4. Budgets — reset blocks that rolled over to a new day, prune usage.
 *  5. Prune stats.attempts and stats.timeSec entries older than 35 days.
 *
 * @returns {Promise<void>}
 */
export async function runTick() {
  const now = new Date();
  const nowMs = now.getTime();
  const [settings, blocks, schedules] = await Promise.all([
    storage.getSettings(),
    storage.getBlocks(),
    storage.getSchedules(),
  ]);

  // ---- 1. Expire due blocks ------------------------------------------------
  const expired = Object.values(blocks).filter((b) => b.expiresAt <= nowMs);
  if (expired.length) {
    const expiredIds = new Set(expired.map((b) => b.id));
    await blocker.removeRules(expired.map((b) => b.id));
    for (const id of expiredIds) delete blocks[id];
    await storage.saveBlocks(blocks);
    for (const block of expired) {
      await stats.recordCompletion(block);
      if (settings.notifications) {
        // Notification failures (e.g. permission flakiness) must not break the tick.
        await notifyComplete(block).catch(() => {});
      }
    }
  }

  // ---- 2. Evaluate schedules ----------------------------------------------
  let schedulesChanged = false;
  /** @type {chrome.declarativeNetRequest.Rule[]} */
  const rulesToAdd = [];
  /** @type {number[]} */
  const ruleIdsToRemove = [];

  for (const schedule of Object.values(schedules)) {
    // A disabled schedule must never have a live rule. Its `active` flag is
    // force-cleared at toggle time, so we only remove a stray rule if the
    // flag somehow stayed set.
    if (!schedule.enabled) {
      if (schedule.active) {
        schedule.active = false;
        schedulesChanged = true;
        ruleIdsToRemove.push(schedule.id);
      }
      continue;
    }

    const activeNow = isScheduleActiveNow(schedule, now);
    if (activeNow && !schedule.active) {
      // inactive -> active: bring the rule up for the rest of the window.
      const windowEndMs = scheduleWindowEnd(schedule, now);
      schedule.active = true;
      schedulesChanged = true;
      rulesToAdd.push(blocker.buildScheduleRule(schedule, windowEndMs));
      // Reload any open tabs on these domains so the block shows immediately.
      for (const domain of schedule.domains) {
        await blocker.reloadDomainTabs(domain).catch(() => {});
      }
    } else if (!activeNow && schedule.active) {
      // active -> inactive: window ended, take the rule down.
      schedule.active = false;
      schedulesChanged = true;
      ruleIdsToRemove.push(schedule.id);
    }
    // active->active / inactive->inactive: nothing to do.
  }

  if (ruleIdsToRemove.length) await blocker.removeRules(ruleIdsToRemove);
  if (rulesToAdd.length) await blocker.addRules(rulesToAdd);
  if (schedulesChanged) await storage.saveSchedules(schedules);

  // ---- 3. Focus phase fallback --------------------------------------------
  const focusState = await storage.getFocus();
  if (focusState.session && focusState.session.endsAt <= nowMs) {
    await focus.advancePhase();
  }

  // ---- 4. Budgets: day rollover + usage pruning ---------------------------
  await budgets.resetForNewDay();

  // ---- 5. Prune old stats --------------------------------------------------
  await stats.pruneOldStats(35);
}

/**
 * Create the repeating tick alarm if it does not exist yet. Called on install
 * and on every service-worker start (alarms persist, so this is usually a
 * no-op after first install).
 *
 * @returns {Promise<void>}
 */
export async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_TICK);
  if (!existing) {
    await chrome.alarms.create(ALARM_TICK, { periodInMinutes: TICK_PERIOD_MINUTES });
  }
}
