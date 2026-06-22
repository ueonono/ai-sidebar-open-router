// Local conversation history (privacy-first).
//
// Everything is stored in browser.storage.local — on this device only, never
// synced, never sent anywhere. The user can disable saving (settings.saveHistory)
// or clear everything. Each conversation keeps a display transcript (for the UI)
// plus the provider-native message array (to allow continuing the chat).

const KEY = "conversations";
const MAX_CONVERSATIONS = 60;

export async function listConversations() {
  const { [KEY]: list } = await browser.storage.local.get(KEY);
  return Array.isArray(list) ? list : [];
}

export async function getConversation(id) {
  const list = await listConversations();
  return list.find((c) => c.id === id) || null;
}

// Insert or update a conversation, keeping the list capped and most-recent-first.
export async function saveConversation(conv) {
  const list = await listConversations();
  const idx = list.findIndex((c) => c.id === conv.id);
  conv.updatedAt = Date.now();
  if (idx >= 0) list[idx] = conv;
  else list.unshift(conv);
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const capped = list.slice(0, MAX_CONVERSATIONS);
  await browser.storage.local.set({ [KEY]: capped });
  return conv;
}

export async function deleteConversation(id) {
  const list = await listConversations();
  await browser.storage.local.set({ [KEY]: list.filter((c) => c.id !== id) });
}

export async function clearConversations() {
  await browser.storage.local.remove(KEY);
}

export function newConversationId() {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Derive a short title from the first user message.
export function titleFrom(transcript) {
  const firstUser = (transcript || []).find((m) => m.role === "user");
  const t = (firstUser && firstUser.text) || "Nouvelle conversation";
  return t.replace(/\s+/g, " ").trim().slice(0, 48);
}
