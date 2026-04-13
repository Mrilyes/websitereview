process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};
const cookieJar = {};
const puppeteerCookieCache = {};

// CF Worker for Cloudflare-protected sites
const CF_WORKER_URL = 'https://cool-wildflower-6b0f.frikhab513.workers.dev/';
const CF_WORKER_SECRET = 'xk92mZ7pQr';
const cfWorkerDomains = new Set([
  'hosting.com', 'www.hosting.com',
  'godaddy.com', 'www.godaddy.com',
  'ovh.com', 'www.ovh.com',
]);

function extractCookies(domain, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  if (!cookieJar[domain]) cookieJar[domain] = {};
  headers.forEach(header => {
    const part = header.split(';')[0];
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) return;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) cookieJar[domain][key] = val;
  });
}

function getCookieHeader(domain) {
  const consentBase = [
    'cookie_consent=true', 'cookieconsent_status=allow',
    'cookies_accepted=true', 'gdpr_consent=1', 'consent=1',
    'viewed_cookie_policy=yes', 'cookie-agreed=2', 'euconsent=true',
    'accept-cookies=true', 'cookie_notice_accepted=true',
    'cookies-consent=1', 'cookie_accepted=true',
    'cookie_consent_level=all', 'privacy_policy_accepted=1', 'terms_accepted=1',
  ].join('; ');

  // Use Puppeteer-captured cookies if available
  const puppeteerCookies = puppeteerCookieCache[domain] || puppeteerCookieCache['www.' + domain] || '';

  const stored = cookieJar[domain]
    ? Object.entries(cookieJar[domain]).map(([k,v]) => `${k}=${v}`).join('; ')
    : '';

  return [consentBase, puppeteerCookies, stored].filter(Boolean).join('; ');
}

function toAbsolute(href, baseUrl, pageUrl) {
  if (!href) return null;
  if (href.startsWith('data:') || href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('blob:')) return null;
  try {
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    if (href.startsWith('//')) return 'https:' + href;
    return new URL(href, pageUrl).href;
  } catch { return null; }
}

function guessContentType(url) {
  const u = url.split('?')[0];
  if (u.endsWith('.css')) return 'text/css';
  if (u.endsWith('.js') || u.endsWith('.mjs')) return 'application/javascript';
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.svg')) return 'image/svg+xml';
  if (u.endsWith('.woff')) return 'font/woff';
  if (u.endsWith('.woff2')) return 'font/woff2';
  if (u.endsWith('.ttf')) return 'font/ttf';
  if (u.endsWith('.otf')) return 'font/otf';
  if (u.endsWith('.eot')) return 'application/vnd.ms-fontobject';
  if (u.endsWith('.ico')) return 'image/x-icon';
  if (u.endsWith('.json')) return 'application/json';
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.gif')) return 'image/gif';
  return null;
}

async function fetchViaWorker(targetUrl, cookieHeader) {
  console.log(`[Worker] Calling worker for: ${targetUrl}`);
  const workerUrl = `${CF_WORKER_URL}?secret=${CF_WORKER_SECRET}&url=${encodeURIComponent(targetUrl)}`;
  const response = await axios.get(workerUrl, {
    responseType: 'arraybuffer',
    validateStatus: () => true,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  console.log(`[Worker] Response status: ${response.status} for ${targetUrl}`);
  const setCookie = response.headers['x-proxy-set-cookie'];
  if (setCookie) response.headers['set-cookie'] = setCookie;
  return response;
}

async function smartFetch(targetUrl, cookieHeader, isHtml = false) {
  const host = new URL(targetUrl).hostname.toLowerCase();
  const useWorker = isHtml && cfWorkerDomains.has(host);

  if (useWorker) {
    console.log(`[Worker] Fetching HTML via CF worker: ${targetUrl}`);
    return fetchViaWorker(targetUrl, cookieHeader);
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': isHtml ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cookie': cookieHeader || '',
  };
  if (isHtml) {
    headers['Upgrade-Insecure-Requests'] = '1';
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none';
    headers['Sec-Fetch-User'] = '?1';
  }

  const response = await axios.get(targetUrl, {
    headers,
    responseType: 'arraybuffer',
    validateStatus: () => true,
    maxRedirects: 5,
    timeout: 15000,
  });

  // Auto-detect CF blocks on HTML requests and retry via worker
  if (isHtml) {
    const ct = response.headers['content-type'] || '';
    if ((response.status === 403 || response.status === 429 || response.status === 503) && ct.includes('text/html')) {
      const body = response.data.toString('utf-8');
      if (body.includes('cloudflare') || body.includes('Ray ID') || body.includes('1015') || body.includes('rate limit') || body.includes('banned')) {
        console.log(`[Worker] CF block detected for ${host}, routing via worker...`);
        cfWorkerDomains.add(host);
        return fetchViaWorker(targetUrl, cookieHeader);
      }
    }

    // Auto-detect consent redirects — use Puppeteer to capture real cookies
    if (response.status === 302 || response.status === 301) {
      const location = response.headers['location'] || '';
      const CONSENT_PATTERNS = ['cookie', 'consent', 'gdpr', 'privacy', 'acceptable-use', 'acceptable-usage'];
      if (CONSENT_PATTERNS.some(p => location.toLowerCase().includes(p))) {
        console.log(`[Puppeteer] Consent redirect detected for ${host} → ${location}`);
        const puppeteerCookies = await captureConsentCookies(targetUrl);
        if (puppeteerCookies) {
          console.log(`[Puppeteer] Retrying ${host} with captured cookies`);
          headers['Cookie'] = puppeteerCookies;
          return axios.get(targetUrl, {
            headers,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            maxRedirects: 5,
            timeout: 15000,
          });
        }
      }
    }

    // Also detect HTML consent pages (200 but consent page content)
    if (response.status === 200) {
      const ct = response.headers['content-type'] || '';
      if (ct.includes('text/html') && !puppeteerCookieCache[host]) {
        const body = response.data.toString('utf-8').slice(0, 3000);
        const CONSENT_PATTERNS = ['acceptable-usage-policy', 'acceptable-use-policy', 'cookie-consent-required'];
        if (CONSENT_PATTERNS.some(p => body.toLowerCase().includes(p))) {
          console.log(`[Puppeteer] Consent page detected for ${host}, capturing cookies...`);
          const puppeteerCookies = await captureConsentCookies(targetUrl);
          if (puppeteerCookies) {
            headers['Cookie'] = puppeteerCookies;
            return axios.get(targetUrl, {
              headers,
              responseType: 'arraybuffer',
              validateStatus: () => true,
              maxRedirects: 5,
              timeout: 15000,
            });
          }
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
  var __hoverStyle = null;

  // ── Hover highlight style ──
  var __highlightCSS = document.createElement('style');
  __highlightCSS.textContent = '.__mk_hover__ { outline: 2px dashed #5c6bc0 !important; outline-offset: 2px !important; cursor: crosshair !important; }';
  document.head.appendChild(__highlightCSS);

  // ── postMessage listener ──
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.__markupType) return;
    var t = e.data.__markupType;
    if (t === 'SET_MODE') {
      __mode = e.data.mode;
      document.body.style.cursor = __mode === 'comment' ? 'crosshair' : '';
      if (__mode === 'browse') { clearHover(); }
    }
    if (t === 'LOAD_PINS') { e.data.pins.forEach(function(p){ renderPin(p); }); }
    if (t === 'DELETE_PIN') { var el = document.querySelector('[data-mkpin="'+e.data.id+'"]'); if (el) el.remove(); }
    if (t === 'HIGHLIGHT_PIN') {
      document.querySelectorAll('[data-mkpin]').forEach(function(p){ p.style.outline=''; });
      var pin = document.querySelector('[data-mkpin="'+e.data.id+'"]');
      if (pin) { pin.style.outline='3px solid #f59e0b'; pin.scrollIntoView({behavior:'smooth',block:'center'}); setTimeout(function(){ pin.style.outline=''; }, 2000); }
    }
    if (t === 'UPDATE_PIN') {
      var pin = document.querySelector('[data-mkpin="'+e.data.id+'"]');
      if (pin) pin.style.background = e.data.resolved ? '#4caf50' : '#5c6bc0';
    }
  });

  // ── Hover highlight ──
  function clearHover() {
    if (__hovered) { __hovered.classList.remove('__mk_hover__'); __hovered = null; }
  }

  document.addEventListener('mouseover', function(e) {
    if (__mode !== 'comment') return;
    var target = e.target;
    if (target === document.body || target === document.documentElement) return;
    if (target.closest('[data-mkpin]') || target.id === '__mkbubble__') return;
    // Use parent for replaced elements
    if (REPLACED.indexOf(target.tagName) !== -1) target = target.parentElement || target;
    // Skip very large containers
    var rect = target.getBoundingClientRect();
    var isFullPage = rect.width >= window.innerWidth * 0.98 && rect.height >= window.innerHeight * 0.98;
    if (isFullPage) return;
    if (__hovered !== target) { clearHover(); __hovered = target; target.classList.add('__mk_hover__'); }
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (__mode !== 'comment') return;
    if (e.target === __hovered) { clearHover(); }
  }, true);

  // ── Click to place pin ──
  var REPLACED = ['IMG','VIDEO','CANVAS','INPUT','TEXTAREA','SELECT','IFRAME','EMBED','OBJECT','SVG'];

  document.addEventListener('click', function(e) {
    if (__mode !== 'comment') return;
    if (e.target.closest('[data-mkpin]') || e.target.closest('#__mkbubble__')) return;
    e.preventDefault(); e.stopPropagation();

    clearHover();
    var target = e.target;
    if (target === document.body || target === document.documentElement) target = document.elementFromPoint(e.clientX, e.clientY) || document.body;

    // Replaced elements can't have children — use parent instead
    if (REPLACED.indexOf(target.tagName) !== -1) {
      target = target.parentElement || target;
    }

    var rect = target.getBoundingClientRect();
    var offsetX = e.clientX - rect.left;
    var offsetY = e.clientY - rect.top;
    __pinCount++;
    var pinId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);

    var pos = window.getComputedStyle(target).position;
    if (pos === 'static') target.style.position = 'relative';

    var pin = document.createElement('div');
    pin.setAttribute('data-mkpin', pinId);
    pin.style.cssText = [
      'position:absolute!important',
      'top:'+offsetY+'px!important',
      'left:'+offsetX+'px!important',
      'transform:translate(-50%,-50%)!important',
      'width:24px!important','height:24px!important',
      'background:#5c6bc0!important','color:#fff!important',
      'border-radius:50%!important','border:2.5px solid #fff!important',
      'display:flex!important','align-items:center!important','justify-content:center!important',
      'font-size:11px!important','font-weight:700!important',
      'font-family:-apple-system,sans-serif!important',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)!important',
      'cursor:pointer!important','z-index:9999999!important',
      'user-select:none!important',
    ].join(';');
    pin.textContent = __pinCount;
    target.appendChild(pin);

    showBubble(pin, offsetX, offsetY, pinId, __pinCount, target);
  }, true);

  // ── Comment bubble ──
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
      'position:fixed!important','z-index:99999999!important',
      'left:'+left+'px!important','top:'+top+'px!important',
      'width:260px!important',
      'background:#fff!important','border-radius:12px!important',
      'box-shadow:0 8px 32px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08)!important',
      'padding:14px!important',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif!important',
    ].join(';');

    bubble.innerHTML = '<textarea placeholder="Add comment here..." style="width:100%!important;height:74px!important;border:1.5px solid #e0e0e0!important;border-radius:8px!important;padding:9px 10px!important;font-size:13px!important;resize:none!important;outline:none!important;font-family:inherit!important;display:block!important;color:#333!important;background:#fff!important;box-sizing:border-box!important;line-height:1.45!important;"></textarea><div style="display:flex!important;justify-content:flex-end!important;gap:8px!important;margin-top:10px!important;"><button id="__mkcancel__" style="padding:6px 14px!important;border:1.5px solid #e0e0e0!important;border-radius:7px!important;background:#fff!important;cursor:pointer!important;font-size:13px!important;color:#666!important;font-family:inherit!important;font-weight:500!important;">Cancel</button><button id="__mksave__" style="padding:6px 16px!important;border:none!important;border-radius:7px!important;background:#5c6bc0!important;color:#fff!important;cursor:pointer!important;font-size:13px!important;font-weight:600!important;font-family:inherit!important;">Save</button></div>';

    document.body.appendChild(bubble);
    var ta = bubble.querySelector('textarea');
    ta.addEventListener('focus', function(){ ta.style.borderColor='#5c6bc0'; });
    ta.addEventListener('blur',  function(){ ta.style.borderColor='#e0e0e0'; });
    setTimeout(function(){ ta.focus(); }, 40);

    ta.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
      if (ev.key === 'Escape') cancel();
    });
    document.getElementById('__mkcancel__').onclick = cancel;
    document.getElementById('__mksave__').onclick   = save;

    function cancel() {
      removeBubble(); pin.remove(); __pinCount--;
      window.parent.postMessage({ __markupType: 'PIN_CANCELLED' }, '*');
    }
    function save() {
      var txt = ta.value.trim();
      if (!txt) { ta.style.borderColor='#ef4444'; ta.focus(); return; }
      removeBubble();
      window.parent.postMessage({
        __markupType: 'PIN_CREATED',
        pin: {
          id: pinId, number: pinNum, comment: txt,
          pageUrl: window.location.href,
          xpath: getXPath(target),
          offsetX: ox, offsetY: oy,
          timestamp: Date.now()
        }
      }, '*');
    }
  }

  function removeBubble() {
    var b = document.getElementById('__mkbubble__'); if (b) b.remove();
  }

  // ── Render existing pin ──
  function renderPin(p) {
    try {
      var el = document.evaluate(p.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return;
      if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
      var pin = document.createElement('div');
      pin.setAttribute('data-mkpin', p.id);
      pin.style.cssText = [
        'position:absolute!important',
        'top:'+p.offsetY+'px!important','left:'+p.offsetX+'px!important',
        'transform:translate(-50%,-50%)!important',
        'width:24px!important','height:24px!important',
        'background:'+(p.resolved?'#4caf50':'#5c6bc0')+'!important',
        'color:#fff!important','border-radius:50%!important','border:2.5px solid #fff!important',
        'display:flex!important','align-items:center!important','justify-content:center!important',
        'font-size:11px!important','font-weight:700!important',
        'font-family:-apple-system,sans-serif!important',
        'box-shadow:0 2px 10px rgba(0,0,0,.3)!important',
        'cursor:pointer!important','z-index:9999999!important','user-select:none!important',
      ].join(';');
      pin.textContent = p.number;
      if (p.number > __pinCount) __pinCount = p.number;
      el.appendChild(pin);
    } catch(e) {}
  }

  // ── XPath ──
  function getXPath(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      var i = 1, sib = el.previousSibling;
      while (sib) { if (sib.nodeType===1 && sib.nodeName===el.nodeName) i++; sib=sib.previousSibling; }
      parts.unshift(el.nodeName.toLowerCase()+'['+i+']');
      el = el.parentNode;
    }
    return '/'+parts.join('/');
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
  } catch(e) {}

  // document.cookie fake already set in <head>

  var COOKIE_REDIRECT_PATTERNS = ['cookie','consent','gdpr','privacy-policy','cookie-policy','acceptable-use','acceptable-usage','terms','legal'];
  function isCookieRedirect(url) {
    if (!url) return false;
    var u = String(url).toLowerCase();
    return COOKIE_REDIRECT_PATTERNS.some(function(p) { return u.includes(p); });
  }

  // Location interceptors already set in <head>

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('meta[http-equiv="refresh"]').forEach(function(m) { m.remove(); });
  });

  var COOKIE_SELECTORS = [
    '#CybotCookiebotDialog','.CybotCookiebotDialogBodyButton','#cookiebanner',
    '#onetrust-banner-sdk','#onetrust-consent-sdk','.onetrust-pc-dark-filter',
    '.cky-consent-container','.cky-overlay','#cky-consent',
    '#didomi-host','#didomi-popup','.didomi-popup-overlay','.didomi-notice',
    '#usercentrics-root','#truste-consent-content','.truste_overlay','.trustarc-banner',
    '#qcCmpUi','.qc-cmp2-container','.osano-cm-window','.osano-cm-overlay',
    '#consent-overlay','.consent-overlay',
    '#cookie-banner','#cookie-notice','#cookie-bar','#cookie-consent','#cookie-popup','#cookie-modal',
    '.cookie-banner','.cookie-notice','.cookie-bar','.cookie-consent','.cookie-popup','.cookie-modal',
    '.cookie-overlay','.cookie-disclaimer',
    '#gdpr-banner','#gdpr-notice','#gdpr-popup','.gdpr-banner','.gdpr-notice','.gdpr-popup','.gdpr-overlay','.gdpr-consent',
    '.cc-window','.cc-banner','.cc-overlay','#cc-main',
    '#hs-eu-cookie-confirmation','#iubenda-cs-banner','.iubenda-cs-overlay',
    '#cookie-law-info-bar','.cookiefirst-root','#BorlabsCookieBox',
    '[data-testid="cookie-banner"]','[class*="CookieBanner"]','[class*="cookieBanner"]',
    '[class*="CookieConsent"]','[class*="cookieConsent"]',
    '.h-cookie-consent-wrapper','.h-cookie-consent',
  ];

  var style = document.createElement('style');
  style.textContent = COOKIE_SELECTORS.map(function(s) {
    return s + '{display:none!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;}';
  }).join('') + 'body[style*="overflow: hidden"]{overflow:auto!important;}';
  document.head.appendChild(style);

  function tryAcceptKnown() {
    var sels = ['#CybotCookiebotDialogBodyButtonAccept','#onetrust-accept-btn-handler','.cc-accept-all','button[class*="accept"]','button[id*="accept"]'];
    for (var i = 0; i < sels.length; i++) {
      var btn = document.querySelector(sels[i]);
      if (btn && btn.offsetParent !== null) { try { btn.click(); } catch(e) {} return; }
    }
  }

  function isLikelyCookieBanner(el) {
    if (!el || el.nodeType !== 1) return false;
    var text = (el.innerText || el.textContent || '').toLowerCase();
    var hasKeyword = ['cookie','cookies','consent','gdpr','accept all','reject all'].some(function(kw) { return text.includes(kw); });
    if (!hasKeyword) return false;
    var rect = el.getBoundingClientRect();
    if (rect.height > window.innerHeight * 0.6) return false;
    if (rect.width < window.innerWidth * 0.3) return false;
    var computed = window.getComputedStyle(el);
    return computed.position === 'fixed' || computed.position === 'sticky' || parseInt(computed.zIndex) > 100;
  }

  function killIfCookieBanner(el) {
    if (isLikelyCookieBanner(el)) {
      el.style.cssText = 'display:none!important;visibility:hidden!important;pointer-events:none!important;';
      document.body.style.overflow = '';
      return true;
    }
    return false;
  }

  function scanExisting() {
    document.querySelectorAll('div,section,aside').forEach(function(el) {
      if (el.children.length > 0 && el.children.length < 30) killIfCookieBanner(el);
    });
    tryAcceptKnown();
    if (document.body && document.body.style.overflow === 'hidden') document.body.style.overflow = '';
  }

  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        var id = (node.id || '').toLowerCase();
        var cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
        if (id.includes('cookie') || id.includes('consent') || id.includes('gdpr') ||
            cls.includes('cookie') || cls.includes('consent') || cls.includes('gdpr') ||
            id.includes('didomi') || id.includes('onetrust') || id.includes('cybot')) {
          node.style.cssText = 'display:none!important;visibility:hidden!important;';
          return;
        }
        killIfCookieBanner(node);
      });
    });
    if (document.body && document.body.style.overflow === 'hidden') document.body.style.overflow = '';
    tryAcceptKnown();
  });

  function startObserver() {
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    scanExisting();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      startObserver();
      setTimeout(scanExisting, 500);
      setTimeout(scanExisting, 1500);
      setTimeout(scanExisting, 3000);
    });
  } else {
    startObserver();
    setTimeout(scanExisting, 500);
    setTimeout(scanExisting, 1500);
    setTimeout(scanExisting, 3000);
  }
})();
`;

// ── Screenshot fallback for blocked sites ────────────────────
const screenshotCache = {};

app.get('/api/screenshot/:id', async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).send('Session not found');

  const cached = screenshotCache[req.params.id];
  if (cached) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(cached);
  }

  let browser;
  try {
    console.log(`[Screenshot] Taking screenshot of ${session.url}`);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.goto(session.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000)); // wait for lazy content

    const screenshot = await page.screenshot({ fullPage: true, encoding: 'base64', type: 'jpeg', quality: 85 });
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await browser.close();

    // Return an HTML page with the screenshot as background — pins work on top
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  img#screenshot { display: block; width: 100%; height: auto; }
</style></head><body>
<img id="screenshot" src="data:image/jpeg;base64,${screenshot}" alt="Screenshot of ${session.url}">
</body></html>`;

    screenshotCache[req.params.id] = html;
    console.log(`[Screenshot] Done for ${session.url} (height: ${pageHeight}px)`);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    console.error('[Screenshot] Error:', e.message);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px;color:#666">
      <h2>Screenshot failed</h2><p>${e.message}</p>
    </body></html>`);
  }
});


app.post('/api/session', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  const id = uuidv4().replace(/-/g, '').slice(0, 12);
  sessions[id] = { url, createdAt: Date.now() };
  console.log(`[Session] ${id} → ${url}`);

  // Pre-warm Puppeteer cookies in background for any site not yet cached
  const host = new URL(url).hostname.toLowerCase();
  if (!puppeteerCookieCache[host]) {
    captureConsentCookies(url).catch(() => {});
  }

  res.json({ id, proxyPath: `/s/${id}/` });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', sessions: Object.keys(sessions).length });
});

// ── Find Chrome on filesystem ─────────────────────────────────
app.get('/api/find-chrome', (req, res) => {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const results = {};

  // Check env vars
  results.env = {
    PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
    HOME: process.env.HOME,
    cwd: process.cwd(),
    nodeExec: process.execPath,
  };

  // Try to find chrome binary
  try {
    results.findChrome = execSync('find /home/u741730845 -name "chrome" -o -name "chromium" 2>/dev/null | head -20').toString().trim();
  } catch(e) { results.findChrome = e.message; }

  // Check cache dirs
  const cacheDirs = [
    '/home/u741730845/.cache/puppeteer',
    '/home/u741730845/domains/isb-wp-training.com/nodejs/.cache/puppeteer',
    '/root/.cache/puppeteer',
    `${process.env.HOME}/.cache/puppeteer`,
  ];

  results.cacheDirs = {};
  for (const d of cacheDirs) {
    try {
      results.cacheDirs[d] = fs.existsSync(d) ? fs.readdirSync(d) : 'does not exist';
    } catch(e) {
      results.cacheDirs[d] = 'error: ' + e.message;
    }
  }

  res.json(results);
});
app.get('/api/install-chrome', async (req, res) => {
  const { execSync } = require('child_process');
  const path = require('path');

  // Find node and npm paths
  const nodeExec = process.execPath; // full path to node binary
  const npmPath = path.join(path.dirname(nodeExec), 'npm');
  const cwd = process.cwd();

  console.log('[Chrome] Node path:', nodeExec);
  console.log('[Chrome] npm path:', npmPath);
  console.log('[Chrome] cwd:', cwd);

  // Try multiple install methods
  const methods = [
    `"${nodeExec}" node_modules/puppeteer/install.mjs`,
    `"${nodeExec}" node_modules/.bin/puppeteer browsers install chrome`,
    `"${npmPath}" exec puppeteer browsers install chrome`,
    `"${nodeExec}" -e "require('puppeteer/internal/node/install.js')"`,
  ];

  for (const cmd of methods) {
    try {
      console.log('[Chrome] Trying:', cmd);
      const output = execSync(cmd, {
        timeout: 120000,
        cwd,
        env: { ...process.env, PUPPETEER_CACHE_DIR: path.join(cwd, '.cache/puppeteer') },
      }).toString();
      console.log('[Chrome] Success:', output.slice(-200));
      return res.json({ status: 'done', method: cmd, output: output.slice(-500) });
    } catch (e) {
      console.log('[Chrome] Failed:', e.message.slice(0, 100));
    }
  }

  res.json({
    status: 'all methods failed',
    nodeExec,
    npmPath,
    cwd,
    hint: 'Try SSH into the server and run: node node_modules/puppeteer/install.mjs'
  });
});

const CHROME_PATH = '/home/u741730845/domains/isb-wp-training.com/nodejs/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome';
const CHROME_HEADLESS_SHELL_PATH = '/home/u741730845/domains/isb-wp-training.com/nodejs/.cache/puppeteer/chrome-headless-shell/linux-127.0.6533.88/chrome-headless-shell-linux64/chrome-headless-shell';
const NODE_EXEC = '/opt/alt/alt-nodejs22/root/usr/bin/node';

// Singleton promise — prevents race condition during install
let chromeInstallPromise = null;

async function ensureChrome() {
  if (chromeInstallPromise) return chromeInstallPromise;

  const fs = require('fs');
  if (fs.existsSync(CHROME_PATH)) {
    console.log('[Chrome] Already installed ✓');
    return;
  }

  chromeInstallPromise = (async () => {
    console.log('[Chrome] Not found, installing...');
    try {
      const { execSync } = require('child_process');
      const output = execSync(`"${NODE_EXEC}" node_modules/puppeteer/install.mjs`, {
        timeout: 180000,
        cwd: process.cwd(),
        env: {
          ...process.env,
          PUPPETEER_CACHE_DIR: '/home/u741730845/domains/isb-wp-training.com/nodejs/.cache/puppeteer',
        },
      }).toString();
      console.log('[Chrome] Installation complete:', output.slice(-200));
    } catch (e) {
      console.error('[Chrome] Installation failed:', e.message.slice(0, 200));
    } finally {
      chromeInstallPromise = null;
    }
  })();

  return chromeInstallPromise;
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  const fs = require('fs');

  // Wait for any ongoing install to complete
  await ensureChrome();

  // Only use full Chrome — headless-shell has V8 snapshot issues on this server
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome not found at ${CHROME_PATH}`);
  }

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--mute-audio',
  ];

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args });
  console.log('[Puppeteer] Browser launched ✓');
  return browser;
}
app.get('/api/test-puppeteer', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    await browser.close();
    res.json({ status: 'puppeteer works!', title, cwd: process.cwd() });
  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    // Show diagnostic info
    const fs = require('fs');
    const path = require('path');
    const cwd = process.cwd();
    let cacheContents = {};
    try {
      const cachePath = path.join(cwd, '.cache/puppeteer');
      if (fs.existsSync(cachePath)) {
        cacheContents = fs.readdirSync(cachePath);
      }
    } catch {}
    res.json({ status: 'failed', error: e.message, cwd, cacheContents });
  }
});

// ── Puppeteer cookie capture ──────────────────────────────────

async function captureConsentCookies(targetUrl) {
  const host = new URL(targetUrl).hostname;
  if (puppeteerCookieCache[host]) {
    console.log(`[Puppeteer] Using cached cookies for ${host}`);
    return puppeteerCookieCache[host];
  }

  console.log(`[Puppeteer] Capturing consent cookies for ${host}`);
  let browser;
  try {
    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Try to click accept button
    const acceptSelectors = [
      '#CybotCookiebotDialogBodyButtonAccept',
      '#onetrust-accept-btn-handler',
      'button[id*="accept"]',
      'button[class*="accept"]',
      '[data-testid="cookie-banner-accept-button"]',
      '.cc-accept-all',
    ];

    for (const sel of acceptSelectors) {
      try {
        await page.click(sel);
        console.log(`[Puppeteer] Clicked consent button: ${sel}`);
        await page.waitForTimeout(1000);
        break;
      } catch {}
    }

    // Get all cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    puppeteerCookieCache[host] = cookieString;
    console.log(`[Puppeteer] Captured ${cookies.length} cookies for ${host}`);
    return cookieString;
  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    console.error(`[Puppeteer] Failed for ${host}:`, e.message);
    return null;
  }
}

// ── Asset proxy /a?url= ───────────────────────────────────────
app.get('/a', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  const BLOCKED_PATTERNS = ['acceptable-use', 'acceptable-usage', 'cookie-policy', 'privacy-policy', 'gdpr', 'cookie-consent'];
  if (BLOCKED_PATTERNS.some(p => targetUrl.toLowerCase().includes(p))) {
    const ct = guessContentType(targetUrl);
    if (ct && ct.includes('javascript')) return res.setHeader('Content-Type','application/javascript').send('/* ok */');
    if (ct && ct.includes('css')) return res.setHeader('Content-Type','text/css').send('');
    return res.setHeader('Content-Type','application/json').send('{"status":"ok"}');
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const response = await smartFetch(targetUrl, getCookieHeader(parsedTarget.host), false);
    extractCookies(parsedTarget.host, response.headers['set-cookie']);

    let contentType = response.headers['content-type'] || '';
    const baseContentType = contentType.split(';')[0].trim();
    const guessed = guessContentType(targetUrl);

    if (baseContentType === 'text/html' && guessed && guessed !== 'text/html') {
      if (guessed.includes('javascript')) { res.setHeader('Content-Type','application/javascript'); return res.send('/* unavailable */'); }
      if (guessed.includes('css')) { res.setHeader('Content-Type','text/css'); return res.send(''); }
      return res.status(200).send('');
    }
    if (guessed && (!contentType || baseContentType === 'application/octet-stream')) contentType = guessed;

    const isFont = contentType.includes('font') || /\.(woff2?|ttf|eot|otf)(\?|$)/i.test(targetUrl);
    if (isFont) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', '');

    const isCss = baseContentType === 'text/css' || (guessed && guessed === 'text/css');
    if (isCss) {
      let cssText = response.data.toString('utf-8');
      const cssBase = `${parsedTarget.protocol}//${parsedTarget.host}`;
      cssText = cssText.replace(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, p1) => {
        if (p1.startsWith('data:') || p1.startsWith('#')) return match;
        try {
          const absolute = toAbsolute(p1, cssBase, targetUrl);
          if (absolute) return `url('/a?url=${encodeURIComponent(absolute)}')`;
        } catch {}
        return match;
      });
      cssText = cssText.replace(/@import\s+['"]([^'"]+)['"]/g, (match, p1) => {
        try {
          const absolute = toAbsolute(p1, cssBase, targetUrl);
          if (absolute) return `@import '/a?url=${encodeURIComponent(absolute)}'`;
        } catch {}
        return match;
      });
      res.setHeader('Content-Type', 'text/css');
      return res.send(cssText);
    }

    res.send(response.data);
  } catch (error) {
    console.error('Asset error:', error.message);
    res.status(200).send('');
  }
});

// ── HTML proxy /s/:id/* ───────────────────────────────────────
app.use('/s/:id', async (req, res) => {
  const { id } = req.params;
  const session = sessions[id];
  if (!session) return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px"><h2>Session expired</h2><p><a href="/">Go back</a></p></body></html>');

  const targetBase = new URL(session.url);
  const baseUrl = `${targetBase.protocol}//${targetBase.host}`;
  const sessionBase = `/s/${id}`;

  let subPath = req.path || '/';
  let targetUrl;
  if (subPath === '/' || subPath === '') {
    targetUrl = session.url;
  } else {
    try { targetUrl = new URL(subPath + (req.search || ''), session.url).href; }
    catch { targetUrl = session.url; }
  }

  // Block cookie/policy redirect loops
  const BLOCKED_PATTERNS = ['acceptable-use','acceptable-usage','cookie-policy','privacy-policy','gdpr','cookie-consent','terms-of-service'];
  if (BLOCKED_PATTERNS.some(p => subPath.toLowerCase().includes(p))) {
    console.log(`[Block] Blocked policy redirect: ${subPath}`);
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) return res.setHeader('Content-Type','application/json').send('{"status":"ok"}');
    return res.send('<!DOCTYPE html><html><head></head><body></body></html>');
  }

  try {
    const response = await smartFetch(targetUrl, getCookieHeader(targetBase.host), true);
    extractCookies(targetBase.host, response.headers['set-cookie']);

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) {
      const guessed = guessContentType(targetUrl);
      let ct = contentType;
      if (guessed && (!ct || ct.includes('octet-stream'))) ct = guessed;
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', '');
      return res.send(response.data);
    }

    const html = response.data.toString('utf-8');
    const $ = cheerio.load(html);

    // Strip Cookiebot/consent CMPs
    $('script[src*="cookiebot.com"]').remove();
    $('script[src*="cookielaw.org"]').remove();
    $('script[src*="onetrust.com"]').remove();
    $('meta[http-equiv="refresh"]').remove();
    $('script[type="text/plain"][data-cookieconsent]').each((_, el) => {
      $(el).attr('type', 'text/javascript').removeAttr('data-cookieconsent');
    });

    // Strip SPA hydration entry points — prevents blank page on Nuxt/Next/Vue apps
    // These cause the client to blank out SSR content when URL doesn't match
    $('script[type="module"]').each((_, el) => {
      const src = $(el).attr('src') || '';
      // Only remove the main entry bundle, keep small inline modules
      if (src && (src.includes('entry') || src.includes('app') || src.includes('main') || src.includes('_nuxt'))) {
        $(el).remove();
      }
    });
    // Remove Nuxt data/config scripts that trigger hydration
    $('script#__NUXT_DATA__').remove();
    $('script').each((_, el) => {
      const content = $(el).html() || '';
      if (content.includes('window.__NUXT__') && content.length > 100) {
        $(el).remove();
      }
    });

    // Strip SRI integrity checks — they fail after proxy URL rewriting
    $('link[integrity], script[integrity]').each((_, el) => {
      $(el).removeAttr('integrity').removeAttr('crossorigin');
    });

    // Inject Font Awesome
    $('head').append('<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" crossorigin="anonymous">');

    // Head: fake document.cookie + block redirects + dynamic asset interceptor
    $('head').prepend(`<script>
    (function() {
      try {
        var _d = Object.getOwnPropertyDescriptor(Document.prototype,'cookie') || Object.getOwnPropertyDescriptor(HTMLDocument.prototype,'cookie');
        var _fk = 'cookie_consent=true;cookieconsent_status=allow;cookies_accepted=true;gdpr_consent=1;consent=1;viewed_cookie_policy=yes;cookie-agreed=2;privacy_policy_accepted=1;terms_accepted=1';
        if (_d && _d.set) Object.defineProperty(document,'cookie',{get:function(){var r='';try{r=_d.get.call(document);}catch(e){}return _fk+(r?'; '+r:'');},set:function(v){try{_d.set.call(document,v);}catch(e){}},configurable:true});
      } catch(e) {}

      window.__proxyBase = '${targetUrl}';
      var _BLOCK = ['cookie','consent','gdpr','privacy-policy','cookie-policy','acceptable-use','acceptable-usage'];
      function _isBlock(u) { if(!u)return false; var s=String(u).toLowerCase(); return _BLOCK.some(function(p){return s.includes(p);}); }
      try {
        var _loc = Object.getPrototypeOf(window.location);
        var _href = Object.getOwnPropertyDescriptor(_loc,'href') || Object.getOwnPropertyDescriptor(window.location,'href');
        if (_href && _href.set) {
          Object.defineProperty(window.location,'href',{set:function(u){if(_isBlock(u))return;_href.set.call(window.location,u);},get:function(){return _href.get?_href.get.call(window.location):window.location.toString();},configurable:true});
        }
        window.location.assign=function(u){if(_isBlock(u))return;window.location.href=u;};
        window.location.replace=function(u){if(_isBlock(u))return;if(_href)_href.set.call(window.location,u);};
        var _ps=history.pushState,_rs=history.replaceState;
        history.pushState=function(s,t,u){if(u&&_isBlock(u))return;return _ps.apply(this,arguments);};
        history.replaceState=function(s,t,u){if(u&&_isBlock(u))return;return _rs.apply(this,arguments);};
      } catch(e) {}

      var _orig = document.createElement.bind(document);
      document.createElement = function(tag) {
        var el = _orig(tag);
        var t = (tag||'').toLowerCase();
        if (t === 'link') {
          var _sa = el.setAttribute.bind(el);
          el.setAttribute = function(n,v) {
            if (n==='href' && v && !v.startsWith('data:') && !v.startsWith('/a?') && v.includes('.')) {
              try { var abs=new URL(v,window.__proxyBase||location.href).href; if(!abs.startsWith(location.origin)) v='/a?url='+encodeURIComponent(abs); } catch(e) {}
            }
            return _sa(n,v);
          };
        }
        if (t === 'script') {
          var _sas = el.setAttribute.bind(el);
          el.setAttribute = function(n,v) {
            if (n==='src' && v && !v.startsWith('/a?') && !v.startsWith('data:') && v.includes('.')) {
              try { var abs=new URL(v,window.__proxyBase||location.href).href; if(!abs.startsWith(location.origin)) v='/a?url='+encodeURIComponent(abs); } catch(e) {}
            }
            return _sas(n,v);
          };
        }
        return el;
      };

      var _f=window.fetch;
      window.fetch=function(input,init){
        try {
          var u=typeof input==='string'?input:(input&&input.url)?input.url:String(input);
          if(u&&!u.startsWith(location.origin)&&!u.startsWith('/a?')){
            try{var abs=new URL(u,window.__proxyBase||location.href).href;if(!abs.startsWith(location.origin)){var px='/a?url='+encodeURIComponent(abs);input=typeof input==='string'?px:new Request(px,input);}}catch(e){}
          }
        } catch(e) {}
        return _f.apply(this,arguments);
      };
      var _xo=XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open=function(m,u){
        try{if(u&&!String(u).startsWith(location.origin)){var abs=new URL(u,window.__proxyBase||location.href).href;if(!abs.startsWith(location.origin))arguments[1]='/a?url='+encodeURIComponent(abs);}}catch(e){}
        return _xo.apply(this,arguments);
      };
    })();
    </script>`);

    // Loading overlay
    $('head').append(`<style>
      #__proxy_loading__{position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;z-index:2147483647;display:flex;align-items:center;justify-content:center;transition:opacity 0.3s;}
      @keyframes __proxy_spin__{to{transform:rotate(360deg);}}
    </style>`);
    $('body').prepend(`<div id="__proxy_loading__"><div style="text-align:center;color:#888;font-family:sans-serif"><div style="width:36px;height:36px;border:3px solid #eee;border-top-color:#5c6bc0;border-radius:50%;animation:__proxy_spin__ 0.8s linear infinite;margin:0 auto 10px"></div><div style="font-size:13px">Loading...</div></div></div>`);

    // Rewrite links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const absolute = toAbsolute(href, baseUrl, targetUrl);
      if (absolute) {
        try {
          const u = new URL(absolute);
          if (u.host === targetBase.host) $(el).attr('href', `${sessionBase}${u.pathname}${u.search}${u.hash}`);
        } catch {}
      }
    });

    // Rewrite assets
    $('link[href]').each((_, el) => {
      const rel = ($(el).attr('rel') || '').toLowerCase().trim();
      if (rel === 'preconnect' || rel === 'dns-prefetch') return;
      const href = $(el).attr('href');
      const absolute = toAbsolute(href, baseUrl, targetUrl);
      if (absolute) $(el).attr('href', `/a?url=${encodeURIComponent(absolute)}`);
    });

    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      const absolute = toAbsolute(src, baseUrl, targetUrl);
      if (absolute) $(el).attr('src', `/a?url=${encodeURIComponent(absolute)}`);
    });

    $('img').each((_, el) => {
      ['src','data-src','data-lazy-src','data-gt-lazy-src','data-original','data-lazy'].forEach(attr => {
        const val = $(el).attr(attr);
        if (val) {
          // Handle Next.js image optimization URLs — keep them as-is (our /_next/image handler serves them)
          if (val.includes('/_next/image')) {
            $(el).attr(attr, val); // keep as root-relative, our handler will serve it
            return;
          }
          const absolute = toAbsolute(val, baseUrl, targetUrl);
          if (absolute) $(el).attr(attr, `/a?url=${encodeURIComponent(absolute)}`);
        }
      });
      // Handle srcset — rewrite each URL
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const rewritten = srcset.split(',').map(part => {
          const [url, size] = part.trim().split(/\s+/);
          if (!url) return part;
          if (url.includes('/_next/image')) return part; // keep as-is
          const absolute = toAbsolute(url, baseUrl, targetUrl);
          const proxied = absolute ? `/a?url=${encodeURIComponent(absolute)}` : url;
          return size ? `${proxied} ${size}` : proxied;
        }).join(', ');
        $(el).attr('srcset', rewritten);
      } else {
        $(el).removeAttr('srcset');
      }
    });

    $('source').each((_, el) => {
      $(el).removeAttr('srcset');
      const src = $(el).attr('src');
      if (src) {
        const absolute = toAbsolute(src, baseUrl, targetUrl);
        if (absolute) $(el).attr('src', `/a?url=${encodeURIComponent(absolute)}`);
      }
    });

    $('[style]').each((_, el) => {
      const style = $(el).attr('style');
      if (style && style.includes('url(')) {
        const rewritten = style.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, p1) => {
          const absolute = toAbsolute(p1, baseUrl, targetUrl);
          return absolute ? `url('/a?url=${encodeURIComponent(absolute)}')` : match;
        });
        $(el).attr('style', rewritten);
      }
    });

    $('style').each((_, el) => {
      let cssText = $(el).html();
      if (!cssText || !cssText.includes('url(')) return;
      cssText = cssText.replace(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, p1) => {
        if (p1.startsWith('data:') || p1.startsWith('#')) return match;
        try {
          const absolute = toAbsolute(p1, baseUrl, targetUrl);
          if (absolute) return `url('/a?url=${encodeURIComponent(absolute)}')`;
        } catch {}
        return match;
      });
      $(el).html(cssText);
    });

    $('body').append(`<script>
    (function(){
      function hideOverlay(){var el=document.getElementById('__proxy_loading__');if(!el)return;el.style.opacity='0';setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},300);}
      window.addEventListener('load',function(){setTimeout(hideOverlay,300);});
      setTimeout(hideOverlay,8000);
    })();
    ${COOKIE_KILLER_SCRIPT}
    ${PIN_SCRIPT}
    </script>`);

    res.removeHeader('X-Frame-Options');
    res.removeHeader('X-Content-Type-Options');
    res.setHeader('Content-Security-Policy', '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send($.html());

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px"><h2>Proxy error</h2><p>${error.message}</p></body></html>`);
  }
});

// ── Next.js Image optimization handler ───────────────────────
app.get('/_next/image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing url');

  // Get origin from Referer
  const referer = req.headers['referer'] || '';
  let originDomain = null;
  try {
    const refUrl = new URL(referer);
    const sessionMatch = refUrl.pathname.match(/^\/s\/([a-f0-9]+)\//);
    if (sessionMatch) {
      const session = sessions[sessionMatch[1]];
      if (session) originDomain = new URL(session.url).origin;
    }
  } catch {}

  // Resolve the actual image URL
  let targetUrl;
  try {
    if (imageUrl.startsWith('http')) {
      targetUrl = imageUrl;
    } else {
      targetUrl = originDomain
        ? `${originDomain}${imageUrl}`
        : imageUrl;
    }
  } catch {
    return res.status(400).send('Invalid url');
  }

  try {
    const response = await smartFetch(targetUrl, '', false);
    const ct = response.headers['content-type'] || guessContentType(targetUrl) || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(response.data);
  } catch (e) {
    console.error('[Next/image] Error:', e.message);
    return res.status(404).send('');
  }
});


app.use(async (req, res, next) => {
  // Only handle asset-like paths not already handled
  const ext = req.path.split('.').pop().toLowerCase();
  const assetExts = ['js','mjs','css','woff','woff2','ttf','svg','png','jpg','jpeg','webp','gif','ico','json','map'];
  if (!assetExts.includes(ext)) return next();

  // Get origin domain from Referer header
  const referer = req.headers['referer'] || '';
  let originDomain = null;
  try {
    const refUrl = new URL(referer);
    // Check if referer is one of our proxy sessions
    const sessionMatch = refUrl.pathname.match(/^\/s\/([a-f0-9]+)\//);
    if (sessionMatch) {
      const session = sessions[sessionMatch[1]];
      if (session) originDomain = new URL(session.url).origin;
    }
  } catch {}

  if (!originDomain) return next();

  const targetUrl = `${originDomain}${req.path}${req.search || ''}`;
  console.log(`[Catch-all] Proxying root-relative: ${req.path} → ${targetUrl}`);

  try {
    const response = await smartFetch(targetUrl, getCookieHeader(new URL(originDomain).hostname), false);
    let contentType = response.headers['content-type'] || '';
    const guessed = guessContentType(targetUrl);
    if (guessed && (!contentType || contentType.includes('text/html'))) contentType = guessed;

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.removeHeader('X-Frame-Options');
    return res.send(response.data);
  } catch (e) {
    console.error('[Catch-all] Error:', e.message);
    return next();
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('─────────────────────────────────────────');
  console.log(`  Testing Review running on port ${PORT}`);
  console.log('─────────────────────────────────────────');
  // Install Chrome in background at startup
  ensureChrome().catch(e => console.error('[Chrome] Startup install error:', e.message));
});
