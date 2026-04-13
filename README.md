# Testing Review — Developer Documentation

> A visual review and annotation tool similar to [markup.io](https://markup.io).  
> Users load any website via a proxied iframe, switch to Comment mode, place numbered pins on any element, and leave text comments that appear in a sidebar.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Deployment](#3-deployment)
4. [How the Proxy Works](#4-how-the-proxy-works)
5. [HTML Rewriting Pipeline](#5-html-rewriting-pipeline)
6. [Asset Proxy](#6-asset-proxy)
7. [Cookie & Consent Handling](#7-cookie--consent-handling)
8. [Cloudflare Worker](#8-cloudflare-worker)
9. [Puppeteer Integration](#9-puppeteer-integration)
10. [Comment / Pin System](#10-comment--pin-system)
11. [API Reference](#11-api-reference)
12. [Frontend UI](#12-frontend-ui)
13. [Known Limitations](#13-known-limitations)
14. [Environment & Dependencies](#14-environment--dependencies)
15. [Roadmap](#15-roadmap)

---

## 1. Project Overview

**Testing Review** is a Node.js/Express application that:

- Accepts any URL from the user
- Fetches the target website server-side (bypassing CORS and iframe restrictions)
- Rewrites all asset URLs so CSS, JS, images, and fonts load through our server
- Injects a pin/comment script into every proxied page
- Lets users place numbered comment pins on any element (just like markup.io)
- Shows all comments in a collapsible sidebar with resolve/delete actions

---

## 2. Architecture

```
Browser (user)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Express Server  (isb-wp-training.com:3000)         │
│                                                     │
│  POST /api/session  ──► creates session ID          │
│  GET  /s/:id/*      ──► HTML proxy route            │
│  GET  /a?url=...    ──► asset proxy route           │
│  GET  /_next/image  ──► Next.js image handler       │
│  GET  /*            ──► smart catch-all             │
│                                                     │
│  [Puppeteer]  auto-captures consent cookies         │
│  [CF Worker]  bypasses Cloudflare-protected sites   │
└─────────────────────────────────────────────────────┘
    │                        │
    ▼                        ▼
Target Website         Cloudflare Worker
(direct fetch)         (for CF-blocked sites)
```

**Session flow:**

1. User enters URL → `POST /api/session` → returns `{ id, proxyPath: '/s/:id/' }`
2. Browser loads `proxyPath` in the iframe
3. Server fetches the target URL, rewrites all assets, injects scripts, returns HTML
4. All subsequent asset requests go through `/a?url=...`
5. Puppeteer pre-warms consent cookies in the background

---

## 3. Deployment

| Property         | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| **Platform**     | Hostinger Business Node.js Web App                    |
| **Live URL**     | https://isb-wp-training.com                           |
| **Server IP**    | 194.164.74.88                                         |
| **Node version** | 22.x (`/opt/alt/alt-nodejs22/root/usr/bin/node`)      |
| **Working dir**  | `/home/u741730845/domains/isb-wp-training.com/nodejs` |
| **Entry file**   | `server.js`                                           |
| **Port**         | 3000 (Hostinger proxies 80/443 → 3000)                |

**To deploy:** zip the project (excluding `node_modules`), upload via Hostinger file manager to the `nodejs` directory, then restart the Node.js app from the Hostinger panel.

```bash
zip -r deploy.zip . -x "node_modules/*" -x "*.zip" -x ".git/*"
```

---

## 4. How the Proxy Works

### Session Creation

```javascript
POST /api/session
Body: { url: "https://example.com" }
Response: { id: "abc123", proxyPath: "/s/abc123/" }
```

Sessions are stored in-memory in the `sessions` object:

```javascript
sessions["abc123"] = { url: "https://example.com", createdAt: Date.now() };
```

> ⚠️ Sessions are lost on server restart. Phase 2 will persist them to PostgreSQL.

### HTML Proxy Route

`GET /s/:id/` and `GET /s/:id/any/path`

1. Looks up session to get target URL
2. Calls `smartFetch()` to get the HTML
3. Runs the **HTML Rewriting Pipeline** (see section 5)
4. Returns modified HTML with all assets rewritten to go through `/a?url=...`

### smartFetch()

```javascript
async function smartFetch(targetUrl, cookieHeader, isHtml = false)
```

Decision tree:

1. If domain is in `cfWorkerDomains` → route through Cloudflare Worker
2. Otherwise → direct `axios.get()`
3. If response is 403/429/503 with Cloudflare Ray ID → auto-add to `cfWorkerDomains`, retry via worker
4. If response is a consent redirect (302 to policy URL) → trigger Puppeteer cookie capture, retry

---

## 5. HTML Rewriting Pipeline

Every proxied HTML page goes through this pipeline in order:

```
Load HTML into cheerio ($)
  │
  ├── 1. Strip Cookiebot/OneTrust scripts
  │        $('script[src*="cookiebot.com"]').remove()
  │        $('script[src*="onetrust.com"]').remove()
  │
  ├── 2. Remove meta refresh redirects
  │        $('meta[http-equiv="refresh"]').remove()
  │
  ├── 3. Restore CMP-blocked scripts
  │        type="text/plain" → type="text/javascript"
  │
  ├── 4. Strip Nuxt/Vue hydration entry points
  │        Removes <script type="module" src="...entry...">
  │        Removes <script id="__NUXT_DATA__">
  │        Removes window.__NUXT__ inline scripts
  │        (prevents SPA from blanking SSR content)
  │
  ├── 5. Strip SRI integrity attributes
  │        Removes integrity="" and crossorigin="" from all link/script
  │        (our CSS url() rewriting changes file content, breaking SRI hashes)
  │
  ├── 6. Inject Font Awesome 6.5 CSS
  │
  ├── 7. Prepend to <head>: inline script with:
  │        - Fake document.cookie (injects consent cookies)
  │        - Block location redirects to policy URLs
  │        - Intercept document.createElement('link'/'script')
  │        - Intercept fetch() and XMLHttpRequest
  │        - window.__proxyBase = targetUrl
  │
  ├── 8. Append to <head>: loading overlay CSS + spinner
  │
  ├── 9. Rewrite <a href> for same-domain links → session path
  │
  ├── 10. Rewrite <link href> → /a?url=... (skip preconnect/dns-prefetch)
  │
  ├── 11. Rewrite <script src> → /a?url=...
  │
  ├── 12. Rewrite <img> src/srcset/data-src/data-lazy-src
  │         (Next.js /_next/image URLs kept as-is, handled by dedicated route)
  │
  ├── 13. Rewrite <source> srcset/src
  │
  ├── 14. Rewrite inline style background-image url()
  │
  ├── 15. Rewrite <style> tag url() and @import
  │
  └── 16. Append to <body>:
           - Loading overlay hide script (fires on window.load)
           - Cookie banner killer (MutationObserver + CSS hiding)
           - PIN_SCRIPT (comment/annotation system)
```

---

## 6. Asset Proxy

`GET /a?url=<encoded-absolute-url>`

Handles all non-HTML assets: CSS, JS, images, fonts, JSON.

Key behaviors:

- **CSS files**: rewrites all `url()` and `@import` paths to go through `/a?url=...`
- **Font files**: adds `Cross-Origin-Resource-Policy: cross-origin` header
- **JS files**: served as-is (no modification — see Known Limitations)
- **Blocked patterns**: requests to `acceptable-use`, `cookie-policy`, `privacy-policy` etc. return empty responses to prevent redirect loops

### Next.js Image Handler

`GET /_next/image?url=<encoded-path>&w=640&q=75`

Next.js uses its own image optimization endpoint that generates different URLs. Our handler:

1. Extracts the actual image URL from the `url` query param
2. Resolves it against the session's origin domain
3. Fetches and serves the raw image with correct Content-Type

### Smart Catch-All

`GET /<any-asset-extension>`

Handles root-relative dynamic imports like `/p-495c12a1.js` that bypass our rewriting (used by Stencil.js, Module Federation etc.):

1. Reads the `Referer` header to find which session this belongs to
2. Extracts the session ID from `/s/:id/` in the referer path
3. Reconstructs the full target URL: `https://origin-domain.com/p-495c12a1.js`
4. Fetches and serves with correct MIME type

---

## 7. Cookie & Consent Handling

### Generic Consent Cookies

Every request includes a base set of common consent cookies:

```
cookie_consent=true; cookieconsent_status=allow; gdpr_consent=1; CookieConsent=true; ...
```

### Puppeteer Auto-Capture

When a new session is created, Puppeteer runs in the background:

1. Launches headless Chrome
2. Navigates to the target URL
3. Tries to click common "Accept All" buttons (CybotCookiebot, OneTrust, etc.)
4. Captures all cookies from the resulting page
5. Caches them in `puppeteerCookieCache[hostname]`

On subsequent requests, cached Puppeteer cookies are merged into every request header.

**Cookie cache** is in-memory — cleared on restart. Sites that were previously auto-accepted will need re-acceptance after restart.

### Browser-Side Cookie Injection

Every proxied page has this injected at the top of `<head>`:

```javascript
Object.defineProperty(document, "cookie", {
  get: () => "cookie_consent=true; CookieConsent=true; ...",
  set: (v) => {
    /* pass through to real setter */
  },
});
```

This makes the site's JS "think" consent was already given.

---

## 8. Cloudflare Worker

Some sites (hosting.com, godaddy.com, ovh.com) aggressively block datacenter IPs.

**Worker URL:** `https://cool-wildflower-6b0f.frikhab513.workers.dev/`  
**Secret:** `xk92mZ7pQr` (passed as query param)

The worker:

- Runs on Cloudflare's edge network (residential-ish IPs)
- Fetches the target URL with `redirect: 'manual'`
- Returns the response with `x-proxy-set-cookie` header for cookie passthrough

**Auto-detection:** If a direct fetch returns 403/429/503 with "Ray ID" in the body, the domain is automatically added to `cfWorkerDomains` and retried via the worker.

**Hardcoded domains:**

```javascript
const cfWorkerDomains = new Set([
  "hosting.com",
  "www.hosting.com",
  "godaddy.com",
  "www.godaddy.com",
  "ovh.com",
  "www.ovh.com",
]);
```

---


## 9. Puppeteer Integration

### Chrome Path

Chrome is downloaded on first startup to:

```
/home/u741730845/domains/isb-wp-training.com/nodejs/.cache/puppeteer/
  chrome/linux-127.0.6533.88/chrome-linux64/chrome
  chrome-headless-shell/linux-127.0.6533.88/chrome-headless-shell-linux64/chrome-headless-shell
```

> **Note:** Only `chrome-headless-shell` works reliably on Hostinger (full chrome hits V8 snapshot issues or ETXTBSY race condition). The `ensureChrome()` function uses a singleton promise to prevent race conditions.

### Launch flags

```javascript
[
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
  "--disable-extensions",
  "--disable-software-rasterizer",
  "--mute-audio",
];
```

### Diagnostic endpoints

| Endpoint                  | Purpose                                    |
| ------------------------- | ------------------------------------------ |
| `GET /api/test-puppeteer` | Verify Puppeteer works (loads example.com) |
| `GET /api/install-chrome` | Manually trigger Chrome download           |
| `GET /api/find-chrome`    | List Chrome binary locations on filesystem |

---

## 10. Comment / Pin System

### How it works

The system uses `postMessage` to communicate between the proxied iframe (cross-origin) and the parent toolbar UI.

```
Parent (index.html)  ←──postMessage──→  Iframe (PIN_SCRIPT)
```

### Message Protocol

| Message type    | Direction       | Payload                        |
| --------------- | --------------- | ------------------------------ |
| `IFRAME_READY`  | iframe → parent | —                              |
| `SET_MODE`      | parent → iframe | `{ mode: 'browse'/'comment' }` |
| `PIN_CREATED`   | iframe → parent | `{ pin: PinObject }`           |
| `PIN_CANCELLED` | iframe → parent | —                              |
| `LOAD_PINS`     | parent → iframe | `{ pins: PinObject[] }`        |
| `DELETE_PIN`    | parent → iframe | `{ id }`                       |
| `HIGHLIGHT_PIN` | parent → iframe | `{ id }`                       |
| `UPDATE_PIN`    | parent → iframe | `{ id, resolved }`             |

### PinObject schema

```javascript
{
  id: "p_1712345678_ab3cd",   // unique ID
  number: 1,                   // display number (1, 2, 3...)
  comment: "Fix this button",  // user's comment text
  xpath: "/html/body/div[2]/section[1]/p[1]",  // element path for replay
  offsetX: 142.5,              // click offset from element's top-left
  offsetY: 38.2,
  pageUrl: "https://example.com/page",
  timestamp: 1712345678000,
  resolved: false,
  author: "You"                // Phase 3: will be real user name
}
```

### Pin placement logic (inside iframe)

1. User hovers → blue dashed outline on hovered element (skips replaced elements like `<img>`)
2. User clicks → check if target is a replaced element (`IMG`, `VIDEO`, `CANVAS`, etc.) → use parent instead
3. Make target `position: relative` if it was `static`
4. Append pin `<div>` as absolute child of target at click coordinates
5. Show comment bubble (textarea + Save/Cancel)
6. On Save → `postMessage` `PIN_CREATED` to parent
7. Parent renders comment card in sidebar

### Why pins are injected INSIDE the element (not on body)

This is the key insight from markup.io's approach. By appending the pin as a child of the clicked element, it naturally follows the element on scroll — no need for `getBoundingClientRect()` polling or scroll event listeners.

---

## 11. API Reference

| Method | Path                   | Description                              |
| ------ | ---------------------- | ---------------------------------------- |
| `POST` | `/api/session`         | Create proxy session                     |
| `GET`  | `/api/health`          | Health check + session count             |
| `GET`  | `/api/test-puppeteer`  | Test Puppeteer/Chrome works              |
| `GET`  | `/api/install-chrome`  | Manually install Chrome                  |
| `GET`  | `/api/find-chrome`     | Find Chrome binary on filesystem         |
| `GET`  | `/a?url=...`           | Asset proxy                              |
| `GET`  | `/_next/image?url=...` | Next.js image proxy                      |
| `GET`  | `/s/:id/`              | Proxied HTML page                        |
| `GET`  | `/s/:id/*`             | Proxied subpages                         |
| `GET`  | `/*.(js\|css\|...)`    | Smart catch-all for root-relative assets |

### POST /api/session

```json
// Request
{ "url": "https://example.com" }

// Response
{ "id": "abc123def456", "proxyPath": "/s/abc123def456/" }
```

---

## 12. Frontend UI

**File:** `public/index.html` (single-file, no framework)

### Layout

```
┌──────────────────────────────────────────────────────┐
│  TOOLBAR: Logo | URL input | Load | Browse/Comment   │
├───────────────┬──────────────────────────────────────┤
│               │                                      │
│   SIDEBAR     │         IFRAME AREA                  │
│   (300px)     │                                      │
│               │   [proxied website renders here]     │
│  ‹ toggle     │                                      │
│               │                                      │
│  Active  0    │                                      │
│  Resolved 0   │                                      │
│               │                                      │
│  [comment     │                                      │
│   cards]      │                                      │
│               │                                      │
└───────────────┴──────────────────────────────────────┘
```

### State variables

```javascript
let mode = "browse"; // 'browse' | 'comment'
let currentSessionId = null; // active session ID
let currentUrl = null; // currently loaded URL
let pins = []; // array of PinObjects (in-memory for now)
let pinCounter = 0; // highest pin number
let activeTab = "active"; // sidebar tab
let sidebarOpen = true; // sidebar visibility
```

### Comment mode behavior

- `iframeWrap` gets `cursor: crosshair` CSS
- PIN_SCRIPT inside iframe handles all click/hover events
- The iframe is NOT pointer-events blocked — this is intentional, the script intercepts at capture phase

---

## 13. Known Limitations

### Sites that don't work

| Site          | Reason                                          |
| ------------- | ----------------------------------------------- |
| amazon.com    | PerimeterX bot detection, blocks datacenter IPs |
| facebook.com  | Bot detection + X-Frame-Options: SAMEORIGIN     |
| instagram.com | Same as Facebook                                |
| netflix.com   | DRM + bot detection                             |

These require residential proxy IPs — planned for Phase 7 with a VPS upgrade.

### In-memory storage

- Sessions are lost on restart
- Pins/comments are lost on page refresh
- Puppeteer cookie cache is lost on restart
- **Fix:** Phase 2 adds PostgreSQL persistence

### JS-heavy SPAs

Sites that rely heavily on client-side routing may have navigation issues since link clicks load within the same iframe session. Workaround: Nuxt entry bundles are stripped to prevent hydration from breaking the SSR snapshot.

### Shared Hostinger IP

Our server IP is a known datacenter IP. Some sites detect and block datacenter traffic even without Cloudflare. The CF Worker helps for some, but not all.

---

## 14. Environment & Dependencies

### package.json

```json
{
  "dependencies": {
    "axios": "^1.6.0",
    "cheerio": "^1.0.0",
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "puppeteer": "^22.0.0",
    "uuid": "^9.0.0"
  },
  "scripts": {
    "start": "node server.js",
    "postinstall": "node node_modules/puppeteer/install.mjs || true"
  }
}
```

### Environment variables

| Variable                       | Value  | Purpose                                                |
| ------------------------------ | ------ | ------------------------------------------------------ |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0`    | Skip SSL verification for proxied sites with bad certs |
| `PORT`                         | `3000` | Server port                                            |

### Key constants in server.js

```javascript
const CHROME_PATH = "/home/u741730845/.../chrome";
const NODE_EXEC = "/opt/alt/alt-nodejs22/root/usr/bin/node";
const CF_WORKER_URL = "https://cool-wildflower-6b0f.frikhab513.workers.dev/";
const CF_WORKER_SECRET = "xk92mZ7pQr";
```

---

## 15. Roadmap

| Phase       | Status      | Description                                                     |
| ----------- | ----------- | --------------------------------------------------------------- |
| **Phase 1** | ✅ Complete | Core proxy + comment pins                                       |
| **Phase 2** | 🔄 Next     | PostgreSQL persistence (sessions, pins, users)                  |
| **Phase 3** | 📋 Planned  | Screenshot service (BullMQ + Redis queue)                       |
| **Phase 4** | 📋 Planned  | Real-time collaboration (Pusher/Ably presence)                  |
| **Phase 5** | 📋 Planned  | Auth system (users, workspaces, sharing links)                  |
| **Phase 6** | 📋 Planned  | Polish (device preview modes, file attachments, PDF export)     |
| **Phase 7** | 📋 Planned  | VPS upgrade + residential proxy for blocked sites (Amazon etc.) |

---

## File Structure

```
nodejs/
├── server.js              # Main Express server (~1280 lines)
├── package.json
├── package-lock.json
├── public/
│   └── index.html         # Single-page frontend UI
└── .cache/
    └── puppeteer/         # Chrome binary (auto-downloaded)
        ├── chrome/
        └── chrome-headless-shell/
```

---

_Last updated: April 2026 — v47_
