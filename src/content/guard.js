/**
 * GetFocusd — heartbeat time tracker + mindful-pause delay overlay.
 *
 * CLASSIC script — no import/export (content scripts are not ES modules).
 * Wrapped in an IIFE to avoid leaking globals into the page.
 *
 * Two independent duties (contract §7b/§9):
 *   1. Heartbeat — every 15 s while the tab is visible, send a HEARTBEAT
 *      message to the service worker so it can accumulate per-site time and
 *      enforce daily budgets.
 *   2. Delay overlay — if the current hostname matches a domain in
 *      `delays.domains`, show a full-viewport "mindful pause" overlay with a
 *      breathing circle and countdown before the user may continue.
 *
 * Runs on all http/https pages at document_start, top frame only.
 *
 * INTENTIONAL DUPLICATION: The constants below are duplicated from
 * src/shared/constants.js because content scripts cannot import ES modules.
 * Keep in sync manually.
 *
 * @module content/guard
 */
(function () {
  "use strict";

  // ── Duplicated constants (from src/shared/constants.js) ──────────────
  /** Storage key for the delays object. */
  var STORAGE_KEY_DELAYS = "delays";
  /** Message type sent to the service worker on each heartbeat tick. */
  var MSG_HEARTBEAT = "HEARTBEAT";
  /** Default delay seconds when delays.seconds is missing/invalid. */
  var DEFAULT_DELAY_SECONDS = 15;
  /** Heartbeat interval in milliseconds. */
  var HEARTBEAT_INTERVAL_MS = 15000;

  // ── Shared state ──────────────────────────────────────────────────────
  /** Normalized hostname for this page (lowercase, one leading www stripped). */
  var hostname = normalizeHostname(location.hostname);
  /** Whether this page's hostname is valid (contains a dot). */
  var hostnameValid = hostname !== null;

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Normalize a hostname: lowercase and strip ONE leading "www.".
   *
   * @param {string} raw - The raw hostname from location.hostname.
   * @returns {string|null} The normalized hostname, or null if it has no dot.
   */
  function normalizeHostname(raw) {
    var h = (raw || "").toLowerCase();
    if (h.indexOf("www.") === 0) {
      h = h.slice(4);
    }
    return h.indexOf(".") !== -1 ? h : null;
  }

  /**
   * Check if the normalized hostname matches a delay-list domain.
   * Matches exactly or as a subdomain (host === d || host.endsWith("." + d)).
   *
   * @param {string} host - Normalized hostname.
   * @param {string} domain - Domain from delays.domains.
   * @returns {boolean}
   */
  function domainMatches(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  // ═════════════════════════════════════════════════════════════════════
  // Duty 1: Heartbeat time tracker
  // ═════════════════════════════════════════════════════════════════════

  /** The setInterval id for the heartbeat (null when stopped). */
  var heartbeatTimer = null;

  /**
   * Send a single heartbeat message to the service worker.
   * Fire-and-forget — never throws.
   */
  function sendHeartbeat() {
    if (!hostnameValid) return;
    try {
      chrome.runtime
        .sendMessage({ type: MSG_HEARTBEAT, domain: hostname, sec: 15 })
        .catch(function () {
          // SW may be starting or reloaded — ignore.
        });
    } catch (e) {
      // Never throw.
    }
  }

  /**
   * Start the heartbeat interval. Only ticks when document is visible.
   */
  function startHeartbeat() {
    if (heartbeatTimer !== null || !hostnameValid) return;
    heartbeatTimer = setInterval(function () {
      if (document.visibilityState === "visible") {
        sendHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat interval.
   */
  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // Duty 2: Delay overlay ("mindful pause")
  // ═════════════════════════════════════════════════════════════════════

  /** The overlay root element (null when not shown). */
  var overlayEl = null;
  /** Countdown interval id for the overlay. */
  var countdownTimer = null;
  /** Current delay configuration. */
  var delaysConfig = null;
  /** Whether the overlay has already been shown for this page load. */
  var overlayShownThisPageLoad = false;

  /**
   * Check whether the current hostname matches any domain in the delays list.
   *
   * @returns {boolean}
   */
  function isDelayed() {
    if (!hostnameValid || !delaysConfig || !Array.isArray(delaysConfig.domains)) {
      return false;
    }
    for (var i = 0; i < delaysConfig.domains.length; i++) {
      if (domainMatches(hostname, delaysConfig.domains[i])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remove the overlay if present and clean up the countdown timer.
   */
  function removeOverlay() {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
  }

  /**
   * Show the mindful-pause overlay: dark veil, breathing circle, countdown,
   * then a "Continue" button. Only shows once per page load.
   */
  function showOverlay() {
    if (overlayShownThisPageLoad || overlayEl) return;
    overlayShownThisPageLoad = true;

    try {
      var seconds =
        delaysConfig && typeof delaysConfig.seconds === "number"
          ? delaysConfig.seconds
          : DEFAULT_DELAY_SECONDS;

      // ── Build DOM ────────────────────────────────────────────────
      overlayEl = document.createElement("div");
      overlayEl.id = "getfocusd-delay-overlay";
      overlayEl.setAttribute(
        "style",
        "position:fixed !important;" +
          "inset:0 !important;" +
          "z-index:2147483647 !important;" +
          "display:flex !important;" +
          "align-items:center !important;" +
          "justify-content:center !important;" +
          "flex-direction:column !important;" +
          "background:rgba(15,23,42,0.97) !important;" +
          "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif !important;" +
          "color:#e2e8f0 !important;" +
          "transition:opacity 0.3s ease !important;"
      );

      // Breathing circle
      var circle = document.createElement("div");
      circle.setAttribute(
        "style",
        "width:120px;height:120px;border-radius:50%;" +
          "background:radial-gradient(circle,#6366f1 0%,#1e293b 70%);" +
          "margin-bottom:32px;" +
          "animation:getfocusd-breathe " + seconds + "s ease-in-out infinite;"
      );
      overlayEl.appendChild(circle);

      // Inject keyframes
      var style = document.createElement("style");
      style.textContent =
        "@keyframes getfocusd-breathe{" +
        "0%,100%{transform:scale(0.7);opacity:0.5;}" +
        "50%{transform:scale(1);opacity:1;}}";
      overlayEl.appendChild(style);

      // Heading
      var heading = document.createElement("div");
      heading.textContent = "Take a breath";
      heading.setAttribute(
        "style",
        "font-size:24px;font-weight:600;margin-bottom:8px;"
      );
      overlayEl.appendChild(heading);

      // Countdown text
      var countdownEl = document.createElement("div");
      countdownEl.setAttribute(
        "style",
        "font-size:48px;font-weight:700;color:#6366f1;margin-bottom:24px;min-height:60px;"
      );
      overlayEl.appendChild(countdownEl);

      // Continue button (hidden initially)
      var btn = document.createElement("button");
      btn.textContent = "Continue";
      btn.setAttribute(
        "style",
        "padding:12px 32px;font-size:16px;font-weight:600;" +
          "background:#6366f1;color:#fff;border:none;border-radius:12px;" +
          "cursor:pointer;display:none;outline:none;" +
          "transition:background 0.2s;"
      );
      btn.addEventListener("mouseenter", function () {
        btn.style.background = "#818cf8";
      });
      btn.addEventListener("mouseleave", function () {
        btn.style.background = "#6366f1";
      });
      btn.addEventListener("click", function () {
        removeOverlay();
      });
      overlayEl.appendChild(btn);

      // Append to body (or documentElement if body missing)
      var parent = document.body || document.documentElement;
      parent.appendChild(overlayEl);

      // ── Countdown ────────────────────────────────────────────────
      var remaining = seconds;
      countdownEl.textContent = String(remaining);

      countdownTimer = setInterval(function () {
        remaining--;
        if (remaining <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          countdownEl.style.display = "none";
          heading.textContent = "You may continue";
          btn.style.display = "inline-block";
        } else {
          countdownEl.textContent = String(remaining);
        }
      }, 1000);
    } catch (e) {
      // Never break the page.
      removeOverlay();
    }
  }

  // ── Storage listener ──────────────────────────────────────────────────

  /**
   * Handle chrome.storage.onChanged — re-evaluate delay config and show/hide
   * overlay as needed.
   *
   * @param {object} changes
   * @param {string} areaName
   */
  function onStorageChanged(changes, areaName) {
    if (areaName !== "local") return;
    var change = changes[STORAGE_KEY_DELAYS];
    if (!change) return;
    try {
      delaysConfig = change.newValue || null;
      if (isDelayed() && !overlayShownThisPageLoad) {
        showOverlay();
      } else if (!isDelayed()) {
        removeOverlay();
      }
    } catch (e) {
      // Never break the page.
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────

  /**
   * Entry point: start heartbeat, read delays config, subscribe to changes.
   * Never throws.
   */
  function init() {
    try {
      // Duty 1: heartbeat
      startHeartbeat();

      // Clean up heartbeat on page unload
      window.addEventListener("pagehide", function () {
        stopHeartbeat();
      });

      // Duty 2: delay overlay — read current config
      chrome.storage.local.get(STORAGE_KEY_DELAYS, function (result) {
        try {
          delaysConfig = (result && result[STORAGE_KEY_DELAYS]) || null;
          if (isDelayed()) {
            // If body isn't ready yet, wait for DOMContentLoaded
            if (document.body) {
              showOverlay();
            } else {
              document.addEventListener(
                "DOMContentLoaded",
                function () {
                  showOverlay();
                },
                { once: true }
              );
            }
          }
        } catch (e) {
          // Never break the page.
        }
      });

      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {
      // Never break the page.
    }
  }

  init();
})();
