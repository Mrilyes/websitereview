process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const globalState = globalThis.__testingReviewState ?? {
  sessions: {},
  cookieJar: {},
  puppeteerCookieCache: {},
  screenshotCache: {},
  chromeInstallPromise: null,
};

globalThis.__testingReviewState = globalState;

const { sessions, cookieJar, puppeteerCookieCache, screenshotCache } =
  globalState;

const CF_WORKER_URL =
  "https://cool-wildflower-6b0f.frikhab513.workers.dev/";
const CF_WORKER_SECRET = "xk92mZ7pQr";
const cfWorkerDomains = new Set([
  "hosting.com",
  "www.hosting.com",
  "godaddy.com",
  "www.godaddy.com",
  "ovh.com",
  "www.ovh.com",
]);

const NODE_EXEC = "/opt/alt/alt-nodejs22/root/usr/bin/node";
const SESSION_COOKIE_PREFIX = "tr_session_";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

function getPreferredPuppeteerCacheDir() {
  return (
    process.env.PUPPETEER_CACHE_DIR ||
    path.join(
      /* turbopackIgnore: true */ process.env.HOME || process.cwd(),
      ".cache",
      "puppeteer",
    )
  );
}

function findChromeInCache(cacheDir) {
  const chromeRoot = path.join(cacheDir, "chrome");
  if (!fs.existsSync(chromeRoot)) return null;

  const platform = process.platform;
  const executableCandidates =
    platform === "win32"
      ? ["chrome.exe"]
      : platform === "darwin"
        ? ["Chromium.app/Contents/MacOS/Chromium", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
        : ["chrome-linux64/chrome", "chrome"];

  for (const versionDir of fs.readdirSync(chromeRoot)) {
    const baseDir = path.join(chromeRoot, versionDir);
    for (const relativeExecutable of executableCandidates) {
      const candidate = path.join(baseDir, relativeExecutable);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

async function resolveChromeExecutable(puppeteerModule) {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  try {
    const resolved = puppeteerModule.executablePath();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}

  const commonCacheDirs = [
    getPreferredPuppeteerCacheDir(),
    path.join(
      "/home/u741730845/domains/isb-wp-training.com/nodejs",
      ".cache",
      "puppeteer",
    ),
    path.join("/home/u741730845", ".cache", "puppeteer"),
  ];

  for (const cacheDir of commonCacheDirs) {
    const found = findChromeInCache(cacheDir);
    if (found) return found;
  }

  return null;
}

function createTextResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  return new Response(body, { ...init, headers });
}

function createJsonResponse(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function createBinaryResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  return new Response(body, { ...init, headers });
}

function createProxyHeaders(contentType, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  if (contentType) headers.set("Content-Type", contentType);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Content-Security-Policy", "");
  return headers;
}

function getSessionCookieName(id) {
  return `${SESSION_COOKIE_PREFIX}${id}`;
}

function normalizeSessionUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function hydrateSession(id, fallbackUrl) {
  const existing = sessions[id];
  if (existing?.url) return existing;

  const normalizedUrl = fallbackUrl ? normalizeSessionUrl(fallbackUrl) : null;
  if (!normalizedUrl) return null;

  const restored = { url: normalizedUrl, createdAt: Date.now() };
  sessions[id] = restored;
  return restored;
}

export function getSessionCookieDescriptor(id, url) {
  return {
    name: getSessionCookieName(id),
    value: encodeURIComponent(url),
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE,
    },
  };
}

function extractCookies(domain, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  if (!cookieJar[domain]) cookieJar[domain] = {};
  headers.forEach((header) => {
    const part = header.split(";")[0];
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) return;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key) cookieJar[domain][key] = value;
  });
}

function getCookieHeader(domain) {
  const consentBase = [
    "cookie_consent=true",
    "cookieconsent_status=allow",
    "cookies_accepted=true",
    "gdpr_consent=1",
    "consent=1",
    "viewed_cookie_policy=yes",
    "cookie-agreed=2",
    "euconsent=true",
    "accept-cookies=true",
    "cookie_notice_accepted=true",
    "cookies-consent=1",
    "cookie_accepted=true",
    "cookie_consent_level=all",
    "privacy_policy_accepted=1",
    "terms_accepted=1",
  ].join("; ");

  const puppeteerCookies =
    puppeteerCookieCache[domain] || puppeteerCookieCache[`www.${domain}`] || "";
  const stored = cookieJar[domain]
    ? Object.entries(cookieJar[domain])
        .map(([key, value]) => `${key}=${value}`)
        .join("; ")
    : "";

  return [consentBase, puppeteerCookies, stored].filter(Boolean).join("; ");
}

function toAbsolute(href, pageUrl) {
  if (!href) return null;
  if (
    href.startsWith("data:") ||
    href.startsWith("mailto:") ||
    href.startsWith("javascript:") ||
    href.startsWith("#") ||
    href.startsWith("blob:")
  ) {
    return null;
  }
  try {
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("//")) return `https:${href}`;
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}

function guessContentType(url) {
  const cleanUrl = url.split("?")[0];
  if (cleanUrl.endsWith(".css")) return "text/css";
  if (cleanUrl.endsWith(".js") || cleanUrl.endsWith(".mjs")) {
    return "application/javascript";
  }
  if (cleanUrl.endsWith(".png")) return "image/png";
  if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";
  if (cleanUrl.endsWith(".svg")) return "image/svg+xml";
  if (cleanUrl.endsWith(".woff")) return "font/woff";
  if (cleanUrl.endsWith(".woff2")) return "font/woff2";
  if (cleanUrl.endsWith(".ttf")) return "font/ttf";
  if (cleanUrl.endsWith(".otf")) return "font/otf";
  if (cleanUrl.endsWith(".eot")) return "application/vnd.ms-fontobject";
  if (cleanUrl.endsWith(".ico")) return "image/x-icon";
  if (cleanUrl.endsWith(".json")) return "application/json";
  if (cleanUrl.endsWith(".webp")) return "image/webp";
  if (cleanUrl.endsWith(".gif")) return "image/gif";
  return null;
}

async function fetchViaWorker(targetUrl) {
  const workerUrl = `${CF_WORKER_URL}?secret=${CF_WORKER_SECRET}&url=${encodeURIComponent(targetUrl)}`;
  const response = await axios.get(workerUrl, {
    responseType: "arraybuffer",
    validateStatus: () => true,
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  const setCookie = response.headers["x-proxy-set-cookie"];
  if (setCookie) response.headers["set-cookie"] = setCookie;
  return response;
}

async function smartFetch(targetUrl, cookieHeader, isHtml = false) {
  const host = new URL(targetUrl).hostname.toLowerCase();
  if (isHtml && cfWorkerDomains.has(host)) {
    return fetchViaWorker(targetUrl);
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: isHtml
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      : "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    Cookie: cookieHeader || "",
  };

  if (isHtml) {
    headers["Upgrade-Insecure-Requests"] = "1";
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Site"] = "none";
    headers["Sec-Fetch-User"] = "?1";
  }

  const response = await axios.get(targetUrl, {
    headers,
    responseType: "arraybuffer",
    validateStatus: () => true,
    maxRedirects: 5,
    timeout: 15000,
  });

  if (isHtml) {
    const contentType = response.headers["content-type"] || "";
    if (
      [403, 429, 503].includes(response.status) &&
      contentType.includes("text/html")
    ) {
      const body = Buffer.from(response.data).toString("utf-8");
      if (
        body.includes("cloudflare") ||
        body.includes("Ray ID") ||
        body.includes("1015") ||
        body.includes("rate limit") ||
        body.includes("banned")
      ) {
        cfWorkerDomains.add(host);
        return fetchViaWorker(targetUrl);
      }
    }

    if ([301, 302].includes(response.status)) {
      const location = response.headers.location || "";
      const consentPatterns = [
        "cookie",
        "consent",
        "gdpr",
        "privacy",
        "acceptable-use",
        "acceptable-usage",
      ];
      if (consentPatterns.some((pattern) => location.toLowerCase().includes(pattern))) {
        const puppeteerCookies = await captureConsentCookies(targetUrl);
        if (puppeteerCookies) {
          headers.Cookie = puppeteerCookies;
          return axios.get(targetUrl, {
            headers,
            responseType: "arraybuffer",
            validateStatus: () => true,
            maxRedirects: 5,
            timeout: 15000,
          });
        }
      }
    }
  }

  return response;
}

const PIN_SCRIPT = `
(function() {
  var __mode = 'browse';
  var __pinCount = 0;
  var __hovered = null;
  var __highlightCSS = document.createElement('style');
  __highlightCSS.textContent = '.__mk_hover__ { outline: 2px dashed #5c6bc0 !important; outline-offset: 2px !important; cursor: crosshair !important; }';
  document.head.appendChild(__highlightCSS);

  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.__markupType) return;
    var t = e.data.__markupType;
    if (t === 'SET_MODE') {
      __mode = e.data.mode;
      document.body.style.cursor = __mode === 'comment' ? 'crosshair' : '';
      if (__mode === 'browse') clearHover();
    }
    if (t === 'LOAD_PINS') e.data.pins.forEach(function(p) { renderPin(p); });
    if (t === 'DELETE_PIN') {
      var el = document.querySelector('[data-mkpin="' + e.data.id + '"]');
      if (el) el.remove();
    }
    if (t === 'HIGHLIGHT_PIN') {
      document.querySelectorAll('[data-mkpin]').forEach(function(p) { p.style.outline = ''; });
      var pin = document.querySelector('[data-mkpin="' + e.data.id + '"]');
      if (pin) {
        pin.style.outline = '3px solid #f59e0b';
        pin.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function() { pin.style.outline = ''; }, 2000);
      }
    }
    if (t === 'UPDATE_PIN') {
      var pin = document.querySelector('[data-mkpin="' + e.data.id + '"]');
      if (pin) pin.style.background = e.data.resolved ? '#4caf50' : '#5c6bc0';
    }
  });

  function clearHover() {
    if (__hovered) {
      __hovered.classList.remove('__mk_hover__');
      __hovered = null;
    }
  }

  var REPLACED = ['IMG', 'VIDEO', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'EMBED', 'OBJECT', 'SVG'];

  document.addEventListener('mouseover', function(e) {
    if (__mode !== 'comment') return;
    var target = e.target;
    if (target === document.body || target === document.documentElement) return;
    if (target.closest('[data-mkpin]') || target.id === '__mkbubble__') return;
    if (REPLACED.indexOf(target.tagName) !== -1) target = target.parentElement || target;
    var rect = target.getBoundingClientRect();
    var isFullPage = rect.width >= window.innerWidth * 0.98 && rect.height >= window.innerHeight * 0.98;
    if (isFullPage) return;
    if (__hovered !== target) {
      clearHover();
      __hovered = target;
      target.classList.add('__mk_hover__');
    }
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (__mode !== 'comment') return;
    if (e.target === __hovered) clearHover();
  }, true);

  document.addEventListener('click', function(e) {
    if (__mode !== 'comment') return;
    if (e.target.closest('[data-mkpin]') || e.target.closest('#__mkbubble__')) return;
    e.preventDefault();
    e.stopPropagation();

    clearHover();
    var target = e.target;
    if (target === document.body || target === document.documentElement) {
      target = document.elementFromPoint(e.clientX, e.clientY) || document.body;
    }
    if (REPLACED.indexOf(target.tagName) !== -1) target = target.parentElement || target;

    var rect = target.getBoundingClientRect();
    var offsetX = e.clientX - rect.left;
    var offsetY = e.clientY - rect.top;
    __pinCount++;
    var pinId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    if (window.getComputedStyle(target).position === 'static') target.style.position = 'relative';

    var pin = document.createElement('div');
    pin.setAttribute('data-mkpin', pinId);
    pin.style.cssText = [
      'position:absolute!important',
      'top:' + offsetY + 'px!important',
      'left:' + offsetX + 'px!important',
      'transform:translate(-50%,-50%)!important',
      'width:24px!important',
      'height:24px!important',
      'background:#5c6bc0!important',
      'color:#fff!important',
      'border-radius:50%!important',
      'border:2.5px solid #fff!important',
      'display:flex!important',
      'align-items:center!important',
      'justify-content:center!important',
      'font-size:11px!important',
      'font-weight:700!important',
      'font-family:-apple-system,sans-serif!important',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)!important',
      'cursor:pointer!important',
      'z-index:9999999!important',
      'user-select:none!important'
    ].join(';');
    pin.textContent = __pinCount;
    target.appendChild(pin);
    showBubble(pin, offsetX, offsetY, pinId, __pinCount, target);
  }, true);

  function showBubble(pin, ox, oy, pinId, pinNum, target) {
    removeBubble();
    var bubble = document.createElement('div');
    bubble.id = '__mkbubble__';
    var pr = pin.getBoundingClientRect();
    var left = pr.right + 12;
    var top = pr.top - 8;
    if (left + 264 > window.innerWidth) left = pr.left - 276;
    if (top + 140 > window.innerHeight) top = window.innerHeight - 145;
    if (top < 8) top = 8;

    bubble.style.cssText = [
      'position:fixed!important',
      'z-index:99999999!important',
      'left:' + left + 'px!important',
      'top:' + top + 'px!important',
      'width:260px!important',
      'background:#fff!important',
      'border-radius:12px!important',
      'box-shadow:0 8px 32px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08)!important',
      'padding:14px!important',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif!important'
    ].join(';');
    bubble.innerHTML = '<textarea placeholder="Add comment here..." style="width:100%!important;height:74px!important;border:1.5px solid #e0e0e0!important;border-radius:8px!important;padding:9px 10px!important;font-size:13px!important;resize:none!important;outline:none!important;font-family:inherit!important;display:block!important;color:#333!important;background:#fff!important;box-sizing:border-box!important;line-height:1.45!important;"></textarea><div style="display:flex!important;justify-content:flex-end!important;gap:8px!important;margin-top:10px!important;"><button id="__mkcancel__" style="padding:6px 14px!important;border:1.5px solid #e0e0e0!important;border-radius:7px!important;background:#fff!important;cursor:pointer!important;font-size:13px!important;color:#666!important;font-family:inherit!important;font-weight:500!important;">Cancel</button><button id="__mksave__" style="padding:6px 16px!important;border:none!important;border-radius:7px!important;background:#5c6bc0!important;color:#fff!important;cursor:pointer!important;font-size:13px!important;font-weight:600!important;font-family:inherit!important;">Save</button></div>';

    document.body.appendChild(bubble);
    var ta = bubble.querySelector('textarea');
    ta.addEventListener('focus', function() { ta.style.borderColor = '#5c6bc0'; });
    ta.addEventListener('blur', function() { ta.style.borderColor = '#e0e0e0'; });
    setTimeout(function() { ta.focus(); }, 40);
    ta.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        save();
      }
      if (ev.key === 'Escape') cancel();
    });
    document.getElementById('__mkcancel__').onclick = cancel;
    document.getElementById('__mksave__').onclick = save;

    function cancel() {
      removeBubble();
      pin.remove();
      __pinCount--;
      window.parent.postMessage({ __markupType: 'PIN_CANCELLED' }, '*');
    }

    function save() {
      var txt = ta.value.trim();
      if (!txt) {
        ta.style.borderColor = '#ef4444';
        ta.focus();
        return;
      }
      removeBubble();
      window.parent.postMessage({
        __markupType: 'PIN_CREATED',
        pin: {
          id: pinId,
          number: pinNum,
          comment: txt,
          pageUrl: window.location.href,
          xpath: getXPath(target),
          offsetX: ox,
          offsetY: oy,
          timestamp: Date.now()
        }
      }, '*');
    }
  }

  function removeBubble() {
    var b = document.getElementById('__mkbubble__');
    if (b) b.remove();
  }

  function renderPin(p) {
    try {
      var el = document.evaluate(p.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return;
      if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
      var pin = document.createElement('div');
      pin.setAttribute('data-mkpin', p.id);
      pin.style.cssText = [
        'position:absolute!important',
        'top:' + p.offsetY + 'px!important',
        'left:' + p.offsetX + 'px!important',
        'transform:translate(-50%,-50%)!important',
        'width:24px!important',
        'height:24px!important',
        'background:' + (p.resolved ? '#4caf50' : '#5c6bc0') + '!important',
        'color:#fff!important',
        'border-radius:50%!important',
        'border:2.5px solid #fff!important',
        'display:flex!important',
        'align-items:center!important',
        'justify-content:center!important',
        'font-size:11px!important',
        'font-weight:700!important',
        'font-family:-apple-system,sans-serif!important',
        'box-shadow:0 2px 10px rgba(0,0,0,.3)!important',
        'cursor:pointer!important',
        'z-index:9999999!important',
        'user-select:none!important'
      ].join(';');
      pin.textContent = p.number;
      if (p.number > __pinCount) __pinCount = p.number;
      el.appendChild(pin);
    } catch (error) {}
  }

  function getXPath(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      var i = 1;
      var sib = el.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.nodeName === el.nodeName) i++;
        sib = sib.previousSibling;
      }
      parts.unshift(el.nodeName.toLowerCase() + '[' + i + ']');
      el = el.parentNode;
    }
    return '/' + parts.join('/');
  }

  window.parent.postMessage({ __markupType: 'IFRAME_READY' }, '*');
})();
`;

const COOKIE_KILLER_SCRIPT = `
(function() {
  try {
    Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth; }, configurable: true });
    Object.defineProperty(window, 'outerHeight', { get: function() { return window.innerHeight; }, configurable: true });
    Object.defineProperty(navigator, 'webdriver', { get: function() { return false; }, configurable: true });
  } catch (error) {}

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('meta[http-equiv="refresh"]').forEach(function(m) { m.remove(); });
  });

  var selectors = [
    '#CybotCookiebotDialog', '.CybotCookiebotDialogBodyButton', '#cookiebanner',
    '#onetrust-banner-sdk', '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
    '.cky-consent-container', '.cky-overlay', '#cky-consent', '#didomi-host',
    '#didomi-popup', '.didomi-popup-overlay', '.didomi-notice', '#cookie-banner',
    '#cookie-notice', '#cookie-bar', '#cookie-consent', '#cookie-popup',
    '.cookie-banner', '.cookie-notice', '.cookie-bar', '.cookie-consent',
    '.cookie-popup', '.gdpr-banner', '.gdpr-notice', '.gdpr-popup', '.gdpr-overlay'
  ];

  var style = document.createElement('style');
  style.textContent = selectors.map(function(selector) {
    return selector + '{display:none!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;}';
  }).join('');
  document.head.appendChild(style);

  function tryAcceptKnown() {
    var candidates = ['#CybotCookiebotDialogBodyButtonAccept', '#onetrust-accept-btn-handler', '.cc-accept-all', 'button[class*="accept"]', 'button[id*="accept"]'];
    for (var i = 0; i < candidates.length; i++) {
      var btn = document.querySelector(candidates[i]);
      if (btn && btn.offsetParent !== null) {
        try { btn.click(); } catch (error) {}
        return;
      }
    }
  }

  function scanExisting() {
    tryAcceptKnown();
    if (document.body && document.body.style.overflow === 'hidden') {
      document.body.style.overflow = '';
    }
  }

  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        var id = (node.id || '').toLowerCase();
        var cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
        if (id.includes('cookie') || id.includes('consent') || id.includes('gdpr') || cls.includes('cookie') || cls.includes('consent') || cls.includes('gdpr')) {
          node.style.cssText = 'display:none!important;visibility:hidden!important;';
        }
      });
    });
    scanExisting();
  });

  function startObserver() {
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    scanExisting();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();
`;

async function ensureChrome() {
  if (globalState.chromeInstallPromise) return globalState.chromeInstallPromise;

  globalState.chromeInstallPromise = (async () => {
    try {
      execSync(`"${NODE_EXEC}" node_modules/puppeteer/install.mjs`, {
        timeout: 180000,
        cwd: process.cwd(),
        env: {
          ...process.env,
          PUPPETEER_CACHE_DIR: getPreferredPuppeteerCacheDir(),
        },
      });
    } catch (error) {
      console.error("[Chrome] Installation failed:", error.message);
    } finally {
      globalState.chromeInstallPromise = null;
    }
  })();

  return globalState.chromeInstallPromise;
}

async function launchBrowser() {
  const puppeteer = await import("puppeteer");
  let executablePath = await resolveChromeExecutable(puppeteer.default);
  if (!executablePath) {
    await ensureChrome();
    executablePath = await resolveChromeExecutable(puppeteer.default);
  }
  if (!executablePath) {
    throw new Error("Chrome executable was not found in the Puppeteer cache");
  }

  return puppeteer.default.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
      "--disable-software-rasterizer",
      "--disable-background-networking",
      "--mute-audio",
    ],
  });
}

export async function captureConsentCookies(targetUrl) {
  const host = new URL(targetUrl).hostname;
  if (puppeteerCookieCache[host]) return puppeteerCookieCache[host];

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    );
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    const acceptSelectors = [
      "#CybotCookiebotDialogBodyButtonAccept",
      "#onetrust-accept-btn-handler",
      'button[id*="accept"]',
      'button[class*="accept"]',
      '[data-testid="cookie-banner-accept-button"]',
      ".cc-accept-all",
    ];

    for (const selector of acceptSelectors) {
      try {
        await page.click(selector);
        await page.waitForTimeout(1000);
        break;
      } catch (error) {}
    }

    const cookies = await page.cookies();
    const cookieString = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    puppeteerCookieCache[host] = cookieString;
    await browser.close();
    return cookieString;
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    console.error("[Puppeteer] Failed:", error.message);
    return null;
  }
}

function rewriteCssUrls(cssText, targetUrl) {
  return cssText
    .replace(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, assetUrl) => {
      if (assetUrl.startsWith("data:") || assetUrl.startsWith("#")) return match;
      const absolute = toAbsolute(assetUrl, targetUrl);
      return absolute ? `url('/a?url=${encodeURIComponent(absolute)}')` : match;
    })
    .replace(/@import\s+['"]([^'"]+)['"]/g, (match, importUrl) => {
      const absolute = toAbsolute(importUrl, targetUrl);
      return absolute ? `@import '/a?url=${encodeURIComponent(absolute)}'` : match;
    });
}

function buildInjectedHead(targetUrl) {
  const safeTargetUrl = targetUrl.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `<script>
  (function() {
    try {
      var original = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
      var forced = 'cookie_consent=true;cookieconsent_status=allow;cookies_accepted=true;gdpr_consent=1;consent=1;viewed_cookie_policy=yes;cookie-agreed=2;privacy_policy_accepted=1;terms_accepted=1';
      if (original && original.set) {
        Object.defineProperty(document, 'cookie', {
          get: function() {
            var current = '';
            try { current = original.get.call(document); } catch (error) {}
            return forced + (current ? '; ' + current : '');
          },
          set: function(value) {
            try { original.set.call(document, value); } catch (error) {}
          },
          configurable: true
        });
      }
    } catch (error) {}

    window.__proxyBase = '${safeTargetUrl}';
    var blocked = ['cookie', 'consent', 'gdpr', 'privacy-policy', 'cookie-policy', 'acceptable-use', 'acceptable-usage'];
    function isBlocked(url) {
      if (!url) return false;
      var lowered = String(url).toLowerCase();
      return blocked.some(function(pattern) { return lowered.includes(pattern); });
    }

    try {
      var locationProto = Object.getPrototypeOf(window.location);
      var hrefDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'href') || Object.getOwnPropertyDescriptor(window.location, 'href');
      if (hrefDescriptor && hrefDescriptor.set) {
        Object.defineProperty(window.location, 'href', {
          set: function(url) {
            if (isBlocked(url)) return;
            hrefDescriptor.set.call(window.location, url);
          },
          get: function() {
            return hrefDescriptor.get ? hrefDescriptor.get.call(window.location) : window.location.toString();
          },
          configurable: true
        });
      }
      window.location.assign = function(url) {
        if (isBlocked(url)) return;
        window.location.href = url;
      };
      window.location.replace = function(url) {
        if (isBlocked(url)) return;
        if (hrefDescriptor) hrefDescriptor.set.call(window.location, url);
      };
    } catch (error) {}

    var originalCreateElement = document.createElement.bind(document);
    document.createElement = function(tag) {
      var el = originalCreateElement(tag);
      var lowerTag = (tag || '').toLowerCase();
      if (lowerTag === 'link' || lowerTag === 'script') {
        var originalSetAttribute = el.setAttribute.bind(el);
        el.setAttribute = function(name, value) {
          if ((name === 'href' || name === 'src') && value && !value.startsWith('/a?') && !value.startsWith('data:') && value.includes('.')) {
            try {
              var absolute = new URL(value, window.__proxyBase || location.href).href;
              if (!absolute.startsWith(location.origin)) value = '/a?url=' + encodeURIComponent(absolute);
            } catch (error) {}
          }
          return originalSetAttribute(name, value);
        };
      }
      return el;
    };

    var originalFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
        if (url && !url.startsWith(location.origin) && !url.startsWith('/a?')) {
          var absoluteUrl = new URL(url, window.__proxyBase || location.href).href;
          if (!absoluteUrl.startsWith(location.origin)) {
            var proxyUrl = '/a?url=' + encodeURIComponent(absoluteUrl);
            input = typeof input === 'string' ? proxyUrl : new Request(proxyUrl, input);
          }
        }
      } catch (error) {}
      return originalFetch.call(this, input, init);
    };

    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        if (url && !String(url).startsWith(location.origin)) {
          var absoluteUrl = new URL(url, window.__proxyBase || location.href).href;
          if (!absoluteUrl.startsWith(location.origin)) arguments[1] = '/a?url=' + encodeURIComponent(absoluteUrl);
        }
      } catch (error) {}
      return originalOpen.apply(this, arguments);
    };
  })();
  </script>`;
}

function injectProxyMarkup($, targetUrl) {
  $("head").prepend(buildInjectedHead(targetUrl));
  $("head").append(
    `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" crossorigin="anonymous">`,
  );
  $("head").append(`<style>
    #__proxy_loading__{position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;z-index:2147483647;display:flex;align-items:center;justify-content:center;transition:opacity .3s;}
    @keyframes __proxy_spin__{to{transform:rotate(360deg);}}
  </style>`);
  $("body").prepend(
    `<div id="__proxy_loading__"><div style="text-align:center;color:#888;font-family:sans-serif"><div style="width:36px;height:36px;border:3px solid #eee;border-top-color:#5c6bc0;border-radius:50%;animation:__proxy_spin__ .8s linear infinite;margin:0 auto 10px"></div><div style="font-size:13px">Loading...</div></div></div>`,
  );
  $("body").append(`<script>
    (function() {
      function hideOverlay() {
        var el = document.getElementById('__proxy_loading__');
        if (!el) return;
        el.style.opacity = '0';
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
      }
      window.addEventListener('load', function() { setTimeout(hideOverlay, 300); });
      setTimeout(hideOverlay, 8000);
    })();
    ${COOKIE_KILLER_SCRIPT}
    ${PIN_SCRIPT}
  </script>`);
}

function rewriteHtml($, targetUrl, sessionBase, targetHost) {
  $("script[src*='cookiebot.com']").remove();
  $("script[src*='cookielaw.org']").remove();
  $("script[src*='onetrust.com']").remove();
  $("meta[http-equiv='refresh']").remove();
  $("script[type='text/plain'][data-cookieconsent]").each((_, el) => {
    $(el).attr("type", "text/javascript").removeAttr("data-cookieconsent");
  });

  $("script[type='module']").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (src && /(entry|app|main|_nuxt)/i.test(src)) {
      $(el).remove();
    }
  });
  $("script#__NUXT_DATA__").remove();
  $("script").each((_, el) => {
    const content = $(el).html() || "";
    if (content.includes("window.__NUXT__") && content.length > 100) {
      $(el).remove();
    }
  });

  $("link[integrity], script[integrity]").each((_, el) => {
    $(el).removeAttr("integrity").removeAttr("crossorigin");
  });

  injectProxyMarkup($, targetUrl);

  $("a[href]").each((_, el) => {
    const absolute = toAbsolute($(el).attr("href"), targetUrl);
    if (!absolute) return;
    try {
      const absoluteUrl = new URL(absolute);
      if (absoluteUrl.host === targetHost) {
        $(el).attr(
          "href",
          `${sessionBase}${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`,
        );
      }
    } catch {}
  });

  $("link[href]").each((_, el) => {
    const rel = ($(el).attr("rel") || "").toLowerCase().trim();
    if (rel === "preconnect" || rel === "dns-prefetch") return;
    const absolute = toAbsolute($(el).attr("href"), targetUrl);
    if (absolute) $(el).attr("href", `/a?url=${encodeURIComponent(absolute)}`);
  });

  $("script[src]").each((_, el) => {
    const absolute = toAbsolute($(el).attr("src"), targetUrl);
    if (absolute) $(el).attr("src", `/a?url=${encodeURIComponent(absolute)}`);
  });

  $("img").each((_, el) => {
    [
      "src",
      "data-src",
      "data-lazy-src",
      "data-gt-lazy-src",
      "data-original",
      "data-lazy",
    ].forEach((attr) => {
      const absolute = toAbsolute($(el).attr(attr), targetUrl);
      if (absolute) $(el).attr(attr, `/a?url=${encodeURIComponent(absolute)}`);
    });

    const srcset = $(el).attr("srcset");
    if (!srcset) {
      $(el).removeAttr("srcset");
      return;
    }

    const rewritten = srcset
      .split(",")
      .map((part) => {
        const [assetUrl, descriptor] = part.trim().split(/\s+/);
        const absolute = toAbsolute(assetUrl, targetUrl);
        const proxied = absolute
          ? `/a?url=${encodeURIComponent(absolute)}`
          : assetUrl;
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(", ");
    $(el).attr("srcset", rewritten);
  });

  $("source").each((_, el) => {
    const src = $(el).attr("src");
    if (src) {
      const absolute = toAbsolute(src, targetUrl);
      if (absolute) $(el).attr("src", `/a?url=${encodeURIComponent(absolute)}`);
    }
    const srcset = $(el).attr("srcset");
    if (srcset) {
      const rewritten = srcset
        .split(",")
        .map((part) => {
          const [assetUrl, descriptor] = part.trim().split(/\s+/);
          const absolute = toAbsolute(assetUrl, targetUrl);
          const proxied = absolute
            ? `/a?url=${encodeURIComponent(absolute)}`
            : assetUrl;
          return descriptor ? `${proxied} ${descriptor}` : proxied;
        })
        .join(", ");
      $(el).attr("srcset", rewritten);
    }
  });

  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (!style || !style.includes("url(")) return;
    $(el).attr("style", rewriteCssUrls(style, targetUrl));
  });

  $("style").each((_, el) => {
    const cssText = $(el).html();
    if (!cssText) return;
    $(el).html(rewriteCssUrls(cssText, targetUrl));
  });
}

export function createSession(url) {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  sessions[id] = { url, createdAt: Date.now() };
  const host = new URL(url).hostname.toLowerCase();
  if (process.env.ENABLE_PUPPETEER_PREWARM === "1" && !puppeteerCookieCache[host]) {
    captureConsentCookies(url).catch(() => {});
  }
  return { id, proxyPath: `/s/${id}/` };
}

export function getHealthPayload() {
  return { status: "ok", sessions: Object.keys(sessions).length };
}

export async function handleScreenshot(id, fallbackUrl) {
  const session = hydrateSession(id, fallbackUrl);
  if (!session) {
    return createTextResponse("Session not found", { status: 404 });
  }

  if (screenshotCache[id]) {
    return createTextResponse(screenshotCache[id], {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    );
    await page.goto(session.url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const screenshot = await page.screenshot({
      fullPage: true,
      encoding: "base64",
      type: "jpeg",
      quality: 85,
    });
    await browser.close();

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff}img#screenshot{display:block;width:100%;height:auto}</style></head><body><img id="screenshot" src="data:image/jpeg;base64,${screenshot}" alt="Screenshot of ${session.url}"></body></html>`;
    screenshotCache[id] = html;
    return createTextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    return createTextResponse(
      `<html><body style="font-family:sans-serif;padding:40px;color:#666"><h2>Screenshot failed</h2><p>${error.message}</p></body></html>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

export function handleFindChrome() {
  const preferredCacheDir = getPreferredPuppeteerCacheDir();
  const results = {
    env: {
      PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
      HOME: process.env.HOME,
      cwd: process.cwd(),
      nodeExec: process.execPath,
      preferredCacheDir,
    },
    cacheDirs: {},
  };

  try {
    results.findChrome = execSync(
      'find /home/u741730845 -name "chrome" -o -name "chromium" 2>/dev/null | head -20',
    )
      .toString()
      .trim();
  } catch (error) {
    results.findChrome = error.message;
  }

  const cacheDirs = [
    preferredCacheDir,
    "/home/u741730845/.cache/puppeteer",
    "/home/u741730845/domains/isb-wp-training.com/nodejs/.cache/puppeteer",
    "/root/.cache/puppeteer",
    `${process.env.HOME}/.cache/puppeteer`,
  ];

  for (const dir of cacheDirs) {
    try {
      results.cacheDirs[dir] = fs.existsSync(dir)
        ? fs.readdirSync(dir)
        : "does not exist";
    } catch (error) {
      results.cacheDirs[dir] = `error: ${error.message}`;
    }
  }

  results.detectedChrome = findChromeInCache(preferredCacheDir);

  return createJsonResponse(results);
}

export function handleInstallChrome() {
  const nodeExec = process.execPath;
  const npmPath = path.join(path.dirname(nodeExec), "npm");
  const cwd = process.cwd();
  const methods = [
    `"${nodeExec}" node_modules/puppeteer/install.mjs`,
    `"${nodeExec}" node_modules/.bin/puppeteer browsers install chrome`,
    `"${npmPath}" exec puppeteer browsers install chrome`,
  ];

  for (const command of methods) {
    try {
      const output = execSync(command, {
        timeout: 120000,
        cwd,
        env: {
          ...process.env,
          PUPPETEER_CACHE_DIR: getPreferredPuppeteerCacheDir(),
        },
      }).toString();
      return createJsonResponse({
        status: "done",
        method: command,
        output: output.slice(-500),
      });
    } catch (error) {}
  }

  return createJsonResponse({
    status: "all methods failed",
    nodeExec,
    npmPath,
    cwd,
  });
}

export async function handleTestPuppeteer() {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    const title = await page.title();
    await browser.close();
    return createJsonResponse({
      status: "puppeteer works!",
      title,
      cwd: process.cwd(),
    });
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    let cacheContents = {};
    try {
      const cachePath = path.join(
        /* turbopackIgnore: true */ getPreferredPuppeteerCacheDir(),
      );
      if (fs.existsSync(cachePath)) {
        cacheContents = fs.readdirSync(cachePath);
      }
    } catch {}
    return createJsonResponse({
      status: "failed",
      error: error.message,
      cwd: process.cwd(),
      cacheContents,
    });
  }
}

export async function handleAssetProxy(targetUrl) {
  if (!targetUrl) {
    return createTextResponse("Missing url", { status: 400 });
  }

  const blockedPatterns = [
    "acceptable-use",
    "acceptable-usage",
    "cookie-policy",
    "privacy-policy",
    "gdpr",
    "cookie-consent",
  ];

  if (blockedPatterns.some((pattern) => targetUrl.toLowerCase().includes(pattern))) {
    const contentType = guessContentType(targetUrl);
    if (contentType?.includes("javascript")) {
      return createTextResponse("/* ok */", {
        headers: { "Content-Type": "application/javascript" },
      });
    }
    if (contentType?.includes("css")) {
      return createTextResponse("", { headers: { "Content-Type": "text/css" } });
    }
    return createTextResponse('{"status":"ok"}', {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const response = await smartFetch(
      targetUrl,
      getCookieHeader(parsedTarget.host),
      false,
    );
    extractCookies(parsedTarget.host, response.headers["set-cookie"]);

    let contentType = response.headers["content-type"] || "";
    const baseContentType = contentType.split(";")[0].trim();
    const guessedType = guessContentType(targetUrl);

    if (
      baseContentType === "text/html" &&
      guessedType &&
      guessedType !== "text/html"
    ) {
      if (guessedType.includes("javascript")) {
        return createTextResponse("/* unavailable */", {
          headers: { "Content-Type": "application/javascript" },
        });
      }
      if (guessedType.includes("css")) {
        return createTextResponse("", { headers: { "Content-Type": "text/css" } });
      }
      return createTextResponse("", { status: 200 });
    }

    if (guessedType && (!contentType || baseContentType === "application/octet-stream")) {
      contentType = guessedType;
    }

    const isCss = baseContentType === "text/css" || guessedType === "text/css";
    if (isCss) {
      const cssText = rewriteCssUrls(
        Buffer.from(response.data).toString("utf-8"),
        targetUrl,
      );
      return createTextResponse(cssText, {
        headers: createProxyHeaders("text/css", {
          "Cache-Control": "public, max-age=3600",
        }),
      });
    }

    const headers = createProxyHeaders(contentType || "application/octet-stream", {
      "Cache-Control": "public, max-age=3600",
    });
    if (
      contentType.includes("font") ||
      /\.(woff2?|ttf|eot|otf)(\?|$)/i.test(targetUrl)
    ) {
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    }
    return createBinaryResponse(response.data, { headers });
  } catch (error) {
    console.error("[Asset] Error:", error.message);
    return createTextResponse("", { status: 200 });
  }
}

export async function handleSessionProxy({
  id,
  subPath = "/",
  search = "",
  accept = "",
  sessionUrl = null,
}) {
  const session = hydrateSession(id, sessionUrl);
  if (!session) {
    return createTextResponse(
      '<html><body style="font-family:sans-serif;padding:40px"><h2>Session expired</h2><p><a href="/">Go back</a></p></body></html>',
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  const blockedPatterns = [
    "acceptable-use",
    "acceptable-usage",
    "cookie-policy",
    "privacy-policy",
    "gdpr",
    "cookie-consent",
    "terms-of-service",
  ];

  if (blockedPatterns.some((pattern) => subPath.toLowerCase().includes(pattern))) {
    if (accept.includes("application/json")) {
      return createTextResponse('{"status":"ok"}', {
        headers: { "Content-Type": "application/json" },
      });
    }
    return createTextResponse("<!DOCTYPE html><html><head></head><body></body></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let targetUrl = session.url;
  if (subPath !== "/") {
    try {
      targetUrl = new URL(`${subPath}${search}`, session.url).href;
    } catch {}
  }

  try {
    const targetBase = new URL(session.url);
    const response = await smartFetch(
      targetUrl,
      getCookieHeader(targetBase.host),
      true,
    );
    extractCookies(targetBase.host, response.headers["set-cookie"]);

    const contentType = response.headers["content-type"] || "";
    if (!contentType.includes("text/html")) {
      const guessedType = guessContentType(targetUrl);
      const finalType =
        guessedType && (!contentType || contentType.includes("octet-stream"))
          ? guessedType
          : contentType || "application/octet-stream";
      return createBinaryResponse(response.data, {
        headers: createProxyHeaders(finalType),
      });
    }

    const html = Buffer.from(response.data).toString("utf-8");
    const $ = cheerio.load(html);
    rewriteHtml($, targetUrl, `/s/${id}`, targetBase.host);

    return createTextResponse($.html(), {
      headers: createProxyHeaders("text/html; charset=utf-8"),
    });
  } catch (error) {
    console.error("[Proxy] Error:", error.message);
    return createTextResponse(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Proxy error</h2><p>${error.message}</p></body></html>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

export async function handleRootRelativeAsset({
  requestPath,
  search = "",
  referer = "",
}) {
  const ext = requestPath.split(".").pop().toLowerCase();
  const assetExts = [
    "js",
    "mjs",
    "css",
    "woff",
    "woff2",
    "ttf",
    "svg",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "ico",
    "json",
    "map",
  ];

  if (!assetExts.includes(ext)) return null;

  let originDomain = null;
  try {
    const refererUrl = new URL(referer);
    const sessionMatch = refererUrl.pathname.match(/^\/s\/([a-f0-9]+)\//);
    if (sessionMatch) {
      const session = sessions[sessionMatch[1]];
      if (session) originDomain = new URL(session.url).origin;
    }
  } catch {}

  if (!originDomain) return null;

  const targetUrl = `${originDomain}${requestPath}${search}`;
  try {
    const response = await smartFetch(
      targetUrl,
      getCookieHeader(new URL(originDomain).hostname),
      false,
    );
    let contentType = response.headers["content-type"] || "";
    const guessedType = guessContentType(targetUrl);
    if (guessedType && (!contentType || contentType.includes("text/html"))) {
      contentType = guessedType;
    }
    return createBinaryResponse(response.data, {
      headers: createProxyHeaders(contentType || "application/octet-stream", {
        "Cache-Control": "public, max-age=3600",
      }),
    });
  } catch (error) {
    console.error("[Catch-all] Error:", error.message);
    return null;
  }
}
