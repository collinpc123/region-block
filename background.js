// background.js (MV3 service worker)
// Stores rules in chrome.storage.sync
// Stores profile cache + stats in chrome.storage.local

const RULES_KEY = "rules";
const PREFS_KEY = "prefs";

const PROFILE_CACHE_KEY = "btc_profile_cache_v1";
const STATS_KEY = "btc_stats_v1";

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_CACHE_ENTRIES = 5000;

function bgLog(...a) { console.log("[BTC-bg]", ...a); }
function bgWarn(...a) { console.warn("[BTC-bg]", ...a); }
function now() { return Date.now(); }

chrome.runtime.onInstalled.addListener(async () => {
  bgLog("installed");

  // seed defaults if missing
  const sync = await chrome.storage.sync.get({
    [RULES_KEY]: [],
    [PREFS_KEY]: { debug: false, logOnce: true, blockUnresolved: false }
  });
  if (!Array.isArray(sync[RULES_KEY])) {
    await chrome.storage.sync.set({ [RULES_KEY]: [] });
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
    [STATS_KEY]: { totalBlocked: 0, byCountry: {}, byRuleId: {} }
  });
  return res[STATS_KEY] || { totalBlocked: 0, byCountry: {}, byRuleId: {} };
}

async function setStats(stats) {
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

async function incBlock({ country, ruleId }) {
  const stats = await getStats();
  stats.totalBlocked = (stats.totalBlocked || 0) + 1;

  if (country) {
    stats.byCountry ||= {};
    stats.byCountry[country] = (stats.byCountry[country] || 0) + 1;
  }
  if (ruleId) {
    stats.byRuleId ||= {};
    stats.byRuleId[ruleId] = (stats.byRuleId[ruleId] || 0) + 1;
  }
  await setStats(stats);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const prefs = await getPrefs();
      const debug = !!prefs.debug;

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
        const bio = String(msg.profile?.bio || "").trim();

        const cache = await getCache();
        cache[handle] = {
          location,
          bio,
          ts: now(),
          source: msg.profile?.source || "profile_dom"
        };
        await setCache(await pruneCache(cache));
        if (debug) bgLog("SET_PROFILE", { handle, hasLoc: !!location, hasBio: !!bio });

        return sendResponse({ ok: true });
      }

      if (msg?.type === "INCREMENT_BLOCK") {
        await incBlock({ country: msg.country, ruleId: msg.ruleId });
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
