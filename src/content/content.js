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

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg && msg.type) {
      case "read_page":
        return Promise.resolve(readPage());
      case "read_selection":
        return Promise.resolve(readSelection());
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

  function injectWebmailButton() {
    if (document.getElementById("__ai_reply_fab")) return;
    const btn = document.createElement("button");
    btn.id = "__ai_reply_fab";
    btn.type = "button";
    btn.textContent = "✨ Répondre avec l'IA";
    btn.setAttribute("aria-label", "Rédiger une réponse assistée par IA");
    Object.assign(btn.style, {
      position: "fixed", right: "18px", bottom: "18px", zIndex: 2147483647,
      padding: "10px 14px", borderRadius: "999px", border: "0",
      background: "#c8643c", color: "#fff", font: "600 13px system-ui, sans-serif",
      boxShadow: "0 4px 14px rgba(0,0,0,.25)", cursor: "pointer",
    });
    btn.addEventListener("click", () => {
      const thread = readThread();
      // Hand the thread to the sidebar via a pending action; it drafts a reply.
      browser.runtime.sendMessage({ type: "draft_reply", thread, url: location.href });
      btn.textContent = "✓ Ouvre la sidebar…";
      setTimeout(() => (btn.textContent = "✨ Répondre avec l'IA"), 2500);
    });
    document.documentElement.appendChild(btn);
  }

  function maybeSetupWebmail() {
    if (!isWebmail()) return;
    try {
      browser.storage.local.get("webmailAssist").then((s) => {
        if (s.webmailAssist === false) return;
        injectWebmailButton();
      });
    } catch (_) {
      injectWebmailButton();
    }
  }
  maybeSetupWebmail();
})();
