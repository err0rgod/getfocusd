# GetFocusd — Privacy Policy

**Last updated:** November 2026
**Policy URL:** [https://getfocusd.tech/privacy](https://getfocusd.tech/privacy) *(must be live before store submission)*

GetFocusd is a browser extension that helps you stay focused by blocking distracting websites, timing focus sessions, enforcing daily budgets, and adding mindful pauses. This policy explains, in plain language, what data the extension handles and how.

---

## What is stored, and where

All data is stored exclusively in **`chrome.storage.local`** — a sandboxed storage area on your own device, managed by your browser. Nothing is transmitted anywhere.

| Data | Description |
|------|-------------|
| **Block list** | Domains you choose to block, with duration, reason, and expiry timestamps |
| **Schedules** | Recurring block windows: days of the week, start/end times, target domains |
| **Pomodoro config** | Focus list domains, work/break/cycle durations, and live session state |
| **Daily budgets** | Per-site daily time allowances, seconds used per day, and blocked-today flags |
| **Mindful-pause delays** | Domains that show a breathing-overlay pause, and the pause duration |
| **Settings** | Unlock mode preference, password hash (SHA-256, never plaintext), Shorts blocker toggle, notification toggle |
| **Usage stats** | Blocked-attempt counts per day and per domain, completed block totals, streak data, focus minutes, per-site active time |

---

## What GetFocusd does NOT do

- **No accounts** — there is nothing to sign up for.
- **No analytics** — no telemetry, no usage tracking, no crash reports sent anywhere.
- **No ads** — the extension contains no advertising.
- **No remote servers** — zero network requests are made by the extension.
- **No data sale or sharing** — your data never leaves your device, so there is nothing to sell or share.

---

## Permissions justification

| Permission | Why it is needed |
|-----------|-----------------|
| `declarativeNetRequestWithHostAccess` | Redirect blocked sites to the internal block page **before they load** — this is the core blocking mechanism |
| `host_permissions: <all_urls>` | Allows the DNR rules above to match any domain you choose to block |
| `storage` | Save your block list, schedules, Pomodoro config, budgets, delays, settings, and usage stats locally |
| `alarms` | Run the 1-minute tick that expires finished blocks, activates/deactivates schedules, resets budgets at midnight, and serves as a fallback for Pomodoro phase transitions; also fires the one-shot alarm at each Pomodoro phase boundary |
| `notifications` | Alert you when a block completes, a Pomodoro phase ends, or a daily budget is exhausted (only if enabled in settings) |
| Content script on all sites (`guard.js`) | Measures active viewing time on sites with daily budgets (15-second heartbeat pings, processed locally) and shows the mindful-pause overlay on delay-listed sites. All processing is local; nothing is transmitted. Data stays in `chrome.storage.local`. |
| Content script on youtube.com (`shorts.js`) | Cosmetically hides YouTube Shorts UI elements when the Shorts blocker toggle is enabled |

---

## Data deletion

Uninstalling the extension removes all stored data. There are no server-side copies because no data ever leaves your device.

---

## Contact

Questions or concerns? [Open a GitHub issue](https://github.com/your-username/getfocusd/issues).
