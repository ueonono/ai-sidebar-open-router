import { getSettings, setSettings } from "../lib/storage.js";
import { PROVIDERS, PROVIDER_ORDER, IMAGE_SIZES, WRITING_PRESETS } from "../lib/models.js";
import { connectOpenRouter } from "../lib/auth.js";
import { clearConversations } from "../lib/history.js";

const $ = (id) => document.getElementById(id);

// Build one block per provider: API key (when required), base URL (local /
// custom servers) and a default model.
function buildProviderFields(settings) {
  const root = $("providers");
  root.innerHTML = "";
  for (const id of PROVIDER_ORDER) {
    const meta = PROVIDERS[id];
    const sec = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = meta.label + (meta.local ? "  (local, sans clé)" : "");
    sec.appendChild(h);

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
        p.innerHTML = `Obtenir une clé : <a href="${meta.keysUrl}" target="_blank" rel="noreferrer">${meta.keysUrl.replace(/^https?:\/\//, "")}</a>`;
        sec.appendChild(p);
      }
    }

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

    const lab = document.createElement("label");
    lab.textContent = "Modèle par défaut";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = `model_${id}`;
    inp.placeholder = (meta.models[0] && meta.models[0][0]) || "nom-du-modèle";
    inp.value = (settings.models && settings.models[id]) || "";
    lab.appendChild(inp);
    sec.appendChild(lab);

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

function buildImageProvider(settings) {
  const imgProviders = PROVIDER_ORDER.filter((id) => PROVIDERS[id].supportsImages).map((id) => [id, PROVIDERS[id].label]);
  fillSelect($("imageProvider"), imgProviders, settings.imageProvider || "openai");
  fillSelect($("imageSize"), IMAGE_SIZES.map((s) => [s, s]), settings.imageSize || "1024x1024");
}

let settings;

async function load() {
  settings = await getSettings();
  buildProviderFields(settings);
  buildImageProvider(settings);
  fillSelect($("improvePreset"), WRITING_PRESETS.map((p) => [p[0], p[1]]), settings.improvePreset || "improve");
  $("imageModel").value = settings.imageModel || "";
  $("targetLang").value = settings.targetLang || "Français";
  $("thinking").checked = settings.thinking;
  $("webSearch").checked = settings.webSearch;
  $("agentMode").checked = settings.agentMode;
  $("compareMode").checked = settings.compareMode;
  $("confirmActions").checked = settings.confirmActions;
  $("blockPayments").checked = settings.blockPayments;
  $("webmailAssist").checked = settings.webmailAssist;
  $("saveHistory").checked = settings.saveHistory;
  $("includePageContext").checked = settings.includePageContext;
  $("autoReadPage").checked = settings.autoReadPage;
  $("maxPageChars").value = settings.maxPageChars;
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
    if (m && m.value.trim()) models[id] = m.value.trim();
  }
  // Replace (do not merge): clearing a field deletes the stored key/URL/model.
  await setSettings({
    keys,
    baseUrls,
    models,
    imageProvider: $("imageProvider").value,
    imageModel: $("imageModel").value.trim() || "gpt-image-1",
    imageSize: $("imageSize").value,
    improvePreset: $("improvePreset").value,
    targetLang: $("targetLang").value.trim() || "Français",
    thinking: $("thinking").checked,
    webSearch: $("webSearch").checked,
    agentMode: $("agentMode").checked,
    compareMode: $("compareMode").checked,
    confirmActions: $("confirmActions").checked,
    blockPayments: $("blockPayments").checked,
    webmailAssist: $("webmailAssist").checked,
    saveHistory: $("saveHistory").checked,
    includePageContext: $("includePageContext").checked,
    autoReadPage: $("autoReadPage").checked,
    maxPageChars: parseInt($("maxPageChars").value, 10) || 12000,
  });
  settings = await getSettings();
  flash($("status"), "✓ Enregistré.");
}

function flash(node, text) {
  node.textContent = text;
  setTimeout(() => (node.textContent = ""), 2000);
}

async function connect() {
  const status = $("connectStatus");
  $("connectBtn").disabled = true;
  status.textContent = "Connexion…";
  try {
    const key = await connectOpenRouter();
    const cur = await getSettings();
    cur.keys = cur.keys || {};
    cur.keys.openrouter = key;
    await setSettings({ keys: cur.keys, provider: "openrouter" });
    await load();
    flash(status, "✓ Connecté à OpenRouter.");
  } catch (e) {
    flash(status, "Échec : " + (e && e.message ? e.message : e));
  } finally {
    $("connectBtn").disabled = false;
  }
}

$("save").addEventListener("click", save);
$("connectBtn").addEventListener("click", connect);
$("clearHistoryBtn").addEventListener("click", async () => {
  await clearConversations();
  flash($("status"), "✓ Historique effacé.");
});
load();
