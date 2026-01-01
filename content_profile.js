// content_profile.js
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

function textFrom(el) {
  if (!el) return "";
  return (el.innerText || el.textContent || "").trim();
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
  if (!looksLikeProfilePage()) return;

  const handle = getPathParts()[0];

  // Wait for profile header area to render (X is SPA)
  // Try a few times without infinite looping.
  for (let attempt = 0; attempt < 20; attempt++) {
    const loc = extractLocation();
    const bio = extractBio();

    if (loc || bio) {
      console.log("[BTC-profile] scraped", { handle, loc, bio_preview: (bio || "").slice(0, 80) });
      await saveProfile(handle, { location: loc, bio, source: "profile_dom" });
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
