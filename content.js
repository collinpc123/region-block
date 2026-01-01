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

function iso2ToFlag(iso2) {
  const code = (iso2 || "").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}

async function loadRules() {
  const res = await chrome.storage.sync.get({ rules: [] });
  rules = (res.rules || []).filter(r => r && r.country);
}

async function loadPrefs() {
  const res = await chrome.storage.sync.get({ prefs: { debug: true, logOnce: true } });
  prefs = res.prefs || { debug: true, logOnce: true };
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
    .btc-flag { font-size: 14px; line-height: 14px; }
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
  `;
  document.head.appendChild(style);
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

function addOrUpdateBadge(articleEl, countryName, iso2) {
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
}

function blockWithPlaceholder(articleEl, countryName, iso2, handle, locationText) {
  if (articleEl.dataset.btcBlocked === "1") return;
  articleEl.dataset.btcBlocked = "1";

  const placeholder = document.createElement("div");
  placeholder.className = "btc-blocked-placeholder";

  const left = document.createElement("div");
  left.className = "btc-blocked-left";

  const badge = document.createElement("span");
  badge.className = "btc-flag-badge";
  badge.innerHTML = `<span class="btc-flag">${iso2ToFlag(iso2)}</span><span class="btc-country">${countryName || "Unknown"}</span>`;

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
  if (!articleEl || articleEl.dataset.btcApplied === "1") return;
  articleEl.dataset.btcApplied = "1";

  const location = prof.location || "";
  const bio = prof.bio || "";

  const rule = findMatchingRule(location, bio);
  maybeLogDetection({ handle: handleLower, rule, location, bio, method: prof.method });

  ensureStyle();

  if (rule) {
    addOrUpdateBadge(articleEl, rule.country, rule.iso2);
    blockWithPlaceholder(articleEl, rule.country, rule.iso2, handleLower, location);

    chrome.runtime.sendMessage({ type: "INCREMENT_BLOCK_COUNT", country: rule.country }).catch(() => {});
  } else {
    // If you want badges for everyone, you need a country inference even for non-matches.
    // For now we only badge blocked/matched rules to keep it cheap.
  }
}

function observeTweet(articleEl) {
  if (observed.has(articleEl)) return;
  observed.add(articleEl);
  io?.observe(articleEl);
}

async function checkTweet(articleEl) {
  if (!rules.length) return;

  const handle = getHandleFromTweet(articleEl);
  if (!handle) return;

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
