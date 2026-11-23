/**
 * GetFocusd — YouTube Shorts cosmetic hider (content script).
 *
 * CLASSIC script — no import/export (content scripts are not ES modules).
 * Wrapped in an IIFE to avoid leaking globals into the page.
 *
 * NOTE: Actual /shorts/ navigation blocking (redirect to youtube.com) is done
 * by a declarativeNetRequest rule in the background service worker.
 * This script is PURELY COSMETIC — it hides Shorts UI elements that YouTube
 * renders in feeds, sidebar, and links.
 *
 * INTENTIONAL DUPLICATION: The constants below are duplicated from
 * src/shared/constants.js because content scripts cannot import ES modules.
 * Keep in sync manually.
 *
 * @module content/shorts
 */
(function () {
  "use strict";

  // ── Duplicated constants (from src/shared/constants.js) ──────────────
  /** Storage key for the settings object. */
  var STORAGE_KEY_SETTINGS = "settings";
  /** Field within settings that controls the Shorts blocker. */
  var SETTINGS_FIELD_SHORTS = "shortsBlocker";

  // ── State ─────────────────────────────────────────────────────────────
  /** Whether the blocker is currently active. */
  var active = false;
  /** The injected <style> element (null when inactive). */
  var styleEl = null;
  /** The MutationObserver instance (null when inactive). */
  var observer = null;
  /** Debounce timer id for the JS sweep. */
  var sweepTimer = null;

  // ── CSS (injected via <style>) ────────────────────────────────────────
  var CSS_RULES = [
    // Shorts shelf in feeds
    'ytd-rich-shelf-renderer:has(a[href^="/shorts/"]) { display:none !important; }',
    'ytd-rich-shelf-renderer:has(a[href*="youtube.com/shorts/"]) { display:none !important; }',
    // Sidebar / guide entries linking to /shorts/
    'ytd-guide-entry-renderer:has(a[href^="/shorts/"]) { display:none !important; }',
    'ytd-guide-entry-renderer:has(a[href*="youtube.com/shorts/"]) { display:none !important; }',
    'ytd-mini-guide-entry-renderer:has(a[href^="/shorts/"]) { display:none !important; }',
    'ytd-mini-guide-entry-renderer:has(a[href*="youtube.com/shorts/"]) { display:none !important; }',
    // Individual video/reel items that link to /shorts/
    'ytd-rich-item-renderer:has(a[href^="/shorts/"]) { display:none !important; }',
    'ytd-rich-item-renderer:has(a[href*="youtube.com/shorts/"]) { display:none !important; }',
    'ytd-video-renderer:has(a[href^="/shorts/"]) { display:none !important; }',
    'ytd-video-renderer:has(a[href*="youtube.com/shorts/"]) { display:none !important; }',
    // Standalone anchors (fallback — hide the anchor itself)
    'a[href^="/shorts/"] { display:none !important; }',
    'a[href*="youtube.com/shorts/"] { display:none !important; }',
  ].join("\n");

  // ── Selectors used by the JS sweep ───────────────────────────────────
  var ANCHOR_SELECTOR =
    'a[href^="/shorts/"], a[href*="youtube.com/shorts/"]';

  /**
   * Candidate container tags to try hiding, in order of preference.
   * The sweep walks up from each anchor to find the closest match.
   */
  var CONTAINER_TAGS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-guide-entry-renderer",
    "ytd-mini-guide-entry-renderer",
    "ytd-compact-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-grid-video-renderer",
  ];

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Find the closest ancestor (or self) matching one of the container tags.
   *
   * @param {Element} el - The anchor element to start from.
   * @returns {Element|null} The closest container, or null.
   */
  function closestContainer(el) {
    for (var i = 0; i < CONTAINER_TAGS.length; i++) {
      var found = el.closest(CONTAINER_TAGS[i]);
      if (found) return found;
    }
    return null;
  }

  /**
   * Hide an element by setting inline display:none.
   *
   * @param {Element} el
   */
  function hideEl(el) {
    if (el && el.style.display !== "none") {
      el.style.display = "none";
    }
  }

  /**
   * Show an element by removing inline display:none.
   *
   * @param {Element} el
   */
  function showEl(el) {
    if (el && el.style.display === "none") {
      el.style.display = "";
    }
  }

  /**
   * Perform a JS sweep: find all Shorts anchors and hide their containers
   * (or the anchors themselves as fallback). This is the fallback for
   * browsers/environments where :has() may not be fully reliable.
   */
  function sweep() {
    var anchors = document.querySelectorAll(ANCHOR_SELECTOR);
    for (var i = 0; i < anchors.length; i++) {
      var container = closestContainer(anchors[i]);
      hideEl(container || anchors[i]);
    }
  }

  /**
   * Debounced sweep — schedules a sweep after 50 ms, coalescing rapid
   * MutationObserver callbacks into a single pass.
   */
  function scheduleSweep() {
    if (sweepTimer !== null) return;
    sweepTimer = setTimeout(function () {
      sweepTimer = null;
      sweep();
    }, 50);
  }

  /**
   * Un-hide everything the sweep hid. Called when the toggle flips off.
   * We query the same anchor selector and restore the container/anchor.
   */
  function unsweep() {
    var anchors = document.querySelectorAll(ANCHOR_SELECTOR);
    for (var i = 0; i < anchors.length; i++) {
      var container = closestContainer(anchors[i]);
      showEl(container || anchors[i]);
    }
  }

  // ── Activate / Deactivate ─────────────────────────────────────────────

  /**
   * Activate the cosmetic blocker: inject CSS, run initial sweep, start
   * MutationObserver for SPA navigations and lazy-loaded content.
   */
  function activate() {
    if (active) return;
    active = true;

    // Inject <style>
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "getfocusd-shorts-css";
      styleEl.textContent = CSS_RULES;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    // Initial sweep
    sweep();

    // Start observer for SPA nav / lazy load
    if (!observer) {
      observer = new MutationObserver(function () {
        scheduleSweep();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
      });
    }
  }

  /**
   * Deactivate: remove style, stop observer, un-hide everything.
   */
  function deactivate() {
    if (!active) return;
    active = false;

    // Remove <style>
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
    styleEl = null;

    // Stop observer
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    // Cancel pending sweep
    if (sweepTimer !== null) {
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }

    // Un-hide
    unsweep();
  }

  // ── Storage listener ──────────────────────────────────────────────────

  /**
   * Handle chrome.storage.onChanged events — flip active state when the
   * shortsBlocker setting changes.
   *
   * @param {object} changes
   * @param {string} areaName
   */
  function onStorageChanged(changes, areaName) {
    if (areaName !== "local") return;
    var settingsChange = changes[STORAGE_KEY_SETTINGS];
    if (!settingsChange) return;
    var newVal =
      settingsChange.newValue &&
      settingsChange.newValue[SETTINGS_FIELD_SHORTS] === true;
    if (newVal) {
      activate();
    } else {
      deactivate();
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────

  /**
   * Entry point: read settings, activate if needed, subscribe to changes.
   * Never throws — wraps everything in try/catch.
   */
  function init() {
    try {
      chrome.storage.local.get(STORAGE_KEY_SETTINGS, function (result) {
        try {
          var settings = result && result[STORAGE_KEY_SETTINGS];
          if (settings && settings[SETTINGS_FIELD_SHORTS] === true) {
            activate();
          }
        } catch (e) {
          console.warn("[GetFocusd] shorts activation error:", e);
        }
      });

      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {
      console.warn("[GetFocusd] shorts init failed:", e);
    }
  }

  init();
})();
