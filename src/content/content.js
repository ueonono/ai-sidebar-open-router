// Content script: reads the page and performs the DOM actions requested by the
// agent. Injected on every page (document_idle) and re-injected on demand by
// tools.js. Also adds an opt-in "AI reply" helper button on known webmail sites.
(function () {
  if (window.__aiSidebarInjected) return;
  window.__aiSidebarInjected = true;

  const refMap = new Map(); // ref -> element
  let refCounter = 0;

  // --- Safety: payment / checkout guardrail --------------------------------
  // The agent may browse and fill a cart, but never transact. We refuse clicks
  // on payment/checkout controls and typing into card fields. Matching is
  // intentionally broad (EN + FR) and errs on the side of refusing.
  const PAY_WORDS = [
    "pay now", "pay ", "payment", "checkout", "check out", "place order",
    "place your order", "buy now", "buy ", "purchase", "complete purchase",
    "confirm order", "confirm and pay", "proceed to payment", "proceed to checkout",
    "subscribe", "complete order", "order now",
    // French
    "payer", "paiement", "payez", "régler", "passer commande", "passer la commande",
    "valider la commande", "valider le paiement", "confirmer la commande",
    "confirmer l'achat", "acheter", "procéder au paiement", "finaliser la commande",
    "finaliser l'achat",
  ];
  const CARD_FIELD = /(card.?number|cardnum|cc.?num|cvv|cvc|cryptogramme|num(é|e)ro.?de.?carte|expir|exp.?date|securitycode|card.?code)/i;

  function textOf(el) {
    return (
      (el.innerText || el.value || "") + " " +
      (el.getAttribute && (
        (el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("name") || "") + " " +
        (el.getAttribute("id") || "") + " " +
        (el.getAttribute("title") || "") + " " +
        (el.getAttribute("value") || "")
      ) || "")
    ).toLowerCase();
  }

  function looksLikePaymentControl(el) {
    const hay = textOf(el);
    return PAY_WORDS.some((w) => hay.includes(w));
  }

  function looksLikeCardField(el) {
    const ac = (el.getAttribute && el.getAttribute("autocomplete")) || "";
    if (/cc-(number|csc|exp)/i.test(ac)) return true;
    const hay =
      (el.getAttribute && (
        (el.getAttribute("name") || "") + " " +
        (el.getAttribute("id") || "") + " " +
        (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("aria-label") || "")
      )) || "";
    return CARD_FIELD.test(hay);
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function labelOf(el) {
    const txt =
      (el.innerText || "").trim() ||
      (el.value || "").trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      "";
    return txt.replace(/\s+/g, " ").slice(0, 120);
  }

  function metaDescription() {
    const m =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[property="og:description"]');
    return (m && m.getAttribute("content")) || "";
  }

  function readPage() {
    const main = document.querySelector("main, article, [role=main]") || document.body;
    const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000);
    return {
      title: document.title,
      url: location.href,
      description: metaDescription(),
      text,
    };
  }

  function readSelection() {
    return { selection: (window.getSelection() || "").toString().slice(0, 8000) };
  }

  function findElements(query) {
    refMap.clear();
    refCounter = 0;
    const q = (query || "").toLowerCase().trim();
    const selector =
      "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [onclick]";
    const out = [];
    const nodes = document.querySelectorAll(selector);
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      const hay = (label + " " + (el.getAttribute("href") || "")).toLowerCase();
      if (q && !hay.includes(q)) continue;
      const ref = "e" + ++refCounter;
      refMap.set(ref, el);
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || undefined,
        text: label,
        href: el.getAttribute("href") || undefined,
        // Hint so the model can avoid even proposing a payment action.
        payment: looksLikePaymentControl(el) || undefined,
      });
      if (out.length >= 60) break;
    }
    return { count: out.length, elements: out };
  }

  function clickElement(ref, guard) {
    const el = refMap.get(ref);
    if (!el) return { error: `ref not found: ${ref} (re-run find_elements)` };
    if (guard && guard.blockPayments && looksLikePaymentControl(el)) {
      return { error: "Blocked by safety guardrail: payment/checkout action is not allowed.", blocked: true };
    }
    el.scrollIntoView({ block: "center" });
    el.click();
    return { ok: true, clicked: labelOf(el) };
  }

  function fillInput(ref, value, submit, guard) {
    const el = refMap.get(ref);
    if (!el) return { error: `ref not found: ${ref} (re-run find_elements)` };
    if (guard && guard.blockPayments && looksLikeCardField(el)) {
      return { error: "Blocked by safety guardrail: card/payment field is not allowed.", blocked: true };
    }
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) {
      // Refuse to submit a form that looks like a payment form.
      if (guard && guard.blockPayments && el.form && looksLikePaymentControl(el.form)) {
        return { ok: true, filled: labelOf(el), note: "Filled but submit blocked (payment form)." };
      }
      const form = el.form;
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
        );
      }
    }
    return { ok: true, filled: labelOf(el) };
  }

  function scrollPage(direction) {
    const h = window.innerHeight;
    if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (direction === "bottom")
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    else window.scrollBy({ top: direction === "up" ? -h * 0.9 : h * 0.9, behavior: "smooth" });
    return { ok: true };
  }

  // --- Element picker ------------------------------------------------------
  // Lets the user point at any element on the page (a table, an image, a menu…) and
  // "ask the AI about it". Hover outlines the element; a single click captures it;
  // holding the left button and dragging across several elements selects them all
  // (each captured). Esc, or a pick_cancel message from the sidebar, aborts cleanly.
  let pickResolve = null;
  let pickHoverBox = null;
  let pickHover = null;
  let pickPainting = false;
  let pickSelected = [];
  let pickBoxes = [];
  function mkBox(color, bg, z) {
    const d = document.createElement("div");
    Object.assign(d.style, {
      position: "fixed", zIndex: z, top: 0, left: 0, width: 0, height: 0,
      border: "2px solid " + color, background: bg, borderRadius: "3px", pointerEvents: "none",
    });
    document.documentElement.appendChild(d);
    return d;
  }
  function placeBox(d, r) {
    Object.assign(d.style, { top: r.top + "px", left: r.left + "px", width: r.width + "px", height: r.height + "px" });
  }
  function addSelected(el) {
    if (!el || pickSelected.includes(el)) return;
    pickSelected.push(el);
    const b = mkBox("#8b5cf6", "rgba(139,92,246,.22)", 2147483646);
    placeBox(b, el.getBoundingClientRect());
    pickBoxes.push(b);
  }
  function pickMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    if (pickPainting) { addSelected(el); }
    else { pickHover = el; placeBox(pickHoverBox, el.getBoundingClientRect()); }
  }
  function pickDown(e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    pickPainting = true;
    if (pickHoverBox) pickHoverBox.style.display = "none";
    addSelected(pickHover || document.elementFromPoint(e.clientX, e.clientY));
  }
  function pickUp(e) {
    if (!pickPainting) return;
    e.preventDefault(); e.stopPropagation();
    endPick(false);
  }
  function pickSwallow(e) { e.preventDefault(); e.stopPropagation(); } // don't trigger page links/buttons
  function pickKey(e) { if (e.key === "Escape") { e.preventDefault(); endPick(true); } }
  function describeElement(el) {
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
    let imgSrc = "";
    if (el.tagName === "IMG") imgSrc = el.currentSrc || el.src || "";
    return { tag: el.tagName.toLowerCase(), text, imgSrc, rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } };
  }
  function endPick(cancelled) {
    document.removeEventListener("mousemove", pickMove, true);
    document.removeEventListener("mousedown", pickDown, true);
    document.removeEventListener("mouseup", pickUp, true);
    document.removeEventListener("click", pickSwallow, true);
    document.removeEventListener("keydown", pickKey, true);
    document.documentElement.style.cursor = "";
    if (pickHoverBox) { pickHoverBox.remove(); pickHoverBox = null; }
    pickBoxes.forEach((b) => b.remove());
    const els = pickSelected;
    pickBoxes = []; pickSelected = []; pickPainting = false;
    const r = pickResolve; pickResolve = null;
    if (!r) return;
    if (cancelled || !els.length) { r({ cancelled: true }); return; }
    r({ elements: els.slice(0, 8).map(describeElement), dpr: window.devicePixelRatio || 1, url: location.href, title: document.title });
  }
  function startPick() {
    if (pickResolve) endPick(true); // restart cleanly
    return new Promise((resolve) => {
      pickResolve = resolve; pickSelected = []; pickBoxes = []; pickPainting = false; pickHover = null;
      pickHoverBox = mkBox("#a855f7", "rgba(168,85,247,.14)", 2147483647);
      document.documentElement.style.cursor = "crosshair";
      document.addEventListener("mousemove", pickMove, true);
      document.addEventListener("mousedown", pickDown, true);
      document.addEventListener("mouseup", pickUp, true);
      document.addEventListener("click", pickSwallow, true);
      document.addEventListener("keydown", pickKey, true);
    });
  }

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg && msg.type) {
      case "read_page":
        return Promise.resolve(readPage());
      case "read_selection":
        return Promise.resolve(readSelection());
      case "pick_element":
        return startPick();
      case "pick_cancel":
        if (pickResolve) endPick(true);
        return Promise.resolve({ ok: true });
      case "find_elements":
        return Promise.resolve(findElements(msg.query));
      case "click_element":
        return Promise.resolve(clickElement(msg.ref, msg.guard));
      case "fill_input":
        return Promise.resolve(fillInput(msg.ref, msg.value, msg.submit, msg.guard));
      case "scroll_page":
        return Promise.resolve(scrollPage(msg.direction));
      case "ping":
        return Promise.resolve({ ok: true });
    }
    return false;
  });

  // --- SPA navigation notifier ---------------------------------------------
  // Tell the sidebar when the URL changes via the History API (pushState /
  // popstate), which does not always fire tabs.onUpdated. Classic navigations
  // (new site, subdomain) are caught by the sidebar via tab events instead.
  let lastUrl = location.href;
  const notifyNav = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    try {
      browser.runtime.sendMessage({ type: "page_changed", url: location.href });
    } catch (_) {}
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(notifyNav, 50);
      return r;
    };
  }
  window.addEventListener("popstate", () => setTimeout(notifyNav, 50));

  // --- Webmail "AI reply" helper -------------------------------------------
  // On known webmail hosts, add a small floating button that grabs the visible
  // email thread and asks the sidebar to draft a reply. It NEVER sends anything:
  // the user reviews the draft in the sidebar and copies it back. Opt-out via the
  // `webmailAssist` setting.
  const WEBMAIL_HOSTS = [
    "mail.google.com", "outlook.live.com", "outlook.office.com",
    "outlook.office365.com", "mail.proton.me", "mail.yahoo.com",
  ];
  function isWebmail() {
    return WEBMAIL_HOSTS.some((h) => location.hostname.endsWith(h));
  }

  function readThread() {
    // Grab the largest readable region as the conversation text. Good enough
    // across webmails without brittle per-provider selectors.
    const main = document.querySelector("[role=main], main") || document.body;
    return (main.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 12000);
  }

  // Webmail button labels — English by default, French when uiLang="fr".
  const WEBMAIL_I18N = {
    en: { reply: "✨ Reply with AI", aria: "Draft an AI-assisted reply", opening: "✓ Opening the sidebar…" },
    fr: { reply: "✨ Répondre avec l'IA", aria: "Rédiger une réponse assistée par IA", opening: "✓ Ouvre la sidebar…" },
  };
  let WM = WEBMAIL_I18N.en;

  const IS_GMAIL = location.hostname.endsWith("mail.google.com");
  function onReplyClick(btn) {
    const thread = readThread();
    browser.runtime.sendMessage({ type: "draft_reply", thread, url: location.href });
    const prev = btn.textContent;
    btn.textContent = WM.opening;
    setTimeout(() => (btn.textContent = prev), 2500);
  }

  // Floating fallback button (used on non-Gmail webmails, or if the inline slot
  // can't be found on Gmail).
  function injectWebmailButton() {
    if (document.getElementById("__ai_reply_fab")) return;
    const btn = document.createElement("button");
    btn.id = "__ai_reply_fab";
    btn.type = "button";
    btn.textContent = WM.reply;
    btn.setAttribute("aria-label", WM.aria);
    Object.assign(btn.style, {
      position: "fixed", right: "18px", bottom: "18px", zIndex: 2147483647,
      padding: "10px 14px", borderRadius: "999px", border: "0",
      background: "linear-gradient(135deg,#6366f1 0%,#8b5cf6 55%,#a855f7 100%)",
      color: "#fff", font: "600 13px system-ui, sans-serif",
      boxShadow: "0 4px 14px rgba(124,58,237,.35)", cursor: "pointer",
    });
    btn.addEventListener("click", () => onReplyClick(btn));
    document.documentElement.appendChild(btn);
  }

  // Gmail: place the button INLINE in the bottom action row of an open email, right
  // after Reply / Forward / the emoji-reaction buttons (instead of a corner FAB).
  function findGmailActionRow() {
    const wants = ["reply", "reply all", "forward", "répondre", "repondre", "répondre à tous", "transférer", "transferer"];
    for (const b of document.querySelectorAll('[role="button"]')) {
      const label = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("data-tooltip") || "")).trim().toLowerCase();
      if (!label) continue;
      if (wants.some((w) => label === w || label.startsWith(w))) {
        const row = b.parentElement;
        // Sanity: the bottom action row groups several buttons together.
        if (row && row.querySelectorAll('[role="button"]').length >= 2 && row.offsetParent) return row;
      }
    }
    return null;
  }
  function injectGmailInline() {
    const existing = document.getElementById("__ai_reply_inline");
    if (existing && document.body.contains(existing) && existing.offsetParent) return true;
    const row = findGmailActionRow();
    if (!row) return false;
    const btn = document.createElement("button");
    btn.id = "__ai_reply_inline";
    btn.type = "button";
    btn.textContent = WM.reply;
    btn.setAttribute("aria-label", WM.aria);
    Object.assign(btn.style, {
      marginLeft: "8px", padding: "8px 14px", borderRadius: "18px", border: "0",
      background: "linear-gradient(135deg,#6366f1,#8b5cf6 55%,#a855f7)", color: "#fff",
      font: "500 14px 'Google Sans', Roboto, system-ui, sans-serif", cursor: "pointer",
      verticalAlign: "middle", lineHeight: "1",
    });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onReplyClick(btn); });
    row.appendChild(btn);
    const fab = document.getElementById("__ai_reply_fab"); // drop the corner fallback
    if (fab) fab.remove();
    return true;
  }
  let gmailObserver = null;
  function setupGmail() {
    injectGmailInline();
    if (gmailObserver) return;
    gmailObserver = new MutationObserver(() => {
      clearTimeout(gmailObserver._t);
      gmailObserver._t = setTimeout(injectGmailInline, 350);
    });
    gmailObserver.observe(document.body, { childList: true, subtree: true });
    // If we never find the inline slot, fall back to the corner button.
    setTimeout(() => { if (!document.getElementById("__ai_reply_inline")) injectWebmailButton(); }, 4000);
  }

  function maybeSetupWebmail() {
    if (!isWebmail()) return;
    const go = (s) => {
      if (s && s.webmailAssist === false) return;
      WM = WEBMAIL_I18N[(s && s.uiLang) === "fr" ? "fr" : "en"];
      if (IS_GMAIL) setupGmail();
      else injectWebmailButton();
    };
    try { browser.storage.local.get(["webmailAssist", "uiLang"]).then(go); } catch (_) { go({}); }
  }
  maybeSetupWebmail();
})();
