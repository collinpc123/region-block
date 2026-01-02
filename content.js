// content.js
// Country blocking + badge rendering.
// Uses background SCRAPE_PROFILE (syndication endpoint) for {location,bio}.
// Strong caps to prevent X freezing / memory spikes.

let rules = [];
let prefs = { debug: true, logOnce: true };

const LOG_PREFIX = "[BTC]";

// ---- safety caps ----
const MAX_REQUESTS_PER_PAGE = 120;
const MAX_QUEUE = 80;
const MAX_PENDING_PER_HANDLE = 25;

// ---- caches (page lifetime) ----
const memCache = new Map(); // handleLower -> {location,bio,ts,method,sourceUrl,status}
const pendingByHandle = new Map(); // handleLower -> Set<articleEl>
const blockedHandles = new Map(); // handleLower -> {ruleId,location,ts}
const loggedHandles = new Set();

// ---- queue ----
let requestsThisPage = 0;
const queue = [];
const inQueue = new Set();
let running = false;

// ---- viewport limiting ----
const observed = new WeakSet();
let io = null;

function log(...a) { if (prefs.debug) console.log(LOG_PREFIX, ...a); }
function warn(...a) { if (prefs.debug) console.warn(LOG_PREFIX, ...a); }

function norm(s) { return (s || "").toLowerCase(); }

function flagEmojiToIso2(flag) {
  if (!flag) return "";
  const chars = Array.from(flag);
  if (chars.length !== 2) return "";
  const A = 0x1F1E6;
  const codePoints = chars.map(c => c.codePointAt(0) || 0);
  if (codePoints.some(cp => cp < A || cp > A + 25)) return "";
  return String.fromCharCode(codePoints[0] - A + 65, codePoints[1] - A + 65);
}

function extractFlagIso2s(text) {
  const out = new Set();
  if (!text) return out;
  const matches = text.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu);
  if (!matches) return out;
  for (const m of matches) {
    const iso = flagEmojiToIso2(m);
    if (iso) out.add(iso);
  }
  return out;
}

function iso2ToFlag(iso2) {
  const code = (iso2 || "").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}

function flagImgEl(iso2, className) {
  const iso = String(iso2 || "").trim().toLowerCase();
  if (/^[a-z]{2}$/.test(iso)) {
    const img = document.createElement("img");
    img.src = `https://flagcdn.com/48x36/${iso}.png`;
    img.alt = `${iso.toUpperCase()} flag`;
    img.className = className;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      const fallback = document.createElement("span");
      fallback.className = className.replace("img", "flag");
      fallback.textContent = iso2ToFlag(iso2);
      img.replaceWith(fallback);
    };
    return img;
  }
  const span = document.createElement("span");
  span.className = className.replace("img", "flag");
  span.textContent = iso2ToFlag(iso2);
  return span;
}

async function loadRules() {
  const res = await chrome.storage.sync.get({ rules: [] });
  rules = (res.rules || []).filter(r => r && r.country);
}

async function loadBlockedHandles() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_BLOCKED_HANDLES" });
    blockedHandles.clear();
    Object.entries(resp?.blocked || {}).forEach(([h, entry]) => {
      if (h) blockedHandles.set(h, entry);
    });
  } catch {}
  if (!blockedHandles.size) {
    try {
      const res = await chrome.storage.local.get({ btc_blocked_handles_v1: {} });
      Object.entries(res.btc_blocked_handles_v1 || {}).forEach(([h, entry]) => {
        if (h) blockedHandles.set(h, entry);
      });
    } catch {}
  }
}

async function persistBlockedLocally(handle, entry) {
  try {
    const res = await chrome.storage.local.get({ btc_blocked_handles_v1: {} });
    const map = res.btc_blocked_handles_v1 || {};
    map[handle] = entry;
    const keys = Object.keys(map);
    if (keys.length > 5000) {
      const sorted = keys
        .map(k => [k, map[k]?.ts || 0])
        .sort((a, b) => a[1] - b[1])
        .slice(keys.length - 5000);
      const trimmed = Object.fromEntries(sorted.map(([k]) => [k, map[k]]));
      await chrome.storage.local.set({ btc_blocked_handles_v1: trimmed });
    } else {
      await chrome.storage.local.set({ btc_blocked_handles_v1: map });
    }
  } catch {}
}

async function loadPrefs() {
  const res = await chrome.storage.sync.get({ prefs: { debug: true, logOnce: true } });
  prefs = res.prefs || { debug: true, logOnce: true };
}

function rememberBlocked(handle, rule, locationText) {
  const h = String(handle || "").toLowerCase();
  if (!h || !rule?.id) return;
  blockedHandles.set(h, {
    ruleId: rule.id,
    location: locationText || "",
    country: rule.country || "",
    iso2: rule.iso2 || "",
    nickname: rule.nickname || "",
    ts: Date.now()
  });
  persistBlockedLocally(h, blockedHandles.get(h));
  chrome.runtime.sendMessage({
    type: "ADD_BLOCKED_HANDLE",
    handle: h,
    ruleId: rule.id,
    location: locationText || "",
    meta: {
      country: rule.country || "",
      iso2: rule.iso2 || "",
      nickname: rule.nickname || ""
    }
  }).catch(() => {});
}

function getRememberedRule(handle) {
  const h = String(handle || "").toLowerCase();
  const entry = blockedHandles.get(h);
  if (!entry || !entry.ruleId) return null;
  const rule = rules.find(r => r.id === entry.ruleId) || {
    id: entry.ruleId,
    country: entry.country || "Blocked",
    iso2: entry.iso2 || "??",
    nickname: entry.nickname || entry.country || "Blocked",
    enabled: true,
    keywords: [],
    scanBio: true
  };
  return { rule, location: entry.location || "" };
}

function ensureStyle() {
  if (document.getElementById("btc-country-style")) return;
  const style = document.createElement("style");
  style.id = "btc-country-style";
  style.textContent = `
    .btc-flag-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      padding: 1px 7px;
      border: 1px solid rgba(120,120,120,0.35);
      border-radius: 999px;
      font-size: 12px;
      line-height: 16px;
      user-select: none;
      opacity: 0.95;
    }
    .btc-flag-img { width: 18px; height: 14px; object-fit: cover; display: inline-block; vertical-align: middle; }
    .btc-block-flag-img { width: 26px; height: 18px; object-fit: cover; margin-left: 6px; vertical-align: middle; display: inline-block; }
    .btc-country {
      font-size: 12px;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btc-blocked-placeholder {
      border: 1px dashed rgba(120,120,120,0.5);
      border-radius: 16px;
      padding: 10px 12px;
      margin: 8px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .btc-blocked-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .btc-blocked-title { font-weight: 700; font-size: 13px; white-space: nowrap; }
    .btc-blocked-sub {
      font-size: 12px; opacity: 0.8; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; max-width: 340px;
    }
    .btc-btn {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(120,120,120,0.5);
      background: transparent;
      cursor: pointer;
      font-weight: 700;
      font-size: 12px;
    }
    .btc-actions { display: flex; gap: 8px; align-items: center; }
    .btc-block-btn {
      border-color: rgba(255, 102, 102, 0.8);
      color: #b30000;
      background: rgba(255, 102, 102, 0.08);
    }
  `;
  document.head.appendChild(style);
}

const BLOCK_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAv0Q6O5K5XFz1j/A//vN/i2QfJ9w=1Zv7ttfk8LF81IUq16jS3eAdJ2PHGJwZHo9TnA6Yl4";
const BLOCK_URLS = [
  "https://api.twitter.com/1.1/blocks/create.json",
  "https://x.com/i/api/1.1/blocks/create.json"
];

let cachedCookies = { ct0: "", auth: "", ts: 0 };
async function getSessionCookies() {
  const now = Date.now();
  if (cachedCookies.ct0 && cachedCookies.auth && now - cachedCookies.ts < 5 * 60 * 1000) {
    return cachedCookies;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_COOKIES" });
    if (resp?.ct0 && resp?.authToken) {
      cachedCookies = { ct0: resp.ct0, auth: resp.authToken, ts: now };
      return cachedCookies;
    }
  } catch {}
  // fallback to document.cookie if available
  const mCt0 = document.cookie.match(/(?:^|; )ct0=([^;]+)/);
  const mAuth = document.cookie.match(/(?:^|; )auth_token=([^;]+)/);
  if (mCt0 && mAuth) {
    cachedCookies = { ct0: decodeURIComponent(mCt0[1]), auth: decodeURIComponent(mAuth[1]), ts: now };
    return cachedCookies;
  }
  return { ct0: "", auth: "", ts: now };
}

async function getAuthHeaders() {
  let { ct0, auth } = await getSessionCookies();
  if (!ct0 || !auth) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "SYNC_COOKIES_TO_X" });
      if (resp?.ct0 && resp?.authToken) {
        ct0 = resp.ct0;
        auth = resp.authToken;
        cachedCookies = { ct0, auth, ts: Date.now() };
      }
    } catch {}
  }
  return {
    csrf: ct0,
    authToken: auth,
    headers: {
      accept: "application/json, text/plain, */*",
      "authorization": `Bearer ${BLOCK_BEARER}`,
      "x-csrf-token": ct0,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": document.documentElement.lang || "en",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "origin": "https://x.com",
      "referer": "https://x.com/"
    }
  };
}

async function blockUser(handle) {
  const h = String(handle || "").replace(/^@/, "").trim();
  if (!h) throw new Error("empty handle");
  const { csrf, authToken, headers } = await getAuthHeaders();
  if (!csrf || !authToken) throw new Error("missing session cookies (ct0/auth_token); open X in a tab and stay logged in.");

  const body = `screen_name=${encodeURIComponent(h)}&skip_status=1&include_entities=false`;

  let lastErr = null;
  for (const url of BLOCK_URLS) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body
      });
      if (!resp.ok) {
        let detail = "";
        try {
          const j = await resp.json();
          detail = j?.errors?.[0]?.message || "";
        } catch {}
        lastErr = new Error(`block failed (${resp.status}) ${detail}`.trim());
        continue;
      }
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("block failed");
}

function ruleMatches(rule, locationText, bioText) {
  const loc = norm(locationText);
  const bio = norm(bioText);

  const country = norm(rule.country);
  const keywords = (rule.keywords || []).map(norm);
  const iso2 = (rule.iso2 || "").toUpperCase();

  const locIso2s = extractFlagIso2s(locationText);
  const bioIso2s = extractFlagIso2s(bioText);

  if (iso2 && (locIso2s.has(iso2) || bioIso2s.has(iso2))) return true;

  if (country && loc.includes(country)) return true;
  for (const k of keywords) if (k && loc.includes(k)) return true;

  if (country && bio.includes(country)) return true;
  for (const k of keywords) if (k && bio.includes(k)) return true;

  return false;
}

function findMatchingRule(locationText, bioText) {
  for (const r of rules) {
    if (!r.enabled) continue;
    if (ruleMatches(r, locationText, bioText)) return r;
  }
  return null;
}

function getHandleFromTweet(articleEl) {
  const nameBlock = articleEl.querySelector('div[data-testid="User-Name"]');
  if (nameBlock) {
    const text = nameBlock.innerText || "";
    const m = text.match(/@([A-Za-z0-9_]{1,20})/);
    if (m) return m[1];
  }

  const links = articleEl.querySelectorAll('a[href^="/"]');
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("/i/") || href.includes("/status/")) continue;
    const seg = href.split("?")[0].split("/").filter(Boolean)[0];
    if (seg) return seg;
  }
  return null;
}

function getTweetId(articleEl) {
  const links = articleEl.querySelectorAll('a[href*="/status/"]');
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d{5,})/);
    if (m) return m[1];
  }
  return "";
}

function resetArticleState(articleEl) {
  if (articleEl.dataset.btcBlocked === "1") {
    articleEl.style.display = "";
    const prev = articleEl.previousElementSibling;
    if (prev && prev.classList?.contains("btc-blocked-placeholder")) prev.remove();
  }
  delete articleEl.dataset.btcTweetId;
  delete articleEl.dataset.btcBlocked;
  delete articleEl.dataset.btcApplied;
  delete articleEl.dataset.btcPending;
  delete articleEl.dataset.btcRetryCount;
}

function addOrUpdateBadge(articleEl, countryName, iso2) {
  const nameBlock = articleEl.querySelector('div[data-testid="User-Name"]');
  if (!nameBlock) return;

  let badge = nameBlock.querySelector(".btc-flag-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "btc-flag-badge";
    badge.innerHTML = `<span class="btc-country"></span>`;
    nameBlock.appendChild(badge);
  }

  const existingFlag = badge.querySelector(".btc-flag-img, .btc-flag");
  if (existingFlag) existingFlag.remove();
  const flagEl = flagImgEl(iso2, "btc-flag-img");
  badge.prepend(flagEl);
  badge.querySelector(".btc-country").textContent = countryName || "Unknown";
}

function blockWithPlaceholder(articleEl, rule, handle, locationText) {
  if (articleEl.dataset.btcBlocked === "1") return;
  articleEl.dataset.btcBlocked = "1";

  const countryName = rule?.country || "Unknown";
  const iso2 = (rule?.iso2 || "").toUpperCase();
  const customMessage = (rule?.customMessage || "").trim();

  const placeholder = document.createElement("div");
  placeholder.className = "btc-blocked-placeholder";

  const left = document.createElement("div");
  left.className = "btc-blocked-left";

  const badge = document.createElement("span");
  badge.className = "btc-flag-badge";
  const flagElSmall = flagImgEl(iso2, "btc-flag-img");
  const countrySpan = document.createElement("span");
  countrySpan.className = "btc-country";
  countrySpan.textContent = countryName || "Unknown";
  badge.append(flagElSmall, countrySpan);

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  const title = document.createElement("div");
  title.className = "btc-blocked-title";
  title.textContent = "Tweet blocked ";
  const flagElLarge = flagImgEl(iso2, "btc-block-flag-img");
  title.appendChild(flagElLarge);
  const sub = document.createElement("div");
  sub.className = "btc-blocked-sub";
  sub.textContent = `@${handle || "unknown"} • location: ${locationText || "—"}`;
  textWrap.append(title, sub);

  left.appendChild(badge);
  left.appendChild(textWrap);

  const actions = document.createElement("div");
  actions.className = "btc-actions";

  const showBtn = document.createElement("button");
  showBtn.className = "btc-btn";
  showBtn.textContent = "Show";
  showBtn.addEventListener("click", () => {
    placeholder.remove();
    articleEl.style.display = "";
  });

  actions.appendChild(showBtn);

  placeholder.appendChild(left);
  placeholder.appendChild(actions);

  articleEl.style.display = "none";
  articleEl.parentElement?.insertBefore(placeholder, articleEl);
}

function maybeLogDetection({ handle, rule, location, bio, method }) {
  if (!prefs.debug) return;

  const h = (handle || "").toLowerCase();
  if (prefs.logOnce && loggedHandles.has(h)) return;
  if (prefs.logOnce) loggedHandles.add(h);

  console.log(LOG_PREFIX, {
    handle,
    matched: !!rule,
    rule: rule ? { country: rule.country, iso2: rule.iso2 } : null,
    location: location || "",
    bio_preview: (bio || "").slice(0, 120),
    method: method || "",
  });
}

async function scrapeProfile(handle) {
  const h = String(handle || "").replace(/^@/, "").trim().toLowerCase();
  const cached = memCache.get(h);
  if (cached) return cached;

  if (requestsThisPage >= MAX_REQUESTS_PER_PAGE) {
    return { location: "", bio: "", method: "cap_reached" };
  }
  requestsThisPage++;

  // Important: this must run in the content script context (chrome.runtime exists here)
  let resp;
  try {
    log("SCRAPE_PROFILE request", h);
    resp = await chrome.runtime.sendMessage({ type: "SCRAPE_PROFILE", handle: h });
  } catch (e) {
    warn("SCRAPE_PROFILE sendMessage failed", e);
    return { location: "", bio: "", method: "sendMessage_fail" };
  }

  if (!resp || !resp.ok) {
    warn("SCRAPE_PROFILE bad response", resp);
    return { location: "", bio: "", method: "bg_fail" };
  }

  const out = {
    location: resp.location || "",
    bio: resp.bio || "",
    method: resp.method || "unknown",
    status: resp.status,
    sourceUrl: resp.sourceUrl,
  };

  memCache.set(h, out);

  log("SCRAPE_PROFILE response", {
    h,
    ok: true,
    status: resp.status,
    method: resp.method,
    location: out.location,
    bio_preview: out.bio.slice(0, 80),
  });

  return out;
}

function enqueue(handle, articleEl) {
  const h = handle.toLowerCase();
  if (queue.length >= MAX_QUEUE) return;

  // Track pending tweet elements by handle so we can apply when profile arrives
  let set = pendingByHandle.get(h);
  if (!set) {
    set = new Set();
    pendingByHandle.set(h, set);
  }
  if (set.size < MAX_PENDING_PER_HANDLE) set.add(articleEl);

  if (inQueue.has(h)) return;
  inQueue.add(h);
  queue.push(h);
  runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;

  try {
    while (queue.length) {
      const h = queue.shift();
      inQueue.delete(h);

      const prof = await scrapeProfile(h);

      const pending = pendingByHandle.get(h);
      pendingByHandle.delete(h);

      if (!pending) continue;

      for (const articleEl of pending) {
        try {
          applyToTweet(articleEl, h, prof);
        } catch (e) {
          warn("applyToTweet error", e);
        }
      }
    }
  } finally {
    running = false;
  }
}

function applyToTweet(articleEl, handleLower, prof) {
  const tweetId = getTweetId(articleEl);
  const prevId = articleEl.dataset.btcTweetId || "";
  const pending = articleEl.dataset.btcPending === "1";
  if (tweetId && prevId === tweetId && !pending) return;
  if ((tweetId && prevId && tweetId !== prevId) || (!tweetId && prevId)) resetArticleState(articleEl);
  articleEl.dataset.btcTweetId = tweetId || prevId || "";

  if (!articleEl || articleEl.dataset.btcApplied === "1") return;
  articleEl.dataset.btcApplied = "1";

  const location = prof.location || "";
  const bio = prof.bio || "";

  const rule = findMatchingRule(location, bio);
  maybeLogDetection({ handle: handleLower, rule, location, bio, method: prof.method });

  ensureStyle();

  if (rule) {
    addOrUpdateBadge(articleEl, rule.country, rule.iso2);
    blockWithPlaceholder(articleEl, rule, handleLower, location);

    const locForCache = location || bio || rule.country || "";
    rememberBlocked(handleLower, rule, locForCache);
    chrome.runtime.sendMessage({ type: "INCREMENT_BLOCK_COUNT", country: rule.country }).catch(() => {});
  } else {
    // If you want badges for everyone, you need a country inference even for non-matches.
    // For now we only badge blocked/matched rules to keep it cheap.
  }
}

function observeTweet(articleEl) {
  const currentId = getTweetId(articleEl);
  const prevId = articleEl.dataset.btcTweetId || "";
  if (!observed.has(articleEl)) {
    observed.add(articleEl);
    io?.observe(articleEl);
  }
  if (!currentId || !prevId || currentId !== prevId) {
    checkTweet(articleEl);
  }
}

async function checkTweet(articleEl) {
  if (!rules.length) return;

  const handle = getHandleFromTweet(articleEl);
  if (!handle) return;

  const remembered = getRememberedRule(handle);
  if (remembered) {
    ensureStyle();
    addOrUpdateBadge(articleEl, remembered.rule.country, remembered.rule.iso2);
    blockWithPlaceholder(articleEl, remembered.rule, handle, remembered.location || "");
    return;
  }

  // If already cached, apply immediately; else queue
  const h = handle.toLowerCase();
  const cached = memCache.get(h);
  if (cached) {
    applyToTweet(articleEl, h, cached);
  } else {
    enqueue(h, articleEl);
  }
}

function scan() {
  ensureStyle();
  const articles = document.querySelectorAll('article[role="article"]');
  for (const a of articles) observeTweet(a);
}

async function init() {
  await loadRules();
  await loadBlockedHandles();
  await loadPrefs();

  log("init", { rules, prefs });

  ensureStyle();

  io = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      if (!ent.isIntersecting) continue;
      const el = ent.target;
      io.unobserve(el); // process once per appearance
      checkTweet(el);
    }
  }, { root: null, rootMargin: "1200px 0px", threshold: 0 });

  scan();

  const mo = new MutationObserver(() => scan());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.prefs) {
      prefs = changes.prefs.newValue || prefs;
      log("prefs updated", prefs);
    }
    if (area === "sync" && changes.rules) {
      rules = (changes.rules.newValue || []).filter(r => r && r.country);
      log("rules updated", rules);
      scan();
    }
  });
}

init();
