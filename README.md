# GetFocusd

**Sealed website blocks, Pomodoro focus timer, daily budgets, mindful pauses and a YouTube Shorts blocker — free, private, 100% local.**

Website: [https://getfocusd.tech](https://getfocusd.tech)

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License MIT](https://img.shields.io/badge/License-MIT-green)
![GetFocusd — 100% Local](https://img.shields.io/badge/GetFocusd-100%25%20Local-brightgreen)

---

## Features

- **Timed sealed blocks** — pick a site, set a duration. Until the timer expires the site never loads. No early undo without passing a barrier.
- **Unlock barriers** — choose between a typing challenge (type a motivational quote exactly) or a friend-set password (stored as SHA-256 hash only).
- **Pomodoro focus timer** — work/break cycles with a configurable focus list. During work phases the listed sites are sealed-blocked; breaks lift the block automatically.
- **Daily time budgets** — set a per-site daily allowance (minutes). A content-script heartbeat tracks active viewing time; exceeding the budget blocks the site until midnight.
- **Mindful pause delays** — chosen sites get a full-screen breathing countdown overlay before you may continue, one per page load.
- **Live block page** — countdown timer, your reason for blocking, a motivational quote, and an attempt counter showing how many times you've tried to visit today.
- **Schedules** — recurring day-of-week + time-window blocks. Handles overnight windows (e.g. 22:00–06:00).
- **YouTube Shorts blocker** — redirects /shorts/ URLs to the YouTube homepage and cosmetically hides Shorts shelves, sidebar entries, and links.
- **Focus insights** — blocked-attempt counts per day and per domain, 7-day bar chart, top blocked domains, current streak, focus minutes, and time-on-sites today.
- **Notifications** — get alerted when a block completes, a Pomodoro phase ends, or a budget is exhausted.
- **Dark UI** — calm, minimal, dark-first design across all pages.
- **Privacy** — no accounts, no analytics, no network calls. Everything stays in `chrome.storage.local` on your device.

---

## Install from Source

```bash
git clone https://github.com/your-username/getfocusd.git
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select the cloned `getfocusd` folder.

---

## Usage Quickstart

### Block a site in 10 seconds

1. Click the GetFocusd icon in the toolbar.
2. The current tab's domain is pre-filled — pick a duration (or type a custom one).
3. Optionally add a reason ("distracting", "doomscrolling", …).
4. Hit **Block**. The site redirects to the block page until the timer runs out.

### Dashboard tour

Open the dashboard via the popup's **Open dashboard** link, or go to `chrome://extensions` → GetFocusd → **Extension options**.

| Tab | What it does |
|-----|-------------|
| **Blocks** | Add blocks with preset domains & duration chips. See active blocks with live countdowns. "End early" requires passing the unlock barrier. |
| **Focus** | Edit the Pomodoro focus list, configure work/break/cycle durations, and start/stop focus sessions with a live phase countdown. |
| **Limits** | Set daily time budgets per domain (progress bars show today's usage) and manage mindful-pause delay sites. |
| **Schedules** | Create recurring blocks: pick days of the week, set a time window (overnight supported), toggle on/off. |
| **Insights** | Today's blocked attempts, 7-day bar chart, top blocked domains, totals, streak, focus time today, time on sites today. |
| **Settings** | Unlock mode (challenge vs. password), set/clear friend password, YouTube Shorts toggle, notification toggle. |

---

## Project Structure

```
manifest.json                        Extension manifest (MV3)
docs/ARCHITECTURE.md                 Architecture contract (single source of truth)
docs/PRIVACY.md                      Privacy policy (linked from store listing)
LICENSE                              MIT license
src/shared/constants.js              Storage keys, message types, presets, quotes
src/shared/utils.js                  Domain normalization, date keys, helpers
src/background/service-worker.js     Entry: wires alarms + message handlers
src/background/storage.js            Storage CRUD + defaults
src/background/blocker.js            declarativeNetRequest rule builders + reconcile
src/background/stats.js              Insights bookkeeping
src/background/scheduler.js          Tick engine: expiry + schedules + budgets + focus fallback
src/background/focus.js              Pomodoro session state machine
src/background/budgets.js            Daily budget tracking + blocking
src/options/options.html|.css|.js    Dashboard: Blocks/Focus/Limits/Schedules/Insights/Settings
src/popup/popup.html|.css|.js        Quick block + focus timer controls
src/blocked/blocked.html|.css|.js    Block page (all block types)
src/content/shorts.js                YouTube Shorts cosmetic hider (classic script)
src/content/guard.js                 Heartbeat time tracker + delay overlay (classic script)
assets/icons/icon{16,32,48,128}.png
```

---

## Tech Notes

- **Manifest V3** — service worker background, declarativeNetRequest, no remote code.
- **DNR dynamic rules** — blocking rules persist across browser restarts and are enforced even when the service worker is asleep.
- **Heartbeat tracking** — a content script sends 15-second visibility-gated pings to the service worker, which accumulates per-site time and enforces daily budgets.
- **Pomodoro phase alarm** — a one-shot alarm fires at each phase boundary for precise timing; a 1-minute fallback tick catches missed alarms after sleep.
- **Budget midnight reset** — the tick engine resets `blockedToday` flags and prunes usage data when the local date changes.
- **Zero dependencies** — vanilla HTML/CSS/JS. No npm, no bundler, no build step.
- **`chrome.storage.local`** — all state (settings, blocks, schedules, focus, budgets, delays, stats) lives here. Never `localStorage`, never cookies.

---

## Privacy

Everything is stored in `chrome.storage.local` on your device. There are no accounts, no analytics, no ads, no remote servers, and no data is sold or shared. Uninstalling the extension deletes all data.

Full details: [docs/PRIVACY.md](docs/PRIVACY.md) (also hosted at [getfocusd.tech/privacy](https://getfocusd.tech/privacy))

---

## Roadmap

- [ ] `chrome.storage.sync` multi-device sync
- [ ] JSON export/import of block lists and settings
- [ ] Custom block-page themes
- [ ] Focus soundscapes
- [ ] Allowlist mode (block everything except approved sites)
- [ ] Optional-permissions model (grant host access per-site)
- [ ] Firefox port

---

## Honest Limitation

A browser extension cannot stop a determined user from disabling it in `chrome://extensions`. GetFocusd adds **friction for impulses** — it is not a vault. The unlock barriers and sealed blocks are designed to give you a moment of pause, not to be cryptographically unbreakable.

---

## License

[MIT](LICENSE) © 2026 GetFocusd contributors
