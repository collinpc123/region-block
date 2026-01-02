// background.js (MV3 service worker)
// Stores rules in chrome.storage.sync
// Stores profile cache + stats in chrome.storage.local

const RULES_KEY = "rules";
const PREFS_KEY = "prefs";

const PROFILE_CACHE_KEY = "btc_profile_cache_v1";
const STATS_KEY = "btc_stats_v1";
const BLOCKED_HANDLES_KEY = "btc_blocked_handles_v1";

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_CACHE_ENTRIES = 5000;
const BLOCK_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_BLOCKED_ENTRIES = 5000;

function bgLog(...a) { console.log("[BTC-bg]", ...a); }
function bgWarn(...a) { console.warn("[BTC-bg]", ...a); }
function now() { return Date.now(); }

chrome.runtime.onInstalled.addListener(async () => {
  bgLog("installed");

  // seed defaults if missing
  const sync = await chrome.storage.sync.get({
    [RULES_KEY]: null,
    [PREFS_KEY]: { debug: false, logOnce: true, blockUnresolved: false }
  });
  if (!Array.isArray(sync[RULES_KEY])) {
    try {
      const resp = await fetch(chrome.runtime.getURL("default_config.json"));
      const defaults = await resp.json();
      if (Array.isArray(defaults.rules)) {
        await chrome.storage.sync.set({ [RULES_KEY]: defaults.rules });
      } else {
        await chrome.storage.sync.set({ [RULES_KEY]: [] });
      }
      if (defaults.prefs) {
        await chrome.storage.sync.set({ [PREFS_KEY]: defaults.prefs });
      }
    } catch (e) {
      bgWarn("failed to load default_config.json", e);
      await chrome.storage.sync.set({ [RULES_KEY]: [] });
    }
  }
});

async function getPrefs() {
  const res = await chrome.storage.sync.get({ [PREFS_KEY]: { debug: false, logOnce: true, blockUnresolved: false } });
  return res[PREFS_KEY] || { debug: false, logOnce: true, blockUnresolved: false };
}

async function getCache() {
  const res = await chrome.storage.local.get({ [PROFILE_CACHE_KEY]: {} });
  return res[PROFILE_CACHE_KEY] || {};
}

async function setCache(cache) {
  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: cache });
}

async function pruneCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_CACHE_ENTRIES) return cache;
  keys.sort((a, b) => (cache[a]?.ts || 0) - (cache[b]?.ts || 0));
  const remove = keys.slice(0, keys.length - MAX_CACHE_ENTRIES);
  for (const k of remove) delete cache[k];
  return cache;
}

function isFresh(entry) {
  return entry?.ts && (now() - entry.ts) < CACHE_TTL_MS;
}

async function getStats() {
  const res = await chrome.storage.local.get({
    [STATS_KEY]: { totalBlocked: 0, byCountry: {}, byRuleId: {}, ruleMeta: {} }
  });
  return res[STATS_KEY] || { totalBlocked: 0, byCountry: {}, byRuleId: {}, ruleMeta: {} };
}

async function setStats(stats) {
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

async function getBlockedHandles() {
  const res = await chrome.storage.local.get({ [BLOCKED_HANDLES_KEY]: {} });
  const obj = res[BLOCKED_HANDLES_KEY] || {};
  const now = now();
  const cleaned = {};
  for (const [h, entry] of Object.entries(obj)) {
    if (!entry || !entry.ts) continue;
    if (now - entry.ts > BLOCK_TTL_MS) continue;
    cleaned[h] = entry;
  }
  if (Object.keys(cleaned).length !== Object.keys(obj).length) {
    await chrome.storage.local.set({ [BLOCKED_HANDLES_KEY]: cleaned });
  }
  return cleaned;
}

async function addBlockedHandle(handle, ruleId, location, meta = {}) {
  const h = String(handle || "").toLowerCase();
  if (!h || !ruleId) return;
  const blocked = await getBlockedHandles();
  blocked[h] = {
    ruleId,
    location: location || "",
    country: meta.country || "",
    iso2: meta.iso2 || "",
    nickname: meta.nickname || "",
    ts: now()
  };
  const entries = Object.entries(blocked);
  if (entries.length > MAX_BLOCKED_ENTRIES) {
    entries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
    const trimmed = Object.fromEntries(entries.slice(entries.length - MAX_BLOCKED_ENTRIES));
    await chrome.storage.local.set({ [BLOCKED_HANDLES_KEY]: trimmed });
    return;
  }
  await chrome.storage.local.set({ [BLOCKED_HANDLES_KEY]: blocked });
}

async function incBlock({ country, ruleId, nickname, iso2 }) {
  const stats = await getStats();
  stats.totalBlocked = (stats.totalBlocked || 0) + 1;

  if (country) {
    stats.byCountry ||= {};
    stats.byCountry[country] = (stats.byCountry[country] || 0) + 1;
  }
  if (ruleId) {
    stats.byRuleId ||= {};
    stats.byRuleId[ruleId] = (stats.byRuleId[ruleId] || 0) + 1;
    stats.ruleMeta ||= {};
    stats.ruleMeta[ruleId] = {
      ...(stats.ruleMeta[ruleId] || {}),
      nickname: nickname || country || (stats.ruleMeta[ruleId] || {}).nickname || "",
      country: country || (stats.ruleMeta[ruleId] || {}).country || "",
      iso2: iso2 || (stats.ruleMeta[ruleId] || {}).iso2 || ""
    };
  }
  await setStats(stats);
}

async function setRuleMeta(ruleMeta) {
  const stats = await getStats();
  stats.ruleMeta = ruleMeta || {};
  await setStats(stats);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const prefs = await getPrefs();
      const debug = !!prefs.debug;

      if (msg?.type === "GET_COOKIES") {
        const urls = ["https://x.com", "https://twitter.com"];
        const getCookieVal = async (name) => {
          for (const url of urls) {
            try {
              const c = await chrome.cookies.get({ name, url });
              if (c?.value) return c.value;
            } catch {}
          }
          return "";
        };
        const ct0 = await getCookieVal("ct0");
        const authToken = await getCookieVal("auth_token");
        return sendResponse({ ok: !!(ct0 && authToken), ct0, authToken });
      }

      if (msg?.type === "GET_BLOCKED_HANDLES") {
        const blocked = await getBlockedHandles();
        return sendResponse({ ok: true, blocked });
      }

      if (msg?.type === "ADD_BLOCKED_HANDLE") {
        await addBlockedHandle(msg.handle, msg.ruleId, msg.location, msg.meta || {});
        return sendResponse({ ok: true });
      }

      if (msg?.type === "SYNC_COOKIES_TO_X") {
        try {
          const srcs = ["https://twitter.com", "https://x.com"];
          const ct0 = (await chrome.cookies.get({ name: "ct0", url: srcs[0] }))?.value ||
                      (await chrome.cookies.get({ name: "ct0", url: srcs[1] }))?.value ||
                      "";
          const auth = (await chrome.cookies.get({ name: "auth_token", url: srcs[0] }))?.value ||
                       (await chrome.cookies.get({ name: "auth_token", url: srcs[1] }))?.value ||
                       "";
          const optsBase = { secure: true, httpOnly: false, sameSite: "no_restriction" };
          if (ct0) {
            await chrome.cookies.set({ ...optsBase, url: "https://x.com", name: "ct0", value: ct0, domain: ".x.com", path: "/" });
          }
          if (auth) {
            await chrome.cookies.set({ ...optsBase, url: "https://x.com", name: "auth_token", value: auth, domain: ".x.com", path: "/" });
          }
          return sendResponse({ ok: !!(ct0 && auth), ct0, authToken: auth });
        } catch (e) {
          return sendResponse({ ok: false, error: String(e) });
        }
      }

      if (msg?.type === "GET_PROFILE") {
        const handle = String(msg.handle || "").toLowerCase().replace(/^@/, "").trim();
        if (!handle) return sendResponse({ ok: false, error: "empty handle" });

        const cache = await getCache();
        const entry = cache[handle];
        if (entry && isFresh(entry)) {
          if (debug) bgLog("cache hit", { handle, hasLoc: !!entry.location, hasBio: !!entry.bio, ts: entry.ts });
          return sendResponse({ ok: true, cached: true, profile: entry });
        }
        return sendResponse({ ok: true, cached: false, profile: null });
      }

      if (msg?.type === "SET_PROFILE") {
        const handle = String(msg.handle || "").toLowerCase().replace(/^@/, "").trim();
        if (!handle) return sendResponse({ ok: false, error: "empty handle" });

        const location = String(msg.profile?.location || "").trim();
        const locationIso2 = String(msg.profile?.locationIso2 || "").trim();
        const bio = String(msg.profile?.bio || "").trim();

        const cache = await getCache();
        cache[handle] = {
          location,
          locationIso2,
          bio,
          ts: now(),
          source: msg.profile?.source || "profile_dom"
        };
        await setCache(await pruneCache(cache));
        if (debug) bgLog("SET_PROFILE", { handle, hasLoc: !!location, hasBio: !!bio });

        // broadcast to tabs so badges refresh without reload
        try {
          const tabs = await chrome.tabs.query({ url: ["*://x.com/*", "*://twitter.com/*"] });
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, {
              type: "PROFILE_UPDATED",
              handle,
              profile: cache[handle]
            }).catch(() => {});
          }
        } catch {}

        return sendResponse({ ok: true });
      }

      if (msg?.type === "INCREMENT_BLOCK") {
        await incBlock({
          country: msg.country,
          ruleId: msg.ruleId,
          nickname: msg.nickname,
          iso2: msg.iso2
        });
        return sendResponse({ ok: true });
      }

      if (msg?.type === "SET_RULE_META") {
        await setRuleMeta(msg.ruleMeta || {});
        return sendResponse({ ok: true });
      }

      if (msg?.type === "GET_STATS") {
        const stats = await getStats();
        return sendResponse({ ok: true, stats });
      }

      if (msg?.type === "CLEAR_CACHE") {
        await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: {} });
        return sendResponse({ ok: true });
      }

      return sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      bgWarn("onMessage error", e);
      return sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
