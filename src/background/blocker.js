/**
 * GetFocusd — declarativeNetRequest rule management.
 *
 * Builds and mutates the dynamic rules that enforce blocks at the network
 * layer (ARCHITECTURE.md §5). Storage is the source of truth; this module
 * only translates that truth into live rules and heals drift on start.
 *
 * @module background/blocker
 */

import { RULE_ID_SHORTS } from "../shared/constants.js";
import * as storage from "./storage.js";
import {
  isScheduleActiveNow,
  scheduleWindowEnd,
  nextMidnightTs,
} from "../shared/utils.js";

/**
 * Build the DNR rule for a timed block (ARCHITECTURE.md §5). The redirect
 * target carries display params in the query string; blocked.html parses
 * `location.search`. `extensionPath` with a query IS supported by DNR.
 *
 * @param {{id:number, domain:string, reason:string, expiresAt:number}} block
 * @returns {chrome.declarativeNetRequest.Rule} the rule object
 */
export function buildBlockRule(block) {
  return {
    id: block.id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath:
          `/src/blocked/blocked.html?t=block&d=${encodeURIComponent(block.domain)}` +
          `&until=${block.expiresAt}&r=${encodeURIComponent(block.reason)}`,
      },
    },
    condition: {
      requestDomains: [block.domain],
      resourceTypes: ["main_frame"],
    },
  };
}

/**
 * Build the DNR rule for an active schedule (ARCHITECTURE.md §5). Query
 * carries the schedule name and the timestamp at which the current window
 * ends so blocked.html can show a countdown.
 *
 * @param {{id:number, name:string, domains:string[]}} schedule
 * @param {number} windowEndMs epoch ms at which the active window ends
 * @returns {chrome.declarativeNetRequest.Rule} the rule object
 */
export function buildScheduleRule(schedule, windowEndMs) {
  return {
    id: schedule.id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath:
          `/src/blocked/blocked.html?t=schedule&name=${encodeURIComponent(schedule.name)}` +
          `&until=${windowEndMs}`,
      },
    },
    condition: {
      requestDomains: schedule.domains,
      resourceTypes: ["main_frame"],
    },
  };
}

/**
 * Build the DNR rule for a Pomodoro work phase (ARCHITECTURE.md §5, t=focus).
 * Blocks the whole Focus List in one rule; `until` is the phase end so
 * blocked.html can count down to the break.
 *
 * @param {{ruleId:number, endsAt:number}} session the live focus session
 * @param {string[]} focusList normalized domains blocked during work phases
 * @returns {chrome.declarativeNetRequest.Rule} the rule object
 */
export function buildFocusRule(session, focusList) {
  return {
    id: session.ruleId,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath: `/src/blocked/blocked.html?t=focus&until=${session.endsAt}`,
      },
    },
    condition: {
      requestDomains: focusList,
      resourceTypes: ["main_frame"],
    },
  };
}

/**
 * Build the DNR rule for an exhausted daily budget (ARCHITECTURE.md §5,
 * t=budget). `until` is the next local midnight so blocked.html can count
 * down to the reset; `limit` shows the user their configured daily minutes.
 *
 * @param {{id:number, domain:string, dailyMin:number}} budget
 * @returns {chrome.declarativeNetRequest.Rule} the rule object
 */
export function buildBudgetRule(budget) {
  return {
    id: budget.id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath:
          `/src/blocked/blocked.html?t=budget&d=${encodeURIComponent(budget.domain)}` +
          `&until=${nextMidnightTs()}&limit=${budget.dailyMin}`,
      },
    },
    condition: {
      requestDomains: [budget.domain],
      resourceTypes: ["main_frame"],
    },
  };
}

/**
 * Build the YouTube Shorts redirect rule (id RULE_ID_SHORTS, ARCHITECTURE.md §5).
 * @returns {chrome.declarativeNetRequest.Rule} the rule object
 */
export function buildShortsRule() {
  return {
    id: RULE_ID_SHORTS,
    priority: 1,
    action: { type: "redirect", redirect: { url: "https://www.youtube.com/" } },
    condition: {
      regexFilter: "^https?://([^/]+\\.)?youtube\\.com/shorts/",
      resourceTypes: ["main_frame"],
    },
  };
}

/**
 * Add (or replace) dynamic rules. Surfaces Chrome errors as rejected promises
 * so callers can roll back storage writes (e.g. ADD_BLOCK).
 *
 * @param {chrome.declarativeNetRequest.Rule[]} rules rules to add
 * @returns {Promise<void>}
 */
export async function addRules(rules) {
  if (!rules.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
}

/**
 * Remove dynamic rules by id. Unknown ids are ignored by Chrome, so this is
 * safe to call defensively.
 *
 * @param {number[]} ids rule ids to remove
 * @returns {Promise<void>}
 */
export async function removeRules(ids) {
  if (!ids.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
}

/**
 * Add or remove the Shorts rule according to the current setting.
 * @param {boolean} enabled whether the Shorts blocker is on
 * @returns {Promise<void>}
 */
export async function syncShortsRule(enabled) {
  if (enabled) {
    // removeRuleIds first so re-adding after a partial state never conflicts.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID_SHORTS],
      addRules: [buildShortsRule()],
    });
  } else {
    await removeRules([RULE_ID_SHORTS]);
  }
}

/**
 * Reconcile live dynamic rules with storage truth (ARCHITECTURE.md §5).
 *
 * Storage is the source of truth: every live rule must correspond to an
 * active block, an active schedule, a work-phase focus session, a
 * blocked-today budget, or the shorts setting — and every one of those must
 * have its rule live. Any drift (e.g. crash mid-operation, or a rule added
 * while the SW was dead) is healed here.
 *
 * @returns {Promise<void>}
 */
export async function reconcileRules() {
  const [liveRules, blocks, schedules, settings, focus, budgets] =
    await Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      storage.getBlocks(),
      storage.getSchedules(),
      storage.getSettings(),
      storage.getFocus(),
      storage.getBudgets(),
    ]);

  const now = new Date();
  const nowMs = now.getTime();
  /** @type {Map<number, chrome.declarativeNetRequest.Rule>} id -> desired rule */
  const desired = new Map();

  for (const block of Object.values(blocks)) {
    // An already-expired block is expiring on the imminent tick; don't (re)add
    // its rule. The tick will delete it from storage and count it completed.
    if (block.expiresAt > nowMs) {
      desired.set(block.id, buildBlockRule(block));
    }
  }
  // Only schedules flagged active by the scheduler may have a live rule; a
  // disabled schedule must never appear in the live ruleset.
  for (const schedule of Object.values(schedules)) {
    if (!schedule.enabled || !schedule.active) continue;
    const windowEndMs = isScheduleActiveNow(schedule, now)
      ? scheduleWindowEnd(schedule, now)
      : null;
    if (windowEndMs != null) {
      desired.set(schedule.id, buildScheduleRule(schedule, windowEndMs));
    }
  }
  // A live focus rule exists only during a work phase. If the phase already
  // ended while the SW was asleep, the imminent tick advances the phase, so
  // don't (re)add the stale rule here.
  const session = focus?.session;
  if (session && session.phase === "work" && session.endsAt > nowMs) {
    if (Array.isArray(focus.focusList) && focus.focusList.length) {
      desired.set(session.ruleId, buildFocusRule(session, focus.focusList));
    }
  }
  for (const budget of Object.values(budgets)) {
    if (budget.blockedToday) {
      desired.set(budget.id, buildBudgetRule(budget));
    }
  }
  if (settings.shortsBlocker) {
    desired.set(RULE_ID_SHORTS, buildShortsRule());
  }

  const liveIds = new Set(liveRules.map((r) => r.id));
  /** Orphans: live rules with no storage counterpart. */
  const toRemove = liveRules.filter((r) => !desired.has(r.id)).map((r) => r.id);
  /** Missing: storage entries whose rule is not live. */
  const toAdd = [...desired.values()].filter((r) => !liveIds.has(r.id));

  if (toRemove.length || toAdd.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: toRemove,
      addRules: toAdd,
    });
  }
}
