/**
 * GetFocusd — Pomodoro focus state machine (ARCHITECTURE.md §7c).
 *
 * A session alternates work/break phases. During work phases the Focus List
 * is sealed-blocked by a DNR rule; breaks lift it. An exact one-shot alarm
 * (`getfocusd:phase`, ALARM_PHASE) marks each phase end; the scheduler tick is
 * the fallback if the alarm was missed (e.g. system sleep).
 *
 * @module background/focus
 */

import { ALARM_PHASE } from "../shared/constants.js";
import { dateKey } from "../shared/utils.js";
import * as storage from "./storage.js";
import * as blocker from "./blocker.js";
import * as stats from "./stats.js";

/**
 * Fire a notification when the user has them enabled. Notification failures
 * (permission flakiness) must not break the state machine.
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
 * Arm the exact one-shot phase alarm for the live session's `endsAt`.
 * @param {{endsAt:number}} session live session
 * @returns {Promise<void>}
 */
export async function armPhaseAlarm(session) {
  await clearPhaseAlarm();
  await chrome.alarms.create(ALARM_PHASE, { when: session.endsAt });
}

/**
 * Cancel the phase alarm (no-op if none is armed).
 * @returns {Promise<void>}
 */
export async function clearPhaseAlarm() {
  await chrome.alarms.clear(ALARM_PHASE);
}

/**
 * Add the work-phase DNR rule for a session and arm its alarm. Used when a
 * work phase begins (start / break→work).
 * @param {object} focus focus object (already containing the session)
 * @returns {Promise<void>}
 */
async function activateWorkPhase(focus) {
  const session = focus.session;
  if (Array.isArray(focus.focusList) && focus.focusList.length) {
    await blocker.addRules([blocker.buildFocusRule(session, focus.focusList)]);
    // Reload any already-open focus-list tabs so the block page shows now.
    for (const domain of focus.focusList) {
      await blocker.reloadDomainTabs(domain);
    }
  }
  await armPhaseAlarm(session);
}

/**
 * Start a new focus session (ARCHITECTURE.md §7c). Merges any overrides into
 * the stored config, creates a work-phase session, blocks the Focus List, and
 * arms the phase alarm.
 *
 * @param {{workMin?:number, breakMin?:number, cycles?:number}} [cfg] overrides
 * @returns {Promise<object>} the created session
 * @throws {Error} when a session is already active
 */
export async function startFocus(cfg = {}) {
  const focus = await storage.getFocus();
  if (focus.session) throw new Error("A focus session is already running");

  // Merge overrides into config (validated upstream against FOCUS_LIMITS).
  for (const k of ["workMin", "breakMin", "cycles"]) {
    if (cfg[k] != null && Number.isFinite(Number(cfg[k]))) focus[k] = Number(cfg[k]);
  }

  const nowMs = Date.now();
  const session = {
    phase: "work",
    cycle: 1,
    totalCycles: focus.cycles,
    startedAt: nowMs,
    endsAt: nowMs + focus.workMin * 60000,
    ruleId: await storage.allocateRuleId(),
  };
  focus.session = session;
  await storage.saveFocus(focus);
  await activateWorkPhase(focus);
  return session;
}

/**
 * Advance to the next phase (ARCHITECTURE.md §7c).
 *
 * work→break: record the work minutes, remove the rule; if this was the last
 * cycle, end the session instead. break→work: next cycle, re-block.
 * Re-arms the phase alarm for the new phase. Idempotent-ish: a no-op when no
 * session is live, and it only advances when the current phase has actually
 * ended (callers are the phase alarm and the tick fallback).
 *
 * @returns {Promise<object|null>} the session after advancing (null if ended)
 */
export async function advancePhase() {
  const focus = await storage.getFocus();
  const session = focus.session;
  if (!session) return null;

  const nowMs = Date.now();
  // Guard against a premature alarm/stray tick: only advance a finished phase.
  if (session.endsAt > nowMs) {
    await armPhaseAlarm(session); // re-arm defensively
    return session;
  }

  if (session.phase === "work") {
    // Count each completed work phase so partial sessions still get credit.
    await stats.recordWorkPhaseComplete(focus.workMin);
    await blocker.removeRules([session.ruleId]);

    if (session.cycle >= session.totalCycles) {
      // Session complete: last work phase done, no trailing break.
      const totalWorkMin = session.totalCycles * focus.workMin;
      focus.session = null;
      await storage.saveFocus(focus);
      await clearPhaseAlarm();
      await notify(
        "focus:done",
        `All ${session.totalCycles} focus cycles complete — ${totalWorkMin} minutes focused`
      );
      return null;
    }

    // work -> break
    session.phase = "break";
    session.startedAt = nowMs;
    session.endsAt = nowMs + focus.breakMin * 60000;
    await storage.saveFocus(focus);
    await armPhaseAlarm(session);
    await notify("focus:break", `Focus complete — break time (${focus.breakMin} min)`);
    return session;
  }

  // break -> work (next cycle)
  session.phase = "work";
  session.cycle += 1;
  session.startedAt = nowMs;
  session.endsAt = nowMs + focus.workMin * 60000;
  await storage.saveFocus(focus);
  await activateWorkPhase(focus);
  await notify(
    "focus:work",
    `Back to focus — cycle ${session.cycle} of ${session.totalCycles}`
  );
  return session;
}

/**
 * Stop the live session (ARCHITECTURE.md §7c): remove the work-phase rule if
 * live, clear the session, cancel the phase alarm. The caller (service worker)
 * enforces the work-phase unlock barrier; this function just tears down.
 *
 * @param {{bypass?:boolean}} [_opts] accepted for signature symmetry; barrier
 *   enforcement lives in the service-worker route.
 * @returns {Promise<void>}
 */
export async function stopFocus(_opts = {}) {
  const focus = await storage.getFocus();
  const session = focus.session;
  if (!session) {
    await clearPhaseAlarm();
    return;
  }
  if (session.phase === "work") {
    await blocker.removeRules([session.ruleId]);
  }
  focus.session = null;
  await storage.saveFocus(focus);
  await clearPhaseAlarm();
}

/**
 * Re-arm the phase alarm for a live session after a service-worker restart
 * (ARCHITECTURE.md §7c). Alarms can be lost when the SW is killed; the tick is
 * the fallback, but re-arming here keeps phase transitions snappy. If the phase
 * already ended while the SW was down, advance immediately instead.
 *
 * @returns {Promise<void>}
 */
export async function resumeAfterRestart() {
  const focus = await storage.getFocus();
  const session = focus.session;
  if (!session) return;
  if (session.endsAt <= Date.now()) {
    // Phase ended while we were asleep — catch up now.
    await advancePhase();
    return;
  }
  await armPhaseAlarm(session);
}
