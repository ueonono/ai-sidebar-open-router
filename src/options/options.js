import { getSettings, setSettings } from "../lib/storage.js";
import { PROVIDERS, PROVIDER_ORDER, IMAGE_SIZES, WRITING_PRESETS, isConnected } from "../lib/models.js";
import { connectOpenRouter } from "../lib/auth.js";
import { listModels } from "../lib/providers.js";
import { clearConversations } from "../lib/history.js";
import { t, setLang, applyDom } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);

// Most-spoken languages for the AI response language (English first / default).
const LANGUAGES = [
  "English", "中文 (Chinese)", "हिन्दी (Hindi)", "Español", "Français", "العربية (Arabic)",
  "বাংলা (Bengali)", "Português", "Русский (Russian)", "Bahasa Indonesia", "Deutsch",
  "日本語 (Japanese)", "Türkçe", "한국어 (Korean)", "Italiano", "Tiếng Việt", "Nederlands", "Polski",
];

// Providers with a free tier (free API key / free models).
const FREE_TIER = new Set(["google", "groq", "openrouter", "mistral", "cerebras"]);
// Providers with a real in-app account OAuth (the rest log in on the provider's
// own site to copy an API key).
const OAUTH = new Set(["openrouter"]);

// Sign-in / console page for each provider. We use the provider's CONSOLE (which
// redirects to its login when the user isn't authenticated) rather than raw auth
// endpoints like auth.openai.com — those reject direct access ("session ended").
// After signing in with their account, the user creates an API key there.
const LOGIN_URL = {
  anthropic: "https://console.anthropic.com/",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/app/apikey",
  mistral: "https://console.mistral.ai/api-keys",
  groq: "https://console.groq.com/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai/",
  perplexity: "https://www.perplexity.ai/settings/api",
  together: "https://api.together.ai/settings/api-keys",
  fireworks: "https://fireworks.ai/",
  deepinfra: "https://deepinfra.com/dash/api_keys",
  cerebras: "https://cloud.cerebras.ai/",
  cohere: "https://dashboard.cohere.com/api-keys",
};

let settings;
let modelLists = {};

function category(id) {
  const meta = PROVIDERS[id];
  if (meta.local) return "local";
  if (meta.custom) return "custom";
  return "cloud";
}

function modelOptionsFor(id) {
  const fetched = modelLists[id] || [];
  const labels = new Map(PROVIDERS[id].models);
  const ids = fetched.length ? fetched : PROVIDERS[id].models.map((m) => m[0]);
  const seen = new Set();
  const out = [["", t("opt.model.auto")]];
  for (const m of ids) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push([m, labels.get(m) || m]);
  }
  return out;
}

function fillModelSelect(sel, id) {
  const chosen = (settings.models && settings.models[id]) || "";
  sel.innerHTML = "";
  for (const [val, label] of modelOptionsFor(id)) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = chosen;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildCard(id) {
  const meta = PROVIDERS[id];
  const sec = el("section", "provider-card");

  const head = el("div", "provider-head");
  head.appendChild(el("h3", null, meta.label + (meta.local ? t("opt.localSuffix") : "")));
  const badge = el("span", "badge");
  head.appendChild(badge);
  if (FREE_TIER.has(id)) head.appendChild(el("span", "badge free", t("opt.badge.free")));
  sec.appendChild(head);

  // Connect affordance on EVERY cloud provider. P8 — the badge AND this button now
  // reflect the connection state live (as soon as a key is pasted, before saving),
  // so "Se connecter" never lingers next to an already-connected provider.
  let connectBtn = null;
  if (category(id) === "cloud") {
    connectBtn = el("button", "small connect");
    connectBtn.addEventListener("click", () => connectAccount(id));
    sec.appendChild(connectBtn);
    sec.appendChild(el("p", "muted hint", OAUTH.has(id) ? t("opt.hint.oauth") : t("opt.hint.key")));
  }

  // Reflect connected/disconnected state on the badge + connect button.
  const applyConnState = (connectedNow) => {
    badge.className = "badge " + (connectedNow ? "ok" : "off");
    badge.textContent = connectedNow ? t("opt.badge.connected") : t("opt.badge.off");
    if (id === "openrouter") updateQuickConnect(connectedNow);
    if (!connectBtn) return;
    if (connectedNow) {
      connectBtn.className = "ghost small connect connected";
      connectBtn.textContent = OAUTH.has(id) ? t("opt.connect.oauthReconnect") : t("opt.connect.keyReconnect", { label: meta.label });
    } else {
      connectBtn.className = "grad small connect";
      connectBtn.textContent = OAUTH.has(id) ? t("opt.connect.oauth") : t("opt.connect.key", { label: meta.label });
    }
  };
  applyConnState(isConnected(id, settings));

  // Local server: explicit opt-in.
  if (meta.local) {
    const lab = el("label", "switch");
    const inp = el("input");
    inp.type = "checkbox";
    inp.id = `local_${id}`;
    inp.checked = !!(settings.localEnabled && settings.localEnabled[id]);
    inp.addEventListener("change", () => applyConnState(inp.checked));
    lab.appendChild(inp);
    lab.appendChild(el("span", "track"));
    lab.appendChild(el("span", "lbl", t("opt.local.enable")));
    sec.appendChild(lab);
  }

  // API key.
  if (meta.needsKey || id === "custom") {
    const lab = el("label", null, meta.needsKey ? t("opt.key.label") : t("opt.key.labelOpt"));
    const inp = el("input");
    inp.type = "password";
    inp.id = `key_${id}`;
    inp.placeholder = meta.keyHint || "key…";
    inp.value = (settings.keys && settings.keys[id]) || "";
    // Live feedback: a non-empty key counts as "Connecté(e)" immediately (P8).
    inp.addEventListener("input", () => applyConnState(!!inp.value.trim() || isConnected(id, settings)));
    lab.appendChild(inp);
    sec.appendChild(lab);
    if (meta.keysUrl) {
      const p = el("p", "muted");
      const tag = FREE_TIER.has(id) ? t("opt.key.getFree") : t("opt.key.console");
      p.innerHTML = `${tag}<a href="${meta.keysUrl}" target="_blank" rel="noreferrer">${meta.keysUrl.replace(/^https?:\/\//, "")}</a>`;
      sec.appendChild(p);
    }
  }

  // Base URL (local / custom).
  if (meta.local || meta.custom) {
    const lab = el("label", null, t("opt.url.label"));
    const inp = el("input");
    inp.type = "text";
    inp.id = `url_${id}`;
    inp.placeholder = meta.baseUrl || "https://your-server/v1";
    inp.value = (settings.baseUrls && settings.baseUrls[id]) || "";
    lab.appendChild(inp);
    sec.appendChild(lab);
  }

  // Default model — dropdown of currently available models.
  const lab = el("label", null, t("opt.model.default"));
  const sel = el("select");
  sel.id = `model_${id}`;
  lab.appendChild(sel);
  sec.appendChild(lab);
  fillModelSelect(sel, id);

  return sec;
}

function buildProviderFields() {
  const root = $("providers");
  root.innerHTML = "";
  let lastCat = null;
  for (const id of PROVIDER_ORDER) {
    const cat = category(id);
    if (cat !== lastCat) {
      root.appendChild(el("h2", "group-title", t("opt.group." + cat)));
      lastCat = cat;
    }
    root.appendChild(buildCard(id));
  }
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  for (const [val, label] of items) {
    const o = el("option", null, label);
    o.value = val;
    sel.appendChild(o);
  }
  if (value != null) sel.value = value;
}

function buildImageProvider() {
  const imgProviders = PROVIDER_ORDER.filter((id) => PROVIDERS[id].supportsImages).map((id) => [id, PROVIDERS[id].label]);
  fillSelect($("imageProvider"), imgProviders, settings.imageProvider || "openai");
  fillSelect($("imageSize"), IMAGE_SIZES, settings.imageSize || "1024x1024");
}

// Agent-model picker: "Auto" + the catalogue models of every CONNECTED provider.
// Lets the user pin a tool-capable model for agent mode (many free models can't
// call tools). Mirrors buildSearchModelSelect.
function buildAgentModelSelect() {
  const sel = $("agentModel");
  if (!sel) return;
  sel.innerHTML = "";
  const auto = el("option", null, t("opt.agent.auto"));
  auto.value = "";
  sel.appendChild(auto);
  for (const id of PROVIDER_ORDER) {
    if (!isConnected(id, settings)) continue;
    const meta = PROVIDERS[id];
    if (!meta.models || !meta.models.length) continue;
    const group = document.createElement("optgroup");
    group.label = meta.label;
    for (const [mid, mlabel] of meta.models) {
      const o = el("option", null, mlabel);
      o.value = id + "|" + mid;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  sel.value = settings.agentModel || "";
}

// Web-search model picker: "Auto" + the catalogue models of every CONNECTED
// provider (using the curated catalogue, not the huge live OpenRouter list, to
// keep it usable). Perplexity Sonar and OpenRouter free models are the good picks.
function buildSearchModelSelect() {
  const sel = $("searchModel");
  if (!sel) return;
  sel.innerHTML = "";
  const auto = el("option", null, t("opt.search.auto"));
  auto.value = "";
  sel.appendChild(auto);
  for (const id of PROVIDER_ORDER) {
    if (!isConnected(id, settings)) continue;
    const meta = PROVIDERS[id];
    if (!meta.models || !meta.models.length) continue;
    const group = document.createElement("optgroup");
    group.label = meta.label + (meta.supportsWebSearch ? " · web" : "");
    for (const [mid, mlabel] of meta.models) {
      const o = el("option", null, mlabel);
      o.value = id + "|" + mid;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  sel.value = settings.searchModel || "";
}

// Fetch live model lists for connected providers, then refresh the dropdowns.
async function refreshModelLists() {
  const ids = PROVIDER_ORDER.filter((id) => isConnected(id, settings));
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const list = await listModels(id, settings);
        if (list && list.length) modelLists[id] = list;
      } catch (_) {}
    })
  );
  for (const id of ids) {
    const sel = $(`model_${id}`);
    if (sel) fillModelSelect(sel, id);
  }
  await setSettings({ modelLists: { ...(settings.modelLists || {}), ...modelLists } });
}

// Reflect the OpenRouter quick-connect button state at the top of the page (it used
// to stay "Connect…" even once connected).
function updateQuickConnect(connectedNow) {
  const btn = $("quickConnect");
  if (!btn) return;
  if (connectedNow) {
    btn.className = "ghost";
    btn.textContent = t("opt.quick.btnConnected");
  } else {
    btn.className = "grad";
    btn.textContent = t("opt.quick.btn");
  }
}

// Quick-navigation pins: one per settings section, with smooth scroll + a scroll-spy
// that highlights the section currently in view. Built from <section id> + its <h2>.
function buildQuickNav() {
  const nav = $("quicknav");
  if (!nav) return;
  nav.innerHTML = "";
  nav.appendChild(el("span", "qn-label", t("opt.nav.label")));
  const links = [];
  document.querySelectorAll("main > section[id]").forEach((sec) => {
    const h = sec.querySelector("h2");
    if (!h) return;
    const a = el("a", "qn-pin", h.textContent.trim());
    a.href = "#" + sec.id;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      sec.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", "#" + sec.id);
    });
    nav.appendChild(a);
    links.push({ a, sec });
  });
  const spy = () => {
    let active = links[0];
    for (const l of links) if (l.sec.getBoundingClientRect().top <= 96) active = l;
    links.forEach((l) => l.a.classList.toggle("active", l === active));
  };
  window.addEventListener("scroll", spy, { passive: true });
  spy();
}

async function load() {
  settings = await getSettings();
  setLang(settings.uiLang || "en");       // English default; French via the uiLang setting
  applyDom(document);                      // fill all data-i18n static markup
  document.documentElement.lang = settings.uiLang === "fr" ? "fr" : "en";
  buildQuickNav();                         // jump pins to each section
  modelLists = { ...(settings.modelLists || {}) };
  buildProviderFields();
  buildImageProvider();
  buildSearchModelSelect();
  buildAgentModelSelect();
  fillSelect($("responseLang"), [["Auto", t("opt.lang.respAuto")], ...LANGUAGES.map((l) => [l, l])], settings.responseLang || "Auto");
  fillSelect($("improvePreset"), WRITING_PRESETS.map((p) => [p[0], t("preset." + p[0])]), settings.improvePreset || "improve");
  updateQuickConnect(isConnected("openrouter", settings));
  $("imageModel").value = settings.imageModel || "";
  $("uiLang").value = settings.uiLang || "en";
  $("railSide").value = settings.railSide === "right" ? "right" : "left";
  $("targetLang").value = settings.targetLang || "French";
  $("webSearch").checked = settings.webSearch;
  $("orFreeOnly").checked = settings.orFreeOnly !== false;
  $("agentPermission").value = settings.agentPermission || "manual";
  $("codeAppUrl").value = settings.codeAppUrl != null ? settings.codeAppUrl : "";
  $("blockPayments").checked = settings.blockPayments;
  $("webmailAssist").checked = settings.webmailAssist;
  $("saveHistory").checked = settings.saveHistory;
  $("includePageContext").checked = settings.includePageContext;
  $("autoReadPage").checked = settings.autoReadPage;
  $("maxPageChars").value = settings.maxPageChars;
  refreshModelLists();
}

async function save() {
  const keys = {};
  const baseUrls = {};
  const models = {};
  const localEnabled = {};
  for (const id of PROVIDER_ORDER) {
    const k = $(`key_${id}`);
    if (k && k.value.trim()) keys[id] = k.value.trim();
    const u = $(`url_${id}`);
    if (u && u.value.trim()) baseUrls[id] = u.value.trim();
    const m = $(`model_${id}`);
    if (m && m.value) models[id] = m.value;
    const lc = $(`local_${id}`);
    if (lc && lc.checked) localEnabled[id] = true;
  }
  await setSettings({
    keys, baseUrls, models, localEnabled,
    imageProvider: $("imageProvider").value,
    imageModel: $("imageModel").value.trim() || "gpt-image-1",
    imageSize: $("imageSize").value,
    improvePreset: $("improvePreset").value,
    uiLang: $("uiLang").value === "fr" ? "fr" : "en",
    railSide: $("railSide").value === "right" ? "right" : "left",
    responseLang: $("responseLang").value,
    targetLang: $("targetLang").value.trim() || "French",
    webSearch: $("webSearch").checked,
    orFreeOnly: $("orFreeOnly").checked,
    searchModel: $("searchModel").value,
    agentModel: $("agentModel").value,
    agentPermission: $("agentPermission").value,
    // Keep the legacy `confirmActions` flag in sync with the permission select so
    // older code paths stay consistent (manual = confirm, auto = no confirm).
    confirmActions: $("agentPermission").value !== "auto",
    codeAppUrl: $("codeAppUrl").value.trim(),
    blockPayments: $("blockPayments").checked,
    webmailAssist: $("webmailAssist").checked,
    saveHistory: $("saveHistory").checked,
    includePageContext: $("includePageContext").checked,
    autoReadPage: $("autoReadPage").checked,
    maxPageChars: parseInt($("maxPageChars").value, 10) || 12000,
  });
  settings = await getSettings();
  modelLists = { ...(settings.modelLists || {}) };
  buildProviderFields();
  buildSearchModelSelect();
  buildAgentModelSelect();
  refreshModelLists();
  flash($("status"), t("opt.saved"));
}

function flash(node, text) {
  node.textContent = text;
  setTimeout(() => (node.textContent = ""), 2500);
}

// "Connect": OpenRouter via in-app OAuth; other providers open their own console
// (the user logs in with their account there, creates a key, and pastes it).
async function connectAccount(id) {
  const status = $("status");
  if (OAUTH.has(id)) {
    status.textContent = t("opt.dyn.connecting");
    try {
      const key = await connectOpenRouter();
      const cur = await getSettings();
      cur.keys = cur.keys || {};
      cur.keys[id] = key;
      await setSettings({ keys: cur.keys, provider: id });
      await load();
      flash(status, t("opt.dyn.connected", { label: PROVIDERS[id].label }));
    } catch (e) {
      flash(status, t("opt.dyn.failed", { msg: e && e.message ? e.message : e }));
    }
    return;
  }
  // Non-OAuth: open the provider's LOGIN page directly (the user signs in with
  // their account), then focus the key field for the key they create there.
  const meta = PROVIDERS[id];
  const url = LOGIN_URL[id] || meta.keysUrl;
  if (url) window.open(url, "_blank", "noopener");
  const f = $(`key_${id}`);
  if (f) { f.focus(); f.scrollIntoView({ block: "center" }); }
  flash(status, t("opt.dyn.identify", { label: meta.label }));
}

$("save").addEventListener("click", save);
$("quickConnect").addEventListener("click", async () => {
  flash($("quickStatus"), t("opt.dyn.connecting"));
  await connectAccount("openrouter");
  flash($("quickStatus"), isConnected("openrouter", settings) ? t("opt.quick.savedNote") : "");
});
$("clearHistoryBtn").addEventListener("click", async () => {
  await clearConversations();
  flash($("status"), t("opt.cleared"));
});

// Reflect connections made elsewhere (e.g. the sidebar's quick-connect): when the
// stored keys / providers change, rebuild the cards so the new API key shows up
// here without a manual refresh.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!(changes.keys || changes.baseUrls || changes.localEnabled || changes.provider)) return;
  getSettings().then((s) => {
    settings = s;
    modelLists = { ...(s.modelLists || {}) };
    buildProviderFields();
    buildImageProvider();
    buildSearchModelSelect();
    buildAgentModelSelect();
    refreshModelLists();
  });
});

load();
