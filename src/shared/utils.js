/**
 * GetFocusd — shared pure utilities.
 *
 * No chrome.* APIs here except hashing (Web Crypto, available everywhere).
 * Every function is side-effect free and unit-testable.
 *
 * @module shared/utils
 */

/**
 * Normalize user input into a bare registrable-ish domain.
 *
 * Accepts "youtube.com", "www.YouTube.com/watch?v=x", "https://m.reddit.com/r/all",
 * etc. Strips protocol, credentials, port, path/query/hash and ONE leading
 * "www." label, then lowercases. Returns null when the input cannot possibly
 * be a hostname.
 *
 * @param {string} input raw user input
 * @returns {string|null} normalized domain (e.g. "reddit.com") or null
 */
export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // Let URL do the heavy lifting; prepend a scheme when missing.
  let host = s;
  try {
    host = new URL(s.includes("://") ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  // Basic hostname sanity: labels of letters/digits/hyphens, at least one dot
  // or an explicit localhost-style single label is rejected (we block sites,
  // not dev servers).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  return host;
}

/**
 * Local-time date key used throughout the stats schema: "yyyyMmDd".
 * @param {number} [ts=Date.now()] epoch milliseconds
 * @returns {string} e.g. "20261124"
 */
export function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

/**
 * Human "time left" string: "3d 2h", "2h 15m", "4m 30s", "<1m".
 * @param {number} msLeft milliseconds remaining (clamped at 0)
 * @returns {string}
 */
export function formatRemaining(msLeft) {
  const totalSec = Math.max(0, Math.floor(msLeft / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return "<1m";
}

/**
 * Compact duration label for chips and stats: 90 -> "1h 30m", 1440 -> "1d".
 * @param {number} minutes
 * @returns {string}
 */
export function formatMinutes(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/**
 * SHA-256 hex digest (lowercase) of a string. Used for the unlock password —
 * only the hash is ever stored.
 * @param {string} text
 * @returns {Promise<string>} 64-char hex string
 */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Loose equality for typing challenges: trims, collapses inner whitespace and
 * ignores case, so a small typo of spacing/casing doesn't punish the user.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function looseEqual(a, b) {
  const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Pick a uniformly random element.
 * @template T
 * @param {readonly T[]} arr
 * @returns {T}
 */
export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Is a schedule inside its window at `now`? Handles overnight windows where
 * startMin > endMin (e.g. 22:00–06:00).
 * @param {{days:number[], startMin:number, endMin:number}} schedule
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isScheduleActiveNow(schedule, now = new Date()) {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const { days, startMin, endMin } = schedule;
  if (!Array.isArray(days)) return false;
  if (startMin === endMin) return false; // zero-length window = never active
  if (startMin < endMin) {
    // Same-day window: the day must be selected.
    return days.includes(day) && mins >= startMin && mins < endMin;
  }
  // Overnight window: after start belongs to `day`, before end belongs to the
  // previous day's selection.
  if (mins >= startMin) return days.includes(day);
  const prevDay = (day + 6) % 7;
  return days.includes(prevDay) && mins < endMin;
}

/**
 * Timestamp (ms) at which the currently active schedule window ends.
 * Returns null when the schedule is not active right now.
 * @param {{days:number[], startMin:number, endMin:number}} schedule
 * @param {Date} [now=new Date()]
 * @returns {number|null}
 */
export function scheduleWindowEnd(schedule, now = new Date()) {
  if (!isScheduleActiveNow(schedule, now)) return null;
  const end = new Date(now);
  end.setHours(Math.floor(schedule.endMin / 60), schedule.endMin % 60, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime();
}

/**
 * Consecutive-day streak ending today or yesterday, from a {yyyyMmDd: count}
 * map. A day "counts" when its value > 0.
 * @param {Record<string, number>} daysMap
 * @param {number} [now=Date.now()]
 * @returns {number} streak length in days
 */
export function computeStreak(daysMap, now = Date.now()) {
  let streak = 0;
  const cursor = new Date(now);
  // Allow the streak to survive until the end of today: if today has no entry
  // yet, start counting from yesterday.
  if (!(daysMap[dateKey(cursor.getTime())] > 0)) cursor.setDate(cursor.getDate() - 1);
  while (daysMap[dateKey(cursor.getTime())] > 0) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * Last N date keys (oldest → newest, today last) for charts.
 * @param {number} n number of days
 * @returns {string[]} array of yyyyMmDd keys
 */
export function lastNDays(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = new Date(d);
    c.setDate(d.getDate() - i);
    out.push(dateKey(c.getTime()));
  }
  return out;
}

/**
 * Does `host` belong to `domain`? Matches the domain itself and any depth of
 * subdomain: domainMatches("old.reddit.com", "reddit.com") === true.
 * Both inputs are expected lowercase/normalized.
 * @param {string} host
 * @param {string} domain
 * @returns {boolean}
 */
export function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Timestamp (ms) of the next local midnight strictly after `now`.
 * Used as the `until` for exhausted daily budgets.
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function nextMidnightTs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Escape a string for safe interpolation into HTML text contexts.
 * (Pages should prefer textContent; this is a belt-and-braces helper.)
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
