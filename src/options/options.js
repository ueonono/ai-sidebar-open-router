import { getSettings, setSettings } from "../lib/storage.js";
import { PROVIDERS, PROVIDER_ORDER, IMAGE_SIZES, WRITING_PRESETS, isConnected } from "../lib/models.js";
import { connectOpenRouter } from "../lib/auth.js";
import { listModels } from "../lib/providers.js";
import { clearConversations } from "../lib/history.js";

const $ = (id) => document.getElementById(id);

// Providers that offer a free tier (free API key / free models).
const FREE_TIER = new Set(["google", "groq", "openrouter", "mistral", "cerebras"]);
// Providers that support real account OAuth (the rest use an API key).
const OAUTH = new Set(["openrouter"]);

let settings;
let modelLists = {};

// Build the list of model options for a provider's default-model dropdown:
// live-fetched models when available (current models only), else the catalogue.
function modelOptionsFor(id) {
  const fetched = modelLists[id] || [];
  const labels = new Map(PROVIDERS[id].models);
  const ids = fetched.length ? fetched : PROVIDERS[id].models.map((m) => m[0]);
  const seen = new Set();
  const out = [["", "(défaut automatique)"]];
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

// One card per provider: connection status, account/key, and a default-model menu.
function buildProviderFields() {
  const root = $("providers");
  root.innerHTML = "";
  for (const id of PROVIDER_ORDER) {
    const meta = PROVIDERS[id];
    const sec = document.createElement("section");
    sec.className = "provider-card";

    const head = document.createElement("div");
    head.className = "provider-head";
    const h = document.createElement("h3");
    h.textContent = meta.label + (meta.local ? "  (local, sans clé)" : "");
    head.appendChild(h);
    const badge = document.createElement("span");
    const connected = isConnected(id, settings);
    badge.className = "badge " + (connected ? "ok" : "off");
    badge.textContent = connected ? "✅ Connecté" : "○ Non connecté";
    head.appendChild(badge);
    if (FREE_TIER.has(id)) {
      const free = document.createElement("span");
      free.className = "badge free";
      free.textContent = "gratuit dispo";
      head.appendChild(free);
    }
    sec.appendChild(head);

    // Account OAuth (only providers that support it).
    if (OAUTH.has(id)) {
      const btn = document.createElement("button");
      btn.className = "grad small";
      btn.textContent = "Se connecter avec mon compte";
      btn.addEventListener("click", () => connect(id));
      sec.appendChild(btn);
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Connexion par compte (Google / GitHub / email) — débloque tous les modèles, y compris gratuits.";
      sec.appendChild(p);
    }

    // API key.
    if (meta.needsKey || id === "custom") {
      const lab = document.createElement("label");
      lab.textContent = meta.needsKey ? "Clé API" : "Clé API (optionnelle)";
      const inp = document.createElement("input");
      inp.type = "password";
      inp.id = `key_${id}`;
      inp.placeholder = meta.keyHint || "clé…";
      inp.value = (settings.keys && settings.keys[id]) || "";
      lab.appendChild(inp);
      sec.appendChild(lab);
      if (meta.keysUrl) {
        const p = document.createElement("p");
        p.className = "muted";
        const tag = FREE_TIER.has(id) ? "Obtenir une clé (offre gratuite) : " : "Obtenir une clé : ";
        p.innerHTML = `${tag}<a href="${meta.keysUrl}" target="_blank" rel="noreferrer">${meta.keysUrl.replace(/^https?:\/\//, "")}</a>`;
        sec.appendChild(p);
      }
    }

    // Base URL (local / custom).
    if (meta.local || meta.custom) {
      const lab = document.createElement("label");
      lab.textContent = "URL de base";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.id = `url_${id}`;
      inp.placeholder = meta.baseUrl || "https://votre-serveur/v1";
      inp.value = (settings.baseUrls && settings.baseUrls[id]) || "";
      lab.appendChild(inp);
      sec.appendChild(lab);
    }

    // Default model — dropdown of currently available models.
    const lab = document.createElement("label");
    lab.textContent = "Modèle par défaut";
    const sel = document.createElement("select");
    sel.id = `model_${id}`;
    lab.appendChild(sel);
    sec.appendChild(lab);
    fillModelSelect(sel, id);

    root.appendChild(sec);
  }
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  for (const [val, label] of items) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    sel.appendChild(o);
  }
  if (value != null) sel.value = value;
}

function buildImageProvider() {
  const imgProviders = PROVIDER_ORDER.filter((id) => PROVIDERS[id].supportsImages).map((id) => [id, PROVIDERS[id].label]);
  fillSelect($("imageProvider"), imgProviders, settings.imageProvider || "openai");
  fillSelect($("imageSize"), IMAGE_SIZES.map((s) => [s, s]), settings.imageSize || "1024x1024");
}

// Fetch the live model list for every connected provider, then refresh the
// default-model dropdowns so they show only currently available models.
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
  // Persist so the sidebar shows the same fresh lists.
  await setSettings({ modelLists: { ...(settings.modelLists || {}), ...modelLists } });
}

async function load() {
  settings = await getSettings();
  modelLists = { ...(settings.modelLists || {}) };
  buildProviderFields();
  buildImageProvider();
  fillSelect($("improvePreset"), WRITING_PRESETS.map((p) => [p[0], p[1]]), settings.improvePreset || "improve");
  $("imageModel").value = settings.imageModel || "";
  $("targetLang").value = settings.targetLang || "Français";
  $("thinking").checked = settings.thinking;
  $("webSearch").checked = settings.webSearch;
  $("agentMode").checked = settings.agentMode;
  $("confirmActions").checked = settings.confirmActions;
  $("blockPayments").checked = settings.blockPayments;
  $("webmailAssist").checked = settings.webmailAssist;
  $("saveHistory").checked = settings.saveHistory;
  $("includePageContext").checked = settings.includePageContext;
  $("autoReadPage").checked = settings.autoReadPage;
  $("maxPageChars").value = settings.maxPageChars;
  refreshModelLists(); // background: fill dropdowns with live models
}

async function save() {
  const keys = {};
  const baseUrls = {};
  const models = {};
  for (const id of PROVIDER_ORDER) {
    const k = $(`key_${id}`);
    if (k && k.value.trim()) keys[id] = k.value.trim();
    const u = $(`url_${id}`);
    if (u && u.value.trim()) baseUrls[id] = u.value.trim();
    const m = $(`model_${id}`);
    if (m && m.value) models[id] = m.value;
  }
  await setSettings({
    keys, baseUrls, models,
    imageProvider: $("imageProvider").value,
    imageModel: $("imageModel").value.trim() || "gpt-image-1",
    imageSize: $("imageSize").value,
    improvePreset: $("improvePreset").value,
    targetLang: $("targetLang").value.trim() || "Français",
    thinking: $("thinking").checked,
    webSearch: $("webSearch").checked,
    agentMode: $("agentMode").checked,
    confirmActions: $("confirmActions").checked,
    blockPayments: $("blockPayments").checked,
    webmailAssist: $("webmailAssist").checked,
    saveHistory: $("saveHistory").checked,
    includePageContext: $("includePageContext").checked,
    autoReadPage: $("autoReadPage").checked,
    maxPageChars: parseInt($("maxPageChars").value, 10) || 12000,
  });
  settings = await getSettings();
  buildProviderFields(); // refresh statuses
  refreshModelLists();
  flash($("status"), "✓ Enregistré.");
}

function flash(node, text) {
  node.textContent = text;
  setTimeout(() => (node.textContent = ""), 2000);
}

// OAuth account connection (currently OpenRouter).
async function connect(id) {
  const status = $("connectStatus");
  status.textContent = "Connexion…";
  try {
    if (id === "openrouter") {
      const key = await connectOpenRouter();
      const cur = await getSettings();
      cur.keys = cur.keys || {};
      cur.keys.openrouter = key;
      await setSettings({ keys: cur.keys, provider: "openrouter" });
    }
    await load();
    flash(status, "✓ Connecté.");
  } catch (e) {
    flash(status, "Échec : " + (e && e.message ? e.message : e));
  }
}

$("save").addEventListener("click", save);
$("connectBtn").addEventListener("click", () => connect("openrouter"));
$("clearHistoryBtn").addEventListener("click", async () => {
  await clearConversations();
  flash($("status"), "✓ Historique effacé.");
});
load();
