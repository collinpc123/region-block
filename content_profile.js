// content_profile.js
if (window.__BTC_PROFILE_LOADED__) {
  console.log("[BTC-profile] already loaded");
} else {
  window.__BTC_PROFILE_LOADED__ = true;
// Runs on x.com/* but does work ONLY when URL is a profile page.
// Extracts:
//   - location: [data-testid="UserLocation"]
//   - bio:      [data-testid="UserDescription"]
// Then sends it to background to cache for that handle.

function isXHost() {
  return location.hostname === "x.com" || location.hostname === "twitter.com";
}

function getPathParts() {
  return location.pathname.split("/").filter(Boolean);
}

function getHandleFromPath() {
  const parts = getPathParts();
  if (!parts.length) return "";
  return parts[0];
}

function looksLikeProfilePage() {
  // profile page is: /<handle>
  // exclude: /home, /explore, /i/..., /settings, /notifications, /<handle>/status/...
  const parts = getPathParts();
  if (parts.length !== 1) return false;

  const p = parts[0].toLowerCase();
  if (!p) return false;
  if (p === "home" || p === "explore" || p === "notifications" || p === "messages") return false;
  if (p === "i" || p === "settings" || p === "compose") return false;
  if (p.startsWith("search")) return false;

  // handle format is loose; X allows underscores
  return /^[a-z0-9_]{1,20}$/i.test(parts[0]);
}

function looksLikeAboutPage() {
  const parts = getPathParts();
  if (parts.length !== 2) return false;
  if (parts[1].toLowerCase() !== "about") return false;
  return /^[a-z0-9_]{1,20}$/i.test(parts[0]);
}

function textFrom(el) {
  if (!el) return "";
  return (el.innerText || el.textContent || "").trim();
}

function flagEmojiToIso2(flag) {
  if (!flag) return "";
  const chars = Array.from(flag);
  if (chars.length !== 2) return "";
  const A = 0x1F1E6;
  const cps = chars.map(c => c.codePointAt(0) || 0);
  if (cps.some(cp => cp < A || cp > A + 25)) return "";
  return String.fromCharCode(cps[0] - A + 65, cps[1] - A + 65);
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

function extractLocation() {
  // You provided example:
  // <span data-testid="UserLocation"> ... <span>TEXT</span> </span>
  const locRoot = document.querySelector('[data-testid="UserLocation"]');
  if (!locRoot) return "";
  // Most reliable is last inner span text
  const spans = locRoot.querySelectorAll("span");
  for (let i = spans.length - 1; i >= 0; i--) {
    const t = textFrom(spans[i]);
    if (t) return t;
  }
  return textFrom(locRoot);
}

function extractBio() {
  const bioRoot = document.querySelector('[data-testid="UserDescription"]');
  if (!bioRoot) return "";
  return textFrom(bioRoot);
}

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

function isoFromLocationText(locationText) {
  const flags = extractFlagIso2s(locationText);
  for (const iso of flags) return iso;
  const lower = (locationText || "").toLowerCase();
  for (const [key, iso] of Object.entries(COUNTRY_SYNONYMS)) {
    if (lower.includes(key)) return iso;
  }
  return "";
}

const aboutLocCache = new Map(); // handleLower -> Promise<string>
const aboutApiPromises = new Map(); // handleLower -> Promise<string>
let aboutScriptInjected = false;
let aboutRateLimitUntilMs = 0;

function ensureAboutScriptInjected() {
  if (aboutScriptInjected) return;
  if (!chrome?.runtime?.getURL) return;
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page_about.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    aboutScriptInjected = true;
  } catch (e) {
    console.log("[BTC-profile] failed to inject page_about.js", e);
  }
}

function fetchAccountBasedLocationViaApi(handle) {
  const h = String(handle || "").toLowerCase();
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
        console.log("[BTC-profile] about API result", { handle: h, status: msg.status, loc: msg.location, error: msg.error });
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
async function fetchAboutBasedLocation(handle) {
  const h = String(handle || "").replace(/^@/, "").trim().toLowerCase();
  if (!h) return "";

  if (aboutLocCache.has(h)) return aboutLocCache.get(h);

  const p = (async () => {
    const url = `https://x.com/${encodeURIComponent(h)}/about`;
    console.log("[BTC-profile] fetching about page", { handle: h, url });

    // Static fetch and regex fallback (may be limited by CSP).
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) {
        console.log("[BTC-profile] about fetch not ok", { status: resp.status });
        return "";
      }
      const html = await resp.text();
      console.log("[BTC-profile] about fetch html head", html.slice(0, 400));
      const doc = new DOMParser().parseFromString(html, "text/html");
      let loc = extractAccountBasedLocationFromRoot(doc, true);
      if (!loc) {
        loc = extractAccountBasedLocationFromHtmlString(html);
      }
      console.log("[BTC-profile] about page parsed", { handle: h, loc });
      return loc || "";
    } catch (e) {
      console.log("[BTC-profile] about fetch error", e);
      return "";
    }
  })();

  aboutLocCache.set(h, p);
  return p;
}

function extractAccountBasedLocationFromNodes(nodes) {
  for (const n of nodes) {
    const raw = textFrom(n);
    if (!raw) continue;
    if (!/^account based in/i.test(raw)) continue;

    console.log("[BTC-profile] found 'Account based in' label", { text: raw.slice(0, 80) });

    const remainder = raw.replace(/^account based in/i, "").replace(/^:/, "").trim();
    if (remainder) return remainder;

    const parent = n.parentElement;
    if (parent) {
      const siblings = parent.querySelectorAll("span, div");
      for (const sib of siblings) {
        if (sib === n) continue;
        const t = textFrom(sib);
        if (t && !/^account based in/i.test(t)) {
          console.log("[BTC-profile] using sibling for account-based location", { text: t.slice(0, 80) });
          return t;
        }
      }
    }

    const next = n.nextElementSibling;
    if (next) {
      const t = textFrom(next);
      if (t) {
        console.log("[BTC-profile] using next sibling for account-based location", { text: t.slice(0, 80) });
        return t;
      }
    }
  }
  return "";
}

function extractAccountBasedLocationFromRoot(root, includeGlobal = false) {
  const target = root || document;
  const scopes = target.querySelectorAll('[role="dialog"], [data-testid="sheetDialog"], [data-testid="BottomSheet"]');
  console.log("[BTC-profile] scan account-based location: scopes", scopes.length);
  for (const scope of scopes) {
    const loc = extractAccountBasedLocationFromNodes(scope.querySelectorAll("span, div"));
    if (loc) return loc;
  }

  if (includeGlobal) {
    console.log("[BTC-profile] scanning entire document for account-based location fallback");
    const loc = extractAccountBasedLocationFromNodes(target.querySelectorAll("span, div"));
    if (loc) return loc;
  }

  console.log("[BTC-profile] no account-based location found");
  return "";
}

function extractAccountBasedLocation() {
  return extractAccountBasedLocationFromRoot(document, false);
}

function extractAccountBasedLocationFromHtmlString(html) {
  const plain = html.replace(/<[^>]+>/g, " ");
  const regexes = [
    /account based in[^A-Za-z0-9]{0,10}([A-Za-z0-9 ,.'-]{2,80})/i,
    /\"Account based in\"[^A-Za-z0-9]{0,10}([A-Za-z0-9 ,.'-]{2,80})/i
  ];
  for (const re of regexes) {
    const m = plain.match(re);
    if (m && m[1]) {
      const val = m[1].trim();
      if (val) {
        console.log("[BTC-profile] regex extracted account-based location from HTML", { val });
        return val;
      }
    }
  }
  return "";
}

function observeAboutTooltip(handle) {
  // Hover/focus on the About link to encourage X to load tooltip content with "Account based in".
  const selector = `a[href$=\"/${handle}/about\"], a[href$=\"/${handle.toLowerCase()}/about\"]`;
  const aboutLink = document.querySelector(selector);
  if (!aboutLink) return;

  const tooltipObserver = new MutationObserver(() => {
    const tipCandidates = document.querySelectorAll('[role="tooltip"], div[aria-live]');
    for (const tip of tipCandidates) {
      const text = textFrom(tip);
      if (text && /account based in/i.test(text)) {
        const val = extractAccountBasedLocationFromNodes([tip]) || text.replace(/account based in/i, "").trim();
        if (val) {
          const bio = extractBio();
          console.log("[BTC-profile] tooltip account-based location", { handle, val });
          saveProfile(handle, { location: val, bio, source: "profile_tooltip_account_based" });
          tooltipObserver.disconnect();
          return;
        }
      }
    }
  });

  const trigger = () => {
    try {
      aboutLink.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      aboutLink.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      aboutLink.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      console.log("[BTC-profile] triggered about link hover for tooltip", { handle });
      tooltipObserver.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => tooltipObserver.disconnect(), 8000);
    } catch (e) {
      console.log("[BTC-profile] tooltip trigger failed", e);
    }
  };

  trigger();
}

async function saveProfile(handle, profile) {
  if (!chrome?.runtime?.sendMessage) return;
  try {
    await chrome.runtime.sendMessage({
      type: "SET_PROFILE",
      handle,
      profile
    });
  } catch {}
}

async function runOnceAfterLoad() {
  if (!isXHost()) return;
  const isProfile = looksLikeProfilePage();
  const isAbout = looksLikeAboutPage();
  if (!isProfile && !isAbout) return;

  const handle = getHandleFromPath();
  const aboutApiPromise = isProfile ? fetchAccountBasedLocationViaApi(handle) : Promise.resolve("");
  const aboutLocPromise = isProfile ? fetchAboutBasedLocation(handle) : Promise.resolve("");
  if (isProfile) observeAboutTooltip(handle);

  if (isAbout) {
    const loc = extractAccountBasedLocationFromRoot(document, true);
    const bio = extractBio();
    if (loc) {
      const iso = isoFromLocationText(loc);
      console.log("[BTC-profile] about page scrape", { handle, loc });
      await saveProfile(handle, { location: loc, locationIso2: iso, bio, source: "profile_about_page_dom" });
      return;
    }
    console.log("[BTC-profile] about page found no location");
  }

  // Priority 1: About API ("account based in")
  try {
    const apiLoc = await aboutApiPromise;
    if (apiLoc) {
      const bio = extractBio();
      const iso = isoFromLocationText(apiLoc);
      console.log("[BTC-profile] using about API location", { handle, apiLoc, bio_preview: (bio || "").slice(0, 80) });
      await saveProfile(handle, { location: apiLoc, locationIso2: iso, bio, source: "profile_about_api" });
      return;
    }
  } catch (e) {
    console.log("[BTC-profile] about API failed", e);
  }

  // Priority 2: About page scrape (Account based in)
  try {
    const aboutLoc = await aboutLocPromise;
    if (aboutLoc) {
      const bio = extractBio();
      const iso = isoFromLocationText(aboutLoc);
      console.log("[BTC-profile] using about page location", { handle, aboutLoc, bio_preview: (bio || "").slice(0, 80) });
      await saveProfile(handle, { location: aboutLoc, locationIso2: iso, bio, source: "profile_about_page" });
      return;
    }
  } catch (e) {
    console.log("[BTC-profile] about-page fetch failed", e);
  }

  // Priority 3: DOM scrape (location/bio) if about sources failed or rate limited
  for (let attempt = 0; attempt < 20; attempt++) {
    const loc = extractAccountBasedLocation() || extractLocation();
    const bio = extractBio();

    if (loc || bio) {
      console.log("[BTC-profile] scraped", { handle, loc, bio_preview: (bio || "").slice(0, 80) });
      const iso = isoFromLocationText(loc);
      await saveProfile(handle, { location: loc, locationIso2: iso, bio, source: "profile_dom" });
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log("[BTC-profile] no location/bio found after retries", { handle });
}

let lastUrl = location.href;
const mo = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    runOnceAfterLoad();
  }
});

mo.observe(document.documentElement, { childList: true, subtree: true });
runOnceAfterLoad();

// Watch for "About this account" dialogs to capture the "Account based in" value when opened.
const accountDialogObserver = new MutationObserver(() => {
  const handle = looksLikeProfilePage() ? getHandleFromPath() : null;
  if (!handle) return;
  const loc = extractAccountBasedLocationFromRoot(document, false);
  if (loc) {
    const bio = extractBio();
    console.log("[BTC-profile] scraped account-based location from dialog", { handle, loc });
    saveProfile(handle, { location: loc, bio, source: "profile_dom_account_based" });
    accountDialogObserver.disconnect();
  } else {
    console.log("[BTC-profile] account-based location not found yet; waiting for dialog content");
  }
});
console.log("[BTC-profile] observing for account-based location dialog");
accountDialogObserver.observe(document.documentElement, { childList: true, subtree: true });

}
