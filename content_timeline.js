// content_timeline.js
// Timeline processing ONLY uses cached profiles from background.
// If a profile isn't cached yet, we show "Unknown" badge and DO NOT scrape.
// You learn location only when you visit that user's profile page.

let rules = [];
let prefs = { debug: false, logOnce: true, blockUnresolved: false };

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const memProfile = new Map(); // handleLower -> {location,bio,ts}
const memPending = new Set(); // handleLower currently requesting
const loggedHandles = new Set();

const observed = new WeakSet();
let io = null;

function log(...a) { if (prefs.debug) console.log("[BTC]", ...a); }
function warn(...a) { if (prefs.debug) console.warn("[BTC]", ...a); }

function norm(s) { return (s || "").toLowerCase(); }

function iso2ToFlag(iso2) {
  const code = (iso2 || "").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}

function ensureStyle() {
  if (document.getElementById("btc-country-style")) return;
  const style = document.createElement("style");
  style.id = "btc-country-style";
  style.textContent = `
    .btc-flag-badge{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:1px 7px;border:1px solid rgba(120,120,120,.35);border-radius:999px;font-size:12px;line-height:16px;user-select:none;opacity:.95}
    .btc-flag{font-size:14px;line-height:14px}
    .btc-country{font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .btc-blocked-placeholder{border:1px dashed rgba(120,120,120,.5);border-radius:16px;padding:10px 12px;margin:8px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .btc-blocked-left{display:flex;align-items:center;gap:10px;min-width:0}
    .btc-blocked-title{font-weight:700;font-size:13px;white-space:nowrap}
    .btc-blocked-sub{font-size:12px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
    .btc-btn{padding:6px 10px;border-radius:999px;border:1px solid rgba(120,120,120,.5);background:transparent;cursor:pointer;font-weight:700;font-size:12px}
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
}

function ruleMatches(rule, locationText, bioText) {
  const loc = norm(locationText);
  const bio = norm(bioText);

  const country = norm(rule.country);
  const keywords = (rule.keywords || []).map(norm);

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

function addOrUpdateBadge(articleEl, countryName, iso2, hint) {
  const nameBlock = articleEl.querySelector('div[data-testid="User-Name"]');
  if (!nameBlock) return;

  let badge = nameBlock.querySelector(".btc-flag-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "btc-flag-badge";
    badge.innerHTML = `<span class="btc-flag"></span><span class="btc-country"></span>`;
    nameBlock.appendChild(badge);
  }
  badge.querySelector(".btc-flag").textContent = iso2ToFlag(iso2);
  badge.querySelector(".btc-country").textContent = countryName || "Unknown";
  badge.title = hint || "";
}

function blockWithPlaceholder(articleEl, rule, handle, locationText) {
  if (articleEl.dataset.btcBlocked === "1") return;
  articleEl.dataset.btcBlocked = "1";

  const placeholder = document.createElement("div");
  placeholder.className = "btc-blocked-placeholder";

  const left = document.createElement("div");
  left.className = "btc-blocked-left";

  const badge = document.createElement("span");
  badge.className = "btc-flag-badge";
  badge.innerHTML = `<span class="btc-flag">${iso2ToFlag(rule.iso2)}</span><span class="btc-country">${rule.country || "Unknown"}</span>`;

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  textWrap.innerHTML = `
    <div class="btc-blocked-title">Tweet blocked</div>
    <div class="btc-blocked-sub">@${handle || "unknown"} • location: ${locationText || "—"}</div>
  `;

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
    ruleId: rule.id
  }).catch(() => {});
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
  if (cached && isFresh(cached)) return cached;

  if (memPending.has(h)) return null;
  memPending.add(h);

  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PROFILE", handle: h });
    if (resp?.ok && resp.profile) {
      memProfile.set(h, resp.profile);
      return resp.profile;
    }
    return null;
  } catch {
    return null;
  } finally {
    memPending.delete(h);
  }
}

async function checkTweet(articleEl) {
  if (articleEl.dataset.btcChecked === "1") return;
  articleEl.dataset.btcChecked = "1";

  if (!rules.length) return;

  const handle = getHandleFromTweet(articleEl);
  if (!handle) return;

  ensureStyle();

  const profile = await getProfile(handle);

  if (!profile) {
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

  const match = findMatch(profile.location || "", profile.bio || "");

  if (match) {
    addOrUpdateBadge(articleEl, match.country, match.iso2, `Matched by profile location/bio`);
    blockWithPlaceholder(articleEl, match, handle, profile.location || "");
  } else {
    // show badge based on profile (optional)
    addOrUpdateBadge(articleEl, "Allowed", "??", `No rule match. Location: ${profile.location || "—"}`);
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
    if (observed.has(a)) continue;
    observed.add(a);
    io.observe(a);
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

async function init() {
  await loadRulesAndPrefs();
  ensureStyle();
  observeTweets();

  const mo = new MutationObserver(scheduleObserve);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.rules) {
      rules = (changes.rules.newValue || []).filter(r => r && r.country);
      scheduleObserve();
    }
    if (area === "sync" && changes.prefs) {
      prefs = changes.prefs.newValue || prefs;
      scheduleObserve();
    }
  });
}

init();
