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
