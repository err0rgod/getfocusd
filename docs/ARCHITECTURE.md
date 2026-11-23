# GetFocusd — Architecture Contract

> **This document is the single source of truth for every module in the extension.**
> All contributors (human or agent) MUST read this before writing code and MUST NOT
> deviate from the schemas, message types, and conventions defined here without
> updating this file first.
>
> **v2 (2026-11-24):** added Pomodoro focus timer, daily time budgets,
> mindful-pause delays, and per-site time tracking. Product name: GetFocusd
> (getfocusd.tech).

---

## 1. Product Summary

**GetFocusd** is a Manifest V3 Chrome extension that helps users stay focused:

1. **Timed blocks** — pick a site + duration; until the timer expires the site
   never loads (network-level redirect to a block page). Early removal requires
   an **unlock barrier** (typing challenge or friend-set password).
2. **Pomodoro focus timer** — work/break cycles; during work phases the user's
   *Focus List* domains are sealed-blocked; breaks lift the block.
3. **Daily time budgets** — per-site daily allowance (minutes). A content-script
   heartbeat tracks active viewing time; exceeding the budget blocks the site
   until local midnight.
4. **Mindful pause delay** — chosen sites get a full-screen breathing countdown
   overlay before the user may continue (per page load).
5. **YouTube Shorts blocker** — network redirect of `/shorts/` + cosmetic hiding.
6. **Insights** — blocked-attempt counts, 7-day chart, top domains, streak,
   focus minutes, per-site time today.
7. **100 % local** — zero network calls, zero data collection.

## 2. Tech Constraints (hard rules)

- **Manifest V3**, Chrome first. No frameworks, no bundler, no CDN/remote code
  (CWS policy). Vanilla HTML/CSS/JS only.
- Background is an **ES-module service worker** (`"type": "module"`).
- Extension pages (options/popup/blocked) use `<script type="module">` and MAY
  import from `src/shared/`.
- **Content scripts cannot be ES modules** — `src/content/*.js` are classic
  self-contained scripts that duplicate the tiny constants they need (mark the
  duplication with a comment).
- Blocking uses **`chrome.declarativeNetRequest` dynamic rules** (persist across
  restarts; enforced while the service worker sleeps).
- All persistent state lives in `chrome.storage.local`. Never `localStorage`.
- Every JS file must be valid ES2022+, pass `node --check`, and carry JSDoc on
  exported functions. UI text is plain friendly English. Product name in all
  user-facing strings and log prefixes is **"GetFocusd"**.

## 3. File Map

```
manifest.json                        (owned by root — do NOT edit)
docs/ARCHITECTURE.md                 (this file)
src/shared/constants.js              (owned by root — do NOT edit)
src/shared/utils.js                  (owned by root — do NOT edit)
src/background/service-worker.js     (agent A) entry: alarms + message router
src/background/storage.js            (agent A) storage CRUD + defaults
src/background/blocker.js            (agent A) DNR rule builders + reconcile
src/background/stats.js              (agent A) insights bookkeeping
src/background/scheduler.js          (agent A) tick engine
src/background/focus.js              (agent A) Pomodoro session state machine
src/background/budgets.js            (agent A) daily budget tracking + blocking
src/options/options.html|.css|.js    (agent B) dashboard: Blocks/Focus/Limits/Schedules/Insights/Settings
src/popup/popup.html|.css|.js        (agent C) quick block + focus timer controls
src/blocked/blocked.html|.css|.js    (agent C) block page (all block types)
src/content/shorts.js                (agent D) YouTube Shorts cosmetic hiding
src/content/guard.js                 (agent D) heartbeat time tracker + delay overlay
assets/icons/icon{16,32,48,128}.png  (root)
```

## 4. Storage Schema (`chrome.storage.local`)

Timestamps are `Date.now()` ms; date keys are local `yyyyMmDd` via `utils.dateKey`.

### `settings` — single object (unchanged from v1)
```js
{
  version: 1,
  unlockMode: "challenge" | "password",
  passwordHash: string | null,
  shortsBlocker: boolean,
  notifications: boolean,
  theme: "dark"
}
```

### `blocks` — map key = String(ruleId) (unchanged)
```js
{ [id]: { id, domain, reason, createdAt, expiresAt } }
```

### `schedules` — map key = String(ruleId) (unchanged)
```js
{ [id]: { id, name, domains[], days[], startMin, endMin, enabled, active } }
```

### `focus` — Pomodoro configuration + live session (NEW)
```js
{
  version: 1,
  focusList: string[],        // normalized domains blocked during work phases
  workMin: number,            // default 25  (5..120)
  breakMin: number,           // default 5   (1..60)
  cycles: number,             // default 4   (1..12)
  session: null | {
    phase: "work" | "break",
    cycle: number,            // 1-based current cycle
    totalCycles: number,
    startedAt: number,        // ms, phase start
    endsAt: number,           // ms, phase end
    ruleId: number            // DNR rule id; live only during work phases
  }
}
```

### `budgets` — map key = String(ruleId) (NEW)
```js
{
  [id]: {
    id: number,               // DNR rule id while blocked today
    domain: string,           // normalized; matches subdomains too
    dailyMin: number,         // 1..720
    usedSecByDay: { [yyyyMmDd]: number },
    blockedToday: boolean,
    createdAt: number
  }
}
```

### `delays` — mindful-pause list (NEW)
```js
{ domains: string[], seconds: number }   // seconds ∈ DELAY_PRESETS (default 15)
```

### `stats` — single object (EXTENDED)
```js
{
  attempts: { [yyyyMmDd]: { [domain]: number } },
  completedCount: number,
  completedMinutes: number,
  completedDays: { [yyyyMmDd]: number },
  earlyUnlocks: number,
  timeSec: { [yyyyMmDd]: { [domain]: number } },   // NEW: active time per site
  focusMinutesByDay: { [yyyyMmDd]: number },       // NEW: completed work minutes
  focusMinutesTotal: number                        // NEW
}
```

### `meta` — single object (unchanged)
```js
{ nextRuleId: number } // starts at 100
```

## 5. DNR Rule Conventions

- `RULE_ID_SHORTS = 1` reserved; all other ids come from `storage.allocateRuleId()` (≥ 100).
- Redirect targets embed display params in the `extensionPath` query string;
  `blocked.html` parses `location.search`. Param `t` selects the layout:
  - `t=block&d={domain}&until={ms}&r={reason}` — timed block (existing)
  - `t=schedule&name={name}&until={ms}` — schedule window (existing)
  - `t=focus&until={ms}` — NEW: Pomodoro work phase (until = phase end)
  - `t=budget&d={domain}&until={ms}&limit={dailyMin}` — NEW: budget exhausted
    (until = next local midnight via `utils.nextMidnightTs()`)
- Condition for domain rules: `{ requestDomains: [domain], resourceTypes: ["main_frame"] }`
  (schedules/focus list may pass several domains in one rule).
- Shorts rule (id 1): regexFilter `^https?://([^/]+\.)?youtube\.com/shorts/` →
  redirect `https://www.youtube.com/`, toggled by `settings.shortsBlocker`.
- Storage is the source of truth; `reconcileRules()` at SW start heals drift
  (blocks + active schedules + shorts + work-phase focus rule + blockedToday budgets).

## 6. Message API (pages/content → service worker)

`chrome.runtime.sendMessage(msg)` → `{ ok:true, ... } | { ok:false, error }`,
handler returns `true` (async). `type` values in `constants.MSG`.

| type | payload | response |
|---|---|---|
| `GET_STATE` | — | `{ settings, blocks, schedules, stats, focus, budgets, delays }` |
| `ADD_BLOCK` / `BLOCK_TAB` | `{ domain, durationMin, reason }` | `{ block }` |
| `REMOVE_BLOCK` | `{ id, bypass }` | `{}` (bypass before expiry counts `earlyUnlocks`) |
| `VERIFY_UNLOCK` | `{ mode, attempt }` | `{ ok }` |
| `ADD_SCHEDULE` / `REMOVE_SCHEDULE` / `TOGGLE_SCHEDULE` | … | … |
| `UPDATE_SETTINGS` | `{ patch }` (never password/unlockMode weakening) | `{ settings }` |
| `SET_PASSWORD` / `CLEAR_PASSWORD` | … | `{}` |
| `RECORD_ATTEMPT` | `{ domain }` | `{ count }` |
| `START_FOCUS` | `{ workMin?, breakMin?, cycles? }` | `{ session }` — 409-style error if a session is active |
| `STOP_FOCUS` | `{ bypass }` | `{}` — during a **work** phase requires `bypass:true` (page runs unlock modal; bypass counts `earlyUnlocks`); during break, free |
| `UPDATE_FOCUS_CONFIG` | `{ focusList?, workMin?, breakMin?, cycles? }` | `{ focus }` — rejected while a session is active |
| `ADD_BUDGET` | `{ domain, dailyMin }` | `{ budget }` — one budget per domain max |
| `REMOVE_BUDGET` | `{ id, bypass }` | `{}` — if `blockedToday`, requires `bypass:true` (counts `earlyUnlocks`); removes live rule |
| `UPDATE_DELAYS` | `{ domains?, seconds? }` | `{ delays }` |
| `HEARTBEAT` | `{ domain, sec }` | `{}` — from guard.js; accumulates `stats.timeSec` + budget usage (see §7b) |

**Friction note (unchanged):** barriers stop impulses, not determined users —
no client-side extension can do more. Never claim otherwise in UI copy.

## 7. Engines

### 7a. Tick engine (scheduler.js) — alarm `getfocusd:tick`, 1 min period
On every tick AND at SW start:
1. Expire due blocks → remove rule, delete, `recordCompletion`, notify.
2. Evaluate schedules (overnight-aware) → add/remove rules, flip `active`.
3. Focus: if `session` exists and `endsAt <= now`, call `focus.advancePhase()`
   (fallback for a missed phase alarm, e.g. after sleep).
4. Budgets: if any budget's `blockedToday`/usage belongs to a past dateKey,
   reset `blockedToday=false`, remove its rule, prune `usedSecByDay`.
5. Prune `stats.attempts` and `stats.timeSec` older than 35 days.

### 7b. Heartbeat & budgets (budgets.js)
- guard.js sends `HEARTBEAT {domain, sec:15}` every 15 s while the tab document
  is visible. SW finds a budget where `utils.domainMatches(domain, budget.domain)`,
  adds `sec` to `usedSecByDay[today]` and `stats.timeSec[today][domain]`
  (timeSec is recorded for every domain, budget or not — powers insights).
- When usage crosses `dailyMin*60` and `!blockedToday`: set `blockedToday=true`,
  add the budget DNR rule (until = next midnight), notify "Time's up for {domain}",
  and reload matching http(s) tabs (`chrome.tabs.query({url:"*://*.domain/*"})` →
  `chrome.tabs.reload`) so the block page appears immediately.
- Day rollover handled by tick §7a-4.

### 7c. Pomodoro state machine (focus.js)
- `startFocus(cfg?)` — merge cfg into focus config, create session
  `{phase:"work", cycle:1, totalCycles, startedAt:now, endsAt:now+workMin*60000,
  ruleId: allocateRuleId()}`, add focus DNR rule over `focusList`
  (`t=focus&until=endsAt`), arm exact one-shot alarm `getfocusd:phase` at endsAt.
- `advancePhase()` — work→break: remove rule, notify "Break time ⏸"→(no emoji:
  "Focus complete — break time"), if cycle==totalCycles → end session instead.
  break→work: cycle+1, re-add rule, notify. Re-arm the phase alarm each time.
- `stopFocus({bypass})` — remove rule if live, clear session, cancel phase alarm.
- On session completion (last work phase done): `stats.focusMinutesByDay[today] +=
  workMin` per completed work phase (accumulate each work phase end, not just
  session end, so partial sessions still count) and matching `focusMinutesTotal`.
- Phase alarm `getfocusd:phase` fires `advancePhase()`; tick §7a-3 is the fallback.

## 8. UI Design Language (unchanged)

Dark-first, calm, minimal. Each page defines these CSS custom properties:

```css
:root {
  --bg: #0f172a; --surface: #1e293b; --surface-2: #334155;
  --primary: #6366f1; --primary-hover: #818cf8;
  --text: #e2e8f0; --muted: #94a3b8;
  --danger: #ef4444; --success: #22c55e;
  --radius: 12px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
```
Rounded `--radius`, inline SVG only (no emoji icons), focus-visible outlines,
`chrome.storage.onChanged` live re-render. Brand name shown as **GetFocusd**.

## 9. Page Responsibilities

- **options.html** — tabs: **Blocks** (v1), **Focus** (NEW: focus list editor —
  chip add/remove of normalized domains; work/break/cycles steppers; live session
  card with phase + countdown + Start/Stop; Stop during work phase → unlock
  modal), **Limits** (NEW: budgets — add domain + daily minutes, list with
  today-used progress bars, delete gated by unlock modal while blockedToday;
  delays — domain list editor + seconds chips from DELAY_PRESETS),
  **Schedules** (v1), **Insights** (v1 + NEW: "Focus time today" card from
  `focusMinutesByDay`, "Time on sites today" top-5 list from `stats.timeSec`),
  **Settings** (v1). Weakening protection while any block/active schedule/
  work-phase session/blocked-today budget exists requires the unlock modal.
- **popup.html** — v1 quick block + NEW compact focus section: when idle, a
  "Start focus (25m)" button (uses configured workMin); when active, phase
  label + countdown + cycle dots + Stop button (during work phase the SW will
  reject without bypass → show hint "End early from the dashboard").
- **blocked.html** — layouts per `t` param: `block` (v1), `schedule` (v1),
  `focus` (headline "Focus session in progress", sub "This site is on your
  Focus List", countdown to phase end), `budget` (headline "Daily limit
  reached", sub "Your {limit} budget for {d} resets at midnight"). RECORD_ATTEMPT
  only for `t=block`. No unblock control anywhere.
- **content/shorts.js** — (v1) cosmetic Shorts hiding.
- **content/guard.js** — (NEW, classic script, all http/https, document_start,
  top frame only) two duties: (1) heartbeat: while `document.visibilityState ===
  "visible"`, send `HEARTBEAT {domain: location.hostname sans one leading
  "www.", sec: 15}` every 15 s; skip domains without a dot. (2) delay overlay:
  if current host matches `delays.domains` (with subdomain matching), inject a
  full-viewport overlay (dark veil, breathing CSS circle, countdown of
  `delays.seconds`, then a "Continue" button that dismisses it); per page load;
  live-update on `storage.onChanged`; never break the page (try/catch, bail on
  errors; overlay created lazily at DOMContentLoaded if document.body missing).

## 10. Definition of Done

- `node --check` passes on every JS file.
- Load-unpacked smoke test: timed block redirects before load; countdown matches;
  expiry auto-unblocks ≤ 60 s; focus session blocks focus list during work and
  lifts during break; budget blocks at the limit and resets at midnight; delay
  overlay appears on listed sites; shorts toggle works on youtube.com.
- No remote requests, no eval, no inline event handlers (CSP-safe).
