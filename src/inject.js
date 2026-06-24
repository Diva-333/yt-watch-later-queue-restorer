/**
 * inject.js
 * Runs in the page's JavaScript context (not the extension's isolated world).
 * Communicates results back to the content script via CustomEvents.
 */

(function () {
  "use strict";

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function reply(eventName, detail) {
    document.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  // ─── Menu infrastructure ─────────────────────────────────────────────────────

  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-compact-video-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "yt-lockup-view-model",
    "ytm-shorts-lockup-view-model",
  ].join(", ");

  /**
   * Finds the "More actions" button for a video by locating its card element
   * and querying within that bounded scope.
   *
   * The button is matched STRUCTURALLY rather than by its (localized) title /
   * aria-label, so it works regardless of YouTube's interface language. The
   * localized English label is kept as a first, fast match; structural
   * fallbacks cover every other language (Polish, etc.) and both layouts.
   * @param {string} videoId
   * @returns {HTMLButtonElement|null}
   */
  function findMenuButtonForVideo(videoId) {
    const linkSelector = `a[href*="v=${videoId}"], a[href*="/shorts/${videoId}"]`;
    for (const card of document.querySelectorAll(CARD_SELECTORS)) {
      if (!card.querySelector(linkSelector)) continue;

      const btn =
        // English UI — localized label (fast path, kept for back-compat)
        card.querySelector(
          "button[title='More actions'], button[aria-label='More actions']"
        ) ||
        // Legacy ytd-* cards: the overflow menu lives in ytd-menu-renderer
        card.querySelector("ytd-menu-renderer button") ||
        // Most overflow triggers expose a popup — language-independent
        card.querySelector("button[aria-haspopup='true']") ||
        // New lockup view-model layout (class-based, may vary)
        card.querySelector(".yt-lockup-metadata-view-model-wiz__menu button") ||
        // New lockup view-model layout (element-based, more reliable)
        card.querySelector("yt-lockup-metadata-view-model button-view-model button") ||
        // Generic icon-button fallback
        card.querySelector("yt-icon-button button");

      if (btn) return btn;
    }
    return null;
  }

  /**
   * Polls for a menu item whose text matches the given pattern, only finding
   * items that appear after this call (never resolves immediately to avoid
   * picking up a stale open menu).
   * @param {RegExp} pattern
   * @param {number} timeoutMs
   * @returns {Promise<Element|null>}
   */
  function waitForMenuItem(pattern, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const interval = setInterval(() => {
        // Only search within the open popup — never the full document.
        // Pre-existing page elements (sidebar "Watch later", guide entries, etc.)
        // match the same selectors and text patterns, causing false clicks.
        // New YT layout: items live in yt-list-view-model inside tp-yt-iron-dropdown.
        // Legacy layout: items live in ytd-menu-popup-renderer.
        const popup =
          document.querySelector("tp-yt-iron-dropdown yt-list-view-model") ||
          document.querySelector("ytd-menu-popup-renderer");
        if (!popup) {
          // Popup not in DOM yet — keep waiting
          if (Date.now() > deadline) { clearInterval(interval); resolve(null); }
          return;
        }
        const candidates = popup.querySelectorAll(
          "ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model"
        );
        for (const el of candidates) {
          if (pattern.test(el.textContent)) {
            clearInterval(interval);
            resolve(el);
            return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(interval);
          resolve(null);
        }
      }, 50);
    });
  }

  /**
   * Opens the "More actions" menu for a video invisibly, clicks the menu item
   * matching the given pattern, then closes the menu.
   * @param {string} videoId
   * @param {RegExp} itemPattern
   * @returns {Promise<boolean>}
   */
  async function clickMenuItemForVideo(videoId, itemPattern) {
    const menuBtn = findMenuButtonForVideo(videoId);
    if (!menuBtn) return false;

    // Intercept the popup as soon as it appears and hide it from the user.
    let popup = null;
    const observer = new MutationObserver(() => {
      const el = document.querySelector(
        "tp-yt-iron-dropdown:not([aria-hidden='true']), ytd-menu-popup-renderer"
      );
      if (el && !popup) {
        popup = el;
        popup.style.opacity = "0";
        popup.style.pointerEvents = "none";
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden"],
    });

    menuBtn.click();

    const menuItem = await waitForMenuItem(itemPattern, 1500);
    observer.disconnect();

    const restore = () => {
      if (popup) {
        popup.style.opacity = "";
        popup.style.pointerEvents = "";
      }
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    };

    if (!menuItem) {
      restore();
      return false;
    }

    menuItem.click();
    restore();
    return true;
  }

  // ─── Localized menu-item patterns (EN | PL) ──────────────────────────────────
  // textContent of the menu item is matched against these. Add more languages
  // here with extra `|alternatives` as needed.
  //
  //   Watch later  →  EN "Save to Watch later" / PL "Zapisz w sekcji Do obejrzenia"
  //   Add to queue →  EN "Add to queue"         / PL "Dodaj do kolejki"
  const WATCH_LATER_PATTERN = /watch.{0,6}later|obejrzeni/i;
  const QUEUE_PATTERN = /add.{0,10}queue|dodaj.{0,10}kolejk/i;

  // ─── Queue ───────────────────────────────────────────────────────────────────

  async function addToQueue(videoId) {
    try {
      const ok = await clickMenuItemForVideo(videoId, QUEUE_PATTERN);
      if (ok) {
        reply("ytr:queueResult", { ok: true, videoId });
      } else {
        reply("ytr:queueResult", {
          ok: false,
          videoId,
          error: "Could not find the video\u2019s menu in the page.",
        });
      }
    } catch (err) {
      reply("ytr:queueResult", { ok: false, videoId, error: err.message });
    }
  }

  // ─── Watch Later ─────────────────────────────────────────────────────────────

  async function addToWatchLater(videoId) {
    try {
      const ok = await clickMenuItemForVideo(videoId, WATCH_LATER_PATTERN);
      if (ok) {
        reply("ytr:watchLaterResult", { ok: true, videoId });
      } else {
        reply("ytr:watchLaterResult", {
          ok: false,
          videoId,
          error: "Could not find the video\u2019s menu in the page.",
        });
      }
    } catch (err) {
      reply("ytr:watchLaterResult", { ok: false, videoId, error: err.message });
    }
  }

  // ─── Event listeners (from content script) ──────────────────────────────────

  document.addEventListener("ytr:addToWatchLater", (e) => {
    addToWatchLater(e.detail?.videoId);
  });

  document.addEventListener("ytr:addToQueue", (e) => {
    addToQueue(e.detail?.videoId);
  });
})();