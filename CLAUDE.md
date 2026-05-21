# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome Manifest V3 extension ("网页内容一键摘要器") that extracts webpage content and generates Markdown summaries via user-configured OpenAI-compatible LLM APIs. Zero build step, zero dependencies — plain HTML/CSS/JS.

## Key Architecture Decisions

- **All API calls go through the background service worker** (`background.js`). The popup and content scripts never make direct `fetch()` calls. This is what allows the extension to work without `host_permissions` in manifest.json — MV3 service workers can make cross-origin requests without any host permissions.
- **Content extraction uses `chrome.scripting.executeScript`** with a serialized `extractPageContent()` function, NOT a persistent content script. The manifest deliberately has no `content_scripts` key. This avoids injecting JS on every page and was a Chrome Web Store compliance requirement.
- **Streaming is implemented via SSE parsing in background.js**: the background fetches with `stream: true`, reads the `ReadableStream` chunk by chunk, parses `data: [JSON]\n\n` lines, and forwards each content delta to the popup via `chrome.runtime.sendMessage` with action `stream:<streamId>`.
- **The `extractPageContent()` function exists in 3 places** (popup.js, background.js, content-script.js) with slight variations. The popup.js copy is used when the popup triggers summarization; the background.js copy is used for context menu/shortcut flows. If you change the extraction logic, update all three copies.

## File Purposes

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. Permissions: `activeTab`, `storage`, `scripting`, `contextMenus`. No `host_permissions`. |
| `background.js` | Service worker. Message router, API proxy (streaming summarize, model fetch, connection test), token estimation, context menu handler, keyboard shortcut handler. |
| `popup.html` / `popup.css` / `popup.js` | Extension popup UI. Summarize view + Settings view. Handles streaming display with incremental `renderMarkdown()` calls. |
| `lib/markdown.js` | Zero-dependency Markdown-to-HTML renderer. Exports global `renderMarkdown(md)` function. |
| `content-script.js` | Standby content script — NOT auto-injected. Available for manual use; the extension currently doesn't load it. |

## Message Protocol

Popups and content scripts talk to the background via `chrome.runtime.sendMessage`. The background talks to the popup via the same mechanism. All messages use an `action` string prefix:

**Popup → Background:**
- `api:ping` — health check (returns `{success: true}`)
- `api:summarize` — start streaming (responds sync with `{success, streaming}`, then sends chunks)
- `api:cancelStream` — abort active stream
- `api:estimateTokens` — token estimation
- `api:fetchModels` — GET /models from user's API
- `api:testConnection` — test API connectivity

**Background → Popup:**
- `stream:<streamId>` — chunk data: `{type: 'chunk'|'done'|'error'|'cancelled', fullContent, ...}`
- `showStreamReady` — background-initiated stream (context menu/shortcut) is ready
- `showSummary` / `showSummaryError` — legacy non-streaming results

The popup uses a `safeSendMessage()` wrapper with timeout + retry logic because MV3 service workers can be terminated after 30s idle and message delivery during cold start can be unreliable.

## Content Extraction

`extractPageContent()` detects page type by URL pattern:
- **video**: youtube.com/watch, bilibili.com/video, vimeo.com, tiktok.com
- **image**: instagram.com/p/, pinterest.com/pin, imgur.com, flickr.com
- **audio**: soundcloud.com, spotify.com, podcasts.apple.com, xima.fm
- **article**: everything else

Each type has different extraction logic and a different system prompt (see `buildSystemPrompt()` in background.js). Article text is truncated to 8000 chars, multimedia to 3000-4000 chars.

## Testing the Extension

Since there's no build step or test framework, testing is manual:

1. Go to `chrome://extensions/` → enable "Developer mode" → "Load unpacked" → select the `chrome-extension/` directory
2. Click "service worker" link on the extension card to view background console logs (prefix `[BG]`)
3. Right-click the extension icon → "Inspect popup" to view popup console logs
4. After making changes, click the reload icon on the extension card
5. If background behavior seems broken, click "service worker" and check for red error messages — a syntax error in background.js will silently kill the worker

## Common Pitfalls

- **Changing `safeSendMessage` signature**: It's called in 5+ places with the options object pattern `safeSendMessage(message, {timeoutMs, retries})`. Don't revert to positional args.
- **The popup's `onMessage` listener must call `sendResponse()`** for every received message, otherwise Chrome logs "message port closed" warnings and the message channel can degrade.
- **Don't add `host_permissions` to manifest.json** — it would block Chrome Web Store approval. Route everything through background.js instead.
- **`extractPageContent()` changes must be synced** across popup.js (~line 615), background.js (~line 592), and content-script.js (~line 20) if the standby script is being kept.
