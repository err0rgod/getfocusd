/**
 * GetFocusd — service-worker entry point.
 *
 * Wires startup initialization, the repeating tick alarm, the one-shot focus
 * phase alarm, and the message API (ARCHITECTURE.md §6) that pages and content
 * scripts talk to. All heavy lifting lives in the sibling modules
 * (storage/blocker/stats/scheduler/focus/budgets); this file only routes
 * messages and sequences side effects.
 *
 * @module background/service-worker
 */

import {
  MSG,
  ALARM_TICK,
  ALARM_PHASE,
  QUOTES,
  UNLOCK_MODE,
  MAX_DURATION_MIN,
  FOCUS_LIMITS,
  DELAY_PRESETS,
} from "../shared/constants.js";
import {
  normalizeDomain,
  formatRemaining,
  looseEqual,
  sha256Hex,
} from "../shared/utils.js";
import * as storage from "./storage.js";
import * as blocker from "./blocker.js";
import * as stats from "./stats.js";
import * as scheduler from "./scheduler.js";
import * as focus from "./focus.js";
import * as budgets from "./budgets.js";

/** Concise, prefixed info log (no noisy logging elsewhere). */
function log(...args) {
  console.log("[GetFocusd]", ...args);
}

// ---------------------------------------------------------------------------
// Startup (ARCHITECTURE.md §7a): heal state, resume any live session, tick.
// ---------------------------------------------------------------------------
(async () => {
  try {
    await storage.ensureInitialized();
    await scheduler.ensureAlarm();
    await focus.resumeAfterRestart();
    await scheduler.runTick();
    await blocker.reconcileRules();
    log("service worker started");
  } catch (e) {
    console.error("[GetFocusd] startup failed:", e);
  }
})();

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    try {
      await storage.ensureInitialized();
      await scheduler.ensureAlarm();
      const settings = await storage.getSettings();
      await blocker.syncShortsRule(settings.shortsBlocker);
      log("installed/updated; initialized");
    } catch (e) {
      console.error("[GetFocusd] onInstalled failed:", e);
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === ALARM_TICK) {
    scheduler.runTick().catch((e) => console.error("[GetFocusd] tick failed:", e));
  } else if (alarm?.name === ALARM_PHASE) {
    focus.advancePhase().catch((e) => console.error("[GetFocusd] phase failed:", e));
  }
});

// ---------------------------------------------------------------------------
// Message handlers (ARCHITECTURE.md §6). Each returns the data half of the
// { ok:true, ...data } response envelope; route() throws on failure.
// ---------------------------------------------------------------------------

/** Clamp a duration to 1..MAX_DURATION_MIN whole minutes. */
function clampDurationMin(durationMin) {
  const n = Number(durationMin);
  if (!Number.isFinite(n)) return NaN; // caller treats NaN as invalid input
  return Math.min(MAX_DURATION_MIN, Math.max(1, Math.round(n)));
}

/** Shared implementation for ADD_BLOCK / BLOCK_TAB (ARCHITECTURE.md §6). */
async function addBlock(msg) {
  const domain = normalizeDomain(msg.domain);
  if (!domain) throw new Error("Invalid domain");

  const durationMin = clampDurationMin(msg.durationMin);
  if (!Number.isFinite(durationMin)) throw new Error("Invalid duration");

  const reason = typeof msg.reason === "string" ? msg.reason : "";

  const blocks = await storage.getBlocks();
  const nowMs = Date.now();
  const duplicate = Object.values(blocks).find(
    (b) => b.domain === domain && b.expiresAt > nowMs
  );
  if (duplicate) {
    throw new Error(
      `Already blocked until ${formatRemaining(duplicate.expiresAt - nowMs)} from now`
    );
  }

  const id = await storage.allocateRuleId();
  const block = {
    id,
    domain,
    reason,
    createdAt: nowMs,
    expiresAt: nowMs + durationMin * 60000,
  };

  blocks[String(id)] = block;
  await storage.saveBlocks(blocks);
  try {
    await blocker.addRules([blocker.buildBlockRule(block)]);
  } catch (e) {
    // Roll back storage so storage and live rules never diverge.
    const fresh = await storage.getBlocks();
    delete fresh[String(id)];
    await storage.saveBlocks(fresh);
    throw e;
  }
  return { block };
}

async function handleGetState() {
  const [settings, blocks, schedules, statsObj, focusState, budgetsObj, delays] =
    await Promise.all([
      storage.getSettings(),
      storage.getBlocks(),
      storage.getSchedules(),
      storage.getStats(),
      storage.getFocus(),
      storage.getBudgets(),
      storage.getDelays(),
    ]);
  return {
    settings,
    blocks,
    schedules,
    stats: statsObj,
    focus: focusState,
    budgets: budgetsObj,
    delays,
  };
}

async function handleRemoveBlock(msg) {
  const id = String(msg.id);
  const blocks = await storage.getBlocks();
  const block = blocks[id];
  if (!block) return {}; // already gone — removal is idempotent

  const nowMs = Date.now();
  const bypass = msg.bypass === true;
  if (nowMs < block.expiresAt && !bypass) {
    throw new Error("Block is sealed until it expires");
  }

  if (bypass && nowMs < block.expiresAt) {
    await stats.recordEarlyUnlock();
  }

  await blocker.removeRules([block.id]);
  delete blocks[id];
  await storage.saveBlocks(blocks);
  return {};
}

async function handleVerifyUnlock(msg) {
  const attempt = String(msg.attempt ?? "");
  if (msg.mode === UNLOCK_MODE.CHALLENGE) {
    // Accept if the attempt matches ANY quote (block page picks one at random,
    // so we can't know which was shown).
    const ok = QUOTES.some((q) => looseEqual(attempt, q.text));
    if (!ok) throw new Error("Challenge text does not match");
    return {};
  }
  if (msg.mode === UNLOCK_MODE.PASSWORD) {
    const settings = await storage.getSettings();
    if (settings.passwordHash == null) throw new Error("No password set");
    const hash = await sha256Hex(attempt);
    if (hash !== settings.passwordHash) throw new Error("Incorrect password");
    return {};
  }
  throw new Error("Unknown unlock mode");
}

function validateScheduleInput(msg) {
  const name = String(msg.name ?? "").trim();
  if (!name) throw new Error("Schedule name is required");

  const domains = [
    ...new Set(
      (Array.isArray(msg.domains) ? msg.domains : [])
        .map((d) => normalizeDomain(d))
        .filter((d) => d != null)
    ),
  ];
  if (!domains.length) throw new Error("At least one valid domain is required");

  const days = [...new Set(Array.isArray(msg.days) ? msg.days : [])]
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!days.length) throw new Error("At least one day is required");

  const startMin = Number(msg.startMin);
  const endMin = Number(msg.endMin);
  const inRange = (v) => Number.isInteger(v) && v >= 0 && v < 1440;
  if (!inRange(startMin) || !inRange(endMin)) {
    throw new Error("startMin/endMin must be integers in 0..1439");
  }
  if (startMin === endMin) {
    throw new Error("startMin and endMin must differ");
  }
  return { name, domains, days, startMin, endMin };
}

async function handleAddSchedule(msg) {
  const { name, domains, days, startMin, endMin } = validateScheduleInput(msg);
  const id = await storage.allocateRuleId();
  const schedule = {
    id,
    name,
    domains,
    days,
    startMin,
    endMin,
    enabled: true,
    active: false,
  };
  const schedules = await storage.getSchedules();
  schedules[String(id)] = schedule;
  await storage.saveSchedules(schedules);
  // Run a tick so an already-live window activates immediately.
  await scheduler.runTick();
  return { schedule };
}

async function handleRemoveSchedule(msg) {
  const id = String(msg.id);
  const schedules = await storage.getSchedules();
  const schedule = schedules[id];
  if (!schedule) return {}; // idempotent
  await blocker.removeRules([schedule.id]);
  delete schedules[id];
  await storage.saveSchedules(schedules);
  return {};
}

async function handleToggleSchedule(msg) {
  const id = String(msg.id);
  const enabled = msg.enabled === true;
  const schedules = await storage.getSchedules();
  const schedule = schedules[id];
  if (!schedule) throw new Error("Schedule not found");

  schedule.enabled = enabled;
  if (!enabled) {
    // Disabling: take the rule down now and clear the runtime flag.
    schedule.active = false;
    await blocker.removeRules([schedule.id]);
    await storage.saveSchedules(schedules);
  } else {
    // Enabling: persist, then tick so a live window activates immediately.
    await storage.saveSchedules(schedules);
    await scheduler.runTick();
  }
  return { schedule };
}

async function handleUpdateSettings(msg) {
  const patch = msg.patch && typeof msg.patch === "object" ? { ...msg.patch } : {};
  // passwordHash and unlockMode have dedicated, gated flows — never allow a
  // raw settings patch to weaken protection directly.
  delete patch.passwordHash;
  delete patch.unlockMode;

  const settings = await storage.getSettings();
  Object.assign(settings, patch);
  await storage.saveSettings(settings);

  if (Object.prototype.hasOwnProperty.call(patch, "shortsBlocker")) {
    await blocker.syncShortsRule(settings.shortsBlocker);
  }
  return { settings };
}

async function handleSetPassword(msg) {
  const password = String(msg.password ?? "");
  if (!password) throw new Error("Password must not be empty");
  const settings = await storage.getSettings();
  settings.passwordHash = await sha256Hex(password);
  await storage.saveSettings(settings);
  return {};
}

async function handleClearPassword() {
  const settings = await storage.getSettings();
  settings.passwordHash = null;
  await storage.saveSettings(settings);
  return {};
}

async function handleRecordAttempt(msg) {
  const domain = normalizeDomain(msg.domain);
  if (!domain) throw new Error("Invalid domain");
  const count = await stats.recordAttempt(domain);
  return { count };
}

// ---- Focus (Pomodoro) ------------------------------------------------------

async function handleStartFocus(msg) {
  const focusState = await storage.getFocus();
  if (focusState.session) throw new Error("A focus session is already running");
  const session = await focus.startFocus({
    workMin: msg.workMin,
    breakMin: msg.breakMin,
    cycles: msg.cycles,
  });
  return { session };
}

async function handleStopFocus(msg) {
  const focusState = await storage.getFocus();
  const session = focusState.session;
  if (!session) return {}; // nothing to stop — idempotent

  const bypass = msg.bypass === true;
  if (session.phase === "work" && !bypass) {
    throw new Error("Focus session is sealed during work phases");
  }
  if (session.phase === "work" && bypass) {
    await stats.recordEarlyUnlock();
  }
  await focus.stopFocus({ bypass });
  return {};
}

async function handleUpdateFocusConfig(msg) {
  const focusState = await storage.getFocus();
  if (focusState.session) {
    throw new Error("Cannot change focus config while a session is running");
  }

  if (msg.focusList !== undefined) {
    const list = [
      ...new Set(
        (Array.isArray(msg.focusList) ? msg.focusList : [])
          .map((d) => normalizeDomain(d))
          .filter((d) => d != null)
      ),
    ];
    focusState.focusList = list;
  }
  if (msg.workMin !== undefined) {
    const v = Math.round(Number(msg.workMin));
    if (!Number.isFinite(v) || v < FOCUS_LIMITS.MIN_WORK || v > FOCUS_LIMITS.MAX_WORK) {
      throw new Error(`Work minutes must be ${FOCUS_LIMITS.MIN_WORK}–${FOCUS_LIMITS.MAX_WORK}`);
    }
    focusState.workMin = v;
  }
  if (msg.breakMin !== undefined) {
    const v = Math.round(Number(msg.breakMin));
    if (!Number.isFinite(v) || v < FOCUS_LIMITS.MIN_BREAK || v > FOCUS_LIMITS.MAX_BREAK) {
      throw new Error(`Break minutes must be ${FOCUS_LIMITS.MIN_BREAK}–${FOCUS_LIMITS.MAX_BREAK}`);
    }
    focusState.breakMin = v;
  }
  if (msg.cycles !== undefined) {
    const v = Math.round(Number(msg.cycles));
    if (!Number.isFinite(v) || v < FOCUS_LIMITS.MIN_CYCLES || v > FOCUS_LIMITS.MAX_CYCLES) {
      throw new Error(`Cycles must be ${FOCUS_LIMITS.MIN_CYCLES}–${FOCUS_LIMITS.MAX_CYCLES}`);
    }
    focusState.cycles = v;
  }

  await storage.saveFocus(focusState);
  return { focus: focusState };
}

// ---- Budgets ---------------------------------------------------------------

async function handleAddBudget(msg) {
  const budget = await budgets.addBudget({
    domain: msg.domain,
    dailyMin: msg.dailyMin,
  });
  return { budget };
}

async function handleRemoveBudget(msg) {
  const id = String(msg.id);
  const budgetsObj = await storage.getBudgets();
  const budget = budgetsObj[id];
  if (!budget) return {}; // idempotent

  const bypass = msg.bypass === true;
  if (budget.blockedToday && !bypass) {
    throw new Error("Budget is locked for today");
  }
  if (budget.blockedToday && bypass) {
    await stats.recordEarlyUnlock();
  }
  await budgets.removeBudget({ id: budget.id });
  return {};
}

// ---- Delays ----------------------------------------------------------------

async function handleUpdateDelays(msg) {
  const delays = await storage.getDelays();

  if (msg.domains !== undefined) {
    delays.domains = [
      ...new Set(
        (Array.isArray(msg.domains) ? msg.domains : [])
          .map((d) => normalizeDomain(d))
          .filter((d) => d != null)
      ),
    ];
  }
  if (msg.seconds !== undefined) {
    const s = Number(msg.seconds);
    if (!DELAY_PRESETS.includes(s)) {
      throw new Error(`Seconds must be one of ${DELAY_PRESETS.join(", ")}`);
    }
    delays.seconds = s;
  }

  await storage.saveDelays(delays);
  return { delays };
}

// ---- Heartbeat -------------------------------------------------------------

async function handleHeartbeat(msg) {
  await budgets.handleHeartbeat({ domain: msg.domain, sec: msg.sec });
  return {};
}

/**
 * Route a message to its handler. Returns the data half of the response.
 * @param {{type:string}} msg the incoming message
 * @returns {Promise<Object>} response payload
 */
async function route(msg) {
  switch (msg?.type) {
    case MSG.GET_STATE:
      return handleGetState();
    case MSG.ADD_BLOCK:
    case MSG.BLOCK_TAB:
      return addBlock(msg);
    case MSG.REMOVE_BLOCK:
      return handleRemoveBlock(msg);
    case MSG.VERIFY_UNLOCK:
      return handleVerifyUnlock(msg);
    case MSG.ADD_SCHEDULE:
      return handleAddSchedule(msg);
    case MSG.REMOVE_SCHEDULE:
      return handleRemoveSchedule(msg);
    case MSG.TOGGLE_SCHEDULE:
      return handleToggleSchedule(msg);
    case MSG.UPDATE_SETTINGS:
      return handleUpdateSettings(msg);
    case MSG.SET_PASSWORD:
      return handleSetPassword(msg);
    case MSG.CLEAR_PASSWORD:
      return handleClearPassword();
    case MSG.RECORD_ATTEMPT:
      return handleRecordAttempt(msg);
    case MSG.START_FOCUS:
      return handleStartFocus(msg);
    case MSG.STOP_FOCUS:
      return handleStopFocus(msg);
    case MSG.UPDATE_FOCUS_CONFIG:
      return handleUpdateFocusConfig(msg);
    case MSG.ADD_BUDGET:
      return handleAddBudget(msg);
    case MSG.REMOVE_BUDGET:
      return handleRemoveBudget(msg);
    case MSG.UPDATE_DELAYS:
      return handleUpdateDelays(msg);
    case MSG.HEARTBEAT:
      return handleHeartbeat(msg);
    default:
      throw new Error(`Unknown message type: ${msg?.type}`);
  }
}

// Async message plumbing (ARCHITECTURE.md §6): always respond with the
// { ok, ... } envelope and return true so the channel stays open.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      sendResponse({ ok: true, ...(await route(msg)) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
