/**
 * GetFocusd — Marketing site scripts
 * Countdown timer, FAQ accordion, scroll reveal, mobile nav.
 */
(function () {
  "use strict";

  /* ============================================================
     1. Live countdown on the hero mock block page
     ============================================================ */
  var countdownEl = document.getElementById("mock-countdown");

  if (countdownEl) {
    var hoursEl = countdownEl.querySelector("[data-hours]");
    var minutesEl = countdownEl.querySelector("[data-minutes]");
    var secondsEl = countdownEl.querySelector("[data-seconds]");

    // Start at 2h 14m 33s (matches the design)
    var totalSeconds = 2 * 3600 + 14 * 60 + 33;

    function tick() {
      var h = Math.floor(totalSeconds / 3600);
      var m = Math.floor((totalSeconds % 3600) / 60);
      var s = totalSeconds % 60;

      if (hoursEl) hoursEl.textContent = h;
      if (minutesEl) minutesEl.textContent = m < 10 ? "0" + m : String(m);
      if (secondsEl) secondsEl.textContent = s < 10 ? "0" + s : String(s);

      if (totalSeconds > 0) {
        totalSeconds--;
      } else {
        // Loop back for demo purposes
        totalSeconds = 2 * 3600 + 14 * 60 + 33;
      }
    }

    tick();
    setInterval(tick, 1000);
  }

  /* ============================================================
     2. FAQ accordion (aria-expanded toggle)
     ============================================================ */
  var faqButtons = document.querySelectorAll(".faq__question");

  faqButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var item = btn.closest(".faq__item");
      var isOpen = item.hasAttribute("data-open");

      // Close all others
      document.querySelectorAll(".faq__item[data-open]").forEach(function (other) {
        other.removeAttribute("data-open");
        other.querySelector(".faq__question").setAttribute("aria-expanded", "false");
      });

      // Toggle current
      if (!isOpen) {
        item.setAttribute("data-open", "");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ============================================================
     3. Scroll-reveal animation (IntersectionObserver)
     ============================================================ */
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!prefersReducedMotion && "IntersectionObserver" in window) {
    var revealEls = document.querySelectorAll(".reveal");

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal--visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );

    revealEls.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Show everything immediately
    document.querySelectorAll(".reveal").forEach(function (el) {
      el.classList.add("reveal--visible");
    });
  }

  /* ============================================================
     4. Theme toggle — dark / light / auto
     ============================================================ */
  var themeToggle = document.getElementById("theme-toggle");

  function getTheme() {
    var saved = null;
    try { saved = localStorage.getItem("gf-theme"); } catch (e) { /* private mode */ }
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", theme === "dark" ? "false" : "true");
    }
  }

  applyTheme(getTheme());

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem("gf-theme", next); } catch (e) { /* private mode */ }
    });
  }

  // React to OS-level changes when no explicit preference is saved
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function (e) {
      var saved = null;
      try { saved = localStorage.getItem("gf-theme"); } catch (err) { /* ignore */ }
      if (!saved) applyTheme(e.matches ? "light" : "dark");
    });
  } catch (e) { /* older browsers */ }

  /* ============================================================
     5. Mobile nav toggle — sync aria-expanded
     ============================================================ */
  var navToggleInput = document.getElementById("nav-toggle");
  var navToggleLabel = document.querySelector(".nav__toggle");

  if (navToggleInput && navToggleLabel) {
    navToggleInput.addEventListener("change", function () {
      navToggleLabel.setAttribute("aria-expanded", navToggleInput.checked ? "true" : "false");
    });

    // Close menu when a link is clicked
    var navLinks = document.querySelectorAll(".nav__links a");
    navLinks.forEach(function (link) {
      link.addEventListener("click", function () {
        navToggleInput.checked = false;
        navToggleLabel.setAttribute("aria-expanded", "false");
      });
    });
  }
})();
