# AGENTS.md — GetFocusd

Guidance for AI agents (and humans) working in this repository. Read this file
first; read `docs/ARCHITECTURE.md` before touching any extension code.

## What this is

**GetFocusd** (getfocusd.tech) is a Manifest V3 Chrome extension that blocks
distracting websites: sealed timed blocks with unlock barriers, a Pomodoro
focus timer, daily per-site time budgets, mindful-pause delays, a YouTube
Shorts blocker, and local-only insights. `website/` is the static marketing
site + hosted privacy policy.

## Repository layout

```
manifest.json          MV3 manifest (root-owned)
AGENTS.md              this file
docs/ARCHITECTURE.md   THE CONTRACT — storage schema, DNR rules, message API.
                       Single source of truth; update it whenever behavior changes.
docs/PRIVACY.md        privacy policy source (mirrored to website/privacy.html)
src/shared/            constants.js + utils.js — root-owned shared ES modules;
                       every other module imports from here; extend, don't fork
src/background/        ES-module service worker (storage, DNR blocker, stats,
                       scheduler tick, focus Pomodoro machine, budgets)
src/options/           dashboard page (Blocks/Focus/Limits/Schedules/Insights/Settings)
src/popup/             toolbar popup (quick block + focus controls)
src/blocked/           redirect target block page (t=block|schedule|focus|budget)
src/content/           classic scripts (no imports!): guard.js (heartbeat +
                       delay overlay), shorts.js (YouTube cosmetic hiding)
assets/icons/          generated icons (PIL script in git history / regenerate
                       with Python + Pillow if needed)
website/               static site (index, privacy, styles, main.js, CNAME) —
                       no build step; deployed to GitHub Pages via Actions
.github/workflows/     deploy-pages.yml (publishes website/ on push to main)
```

## Hard rules (violations break the build or the store review)

1. **The contract is law.** Any change to storage keys, message types, DNR rule
   shapes, or page responsibilities must be made in `docs/ARCHITECTURE.md`
   FIRST, then in code.
2. **No dependencies, no build step.** Vanilla ES2022 only. Never add npm
   packages, bundlers, CDNs, remote fonts, or remote code — CWS forbids
   remotely hosted code and the brand is "100% local".
3. **Content scripts are classic scripts.** `src/content/*.js` must not use
   `import`/`export`; duplicate tiny constants inline with a comment.
4. **Storage of truth.** All persistent state goes through
   `src/background/storage.js` into `chrome.storage.local` — never
   `localStorage`, never ad-hoc `chrome.storage` calls from other modules.
5. **Every mutation flows through the service worker** via the message API
   (§6 of the contract). Pages never write storage directly.
6. **CSP-safe UI:** no inline event handlers, no `innerHTML` with user data
   (use `textContent` / `utils.escapeHtml`), no `eval`.
7. **JSDoc on exported functions**; comment the "why", not the "what".
8. **Syntax check before finishing:** run `node --check` on every JS file you
   touched (Node 24 auto-detects ESM; on older Node, copy to `.mjs` first).
9. **Naming:** the product is "GetFocusd" everywhere in user-facing strings and
   log prefixes (`[GetFocusd]`).

## Common commands

```powershell
# syntax-check all extension + website JS
Get-ChildItem -Recurse src,website -Filter *.js | ForEach-Object { node --check $_.FullName }

# validate manifest
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"

# manual test: chrome://extensions → Developer mode → Load unpacked → select repo root
```

## Manual smoke-test checklist (run before every store submission)

- Add a block from the popup → site redirects to block page before loading;
  countdown matches the chosen duration; early removal requires the barrier.
- Expiry auto-unblocks within ~60 s (tick) and fires a notification.
- Start a focus session → focus-list sites blocked during work, free during
  break, session survives a browser restart.
- Set a 1-minute budget on a test domain, browse it ~1 min → blocked until
  midnight with the budget layout.
- Delay list entry shows the breathing overlay once per page load.
- Shorts toggle redirects youtube.com/shorts/* and hides Shorts UI.
- Insights tab shows attempts, streak, focus minutes, time-on-sites.

## Release flow

1. Bump `version` in `manifest.json` (semver).
2. Run the smoke-test checklist on a clean profile.
3. Zip the repo root EXCLUDING `website/`, `docs/`, `.github/`, `AGENTS.md`,
   `README.md`, `LICENSE` (store package = runtime files only).
4. Upload to the Chrome Web Store dashboard; update listing copy/screenshots;
   privacy policy URL = https://getfocusd.tech/privacy.
5. After publish, replace the `TODO` CWS placeholder links in `website/`.

## Git workflow

- `main` is the default branch; the site auto-deploys from pushes touching
  `website/**` (GitHub Actions → Pages, custom domain via `website/CNAME`).
- Commit atomically; do not commit `node_modules`, zip artifacts, or secrets
  (see `.gitignore`).

## Known limitations (do not "fix" by overpromising)

- Chrome does not allow extensions to prevent their own removal. GetFocusd is
  a friction device; UI and marketing copy must never claim it is unremovable.
- `chrome.alarms` has a 1-minute minimum period — budget/schedule edges are
  accurate to ~1 min (the Pomodoro phase alarm is exact; tick is fallback).
- DNR `extensionPath` redirects carry display params in the query string —
  keep `src/blocked/blocked.html` in `web_accessible_resources` if renamed.
