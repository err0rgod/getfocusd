/**
 * GetFocusd — daily time budgets (ARCHITECTURE.md §7b).
 *
 * guard.js heartbeats active viewing time; this module accumulates per-site
 * usage, trips a budget into a network-level block when its daily allowance is
 * exhausted, and resets blocks at day rollover (driven by the tick, §7a-4).
 *
 * @module background/budgets
 */

import { BUDGET_LIMITS } from "../shared/constants.js";
import { normalizeDomain, domainMatches, dateKey } from "../shared/utils.js";
import * as storage from "./storage.js";
import * as blocker from "./blocker.js";
import * as stats from "./stats.js";

/** Upper bound for stored usage seconds per budget per day (sanity cap). */
const MAX_DAY_SEC = 86400;

/** Days of per-budget usage history kept before pruning (ARCHITECTURE.md §7a). */
const USAGE_KEEP_DAYS = 35;

/**
 * Fire a notification when the user has them enabled. Failures are swallowed
 * so they never break budget enforcement.
 * @param {string} id unique notification id
 * @param {string} message body text
 * @returns {Promise<void>}
 */
async function notify(id, message) {
  const settings = await storage.getSettings();
  if (!settings.notifications) return;
  await chrome.notifications
    .create(id, {
      type: "basic",
      iconUrl: "assets/icons/icon128.png",
      title: "GetFocusd",
      message,
    })
    .catch(() => {});
}

/**
 * Reload every open http(s) tab on a budget's domain so the freshly-added DNR
 * rule shows the block page immediately. Tabs can vanish between query and
 * reload, so each reload is wrapped in try/catch.
 * @param {{domain:string}} budget
 * @returns {Promise<void>}
 */
async function reloadMatchingTabs(budget) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `*://*.${budget.domain}/*` });
  } catch {
    return; // tab query failure must not break blocking
  }
  for (const tab of tabs) {
    if (!tab?.id || !/^https?:/.test(tab.url ?? "")) continue;
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      // Tab navigated/closed meanwhile — ignore.
    }
  }
}

/**
 * Trip a budget into its blocked state: flag it, add the DNR rule, notify,
 * and reload matching tabs so the block page appears immediately.
 * @param {object} budget the budget being tripped
 * @returns {Promise<void>}
 */
async function tripBudget(budget) {
  budget.blockedToday = true;
  await blocker.addRules([blocker.buildBudgetRule(budget)]);
  await notify(
    `budget:${budget.id}`,
    `Time's up for ${budget.domain} — resets at midnight`
  );
  await reloadMatchingTabs(budget);
}

/**
 * Process a heartbeat from guard.js (ARCHITECTURE.md §7b): add the seconds to
 * today's per-site time (all domains, for insights) and to any matching
 * budget's usage. When usage crosses the daily allowance while not already
 * blocked, trip the budget.
 *
 * @param {{domain:string, sec:number}} payload heartbeat payload
 * @returns {Promise<void>}
 */
export async function handleHeartbeat({ domain, sec }) {
  const host = normalizeDomain(domain);
  const addSec = Math.max(0, Math.floor(Number(sec) || 0));
  if (!host || addSec <= 0) return;

  // Always record site time for insights, budget or not.
  await stats.addTimeSec(host, addSec);

  const today = dateKey();
  const budgets = await storage.getBudgets();
  const budget = Object.values(budgets).find((b) => domainMatches(host, b.domain));
  if (!budget) return;

  const dayMap = budget.usedSecByDay ?? (budget.usedSecByDay = {});
  const used = Math.min(MAX_DAY_SEC, (dayMap[today] ?? 0) + addSec);
  dayMap[today] = used;

  if (!budget.blockedToday && used >= budget.dailyMin * 60) {
    await tripBudget(budget);
  }
  await storage.saveBudgets(budgets);
}

/**
 * Reset budget blocks whose block belongs to a past day, and prune old usage
 * (ARCHITECTURE.md §7a-4). A `blockedToday` budget with no usage entry for
 * today was tripped on a previous day (a tripped budget always has that day's
 * usage recorded), so its block is stale: clear the flag and remove the rule.
 *
 * @returns {Promise<void>}
 */
export async function resetForNewDay() {
  const today = dateKey();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - USAGE_KEEP_DAYS);
  const cutoffKey = dateKey(cutoff.getTime());

  const budgets = await storage.getBudgets();
  /** @type {number[]} */
  const rulesToRemove = [];
  let changed = false;

  for (const budget of Object.values(budgets)) {
    // Stale block: flagged but no usage recorded for today => set on a past day.
    if (budget.blockedToday && !(budget.usedSecByDay?.[today] > 0)) {
      budget.blockedToday = false;
      rulesToRemove.push(budget.id);
      changed = true;
    }
    if (budget.usedSecByDay) {
      for (const key of Object.keys(budget.usedSecByDay)) {
        if (key < cutoffKey) {
          delete budget.usedSecByDay[key];
          changed = true;
        }
      }
    }
  }

  if (rulesToRemove.length) await blocker.removeRules(rulesToRemove);
  if (changed) await storage.saveBudgets(budgets);
}

/**
 * Add a daily budget for a domain (ARCHITECTURE.md §6 ADD_BUDGET). Validates
 * the domain and allowance, and enforces one budget per domain.
 *
 * @param {{domain:string, dailyMin:number}} payload
 * @returns {Promise<object>} the created budget
 * @throws {Error} on invalid input or a duplicate domain
 */
export async function addBudget({ domain, dailyMin }) {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error("Invalid domain");

  const minutes = Math.round(Number(dailyMin));
  if (
    !Number.isFinite(minutes) ||
    minutes < BUDGET_LIMITS.MIN ||
    minutes > BUDGET_LIMITS.MAX
  ) {
    throw new Error(
      `Daily minutes must be ${BUDGET_LIMITS.MIN}–${BUDGET_LIMITS.MAX}`
    );
  }

  const budgets = await storage.getBudgets();
  if (Object.values(budgets).some((b) => b.domain === normalized)) {
    throw new Error("A budget already exists for this domain");
  }

  const id = await storage.allocateRuleId();
  const budget = {
    id,
    domain: normalized,
    dailyMin: minutes,
    usedSecByDay: {},
    blockedToday: false,
    createdAt: Date.now(),
  };
  budgets[String(id)] = budget;
  await storage.saveBudgets(budgets);
  return budget;
}

/**
 * Remove a budget (ARCHITECTURE.md §6 REMOVE_BUDGET). Removes its live rule
 * when one is up. The caller (service worker) enforces the blocked-today
 * unlock barrier before delegating here.
 *
 * @param {{id:number|string}} payload
 * @returns {Promise<void>}
 */
export async function removeBudget({ id }) {
  const budgets = await storage.getBudgets();
  const budget = budgets[String(id)];
  if (!budget) return; // idempotent
  if (budget.blockedToday) {
    await blocker.removeRules([budget.id]);
  }
  delete budgets[String(id)];
  await storage.saveBudgets(budgets);
}
