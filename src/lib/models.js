// Catalogue of AI providers and their default models.
// The extension is 100% BYOK: no key is bundled, the user supplies their own
// (or points at a local server that needs none).
//
// `kind`:
//   "anthropic"  -> native Anthropic API (Claude)
//   "openai"     -> OpenAI-compatible API (/chat/completions, /models, /images)
//
// Most providers (OpenAI, Gemini, Mistral, Groq, DeepSeek, OpenRouter, Ollama,
// LM Studio, self-hosted servers…) speak the OpenAI dialect, so a single generic
// client covers them all, parameterised only by `baseUrl` + `apiKey`.

export const PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    needsKey: true,
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-...",
    supportsThinking: true,
    supportsWebSearch: true,
    supportsImages: false,
    models: [
      ["claude-opus-4-8", "Claude Opus 4.8"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
      ["claude-haiku-4-5", "Claude Haiku 4.5"],
    ],
  },

  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    keysUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-...",
    supportsImages: true,
    imageModels: [
      ["gpt-image-1", "GPT Image 1"],
      ["dall-e-3", "DALL·E 3"],
    ],
    models: [
      ["gpt-4o", "GPT-4o"],
      ["gpt-4o-mini", "GPT-4o mini"],
      ["o4-mini", "o4-mini (raisonnement)"],
      ["o3", "o3 (raisonnement)"],
    ],
  },

  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    keysUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-...",
    canListModels: true,
    models: [
      ["anthropic/claude-opus-4.1", "Claude Opus 4.1"],
      ["anthropic/claude-3.7-sonnet", "Claude 3.7 Sonnet"],
      ["openai/gpt-4o", "GPT-4o"],
      ["google/gemini-2.0-flash-001", "Gemini 2.0 Flash"],
      ["meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B"],
      ["deepseek/deepseek-r1", "DeepSeek R1 (raisonnement)"],
    ],
  },

  google: {
    label: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    keysUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "AIza...",
    models: [
      ["gemini-2.5-pro", "Gemini 2.5 Pro"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash"],
      ["gemini-2.0-flash", "Gemini 2.0 Flash"],
    ],
  },

  mistral: {
    label: "Mistral AI",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    keysUrl: "https://console.mistral.ai/api-keys",
    canListModels: true,
    models: [
      ["mistral-large-latest", "Mistral Large"],
      ["mistral-small-latest", "Mistral Small"],
      ["pixtral-large-latest", "Pixtral Large (vision)"],
    ],
  },

  groq: {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    keysUrl: "https://console.groq.com/keys",
    canListModels: true,
    models: [
      ["llama-3.3-70b-versatile", "Llama 3.3 70B"],
      ["deepseek-r1-distill-llama-70b", "DeepSeek R1 Distill 70B"],
      ["qwen-2.5-32b", "Qwen 2.5 32B"],
    ],
  },

  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: [
      ["deepseek-chat", "DeepSeek V3 (chat)"],
      ["deepseek-reasoner", "DeepSeek R1 (raisonnement)"],
    ],
  },

  ollama: {
    label: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    local: true,
    canListModels: true,
    keysUrl: "https://ollama.com",
    models: [
      ["llama3.2", "llama3.2"],
      ["qwen2.5", "qwen2.5"],
      ["deepseek-r1", "deepseek-r1"],
    ],
  },

  lmstudio: {
    label: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    local: true,
    canListModels: true,
    keysUrl: "https://lmstudio.ai",
    models: [["local-model", "(modèle chargé dans LM Studio)"]],
  },

  custom: {
    label: "Personnalisé (compatible OpenAI)",
    kind: "openai",
    baseUrl: "",
    needsKey: false,
    custom: true,
    canListModels: true,
    models: [],
  },
};

export const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "mistral",
  "groq",
  "deepseek",
  "ollama",
  "lmstudio",
  "custom",
];

// Image sizes accepted by the OpenAI-compatible /images/generations endpoint.
export const IMAGE_SIZES = ["1024x1024", "1024x1792", "1792x1024", "512x512"];

// Effective base URL (honours the user's override for local / custom servers).
export function baseUrlFor(providerId, settings) {
  const override = settings && settings.baseUrls && settings.baseUrls[providerId];
  return (override && override.trim()) || PROVIDERS[providerId].baseUrl;
}

// Selected model for this provider (falls back to the first default).
export function modelFor(providerId, settings) {
  const chosen = settings && settings.models && settings.models[providerId];
  if (chosen) return chosen;
  const def = PROVIDERS[providerId].models[0];
  return def ? def[0] : "";
}

export function keyFor(providerId, settings) {
  return (settings && settings.keys && settings.keys[providerId]) || "";
}
