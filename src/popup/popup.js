/**
 * GetFocusd popup — quick actions UI.
 *
 * Lets the user block the current tab's domain with one click, shows a compact
 * Pomodoro focus control (start when idle; phase badge, live countdown, cycle
 * text and Stop when active), a compact live view of active blocks, a YouTube
 * Shorts toggle, and a link to the full dashboard. Talks to the service worker
 * only via chrome.runtime.sendMessage (types in shared/constants MSG — see
 * docs/ARCHITECTURE.md §6).
 *
 * @module popup/popup
 */

import { STORAGE_KEYS, MSG, DURATION_PRESETS, DEFAULT_FOCUS } from "../shared/constants.js";
import { normalizeDomain, formatMinutes, formatRemaining } from "../shared/utils.js";

/** Maximum number of blocks listed before the overflow line kicks in. */
const MAX_LISTED = 5;
/** Default duration chip selection (minutes). */
const DEFAULT_DURATION_MIN = 60;

/** @type {HTMLElement} */
const els = {
  toast: document.getElementById("toast"),
  quickBlock: document.getElementById("quick-block"),
  quickBlockUnavailable: document.getElementById("quick-block-unavailable"),
  currentDomain: document.getElementById("current-domain"),
  chips: document.getElementById("duration-chips"),
  reasonInput: document.getElementById("reason-input"),
  blockError: document.getElementById("block-error"),
  blockBtn: document.getElementById("block-btn"),
  focusIdle: document.getElementById("focus-idle"),
  focusActive: document.getElementById("focus-active"),
  focusStartBtn: document.getElementById("focus-start-btn"),
  focusPhaseBadge: document.getElementById("focus-phase-badge"),
  focusCountdown: document.getElementById("focus-countdown"),
  focusCycleText: document.getElementById("focus-cycle-text"),
  focusStopBtn: document.getElementById("focus-stop-btn"),
  focusStopHint: document.getElementById("focus-stop-hint"),
  focusHintLink: document.getElementById("focus-hint-link"),
  blockList: document.getElementById("block-list"),
  blockListEmpty: document.getElementById("block-list-empty"),
  blockListMore: document.getElementById("block-list-more"),
  shortsToggle: document.getElementById("shorts-toggle"),
  dashboardBtn: document.getElementById("dashboard-btn"),
};

/** Local UI state mirrored from the service worker. */
const state = {
  /** @type {string|null} normalized domain of the active tab, if blockable */
  domain: null,
  /** @type {number} selected duration in minutes */
  durationMin: DEFAULT_DURATION_MIN,
  /** @type {Array<{id:number, domain:string, reason:string, createdAt:number, expiresAt:number}>} */
  blocks: [],
  /** @type {{focusList:string[], workMin:number, breakMin:number, cycles:number,
   *         session: null | {phase:"work"|"break", cycle:number, totalCycles:number,
   *         startedAt:number, endsAt:number, ruleId:number}}} */
  focus: { ...DEFAULT_FOCUS, focusList: [...DEFAULT_FOCUS.focusList] },
  /** @type {boolean} */
  shortsBlocker: false,
};

/** Guard: don't clobber the checkbox while the user is flipping it. */
let suppressToggleSync = false;

let toastTimer = 0;
let tickTimer = 0;

/**
 * Resolve "auto" via prefers-color-scheme and set data-theme on <html>.
 * @param {string} [theme] "dark" | "light" | "auto" (default "dark")
 */
function applyTheme(theme) {
  const t = theme === "light" || theme === "auto" ? theme : "dark";
  const resolved =
    t === "auto"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : t;
  document.documentElement.dataset.theme = resolved;
}

/**
 * Send a message to the service worker and unwrap the {ok, ...} envelope.
 * @param {string} type one of constants.MSG
 * @param {object} [payload] extra message fields
 * @returns {Promise<object>} response data on ok
 * @throws {Error} with the SW-provided message on failure
 */
async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res || res.ok !== true) {
    throw new Error(res?.error || "Something went wrong. Try again.");
  }
  return res;
}

/**
 * Show a short-lived toast.
 * @param {string} text
 * @param {"info"|"error"} [kind="info"]
 */
function showToast(text, kind = "info") {
  window.clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.classList.toggle("toast-error", kind === "error");
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2600);
}

/**
 * Detect the active tab's normalized domain. Returns null for non-http(s)
 * pages (chrome://, about:, the Web Store, extension pages, …).
 * @returns {Promise<string|null>}
 */
async function detectCurrentDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Build the duration chips from DURATION_PRESETS, selecting the default.
 */
function renderChips() {
  els.chips.textContent = "";
  for (const preset of DURATION_PRESETS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("role", "radio");
    chip.textContent = formatMinutes(preset);
    chip.dataset.minutes = String(preset);
    const selected = preset === state.durationMin;
    chip.classList.toggle("selected", selected);
    chip.setAttribute("aria-checked", String(selected));
    chip.addEventListener("click", () => selectChip(preset));
    els.chips.appendChild(chip);
  }
}

/**
 * Mark one chip as selected and store its duration.
 * @param {number} minutes
 */
function selectChip(minutes) {
  state.durationMin = minutes;
  for (const chip of els.chips.querySelectorAll(".chip")) {
    const selected = Number(chip.dataset.minutes) === minutes;
    chip.classList.toggle("selected", selected);
    chip.setAttribute("aria-checked", String(selected));
  }
}

/**
 * Show or hide the quick-block card depending on whether the current tab
 * is blockable.
 */
function renderQuickBlockVisibility() {
  const blockable = state.domain !== null;
  els.quickBlock.hidden = !blockable;
  els.quickBlockUnavailable.hidden = blockable;
  if (blockable) {
    els.currentDomain.textContent = state.domain;
  } else {
    els.currentDomain.textContent = "";
  }
}

/**
 * Render the compact focus section: idle (start button using the configured
 * work minutes) or active (phase badge, countdown placeholder, cycle text,
 * Stop button). Countdown digits are updated every second by tick().
 */
function renderFocus() {
  const session = state.focus?.session ?? null;
  const workMin = state.focus?.workMin ?? DEFAULT_FOCUS.workMin;

  els.focusIdle.hidden = session !== null;
  els.focusActive.hidden = session === null;

  if (session === null) {
    els.focusStartBtn.textContent = `Start ${workMin} min focus`;
    els.focusStopHint.hidden = true;
    return;
  }

  const isWork = session.phase === "work";
  els.focusPhaseBadge.textContent = isWork ? "Focusing" : "Break";
  els.focusPhaseBadge.classList.toggle("break", !isWork);
  els.focusCycleText.textContent = `Cycle ${session.cycle}/${session.totalCycles}`;
  tickFocusCountdown();
}

/** Tick the focus phase countdown to session.endsAt. */
function tickFocusCountdown() {
  const session = state.focus?.session;
  if (!session) return;
  els.focusCountdown.textContent = formatRemaining(session.endsAt - Date.now());
}

/**
 * Start a Pomodoro session with the configured defaults.
 */
async function onFocusStart() {
  els.focusStartBtn.disabled = true;
  try {
    await send(MSG.START_FOCUS, {});
    showToast("Focus session started. Stay on it.");
    await refreshState();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    els.focusStartBtn.disabled = false;
  }
}

/**
 * Stop the current session. Work phases are sealed: the service worker
 * rejects without bypass, so show the dashboard hint instead of an error.
 */
async function onFocusStop() {
  els.focusStopBtn.disabled = true;
  try {
    await send(MSG.STOP_FOCUS, { bypass: false });
    els.focusStopHint.hidden = true;
    await refreshState();
  } catch {
    els.focusStopHint.hidden = false;
  } finally {
    els.focusStopBtn.disabled = false;
  }
}

/** Render the compact active-blocks list (up to MAX_LISTED + overflow line). */
function renderBlockList() {
  els.blockList.textContent = "";
  const blocks = sortedBlocks();
  const shown = blocks.slice(0, MAX_LISTED);
  const now = Date.now();

  for (const block of shown) {
    const li = document.createElement("li");
    li.className = "block-item";
    const domain = document.createElement("span");
    domain.className = "block-domain";
    domain.textContent = block.domain;
    const remaining = document.createElement("span");
    remaining.className = "block-remaining";
    remaining.textContent = formatRemaining(block.expiresAt - now);
    li.append(domain, remaining);
    els.blockList.appendChild(li);
  }

  const extra = blocks.length - shown.length;
  els.blockListMore.hidden = extra <= 0;
  if (extra > 0) {
    els.blockListMore.textContent = `…and ${extra} more`;
  }
  els.blockListEmpty.hidden = blocks.length > 0;
}

/**
 * Active blocks sorted by soonest expiry (list order).
 * @returns {Array<{id:number, domain:string, expiresAt:number}>}
 */
function sortedBlocks() {
  return [...state.blocks].sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Tick the remaining-time labels every second (blocks + focus phase). */
function tick() {
  const now = Date.now();
  const items = els.blockList.querySelectorAll(".block-remaining");
  sortedBlocks()
    .slice(0, MAX_LISTED)
    .forEach((block, i) => {
      if (items[i]) items[i].textContent = formatRemaining(block.expiresAt - now);
    });
  tickFocusCountdown();
}

/**
 * Pull fresh state from the service worker and re-render.
 */
async function refreshState() {
  try {
    const data = await send(MSG.GET_STATE);
    state.blocks = Object.values(data.blocks ?? {});
    if (data.focus) state.focus = data.focus;
    state.shortsBlocker = Boolean(data.settings?.shortsBlocker);
    applyTheme(data.settings?.theme);
    if (!suppressToggleSync) {
      els.shortsToggle.checked = state.shortsBlocker;
    }
    renderBlockList();
    renderFocus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

/**
 * Handle the "Block now" button: BLOCK_TAB → toast + refresh.
 */
async function onBlockNow() {
  if (!state.domain) return;
  setBlockError("");
  els.blockBtn.disabled = true;
  try {
    await send(MSG.BLOCK_TAB, {
      domain: state.domain,
      durationMin: state.durationMin,
      reason: els.reasonInput.value.trim(),
    });
    els.reasonInput.value = "";
    showToast(`Blocked ${state.domain} for ${formatMinutes(state.durationMin)}.`);
    await refreshState();
  } catch (err) {
    setBlockError(err.message);
  } finally {
    els.blockBtn.disabled = false;
  }
}

/**
 * Show (or clear) the inline quick-block error.
 * @param {string} message empty string hides the element
 */
function setBlockError(message) {
  els.blockError.textContent = message;
  els.blockError.hidden = message === "";
}

/**
 * Persist the Shorts toggle via UPDATE_SETTINGS.
 */
async function onShortsToggle() {
  const next = els.shortsToggle.checked;
  suppressToggleSync = true;
  try {
    await send(MSG.UPDATE_SETTINGS, { patch: { shortsBlocker: next } });
    state.shortsBlocker = next;
  } catch (err) {
    els.shortsToggle.checked = !next; // roll back
    showToast(err.message, "error");
  } finally {
    suppressToggleSync = false;
  }
}

/**
 * React to storage changes while the popup is open (block expiry, focus phase
 * changes, settings edits elsewhere) by re-pulling state.
 * @param {Record<string, chrome.storage.StorageChange>} changes
 * @param {string} area
 */
function onStorageChanged(changes, area) {
  if (area !== "local") return;
  // Flip live when the theme is edited elsewhere (options, another view).
  const themeChange = changes.settings?.newValue?.theme;
  if (typeof themeChange === "string") applyTheme(themeChange);
  const watched = [STORAGE_KEYS.BLOCKS, STORAGE_KEYS.SETTINGS, STORAGE_KEYS.FOCUS];
  if (watched.some((k) => k in changes)) {
    void refreshState();
  }
}

/** Wire events, detect the current tab, and load initial state. */
async function init() {
  // Apply the saved theme before first paint to avoid a theme flash.
  try {
    const { settings } = await chrome.storage.local.get("settings");
    applyTheme(settings?.theme);
  } catch { /* default dark */ }

  renderChips();
  state.domain = await detectCurrentDomain();
  renderQuickBlockVisibility();
  renderFocus();

  els.blockBtn.addEventListener("click", () => void onBlockNow());
  els.focusStartBtn.addEventListener("click", () => void onFocusStart());
  els.focusStopBtn.addEventListener("click", () => void onFocusStop());
  els.focusHintLink.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
  els.shortsToggle.addEventListener("change", () => void onShortsToggle());
  els.dashboardBtn.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
  chrome.storage.onChanged.addListener(onStorageChanged);

  tickTimer = window.setInterval(tick, 1000);
  await refreshState();
}

void init();
