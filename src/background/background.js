// Background (non-persistent event page). Deliberately minimal: all the real
// work (API calls, agent loop) happens in the sidebar, which holds the browser.*
// APIs and stays open during use.
//
// Responsibilities here:
//   1. Sider-style right-click menus on the page / selection.
//   2. Relaying the webmail "draft reply" request to the sidebar.
// In both cases we drop a pending action into storage.local and open the
// sidebar, which picks it up and runs it.

const MENU = [
  { id: "ai-open", title: "Ouvrir AI Sidebar", contexts: ["all"] },
  { id: "ai-summarize-page", title: "Résumer la page", contexts: ["page"] },
  { id: "ai-translate-page", title: "Traduire la page", contexts: ["page"] },
  { id: "ai-summarize-sel", title: "Résumer la sélection", contexts: ["selection"] },
  { id: "ai-explain", title: "Expliquer la sélection", contexts: ["selection"] },
  { id: "ai-translate-sel", title: "Traduire la sélection", contexts: ["selection"] },
  { id: "ai-improve", title: "Améliorer le texte sélectionné", contexts: ["selection"] },
  { id: "ai-reply", title: "Rédiger une réponse à ce texte", contexts: ["selection", "editable"] },
];

// Map a menu id to a sidebar quick-action name. Page-level items pass no text,
// so the sidebar falls back to the current page.
const MENU_ACTION = {
  "ai-summarize-page": "summarize",
  "ai-translate-page": "translate",
  "ai-summarize-sel": "summarize-selection",
  "ai-explain": "explain",
  "ai-translate-sel": "translate",
  "ai-improve": "improve",
  "ai-reply": "reply",
};

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.removeAll().then(() => {
    for (const m of MENU) browser.contextMenus.create(m);
  });
});

async function queueAndOpen(action, text) {
  await browser.storage.local.set({
    pendingAction: { action, text: text || "", ts: Date.now() },
  });
  try {
    await browser.sidebarAction.open();
  } catch (_) {
    // open() must run inside a user gesture; the menu click usually qualifies.
    // If it doesn't, the sidebar consumes the pending action next time it opens.
  }
}

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "ai-open") {
    browser.sidebarAction.open();
    return;
  }
  const action = MENU_ACTION[info.menuItemId];
  if (!action) return;
  await queueAndOpen(action, info.selectionText || "");
});

// Webmail helper: the content-script button forwards the email thread here.
// If the sidebar is already open it also receives this message directly and acts
// live; this handler is the fallback that opens the sidebar with the draft queued.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "draft_reply") {
    queueAndOpen("reply", msg.thread || "");
  }
});
