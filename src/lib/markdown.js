// Markdown rendering (marked + DOMPurify) and "artifacts" (HTML/SVG preview,
// Mermaid diagrams). Artifacts run inside sandboxed iframes (opaque origin): the
// model-generated code can reach neither the extension, the pages, nor the API
// keys — and the extension's CSP does not constrain it there.
//
// marked and DOMPurify are loaded as globals via <script> in sidebar.html.

let afCounter = 0;
let mermaidLibPromise = null;

function getMermaidLib() {
  if (!mermaidLibPromise) {
    mermaidLibPromise = fetch(browser.runtime.getURL("vendor/mermaid.min.js")).then((r) =>
      r.text()
    );
  }
  return mermaidLibPromise;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Resize artifact iframes that report their own height.
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.__artifact) {
    const f = document.querySelector(`iframe[data-aid="${d.id}"]`);
    if (f) f.style.height = Math.min(d.h + 8, 900) + "px";
  }
});

export function configureMarkdown() {
  if (window.marked && window.marked.setOptions) {
    window.marked.setOptions({ gfm: true, breaks: true });
  }
  // Links: open in a new tab with a safe rel.
  if (window.DOMPurify) {
    window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
}

export function renderMarkdown(raw) {
  const html = window.marked ? window.marked.parse(raw || "") : escapeHtml(raw || "");
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
}

const REPORTER = (id) =>
  `<script>function __r(){try{parent.postMessage({__artifact:1,id:${JSON.stringify(
    id
  )},h:document.documentElement.scrollHeight},'*')}catch(e){}}` +
  `window.addEventListener('load',function(){__r();setTimeout(__r,300);setTimeout(__r,1200)});<\/script>`;

function makeFrame(srcdoc, { allowScripts, initialHeight }) {
  const id = "af" + ++afCounter;
  const f = document.createElement("iframe");
  f.className = "artifact-frame";
  f.dataset.aid = id;
  f.setAttribute("sandbox", allowScripts ? "allow-scripts" : "");
  f.style.height = (initialHeight || 160) + "px";
  f.srcdoc = srcdoc;
  return f;
}

async function renderMermaid(slot, code) {
  slot.textContent = "Rendu du diagramme…";
  const lib = await getMermaidLib();
  // makeFrame will bump afCounter to this id; the reporter uses the same one.
  const id = "af" + (afCounter + 1);
  const srcdoc =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<style>body{margin:0;padding:10px;font-family:system-ui;background:#fff;color:#111}` +
    `.err{color:#b00;font-size:13px}</style>` +
    `<script>${lib}<\/script></head><body>` +
    `<pre class="mermaid">${escapeHtml(code)}</pre>` +
    `<script>mermaid.initialize({startOnLoad:false,securityLevel:'strict'});` +
    `mermaid.run().catch(function(e){document.body.innerHTML='<div class=err>Erreur Mermaid : '+` +
    `(e&&e.message?e.message:e)+'</div>';});<\/script>` +
    REPORTER(id) +
    `</body></html>`;
  const f = makeFrame(srcdoc, { allowScripts: true, initialHeight: 200 });
  slot.textContent = "";
  slot.appendChild(f);
}

function renderHtmlPreview(slot, code, lang) {
  const id = "af" + (afCounter + 1);
  if (lang === "svg") {
    const srcdoc =
      `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<style>body{margin:0;padding:10px;background:#fff}</style></head><body>` +
      code +
      `</body></html>`;
    // SVG: no scripts -> empty sandbox; fixed height + manual CSS resize.
    const f = makeFrame(srcdoc, { allowScripts: false, initialHeight: 240 });
    slot.textContent = "";
    slot.appendChild(f);
    return;
  }
  // HTML: executed (sandbox allow-scripts) only after an explicit user click.
  const srcdoc = code + REPORTER(id);
  const f = makeFrame(srcdoc, { allowScripts: true, initialHeight: 200 });
  slot.textContent = "";
  slot.appendChild(f);
}

function toolbarButton(label, onClick) {
  const b = document.createElement("button");
  b.className = "code-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// Turn <pre><code> blocks into toolbar'd blocks + artifacts.
export function enhanceArtifacts(container) {
  const codes = container.querySelectorAll("pre > code");
  for (const code of codes) {
    const pre = code.parentElement;
    if (pre.dataset.enhanced) continue;
    pre.dataset.enhanced = "1";

    const lang = ([...code.classList].find((c) => c.startsWith("language-")) || "").slice(9);

    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const tag = document.createElement("span");
    tag.className = "code-lang";
    tag.textContent = lang || "code";
    bar.appendChild(tag);

    const slot = document.createElement("div");
    slot.className = "artifact-slot";

    if (lang === "html" || lang === "svg") {
      bar.appendChild(
        toolbarButton("Aperçu", () => renderHtmlPreview(slot, code.textContent, lang))
      );
    }

    const copy = toolbarButton("Copier", () => {
      navigator.clipboard.writeText(code.textContent).then(() => {
        copy.textContent = "Copié ✓";
        setTimeout(() => (copy.textContent = "Copier"), 1500);
      });
    });
    bar.appendChild(copy);

    pre.replaceWith(wrap);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
    wrap.appendChild(slot);

    // Mermaid: rendered automatically (that's the whole point).
    if (lang === "mermaid") {
      pre.style.display = "none";
      renderMermaid(slot, code.textContent);
    }
  }
}
