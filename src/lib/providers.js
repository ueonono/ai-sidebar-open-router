// API clients. Two families sharing one interface:
//   runTurn({ system, history, tools, onText, onThink, signal })
//     -> { message, toolCalls:[{id,name,input}], stopReason, text }
//   formatToolResults(results) -> native message(s) to push into the history
//
// `history` and `message` stay in each provider's NATIVE wire format (Anthropic
// vs OpenAI) to remain faithful to each API. The agent loop (agent.js) only ever
// touches the normalised `toolCalls` array.
//
// `onThink(delta)` receives reasoning text (Anthropic extended thinking,
// DeepSeek/o-series reasoning_content) so the UI can show it separately.

import { PROVIDERS, baseUrlFor, modelFor, keyFor } from "./models.js";

const MAX_TOKENS = 4096;
const THINKING_BUDGET = 6000;

// Generic SSE reader: yields the payloads of "data:" lines.
async function* sseData(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

async function ensureOk(response) {
  if (response.ok) return;
  let detail = "";
  try {
    detail = await response.text();
  } catch (_) {}
  throw new Error(`HTTP ${response.status} — ${detail.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Anthropic (Claude) — native API, + extended thinking + server-side web search
// ---------------------------------------------------------------------------
function anthropicProvider({ apiKey, model, baseUrl, thinking, webSearch }) {
  const url = baseUrl.replace(/\/$/, "") + "/messages";
  return {
    id: "anthropic",

    async runTurn({ system, history, tools, onText, onThink, signal }) {
      const useThinking = !!thinking;
      const body = {
        model,
        max_tokens: useThinking ? MAX_TOKENS + THINKING_BUDGET : MAX_TOKENS,
        system,
        messages: history,
        stream: true,
      };
      if (useThinking) {
        body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET };
      }
      const toolList = [];
      if (tools && tools.length) {
        for (const t of tools)
          toolList.push({ name: t.name, description: t.description, input_schema: t.input_schema });
      }
      if (webSearch) {
        toolList.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
      }
      if (toolList.length) body.tools = toolList;

      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
      await ensureOk(response);

      const blocks = [];
      let stopReason = null;
      let text = "";

      for await (const data of sseData(response)) {
        if (data === "[DONE]") break;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch (_) {
          continue;
        }
        switch (ev.type) {
          case "content_block_start":
            blocks[ev.index] = { ...ev.content_block, _partial: "" };
            break;
          case "content_block_delta": {
            const b = blocks[ev.index];
            if (!b) break;
            const d = ev.delta;
            if (d.type === "text_delta") {
              b.text = (b.text || "") + d.text;
              text += d.text;
              onText && onText(d.text);
            } else if (d.type === "thinking_delta") {
              b.thinking = (b.thinking || "") + d.thinking;
              onThink && onThink(d.thinking);
            } else if (d.type === "signature_delta") {
              b.signature = (b.signature || "") + d.signature;
            } else if (d.type === "input_json_delta") {
              b._partial += d.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const b = blocks[ev.index];
            if (b && b.type === "tool_use") {
              try {
                b.input = JSON.parse(b._partial || "{}");
              } catch (_) {
                b.input = {};
              }
            }
            if (b) delete b._partial;
            break;
          }
          case "message_delta":
            if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
            break;
        }
      }

      // Keep ALL blocks (including thinking with its signature, which the API
      // requires on the next turn) so the conversation stays valid.
      const content = blocks.filter(Boolean).map((b) => {
        if (b.type === "tool_use")
          return { type: "tool_use", id: b.id, name: b.name, input: b.input || {} };
        if (b.type === "text") return { type: "text", text: b.text || "" };
        if (b.type === "thinking")
          return { type: "thinking", thinking: b.thinking || "", signature: b.signature || "" };
        if (b.type === "redacted_thinking")
          return { type: "redacted_thinking", data: b.data };
        return b;
      });

      const toolCalls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return { message: { role: "assistant", content }, toolCalls, stopReason, text };
    },

    formatToolResults(results) {
      return {
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          is_error: !!r.isError,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible (OpenAI, OpenRouter, Gemini, Mistral, Groq,
// DeepSeek, Ollama, LM Studio, self-hosted…)
// ---------------------------------------------------------------------------
function openaiProvider({ apiKey, model, baseUrl }) {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // OpenRouter attribution headers (ignored by other providers). They carry no
  // user data — just the app name/repo — and are sent only to the chosen endpoint.
  headers["HTTP-Referer"] = "https://github.com/FlorianMartins/firefox-ai-sidebar";
  headers["X-Title"] = "AI Sidebar";

  return {
    id: "openai",

    async runTurn({ system, history, tools, onText, onThink, signal }) {
      const messages = system ? [{ role: "system", content: system }, ...history] : [...history];
      const body = { model, messages, stream: true };
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
      }

      const response = await fetch(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(body),
      });
      await ensureOk(response);

      let text = "";
      let finishReason = null;
      const toolAcc = {};

      for await (const data of sseData(response)) {
        if (data === "[DONE]") break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (_) {
          continue;
        }
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        // Reasoning text (DeepSeek: reasoning_content ; OpenRouter: reasoning)
        const reason = delta.reasoning_content || delta.reasoning;
        if (reason) onThink && onThink(reason);
        if (delta.content) {
          text += delta.content;
          onText && onText(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: tc.id, name: "", args: "" };
            if (tc.id) toolAcc[i].id = tc.id;
            if (tc.function && tc.function.name) toolAcc[i].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolAcc[i].args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      const nativeToolCalls = Object.values(toolAcc).map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: t.args || "{}" },
      }));

      const message = { role: "assistant", content: text || null };
      if (nativeToolCalls.length) message.tool_calls = nativeToolCalls;

      const toolCalls = nativeToolCalls.map((t) => {
        let input = {};
        try {
          input = JSON.parse(t.function.arguments || "{}");
        } catch (_) {}
        return { id: t.id, name: t.function.name, input };
      });

      return {
        message,
        toolCalls,
        stopReason: finishReason === "tool_calls" ? "tool_use" : finishReason,
        text,
      };
    },

    formatToolResults(results) {
      return results.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: r.content,
      }));
    },
  };
}

// Build the provider for the current conversation.
export function makeProvider(settings, opts = {}) {
  const id = settings.provider;
  const meta = PROVIDERS[id] || PROVIDERS.anthropic;
  const apiKey = keyFor(id, settings);
  const model = modelFor(id, settings);
  const baseUrl = baseUrlFor(id, settings);

  if (meta.kind === "anthropic") {
    return anthropicProvider({
      apiKey,
      model,
      baseUrl,
      thinking: !!opts.thinking && meta.supportsThinking,
      webSearch: !!opts.webSearch && meta.supportsWebSearch,
    });
  }
  return openaiProvider({ apiKey, model, baseUrl });
}

// -------- Dynamic model listing (OpenAI /models format) ---------------------
export async function listModels(providerId, settings) {
  const meta = PROVIDERS[providerId];
  if (!meta) throw new Error("Fournisseur inconnu");
  const baseUrl = baseUrlFor(providerId, settings);
  if (!baseUrl) throw new Error("Base URL manquante.");
  const apiKey = keyFor(providerId, settings);
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/models", { headers });
  await ensureOk(res);
  const json = await res.json();
  const data = json.data || json.models || [];
  return data
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort();
}

// -------- Image generation (OpenAI-compatible /images/generations) ----------
// Returns a list of data: (or http) URLs to display.
export async function generateImage(settings, { prompt, size, signal }) {
  size = size || settings.imageSize || "1024x1024";
  const providerId = settings.imageProvider || "openai";
  const meta = PROVIDERS[providerId];
  if (!meta || !meta.supportsImages) {
    throw new Error(
      `Le fournisseur d'images « ${providerId} » n'est pas supporté. Choisissez OpenAI dans les réglages.`
    );
  }
  const baseUrl = baseUrlFor(providerId, settings);
  const apiKey = keyFor(providerId, settings);
  if (meta.needsKey && !apiKey) throw new Error(`Clé API manquante pour ${meta.label}.`);

  const body = {
    model: settings.imageModel || (meta.imageModels && meta.imageModels[0][0]),
    prompt,
    n: 1,
    size,
  };
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(baseUrl.replace(/\/$/, "") + "/images/generations", {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  });
  await ensureOk(res);
  const json = await res.json();
  const out = [];
  for (const item of json.data || []) {
    if (item.b64_json) out.push(`data:image/png;base64,${item.b64_json}`);
    else if (item.url) out.push(item.url);
  }
  if (!out.length) throw new Error("Aucune image renvoyée par l'API.");
  return out;
}
