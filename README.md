# YT Watch Later & Queue Buttons Restorer

A Chrome/Chromium extension that brings back the **Watch Later** and **Add to Queue** buttons that YouTube removed from video thumbnails. Mostly vibecoded cuz I don't fw JS 🫶

## Features

- **Thumbnail buttons** — hover over any video to reveal Watch Later and Queue buttons in the top-right corner of the thumbnail
- **Inline preview buttons** — when a video starts playing inline on hover, the buttons appear in the preview player's controls row (alongside mute and captions)
- Works on the home feed, search results, sidebar, playlists, and channel pages
- Shorts get a Queue button only (Watch Later is skipped, matching YouTube's own behaviour)
- Hides automatically when YouTube's own overlay is present (e.g. already-queued videos)

## Supported languages

The extension detects YouTube's menu items by text, so it needs to know what "Watch Later" and "Add to Queue" are called in your language.

Currently supported:

| Language | Watch Later | Add to Queue |
|----------|-------------|--------------|
| English  | Save to Watch later | Add to queue |
| Polish   | Zapisz w sekcji Do obejrzenia | Dodaj do kolejki |

To add another language, open `src/inject.js` and extend the two patterns near the top:

```js
const WATCH_LATER_PATTERN = /watch.{0,6}later|obejrzeni/i;
const QUEUE_PATTERN       = /add.{0,10}queue|dodaj.{0,10}kolejk/i;
```

Add a `|your_translation` alternative to each regex (partial matches are fine).

## Installation

1. Clone or download this repository
2. Open Chrome/Chromium and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the repository folder

## How it works

The extension injects two scripts:

- **`content.js`** runs in the extension's isolated world — it watches for video card and preview player elements appearing in the DOM and injects the button UI
- **`inject.js`** runs in the page's JS context — it invisibly opens YouTube's native "More actions" menu, clicks the relevant item, then closes the menu, so the action goes through YouTube's own logic

This approach means Watch Later and Queue work exactly as they would through the native menu, with no API calls or workarounds needed.
