// Sidebar UI controller.
//
// Workspaces ("modes"): chat, translate, improve, image — Sider-style tabs that
// reuse the message list but swap the composer controls and the send behaviour.
// The sidebar also owns the privileged work: it talks to the AI provider, runs
// the agent loop, watches the active page ("eyes"), and lets the user pick extra
// tabs to feed as context.

import { getSettings, setSettings, setNested, onSettingsChanged } from "../lib/storage.js";
import { makeProvider, listModels, generateImage } from "../lib/providers.js";
import { buildSystemPrompt, activeTools, runConversation } from "../lib/agent.js";
import { executeTool } from "../lib/tools.js";
import { configureMarkdown, renderMarkdown, enhanceArtifacts } from "../lib/markdown.js";
import { PROVIDERS, PROVIDER_ORDER, modelFor, keyFor } from "../lib/models.js";

const $ = (id) => document.getElementById(id);
const els = {
  provider: $("provider"),
  model: $("model"),
  refreshModels: $("refreshModels"),
  thinking: $("thinking"),
  webSearch: $("webSearch"),
  agentMode: $("agentMode"),
  pageCtx: $("pageCtx"),
  pageBar: $("pageBar"),
  pageTitle: $("pageTitle"),
  tabsBtn: $("tabsBtn"),
  tabsPanel: $("tabsPanel"),
  tabsList: $("tabsList"),
  tabsRefresh: $("tabsRefresh"),
  useTabs: $("useTabs"),
  messages: $("messages"),
  empty: $("empty"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  newChat: $("newChat"),
  openOptions: $("openOptions"),
  modebar: $("modebar"),
  quickbar: $("quickbar"),
  translateControls: $("translateControls"),
  improveControls: $("improveControls"),
  imageControls: $("imageControls"),
  translateLang: $("translateLang"),
  improveTone: $("improveTone"),
  imageSize: $("imageSize"),
  imageProviderNote: $("imageProviderNote"),
  confirmBar: $("confirmBar"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
};

let settings;
let history = [];
let abortController = null;
let currentPage = null; // { title, url, text, description }
let busy = false;
let mode = "chat"; // chat | translate | improve | image

const PLACEHOLDERS = {
  chat: "Écrivez un message…",
  translate: "Texte à traduire (ou laissez vide pour traduire la page)…",
  improve: "Texte à améliorer (ou laissez vide pour la sélection)…",
  image: "Décrivez l'image à générer…",
};

async function init() {
  configureMarkdown();
  settings = await getSettings();
  populateProviders();
  populateModels();
  els.thinking.checked = settings.thinking;
  els.webSearch.checked = settings.webSearch;
  els.agentMode.checked = settings.agentMode;
  els.pageCtx.checked = settings.includePageContext;
  els.useTabs.checked = settings.includeSelectedTabs;
  els.translateLang.value = settings.targetLang || "Français";
  els.improveTone.value = settings.improveTone || "Neutre et clair";
  els.imageSize.value = settings.imageSize || "1024x1024";
  syncToggleVisibility();
  updateImageNote();
  wire();
  setMode(settings.mode || "chat");
  setupPageAwareness();
  await refreshCurrentPage();
  await consumePendingAction();
}

// ----- Providers & models ---------------------------------------------------
function populateProviders() {
  els.provider.innerHTML = "";
  for (const id of PROVIDER_ORDER) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = PROVIDERS[id].label;
    els.provider.appendChild(o);
  }
  els.provider.value = settings.provider in PROVIDERS ? settings.provider : "anthropic";
}

function modelOptions(providerId) {
  // Catalogue defaults + any models fetched dynamically (settings.modelLists).
  const base = PROVIDERS[providerId].models.map((m) => m[0]);
  const fetched = (settings.modelLists && settings.modelLists[providerId]) || [];
  const seen = new Set();
  const out = [];
  for (const id of [...base, ...fetched]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const label = (PROVIDERS[providerId].models.find((m) => m[0] === id) || [])[1] || id;
    out.push([id, label]);
  }
  return out;
}

function populateModels() {
  const providerId = els.provider.value;
  const list = modelOptions(providerId);
  els.model.innerHTML = "";
  for (const [val, label] of list) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    els.model.appendChild(o);
  }
  const chosen = modelFor(providerId, settings);
  if (chosen && list.some((m) => m[0] === chosen)) els.model.value = chosen;
  else if (list.length) els.model.value = list[0][0];
}

function syncToggleVisibility() {
  const meta = PROVIDERS[els.provider.value] || {};
  els.webSearch.closest(".toggle").style.display = meta.supportsWebSearch ? "" : "none";
}

function updateImageNote() {
  const meta = PROVIDERS[settings.imageProvider || "openai"];
  els.imageProviderNote.textContent = meta ? `via ${meta.label}` : "";
}

async function refreshModelsFromApi() {
  const providerId = els.provider.value;
  els.refreshModels.classList.add("spin");
  try {
    const ids = await listModels(providerId, settings);
    settings.modelLists = settings.modelLists || {};
    settings.modelLists[providerId] = ids;
    await setSettings({ modelLists: settings.modelLists });
    populateModels();
  } catch (e) {
    addMessage("error", "Impossible de lister les modèles : " + (e.message || e));
  } finally {
    els.refreshModels.classList.remove("spin");
  }
}

// ----- Workspace modes ------------------------------------------------------
function setMode(next) {
  mode = next;
  settings.mode = next;
  setSettings({ mode: next });
  els.modebar.querySelectorAll(".mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === next)
  );
  els.quickbar.classList.toggle("hidden", next !== "chat");
  els.translateControls.classList.toggle("hidden", next !== "translate");
  els.improveControls.classList.toggle("hidden", next !== "improve");
  els.imageControls.classList.toggle("hidden", next !== "image");
  els.input.placeholder = PLACEHOLDERS[next] || PLACEHOLDERS.chat;
}

// ----- Page awareness (the "eyes") ------------------------------------------
function setupPageAwareness() {
  const onChange = () => debouncedRefresh();
  browser.tabs.onActivated.addListener(onChange);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab && tab.active && (changeInfo.status === "complete" || changeInfo.url)) onChange();
  });
  // SPA navigations + webmail "draft reply" requests come in as runtime messages.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "page_changed") onChange();
    else if (msg.type === "draft_reply") runQuickAction("reply", msg.thread || "");
  });
}

let refreshTimer = null;
function debouncedRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCurrentPage, 350);
}

async function refreshCurrentPage() {
  try {
    const page = await executeTool("read_page", {}, {});
    if (page && !page.error && page.url) {
      currentPage = page;
      els.pageTitle.textContent = page.title || page.url;
      els.pageBar.classList.toggle("hidden", !els.pageCtx.checked);
      return;
    }
  } catch (_) {}
  currentPage = null;
  els.pageBar.classList.add("hidden");
}

// ----- Multi-tab context picker ---------------------------------------------
async function buildTabsList() {
  const res = await executeTool("list_tabs", {}, {});
  els.tabsList.innerHTML = "";
  const selected = new Set(settings.selectedTabs || []);
  for (const t of (res && res.tabs) || []) {
    if (!t.url || /^about:/.test(t.url)) continue;
    const li = document.createElement("li");
    const lab = document.createElement("label");
    lab.className = "tabrow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(t.id);
    cb.dataset.tabId = String(t.id);
    const span = document.createElement("span");
    span.className = "tabtitle";
    span.textContent = t.title || t.url;
    span.title = t.url;
    lab.appendChild(cb);
    lab.appendChild(span);
    li.appendChild(lab);
    els.tabsList.appendChild(li);
  }
}

function collectSelectedTabIds() {
  const ids = [];
  els.tabsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    if (cb.checked) ids.push(parseInt(cb.dataset.tabId, 10));
  });
  return ids;
}

async function persistSelectedTabs() {
  settings.selectedTabs = collectSelectedTabIds();
  await setSettings({ selectedTabs: settings.selectedTabs });
}

// Read the user-selected tabs and turn them into a context block.
async function selectedTabsContext() {
  if (!els.useTabs.checked || !(settings.selectedTabs || []).length) return "";
  const parts = [];
  for (const tabId of settings.selectedTabs) {
    try {
      const p = await executeTool("read_tab", { tabId }, {});
      if (p && !p.error && p.text) {
        parts.push(
          `[Onglet] ${p.title || ""} (${p.url})\n` +
            p.text.slice(0, Math.floor(settings.maxPageChars / 2))
        );
      }
    } catch (_) {}
  }
  return parts.length ? `[Contexte multi-onglets]\n${parts.join("\n\n")}\n\n` : "";
}

// ----- Pending actions (context menus / webmail) ----------------------------
async function consumePendingAction() {
  const { pendingAction } = await browser.storage.local.get("pendingAction");
  if (!pendingAction || Date.now() - pendingAction.ts > 60000) return;
  await browser.storage.local.remove("pendingAction");
  runQuickAction(pendingAction.action, pendingAction.text);
}

// ----- Wiring ---------------------------------------------------------------
function wire() {
  els.provider.addEventListener("change", async () => {
    settings.provider = els.provider.value;
    await setSettings({ provider: settings.provider });
    populateModels();
    syncToggleVisibility();
    await persistModel();
  });
  els.model.addEventListener("change", persistModel);
  els.refreshModels.addEventListener("click", refreshModelsFromApi);

  const bindToggle = (el, key, after) =>
    el.addEventListener("change", async () => {
      settings[key] = el.checked;
      await setSettings({ [key]: el.checked });
      if (after) after();
    });
  bindToggle(els.thinking, "thinking");
  bindToggle(els.webSearch, "webSearch");
  bindToggle(els.agentMode, "agentMode");
  bindToggle(els.pageCtx, "includePageContext", () =>
    els.pageBar.classList.toggle("hidden", !(els.pageCtx.checked && currentPage))
  );
  bindToggle(els.useTabs, "includeSelectedTabs");

  // Mode tabs.
  els.modebar.querySelectorAll(".mode").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode))
  );

  // Mode control persistence.
  els.translateLang.addEventListener("change", async () => {
    settings.targetLang = els.translateLang.value;
    await setSettings({ targetLang: settings.targetLang });
  });
  els.improveTone.addEventListener("change", async () => {
    settings.improveTone = els.improveTone.value;
    await setSettings({ improveTone: settings.improveTone });
  });
  els.imageSize.addEventListener("change", async () => {
    settings.imageSize = els.imageSize.value;
    await setSettings({ imageSize: settings.imageSize });
  });

  // Tabs panel.
  els.tabsBtn.addEventListener("click", async () => {
    const willShow = els.tabsPanel.classList.contains("hidden");
    if (willShow) await buildTabsList();
    els.tabsPanel.classList.toggle("hidden");
  });
  els.tabsRefresh.addEventListener("click", buildTabsList);
  els.tabsList.addEventListener("change", persistSelectedTabs);

  els.send.addEventListener("click", onSend);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.stop.addEventListener("click", () => abortController && abortController.abort());
  els.newChat.addEventListener("click", resetConversation);
  els.openOptions.addEventListener("click", () => browser.runtime.openOptionsPage());
  const eo = $("emptyOptions");
  if (eo) eo.addEventListener("click", (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); });

  els.quickbar.querySelectorAll(".quick").forEach((b) =>
    b.addEventListener("click", () => runQuickAction(b.dataset.action))
  );

  // Keep the UI in sync if settings change elsewhere (the options page).
  onSettingsChanged(async () => {
    settings = await getSettings();
    updateImageNote();
  });
}

async function persistModel() {
  const providerId = els.provider.value;
  settings.models = settings.models || {};
  settings.models[providerId] = els.model.value;
  await setNested("models", providerId, els.model.value);
}

function resetConversation() {
  history = [];
  els.messages.querySelectorAll(".msg, .think").forEach((n) => n.remove());
  els.empty.classList.remove("hidden");
}

function addMessage(role, text) {
  els.empty.classList.add("hidden");
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text || "";
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addThinkBlock() {
  els.empty.classList.add("hidden");
  const d = document.createElement("details");
  d.className = "think";
  d.open = true;
  const s = document.createElement("summary");
  s.textContent = "💭 Réflexion";
  const body = document.createElement("div");
  body.className = "think-body";
  d.appendChild(s);
  d.appendChild(body);
  els.messages.appendChild(d);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

function currentKeyMissing() {
  const meta = PROVIDERS[els.provider.value];
  if (!meta.needsKey) return false;
  return !keyFor(els.provider.value, settings);
}

// Confirmation prompt for write actions. Blocked payment actions never reach
// here — they are refused in code (content.js) — but we still confirm normal
// state-changing actions.
function confirmAction(name, input) {
  return new Promise((resolve) => {
    els.confirmText.textContent = `Autoriser l'action « ${name} » ? ${JSON.stringify(input).slice(0, 120)}`;
    els.confirmBar.classList.remove("hidden");
    const cleanup = (v) => {
      els.confirmBar.classList.add("hidden");
      els.confirmAllow.removeEventListener("click", onAllow);
      els.confirmDeny.removeEventListener("click", onDeny);
      resolve(v);
    };
    const onAllow = () => cleanup(true);
    const onDeny = () => cleanup(false);
    els.confirmAllow.addEventListener("click", onAllow);
    els.confirmDeny.addEventListener("click", onDeny);
  });
}

function pageContextBlock() {
  if (!currentPage) return "";
  const ctx = (currentPage.text || "").slice(0, settings.maxPageChars);
  return (
    `[Contexte de la page active]\nTitre: ${currentPage.title}\nURL: ${currentPage.url}\n` +
    (currentPage.description ? `Description: ${currentPage.description}\n` : "") +
    `${ctx}\n\n`
  );
}

async function getSelection() {
  try {
    const sel = await executeTool("read_selection", {}, {});
    return (sel && sel.selection) || "";
  } catch (_) {
    return "";
  }
}

// ----- Core send ------------------------------------------------------------
// displayText: what the user sees; modelContent: what is sent to the model.
// `runMode` selects the system-prompt persona (chat/translate/improve).
async function sendToModel(displayText, modelContent, { forceWeb = false, runMode = "chat" } = {}) {
  if (busy) return;
  if (currentKeyMissing()) {
    addMessage("error", "Aucune clé API pour ce fournisseur. Ouvrez ⚙ Réglages.");
    return;
  }
  busy = true;
  addMessage("user", displayText);
  history.push({ role: "user", content: modelContent });

  const provider = makeProvider(
    { ...settings, provider: els.provider.value, models: { ...settings.models, [els.provider.value]: els.model.value } },
    { thinking: els.thinking.checked, webSearch: els.webSearch.checked || forceWeb }
  );
  const agentMode = els.agentMode.checked;
  const system = buildSystemPrompt({
    agentMode,
    targetLang: settings.targetLang,
    mode: runMode,
    blockPayments: settings.blockPayments,
  });
  const tools = activeTools({ agentMode });

  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();

  let assistantEl = null;
  let assistantRaw = "";
  let thinkBody = null;
  const finalizeAssistant = () => {
    if (assistantEl) {
      assistantEl.innerHTML = renderMarkdown(assistantRaw);
      enhanceArtifacts(assistantEl);
    }
    assistantEl = null;
    assistantRaw = "";
    thinkBody = null;
  };
  const onThink = (delta) => {
    if (!thinkBody) thinkBody = addThinkBlock();
    thinkBody.textContent += delta;
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const onText = (delta) => {
    if (!assistantEl) {
      assistantEl = addMessage("assistant", "");
      assistantRaw = "";
    }
    assistantRaw += delta;
    assistantEl.innerHTML = renderMarkdown(assistantRaw);
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const onToolStart = (call) => {
    finalizeAssistant();
    addMessage("tool", `→ ${call.name}(${JSON.stringify(call.input).slice(0, 100)})`);
  };
  const onToolEnd = (call, out) => {
    const blocked = out && out.blocked;
    addMessage("tool", blocked ? `   🛡 ${out.error}` : `   ${out && out.error ? "✗ " + out.error : "✓ ok"}`);
  };

  try {
    await runConversation({
      provider,
      system,
      history,
      tools,
      onText,
      onThink,
      onToolStart,
      onToolEnd,
      confirmActions: settings.confirmActions,
      confirmFn: agentMode ? confirmAction : null,
      guard: { blockPayments: settings.blockPayments },
      signal: abortController.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") addMessage("tool", "■ Interrompu.");
    else addMessage("error", "Erreur : " + (e && e.message ? e.message : String(e)));
  } finally {
    finalizeAssistant();
    els.send.classList.remove("hidden");
    els.stop.classList.add("hidden");
    abortController = null;
    busy = false;
  }
}

// ----- Send dispatch (per mode) ---------------------------------------------
async function onSend() {
  if (mode === "translate") return runTranslateFromInput();
  if (mode === "improve") return runImproveFromInput();
  if (mode === "image") return runImageFromInput();
  return onChatSend();
}

async function onChatSend() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  // In chat mode we inject the page (if the eye is on) and the selected tabs.
  // In agent mode the model reads pages itself through its tools.
  let prefix = "";
  if (!els.agentMode.checked) {
    if (els.pageCtx.checked && currentPage) prefix += pageContextBlock();
    prefix += await selectedTabsContext();
  }
  const content = prefix ? prefix + `[Message]\n${text}` : text;
  await sendToModel(text, content);
}

async function runTranslateFromInput() {
  const lang = els.translateLang.value || "Français";
  let txt = els.input.value.trim();
  let label = "🌐 Traduire";
  if (!txt) {
    txt = currentPage ? (currentPage.text || "").slice(0, settings.maxPageChars) : "";
    label = "🌐 Traduire la page";
  }
  if (!txt) return addMessage("error", "Rien à traduire (saisissez du texte ou ouvrez une page).");
  els.input.value = "";
  await sendToModel(label, `Traduis en ${lang}, en gardant la mise en forme :\n\n${txt}`, {
    runMode: "translate",
  });
}

async function runImproveFromInput() {
  const tone = els.improveTone.value || "Neutre et clair";
  let txt = els.input.value.trim();
  if (!txt) txt = await getSelection();
  if (!txt) return addMessage("error", "Saisissez ou sélectionnez du texte à améliorer.");
  els.input.value = "";
  await sendToModel(
    "✨ Améliorer (" + tone + ")",
    `Réécris ce texte avec un style « ${tone} » (clarté, grammaire), garde la langue d'origine, ` +
      `renvoie uniquement le texte réécrit :\n\n${txt}`,
    { runMode: "improve" }
  );
}

async function runImageFromInput() {
  const prompt = els.input.value.trim();
  if (!prompt) return addMessage("error", "Décrivez l'image à générer.");
  els.input.value = "";
  await runImage(prompt);
}

// ----- Quick actions (chat mode + context menus) ----------------------------
async function runQuickAction(action, providedText) {
  if (busy) return;
  const lang = settings.targetLang || "Français";

  if (action === "image") {
    const prompt = providedText || els.input.value.trim();
    if (!prompt) { setMode("image"); els.input.focus(); return; }
    els.input.value = "";
    return runImage(prompt);
  }

  if (action === "summarize") {
    if (!currentPage) await refreshCurrentPage();
    if (!currentPage) return addMessage("error", "Aucune page lisible à résumer.");
    return sendToModel(
      "📝 Résumer la page",
      pageContextBlock() +
        "[Tâche]\nRésume cette page en points clés (titre, idées principales, conclusion)."
    );
  }

  if (action === "summarize-selection") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Rien à résumer.");
    return sendToModel("📝 Résumer la sélection", "Résume en points clés :\n\n" + txt);
  }

  if (action === "translate") {
    let txt = providedText || (await getSelection());
    let label = "🌐 Traduire la sélection";
    if (!txt && currentPage) {
      txt = (currentPage.text || "").slice(0, settings.maxPageChars);
      label = "🌐 Traduire la page";
    }
    if (!txt) return addMessage("error", "Rien à traduire (sélectionne du texte ou ouvre une page).");
    return sendToModel(label, `Traduis en ${lang}, en gardant la mise en forme :\n\n${txt}`, {
      runMode: "translate",
    });
  }

  if (action === "improve") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Sélectionne d'abord du texte dans la page à améliorer.");
    return sendToModel(
      "✨ Améliorer le texte",
      "Améliore ce texte (clarté, style, grammaire), garde la langue d'origine, " +
        "et renvoie uniquement le texte réécrit :\n\n" + txt,
      { runMode: "improve" }
    );
  }

  if (action === "explain") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Rien à expliquer.");
    return sendToModel("💡 Expliquer", "Explique simplement et clairement :\n\n" + txt);
  }

  if (action === "reply") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Aucun message à qui répondre.");
    return sendToModel(
      "✉️ Brouillon de réponse",
      `Rédige une réponse polie et adaptée (en ${lang}) au message/email suivant. ` +
        `Propose un brouillon prêt à relire et envoyer (je vérifierai avant l'envoi) :\n\n${txt}`
    );
  }

  if (action === "research") {
    const q = els.input.value.trim() || providedText;
    if (!q) { els.input.value = "Recherche : "; els.input.focus(); return; }
    els.input.value = "";
    const meta = PROVIDERS[els.provider.value];
    const note = meta.supportsWebSearch
      ? ""
      : "\n(Astuce : la recherche web temps réel n'est dispo qu'avec Claude ; ici, réponse sur la base des connaissances du modèle.)";
    return sendToModel(
      "🔍 " + q,
      `Fais une recherche d'informations à jour et synthétise une réponse sourcée sur : ${q}${note}`,
      { forceWeb: true }
    );
  }
}

// ----- Image generation -----------------------------------------------------
async function runImage(prompt) {
  busy = true;
  addMessage("user", "🎨 " + prompt);
  const status = addMessage("tool", "Génération de l'image…");
  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();
  try {
    const urls = await generateImage(settings, {
      prompt,
      size: els.imageSize.value || settings.imageSize,
      signal: abortController.signal,
    });
    status.remove();
    const wrap = addMessage("assistant", "");
    for (const u of urls) {
      const img = document.createElement("img");
      img.src = u;
      img.alt = prompt;
      img.className = "gen-image";
      wrap.appendChild(img);
    }
  } catch (e) {
    status.remove();
    addMessage("error", "Image : " + (e && e.message ? e.message : String(e)));
  } finally {
    els.send.classList.remove("hidden");
    els.stop.classList.add("hidden");
    abortController = null;
    busy = false;
  }
}

init();
