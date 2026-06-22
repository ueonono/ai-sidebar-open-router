// Sidebar UI controller.
//
// Workspaces ("modes"): chat / translate / improve / image. A single unified model
// picker sits just above the composer and lists ONLY the models of connected
// providers (a key set, an OAuth account, or a running local server) — fetched
// live from each provider's /models endpoint so it reflects what is actually
// available. Comparison is done per-message (a "Comparer" button on the latest
// answer). Conversations are kept locally for privacy.

import { getSettings, setSettings, setNested, onSettingsChanged } from "../lib/storage.js";
import { makeProvider, listModels, generateImage } from "../lib/providers.js";
import { buildSystemPrompt, activeTools, runConversation } from "../lib/agent.js";
import { executeTool } from "../lib/tools.js";
import { configureMarkdown, renderMarkdown, enhanceArtifacts } from "../lib/markdown.js";
import { PROVIDERS, modelFor, keyFor, connectedProviders, WRITING_PRESETS } from "../lib/models.js";
import {
  listConversations, getConversation, saveConversation, deleteConversation,
  clearConversations, newConversationId, titleFrom,
} from "../lib/history.js";

const $ = (id) => document.getElementById(id);
const els = {
  modelSelect: $("modelSelect"),
  modelWrap: $("modelWrap"),
  modelConnect: $("modelConnect"),
  refreshModels: $("refreshModels"),
  historyBtn: $("historyBtn"),
  newChat: $("newChat"),
  openOptions: $("openOptions"),
  historyPanel: $("historyPanel"),
  historyList: $("historyList"),
  clearHistory: $("clearHistory"),
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
  modebar: $("modebar"),
  chatControls: $("chatControls"),
  translateControls: $("translateControls"),
  improveControls: $("improveControls"),
  imageControls: $("imageControls"),
  thinking: $("thinking"),
  webSearch: $("webSearch"),
  agentMode: $("agentMode"),
  pageCtx: $("pageCtx"),
  translateLang: $("translateLang"),
  improvePreset: $("improvePreset"),
  imageSize: $("imageSize"),
  imageProviderNote: $("imageProviderNote"),
  connectBtn: $("connectBtn"),
  confirmBar: $("confirmBar"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
};

let settings;
let history = [];        // provider-native message array (multi-turn continuation)
let transcript = [];     // UI transcript for local history
let convId = newConversationId();
let abortController = null;
let currentPage = null;
let busy = false;
let mode = "chat";
// Last primary turn (to re-run on another model for the "compare" button).
let lastUserContent = "";
let lastRunMode = "chat";
let lastForceWeb = false;

const PLACEHOLDERS = {
  chat: "Écrivez un message…",
  translate: "Texte à traduire (ou laissez vide pour la page)…",
  improve: "Texte à améliorer (ou laissez vide pour la sélection)…",
  image: "Décrivez l'image à générer…",
  terminal: "Demandez du code, une commande, un script…",
};

async function init() {
  configureMarkdown();
  settings = await getSettings();
  populateModelSelector();
  populateImprovePresets();
  els.thinking.checked = settings.thinking;
  els.webSearch.checked = settings.webSearch;
  els.agentMode.checked = settings.agentMode;
  els.pageCtx.checked = settings.includePageContext;
  els.useTabs.checked = settings.includeSelectedTabs;
  els.translateLang.value = settings.targetLang || "Français";
  els.improvePreset.value = settings.improvePreset || "improve";
  els.imageSize.value = settings.imageSize || "1024x1024";
  syncToggleVisibility();
  updateImageNote();
  wire();
  setMode(settings.mode || "chat");
  setupPageAwareness();
  autoListConnected();           // refresh available models in the background
  await refreshCurrentPage();
  await consumePendingAction();
}

// ----- Unified model picker -------------------------------------------------
// Only providers the user is actually connected to (key / account / local server).
// Nothing connected => the picker is hidden and a Connect button is shown instead.
function providersToShow() {
  return connectedProviders(settings);
}

// Models for a provider: the live-fetched list when we have one (authoritative —
// only what the key/account can access), otherwise the catalogue defaults.
function modelsOf(providerId) {
  const fetched = (settings.modelLists && settings.modelLists[providerId]) || [];
  const ids = fetched.length ? fetched : PROVIDERS[providerId].models.map((m) => m[0]);
  const labels = new Map(PROVIDERS[providerId].models);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([id, labels.get(id) || id]);
  }
  return out;
}

// Fill a <select> with optgroups of connected providers' models.
function fillModelSelect(sel, selectedValue) {
  sel.innerHTML = "";
  const ids = providersToShow();
  for (const pid of ids) {
    const group = document.createElement("optgroup");
    const noKey = !(keyFor(pid, settings) || PROVIDERS[pid].local);
    group.label = PROVIDERS[pid].label + (noKey ? " (clé manquante)" : "");
    for (const [mid, mlabel] of modelsOf(pid)) {
      const o = document.createElement("option");
      o.value = pid + "|" + mid;
      o.textContent = mlabel;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  if (selectedValue) sel.value = selectedValue;
}

function populateModelSelector() {
  const connected = connectedProviders(settings);
  const none = connected.length === 0;
  // First-run / nothing connected: no default models — show a Connect button.
  els.modelConnect.classList.toggle("hidden", !none);
  els.modelWrap.classList.toggle("hidden", none);
  els.refreshModels.classList.toggle("hidden", none);
  if (none) return;
  const pid = connected.includes(settings.provider) ? settings.provider : connected[0];
  fillModelSelect(els.modelSelect, pid + "|" + modelFor(pid, settings));
}

function parseSel(value) {
  const i = (value || "").indexOf("|");
  if (i < 0) return { providerId: settings.provider, modelId: modelFor(settings.provider, settings) };
  return { providerId: value.slice(0, i), modelId: value.slice(i + 1) };
}
function currentSelection() {
  return parseSel(els.modelSelect.value);
}

function syncToggleVisibility() {
  const meta = PROVIDERS[currentSelection().providerId] || {};
  els.webSearch.closest(".switch").style.display = meta.supportsWebSearch ? "" : "none";
}
function updateImageNote() {
  const meta = PROVIDERS[settings.imageProvider || "openai"];
  els.imageProviderNote.textContent = meta ? "via " + meta.label : "";
}
function populateImprovePresets() {
  els.improvePreset.innerHTML = "";
  for (const [id, label] of WRITING_PRESETS) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    els.improvePreset.appendChild(o);
  }
}

async function onModelChange() {
  const sel = currentSelection();
  settings.provider = sel.providerId;
  settings.models = settings.models || {};
  settings.models[sel.providerId] = sel.modelId;
  await setSettings({ provider: sel.providerId });
  await setNested("models", sel.providerId, sel.modelId);
  syncToggleVisibility();
}

// Best-effort: fetch the real available model list for every connected provider.
async function autoListConnected() {
  const ids = connectedProviders(settings);
  if (!ids.length) return;
  settings.modelLists = settings.modelLists || {};
  await Promise.allSettled(
    ids.map(async (pid) => {
      try {
        const list = await listModels(pid, settings);
        if (list && list.length) settings.modelLists[pid] = list;
      } catch (_) {}
    })
  );
  await setSettings({ modelLists: settings.modelLists });
  populateModelSelector();
}

async function refreshModelsFromApi() {
  els.refreshModels.classList.add("spin");
  try {
    await autoListConnected();
  } finally {
    els.refreshModels.classList.remove("spin");
  }
}

// ----- Workspace modes ------------------------------------------------------
function setMode(next) {
  mode = next;
  settings.mode = next;
  setSettings({ mode: next });
  els.modebar.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === next));
  // Chat-style toggles are also useful in the terminal/dev mode.
  els.chatControls.classList.toggle("hidden", !(next === "chat" || next === "terminal"));
  els.translateControls.classList.toggle("hidden", next !== "translate");
  els.improveControls.classList.toggle("hidden", next !== "improve");
  els.imageControls.classList.toggle("hidden", next !== "image");
  document.body.classList.toggle("mode-terminal", next === "terminal");
  els.input.placeholder = PLACEHOLDERS[next] || PLACEHOLDERS.chat;
}

// ----- Page awareness -------------------------------------------------------
function setupPageAwareness() {
  const onChange = () => debouncedRefresh();
  browser.tabs.onActivated.addListener(onChange);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab && tab.active && (changeInfo.status === "complete" || changeInfo.url)) onChange();
  });
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

// ----- Multi-tab context ----------------------------------------------------
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
async function persistSelectedTabs() {
  const ids = [];
  els.tabsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    if (cb.checked) ids.push(parseInt(cb.dataset.tabId, 10));
  });
  settings.selectedTabs = ids;
  await setSettings({ selectedTabs: ids });
}
async function selectedTabsContext() {
  if (!els.useTabs.checked || !(settings.selectedTabs || []).length) return "";
  const parts = [];
  for (const tabId of settings.selectedTabs) {
    try {
      const p = await executeTool("read_tab", { tabId }, {});
      if (p && !p.error && p.text) {
        parts.push(`[Onglet] ${p.title || ""} (${p.url})\n` + p.text.slice(0, Math.floor(settings.maxPageChars / 2)));
      }
    } catch (_) {}
  }
  return parts.length ? `[Contexte multi-onglets]\n${parts.join("\n\n")}\n\n` : "";
}

// ----- Local history --------------------------------------------------------
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return Math.floor(s / 3600) + " h";
  return Math.floor(s / 86400) + " j";
}
async function renderHistoryList() {
  const list = await listConversations();
  els.historyList.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Aucune conversation enregistrée.";
    els.historyList.appendChild(li);
    return;
  }
  for (const c of list) {
    const li = document.createElement("li");
    li.className = "histrow";
    const title = document.createElement("span");
    title.className = "htitle";
    title.textContent = c.title || "Conversation";
    const meta = document.createElement("span");
    meta.className = "hmeta";
    meta.textContent = timeAgo(c.updatedAt || Date.now());
    const del = document.createElement("button");
    del.className = "hdel";
    del.textContent = "✕";
    del.title = "Supprimer";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteConversation(c.id);
      renderHistoryList();
    });
    li.addEventListener("click", () => loadConversation(c.id));
    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(del);
    els.historyList.appendChild(li);
  }
}
async function saveCurrent() {
  if (!settings.saveHistory || !transcript.length) return;
  const sel = currentSelection();
  await saveConversation({
    id: convId, title: titleFrom(transcript), updatedAt: Date.now(),
    providerId: sel.providerId, model: sel.modelId, transcript, nativeHistory: history,
  });
}
function renderTranscriptItem(item) {
  if (item.role === "user") {
    addMessage("user", item.text);
  } else if (item.kind === "image") {
    const wrap = addMessage("assistant", "");
    for (const u of item.urls || []) {
      const img = document.createElement("img");
      img.src = u; img.className = "gen-image"; wrap.appendChild(img);
    }
  } else {
    const el = addMessage("assistant", "");
    el.innerHTML = renderMarkdown(item.text || "");
    enhanceArtifacts(el);
  }
}
async function loadConversation(id) {
  const c = await getConversation(id);
  if (!c) return;
  clearMessages();
  transcript = c.transcript || [];
  history = c.nativeHistory || [];
  convId = c.id;
  for (const item of transcript) renderTranscriptItem(item);
  els.empty.classList.add("hidden");
  els.historyPanel.classList.add("hidden");
}
function clearMessages() {
  els.messages.querySelectorAll(".msg, .think").forEach((n) => n.remove());
}
async function newChat() {
  await saveCurrent();
  history = [];
  transcript = [];
  convId = newConversationId();
  lastUserContent = "";
  clearMessages();
  els.empty.classList.remove("hidden");
}

// ----- Pending actions ------------------------------------------------------
async function consumePendingAction() {
  const { pendingAction } = await browser.storage.local.get("pendingAction");
  if (!pendingAction || Date.now() - pendingAction.ts > 60000) return;
  await browser.storage.local.remove("pendingAction");
  runQuickAction(pendingAction.action, pendingAction.text);
}

// ----- Wiring ---------------------------------------------------------------
function wire() {
  els.modelSelect.addEventListener("change", onModelChange);
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

  els.modebar.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  els.translateLang.addEventListener("change", async () => {
    settings.targetLang = els.translateLang.value;
    await setSettings({ targetLang: settings.targetLang });
  });
  els.improvePreset.addEventListener("change", async () => {
    settings.improvePreset = els.improvePreset.value;
    await setSettings({ improvePreset: settings.improvePreset });
  });
  els.imageSize.addEventListener("change", async () => {
    settings.imageSize = els.imageSize.value;
    await setSettings({ imageSize: settings.imageSize });
  });

  els.historyBtn.addEventListener("click", async () => {
    const show = els.historyPanel.classList.contains("hidden");
    if (show) await renderHistoryList();
    els.historyPanel.classList.toggle("hidden");
  });
  els.clearHistory.addEventListener("click", async () => {
    await clearConversations();
    renderHistoryList();
  });

  els.tabsBtn.addEventListener("click", async () => {
    const show = els.tabsPanel.classList.contains("hidden");
    if (show) await buildTabsList();
    els.tabsPanel.classList.toggle("hidden");
  });
  els.tabsRefresh.addEventListener("click", buildTabsList);
  els.tabsList.addEventListener("change", persistSelectedTabs);

  els.send.addEventListener("click", onSend);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.input.addEventListener("input", autoGrow);
  els.stop.addEventListener("click", () => abortController && abortController.abort());
  els.newChat.addEventListener("click", newChat);
  els.openOptions.addEventListener("click", () => browser.runtime.openOptionsPage());
  els.connectBtn.addEventListener("click", () => browser.runtime.openOptionsPage());
  els.modelConnect.addEventListener("click", () => browser.runtime.openOptionsPage());

  onSettingsChanged(async () => {
    settings = await getSettings();
    updateImageNote();
    populateModelSelector();
    autoListConnected();
  });
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 150) + "px";
}
function resetComposerHeight() { els.input.style.height = "auto"; }

// ----- Message rendering ----------------------------------------------------
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

// Streaming sink: owns one assistant card (+ optional model badge) and its
// thinking block. Used for a normal turn and for each compare run.
function makeSink(badgeLabel) {
  let el = null, contentEl = null, raw = "", think = null;
  const ensure = () => {
    if (el) return;
    el = addMessage("assistant", "");
    if (badgeLabel) {
      const b = document.createElement("div");
      b.className = "model-badge";
      b.textContent = badgeLabel;
      el.appendChild(b);
    }
    contentEl = document.createElement("div");
    el.appendChild(contentEl);
  };
  return {
    onText(delta) {
      ensure();
      raw += delta;
      contentEl.innerHTML = renderMarkdown(raw);
      els.messages.scrollTop = els.messages.scrollHeight;
    },
    onThink(delta) {
      if (!think) think = addThinkBlock();
      think.textContent += delta;
      els.messages.scrollTop = els.messages.scrollHeight;
    },
    finalize() {
      if (contentEl) { contentEl.innerHTML = renderMarkdown(raw); enhanceArtifacts(contentEl); }
    },
    getRaw: () => raw,
    getEl: () => el,
  };
}

function currentKeyMissing(providerId) {
  const meta = PROVIDERS[providerId];
  if (!meta || !meta.needsKey) return false;
  return !keyFor(providerId, settings);
}
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
    (currentPage.description ? `Description: ${currentPage.description}\n` : "") + `${ctx}\n\n`
  );
}
async function getSelection() {
  try {
    const sel = await executeTool("read_selection", {}, {});
    return (sel && sel.selection) || "";
  } catch (_) { return ""; }
}
function startBusy() {
  busy = true;
  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();
}
function endBusy() {
  els.send.classList.remove("hidden");
  els.stop.classList.add("hidden");
  abortController = null;
  busy = false;
}

// ----- Per-message comparison ----------------------------------------------
// Add a "compare with another model" bar under the latest assistant answer.
function attachCompareBar(el) {
  els.messages.querySelectorAll(".msg-actions").forEach((n) => n.remove());
  if (!el || !lastUserContent) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const lbl = document.createElement("span");
  lbl.className = "cmp-lbl";
  lbl.textContent = "⚖ Comparer avec";
  const sel = document.createElement("select");
  sel.className = "cmp-select";
  fillModelSelect(sel, null);
  // Default to a model different from the current one.
  for (const opt of sel.options) {
    if (opt.value && opt.value !== els.modelSelect.value) { sel.value = opt.value; break; }
  }
  const btn = document.createElement("button");
  btn.className = "cmp-btn";
  btn.textContent = "Comparer";
  btn.addEventListener("click", () => compareLast(parseSel(sel.value), btn));
  bar.appendChild(lbl);
  bar.appendChild(sel);
  bar.appendChild(btn);
  el.appendChild(bar);
}

async function compareLast(second, btn) {
  if (busy || !lastUserContent) return;
  if (currentKeyMissing(second.providerId)) {
    addMessage("error", "Clé manquante pour " + PROVIDERS[second.providerId].label + ".");
    return;
  }
  btn.disabled = true;
  startBusy();
  const badge = `${PROVIDERS[second.providerId].label} · ${second.modelId}`;
  try {
    const provider = makeProvider(
      { ...settings, provider: second.providerId, models: { ...settings.models, [second.providerId]: second.modelId } },
      { thinking: els.thinking.checked, webSearch: els.webSearch.checked || lastForceWeb }
    );
    const system = buildSystemPrompt({ agentMode: false, targetLang: settings.targetLang, mode: lastRunMode, blockPayments: settings.blockPayments });
    const sink = makeSink(badge);
    await runConversation({ provider, system, history: [{ role: "user", content: lastUserContent }], tools: [], onText: sink.onText, onThink: sink.onThink, signal: abortController.signal });
    sink.finalize();
    if (sink.getRaw()) transcript.push({ role: "assistant", text: `**${badge}**\n\n${sink.getRaw()}` });
    attachCompareBar(sink.getEl()); // allow comparing again with yet another model
  } catch (e) {
    if (e && e.name === "AbortError") addMessage("tool", "■ Interrompu.");
    else addMessage("error", "Erreur : " + (e && e.message ? e.message : String(e)));
  } finally {
    endBusy();
    btn.disabled = false;
    await saveCurrent();
  }
}

// ----- Core send ------------------------------------------------------------
async function sendToModel(displayText, modelContent, { forceWeb = false, runMode = "chat" } = {}) {
  if (busy) return;
  const sel = currentSelection();
  if (currentKeyMissing(sel.providerId)) {
    addMessage("error", "Aucune clé pour ce modèle. Cliquez « Connexion / Ajouter un fournisseur » (⚙).");
    return;
  }
  addMessage("user", displayText);
  transcript.push({ role: "user", text: displayText });
  lastUserContent = modelContent;
  lastRunMode = runMode;
  lastForceWeb = forceWeb;
  startBusy();

  history.push({ role: "user", content: modelContent });
  const provider = makeProvider(
    { ...settings, provider: sel.providerId, models: { ...settings.models, [sel.providerId]: sel.modelId } },
    { thinking: els.thinking.checked, webSearch: els.webSearch.checked || forceWeb }
  );
  const agentMode = els.agentMode.checked;
  const system = buildSystemPrompt({ agentMode, targetLang: settings.targetLang, mode: runMode, blockPayments: settings.blockPayments });
  const tools = activeTools({ agentMode });
  const sink = makeSink(null);
  try {
    await runConversation({
      provider, system, history, tools,
      onText: sink.onText, onThink: sink.onThink,
      onToolStart: (call) => { sink.finalize(); addMessage("tool", `→ ${call.name}(${JSON.stringify(call.input).slice(0, 80)})`); },
      onToolEnd: (call, out) => addMessage("tool", out && out.blocked ? `   🛡 ${out.error}` : `   ${out && out.error ? "✗ " + out.error : "✓ ok"}`),
      confirmActions: settings.confirmActions,
      confirmFn: agentMode ? confirmAction : null,
      guard: { blockPayments: settings.blockPayments },
      signal: abortController.signal,
    });
    sink.finalize();
    if (sink.getRaw()) {
      transcript.push({ role: "assistant", text: sink.getRaw() });
      attachCompareBar(sink.getEl());
    }
  } catch (e) {
    if (e && e.name === "AbortError") addMessage("tool", "■ Interrompu.");
    else addMessage("error", "Erreur : " + (e && e.message ? e.message : String(e)));
  } finally {
    endBusy();
    await saveCurrent();
  }
}

// ----- Send dispatch (per mode) ---------------------------------------------
async function onSend() {
  resetComposerHeight();
  if (mode === "translate") return runTranslateFromInput();
  if (mode === "improve") return runImproveFromInput();
  if (mode === "image") return runImageFromInput();
  if (mode === "terminal") return onTerminalSend();
  return onChatSend();
}

// Terminal/dev mode: send the raw prompt with the dev persona, no page injection.
async function onTerminalSend() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  await sendToModel(text, text, { runMode: "terminal" });
}
async function onChatSend() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
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
  if (!txt) { txt = currentPage ? (currentPage.text || "").slice(0, settings.maxPageChars) : ""; label = "🌐 Traduire la page"; }
  if (!txt) return addMessage("error", "Rien à traduire (saisissez du texte ou ouvrez une page).");
  els.input.value = "";
  await sendToModel(label, `Traduis en ${lang}, en gardant la mise en forme :\n\n${txt}`, { runMode: "translate" });
}
async function runImproveFromInput() {
  const presetId = els.improvePreset.value || "improve";
  const preset = WRITING_PRESETS.find((p) => p[0] === presetId) || WRITING_PRESETS[0];
  let txt = els.input.value.trim();
  if (!txt) txt = await getSelection();
  if (!txt) return addMessage("error", "Saisissez ou sélectionnez du texte.");
  els.input.value = "";
  await sendToModel("✨ " + preset[1], `${preset[2]}\nRenvoie uniquement le résultat, sans préambule.\n\nTexte :\n${txt}`, { runMode: "improve" });
}
async function runImageFromInput() {
  const prompt = els.input.value.trim();
  if (!prompt) return addMessage("error", "Décrivez l'image à générer.");
  els.input.value = "";
  await runImage(prompt);
}

// ----- Quick actions / context menus ----------------------------------------
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
    return sendToModel("📝 Résumer la page", pageContextBlock() + "[Tâche]\nRésume cette page en points clés (titre, idées principales, conclusion).");
  }
  if (action === "summarize-selection") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Rien à résumer.");
    return sendToModel("📝 Résumer la sélection", "Résume en points clés :\n\n" + txt);
  }
  if (action === "translate") {
    let txt = providedText || (await getSelection());
    let label = "🌐 Traduire la sélection";
    if (!txt && currentPage) { txt = (currentPage.text || "").slice(0, settings.maxPageChars); label = "🌐 Traduire la page"; }
    if (!txt) return addMessage("error", "Rien à traduire.");
    return sendToModel(label, `Traduis en ${lang}, en gardant la mise en forme :\n\n${txt}`, { runMode: "translate" });
  }
  if (action === "improve") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Sélectionne d'abord du texte à améliorer.");
    return sendToModel("✨ Améliorer le texte", "Améliore ce texte (clarté, style, grammaire), garde la langue d'origine, renvoie uniquement le texte réécrit :\n\n" + txt, { runMode: "improve" });
  }
  if (action === "explain") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Rien à expliquer.");
    return sendToModel("💡 Expliquer", "Explique simplement et clairement :\n\n" + txt);
  }
  if (action === "reply") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Aucun message à qui répondre.");
    return sendToModel("✉️ Brouillon de réponse", `Rédige une réponse polie et adaptée (en ${lang}) au message/email suivant. Propose un brouillon prêt à relire et envoyer (je vérifierai avant l'envoi) :\n\n${txt}`);
  }
}

// ----- Image generation -----------------------------------------------------
async function runImage(prompt) {
  if (currentKeyMissing(settings.imageProvider || "openai")) {
    return addMessage("error", `Clé manquante pour la génération d'images (${PROVIDERS[settings.imageProvider || "openai"].label}).`);
  }
  addMessage("user", "🎨 " + prompt);
  transcript.push({ role: "user", text: "🎨 " + prompt });
  const status = addMessage("tool", "Génération de l'image…");
  startBusy();
  try {
    const urls = await generateImage(settings, { prompt, size: els.imageSize.value || settings.imageSize, signal: abortController.signal });
    status.remove();
    const wrap = addMessage("assistant", "");
    for (const u of urls) {
      const img = document.createElement("img");
      img.src = u; img.alt = prompt; img.className = "gen-image";
      wrap.appendChild(img);
    }
    transcript.push({ role: "assistant", kind: "image", urls });
  } catch (e) {
    status.remove();
    addMessage("error", "Image : " + (e && e.message ? e.message : String(e)));
  } finally {
    endBusy();
    await saveCurrent();
  }
}

init();
