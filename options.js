const RULES_KEY = "rules";
const PREFS_KEY = "prefs";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function ruleTemplate() {
  return {
    id: uid(),
    enabled: true,
    country: "Israel",
    nickname: "Israel",
    emoji: "",
    iso2: "IL",
    keywords: ["israel", "tel aviv", "jerusalem"],
    scanBio: false
  };
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "checked") e.checked = !!v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function parseKeywords(s) {
  return String(s || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function keywordsToString(arr) {
  return (arr || []).join(", ");
}

async function load() {
  const res = await chrome.storage.sync.get({
    [RULES_KEY]: [],
    [PREFS_KEY]: { debug: false, logOnce: true, blockUnresolved: false }
  });

  const rules = res[RULES_KEY] || [];
  const prefs = res[PREFS_KEY] || { debug: false, logOnce: true, blockUnresolved: false };

  renderRules(rules);
  document.getElementById("debug").checked = !!prefs.debug;
  document.getElementById("logOnce").checked = !!prefs.logOnce;
  document.getElementById("blockUnresolved").checked = !!prefs.blockUnresolved;

  await refreshStats();
}

function renderRules(rules) {
  const root = document.getElementById("rules");
  root.innerHTML = "";

  rules.forEach((r, idx) => {
    const box = el("div", { class: "rule", "data-id": r.id },
      el("div", { class: "row" },
        el("strong", {}, `Rule ${idx + 1}`),
        el("span", { class: "small muted" }, `id: ${r.id}`),
        el("button", { onclick: () => removeRule(r.id) }, "Remove")
      ),
      el("div", { class: "grid" },
        el("label", {}, "Enabled"),
        el("input", { type: "checkbox", class: "enabled", checked: !!r.enabled }),

        el("label", {}, "Country"),
        el("input", { type: "text", class: "country", value: r.country || "" }),

        el("label", {}, "Nickname (counter label)"),
        el("input", { type: "text", class: "nickname", value: r.nickname || "" }),

        el("label", {}, "Emoji (optional)"),
        el("input", { type: "text", class: "emoji", value: r.emoji || "", maxlength: 4 }),

        el("label", {}, "ISO2"),
        el("input", { type: "text", class: "iso2", value: (r.iso2 || "").toUpperCase() }),

        el("label", {}, "Keywords"),
        el("input", { type: "text", class: "keywords", value: keywordsToString(r.keywords || []) }),

        el("label", {}, "Scan bio"),
        el("input", { type: "checkbox", class: "scanBio", checked: !!r.scanBio })
      )
    );

    root.appendChild(box);
  });
}

async function removeRule(id) {
  const res = await chrome.storage.sync.get({ [RULES_KEY]: [] });
  const rules = (res[RULES_KEY] || []).filter(r => r.id !== id);
  await chrome.storage.sync.set({ [RULES_KEY]: rules });
  renderRules(rules);
}

async function addRule() {
  const res = await chrome.storage.sync.get({ [RULES_KEY]: [] });
  const rules = res[RULES_KEY] || [];
  rules.push(ruleTemplate());
  await chrome.storage.sync.set({ [RULES_KEY]: rules });
  renderRules(rules);
}

async function save() {
  const root = document.getElementById("rules");
  const boxes = Array.from(root.querySelectorAll(".rule"));

  const rules = boxes.map(b => {
    const id = b.getAttribute("data-id");
    return {
      id,
      enabled: b.querySelector(".enabled").checked,
      country: b.querySelector(".country").value.trim(),
      nickname: b.querySelector(".nickname").value.trim(),
      emoji: b.querySelector(".emoji").value.trim(),
      iso2: b.querySelector(".iso2").value.trim().toUpperCase(),
      keywords: parseKeywords(b.querySelector(".keywords").value),
      scanBio: b.querySelector(".scanBio").checked
    };
  }).filter(r => r.country);

  const prefs = {
    debug: document.getElementById("debug").checked,
    logOnce: document.getElementById("logOnce").checked,
    blockUnresolved: document.getElementById("blockUnresolved").checked
  };

  await chrome.storage.sync.set({ rules, prefs });
  alert("Saved.");
}

async function refreshStats() {
  const statsEl = document.getElementById("stats");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_STATS" });
    if (!resp?.ok) throw new Error(resp?.error || "no response");

    const s = resp.stats || {};
    statsEl.textContent =
      `totalBlocked: ${s.totalBlocked || 0}\n\n` +
      `byCountry:\n${JSON.stringify(s.byCountry || {}, null, 2)}\n\n` +
      `byRuleId:\n${JSON.stringify(s.byRuleId || {}, null, 2)}\n`;
  } catch (e) {
    statsEl.textContent = `Failed to load stats: ${String(e)}`;
  }
}

async function clearCache() {
  await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  alert("Profile cache cleared.");
}

document.getElementById("addRule").addEventListener("click", addRule);
document.getElementById("save").addEventListener("click", save);
document.getElementById("refreshStats").addEventListener("click", refreshStats);
document.getElementById("clearCache").addEventListener("click", clearCache);

load();
