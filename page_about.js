(function() {
  let capturedHeaders = null;
  let headersReady = false;
  let rateLimitUntil = 0; // ms since epoch
  let lastRequestMs = 0;
  const MIN_INTERVAL_MS = 2500;
  const queue = [];
  let active = false;

  function captureHeaders(headers) {
    if (!headers) return;
    const out = {};
    if (headers instanceof Headers) {
      headers.forEach((v, k) => out[k] = v);
    } else if (typeof headers === "object") {
      Object.assign(out, headers);
    }
    capturedHeaders = out;
    headersReady = true;
    console.log("[BTC-page] captured headers", Object.keys(out || {}));
  }

  // intercept fetch
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    const opts = args[1] || {};
    if (typeof url === "string" && url.includes("/i/api/graphql/")) {
      if (opts.headers) captureHeaders(opts.headers);
    }
    return origFetch.apply(this, args);
  };

  // intercept XHR
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._btcUrl = url;
    this._btcHeaders = {};
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this._btcHeaders) this._btcHeaders[k] = v;
    return origSetHeader.apply(this, [k, v]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._btcUrl && this._btcUrl.includes("/i/api/graphql/")) {
      captureHeaders(this._btcHeaders);
    }
    return origSend.apply(this, args);
  };

  function authHeaders() {
    const h = capturedHeaders || {};
    if (!h["accept"] && !h["Accept"]) h["Accept"] = "application/json";
    if (!h["content-type"] && !h["Content-Type"]) h["Content-Type"] = "application/json";
    return h;
  }

  async function fetchAbout(screenName) {
    const now = Date.now();
    if (rateLimitUntil && now < rateLimitUntil) {
      return { location: "", status: 429, isRateLimited: true, resetTimeMs: rateLimitUntil };
    }

    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestMs));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const vars = JSON.stringify({ screenName });
    const url = `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(vars)}`;
    const headers = authHeaders();
    lastRequestMs = Date.now();
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        credentials: "include",
        referrer: location.href,
        referrerPolicy: "origin-when-cross-origin"
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        let resetMs = 0;
        if (resp.status === 429) {
          const reset = resp.headers.get("x-rate-limit-reset");
          if (reset) {
            resetMs = parseInt(reset, 10) * 1000;
            rateLimitUntil = resetMs;
          } else {
            rateLimitUntil = Date.now() + 5 * 60 * 1000;
            resetMs = rateLimitUntil;
          }
        }
        console.log("[BTC-page] about fetch error", resp.status, txt.slice(0, 200));
        return { location: "", status: resp.status, isRateLimited: resp.status === 429, resetTimeMs: resetMs };
      }
      const data = await resp.json();
      const loc = data?.data?.user_result_by_screen_name?.result?.about_profile?.account_based_in || "";
      console.log("[BTC-page] about fetch ok", { screenName, loc });
      return { location: loc || "", status: resp.status, isRateLimited: false, resetTimeMs: 0 };
    } catch (e) {
      console.log("[BTC-page] about fetch exception", e);
      return { location: "", status: 0, error: String(e), isRateLimited: false, resetTimeMs: 0 };
    }
  }

  async function processQueue() {
    if (active || !queue.length) return;
    active = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        const res = await fetchAbout(item.handle);
        window.postMessage({
          type: "BTC_ABOUT_RESULT",
          handle: item.handle,
          reqId: item.reqId,
          location: res.location || "",
          status: res.status || 0,
          error: res.error || "",
          isRateLimited: !!res.isRateLimited,
          resetTimeMs: res.resetTimeMs || 0
        }, "*");
        if (res.isRateLimited && res.resetTimeMs) {
          const waitMs = Math.max(0, res.resetTimeMs - Date.now());
          await new Promise(r => setTimeout(r, Math.min(waitMs, 60_000)));
        }
      }
    } finally {
      active = false;
    }
  }

  window.addEventListener("message", async (evt) => {
    if (evt.source !== window) return;
    const msg = evt.data || {};
    if (msg.type !== "BTC_FETCH_ABOUT") return;
    const { handle, reqId } = msg;

    let tries = 0;
    while (!headersReady && tries < 20) {
      await new Promise(r => setTimeout(r, 150));
      tries++;
    }

    queue.push({ handle, reqId });
    processQueue();
  });
})();
