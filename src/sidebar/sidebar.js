// Sidebar UI controller.
//
// Workspaces ("modes"): chat / translate / improve / image. A single unified model
// picker (grouped by connected provider) sits above the chat. Extra capabilities:
// model comparison (run the prompt on a second model side by side), Claude-style
// artifacts (handled in markdown.js), and local-only conversation history.

import { getSettings, setSettings, setNested, onSettingsChanged } from "../lib/storage.js";
import { makeProvider, listModels, generateImage } from "../lib/providers.js";
import { buildSystemPrompt, activeTools, runConversation } from "../lib/agent.js";
import { executeTool } from "../lib/tools.js";
import { configureMarkdown, renderMarkdown, enhanceArtifacts } from "../lib/markdown.js";
import {
  PROVIDERS, modelFor, keyFor, connectedProviders, WRITING_PRESETS,
} from "../lib/models.js";
import { connectOpenRouter } from "../lib/auth.js";
import {
  listConversations, getConversation, saveConversation, deleteConversation,
  clearConversations, newConversationId, titleFrom,
} from "../lib/history.js";

const $ = (id) => document.getElementById(id);
const els = {
  modelSelect: $("modelSelect"),
  refreshModels: $("refreshModels"),
  compareMode: $("compareMode"),
  compareRow: $("compareRow"),
  compareSelect: $("compareSelect"),
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
  connectOpenRouter: $("connectOpenRouter"),
  emptyOptions: $("emptyOptions"),
  confirmBar: $("confirmBar"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
};

let settings;
let history = [];        // provider-native message array (for multi-turn continuation)
let transcript = [];     // UI transcript for local history { role, text, kind?, urls? }
let convId = newConversationId();
let abortController = null;
let currentPage = null;
let busy = false;
let mode = "chat";

const PLACEHOLDERS = {
  chat: "Écrivez un message…",
  translate: "Texte à traduire (ou laissez vide pour la page)…",
  improve: "Texte à améliorer (ou laissez vide pour la sélection)…",
  image: "Décrivez l'image à générer…",
};

async function init() {
  configureMarkdown();
  settings = await getSettings();
  populateModelSelectors();
  populateImprovePresets();
  els.thinking.checked = settings.thinking;
  els.webSearch.checked = settings.webSearch;
  els.agentMode.checked = settings.agentMode;
  els.pageCtx.checked = settings.includePageContext;
  els.useTabs.checked = settings.includeSelectedTabs;
  els.compareMode.checked = settings.compareMode;
  els.compareRow.classList.toggle("hidden", !settings.compareMode);
  els.translateLang.value = settings.targetLang || "Français";
  els.improvePreset.value = settings.improvePreset || "improve";
  els.imageSize.value = settings.imageSize || "1024x1024";
  syncToggleVisibility();
  updateImageNote();
  wire();
  setMode(settings.mode || "chat");
  setupPageAwareness();
  await refreshCurrentPage();
  await consumePendingAction();
}

// ----- Unified model picker -------------------------------------------------
// Build the list of providers to show: connected ones first, plus the currently
// selected provider so there is always a valid choice.
function providersToShow() {
  const set = [];
  for (const id of connectedProviders(settings)) set.push(id);
  if (!set.includes(settings.provider)) set.unshift(settings.provider);
  return set;
}

function modelsOf(providerId) {
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

function fillSelect(sel, selectedValue) {
  sel.innerHTML = "";
  const ids = providersToShow();
  if (!ids.length) {
    const o = document.createElement("option");
    o.textContent = "Aucun modèle — connectez-vous";
    sel.appendChild(o);
    return;
  }
  for (const pid of ids) {
    const group = document.createElement("optgroup");
    group.label = PROVIDERS[pid].label + (keyFor(pid, settings) || PROVIDERS[pid].local ? "" : " (clé manquante)");
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

function populateModelSelectors() {
  const primary = settings.provider + "|" + modelFor(settings.provider, settings);
  fillSelect(els.modelSelect, primary);
  fillSelect(els.compareSelect, settings.compareModel || pickDifferent(primary));
}

// Default second model = first option different from the primary one.
function pickDifferent(primaryValue) {
  for (const opt of els.compareSelect.options) {
    if (opt.value && opt.value !== primaryValue) return opt.value;
  }
  return primaryValue;
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

async function onPrimaryModelChange() {
  const sel = currentSelection();
  settings.provider = sel.providerId;
  settings.models = settings.models || {};
  settings.models[sel.providerId] = sel.modelId;
  await setSettings({ provider: sel.providerId });
  await setNested("models", sel.providerId, sel.modelId);
  syncToggleVisibility();
}

async function refreshModelsFromApi() {
  const { providerId } = currentSelection();
  els.refreshModels.classList.add("spin");
  try {
    const ids = await listModels(providerId, settings);
    settings.modelLists = settings.modelLists || {};
    settings.modelLists[providerId] = ids;
    await setSettings({ modelLists: settings.modelLists });
    populateModelSelectors();
  } catch (e) {
    addMessage("error", "Impossible de lister les modèles : " + (e.message || e));
  } finally {
    els.refreshModels.classList.remove("spin");
  }
}

// ----- OAuth connect --------------------------------------------------------
async function doConnectOpenRouter() {
  els.connectOpenRouter.disabled = true;
  els.connectOpenRouter.textContent = "Connexion…";
  try {
    const key = await connectOpenRouter();
    settings.keys = settings.keys || {};
    settings.keys.openrouter = key;
    await setNested("keys", "openrouter", key);
    settings.provider = "openrouter";
    await setSettings({ provider: "openrouter" });
    populateModelSelectors();
    syncToggleVisibility();
    addMessage("tool", "✓ Connecté à OpenRouter — tous les modèles sont disponibles.");
  } catch (e) {
    addMessage("error", "Connexion OpenRouter : " + (e && e.message ? e.message : e));
  } finally {
    els.connectOpenRouter.disabled = false;
    els.connectOpenRouter.textContent = "Se connecter avec OpenRouter";
  }
}

// ----- Workspace modes ------------------------------------------------------
function setMode(next) {
  mode = next;
  settings.mode = next;
  setSettings({ mode: next });
  els.modebar.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === next));
  els.chatControls.classList.toggle("hidden", next !== "chat");
  els.translateControls.classList.toggle("hidden", next !== "translate");
  els.improveControls.classList.toggle("hidden", next !== "improve");
  els.imageControls.classList.toggle("hidden", next !== "image");
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
    id: convId,
    title: titleFrom(transcript),
    updatedAt: Date.now(),
    providerId: sel.providerId,
    model: sel.modelId,
    transcript,
    nativeHistory: history,
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
  els.modelSelect.addEventListener("change", onPrimaryModelChange);
  els.refreshModels.addEventListener("click", refreshModelsFromApi);
  els.compareSelect.addEventListener("change", async () => {
    settings.compareModel = els.compareSelect.value;
    await setSettings({ compareModel: settings.compareModel });
  });

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
  bindToggle(els.compareMode, "compareMode", () => {
    els.compareRow.classList.toggle("hidden", !els.compareMode.checked);
    if (els.compareMode.checked && !settings.compareModel) {
      settings.compareModel = pickDifferent(els.modelSelect.value);
      els.compareSelect.value = settings.compareModel;
      setSettings({ compareModel: settings.compareModel });
    }
  });

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
  els.emptyOptions.addEventListener("click", (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); });
  els.connectOpenRouter.addEventListener("click", doConnectOpenRouter);

  onSettingsChanged(async () => {
    settings = await getSettings();
    updateImageNote();
  });
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 150) + "px";
}

function resetComposerHeight() {
  els.input.style.height = "auto";
}

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

// A streaming sink: owns one assistant card (with optional model badge) and its
// thinking block. Used once for a normal turn, twice for a comparison.
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

// ----- Core send ------------------------------------------------------------
async function sendToModel(displayText, modelContent, { forceWeb = false, runMode = "chat" } = {}) {
  if (busy) return;
  const sel = currentSelection();
  if (currentKeyMissing(sel.providerId)) {
    addMessage("error", "Aucune clé pour ce modèle. Connectez-vous (OpenRouter) ou ajoutez une clé dans ⚙ Réglages.");
    return;
  }
  addMessage("user", displayText);
  transcript.push({ role: "user", text: displayText });
  startBusy();

  try {
    if (els.compareMode.checked) {
      await runComparison(sel, modelContent, runMode, forceWeb);
    } else {
      await runNormalTurn(sel, modelContent, runMode, forceWeb);
    }
  } catch (e) {
    if (e && e.name === "AbortError") addMessage("tool", "■ Interrompu.");
    else addMessage("error", "Erreur : " + (e && e.message ? e.message : String(e)));
  } finally {
    endBusy();
    await saveCurrent();
  }
}

// Normal multi-turn path (with agent tools + thinking).
async function runNormalTurn(sel, modelContent, runMode, forceWeb) {
  history.push({ role: "user", content: modelContent });
  const provider = makeProvider(
    { ...settings, provider: sel.providerId, models: { ...settings.models, [sel.providerId]: sel.modelId } },
    { thinking: els.thinking.checked, webSearch: els.webSearch.checked || forceWeb }
  );
  const agentMode = els.agentMode.checked;
  const system = buildSystemPrompt({ agentMode, targetLang: settings.targetLang, mode: runMode, blockPayments: settings.blockPayments });
  const tools = activeTools({ agentMode });
  const sink = makeSink(null);
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
  if (sink.getRaw()) transcript.push({ role: "assistant", text: sink.getRaw() });
}

// Comparison path: same prompt to two models (single turn, no tools), side by side.
async function runComparison(sel, modelContent, runMode, forceWeb) {
  const second = parseSel(els.compareSelect.value);
  const run = async (s) => {
    if (currentKeyMissing(s.providerId)) {
      addMessage("error", `Clé manquante pour ${PROVIDERS[s.providerId].label}.`);
      return "";
    }
    const provider = makeProvider(
      { ...settings, provider: s.providerId, models: { ...settings.models, [s.providerId]: s.modelId } },
      { thinking: els.thinking.checked, webSearch: els.webSearch.checked || forceWeb }
    );
    const system = buildSystemPrompt({ agentMode: false, targetLang: settings.targetLang, mode: runMode, blockPayments: settings.blockPayments });
    const sink = makeSink(`${PROVIDERS[s.providerId].label} · ${s.modelId}`);
    const h = [{ role: "user", content: modelContent }];
    await runConversation({ provider, system, history: h, tools: [], onText: sink.onText, onThink: sink.onThink, signal: abortController.signal });
    sink.finalize();
    return sink.getRaw();
  };
  const [a, b] = await Promise.all([run(sel), run(second)]);
  // Comparison is single-turn: don't extend the continuing history (formats differ).
  const merged = [a && `**${PROVIDERS[sel.providerId].label}**\n\n${a}`, b && `**${PROVIDERS[second.providerId].label}**\n\n${b}`].filter(Boolean).join("\n\n---\n\n");
  if (merged) transcript.push({ role: "assistant", text: merged });
}

// ----- Send dispatch (per mode) ---------------------------------------------
async function onSend() {
  resetComposerHeight();
  if (mode === "translate") return runTranslateFromInput();
  if (mode === "improve") return runImproveFromInput();
  if (mode === "image") return runImageFromInput();
  return onChatSend();
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
  await sendToModel(
    "✨ " + preset[1],
    `${preset[2]}\nRenvoie uniquement le résultat, sans préambule.\n\nTexte :\n${txt}`,
    { runMode: "improve" }
  );
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
