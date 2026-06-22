// Local settings storage (BYOK — "bring your own key").
//
// PRIVACY MODEL: nothing ever leaves the browser except a request to the AI
// endpoint the user explicitly chose. We use `browser.storage.local`, which is
// scoped to this device and is NEVER synced to any account or server. There is
// no analytics, no telemetry and no remote configuration: the extension talks
// only to the provider URLs listed in the manifest's host permissions.
//
// The project ships 100% blank: every key is empty by default. Users supply
// their own credentials (or point at a local model that needs none).

const DEFAULTS = {
  // ----- Provider / model selection ----------------------------------------
  provider: "anthropic", // active provider id (see PROVIDERS in models.js)
  keys: {}, // per-provider API keys      { anthropic:"", openai:"", ... }
  models: {}, // per-provider chosen model  { anthropic:"claude-opus-4-8", ... }
  baseUrls: {}, // per-provider base URL overrides (ollama / lmstudio / custom)

  // ----- Image generation ---------------------------------------------------
  imageProvider: "openai",
  imageModel: "gpt-image-1",
  imageSize: "1024x1024",

  // ----- UI / behaviour ------------------------------------------------------
  mode: "chat", // active workspace tab: chat | translate | improve | image
  thinking: false, // surface the model's reasoning (supported models only)
  webSearch: false, // server-side web search (Anthropic)
  agentMode: false, // allow the model to act inside the browser
  confirmActions: true, // ask before every state-changing action
  includePageContext: true, // feed the active page into the chat
  autoReadPage: true, // re-read the page on every navigation (subdomains too)
  includeSelectedTabs: false, // also feed the user-selected extra tabs
  selectedTabs: [], // tab ids the user ticked for multi-tab context
  maxPageChars: 12000, // truncation budget for a single page's text
  targetLang: "Français", // preferred target language for translations
  improvePreset: "improve", // default writing preset for the "improve" mode

  // ----- Compare & history ---------------------------------------------------
  compareMode: false, // run the prompt on a second model side-by-side
  compareModel: "", // "providerId|modelId" of the second model
  saveHistory: true, // persist conversations locally (privacy: local only)

  // ----- Safety guardrails ---------------------------------------------------
  // The agent can browse autonomously but must never transact. When enabled it
  // refuses payment / checkout / purchase / order-confirmation actions and stops
  // at the cart, as requested. This is enforced both in the system prompt AND in
  // code (tools.js) so a jailbroken prompt cannot bypass it.
  blockPayments: true,
  // Webmail compose helper: inject an "AI reply" button on known webmail sites.
  // The button only DRAFTS a reply for the user to review — it never auto-sends.
  webmailAssist: true,
};

// Migrate from the older schema (anthropicKey / openrouterKey / *Model).
function migrate(s) {
  s.keys = s.keys || {};
  s.models = s.models || {};
  s.baseUrls = s.baseUrls || {};
  if (s.anthropicKey && !s.keys.anthropic) s.keys.anthropic = s.anthropicKey;
  if (s.openrouterKey && !s.keys.openrouter) s.keys.openrouter = s.openrouterKey;
  if (s.anthropicModel && !s.models.anthropic) s.models.anthropic = s.anthropicModel;
  if (s.openrouterModel && !s.models.openrouter) s.models.openrouter = s.openrouterModel;
  delete s.anthropicKey;
  delete s.openrouterKey;
  delete s.anthropicModel;
  delete s.openrouterModel;
  return s;
}

export async function getSettings() {
  const stored = await browser.storage.local.get(null);
  return migrate({ ...DEFAULTS, ...stored });
}

export async function setSettings(patch) {
  await browser.storage.local.set(patch);
}

// Update a single entry of a nested object (keys / models / baseUrls) without
// clobbering its siblings.
export async function setNested(field, key, value) {
  const cur = (await browser.storage.local.get(field))[field] || {};
  cur[key] = value;
  await browser.storage.local.set({ [field]: cur });
}

export function onSettingsChanged(callback) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") callback(changes);
  });
}

export { DEFAULTS };
