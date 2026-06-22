// Agent tool definitions + the browser-side executor.
//
// Definitions are provider-neutral (plain JSON Schema); providers.js adapts them
// to the Anthropic or OpenAI wire format. The executor runs in the sidebar
// context, which holds the privileged `browser.*` APIs.
//
// SAFETY: every tool is tagged `write:true/false`. Write tools (the ones that
// change state — clicking, typing, navigating, opening/closing tabs) go through
// an optional confirmation prompt. On top of that, a hard-coded payment guardrail
// (see content.js) refuses checkout/payment actions when enabled, so the agent
// can fill a cart but can never complete a purchase.

export const TOOLS = [
  {
    name: "read_page",
    description:
      "Read the visible text of the ACTIVE tab (title, URL, text). Use this to answer questions about the page the user is looking at.",
    write: false,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_selection",
    description:
      "Get the text currently selected by the user in the active tab.",
    write: false,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_tabs",
    description:
      "List the open tabs of the current window (id, title, URL, active).",
    write: false,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_tab",
    description:
      "Read the visible text of a SPECIFIC tab by its id (obtained from list_tabs), without switching to it. Use to compare or gather context across several tabs.",
    write: false,
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "find_elements",
    description:
      "List interactive elements on the page (links, buttons, inputs) each with a 'ref' to use in click_element / fill_input. Pass 'query' (text to look for) to narrow the list.",
    write: false,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text/label to filter elements by (optional).",
        },
      },
      required: [],
    },
  },
  {
    name: "open_tab",
    description: "Open a new tab at the given URL.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL (https://...)" },
        active: { type: "boolean", description: "Bring the tab to front (default true)." },
      },
      required: ["url"],
    },
  },
  {
    name: "switch_tab",
    description: "Activate (bring to front) the tab with the given id.",
    write: true,
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "close_tab",
    description: "Close the tab with the given id.",
    write: true,
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "navigate",
    description: "Navigate the active tab to the given URL.",
    write: true,
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "click_element",
    description:
      "Click an element identified by its 'ref' (from find_elements). Payment/checkout buttons are refused by the safety guardrail.",
    write: true,
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "fill_input",
    description:
      "Type text into a field identified by its 'ref'. submit=true then submits the form. Card/payment fields are refused by the safety guardrail.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "scroll_page",
    description: "Scroll the active tab: 'up', 'down', 'top' or 'bottom'.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      },
      required: ["direction"],
    },
  },
];

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  return tab;
}

// Send a message to a tab's content script, injecting it on the fly if it is not
// present yet (freshly loaded or restricted page).
async function sendToTab(tabId, message) {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (e) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["src/content/content.js"],
      });
      return await browser.tabs.sendMessage(tabId, message);
    } catch (e2) {
      throw new Error("Cannot access this page (protected or not loaded).");
    }
  }
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  return sendToTab(tab.id, message);
}

// Execute a tool call.
// Options:
//   confirmActions / confirmFn : confirmation gate for write tools.
//   guard : { blockPayments } — forwarded to the page so the content script can
//           refuse payment/checkout interactions in code (defence in depth).
export async function executeTool(name, input, opts = {}) {
  const { confirmActions, confirmFn, guard = {} } = opts;
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { error: `Unknown tool: ${name}` };

  if (def.write && confirmActions && confirmFn) {
    const ok = await confirmFn(name, input);
    if (!ok) return { error: "Action declined by the user." };
  }

  try {
    switch (name) {
      case "read_page":
        return await sendToActiveTab({ type: "read_page" });
      case "read_selection":
        return await sendToActiveTab({ type: "read_selection" });
      case "read_tab":
        return await sendToTab(input.tabId, { type: "read_page" });
      case "find_elements":
        return await sendToActiveTab({ type: "find_elements", query: input.query || "" });
      case "click_element":
        return await sendToActiveTab({ type: "click_element", ref: input.ref, guard });
      case "fill_input":
        return await sendToActiveTab({
          type: "fill_input",
          ref: input.ref,
          value: input.value,
          submit: !!input.submit,
          guard,
        });
      case "scroll_page":
        return await sendToActiveTab({ type: "scroll_page", direction: input.direction });

      case "list_tabs": {
        const tabs = await browser.tabs.query({ currentWindow: true });
        return {
          tabs: tabs.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
          })),
        };
      }
      case "open_tab": {
        const tab = await browser.tabs.create({
          url: input.url,
          active: input.active !== false,
        });
        return { ok: true, tabId: tab.id };
      }
      case "switch_tab": {
        await browser.tabs.update(input.tabId, { active: true });
        return { ok: true };
      }
      case "close_tab": {
        await browser.tabs.remove(input.tabId);
        return { ok: true };
      }
      case "navigate": {
        const tab = await getActiveTab();
        await browser.tabs.update(tab.id, { url: input.url });
        return { ok: true };
      }
      default:
        return { error: `Tool not implemented: ${name}` };
    }
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}
