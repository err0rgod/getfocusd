/**
 * GetFocusd blocked page — one page, four layouts.
 *
 * Reached via a declarativeNetRequest redirect whose query string carries the
 * display params (see docs/ARCHITECTURE.md §5). Param `t` selects the layout:
 *   t=block    &d={domain}&until={ms}&r={reason}      timed block (attempt counted)
 *   t=schedule &name={name}&until={ms}                schedule window
 *   t=focus    &until={ms}                            Pomodoro work phase
 *   t=budget   &d={domain}&until={ms}&limit={dailyMin} daily budget exhausted
 *
 * Renders a live countdown to `until`, a random motivational quote and (for
 * timed blocks only) the today's-attempt count reported by the service worker.
 * There is deliberately NO unblock control on this page.
 *
 * @module blocked/blocked
 */

import { MSG, QUOTES } from "../shared/constants.js";
import { pickRandom } from "../shared/utils.js";

/** @type {HTMLElement} */
const els = {
  headline: document.getElementById("headline"),
  subline: document.getElementById("subline"),
  reason: document.getElementById("reason"),
  countdown: document.getElementById("countdown"),
  quote: document.getElementById("quote"),
  quoteText: document.getElementById("quote-text"),
  quoteAuthor: document.getElementById("quote-author"),
  attempts: document.getElementById("attempts"),
  dashboardLink: document.getElementById("dashboard-link"),
};

/** Layout types carried by the DNR redirect query (docs/ARCHITECTURE.md §5). */
const TYPES = Object.freeze(["block", "schedule", "focus", "budget"]);

/** Parsed, sanitized view of location.search. */
const params = parseParams();

let tickTimer = 0;
let reloadTimer = 0;
let finished = false;

/**
 * Read and sanitize the redirect query params. Anything missing or garbage
 * falls back to null so the page can degrade to a generic layout.
 * @returns {{type: "block"|"schedule"|"focus"|"budget"|null, domain: string|null,
 *           until: number|null, reason: string|null, name: string|null,
 *           limit: number|null}}
 */
function parseParams() {
  let sp;
  try {
    sp = new URLSearchParams(location.search);
  } catch {
    return { type: null, domain: null, until: null, reason: null, name: null, limit: null };
  }
  const rawType = sp.get("t");
  const type = TYPES.includes(rawType) ? rawType : null;
  const domain = cleanText(sp.get("d"));
  const reason = cleanText(sp.get("r"));
  const name = cleanText(sp.get("name"));
  const untilRaw = Number(sp.get("until"));
  const until = Number.isFinite(untilRaw) && untilRaw > 0 ? untilRaw : null;
  const limitRaw = Number(sp.get("limit"));
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1440 ? limitRaw : null;
  return { type, domain, until, reason, name, limit };
}

/**
 * Trim a query param to a sane display string (null when absent/empty).
 * @param {string|null} value
 * @returns {string|null}
 */
function cleanText(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v === "" ? null : v.slice(0, 300);
}

/**
 * Format remaining milliseconds as a big "H:MM:SS" style timer
 * (days are folded into hours, e.g. "47:09:12").
 * @param {number} msLeft clamped at 0
 * @returns {string}
 */
function formatBigCountdown(msLeft) {
  const totalSec = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Fill headline, sub-line, title and reason according to the parsed params.
 * Falls back to a generic "This site is blocked" layout on garbage input.
 */
function renderStaticContent() {
  let titleSubject = null;

  switch (params.type) {
    case "block":
      els.headline.textContent = params.domain ?? "This site is blocked";
      titleSubject = params.domain;
      if (params.reason) {
        els.reason.textContent = `“${params.reason}”`;
        els.reason.hidden = false;
      }
      break;

    case "schedule":
      els.headline.textContent = params.name
        ? `Blocked by schedule: ${params.name}`
        : "Blocked by schedule";
      titleSubject = params.name;
      break;

    case "focus":
      els.headline.textContent = "Focus session in progress";
      els.subline.textContent = "This site is on your Focus List.";
      els.subline.hidden = false;
      titleSubject = "Focus";
      break;

    case "budget":
      els.headline.textContent = "Daily limit reached";
      if (params.domain) {
        const limitPart = params.limit !== null ? `${params.limit}-minute` : "daily";
        els.subline.textContent =
          `Your ${limitPart} budget for ${params.domain} resets at midnight.`;
        els.subline.hidden = false;
      }
      titleSubject = params.domain;
      break;

    default:
      els.headline.textContent = "This site is blocked";
      break;
  }

  document.title = titleSubject ? `Blocked · ${titleSubject}` : "Blocked";
}

/** Render a random motivational quote from the shared list. */
function renderQuote() {
  const quote = pickRandom(QUOTES);
  if (!quote) return;
  els.quoteText.textContent = quote.text;
  els.quoteAuthor.textContent = quote.author;
  els.quote.hidden = false;
}

/**
 * Countdown tick: update the big timer; at zero show "Unblocking…" and reload
 * shortly after — by then the rule will have been lifted (block expired,
 * focus phase advanced, budget reset), so the reload lands on the real site.
 * With no valid `until`, show a static em dash.
 */
function tickCountdown() {
  if (finished || params.until === null) return;
  const left = params.until - Date.now();
  if (left <= 0) {
    finished = true;
    els.countdown.textContent = "Unblocking…";
    els.countdown.classList.add("done");
    window.clearInterval(tickTimer);
    reloadTimer = window.setTimeout(() => location.reload(), 2000);
    return;
  }
  els.countdown.textContent = formatBigCountdown(left);
}

/**
 * Record this visit as a blocked attempt and show today's count for the
 * domain. Only meaningful for timed blocks; the line stays hidden on error
 * or when the response carries no count.
 */
async function recordAttempt() {
  if (params.type !== "block" || !params.domain) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.RECORD_ATTEMPT,
      domain: params.domain,
    });
    const count = Number(res?.count);
    if (res?.ok === true && Number.isInteger(count) && count > 0) {
      const noun = count === 1 ? "attempt" : "attempts";
      els.attempts.textContent =
        `That's ${count} ${noun} today — the block is doing its job.`;
      els.attempts.hidden = false;
    }
  } catch {
    // Hide-by-default: failures simply leave the line hidden.
  }
}

/** Wire the dashboard link, paint content, start the countdown. */
function init() {
  renderStaticContent();
  renderQuote();

  if (params.until !== null) {
    tickCountdown();
    tickTimer = window.setInterval(tickCountdown, 1000);
  } else {
    els.countdown.textContent = "—";
  }

  els.dashboardLink.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });

  void recordAttempt();
}

window.addEventListener("pagehide", () => {
  window.clearInterval(tickTimer);
  window.clearTimeout(reloadTimer);
});

init();
