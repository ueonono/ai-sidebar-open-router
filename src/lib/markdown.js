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

function makeFrame(srcdoc, { sandbox, initialHeight }) {
  const id = "af" + ++afCounter;
  const f = document.createElement("iframe");
  f.className = "artifact-frame";
  f.dataset.aid = id;
  // Artifacts run in a sandboxed iframe (opaque origin): isolated from the
  // extension, the visited pages and the user's API keys. We deliberately do NOT
  // grant allow-same-origin. For interactive apps/games we allow scripts, modals,
  // pointer lock and popups so they behave like real apps.
  f.setAttribute("sandbox", sandbox || "");
  f.style.height = (initialHeight || 160) + "px";
  f.srcdoc = srcdoc;
  return f;
}

// Interactive languages = real Claude-style artifacts the user can USE/PLAY.
const INTERACTIVE = ["html", "jsx", "tsx", "react", "babel"];
const GAME_SANDBOX = "allow-scripts allow-modals allow-pointer-lock allow-popups allow-forms";

// Wrap a bare HTML fragment into a full document; pass full documents through.
function asHtmlDocument(code) {
  if (/<!doctype/i.test(code) || /<html[\s>]/i.test(code)) return code;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>body{margin:0;font-family:system-ui;background:#fff;color:#111}</style></head>` +
    `<body>${code}</body></html>`
  );
}

// React/JSX artifact runtime, à la Claude: React + ReactDOM + Babel transpile the
// component in-browser, inside the sandboxed iframe. The libraries are fetched by
// the isolated iframe only (not by the extension) and only when such an artifact
// is shown. The model is asked to define a component named `App`.
function reactShell(code, id) {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>body{margin:0;font-family:system-ui;background:#fff;color:#111}#root{min-height:40px}` +
    `.err{color:#b00;padding:10px;white-space:pre-wrap;font:12px ui-monospace}</style>` +
    `<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>` +
    `<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>` +
    `<script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>` +
    `</head><body><div id="root"></div>` +
    `<script type="text/babel" data-presets="react">\n${code}\n` +
    `;(function(){try{var C=(typeof App!=='undefined')?App:(typeof Component!=='undefined'?Component:null);` +
    `var r=document.getElementById('root');if(C&&!r.hasChildNodes()){ReactDOM.createRoot(r).render(React.createElement(C));}}` +
    `catch(e){document.body.innerHTML='<div class=err>'+(e&&e.message?e.message:e)+'</div>';}})();<\/script>` +
    REPORTER(id) +
    `</body></html>`
  );
}

// Build the full artifact document for a given language.
function buildArtifactDoc(code, lang, id) {
  if (lang === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:10px;background:#fff}</style></head><body>${code}${REPORTER(id)}</body></html>`;
  }
  if (lang === "jsx" || lang === "tsx" || lang === "react" || lang === "babel") {
    return reactShell(code, id);
  }
  // html (interactive app / game)
  return asHtmlDocument(code) + REPORTER(id);
}

function renderPreview(slot, code, lang) {
  const id = "af" + (afCounter + 1);
  const srcdoc = buildArtifactDoc(code, lang, id);
  const sandbox = lang === "svg" ? "" : GAME_SANDBOX;
  const initialHeight = lang === "svg" ? 260 : 380;
  const f = makeFrame(srcdoc, { sandbox, initialHeight });
  slot.textContent = "";
  slot.appendChild(f);
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
  const f = makeFrame(srcdoc, { sandbox: "allow-scripts", initialHeight: 200 });
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

// Open an artifact full-size in a new tab (its own blob: origin, fully isolated).
function openArtifact(code, lang) {
  const doc = buildArtifactDoc(code, lang, "open");
  const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function artifactLabel(lang) {
  if (lang === "mermaid") return "✨ Diagramme";
  if (lang === "svg") return "✨ SVG";
  if (INTERACTIVE.includes(lang)) return "✨ Artifact interactif";
  return lang || "code";
}

// Turn <pre><code> blocks into toolbar'd code blocks and Claude-style artifacts.
// Interactive HTML/JSX render automatically inside a sandboxed iframe the user can
// actually use and PLAY (games, apps, simulations), with an Aperçu/Code toggle and
// an "Ouvrir" button for full screen. Mermaid renders diagrams; other languages
// stay as a copyable code block.
export function enhanceArtifacts(container) {
  const codes = container.querySelectorAll("pre > code");
  for (const code of codes) {
    const pre = code.parentElement;
    if (pre.dataset.enhanced) continue;
    pre.dataset.enhanced = "1";

    const lang = ([...code.classList].find((c) => c.startsWith("language-")) || "").slice(9);
    const isPreviewable = INTERACTIVE.includes(lang) || lang === "svg";
    const isArtifact = isPreviewable || lang === "mermaid";

    const wrap = document.createElement("div");
    wrap.className = isArtifact ? "code-wrap artifact" : "code-wrap";
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const tag = document.createElement("span");
    tag.className = "code-lang";
    tag.textContent = artifactLabel(lang);
    bar.appendChild(tag);

    const slot = document.createElement("div");
    slot.className = "artifact-slot";

    if (isPreviewable) {
      // Auto-render the live artifact; offer a toggle back to the source code.
      renderPreview(slot, code.textContent, lang);
      pre.style.display = "none";
      const toggle = toolbarButton("</> Code", () => {
        const showingCode = pre.style.display !== "none";
        pre.style.display = showingCode ? "none" : "";
        slot.style.display = showingCode ? "" : "none";
        toggle.textContent = showingCode ? "</> Code" : "👁 Aperçu";
      });
      bar.appendChild(toggle);
      bar.appendChild(toolbarButton("⤢ Ouvrir", () => openArtifact(code.textContent, lang)));
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

    if (lang === "mermaid") {
      pre.style.display = "none";
      renderMermaid(slot, code.textContent);
    }
  }
}
