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
  provider: "openrouter", // active provider id — OpenRouter (free models + 1-click OAuth)
  keys: {}, // per-provider API keys      { anthropic:"", openai:"", ... }
  models: {}, // per-provider chosen model  { anthropic:"claude-opus-4-8", ... }
  baseUrls: {}, // per-provider base URL overrides (ollama / lmstudio / custom)

  // ----- Image generation ---------------------------------------------------
  imageProvider: "openai",
  imageModel: "gpt-image-1",
  imageSize: "1024x1024",

  // ----- UI / behaviour ------------------------------------------------------
  mode: "chat", // active workspace tab: chat | agent | translate | improve | image | terminal | code
  thinking: false, // surface the model's reasoning (supported models only)
  webSearch: false, // web search: Anthropic native, OpenRouter "web" plugin, Perplexity Sonar
  searchModel: "", // "providerId|modelId" used in web-search mode ("" = auto-pick a free/online model)
  agentMode: false, // allow the model to act inside the browser
  agentModel: "", // "providerId|modelId" forced for agent mode ("" = use the selected model). Many free
                  // models (e.g. Llama) can't call tools — let the user pick a tool-capable model here.
  agentPermission: "manual", // "manual" = confirm each state-changing action ; "auto" = allow all (no prompt).
                             // The anti-purchase guardrail (blockPayments) still applies in BOTH modes.
  confirmActions: true, // ask before every state-changing action (kept in sync with agentPermission)
  includePageContext: true, // feed the active page into the chat
  autoReadPage: true, // re-read the page on every navigation (subdomains too)
  includeSelectedTabs: false, // also feed the user-selected extra tabs
  selectedTabs: [], // tab ids the user ticked for multi-tab context
  localEnabled: {}, // explicit opt-in for local servers { ollama:true, lmstudio:true }
  maxPageChars: 12000, // truncation budget for a single page's text
  targetLang: "French", // preferred target language for translations (canonical English name)
  responseLang: "Auto", // language the AI replies in. "Auto" = match the user's input language.
                        // (The UI language is separate — see uiLang.)
  orFreeOnly: false, // OpenRouter model picker: show ALL models with their price-tier colours
                     // (🎁🟢🟡🟠🔴) by default. Free-only is an opt-in toggle in Settings.
                     // Inaccessible models are auto-removed on error + a data-policy link is shown.
  improvePreset: "improve", // default writing preset for the "improve" mode
  uiLang: "en", // sidebar interface language: "en" (default) | "fr". Changed from Settings.
  railSide: "left", // workspace tab rail position INSIDE the sidebar: "left" (default) | "right".
                    // (The sidebar's own browser-side position is not controllable by extensions.)

  // ----- Model picker filter (price tiers + providers) -----------------------
  // Persisted state of the model-filter popover shared by every workspace's picker.
  // `tiers` = price tiers to SHOW; `providers` empty = all; `subproviders` empty = all
  // (used to filter OpenRouter models by their vendor: google / openai / anthropic…).
  modelFilter: { tiers: ["free", "green", "yellow", "orange", "red"], providers: [], subproviders: [] },

  // ----- Code workspace ------------------------------------------------------
  // The "Code" tab launches a self-hosted AI app builder ("Program Generator",
  // a Bolt.diy instance) in a NEW BROWSER TAB. WebContainers there require
  // cross-origin isolation (COOP/COEP) and can't run inside an extension iframe,
  // so a new tab is the only robust integration. The builder is keyless server-
  // side: the sidebar hands it its OpenRouter key via the URL fragment (#sk=) so
  // both share one and the same key/budget — a single service. URL is user-
  // configurable; leave blank to hide the launcher.
  codeAppUrl: "https://code.hivey.be",

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
  // The translate-target language is now stored as a canonical English name (the
  // <option> values). Map any legacy French label to it so the dropdown still matches.
  const LANG_FR2EN = {
    "Français": "French", "Anglais": "English", "Espagnol": "Spanish",
    "Allemand": "German", "Italien": "Italian", "Portugais": "Portuguese",
    "Néerlandais": "Dutch", "Arabe": "Arabic", "Chinois": "Chinese",
    "Japonais": "Japanese", "Russe": "Russian",
  };
  if (s.targetLang && LANG_FR2EN[s.targetLang]) s.targetLang = LANG_FR2EN[s.targetLang];
  delete s.anthropicKey;
  delete s.openrouterKey;
  delete s.anthropicModel;
  delete s.openrouterModel;
  return s;
}

export async function getSettings() {
  const stored = await browser.storage.local.get(null);
  const s = migrate({ ...DEFAULTS, ...stored });
  // One-time migration (persisted): the old default forced English replies. Switch
  // it to "Auto" (match the input language) ONCE, so users who never changed it get
  // the expected behaviour, while anyone who later picks a language keeps it.
  if (s.responseLang === "English" && !s.respLangMigrated) {
    s.responseLang = "Auto";
    s.respLangMigrated = true;
    try { await browser.storage.local.set({ responseLang: "Auto", respLangMigrated: true }); } catch (_) {}
  }
  // One-time: the earlier build defaulted to free-only, which hid paid models and made
  // every shown model the same green. Flip it off once so the full coloured list returns.
  if (s.orFreeOnly === true && !s.orFreeOnlyMigrated) {
    s.orFreeOnly = false;
    s.orFreeOnlyMigrated = true;
    try { await browser.storage.local.set({ orFreeOnly: false, orFreeOnlyMigrated: true }); } catch (_) {}
  }
  return s;
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
