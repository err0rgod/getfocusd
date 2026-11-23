/**
 * GetFocusd — shared constants.
 *
 * Single source of truth for storage keys, message types, rule-id ranges,
 * preset data and motivational quotes. Imported by the service worker and all
 * extension pages (ES modules). Content scripts CANNOT import this file —
 * they duplicate the tiny pieces they need (see src/content/).
 *
 * @module shared/constants
 */

/** chrome.storage.local top-level keys. */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "settings",
  BLOCKS: "blocks",
  SCHEDULES: "schedules",
  FOCUS: "focus",
  BUDGETS: "budgets",
  DELAYS: "delays",
  STATS: "stats",
  META: "meta",
});

/** chrome.runtime.sendMessage `type` values (see docs/ARCHITECTURE.md §6). */
export const MSG = Object.freeze({
  GET_STATE: "GET_STATE",
  ADD_BLOCK: "ADD_BLOCK",
  REMOVE_BLOCK: "REMOVE_BLOCK",
  VERIFY_UNLOCK: "VERIFY_UNLOCK",
  ADD_SCHEDULE: "ADD_SCHEDULE",
  REMOVE_SCHEDULE: "REMOVE_SCHEDULE",
  TOGGLE_SCHEDULE: "TOGGLE_SCHEDULE",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  SET_PASSWORD: "SET_PASSWORD",
  CLEAR_PASSWORD: "CLEAR_PASSWORD",
  RECORD_ATTEMPT: "RECORD_ATTEMPT",
  BLOCK_TAB: "BLOCK_TAB",
  START_FOCUS: "START_FOCUS",
  STOP_FOCUS: "STOP_FOCUS",
  UPDATE_FOCUS_CONFIG: "UPDATE_FOCUS_CONFIG",
  ADD_BUDGET: "ADD_BUDGET",
  REMOVE_BUDGET: "REMOVE_BUDGET",
  UPDATE_DELAYS: "UPDATE_DELAYS",
  HEARTBEAT: "HEARTBEAT",
});

/** Reserved declarativeNetRequest rule id for the YouTube Shorts redirect. */
export const RULE_ID_SHORTS = 1;

/** First id handed out to blocks/schedules/focus/budgets. */
export const RULE_ID_START = 100;

/** Repeating 1-minute alarm driving the scheduler tick. */
export const ALARM_TICK = "getfocusd:tick";

/** One-shot alarm marking the end of a Pomodoro phase. */
export const ALARM_PHASE = "getfocusd:phase";

/** Unlock-barrier modes stored in settings.unlockMode. */
export const UNLOCK_MODE = Object.freeze({
  CHALLENGE: "challenge",
  PASSWORD: "password",
});

/** Default settings written on first install. */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  unlockMode: UNLOCK_MODE.CHALLENGE,
  passwordHash: null,
  shortsBlocker: false,
  notifications: true,
  theme: "dark",
});

/**
 * Default Pomodoro configuration. focusList starts with classic distractions
 * so the timer works out of the box; users edit it in the dashboard.
 */
export const DEFAULT_FOCUS = Object.freeze({
  version: 1,
  focusList: ["youtube.com", "reddit.com", "x.com", "instagram.com", "tiktok.com", "facebook.com"],
  workMin: 25,
  breakMin: 5,
  cycles: 4,
  session: null,
});

/** Default mindful-pause configuration: no domains, 15-second pause. */
export const DEFAULT_DELAYS = Object.freeze({ domains: [], seconds: 15 });

/** Validation bounds for Pomodoro configuration. */
export const FOCUS_LIMITS = Object.freeze({
  MIN_WORK: 5, MAX_WORK: 120,
  MIN_BREAK: 1, MAX_BREAK: 60,
  MIN_CYCLES: 1, MAX_CYCLES: 12,
});

/** Validation bounds for daily budgets (minutes). */
export const BUDGET_LIMITS = Object.freeze({ MIN: 1, MAX: 720 });

/** Allowed mindful-pause durations (seconds). */
export const DELAY_PRESETS = Object.freeze([10, 15, 30, 60]);

/** Quick-pick block durations (minutes) offered in popup & options. */
export const DURATION_PRESETS = Object.freeze([15, 30, 60, 120, 240, 480, 1440]);

/** Upper bound for a custom block duration: 7 days in minutes. */
export const MAX_DURATION_MIN = 10080;

/**
 * One-click preset domains for the "add block" form, grouped by category.
 * Domains are stored normalized (no protocol, no leading "www.").
 */
export const PRESET_DOMAINS = Object.freeze([
  { category: "Social", domains: ["facebook.com", "instagram.com", "x.com", "tiktok.com", "reddit.com", "snapchat.com", "linkedin.com", "pinterest.com"] },
  { category: "Video", domains: ["youtube.com", "netflix.com", "twitch.tv", "hulu.com", "primevideo.com"] },
  { category: "News", domains: ["news.ycombinator.com", "cnn.com", "bbc.com", "nytimes.com"] },
  { category: "Games", domains: ["store.steampowered.com", "epicgames.com", "roblox.com"] },
]);

/**
 * Motivational quotes shown on the block page and used (random pick) as the
 * typing-challenge sentence. Keep them single-sentence, punctuation-light
 * enough to type, and attributions accurate.
 */
export const QUOTES = Object.freeze([
  { text: "The successful warrior is the average man with laser-like focus.", author: "Bruce Lee" },
  { text: "Focus is a matter of deciding what things you are not going to do.", author: "John Carmack" },
  { text: "It is during our darkest moments that we must focus to see the light.", author: "Aristotle Onassis" },
  { text: "Concentrate all your thoughts upon the work in hand. The sun's rays do not burn until brought to a focus.", author: "Alexander Graham Bell" },
  { text: "Lack of direction, not lack of time, is the problem. We all have twenty-four hour days.", author: "Zig Ziglar" },
  { text: "You will never reach your destination if you stop and throw stones at every dog that barks.", author: "Winston Churchill" },
  { text: "The cost of a thing is the amount of life which is required to be exchanged for it.", author: "Henry David Thoreau" },
  { text: "Where focus goes, energy flows.", author: "Tony Robbins" },
  { text: "Do the hard jobs first. The easy jobs will take care of themselves.", author: "Dale Carnegie" },
  { text: "Lost time is never found again.", author: "Benjamin Franklin" },
  { text: "Amateurs sit and wait for inspiration. The rest of us just get up and go to work.", author: "Stephen King" },
  { text: "Either you run the day or the day runs you.", author: "Jim Rohn" },
  { text: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
  { text: "Your future is created by what you do today, not tomorrow.", author: "Robert Kiyosaki" },
  { text: "Action is the foundational key to all success.", author: "Pablo Picasso" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Will Durant" },
  { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
  { text: "What gets measured gets managed.", author: "Peter Drucker" },
  { text: "The best time to plant a tree was twenty years ago. The second best time is now.", author: "Chinese proverb" },
]);

/** Day labels indexed by Date.getDay() (0 = Sunday). Used by schedule UI. */
export const DAY_LABELS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
