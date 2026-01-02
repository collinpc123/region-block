// content_timeline.js
// Timeline processing ONLY uses cached profiles from background.
// If a profile isn't cached yet, we show "Unknown" badge and DO NOT scrape.
// You learn location only when you visit that user's profile page.

let rules = [];
let prefs = { debug: false, logOnce: true, blockUnresolved: false };
const RULES_KEY = "rules";

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const COUNTRY_SYNONYMS = {
  "united states": "US", "usa": "US", "u.s.a": "US", "u.s.": "US", "us": "US", "america": "US",
  "united kingdom": "GB", "uk": "GB", "u.k.": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB", "britain": "GB",
  "israel": "IL", "tel aviv": "IL", "jerusalem": "IL",
  "india": "IN", "bharat": "IN", "delhi": "IN",
  "canada": "CA", "toronto": "CA",
  "australia": "AU", "sydney": "AU", "melbourne": "AU",
  "germany": "DE", "deutschland": "DE", "berlin": "DE",
  "france": "FR", "paris": "FR",
  "russia": "RU", "moscow": "RU",
  "china": "CN", "beijing": "CN", "shanghai": "CN",
  "japan": "JP", "tokyo": "JP",
  "spain": "ES", "madrid": "ES", "barcelona": "ES",
  "italy": "IT", "rome": "IT",
  "brazil": "BR", "rio": "BR", "sao paulo": "BR",
  "mexico": "MX", "mexico city": "MX",
  "uae": "AE", "dubai": "AE", "abu dhabi": "AE",
  "pakistan": "PK", "karachi": "PK", "lahore": "PK",
  "bangladesh": "BD", "dhaka": "BD",
  "nepal": "NP", "kathmandu": "NP",
  "sri lanka": "LK", "colombo": "LK",
  "south africa": "ZA", "johannesburg": "ZA",
  "nigeria": "NG", "lagos": "NG",
  "turkey": "TR", "türkiye": "TR", "istanbul": "TR",
  "saudi arabia": "SA", "riyadh": "SA",
  "iran": "IR", "tehran": "IR",
  "ukraine": "UA", "kiev": "UA", "kyiv": "UA",
  "ireland": "IE", "dublin": "IE",
  "sweden": "SE", "norway": "NO", "finland": "FI", "denmark": "DK"
};

const memProfile = new Map(); // handleLower -> {location,bio,ts}
const memPending = new Set(); // handleLower currently requesting
const blockedHandles = new Map(); // handleLower -> {ruleId,location,ts}
const loggedHandles = new Set();
const aboutApiPromises = new Map(); // handleLower -> Promise<string>
let aboutScriptInjected = false;
let aboutRateLimitUntilMs = 0;
const flagDataCache = new Map(); // iso -> dataURL
const flagFetchInFlight = new Set();

const observed = new WeakSet();
let io = null;
let statsWidgetEl = null;
let statsRefreshTimer = null;
let lastProfileUpdateTick = 0;
let statsContainerEl = null;
let bannerEl = null;

function log(...a) { if (prefs.debug) console.log("[BTC]", ...a); }
function warn(...a) { if (prefs.debug) console.warn("[BTC]", ...a); }

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
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}

function flagForCountryName(country, isoHint) {
  const iso = (isoHint || "").toUpperCase().trim() || deriveIsoFromLocation(country || "") || "??";
  return iso2ToFlag(iso);
}

function deriveIsoFromLocation(locationText) {
  const set = extractFlagIso2s(locationText);
  for (const iso of set) return iso; // first match
  const lower = (locationText || "").toLowerCase();
  for (const [key, iso] of Object.entries(COUNTRY_SYNONYMS)) {
    if (lower.includes(key)) return iso;
  }
  return "";
}

function ensureAboutScriptInjected() {
  if (aboutScriptInjected) return;
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("page_about.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
  aboutScriptInjected = true;
}

function fetchAccountBasedLocationViaApi(handle) {
  const h = String(handle || "").toLowerCase().trim();
  if (!h) return Promise.resolve("");
  if (aboutRateLimitUntilMs && Date.now() < aboutRateLimitUntilMs) return Promise.resolve("");
  if (aboutApiPromises.has(h)) return aboutApiPromises.get(h);

  ensureAboutScriptInjected();

  const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const p = new Promise((resolve) => {
    const listener = (event) => {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.type === "BTC_ABOUT_RESULT" && msg.handle === h && msg.reqId === reqId) {
        window.removeEventListener("message", listener);
        log({ about_api_result: { handle: h, status: msg.status, loc: msg.location, error: msg.error } });
        if (msg.isRateLimited && msg.resetTimeMs) {
          aboutRateLimitUntilMs = msg.resetTimeMs;
        } else if (msg.status === 429) {
          aboutRateLimitUntilMs = Date.now() + 5 * 60 * 1000;
        }
        resolve(msg.location || "");
      }
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "BTC_FETCH_ABOUT", handle: h, reqId }, "*");
    setTimeout(() => {
      window.removeEventListener("message", listener);
      resolve("");
    }, 12000);
  });

  aboutApiPromises.set(h, p);
  return p;
}

function flagImgEl(iso2, className) {
  const iso = (iso2 || "").toUpperCase();
  const placeholder = document.createElement("span");
  placeholder.className = className;
  placeholder.textContent = iso2ToFlag(iso);
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.title = iso || "??";
  placeholder.style.fontFamily = '"Twemoji","Noto Color Emoji","Segoe UI Emoji","Apple Color Emoji",sans-serif';

  if (/^[A-Z]{2}$/.test(iso)) {
    const cached = flagDataCache.get(iso);
    if (cached) {
      const img = document.createElement("img");
      img.className = className;
      img.alt = `${iso} flag`;
      img.src = cached;
      img.width = 20;
      img.height = 14;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      return img;
    }
    if (!flagFetchInFlight.has(iso)) {
      flagFetchInFlight.add(iso);
      const url = `https://flagcdn.com/24x18/${iso.toLowerCase()}.png`;
      fetch(url)
        .then(r => r.ok ? r.blob() : null)
        .then(async blob => {
          if (!blob) return;
          const dataUrl = await new Promise(res => {
            const reader = new FileReader();
            reader.onloadend = () => res(reader.result);
            reader.readAsDataURL(blob);
          });
          flagDataCache.set(iso, dataUrl);
          flagFetchInFlight.delete(iso);
          // Replace all placeholders with new imgs
          document.querySelectorAll(`.${className}[data-iso="${iso}"]`).forEach(el => {
            const img = document.createElement("img");
            img.className = className;
            img.alt = `${iso} flag`;
            img.src = dataUrl;
            img.width = 20;
            img.height = 14;
            img.loading = "lazy";
            img.referrerPolicy = "no-referrer";
            el.replaceWith(img);
          });
        })
        .catch(() => flagFetchInFlight.delete(iso));
    }
    placeholder.dataset.iso = iso;
  }

  return placeholder;
}

function ensureStyle() {
  if (document.getElementById("btc-country-style")) return;
  const style = document.createElement("style");
  style.id = "btc-country-style";
  style.textContent = `
    .btc-flag-badge{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:2px 9px;border:1px solid rgba(120,120,120,.35);border-radius:999px;font-size:13px;line-height:16px;user-select:none;opacity:.95}
    .btc-flag-img{display:inline-flex;align-items:center;justify-content:center;font-size:17px;line-height:16px;min-width:18px;font-family:"Twemoji Country Flags","Twemoji","Noto Color Emoji","Segoe UI Emoji","Apple Color Emoji",sans-serif}
    .btc-block-flag-img{display:inline-flex;align-items:center;justify-content:center;font-size:20px;line-height:18px;min-width:22px;margin-left:6px;font-family:"Twemoji Country Flags","Twemoji","Noto Color Emoji","Segoe UI Emoji","Apple Color Emoji",sans-serif}
    .btc-country{font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .btc-blocked-placeholder{border:1px dashed rgba(120,120,120,.5);border-radius:16px;padding:10px 12px;margin:8px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .btc-blocked-left{display:flex;align-items:center;gap:10px;min-width:0}
    .btc-blocked-title{font-weight:700;font-size:13px;white-space:nowrap}
    .btc-blocked-sub{font-size:12px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
    .btc-btn{padding:6px 10px;border-radius:999px;border:1px solid rgba(120,120,120,.5);background:transparent;cursor:pointer;font-weight:700;font-size:12px}
    .btc-actions{display:flex;gap:8px;align-items:center}
    .btc-block-btn{border-color:rgba(255,102,102,.8);color:#b30000;background:rgba(255,102,102,.08)}
    .btc-stats-container{position:fixed;bottom:18px;left:18px;z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
    .btc-banner{display:block;color:#ffecec;font-size:12px;line-height:1.4;margin-bottom:6px;padding:0}
    .btc-banner a{color:#ff8a80;text-decoration:underline;font-weight:600}
    .btc-stats{background:rgba(24,0,0,0.92);color:#f9d6d6;border:1px solid rgba(255,82,82,0.8);border-radius:12px;padding:12px 14px;min-width:220px;font-size:12px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,0.35)}
    .btc-stats-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto}
    .btc-stats-list li{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:6px 2px;border-bottom:1px solid rgba(255,82,82,0.35)}
    .btc-stats-list li:last-child{border-bottom:none}
    .btc-stats-flag{font-size:24px;min-width:20px;text-align:center;color:#ff6b6b}
    .btc-stats-country{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#ffecec}
    .btc-stats-count{font-variant-numeric:tabular-nums;font-weight:800;color:#ff8a80}
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

async function loadRulesAndPrefs() {
  const res = await chrome.storage.sync.get({
    rules: [],
    prefs: { debug: false, logOnce: true, blockUnresolved: false }
  });
  rules = (res.rules || []).filter(r => r && r.country);
  prefs = res.prefs || prefs;
  log("init", { rules, prefs });

  // Push rule metadata to background for the counter (nicknames etc.)
  const ruleMeta = {};
  for (const r of rules) {
    ruleMeta[r.id] = {
      nickname: r.nickname || r.country || "",
      country: r.country || "",
      iso2: (r.iso2 || deriveIsoFromLocation(r.country || "") || "").toUpperCase(),
      emoji: r.emoji || ""
    };
  }
  chrome.runtime.sendMessage({ type: "SET_RULE_META", ruleMeta }).catch(() => {});
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

function findMatch(locationText, bioText) {
  for (const r of rules) {
    if (!r.nickname) r.nickname = r.country;
    if (!r.iso2 && r.country) r.iso2 = deriveIsoFromLocation(r.country);
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
  delete articleEl.dataset.btcChecked;
  delete articleEl.dataset.btcPending;
  delete articleEl.dataset.btcRetryCount;
}

function addOrUpdateBadge(articleEl, countryName, iso2, hint) {
  const nameBlock = articleEl.querySelector('div[data-testid="User-Name"]');
  if (!nameBlock) return;
  const effectiveIso = (iso2 || deriveIsoFromLocation(countryName || "") || "??").toUpperCase();

  let badge = nameBlock.querySelector(".btc-flag-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "btc-flag-badge";
    badge.innerHTML = `<span class="btc-country"></span>`;
    nameBlock.appendChild(badge);
  }
  const existingFlag = badge.querySelector(".btc-flag-img, .btc-flag");
  if (existingFlag) existingFlag.remove();
  const flagEl = flagImgEl(effectiveIso, "btc-flag-img");
  badge.prepend(flagEl);
  badge.querySelector(".btc-country").textContent = countryName || "Unknown";
  badge.title = hint || "";
}

function blockWithPlaceholder(articleEl, rule, handle, locationText) {
  if (articleEl.dataset.btcBlocked === "1") return;
  articleEl.dataset.btcBlocked = "1";

  const countryName = rule.country || "Unknown";
  const ruleIso = (rule.iso2 || deriveIsoFromLocation(rule.country || "") || "??").toUpperCase();

  const placeholder = document.createElement("div");
  placeholder.className = "btc-blocked-placeholder";

  const left = document.createElement("div");
  left.className = "btc-blocked-left";

  const badge = document.createElement("span");
  badge.className = "btc-flag-badge";
  const flagElSmall = flagImgEl(ruleIso, "btc-flag-img");
  const countrySpan = document.createElement("span");
  countrySpan.className = "btc-country";
  countrySpan.textContent = countryName;
  badge.append(flagElSmall, countrySpan);

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  const title = document.createElement("div");
  title.className = "btc-blocked-title";
  title.textContent = "Tweet blocked ";
  const flagElLarge = flagImgEl(ruleIso, "btc-block-flag-img");
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

  actions.append(showBtn);

  placeholder.appendChild(left);
  placeholder.appendChild(actions);

  articleEl.style.display = "none";
  articleEl.parentElement?.insertBefore(placeholder, articleEl);

  chrome.runtime.sendMessage({
    type: "INCREMENT_BLOCK",
    country: rule.country,
    ruleId: rule.id,
    nickname: rule.nickname || rule.country,
    iso2: ruleIso
  }).then(() => scheduleStatsRefresh(200)).catch(() => {});
}

function maybeLog(handle, match, profile, cached) {
  if (!prefs.debug) return;
  if (prefs.logOnce && loggedHandles.has(handle)) return;
  if (prefs.logOnce) loggedHandles.add(handle);

  log({
    handle,
    cached,
    matched: !!match,
    rule: match ? { id: match.id, country: match.country, iso2: match.iso2 } : null,
    location: profile?.location || "",
    bio_preview: (profile?.bio || "").slice(0, 120)
  });
}

function isFresh(entry) {
  return entry?.ts && (Date.now() - entry.ts) < CACHE_TTL_MS;
}

async function getProfile(handle) {
  const h = String(handle || "").toLowerCase().replace(/^@/, "").trim();
  if (!h) return null;

  const cached = memProfile.get(h);
  if (cached && isFresh(cached) && (cached.location || cached.locationIso2 || cached.bio)) {
    // Upgrade to account-based location if we only have profile/bio data.
    const isAccountBased = (cached.source || "").includes("about");
    if (!isAccountBased) {
      const apiLocUpgrade = await fetchAccountBasedLocationViaApi(h);
      if (apiLocUpgrade) {
        const iso = deriveIsoFromLocation(apiLocUpgrade);
        const upgraded = { ...cached, location: apiLocUpgrade, locationIso2: iso, source: "about_api_upgrade", ts: Date.now() };
        memProfile.set(h, upgraded);
        chrome.runtime.sendMessage({
          type: "SET_PROFILE",
          handle: h,
          profile: { location: apiLocUpgrade, locationIso2: iso, bio: upgraded.bio || "", source: "about_api_upgrade" }
        }).catch(() => {});
        return upgraded;
      }
    }
    return cached;
  }

  if (memPending.has(h)) return null;
  memPending.add(h);

  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PROFILE", handle: h });
    let baseProfile = resp?.ok ? resp.profile : null;
    if (baseProfile) {
      if (!baseProfile.locationIso2 && baseProfile.location) {
        baseProfile.locationIso2 = deriveIsoFromLocation(baseProfile.location);
      }
      memProfile.set(h, baseProfile);
      // Try to upgrade to account-based location if current source isn't from about
      const isAccountBased = (baseProfile.source || "").includes("about");
      if (!isAccountBased) {
        const apiLocUpgrade = await fetchAccountBasedLocationViaApi(h);
        if (apiLocUpgrade) {
          const iso = deriveIsoFromLocation(apiLocUpgrade);
          const upgraded = { ...baseProfile, location: apiLocUpgrade, locationIso2: iso, source: "about_api_upgrade", ts: Date.now() };
          memProfile.set(h, upgraded);
          chrome.runtime.sendMessage({
            type: "SET_PROFILE",
            handle: h,
            profile: { location: apiLocUpgrade, locationIso2: iso, bio: upgraded.bio || "", source: "about_api_upgrade" }
          }).catch(() => {});
          return upgraded;
        }
      }
      if (baseProfile.location || baseProfile.locationIso2 || baseProfile.bio) return baseProfile;
    }

    // Fallback to About API (account based in) to avoid visiting profile
    const loc = await fetchAccountBasedLocationViaApi(h);
    if (loc) {
      const iso = deriveIsoFromLocation(loc);
      const profile = { location: loc, locationIso2: iso, bio: "", ts: Date.now() };
      memProfile.set(h, profile);
      // Save to cache so future lookups are fast
      chrome.runtime.sendMessage({
        type: "SET_PROFILE",
        handle: h,
        profile: { location: loc, locationIso2: iso, bio: "", source: "about_api" }
      }).catch(() => {});
      return profile;
    }

    return baseProfile;
  } catch {
    return null;
  } finally {
    memPending.delete(h);
  }
}

async function checkTweet(articleEl) {
  if (!rules.length) return;

  const tweetId = getTweetId(articleEl);
  const prevId = articleEl.dataset.btcTweetId || "";
  const pending = articleEl.dataset.btcPending === "1";
  if (tweetId && prevId === tweetId && !pending) return;
  if ((tweetId && prevId && tweetId !== prevId) || (!tweetId && prevId)) resetArticleState(articleEl);
  articleEl.dataset.btcTweetId = tweetId || prevId || "";
  articleEl.dataset.btcChecked = "1";

  const handle = getHandleFromTweet(articleEl);
  if (!handle) return;

  ensureStyle();

  const remembered = getRememberedRule(handle);
  if (remembered) {
    addOrUpdateBadge(articleEl, remembered.rule.country, remembered.rule.iso2, `Previously blocked`);
    blockWithPlaceholder(articleEl, remembered.rule, handle, remembered.location || "");
    maybeLog(handle, remembered.rule, { location: remembered.location || "" }, true);
    return;
  }

  const profile = await getProfile(handle);

  if (!profile) {
    const retries = Number(articleEl.dataset.btcRetryCount || "0");
    if (retries < 4) {
      articleEl.dataset.btcRetryCount = String(retries + 1);
      articleEl.dataset.btcPending = "1";
      setTimeout(() => checkTweet(articleEl), 1200);
    } else {
      delete articleEl.dataset.btcPending;
    }

    // Not resolved yet: show unknown flag. User must visit profile to teach us.
    addOrUpdateBadge(
      articleEl,
      "Unknown",
      "??",
      "Location unknown — visit this user's profile once to learn it."
    );

    if (prefs.blockUnresolved) {
      // optional aggressive mode
      const fakeRule = { id: "unresolved", country: "Unknown", iso2: "??" };
      blockWithPlaceholder(articleEl, fakeRule, handle, "");
    }
    maybeLog(handle, null, null, false);
    return;
  }

  delete articleEl.dataset.btcPending;
  delete articleEl.dataset.btcRetryCount;

  const match = findMatch(profile.location || "", profile.bio || "");

  if (match) {
    addOrUpdateBadge(articleEl, match.country, match.iso2, `Matched by profile location/bio`);
    const locForCache = profile.location || profile.bio || match.country || "";
    blockWithPlaceholder(articleEl, match, handle, profile.location || "");
    rememberBlocked(handle, match, locForCache);
  } else {
    // Show badge based on profile (optional). Derive ISO from flag emoji if present.
    const inferredIso = (profile.locationIso2 || "").trim() || deriveIsoFromLocation(profile.location || profile.bio || "") || deriveIsoFromLocation(profile.country || "") || "??";
    addOrUpdateBadge(articleEl, profile.location || "Allowed", inferredIso, `No rule match. Location: ${profile.location || "—"}`);
  }

  maybeLog(handle, match, profile, true);
}

function setupIO() {
  if (io) return;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      checkTweet(e.target);
    }
  }, { root: null, rootMargin: "1200px 0px", threshold: 0.01 });
}

function observeTweets() {
  setupIO();
  const articles = document.querySelectorAll('article[role="article"]');
  for (const a of articles) {
    const currentId = getTweetId(a);
    const prevId = a.dataset.btcTweetId || "";
    if (!observed.has(a)) {
      observed.add(a);
      io.observe(a);
    }
    if (!currentId || !prevId || currentId !== prevId) {
      checkTweet(a);
    }
  }
}

let scheduled = false;
function scheduleObserve() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    observeTweets();
  });
}

function ensureStatsContainer() {
  if (statsContainerEl) return statsContainerEl;
  statsContainerEl = document.createElement("div");
  statsContainerEl.id = "btc-stats-container";
  statsContainerEl.className = "btc-stats-container";
  document.body.appendChild(statsContainerEl);
  return statsContainerEl;
}

function ensureStatsWidget() {
  if (statsWidgetEl) return statsWidgetEl;
  ensureStatsContainer();
  statsWidgetEl = document.createElement("div");
  statsWidgetEl.id = "btc-stats-widget";
  statsWidgetEl.className = "btc-stats";
  statsWidgetEl.innerHTML = `<ul class="btc-stats-list"></ul>`;
  statsContainerEl.appendChild(statsWidgetEl);
  return statsWidgetEl;
}

function ensureBanner() {
  const raw = (prefs.customBannerText || "").trim();
  const text = raw
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/&quot;/g, '"');
  if (!text) {
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
    return null;
  }
  ensureStatsWidget();
  if (!bannerEl) {
    bannerEl = document.createElement("div");
    bannerEl.id = "btc-custom-banner";
    bannerEl.className = "btc-banner";
    statsWidgetEl.prepend(bannerEl);
  }
  bannerEl.innerHTML = text;
  return bannerEl;
}

async function refreshStatsWidget() {
  try {
    ensureStatsWidget();
    ensureBanner();
    const [res, sync] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_STATS" }),
      chrome.storage.sync.get({ [RULES_KEY]: [] })
    ]);
    if (!res?.ok || !res.stats) return;
    const ruleList = sync[RULES_KEY] || [];
    const list = statsWidgetEl.querySelector(".btc-stats-list");
    list.innerHTML = "";
    if (!ruleList.length) {
      statsWidgetEl.style.display = "none";
      return;
    }
    statsWidgetEl.style.display = "block";
    const entries = Object.entries(res.stats.byRuleId || {});
    const meta = res.stats.ruleMeta || {};
    // merge current rules to ensure zero entries show
    const merged = new Map();
    for (const [ruleId, count] of entries) merged.set(ruleId, count);
    for (const r of ruleList) {
      if (!merged.has(r.id)) merged.set(r.id, 0);
      meta[r.id] = meta[r.id] || {
        nickname: r.nickname || r.country || "",
        country: r.country || "",
        iso2: (r.iso2 || deriveIsoFromLocation(r.country || "") || "").toUpperCase(),
        emoji: r.emoji || ""
      };
    }
    const sorted = Array.from(merged.entries()).sort((a, b) => b[1] - a[1]);
    for (const [ruleId, count] of sorted.slice(0, 12)) {
      const m = meta[ruleId] || {};
      const displayName = m.nickname || m.country || "Unnamed rule";
      const iso = m.iso2 || deriveIsoFromLocation(m.country || "") || "??";
      const emoji = m.emoji || "";
      const li = document.createElement("li");
      const flag = document.createElement("span");
      flag.className = "btc-stats-flag";
      flag.textContent = emoji || flagForCountryName(displayName, iso);
      const name = document.createElement("span");
      name.className = "btc-stats-country";
      name.textContent = displayName;
      const c = document.createElement("span");
      c.className = "btc-stats-count";
      c.textContent = String(count);
      li.append(flag, name, c);
      list.appendChild(li);
    }
  } catch {}
}

function scheduleStatsRefresh(delay = 400) {
  clearTimeout(statsRefreshTimer);
  statsRefreshTimer = setTimeout(refreshStatsWidget, delay);
}

function rerenderArticlesForHandle(handle) {
  if (!handle) return;
  const articles = document.querySelectorAll('article[role="article"]');
  for (const a of articles) {
    const h = getHandleFromTweet(a);
    if (h && h.toLowerCase() === handle.toLowerCase()) {
      checkTweet(a);
    }
  }
}

async function init() {
  await loadRulesAndPrefs();
  ensureBanner();
  await loadBlockedHandles();
  ensureStyle();
  ensureAboutScriptInjected();
  ensureStatsWidget();
  refreshStatsWidget();
  setInterval(() => scheduleStatsRefresh(0), 30000);
  observeTweets();

  const mo = new MutationObserver(scheduleObserve);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.rules) {
      rules = (changes.rules.newValue || []).filter(r => r && r.country);
      const ruleMeta = {};
      for (const r of rules) {
        ruleMeta[r.id] = {
          nickname: r.nickname || r.country || "",
          country: r.country || "",
          iso2: (r.iso2 || deriveIsoFromLocation(r.country || "") || "").toUpperCase(),
          emoji: r.emoji || ""
        };
      }
      chrome.runtime.sendMessage({ type: "SET_RULE_META", ruleMeta }).catch(() => {});
      scheduleObserve();
      scheduleStatsRefresh(0);
    }
    if (area === "sync" && changes.prefs) {
      prefs = changes.prefs.newValue || prefs;
      ensureBanner();
      scheduleObserve();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "PROFILE_UPDATED" && msg.handle) {
      const h = String(msg.handle || "").toLowerCase();
      const profile = msg.profile || {};
      if (profile.location || profile.locationIso2 || profile.bio) {
        memProfile.set(h, profile);
        rerenderArticlesForHandle(h);
      }
    }
  });
}

init();
