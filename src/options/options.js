import { getSettings, setSettings } from "../lib/storage.js";
import { PROVIDERS, PROVIDER_ORDER, IMAGE_SIZES } from "../lib/models.js";

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

function buildImageProvider(settings) {
  const sel = $("imageProvider");
  sel.innerHTML = "";
  for (const id of PROVIDER_ORDER) {
    if (!PROVIDERS[id].supportsImages) continue;
    const o = document.createElement("option");
    o.value = id;
    o.textContent = PROVIDERS[id].label;
    sel.appendChild(o);
  }
  sel.value = settings.imageProvider || "openai";

  const size = $("imageSize");
  size.innerHTML = "";
  for (const s of IMAGE_SIZES) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    size.appendChild(o);
  }
  size.value = settings.imageSize || "1024x1024";
}

let settings;

async function load() {
  settings = await getSettings();
  buildProviderFields(settings);
  buildImageProvider(settings);
  $("imageModel").value = settings.imageModel || "";
  $("thinking").checked = settings.thinking;
  $("webSearch").checked = settings.webSearch;
  $("agentMode").checked = settings.agentMode;
  $("confirmActions").checked = settings.confirmActions;
  $("blockPayments").checked = settings.blockPayments;
  $("webmailAssist").checked = settings.webmailAssist;
  $("includePageContext").checked = settings.includePageContext;
  $("autoReadPage").checked = settings.autoReadPage;
  $("targetLang").value = settings.targetLang || "Français";
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
  const patch = {
    keys,
    baseUrls,
    models,
    imageProvider: $("imageProvider").value,
    imageModel: $("imageModel").value.trim() || "gpt-image-1",
    imageSize: $("imageSize").value,
    thinking: $("thinking").checked,
    webSearch: $("webSearch").checked,
    agentMode: $("agentMode").checked,
    confirmActions: $("confirmActions").checked,
    blockPayments: $("blockPayments").checked,
    webmailAssist: $("webmailAssist").checked,
    includePageContext: $("includePageContext").checked,
    autoReadPage: $("autoReadPage").checked,
    targetLang: $("targetLang").value.trim() || "Français",
    maxPageChars: parseInt($("maxPageChars").value, 10) || 12000,
  };
  await setSettings(patch);
  settings = await getSettings();
  const st = $("status");
  st.textContent = "✓ Enregistré.";
  setTimeout(() => (st.textContent = ""), 2000);
}

$("save").addEventListener("click", save);
load();
