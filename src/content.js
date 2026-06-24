/**
 * content.js
 * Main content script for YT Watch Later & Queue Buttons Restorer.
 *
 * Responsibilities:
 *  - Inject inject.js into the page context to access YouTube's globals.
 *  - Observe DOM mutations to attach hover buttons to video thumbnails.
 *  - Inject Watch Later + Queue buttons into the inline preview player controls.
 *  - Bridge CustomEvents between inject.js (page context) and this script.
 *  - Display toast notifications.
 */

"use strict";

const LOG_PREFIX = "[YT WL+Queue]";

// ─── Page-context bridge ─────────────────────────────────────────────────────

/**
 * Injects inject.js into the page's script context so it can access
 * YouTube's internal globals (ytcfg, window.yt, etc.).
 */
function injectPageScript() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/inject.js");
    script.onload = () => script.remove();
    (document.head ?? document.documentElement).appendChild(script);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to inject page script:`, err);
  }
}

/**
 * Sends a message to inject.js (page context) via a CustomEvent.
 * @param {string} eventName
 * @param {object} detail
 */
function sendToPage(eventName, detail) {
  document.dispatchEvent(new CustomEvent(eventName, { detail }));
}

// ─── Listen for results from inject.js ──────────────────────────────────────

document.addEventListener("ytr:watchLaterResult", (e) => {
  const { ok, error } = e.detail ?? {};
  if (ok) {
    showToast("✓ Added to Watch Later");
  } else {
    console.warn(`${LOG_PREFIX} Watch Later failed:`, error);
    showToast("✗ Watch Later failed — see console", true);
  }
});

document.addEventListener("ytr:queueResult", (e) => {
  const { ok, error } = e.detail ?? {};
  if (ok) {
    showToast("✓ Added to Queue");
  } else {
    console.warn(`${LOG_PREFIX} Queue failed:`, error);
    showToast("✗ Queue unavailable — see console", true);
  }
});

// ─── Video ID extraction ─────────────────────────────────────────────────────

/**
 * Extracts a YouTube video ID from a URL string or href.
 * @param {string} href
 * @returns {string|null}
 */
function extractVideoId(href) {
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.youtube.com");
    const v = url.searchParams.get("v");
    if (v) return v;
    const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch {
    // Ignore malformed URLs
  }
  return null;
}

/**
 * Finds the video link anchor within a renderer, handling both the legacy
 * ytd-thumbnail/a#thumbnail structure and the new yt-thumbnail-view-model layout.
 * @param {Element} renderer
 * @returns {HTMLAnchorElement|null}
 */
function findThumbnailAnchor(renderer) {
  const legacy = renderer.querySelector("a#thumbnail, a.ytd-thumbnail");
  if (legacy) return legacy;

  const thumbModel = renderer.querySelector("yt-thumbnail-view-model");
  if (thumbModel) {
    const ancestor = thumbModel.closest("a[href]");
    if (ancestor) return ancestor;
  }

  return renderer.querySelector("a[href*='watch?v='], a[href*='/shorts/']");
}

/**
 * Finds the thumbnail container element to attach the overlay to.
 * @param {Element} renderer
 * @returns {Element|null}
 */
function findThumbnailContainer(renderer) {
  const thumbModel = renderer.querySelector("yt-thumbnail-view-model");
  if (thumbModel) return thumbModel;
  return renderer.querySelector("a#thumbnail, a.ytd-thumbnail");
}

/**
 * Extracts a video ID from a renderer element.
 * @param {Element} renderer
 * @returns {string|null}
 */
function getVideoIdFromRenderer(renderer) {
  const anchor = findThumbnailAnchor(renderer);
  if (!anchor) return null;
  return extractVideoId(anchor.href);
}

// ─── Thumbnail hover buttons ─────────────────────────────────────────────────

const QUEUE_SVG = `<path d="M2 2.864v6.277a.5.5 0 00.748.434L9 6.002 2.748 2.43A.5.5 0 002 2.864ZM21 5h-9a1 1 0 100 2h9a1 1 0 100-2Zm0 6H9a1 1 0 000 2h12a1 1 0 000-2Zm0 6H9a1 1 0 000 2h12a1 1 0 000-2Z"/>`;
const WL_SVG = `<path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 110 18.001A9 9 0 0112 3Zm0 3a1 1 0 00-1 1v5.565l.485.292 3.33 2a1 1 0 001.03-1.714L13 11.435V7a1 1 0 00-1-1Z"/>`;

/**
 * Creates a single absolutely-positioned button wrapper for injection into
 * yt-thumbnail-view-model, stacked top-right alongside YouTube's native overlay.
 * @param {string} videoId
 * @param {"queue"|"wl"} type
 * @param {string} title
 * @param {string} svgContent  – inner SVG path(s)
 * @param {number} topPx       – distance from top of thumbnail
 * @returns {HTMLElement}
 */
function createYTRButton(videoId, type, title, svgContent, topPx) {
  const wrap = document.createElement("div");
  wrap.className = "ytr-btn-wrap";
  wrap.style.top = topPx + "px";
  wrap.dataset.videoId = videoId;

  const btn = document.createElement("button");
  btn.className = "ytr-btn";
  btn.title = title;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${svgContent}</svg>`;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToPage(
      type === "queue" ? "ytr:addToQueue" : "ytr:addToWatchLater",
      { videoId }
    );
  });

  wrap.appendChild(btn);
  return wrap;
}

/**
 * Attaches hover buttons (Watch Later + Queue) to a video renderer element.
 *
 * Buttons are absolutely positioned inside yt-thumbnail-view-model, top-right:
 *   WL:    top: 8px
 *   Queue: top: 52px  (below WL: 8px + 40px button + 4px gap)
 *
 * Visibility is toggled via .ytr-hovered on the thumbnail container, driven by JS
 * mouseenter/mouseleave on the full renderer. CSS :hover cannot be used here because
 * YouTube's inline preview VIDEO element (in a separate DOM subtree) sits visually
 * on top of the thumbnail and steals pointer-events, breaking :hover.
 *
 * @param {Element} renderer
 */
function attachOverlayToRenderer(renderer) {
  if (renderer.dataset.ytrAttached) return;

  const videoId = getVideoIdFromRenderer(renderer);
  if (!videoId) return;

  const isShorts =
    renderer.tagName.toLowerCase() === "ytm-shorts-lockup-view-model" ||
    !!findThumbnailAnchor(renderer)?.href?.includes("/shorts/");

  const container = findThumbnailContainer(renderer);
  if (!container) return;

  // Prevent double-attach when both a parent renderer (e.g. ytd-rich-item-renderer)
  // and a child renderer (e.g. yt-lockup-view-model) match the selector list.
  if (container.querySelector(".ytr-btn-wrap")) return;

  // yt-thumbnail-view-model normally has position:relative from YouTube's own CSS.
  // Ensure it here as a safety net for edge-case containers.
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  const wlWrap = isShorts ? null : createYTRButton(videoId, "wl", "Save to Watch Later", WL_SVG, 8);
  const queueWrap = createYTRButton(videoId, "queue", "Add to Queue", QUEUE_SVG, 52);

  // Insert before YouTube's native overlay button to share the same DOM layer
  const nativeBtn = container.querySelector("thumbnail-overlay-button-view-model");
  const insertBefore = (el) => {
    if (nativeBtn) container.insertBefore(el, nativeBtn);
    else container.appendChild(el);
  };
  insertBefore(queueWrap);
  if (wlWrap) insertBefore(wlWrap);

  // JS hover on the full renderer (covers thumbnail + title area).
  // On mouseleave, re-check the actual cursor position via a chained mousemove
  // listener — the inline preview VIDEO fires a spurious mouseleave when it
  // steals pointer capture without the cursor actually having left the renderer.
  renderer.addEventListener("mouseenter", () => {
    container.classList.add("ytr-hovered");
  });
  renderer.addEventListener("mouseleave", () => {
    const checkAndHide = (e) => {
      const r = renderer.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top  && e.clientY <= r.bottom) {
        document.addEventListener("mousemove", checkAndHide, { once: true, passive: true });
      } else {
        container.classList.remove("ytr-hovered");
      }
    };
    document.addEventListener("mousemove", checkAndHide, { once: true, passive: true });
  });

  renderer.dataset.ytrAttached = "true";
}

// Selectors for all renderer types we handle — both legacy ytd-* elements
// and the newer yt-lockup-view-model system.
const RENDERER_SELECTORS = [
  "ytd-rich-item-renderer",
  "ytd-compact-video-renderer",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-playlist-video-renderer",
  "ytd-reel-item-renderer",
  "yt-lockup-view-model",
  "ytm-shorts-lockup-view-model",
].join(", ");

/**
 * Scans the document for video renderers and attaches overlays to any new ones.
 */
function attachAllOverlays() {
  document.querySelectorAll(RENDERER_SELECTORS).forEach(attachOverlayToRenderer);
}

// ─── Toast notifications ─────────────────────────────────────────────────────

let toastTimeout = null;

/**
 * Shows a brief toast notification in the bottom-right corner.
 * @param {string} message
 * @param {boolean} [isError=false]
 */
function showToast(message, isError = false) {
  let toast = document.getElementById("ytr-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "ytr-toast";
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.className = "ytr-toast" + (isError ? " ytr-toast--error" : "");
  toast.classList.add("ytr-toast--visible");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("ytr-toast--visible");
  }, 2500);
}

// ─── Inline preview player controls injection ─────────────────────────────────

/**
 * Watches for YouTube's inline-preview player controls bar to appear and
 * prepends our Watch Later + Queue buttons into it, matching the native
 * circle-button style (mute, captions).
 *
 * Controls bar structure:
 *   div.ytInlinePlayerControlsTopRightControls
 *     div.ytInlinePlayerControlsTopRightControlsCircleButton  ← mute
 *     div.ytInlinePlayerControlsTopRightControlsCircleButton  ← captions
 *
 * We prepend two more circle-button wrappers before those.
 * Video ID is read from ytd-video-preview a#media-container-link.
 */
function setupPreviewControlsObserver() {
  const makePreviewBtn = (videoId, type, title, svgContent) => {
    const wrap = document.createElement("div");
    wrap.className = "ytInlinePlayerControlsTopRightControlsCircleButton ytr-preview-btn";

    const iconWrap = document.createElement("div");
    iconWrap.className = "ytInlinePlayerControlsButtonIcon";

    const btn = document.createElement("button");
    btn.className = "ytr-btn";
    btn.title = title;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${svgContent}</svg>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendToPage(type === "queue" ? "ytr:addToQueue" : "ytr:addToWatchLater", { videoId });
    });

    iconWrap.appendChild(btn);
    wrap.appendChild(iconWrap);
    return wrap;
  };

  let hideTimer = null;

  const observer = new MutationObserver(() => {
    const controls = document.querySelector(".ytInlinePlayerControlsTopRightControls");

    if (controls) {
      clearTimeout(hideTimer);
      hideTimer = null;
      document.body.classList.add("ytr-preview-playing");

      // dataset flag set BEFORE DOM insertion to prevent re-entry when our own
      // insertBefore() triggers this observer again.
      if (!controls.dataset.ytrAttached) {
        controls.dataset.ytrAttached = "true";
        const link = document.querySelector("ytd-video-preview a#media-container-link");
        const videoId = link ? extractVideoId(link.href) : null;
        if (videoId) {
          const isShorts = link.href.includes("/shorts/");
          // Prepend in reverse order so WL ends up first (topmost)
          controls.insertBefore(makePreviewBtn(videoId, "queue", "Add to Queue", QUEUE_SVG), controls.firstChild);
          if (!isShorts) {
            controls.insertBefore(makePreviewBtn(videoId, "wl", "Save to Watch Later", WL_SVG), controls.firstChild);
          }
        }
      }
    } else {
      // Debounce: YouTube briefly removes the controls row during playback
      // transitions. Wait 400ms before restoring thumbnail button visibility.
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (!document.querySelector(".ytInlinePlayerControlsTopRightControls")) {
            document.body.classList.remove("ytr-preview-playing");
          }
        }, 400);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── MutationObserver ────────────────────────────────────────────────────────

/**
 * Watches for DOM additions (YouTube is a SPA) and re-runs overlay attachment.
 */
function startObserver() {
  const observer = new MutationObserver((mutations) => {
    let needsScan = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          needsScan = true;
          break;
        }
      }
      if (needsScan) break;
    }
    if (needsScan) {
      attachAllOverlays();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Route change detection ──────────────────────────────────────────────────

// YouTube uses history.pushState for SPA navigation.
const _originalPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  _originalPushState(...args);
  onRouteChange();
};

window.addEventListener("popstate", onRouteChange);

function onRouteChange() {
  // Brief delay for YouTube to render the new page's DOM
  setTimeout(attachAllOverlays, 800);
}

// ─── Init ────────────────────────────────────────────────────────────────────

function init() {
  console.log(`${LOG_PREFIX} Initialised.`);
  injectPageScript();
  attachAllOverlays();
  setupPreviewControlsObserver();
  startObserver();
}

if (document.body) {
  init();
} else {
  document.addEventListener("DOMContentLoaded", init);
}
