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
    .btc-stats{position:fixed;top:16px;right:16px;z-index:9999;background:rgba(0,0,0,0.82);color:#f5f5f5;border:1px solid rgba(255,255,255,0.2);border-radius:14px;padding:14px 16px;min-width:200px;backdrop-filter:blur(8px);font-size:13px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,0.45)}
    .btc-stats-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;max-height:400px;overflow:auto}
    .btc-stats-list li{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:4px 6px;border-radius:10px;background:rgba(255,255,255,0.06)}
    .btc-stats-flag{font-size:18px;min-width:22px;text-align:center}
    .btc-stats-country{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    .btc-stats-count{font-variant-numeric:tabular-nums;font-weight:800}
  `;
  document.head.appendChild(style);
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

function ruleMatches(rule, locationText, bioText) {
  const loc = norm(locationText);
  const bio = norm(bioText);

  const country = norm(rule.country);
  const keywords = (rule.keywords || []).map(norm);
  const iso2 = (rule.iso2 || "").toUpperCase();

  const locIso2s = extractFlagIso2s(locationText);
  const bioIso2s = extractFlagIso2s(bioText);

  if (iso2 && (locIso2s.has(iso2) || (rule.scanBio && bioIso2s.has(iso2)))) return true;

  if (country && loc.includes(country)) return true;
  for (const k of keywords) if (k && loc.includes(k)) return true;

  if (rule.scanBio) {
    if (country && bio.includes(country)) return true;
    for (const k of keywords) if (k && bio.includes(k)) return true;
  }

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
  countrySpan.textContent = rule.country || "Unknown";
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

  const btn = document.createElement("button");
  btn.className = "btc-btn";
  btn.textContent = "Show";
  btn.addEventListener("click", () => {
    placeholder.remove();
    articleEl.style.display = "";
  });

  placeholder.appendChild(left);
  placeholder.appendChild(btn);

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
    blockWithPlaceholder(articleEl, match, handle, profile.location || "");
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

function ensureStatsWidget() {
  if (statsWidgetEl) return statsWidgetEl;
  statsWidgetEl = document.createElement("div");
  statsWidgetEl.id = "btc-stats-widget";
  statsWidgetEl.className = "btc-stats";
  statsWidgetEl.innerHTML = `<ul class="btc-stats-list"></ul>`;
  document.body.appendChild(statsWidgetEl);
  return statsWidgetEl;
}

async function refreshStatsWidget() {
  try {
    ensureStatsWidget();
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
