/**
 * GetFocusd — options dashboard.
 *
 * Full management UI: Blocks, Focus, Limits, Schedules, Insights, Settings.
 * All state comes from the service worker via chrome.runtime.sendMessage (see
 * docs/ARCHITECTURE.md §6); the page never touches chrome.storage directly —
 * it only LISTENS to storage.onChanged so it knows when to re-pull state.
 *
 * Rendering rules: DOM APIs + textContent only (no innerHTML with user data),
 * addEventListener only (no inline handlers — MV3 CSP-safe).
 *
 * @module options/options
 */

import {
  MSG,
  DURATION_PRESETS,
  PRESET_DOMAINS,
  QUOTES,
  DAY_LABELS,
  UNLOCK_MODE,
  MAX_DURATION_MIN,
  DEFAULT_FOCUS,
  FOCUS_LIMITS,
  BUDGET_LIMITS,
  DELAY_PRESETS,
} from "../shared/constants.js";

import {
  normalizeDomain,
  formatRemaining,
  formatMinutes,
  dateKey,
  looseEqual,
  pickRandom,
  computeStreak,
  lastNDays,
} from "../shared/utils.js";

/* ------------------------------------------------------------------ *
 *  Tiny DOM helper — text-only element factory (no innerHTML).
 * ------------------------------------------------------------------ */

/**
 * Create an element with a text child and optional attributes/listeners.
 * Using textContent exclusively keeps user data out of HTML parsing.
 *
 * @param {string} tag element tag name
 * @param {{className?:string, text?:string, attrs?:Object<string,string>, on?:Object<string,EventListener>, children?:Node[]}} [opts]
 * @returns {HTMLElement}
 */
function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  if (opts.on) {
    for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
  }
  if (opts.children) node.append(...opts.children);
  return node;
}

/** Shorthand: get element by id.
 * @param {string} id
 * @returns {HTMLElement} */
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 *  Messaging + toasts
 * ------------------------------------------------------------------ */

/**
 * Send a message to the service worker and unwrap the {ok, ...} envelope.
 * @param {string} type one of MSG.*
 * @param {Object} [payload={}]
 * @returns {Promise<Object>} response data (ok:true already stripped of `ok`)
 * @throws {Error} with the SW's error string when ok === false
 */
async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || "Something went wrong. Please try again.");
  }
  return res;
}

let toastTimer = 0;

/**
 * Show a transient toast notification (auto-hides after 3 s).
 * @param {string} message
 * @param {"success"|"error"|""} [kind=""]
 */
function showToast(message, kind = "") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast${kind ? ` ${kind}` : ""}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

/** Render an error from a caught send() rejection.
 * @param {unknown} err
 * @returns {string} human message */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ *
 *  Page state
 * ------------------------------------------------------------------ */

/**
 * Last full state snapshot from GET_STATE. Null until the first load.
 * @type {{settings:Object, blocks:Object, schedules:Object, stats:Object, focus:Object, budgets:Object, delays:Object}|null}
 */
let state = null;

/** Selected duration (minutes) in the add-block form. */
let selectedDurationMin = DURATION_PRESETS[1]; // sensible default: 30

/* ------------------------------------------------------------------ *
 *  Theme
 * ------------------------------------------------------------------ */

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

/** Whether the "Custom…" duration row is visible. */
let customDurationOpen = false;

/** Selected days (0–6) in the add-schedule form. */
const selectedDays = new Set();

/** The tab currently shown — preserved across re-renders. */
let currentTab = "blocks";

/** Local copy of the focus list being edited (chips). */
let focusListEdit = [];

/** Local copy of the delays domains being edited (chips). */
let delaysDomainsEdit = [];

/** Currently selected delay seconds (from DELAY_PRESETS). */
let selectedDelaySeconds = DELAY_PRESETS[1]; // default 15

/* ------------------------------------------------------------------ *
 *  Tabs
 * ------------------------------------------------------------------ */

const TAB_IDS = ["blocks", "focus", "limits", "schedules", "insights", "settings"];

/** Switch the visible tab and update ARIA state.
 * @param {string} tab one of TAB_IDS */
function switchTab(tab) {
  currentTab = tab;
  for (const id of TAB_IDS) {
    const btn = $(`tab-btn-${id}`);
    const panel = $(`tab-${id}`);
    const active = id === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  }
}

/** Wire tab buttons once at startup. */
function initTabs() {
  for (const id of TAB_IDS) {
    $(`tab-btn-${id}`).addEventListener("click", () => switchTab(id));
  }
}

/* ------------------------------------------------------------------ *
 *  Protection check — used before any "weakening" action.
 * ------------------------------------------------------------------ */

/**
 * True when at least one protection source exists: an unexpired timed block,
 * an active schedule, a focus session in a work phase, or a budget blocked
 * today. Expired-but-unswept blocks do NOT count (they'll be swept next tick).
 * @returns {boolean}
 */
function protectionIsActive() {
  if (!state) return false;
  const now = Date.now();
  const anyBlock = Object.values(state.blocks).some((b) => b.expiresAt > now);
  const anySchedule = Object.values(state.schedules).some((s) => s.active === true);
  const focusWorkActive = state.focus?.session?.phase === "work";
  const anyBudgetBlocked = Object.values(state.budgets ?? {}).some((b) => b.blockedToday === true);
  return anyBlock || anySchedule || focusWorkActive || anyBudgetBlocked;
}

/* ------------------------------------------------------------------ *
 *  Unlock modal (shared component)
 * ------------------------------------------------------------------ */

const modal = {
  overlay: null,
  challengeView: null,
  passwordView: null,
  quoteText: null,
  quoteAuthor: null,
  challengeInput: null,
  passwordInput: null,
  errorEl: null,
  cancelBtn: null,
  submitBtn: null,
  /** @type {null | {quote:string, resolve:(ok:boolean)=>void}} */
  session: null,
  /** Element that had focus before the modal opened, restored on close. */
  previouslyFocused: null,
};

/** Cache modal element refs once. */
function initModalRefs() {
  modal.overlay = $("unlock-modal");
  modal.challengeView = $("unlock-challenge-view");
  modal.passwordView = $("unlock-password-view");
  modal.quoteText = $("unlock-quote-text");
  modal.quoteAuthor = $("unlock-quote-author");
  modal.challengeInput = $("unlock-challenge-input");
  modal.passwordInput = $("unlock-password-input");
  modal.errorEl = $("unlock-error");
  modal.cancelBtn = $("unlock-cancel");
  modal.submitBtn = $("unlock-submit");

  modal.cancelBtn.addEventListener("click", () => settleUnlock(false));
  modal.submitBtn.addEventListener("click", () => {
    attemptUnlock().catch(() => settleUnlock(false));
  });

  // Enter key submits from either input.
  for (const input of [modal.challengeInput, modal.passwordInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        attemptUnlock().catch(() => settleUnlock(false));
      }
    });
  }

  // Escape cancels (friction barrier is opt-out-able only by closing).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.overlay.hidden) {
      e.preventDefault();
      settleUnlock(false);
    }
  });

  // Focus trap: keep Tab cycling inside the modal while it's open.
  modal.overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusables = getModalFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

/**
 * Elements that can receive focus inside the modal (visible only).
 * @returns {HTMLElement[]}
 */
function getModalFocusables() {
  return [...modal.overlay.querySelectorAll("input, button")].filter(
    (n) => !n.disabled && n.offsetParent !== null
  );
}

/**
 * Open the unlock modal and return a Promise that resolves with the outcome.
 * The barrier type is read live from the current settings snapshot.
 *
 * challenge → verify LOCALLY via looseEqual against a random QUOTES entry.
 * password  → verify via MSG.VERIFY_UNLOCK against the stored hash.
 *
 * @returns {Promise<boolean>} true when the user passed the barrier
 */
export function openUnlockModal() {
  return new Promise((resolve) => {
    const mode = state?.settings?.unlockMode ?? UNLOCK_MODE.CHALLENGE;
    modal.session = { quote: "", resolve };
    modal.previouslyFocused = document.activeElement;

    // Reset UI.
    modal.errorEl.hidden = true;
    modal.errorEl.textContent = "";
    modal.challengeInput.value = "";
    modal.passwordInput.value = "";

    if (mode === UNLOCK_MODE.PASSWORD) {
      modal.session.quote = "";
      modal.challengeView.hidden = true;
      modal.passwordView.hidden = false;
    } else {
      const q = pickRandom(QUOTES);
      modal.session.quote = q.text;
      modal.quoteText.textContent = `"${q.text}"`;
      modal.quoteAuthor.textContent = `— ${q.author}`;
      modal.challengeView.hidden = false;
      modal.passwordView.hidden = true;
    }

    modal.overlay.hidden = false;
    // Focus the primary input so keyboard users land in the right place.
    const target = mode === UNLOCK_MODE.PASSWORD ? modal.passwordInput : modal.challengeInput;
    // Defer so the browser paints the overlay first (offsetParent trick for trap).
    setTimeout(() => target.focus(), 0);
  });
}

/** Show a modal error message.
 * @param {string} msg */
function showUnlockError(msg) {
  modal.errorEl.textContent = msg;
  modal.errorEl.hidden = false;
}

/**
 * Validate the current input against the active barrier.
 * Challenge: local compare only — the quote never leaves this page.
 * Password: ask the SW to hash+compare.
 */
async function attemptUnlock() {
  if (!modal.session) return;
  const mode = state?.settings?.unlockMode ?? UNLOCK_MODE.CHALLENGE;

  if (mode === UNLOCK_MODE.PASSWORD) {
    const attempt = modal.passwordInput.value;
    if (!attempt) {
      showUnlockError("Please enter the password.");
      return;
    }
    try {
      await send(MSG.VERIFY_UNLOCK, { mode: UNLOCK_MODE.PASSWORD, attempt });
      settleUnlock(true);
    } catch (err) {
      showUnlockError(errMsg(err) || "Incorrect password. Try again.");
      modal.passwordInput.select();
    }
    return;
  }

  // Challenge mode — pure client-side compare.
  const typed = modal.challengeInput.value;
  if (looseEqual(typed, modal.session.quote)) {
    settleUnlock(true);
  } else {
    showUnlockError("That doesn't match the quote exactly. Try again.");
    modal.challengeInput.select();
  }
}

/**
 * Close the modal and resolve the pending promise.
 * @param {boolean} ok
 */
function settleUnlock(ok) {
  if (!modal.session) return;
  const { resolve } = modal.session;
  modal.session = null;
  modal.overlay.hidden = true;
  // Restore focus to whatever the user was doing before the modal opened.
  if (modal.previouslyFocused && typeof modal.previouslyFocused.focus === "function") {
    modal.previouslyFocused.focus();
  }
  resolve(ok);
}

/* ------------------------------------------------------------------ *
 *  Field-error helpers
 * ------------------------------------------------------------------ */

/** Show an inline field error.
 * @param {string} id error element id
 * @param {string} msg */
function showFieldError(id, msg) {
  const n = $(id);
  n.textContent = msg;
  n.hidden = false;
}

/** Hide an inline field error.
 * @param {string} id */
function hideFieldError(id) {
  const n = $(id);
  n.textContent = "";
  n.hidden = true;
}

/* ------------------------------------------------------------------ *
 *  BLOCKS TAB — add form
 * ------------------------------------------------------------------ */

/** Build the duration chip row from DURATION_PRESETS + a "Custom…" chip. */
function renderDurationChips() {
  const row = $("duration-chips");
  row.replaceChildren();
  for (const mins of DURATION_PRESETS) {
    row.append(
      el("button", {
        className: `chip${!customDurationOpen && selectedDurationMin === mins ? " selected" : ""}`,
        text: formatMinutes(mins),
        attrs: { type: "button" },
        on: {
          click: () => {
            customDurationOpen = false;
            selectedDurationMin = mins;
            $("custom-duration-row").hidden = true;
            hideFieldError("block-duration-error");
            renderDurationChips();
          },
        },
      })
    );
  }
  row.append(
    el("button", {
      className: `chip${customDurationOpen ? " selected" : ""}`,
      text: "Custom…",
      attrs: { type: "button" },
      on: {
        click: () => {
          customDurationOpen = true;
          $("custom-duration-row").hidden = false;
          hideFieldError("block-duration-error");
          renderDurationChips();
          $("custom-duration").focus();
        },
      },
    })
  );
}

/**
 * Read the effective duration from the form.
 * @returns {number|null} minutes, or null when invalid
 */
function readDuration() {
  if (!customDurationOpen) return selectedDurationMin;
  const raw = Number($("custom-duration").value);
  if (!Number.isFinite(raw) || raw < 1) return null;
  return Math.min(Math.max(Math.round(raw), 1), MAX_DURATION_MIN);
}

/** Wire the add-block form submit. */
function initAddBlockForm() {
  $("add-block-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideFieldError("block-domain-error");
    hideFieldError("block-duration-error");

    const domainInput = $("block-domain");
    const domain = normalizeDomain(domainInput.value);
    if (!domain) {
      showFieldError("block-domain-error", "That doesn't look like a valid website — try something like example.com.");
      domainInput.focus();
      return;
    }

    const durationMin = readDuration();
    if (durationMin === null) {
      showFieldError("block-duration-error", `Enter a custom duration between 1 and ${MAX_DURATION_MIN} minutes.`);
      $("custom-duration").focus();
      return;
    }

    const reason = $("block-reason").value.trim();

    try {
      await send(MSG.ADD_BLOCK, { domain, durationMin, reason });
      showToast(`Blocked ${domain} for ${formatMinutes(durationMin)}.`, "success");
      domainInput.value = "";
      $("block-reason").value = "";
      $("custom-duration").value = "";
      // State will refresh via storage.onChanged → refreshState().
    } catch (err) {
      showFieldError("block-domain-error", errMsg(err));
    }
  });
}

/** Render the preset domain groups (one-click → prefill the add form). */
function renderPresets() {
  const wrap = $("preset-groups");
  wrap.replaceChildren();
  for (const group of PRESET_DOMAINS) {
    const groupEl = el("div", { className: "preset-group" });
    groupEl.append(el("h3", { text: group.category }));
    const btnRow = el("div", { className: "preset-domains" });
    for (const domain of group.domains) {
      btnRow.append(
        el("button", {
          className: "preset-domain-btn",
          text: domain,
          attrs: { type: "button", title: `Prefill ${domain}` },
          on: {
            click: () => {
              $("block-domain").value = domain;
              hideFieldError("block-domain-error");
              $("block-domain").focus();
              showToast(`Filled in ${domain} — pick a duration and hit "Block this site".`);
            },
          },
        })
      );
    }
    groupEl.append(btnRow);
    wrap.append(groupEl);
  }
}

/* ------------------------------------------------------------------ *
 *  BLOCKS TAB — active list + countdowns
 * ------------------------------------------------------------------ */

/**
 * Rebuild the active-blocks list from the current snapshot. Called on every
 * state refresh AND once per second by the countdown ticker.
 */
function renderBlocks() {
  const list = $("active-blocks-list");
  const empty = $("blocks-empty");
  list.replaceChildren();

  if (!state) return;

  const blocks = Object.values(state.blocks).sort((a, b) => a.expiresAt - b.expiresAt);
  empty.hidden = blocks.length > 0;

  const now = Date.now();
  for (const block of blocks) {
    const expired = block.expiresAt <= now;

    const main = el("div", { className: "block-main" });
    main.append(el("p", { className: "block-domain", text: block.domain }));
    if (block.reason) {
      main.append(el("p", { className: "block-reason", text: `"${block.reason}"` }));
    }
    main.append(
      el("p", {
        className: "block-times",
        text: `Started ${formatDateTime(block.createdAt)} · ends ${formatDateTime(block.expiresAt)}`,
      })
    );

    const countdown = el("span", {
      className: `block-countdown${expired ? " expired" : ""}`,
      text: expired ? "Expired" : formatRemaining(block.expiresAt - now),
      attrs: { "aria-live": "off" },
    });

    const endBtn = el("button", {
      className: "btn btn-danger btn-sm",
      text: "End early",
      attrs: { type: "button" },
      on: { click: () => endBlockEarly(block, expired) },
    });

    list.append(
      el("div", {
        className: `block-row${expired ? " expired" : ""}`,
        children: [main, countdown, endBtn],
      })
    );
  }
}

/**
 * Format an epoch-ms timestamp as a short local datetime.
 * @param {number} ts
 * @returns {string} e.g. "Nov 24, 14:32"
 */
function formatDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "End early" flow. Expired-but-unswept blocks are removed without a barrier
 * (bypass:false); live blocks require passing the unlock modal first.
 * @param {{id:number, domain:string, expiresAt:number}} block
 * @param {boolean} expired
 */
async function endBlockEarly(block, expired) {
  if (!expired) {
    const ok = await openUnlockModal();
    if (!ok) {
      showToast("Unlock cancelled — the block stays.");
      return;
    }
  }
  try {
    await send(MSG.REMOVE_BLOCK, { id: block.id, bypass: !expired });
    showToast(`Block on ${block.domain} ended.`, "success");
  } catch (err) {
    showToast(errMsg(err), "error");
  }
}

/* ------------------------------------------------------------------ *
 *  FOCUS TAB — session card + config
 * ------------------------------------------------------------------ */

/** Format seconds as "M:SS" for the focus countdown.
 * @param {number} totalSec
 * @returns {string} */
function formatCountdown(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Render the focus session card (idle vs active state). */
function renderFocusSession() {
  const idleView = $("focus-idle-view");
  const activeView = $("focus-active-view");
  const session = state?.focus?.session ?? null;

  if (!session) {
    idleView.hidden = false;
    activeView.hidden = true;
    // Update the start button label with configured work minutes.
    const workMin = state?.focus?.workMin ?? DEFAULT_FOCUS.workMin;
    $("focus-start-btn").textContent = `Start ${workMin} min focus`;
    return;
  }

  idleView.hidden = true;
  activeView.hidden = false;

  const now = Date.now();
  const remainingMs = Math.max(0, session.endsAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);

  const badge = $("focus-phase-badge");
  if (session.phase === "work") {
    badge.textContent = "Focusing";
    badge.className = "phase-badge work";
  } else {
    badge.textContent = "Break";
    badge.className = "phase-badge break";
  }

  $("focus-countdown").textContent = formatCountdown(remainingSec);
  $("focus-cycle-label").textContent = `Cycle ${session.cycle} of ${session.totalCycles}`;

  // Cycle dots.
  const dotsWrap = $("focus-cycle-dots");
  dotsWrap.replaceChildren();
  for (let i = 1; i <= session.totalCycles; i += 1) {
    let cls = "cycle-dot";
    if (i < session.cycle) cls += " done";
    else if (i === session.cycle) cls += " current";
    dotsWrap.append(el("span", { className: cls }));
  }
}

/** Wire the focus start/stop buttons. */
function initFocusSession() {
  $("focus-start-btn").addEventListener("click", async () => {
    try {
      await send(MSG.START_FOCUS, {});
      showToast("Focus session started. Stay on task!", "success");
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  });

  $("focus-stop-btn").addEventListener("click", async () => {
    const session = state?.focus?.session;
    if (!session) return;

    if (session.phase === "work") {
      const ok = await openUnlockModal();
      if (!ok) {
        showToast("Unlock cancelled — the session continues.");
        return;
      }
      try {
        await send(MSG.STOP_FOCUS, { bypass: true });
        showToast("Focus session stopped early.", "success");
      } catch (err) {
        showToast(errMsg(err), "error");
      }
    } else {
      // Break phase — no barrier needed.
      try {
        await send(MSG.STOP_FOCUS, { bypass: false });
        showToast("Focus session ended.", "success");
      } catch (err) {
        showToast(errMsg(err), "error");
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 *  FOCUS TAB — config card (focus list editor + steppers)
 * ------------------------------------------------------------------ */

/** Re-render the focus list chip editor from focusListEdit. */
function renderFocusListChips() {
  const container = $("focus-list-chips");
  container.replaceChildren();
  for (const domain of focusListEdit) {
    const tag = el("span", { className: "chip-tag" });
    tag.append(el("span", { text: domain }));
    tag.append(
      el("button", {
        className: "chip-tag-remove",
        text: "×",
        attrs: { type: "button", "aria-label": `Remove ${domain}` },
        on: {
          click: () => {
            focusListEdit = focusListEdit.filter((d) => d !== domain);
            renderFocusListChips();
          },
        },
      })
    );
    container.append(tag);
  }
}

/** Wire the focus-list add input + button. */
function initFocusListEditor() {
  const input = $("focus-list-input");
  const addBtn = $("focus-list-add-btn");

  const tryAdd = () => {
    hideFieldError("focus-list-error");
    const domain = normalizeDomain(input.value);
    if (!domain) {
      showFieldError("focus-list-error", "That doesn't look like a valid domain.");
      input.focus();
      return;
    }
    if (focusListEdit.includes(domain)) {
      showFieldError("focus-list-error", `${domain} is already in the list.`);
      input.select();
      return;
    }
    focusListEdit.push(domain);
    input.value = "";
    renderFocusListChips();
  };

  addBtn.addEventListener("click", tryAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      tryAdd();
    }
  });
}

/** Render the focus config form from the current snapshot. */
function renderFocusConfig() {
  if (!state) return;
  const focus = state.focus ?? DEFAULT_FOCUS;
  const sessionActive = focus.session != null;

  // Sync local edit copy (only when not actively typing in the input).
  focusListEdit = [...(focus.focusList ?? [])];
  renderFocusListChips();

  $("focus-work-min").value = String(focus.workMin ?? DEFAULT_FOCUS.workMin);
  $("focus-break-min").value = String(focus.breakMin ?? DEFAULT_FOCUS.breakMin);
  $("focus-cycles").value = String(focus.cycles ?? DEFAULT_FOCUS.cycles);

  // Disable the whole config card while a session is active.
  const notice = $("focus-config-notice");
  notice.hidden = !sessionActive;
  for (const id of ["focus-work-min", "focus-break-min", "focus-cycles", "focus-list-input", "focus-list-add-btn", "focus-save-config-btn"]) {
    $(id).disabled = sessionActive;
  }
}

/** Wire the focus config save button. */
function initFocusConfigSave() {
  $("focus-save-config-btn").addEventListener("click", async () => {
    hideFieldError("focus-config-error");

    const workMin = clampInt($("focus-work-min").value, FOCUS_LIMITS.MIN_WORK, FOCUS_LIMITS.MAX_WORK);
    const breakMin = clampInt($("focus-break-min").value, FOCUS_LIMITS.MIN_BREAK, FOCUS_LIMITS.MAX_BREAK);
    const cycles = clampInt($("focus-cycles").value, FOCUS_LIMITS.MIN_CYCLES, FOCUS_LIMITS.MAX_CYCLES);

    if (workMin === null || breakMin === null || cycles === null) {
      showFieldError(
        "focus-config-error",
        `Work ${FOCUS_LIMITS.MIN_WORK}–${FOCUS_LIMITS.MAX_WORK} min, break ${FOCUS_LIMITS.MIN_BREAK}–${FOCUS_LIMITS.MAX_BREAK} min, cycles ${FOCUS_LIMITS.MIN_CYCLES}–${FOCUS_LIMITS.MAX_CYCLES}.`
      );
      return;
    }

    try {
      await send(MSG.UPDATE_FOCUS_CONFIG, {
        focusList: focusListEdit,
        workMin,
        breakMin,
        cycles,
      });
      showToast("Focus configuration saved.", "success");
    } catch (err) {
      showFieldError("focus-config-error", errMsg(err));
    }
  });
}

/** Clamp a numeric input value to [min,max], returning null when invalid.
 * @param {string} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null} */
function clampInt(raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}

/* ------------------------------------------------------------------ *
 *  LIMITS TAB — budgets
 * ------------------------------------------------------------------ */

/** Render the budgets list from the current snapshot. */
function renderBudgets() {
  const list = $("budgets-list");
  const empty = $("budgets-empty");
  list.replaceChildren();

  if (!state) return;

  const budgets = Object.values(state.budgets ?? {}).sort((a, b) => a.domain.localeCompare(b.domain));
  empty.hidden = budgets.length > 0;

  const today = dateKey();
  for (const budget of budgets) {
    const usedSec = budget.usedSecByDay?.[today] ?? 0;
    const usedMin = Math.ceil(usedSec / 60);
    const pct = Math.min(100, Math.round((usedSec / (budget.dailyMin * 60)) * 100));
    const blocked = budget.blockedToday === true;

    const top = el("div", { className: "budget-top" });
    top.append(el("span", { className: "budget-domain", text: budget.domain }));
    if (blocked) {
      top.append(el("span", { className: "badge-blocked", text: "Blocked until midnight" }));
    }
    top.append(
      el("span", {
        className: "budget-usage",
        text: `${usedMin} of ${budget.dailyMin} min today`,
      })
    );

    const delBtn = el("button", {
      className: "btn btn-danger btn-sm",
      text: "Delete",
      attrs: { type: "button" },
      on: { click: () => deleteBudget(budget) },
    });
    top.append(el("div", { className: "budget-actions", children: [delBtn] }));

    const barTrack = el("div", { className: "budget-bar-track" });
    const barCls = blocked ? "budget-bar-fill blocked" : pct >= 80 ? "budget-bar-fill warning" : "budget-bar-fill";
    barTrack.append(el("div", { className: barCls, attrs: { style: `width:${Math.max(2, pct)}%` } }));

    list.append(
      el("div", {
        className: `budget-row${blocked ? " blocked" : ""}`,
        children: [top, barTrack],
      })
    );
  }
}

/**
 * Delete a budget. If the budget is blockedToday, the unlock modal is
 * required first (this weakens protection), then REMOVE_BUDGET with bypass.
 * @param {{id:number, domain:string, blockedToday:boolean}} budget
 */
async function deleteBudget(budget) {
  if (budget.blockedToday) {
    const ok = await openUnlockModal();
    if (!ok) {
      showToast("Unlock cancelled — the budget stays.");
      return;
    }
  }
  try {
    await send(MSG.REMOVE_BUDGET, { id: budget.id, bypass: budget.blockedToday });
    showToast(`Budget for ${budget.domain} removed.`, "success");
  } catch (err) {
    showToast(errMsg(err), "error");
  }
}

/** Wire the add-budget form. */
function initAddBudgetForm() {
  $("add-budget-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideFieldError("budget-error");

    const domain = normalizeDomain($("budget-domain").value);
    if (!domain) {
      showFieldError("budget-error", "Enter a valid domain, e.g. youtube.com.");
      $("budget-domain").focus();
      return;
    }

    const dailyMin = clampInt($("budget-minutes").value, BUDGET_LIMITS.MIN, BUDGET_LIMITS.MAX);
    if (dailyMin === null) {
      showFieldError("budget-error", `Daily minutes must be ${BUDGET_LIMITS.MIN}–${BUDGET_LIMITS.MAX}.`);
      $("budget-minutes").focus();
      return;
    }

    try {
      await send(MSG.ADD_BUDGET, { domain, dailyMin });
      showToast(`Budget set: ${dailyMin} min/day for ${domain}.`, "success");
      $("budget-domain").value = "";
      $("budget-minutes").value = "";
    } catch (err) {
      showFieldError("budget-error", errMsg(err));
    }
  });
}

/* ------------------------------------------------------------------ *
 *  LIMITS TAB — delays
 * ------------------------------------------------------------------ */

/** Re-render the delays domain chip editor from delaysDomainsEdit. */
function renderDelaysChips() {
  const container = $("delays-list-chips");
  container.replaceChildren();
  for (const domain of delaysDomainsEdit) {
    const tag = el("span", { className: "chip-tag" });
    tag.append(el("span", { text: domain }));
    tag.append(
      el("button", {
        className: "chip-tag-remove",
        text: "×",
        attrs: { type: "button", "aria-label": `Remove ${domain}` },
        on: {
          click: () => {
            delaysDomainsEdit = delaysDomainsEdit.filter((d) => d !== domain);
            renderDelaysChips();
          },
        },
      })
    );
    container.append(tag);
  }
}

/** Render the delay seconds chips (single-select radio style). */
function renderDelaySecondsChips() {
  const row = $("delay-seconds-chips");
  row.replaceChildren();
  for (const sec of DELAY_PRESETS) {
    row.append(
      el("button", {
        className: `chip${selectedDelaySeconds === sec ? " selected" : ""}`,
        text: `${sec}s`,
        attrs: { type: "button" },
        on: {
          click: () => {
            selectedDelaySeconds = sec;
            renderDelaySecondsChips();
          },
        },
      })
    );
  }
}

/** Wire the delays editor add input + save button. */
function initDelaysEditor() {
  const input = $("delays-list-input");
  const addBtn = $("delays-list-add-btn");

  const tryAdd = () => {
    hideFieldError("delays-list-error");
    const domain = normalizeDomain(input.value);
    if (!domain) {
      showFieldError("delays-list-error", "That doesn't look like a valid domain.");
      input.focus();
      return;
    }
    if (delaysDomainsEdit.includes(domain)) {
      showFieldError("delays-list-error", `${domain} is already in the list.`);
      input.select();
      return;
    }
    delaysDomainsEdit.push(domain);
    input.value = "";
    renderDelaysChips();
  };

  addBtn.addEventListener("click", tryAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      tryAdd();
    }
  });

  $("delays-save-btn").addEventListener("click", async () => {
    try {
      await send(MSG.UPDATE_DELAYS, { domains: delaysDomainsEdit, seconds: selectedDelaySeconds });
      showToast("Delays saved.", "success");
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  });
}

/** Render delays config from the snapshot. */
function renderDelays() {
  if (!state) return;
  const delays = state.delays ?? { domains: [], seconds: 15 };

  delaysDomainsEdit = [...(delays.domains ?? [])];
  selectedDelaySeconds = delays.seconds ?? DELAY_PRESETS[1];

  renderDelaysChips();
  renderDelaySecondsChips();
}

/* ------------------------------------------------------------------ *
 *  SCHEDULES TAB — add form
 * ------------------------------------------------------------------ */

/** Build the 7 day-of-week pill toggles from DAY_LABELS. */
function renderDayPills() {
  const row = $("day-pills");
  row.replaceChildren();
  DAY_LABELS.forEach((label, idx) => {
    row.append(
      el("button", {
        className: `chip${selectedDays.has(idx) ? " selected" : ""}`,
        text: label,
        attrs: { type: "button", "aria-pressed": String(selectedDays.has(idx)) },
        on: {
          click: () => {
            if (selectedDays.has(idx)) selectedDays.delete(idx);
            else selectedDays.add(idx);
            hideFieldError("sched-days-error");
            renderDayPills();
          },
        },
      })
    );
  });
}

/** Convert an <input type="time"> value ("HH:MM") to minutes since midnight.
 * @param {string} value
 * @returns {number|null} */
function timeToMinutes(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** Wire the add-schedule form submit. */
function initAddScheduleForm() {
  $("add-schedule-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    for (const id of ["sched-name-error", "sched-domains-error", "sched-days-error", "sched-time-error"]) {
      hideFieldError(id);
    }
    hideFieldError("sched-domains-note");

    const name = $("sched-name").value.trim();
    if (!name) {
      showFieldError("sched-name-error", "Give your schedule a name.");
      $("sched-name").focus();
      return;
    }

    // Normalize each comma-separated domain; drop invalid ones with a note.
    const rawParts = $("sched-domains").value.split(",");
    const domains = [];
    const dropped = [];
    for (const part of rawParts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const norm = normalizeDomain(trimmed);
      if (norm) {
        if (!domains.includes(norm)) domains.push(norm);
      } else {
        dropped.push(trimmed);
      }
    }
    if (dropped.length > 0) {
      showFieldError("sched-domains-note", `Skipped invalid entries: ${dropped.join(", ")}`);
    }
    if (domains.length === 0) {
      showFieldError("sched-domains-error", "Add at least one valid domain, e.g. youtube.com.");
      $("sched-domains").focus();
      return;
    }

    if (selectedDays.size === 0) {
      showFieldError("sched-days-error", "Pick at least one day of the week.");
      return;
    }

    const startMin = timeToMinutes($("sched-start").value);
    const endMin = timeToMinutes($("sched-end").value);
    if (startMin === null || endMin === null) {
      showFieldError("sched-time-error", "Set both a start and an end time.");
      return;
    }
    if (startMin === endMin) {
      showFieldError("sched-time-error", "Start and end time can't be identical — that window would never be active.");
      return;
    }

    try {
      await send(MSG.ADD_SCHEDULE, {
        name,
        domains,
        days: [...selectedDays].sort((a, b) => a - b),
        startMin,
        endMin,
      });
      showToast(`Schedule "${name}" added.`, "success");
      // Reset the form for the next entry.
      $("sched-name").value = "";
      $("sched-domains").value = "";
      $("sched-start").value = "";
      $("sched-end").value = "";
      selectedDays.clear();
      renderDayPills();
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  });
}

/* ------------------------------------------------------------------ *
 *  SCHEDULES TAB — list
 * ------------------------------------------------------------------ */

/** Compact day summary: consecutive runs collapse to "Mon–Fri".
 * @param {number[]} days sorted day indices
 * @returns {string} */
function summarizeDays(days) {
  if (!days || days.length === 0) return "No days";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";

  const runs = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i += 1) {
    if (i < sorted.length && sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    runs.push([start, prev]);
    if (i < sorted.length) {
      start = sorted[i];
      prev = sorted[i];
    }
  }
  return runs
    .map(([a, b]) => (a === b ? DAY_LABELS[a] : `${DAY_LABELS[a]}–${DAY_LABELS[b]}`))
    .join(", ");
}

/** "HH:MM" from minutes since midnight.
 * @param {number} mins
 * @returns {string} */
function minutesToTime(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** Rebuild the schedules list from the current snapshot. */
function renderSchedules() {
  const list = $("schedules-list");
  const empty = $("schedules-empty");
  list.replaceChildren();

  if (!state) return;

  const schedules = Object.values(state.schedules).sort((a, b) => a.name.localeCompare(b.name));
  empty.hidden = schedules.length > 0;

  for (const sched of schedules) {
    const top = el("div", { className: "schedule-top" });
    top.append(el("span", { className: "schedule-name", text: sched.name }));
    if (sched.active) {
      top.append(el("span", { className: "badge-active", text: "Active now" }));
    }

    const actions = el("div", { className: "schedule-actions" });

    // Enable/disable toggle switch.
    const toggle = el("button", {
      className: "switch",
      attrs: {
        type: "button",
        role: "switch",
        "aria-checked": String(sched.enabled),
        "aria-label": `Enable schedule ${sched.name}`,
      },
      children: [el("span", { className: "switch-thumb" })],
      on: {
        click: async () => {
          try {
            await send(MSG.TOGGLE_SCHEDULE, { id: sched.id, enabled: !sched.enabled });
            showToast(`Schedule "${sched.name}" ${sched.enabled ? "disabled" : "enabled"}.`, "success");
          } catch (err) {
            showToast(errMsg(err), "error");
          }
        },
      },
    });

    const delBtn = el("button", {
      className: "btn btn-danger btn-sm",
      text: "Delete",
      attrs: { type: "button" },
      on: { click: () => deleteSchedule(sched) },
    });

    actions.append(toggle, delBtn);
    top.append(actions);

    const meta = el("p", {
      className: "schedule-meta",
      text: `${summarizeDays(sched.days)} · ${minutesToTime(sched.startMin)}–${minutesToTime(sched.endMin)}${sched.enabled ? "" : " · disabled"}`,
    });

    const domainChips = el("div", { className: "schedule-domains" });
    for (const d of sched.domains) {
      domainChips.append(el("span", { className: "domain-chip", text: d }));
    }

    list.append(el("div", { className: "schedule-row", children: [top, meta, domainChips] }));
  }
}

/**
 * Delete flow — deleting an ACTIVE schedule weakens protection, so it
 * requires passing the unlock barrier first (same as ending a block early).
 * @param {{id:number, name:string, active:boolean}} sched
 */
async function deleteSchedule(sched) {
  if (sched.active) {
    const ok = await openUnlockModal();
    if (!ok) {
      showToast("Unlock cancelled — the schedule stays.");
      return;
    }
  }
  try {
    await send(MSG.REMOVE_SCHEDULE, { id: sched.id });
    showToast(`Schedule "${sched.name}" deleted.`, "success");
  } catch (err) {
    showToast(errMsg(err), "error");
  }
}

/* ------------------------------------------------------------------ *
 *  INSIGHTS TAB
 * ------------------------------------------------------------------ */

/** Sum all domain counts for one yyyyMmDd key in stats.attempts.
 * @param {Object} attempts
 * @param {string} key
 * @returns {number} */
function sumAttemptsForDay(attempts, key) {
  const dayMap = attempts?.[key];
  if (!dayMap) return 0;
  return Object.values(dayMap).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/** Render a top-N bar list into a container (shared by top-domains and time-sites).
 * @param {HTMLElement} container
 * @param {HTMLElement} emptyEl
 * @param {[string, number][]} entries sorted desc
 * @param {(n:number)=>string} formatVal formatter for the count column */
function renderTopList(container, emptyEl, entries, formatVal) {
  container.replaceChildren();
  emptyEl.hidden = entries.length > 0;
  const max = entries.length > 0 ? entries[0][1] : 0;
  for (const [name, val] of entries) {
    const widthPct = max > 0 ? Math.max(4, Math.round((val / max) * 100)) : 4;
    container.append(
      el("div", {
        className: "top-domain-row",
        children: [
          el("span", { className: "top-domain-name", text: name }),
          el("div", { className: "top-domain-bar", attrs: { style: `width:${widthPct}%` } }),
          el("span", { className: "top-domain-count", text: formatVal(val) }),
        ],
      })
    );
  }
}

/** Rebuild the whole insights tab from the current snapshot. */
function renderInsights() {
  if (!state) return;
  const { stats } = state;
  const today = dateKey();

  // --- stat cards ---
  const todayAttempts = sumAttemptsForDay(stats.attempts, today);
  $("stat-attempts-today").textContent = String(todayAttempts);
  $("stat-completed").textContent = String(stats.completedCount ?? 0);
  $("stat-focus-minutes").textContent = formatMinutes(stats.completedMinutes ?? 0);
  const streak = computeStreak(stats.completedDays ?? {});
  $("stat-streak").textContent = `${streak} ${streak === 1 ? "day" : "days"}`;
  $("stat-early-unlocks").textContent = String(stats.earlyUnlocks ?? 0);

  // Focus time today (NEW v2).
  const focusToday = stats.focusMinutesByDay?.[today] ?? 0;
  $("stat-focus-today").textContent = `${focusToday} min`;

  // --- 7-day bar chart (pure CSS flex bars, height % of max) ---
  const chart = $("attempts-chart");
  chart.replaceChildren();
  const keys = lastNDays(7);
  const counts = keys.map((k) => sumAttemptsForDay(stats.attempts, k));
  const max = Math.max(...counts, 0);

  keys.forEach((key, i) => {
    const count = counts[i];
    // Min 2% so zero days still show a hairline (zero-state friendly).
    const heightPct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 2;
    const d = new Date(
      Number(key.slice(0, 4)),
      Number(key.slice(4, 6)) - 1,
      Number(key.slice(6, 8))
    );
    const col = el("div", { className: "bar-col" });
    col.append(el("span", { className: "bar-count", text: String(count) }));
    col.append(
      el("div", {
        className: "bar",
        attrs: { style: `height:${heightPct}%`, title: `${count} attempt${count === 1 ? "" : "s"}` },
      })
    );
    col.append(
      el("span", {
        className: "bar-label",
        text: i === keys.length - 1 ? "Today" : DAY_LABELS[d.getDay()],
      })
    );
    chart.append(col);
  });

  // --- Time on sites today (NEW v2) ---
  const timeToday = stats.timeSec?.[today] ?? {};
  const timeTop = Object.entries(timeToday)
    .map(([domain, sec]) => [domain, Number(sec) || 0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  renderTopList(
    $("time-sites-list"),
    $("time-sites-empty"),
    timeTop,
    (sec) => `${Math.ceil(sec / 60)}m`
  );

  // --- Top 5 domains by all-time attempts ---
  const totals = new Map();
  for (const dayMap of Object.values(stats.attempts ?? {})) {
    for (const [domain, n] of Object.entries(dayMap)) {
      totals.set(domain, (totals.get(domain) ?? 0) + (Number(n) || 0));
    }
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  renderTopList($("top-domains-list"), $("top-domains-empty"), top, String);

  // --- one-line friendly summary ---
  const summary = $("insights-summary");
  if (todayAttempts > 0) {
    summary.textContent = `GetFocusd saved you from ${todayAttempts} distraction${todayAttempts === 1 ? "" : "s"} today.`;
  } else if (focusToday > 0) {
    summary.textContent = `${focusToday} minutes of focus time today — keep it up.`;
  } else if ((stats.completedCount ?? 0) > 0) {
    summary.textContent = `No distractions attempted today — and ${stats.completedCount} block${stats.completedCount === 1 ? "" : "s"} completed so far.`;
  } else {
    summary.textContent = "Add your first block to start racking up focus time.";
  }
}

/* ------------------------------------------------------------------ *
 *  SETTINGS TAB
 * ------------------------------------------------------------------ */

/** Render the settings tab controls from the snapshot. */
function renderSettings() {
  if (!state) return;
  const { settings } = state;

  // Unlock mode radios.
  $("mode-challenge").checked = settings.unlockMode === UNLOCK_MODE.CHALLENGE;
  $("mode-password").checked = settings.unlockMode === UNLOCK_MODE.PASSWORD;

  // Password status (never reveal the hash, just set/not-set).
  $("password-status").textContent = settings.passwordHash
    ? "A password is currently set. Only its hash is stored — GetFocusd can't show it back."
    : "No password set yet. Password mode won't work until you set one.";

  // Feature toggles.
  $("shorts-toggle").setAttribute("aria-checked", String(settings.shortsBlocker === true));
  $("notifications-toggle").setAttribute("aria-checked", String(settings.notifications !== false));

  // Theme selector — persisted value drives the chip state.
  const theme = settings.theme ?? "dark";
  for (const chip of document.querySelectorAll("#theme-chips .chip")) {
    const active = chip.dataset.themeValue === theme;
    chip.classList.toggle("selected", active);
    chip.setAttribute("aria-checked", String(active));
  }
}

/** Wire all settings-tab controls. */
function initSettings() {
  // --- unlock mode radios ---
  for (const radio of document.querySelectorAll('input[name="unlock-mode"]')) {
    radio.addEventListener("change", async () => {
      const newMode = radio.value;
      const current = state?.settings?.unlockMode;
      if (newMode === current) return;

      // Weakening protection? Require passing the CURRENT barrier first.
      if (protectionIsActive()) {
        const ok = await openUnlockModal();
        if (!ok) {
          showToast("Unlock cancelled — unlock mode unchanged.");
          renderSettings(); // revert radio selection
          return;
        }
      }

      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { unlockMode: newMode } });
        showToast(
          newMode === UNLOCK_MODE.PASSWORD
            ? "Unlock mode set to password. Make sure a password is set below!"
            : "Unlock mode set to typing challenge.",
          "success"
        );
      } catch (err) {
        showToast(errMsg(err), "error");
        renderSettings();
      }
    });
  }

  // --- set / change password ---
  $("set-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideFieldError("pw-error");
    const pw = $("pw-new").value;
    const confirm = $("pw-confirm").value;

    if (pw.length < 4) {
      showFieldError("pw-error", "Password must be at least 4 characters.");
      return;
    }
    if (pw !== confirm) {
      showFieldError("pw-error", "Passwords don't match. Try again.");
      return;
    }
    try {
      await send(MSG.SET_PASSWORD, { password: pw });
      $("pw-new").value = "";
      $("pw-confirm").value = "";
      showToast("Password updated. Only its hash is stored.", "success");
    } catch (err) {
      showFieldError("pw-error", errMsg(err));
    }
  });

  // --- remove password ---
  $("clear-password-btn").addEventListener("click", async () => {
    if (!state?.settings?.passwordHash) {
      showToast("No password is set.");
      return;
    }
    if (protectionIsActive()) {
      const ok = await openUnlockModal();
      if (!ok) {
        showToast("Unlock cancelled — password kept.");
        return;
      }
    }
    try {
      await send(MSG.CLEAR_PASSWORD);
      showToast("Password removed.", "success");
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  });

  // --- shorts blocker toggle ---
  $("shorts-toggle").addEventListener("click", async () => {
    const next = !(state?.settings?.shortsBlocker === true);
    try {
      await send(MSG.UPDATE_SETTINGS, { patch: { shortsBlocker: next } });
      showToast(`YouTube Shorts blocker ${next ? "enabled" : "disabled"}.`, "success");
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  });

  // --- notifications toggle ---
  $("notifications-toggle").addEventListener("click", async () => {
    const next = !(state?.settings?.notifications !== false);
    try {
      await send(MSG.UPDATE_SETTINGS, { patch: { notifications: next } });
      showToast(`Notifications ${next ? "enabled" : "disabled"}.`, "success");
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  });

  // --- theme selector ---
  for (const chip of document.querySelectorAll("#theme-chips .chip")) {
    chip.addEventListener("click", async () => {
      const theme = chip.dataset.themeValue;
      if (!theme || theme === state?.settings?.theme) return;
      try {
        await send(MSG.UPDATE_SETTINGS, { patch: { theme } });
        applyTheme(theme);
        showToast(`Theme set to ${theme}.`, "success");
      } catch (err) {
        showToast(errMsg(err), "error");
        renderSettings();
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 *  State refresh + live ticking
 * ------------------------------------------------------------------ */

/** Pull a fresh snapshot and re-render every tab. */
async function refreshState() {
  try {
    const data = await send(MSG.GET_STATE);
    state = data;
    applyTheme(data.settings?.theme);
    renderBlocks();
    renderFocusSession();
    renderFocusConfig();
    renderBudgets();
    renderDelays();
    renderSchedules();
    renderInsights();
    renderSettings();
  } catch (err) {
    // SW may be starting up — surface once via toast, keep old UI if any.
    showToast(errMsg(err), "error");
  } finally {
    $("loading-overlay").hidden = true;
  }
}

/** Subscribe to storage changes → re-pull the full snapshot. */
function initStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // Flip live when the theme is edited elsewhere (popup, another tab).
    const themeChange = changes.settings?.newValue?.theme;
    if (typeof themeChange === "string") applyTheme(themeChange);
    // Any of our keys changing means the snapshot is stale.
    refreshState();
  });
}

/**
 * 1-second ticker: only rebuilds the views that contain live time info.
 * Block countdowns, focus session countdown, and "ACTIVE now" badges tick;
 * everything else updates via storage events to avoid flicker.
 */
function initCountdownTicker() {
  setInterval(() => {
    if (!state) return;
    renderBlocks();
    renderFocusSession();
    renderSchedules();
  }, 1000);
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */

/** Wire everything up and load the initial state. */
function init() {
  initTabs();
  initModalRefs();
  initAddBlockForm();
  initFocusSession();
  initFocusListEditor();
  initFocusConfigSave();
  initAddBudgetForm();
  initDelaysEditor();
  initAddScheduleForm();
  initSettings();
  renderDurationChips();
  renderDayPills();
  renderPresets();
  initStorageListener();
  initCountdownTicker();
  refreshState();
}

init();
