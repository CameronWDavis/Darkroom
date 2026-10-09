// The Edit PDF workspace. Documents are opened, edited, undone and saved by
// PdfCraft's engine (./pkg, built from ../../pdf), which this module loads the
// first time the workspace opens. Geometry exchanged with the engine is in
// "view space": PDF points from the top-left of the displayed page, y down.
// Nothing here touches storage or the network beyond loading the engine.

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const MAX_PDF_BYTES = 500 * 1024 * 1024;
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];

let mod = null, studio = null, loading = null;
const docs = new Map();      // id -> { state, version, text: Map(page -> layer) }
let activeId = null;
let zoomMode = "fit", zoom = 1;
let tool = "select", task = "comment";
let selectedPages = new Set(), anchorPage = 0, currentPage = 0;
let selectedComment = null;  // { page, index }
let found = { hits: [], current: -1 };
let textSel = null;          // { page, from, to }
let signature = null;        // { kind: "drawn", strokes } | { kind: "typed", text }
let gesture = null;
let editor = null;           // inline text editor on a page
let spaceDown = false;

const active = () => docs.get(activeId);
const pages = () => active()?.state.pages ?? [];

// --- messages -------------------------------------------------------------------

let toastTimer;
function say(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg; t.classList.toggle("bad", bad); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 7000 : 4200);
}
function fail(e) { say(typeof e === "string" ? e : e?.message || String(e), true); console.error(e); }

// --- engine ------------------------------------------------------------------------

async function ensureEngine() {
  if (studio) return true;
  const note = $("p-empty").querySelector(".dim"), idle = note.textContent;
  note.textContent = "Loading the PDF engine…";
  loading ??= (async () => {
    const m = await import("./pkg/darkroom_pdf.js");
    await m.default();
    mod = m; studio = new m.PdfStudio();
  })();
  try { await loading; note.textContent = idle; return true; }
  catch (e) {
    loading = null; console.error(e);
    say("The PDF engine isn't built. Build it with wasm-bindgen into web/pdf/pkg (see README).", true);
    return false;
  }
}

/** Runs an engine call that returns new state JSON, then shows it. */
function run(fn) {
  const d = active(); if (!d) return false;
  try { setState(JSON.parse(fn(d.state.id))); return true; }
  catch (e) { fail(e); return false; }
}
const edit = (op) => run((id) => studio.edit(id, JSON.stringify(op)));

function setState(state) {
  const d = docs.get(state.id);
  const before = d.state;
  d.state = state; d.version++; d.text.clear();
  const reshaped = before.pages.length !== state.pages.length || before.pages.some((p, i) => p.w !== state.pages[i].w || p.h !== state.pages[i].h);
  for (const p of [...selectedPages]) if (p >= state.pages.length) selectedPages.delete(p);
  if (selectedComment && !state.comments.some((c) => c.page === selectedComment.page && c.index === selectedComment.index)) selectedComment = null;
  if (state.id === activeId) {
    if (reshaped) buildPages(); else refreshPages();
    syncChrome();
  }
  renderTabs();
}

// --- documents -----------------------------------------------------------------------

async function openFiles(files) {
  if (!(await ensureEngine())) return;
  let opened = 0;
  for (const f of files) {
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) continue;
    if (f.size > MAX_PDF_BYTES) { fail(`'${f.name}' is larger than the 500 MB PDF limit.`); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const state = await openWithPassword(f.name, bytes);
    if (!state) continue;
    docs.set(state.id, { state, version: 0, text: new Map() });
    activate(state.id); opened++;
    if (!state.editable) say(`${f.name} opened read-only: ${state.read_only_reason || "its permissions don't allow changes"}.`);
  }
  if (opened > 1) say(`Opened ${opened} PDFs.`);
}

async function openWithPassword(name, bytes) {
  let password;
  for (;;) {
    try { return JSON.parse(studio.open(name, bytes, password)); }
    catch (e) {
      const m = String(e?.message || e);
      if (m !== "password-required" && m !== "password-wrong") { fail(`${name}: ${m}`); return null; }
      password = await askPassword(name, m === "password-wrong");
      if (password === null) return null;
    }
  }
}

function askPassword(name, wrong) {
  return new Promise((resolve) => {
    const dlg = $("p-password");
    $("p-password-msg").textContent = wrong ? `That password didn't open ${name}. Try again.` : `${name} is protected. Enter its password to open it.`;
    $("p-password-input").value = "";
    const done = (v) => { dlg.close(); $("p-password-ok").onclick = $("p-password-cancel").onclick = null; resolve(v); };
    $("p-password-ok").onclick = () => done($("p-password-input").value);
    $("p-password-cancel").onclick = () => done(null);
    dlg.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); done($("p-password-input").value); } };
    dlg.oncancel = (e) => { e.preventDefault(); done(null); };
    dlg.showModal(); $("p-password-input").focus();
  });
}

function activate(id) {
  activeId = id;
  selectedPages = new Set(id === null ? [] : [0]); anchorPage = 0; currentPage = 0;
  selectedComment = null; found = { hits: [], current: -1 }; textSel = null; closeEditor(false);
  $("p-results").replaceChildren(); $("p-find-count").textContent = "";
  buildPages(); syncChrome(); renderTabs();
  $("p-scroll").scrollTop = 0;
}

function closeDoc(id) {
  const d = docs.get(id);
  if (d?.state.dirty && !confirm(`Close ${d.state.name} without saving your changes?`)) return;
  studio.close(id); docs.delete(id);
  activate(docs.size ? [...docs.keys()].at(-1) : null);
}

function renderTabs() {
  const tabs = $("p-tabs"); tabs.replaceChildren();
  for (const [id, d] of docs) {
    const tab = document.createElement("div");
    tab.className = "p-tab"; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(id === activeId));
    const name = document.createElement("span"); name.textContent = d.state.name; name.classList.toggle("dirty", d.state.dirty);
    const x = document.createElement("button"); x.className = "x"; x.textContent = "×"; x.setAttribute("aria-label", `Close ${d.state.name}`);
    x.onclick = (e) => { e.stopPropagation(); closeDoc(id); };
    tab.onclick = () => { if (id !== activeId) activate(id); };
    tab.append(name, x); tabs.append(tab);
  }
}

$("p-open").onclick = () => $("p-file").click();
$("p-file").onchange = (e) => { const files = [...e.target.files]; e.target.value = ""; openFiles(files); };
$("p-new").onclick = async () => {
  if (!(await ensureEngine())) return;
  try {
    const state = JSON.parse(studio.blank(`Untitled ${docs.size + 1}.pdf`, 612, 792, 1));
    docs.set(state.id, { state, version: 0, text: new Map() }); activate(state.id);
  } catch (e) { fail(e); }
};

/** Saves to a location the user picks, or downloads where the API is missing. */
async function putFile(blob, suggestedName) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }] });
      const w = await handle.createWritable(); await w.write(blob); await w.close(); return true;
    } catch (e) { if (e.name === "AbortError") return false; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = suggestedName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
const pdfName = (name, suffix = "") => name.replace(/\.pdf$/i, "") + suffix + ".pdf";

async function save() {
  const d = active(); if (!d) return;
  closeEditor(true);
  let bytes;
  try { bytes = studio.save(d.state.id); setState(JSON.parse(studio.state(d.state.id))); } catch (e) { return fail(e); }
  if (await putFile(new Blob([bytes], { type: "application/pdf" }), pdfName(d.state.name))) say(`Saved ${d.state.name}.`);
}
$("p-save").onclick = save;

// --- pages in the viewer --------------------------------------------------------------

let pageEls = [], observer = null, thumbObserver = null;
const visible = new Set(), thumbsVisible = new Set();
let renderQueued = false;

function computeZoom() {
  const list = pages(); if (!list.length) return;
  const scroll = $("p-scroll"), avail = Math.max(100, scroll.clientWidth - 64);
  const widest = Math.max(...list.map((p) => p.w));
  if (zoomMode === "fit") zoom = avail / widest;
  else if (zoomMode === "page") {
    const p = list[currentPage] || list[0];
    zoom = Math.min(avail / p.w, Math.max(100, scroll.clientHeight - 64) / p.h);
  } else zoom = Number(zoomMode);
  zoom = clamp(zoom, 0.1, 8);
}

function buildPages() {
  const host = $("p-pages"); host.replaceChildren(); pageEls = []; visible.clear();
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) { const i = Number(e.target.dataset.page); e.isIntersecting ? visible.add(i) : visible.delete(i); }
    queueRender(); trackCurrentPage();
  }, { root: $("p-scroll"), rootMargin: "600px 0px" });
  $("p-empty").hidden = !!active();
  computeZoom();
  pages().forEach((p, i) => {
    const el = document.createElement("div"); el.className = "p-page"; el.dataset.page = i;
    const label = document.createElement("span"); label.className = "p-label"; label.textContent = `${p.label}`;
    const canvas = document.createElement("canvas"); canvas.className = "p-raster";
    const layer = document.createElement("div"); layer.className = "p-layer";
    el.append(label, canvas, layer); host.append(el); pageEls.push(el);
    observer.observe(el);
  });
  sizePages(); buildThumbs(); refreshOverlays();
}

function sizePages() {
  pages().forEach((p, i) => { const el = pageEls[i]; el.style.width = `${p.w * zoom}px`; el.style.height = `${p.h * zoom}px`; el.dataset.rendered = ""; });
  $("p-zoom").value = zoomMode;
  if (![...$("p-zoom").options].some((o) => o.value === zoomMode)) $("p-zoom").value = "";
  queueRender(); refreshOverlays();
}

/** New content on the same pages: redraw what is shown, keep the scroll position. */
function refreshPages() {
  for (const el of pageEls) el.dataset.rendered = "";
  for (const t of $("p-thumbs").children) t.dataset.rendered = "";
  pages().forEach((p, i) => { const label = pageEls[i]?.querySelector(".p-label"); if (label) label.textContent = p.label; });
  renderThumbLabels(); queueRender(); refreshOverlays();
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderSome(); });
}

/** Draws one stale page (visible ones first) per frame, so the UI stays responsive. */
function renderSome() {
  const d = active(); if (!d) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), key = `${d.version}@${zoom * dpr}`;
  const order = [...visible].sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage));
  const page = order.find((i) => pageEls[i]?.dataset.rendered !== key);
  if (page !== undefined) {
    paint(pageEls[page].querySelector("canvas"), d.state.id, page, zoom * dpr);
    pageEls[page].dataset.rendered = key;
    return queueRender();
  }
  const thumbs = $("p-thumbs").children;
  const t = [...thumbsVisible].find((i) => thumbs[i] && thumbs[i].dataset.rendered !== String(d.version));
  if (t !== undefined) {
    const p = pages()[t];
    paint(thumbs[t].querySelector("canvas"), d.state.id, t, Math.min(150 / p.w, 190 / p.h) * dpr);
    thumbs[t].dataset.rendered = String(d.version);
    queueRender();
  }
}

function paint(canvas, id, page, scale) {
  let bytes;
  try { bytes = studio.render(id, page, scale); } catch (e) { return fail(e); }
  const head = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const w = head.getUint32(0, true), h = head.getUint32(4, true);
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, w * h * 4), w, h), 0, 0);
}

function trackCurrentPage() {
  const scroll = $("p-scroll"), mid = scroll.scrollTop + scroll.clientHeight * 0.35;
  let best = 0;
  pageEls.forEach((el, i) => { if (el.offsetTop <= mid) best = i; });
  if (best !== currentPage) { currentPage = best; renderThumbLabels(); }
  $("p-pageno").value = pages().length ? currentPage + 1 : 0;
}
$("p-scroll").addEventListener("scroll", () => requestAnimationFrame(trackCurrentPage), { passive: true });

function goToPage(i, rect) {
  const el = pageEls[i]; if (!el) return;
  const scroll = $("p-scroll");
  scroll.scrollTop = el.offsetTop - 24 + (rect ? rect[1] * zoom - scroll.clientHeight / 3 : 0);
  if (rect) scroll.scrollLeft = el.offsetLeft + rect[0] * zoom - scroll.clientWidth / 3;
  currentPage = i; renderThumbLabels(); $("p-pageno").value = i + 1;
}
$("p-pageno").onchange = (e) => goToPage(clamp((Number(e.target.value) || 1) - 1, 0, pages().length - 1));

function setZoom(mode, anchor) {
  const scroll = $("p-scroll"), before = zoom;
  const fx = (scroll.scrollLeft + (anchor?.x ?? scroll.clientWidth / 2)) / before;
  const fy = (scroll.scrollTop + (anchor?.y ?? scroll.clientHeight / 2)) / before;
  zoomMode = String(mode); computeZoom(); sizePages();
  scroll.scrollLeft = fx * zoom - (anchor?.x ?? scroll.clientWidth / 2);
  scroll.scrollTop = fy * zoom - (anchor?.y ?? scroll.clientHeight / 2);
}
const zoomStep = (dir) => {
  const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 1e-3) : [...ZOOMS].reverse().find((z) => z < zoom - 1e-3);
  if (next) setZoom(next);
};
$("p-zoom").onchange = (e) => setZoom(e.target.value);
$("p-zoom-in").onclick = () => zoomStep(1);
$("p-zoom-out").onclick = () => zoomStep(-1);
$("p-scroll").addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !active()) return;
  e.preventDefault();
  const r = $("p-scroll").getBoundingClientRect(), anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
  const next = e.deltaY < 0 ? ZOOMS.find((z) => z > zoom + 1e-3) : [...ZOOMS].reverse().find((z) => z < zoom - 1e-3);
  if (next) setZoom(next, anchor);
}, { passive: false });
window.addEventListener("resize", () => { if (!$("pdf-workspace").hidden && active() && (zoomMode === "fit" || zoomMode === "page")) { computeZoom(); sizePages(); } });

// --- thumbnails & organizing -------------------------------------------------------------

function buildThumbs() {
  const list = $("p-thumbs"); list.replaceChildren(); thumbsVisible.clear();
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) { const i = Number(e.target.dataset.page); e.isIntersecting ? thumbsVisible.add(i) : thumbsVisible.delete(i); }
    queueRender();
  }, { root: list.closest(".panel"), rootMargin: "300px 0px" });
  pages().forEach((p, i) => {
    const li = document.createElement("li"); li.className = "p-thumb"; li.dataset.page = i; li.draggable = true;
    li.setAttribute("role", "option");
    const c = document.createElement("canvas"), s = Math.min(150 / p.w, 190 / p.h);
    c.style.width = `${p.w * s}px`; c.style.height = `${p.h * s}px`;
    const label = document.createElement("span");
    li.append(c, label); list.append(li); thumbObserver.observe(li);
    li.onclick = (e) => selectPage(i, e);
    li.ondblclick = () => goToPage(i);
    li.ondragstart = (e) => { if (!selectedPages.has(i)) selectPage(i, {}); e.dataTransfer.setData("text/x-pdf-pages", "1"); e.dataTransfer.effectAllowed = "move"; };
    li.ondragover = (e) => {
      if (!e.dataTransfer.types.includes("text/x-pdf-pages")) return;
      e.preventDefault();
      const after = e.offsetY > li.clientHeight / 2;
      li.classList.toggle("drop-after", after); li.classList.toggle("drop-before", !after);
    };
    li.ondragleave = () => li.classList.remove("drop-after", "drop-before");
    li.ondrop = (e) => {
      e.preventDefault(); li.classList.remove("drop-after", "drop-before");
      movePages(e.offsetY > li.clientHeight / 2 ? i + 1 : i);
    };
  });
  renderThumbLabels();
}

function renderThumbLabels() {
  [...$("p-thumbs").children].forEach((li, i) => {
    li.querySelector("span").textContent = `${pages()[i]?.label ?? i + 1}`;
    li.setAttribute("aria-selected", String(selectedPages.has(i)));
    li.classList.toggle("current", i === currentPage);
  });
}

function selectPage(i, e) {
  if (e.shiftKey) {
    const [a, b] = [Math.min(anchorPage, i), Math.max(anchorPage, i)];
    selectedPages = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
  } else if (e.ctrlKey || e.metaKey) {
    selectedPages.has(i) && selectedPages.size > 1 ? selectedPages.delete(i) : selectedPages.add(i);
    anchorPage = i;
  } else { selectedPages = new Set([i]); anchorPage = i; goToPage(i); }
  renderThumbLabels();
}

const chosen = () => [...selectedPages].sort((a, b) => a - b);
function movePages(to) {
  const list = chosen(); if (!list.length) return;
  if (edit({ op: "move", pages: list, to })) {
    // Keep the moved pages selected where they landed.
    const before = list.filter((p) => p < to).length, start = to - before;
    selectedPages = new Set(list.map((_, k) => start + k)); anchorPage = start; renderThumbLabels();
  }
}
$("p-rot-l").onclick = () => edit({ op: "rotate", pages: chosen(), degrees: -90 });
$("p-rot-r").onclick = () => edit({ op: "rotate", pages: chosen(), degrees: 90 });
$("p-del").onclick = () => { if (edit({ op: "delete", pages: chosen() })) { selectedPages = new Set([Math.min(chosen()[0] ?? 0, pages().length - 1)]); renderThumbLabels(); } };
$("p-dup").onclick = () => edit({ op: "duplicate", pages: chosen() });
$("p-blank").onclick = () => edit({ op: "insert_blank", at: (chosen().at(-1) ?? pages().length - 1) + 1 });
$("p-up").onclick = () => { const l = chosen(); if (l[0] > 0) movePages(l[0] - 1); };
$("p-down").onclick = () => { const l = chosen(); if (l.at(-1) < pages().length - 1) movePages(l.at(-1) + 2); };
$("p-insert").onclick = () => $("p-insert-file").click();
$("p-insert-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !active()) return;
  const bytes = new Uint8Array(await f.arrayBuffer()), at = (chosen().at(-1) ?? pages().length - 1) + 1;
  let password;
  for (;;) {
    try { setState(JSON.parse(studio.insert_pdf(activeId, f.name, bytes, at, password))); say(`Inserted ${f.name}.`); return; }
    catch (err) {
      const m = String(err?.message || err);
      if (!/password|encrypt/i.test(m)) return fail(m);
      password = await askPassword(f.name, password !== undefined);
      if (password === null) return;
    }
  }
};
$("p-extract").onclick = async () => {
  const d = active(); if (!d) return;
  try {
    const list = chosen(), bytes = studio.extract(d.state.id, Uint32Array.from(list));
    const label = list.length === 1 ? `-page-${list[0] + 1}` : `-pages-${list[0] + 1}-${list.at(-1) + 1}`;
    if (await putFile(new Blob([bytes], { type: "application/pdf" }), pdfName(d.state.name, label))) say(`Extracted ${list.length} page${list.length > 1 ? "s" : ""}.`);
  } catch (e) { fail(e); }
};
$("p-split").onclick = async () => {
  const d = active(); if (!d) return;
  const n = clamp(Number($("p-split-n").value) || 1, 1, 999), total = pages().length;
  const parts = Math.ceil(total / n);
  if (parts > 50) return say("That would make more than 50 files. Choose a larger number of pages per file.", true);
  // The browser downloads each part; the file picker would ask once per file.
  const picker = window.showSaveFilePicker; window.showSaveFilePicker = undefined;
  try {
    for (let k = 0; k < parts; k++) {
      const list = Array.from({ length: Math.min(n, total - k * n) }, (_, j) => k * n + j);
      await putFile(new Blob([studio.extract(d.state.id, Uint32Array.from(list))], { type: "application/pdf" }), pdfName(d.state.name, `-part-${k + 1}`));
      await new Promise((r) => setTimeout(r, 250));
    }
    say(`Split into ${parts} file${parts > 1 ? "s" : ""}.`);
  } catch (e) { fail(e); } finally { window.showSaveFilePicker = picker; }
};

// --- overlays: comments, fields, search hits, text selection -------------------------------

function refreshOverlays() {
  pageEls.forEach((el, i) => drawOverlay(i));
  renderComments(); renderSelected();
}

const place = (el, r) => Object.assign(el.style, { left: `${r[0] * zoom}px`, top: `${r[1] * zoom}px`, width: `${Math.max(2, (r[2] - r[0]) * zoom)}px`, height: `${Math.max(2, (r[3] - r[1]) * zoom)}px` });

function drawOverlay(i) {
  const layer = pageEls[i]?.querySelector(".p-layer"), d = active(); if (!layer || !d) return;
  const keep = editor?.page === i ? editor.el : null;
  layer.replaceChildren(...(keep ? [keep] : []));
  if (keep) placeEditor();
  const st = d.state, selecting = tool === "select";
  found.hits.forEach((h, k) => {
    if (h.page !== i) return;
    for (const r of h.rects) { const div = document.createElement("div"); div.className = "p-hl" + (k === found.current ? " current" : ""); place(div, r); layer.append(div); }
  });
  if (textSel?.page === i) for (const r of selectionRects(i)) { const div = document.createElement("div"); div.className = "p-sel"; place(div, r); layer.append(div); }
  for (const c of st.comments) {
    if (c.page !== i || c.reply_to || !c.rect) continue;
    const box = document.createElement("div"); box.className = "p-cmt"; place(box, c.rect);
    box.classList.toggle("selected", selectedComment?.page === i && selectedComment.index === c.index);
    box.style.pointerEvents = selecting ? "auto" : "none";
    box.title = [c.type, c.contents].filter(Boolean).join(": ");
    box.dataset.index = c.index;
    layer.append(box);
  }
  for (const f of st.fields) for (const w of f.widgets) if (w.page === i && !w.hidden) layer.append(fieldInput(f, w, selecting && st.allows.fill));
}

function fieldInput(f, w, enabled) {
  let el;
  const value = f.value[0] ?? "";
  const size = Math.max(7, Math.min(14, (w.rect[3] - w.rect[1]) * 0.7)) * zoom;
  if (f.kind === "checkbox" || f.kind === "radio") {
    el = document.createElement("input"); el.type = f.kind;
    if (f.kind === "radio") { el.name = `p-${activeId}-${f.name}`; el.checked = !!w.on && value === w.on; }
    else el.checked = !!value && value !== "Off";
    el.onchange = () => edit({ op: "field", name: f.name, value: f.kind === "radio" ? w.on : el.checked });
  } else if (f.kind === "combo" || f.kind === "list") {
    el = document.createElement("select");
    el.append(new Option("", ""));
    for (const [exp, shown] of f.options) el.append(new Option(shown || exp, exp));
    el.value = value;
    el.onchange = () => edit({ op: "field", name: f.name, value: el.value });
  } else if (f.kind === "text") {
    el = document.createElement(f.multiline ? "textarea" : "input");
    el.value = value; if (f.max_len) el.maxLength = f.max_len;
    el.onchange = () => edit({ op: "field", name: f.name, value: el.value });
    el.onkeydown = (e) => { if (e.key === "Enter" && !f.multiline) el.blur(); e.stopPropagation(); };
  } else if (f.kind === "signature") {
    el = document.createElement("button"); el.type = "button"; el.title = "Click to sign here";
    el.onclick = () => signAt(w.page, [w.rect[0] + 2, (w.rect[1] + w.rect[3]) / 2], w.rect);
  } else return document.createTextNode("");
  el.className = "p-field"; place(el, w.rect);
  el.style.fontSize = `${size}px`;
  el.title = f.tooltip || f.name;
  el.disabled = !enabled || f.read_only;
  el.style.pointerEvents = enabled ? "auto" : "none";
  el.setAttribute("aria-label", f.tooltip || f.name);
  return el;
}

// --- text layer ------------------------------------------------------------------------------

function textOf(page) {
  const d = active(); if (!d) return null;
  if (!d.text.has(page)) {
    try { d.text.set(page, JSON.parse(studio.text(d.state.id, page))); } catch (e) { fail(e); return null; }
  }
  return d.text.get(page);
}

/** The glyph nearest a point, preferring glyphs on the same line. */
function glyphAt(t, x, y) {
  let best = -1, bestD = Infinity;
  t.glyphs.forEach((g, i) => {
    const dx = x < g[0] ? g[0] - x : x > g[2] ? x - g[2] : 0;
    const dy = y < g[1] ? g[1] - y : y > g[3] ? y - g[3] : 0;
    const d = dx + dy * 4;
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD < 40 ? best : -1;
}

function selectionRects(page) {
  const t = textOf(page); if (!t || !textSel) return [];
  const [a, b] = [Math.min(textSel.from, textSel.to), Math.max(textSel.from, textSel.to)];
  const lines = new Map();
  for (let i = a; i <= b; i++) {
    const g = t.glyphs[i], r = lines.get(t.line[i]);
    lines.set(t.line[i], r ? [Math.min(r[0], g[0]), Math.min(r[1], g[1]), Math.max(r[2], g[2]), Math.max(r[3], g[3])] : [...g]);
  }
  return [...lines.values()];
}

function selectedText() {
  const t = textSel && textOf(textSel.page); if (!t) return "";
  const [a, b] = [Math.min(textSel.from, textSel.to), Math.max(textSel.from, textSel.to)];
  let s = "";
  for (let i = a; i <= b; i++) {
    if (i > a) s += t.line[i] !== t.line[i - 1] ? "\n" : t.space[i] ? " " : "";
    s += t.text[i];
  }
  return s;
}

// --- tools -------------------------------------------------------------------------------------

const TOOL_NAMES = {
  select: "Select", hand: "Hand", highlight: "Highlight", underline: "Underline", strikeout: "Strikethrough", note: "Sticky note",
  textbox: "Text box", ink: "Draw", rectangle: "Rectangle", oval: "Oval", arrow: "Arrow", line: "Line", stamp: "Stamp",
  type: "Add text (Fill & Sign)", check: "Check mark", cross: "Cross", dot: "Dot", sign: "Sign", addtext: "Add page text",
  addimage: "Add image", redact: "Mark for redaction",
};
const TEXT_TOOLS = new Set(["select", "highlight", "underline", "strikeout"]);

function setTool(t) {
  closeEditor(true);
  tool = t; textSel = null;
  for (const b of document.querySelectorAll("[data-ptool]")) b.setAttribute("aria-pressed", String(b.dataset.ptool === t));
  $("p-tool-name").textContent = `Tool: ${TOOL_NAMES[t]}`;
  $("p-stamp-field").hidden = t !== "stamp";
  $("p-scroll").classList.toggle("can-pan", t === "hand");
  for (const el of pageEls) el.querySelector(".p-layer").style.cursor = t === "hand" ? "" : TEXT_TOOLS.has(t) ? "text" : "crosshair";
  refreshOverlays();
}
document.querySelectorAll("[data-ptool]").forEach((b) => (b.onclick = () => setTool(b.dataset.ptool)));

function setTask(t) {
  task = t;
  for (const b of document.querySelectorAll("[data-task]")) b.setAttribute("aria-pressed", String(b.dataset.task === t));
  for (const s of document.querySelectorAll("[data-taskpanel]")) s.hidden = s.dataset.taskpanel !== t;
  if (!["select", "hand"].includes(tool) && !document.querySelector(`[data-taskpanel="${t}"] [data-ptool="${tool}"]`)) setTool("select");
  syncChrome();
}
document.querySelectorAll("[data-task]").forEach((b) => (b.onclick = () => setTask(b.dataset.task)));

const pointOn = (e, el) => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom]; };
const rectOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const style = () => ({ color: $("p-color").value, opacity: clamp(Number($("p-opacity").value) || 100, 5, 100) / 100, width: clamp(Number($("p-width").value) || 0, 0, 24) });
const author = () => $("p-author").value.trim() || "Darkroom";
const DRAG_TOOLS = new Set(["textbox", "rectangle", "oval", "arrow", "line", "addtext", "addimage", "redact", "ink"]);

$("p-pages").addEventListener("pointerdown", (e) => {
  const page = e.target.closest(".p-page"); if (!page || e.button !== 0) return;
  if (tool === "hand" || spaceDown || e.target.closest(".p-field, .p-editor")) return;
  const i = Number(page.dataset.page), layer = page.querySelector(".p-layer"), at = pointOn(e, layer);
  const st = active().state;
  if (tool !== "select" && !st.editable) return say(st.read_only_reason || "This PDF can't be changed.", true);
  closeEditor(true);
  if (tool === "select") {
    const box = e.target.closest(".p-cmt");
    if (box) {
      selectedComment = { page: i, index: Number(box.dataset.index) }; textSel = null;
      // Redrawing the overlay replaces its elements, so drag the new box.
      refreshOverlays();
      const fresh = layer.querySelector(`.p-cmt[data-index="${selectedComment.index}"]`);
      gesture = { kind: "move", page: i, start: at, box: fresh, origin: [fresh.offsetLeft, fresh.offsetTop] };
      layer.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    selectedComment = null; renderSelected();
  }
  if (TEXT_TOOLS.has(tool)) {
    const t = textOf(i), g = t ? glyphAt(t, ...at) : -1;
    textSel = g >= 0 ? { page: i, from: g, to: g } : null;
    gesture = g >= 0 ? { kind: "text", page: i } : null;
    drawOverlay(i);
    if (g < 0 && tool !== "select") say("Drag across text to mark it.");
    if (gesture) { layer.setPointerCapture(e.pointerId); e.preventDefault(); }
    return;
  }
  if (DRAG_TOOLS.has(tool)) {
    const preview = document.createElement("div"); preview.className = "p-preview"; layer.append(preview);
    gesture = { kind: tool, page: i, start: at, end: at, preview, points: [at] };
    if (tool === "ink" || tool === "arrow" || tool === "line") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      Object.assign(svg.style, { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" });
      svg.innerHTML = `<polyline fill="none" stroke="${$("p-color").value}" stroke-width="${Math.max(1, style().width * zoom)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      preview.replaceWith(svg); gesture.preview = svg;
    }
    layer.setPointerCapture(e.pointerId); e.preventDefault(); return;
  }
  click(i, at);
});

$("p-pages").addEventListener("pointermove", (e) => {
  if (!gesture) return;
  const layer = pageEls[gesture.page].querySelector(".p-layer"), at = pointOn(e, layer);
  if (gesture.kind === "move") {
    const dx = (at[0] - gesture.start[0]) * zoom, dy = (at[1] - gesture.start[1]) * zoom;
    gesture.box.style.left = `${gesture.origin[0] + dx}px`; gesture.box.style.top = `${gesture.origin[1] + dy}px`;
    gesture.moved = Math.hypot(dx, dy) > 2; return;
  }
  if (gesture.kind === "text") {
    const t = textOf(gesture.page), g = glyphAt(t, ...at);
    if (g >= 0 && g !== textSel.to) { textSel.to = g; drawOverlay(gesture.page); }
    return;
  }
  gesture.end = at;
  if (gesture.kind === "ink") {
    const last = gesture.points.at(-1);
    if (Math.hypot(at[0] - last[0], at[1] - last[1]) * zoom >= 2 && gesture.points.length < 4000) gesture.points.push(at);
  }
  if (gesture.preview instanceof SVGElement) {
    const pts = gesture.kind === "ink" ? gesture.points : [gesture.start, at];
    gesture.preview.querySelector("polyline").setAttribute("points", pts.map((p) => `${p[0] * zoom},${p[1] * zoom}`).join(" "));
  } else {
    place(gesture.preview, rectOf(gesture.start, at));
    gesture.preview.style.borderRadius = gesture.kind === "oval" ? "50%" : "";
    gesture.preview.style.background = gesture.kind === "redact" ? "rgba(220,30,30,.25)" : "";
  }
});

for (const type of ["pointerup", "pointercancel"]) $("p-pages").addEventListener(type, () => {
  const g = gesture; gesture = null; if (!g) return;
  if (type === "pointercancel") { g.preview?.remove(); return refreshOverlays(); }
  if (g.kind === "move") {
    if (g.moved) edit({ op: "comment_move", page: g.page, index: selectedComment.index, dx: (g.box.offsetLeft - g.origin[0]) / zoom, dy: (g.box.offsetTop - g.origin[1]) / zoom });
    else refreshOverlays();
    return;
  }
  if (g.kind === "text") {
    if (tool !== "select" && textSel) {
      const rects = selectionRects(textSel.page), page = textSel.page; textSel = null;
      edit({ op: "comment", type: tool, page, rects, ...markupStyle(), author: author() });
    }
    return;
  }
  g.preview?.remove();
  const r = rectOf(g.start, g.end), small = (r[2] - r[0]) * zoom < 4 && (r[3] - r[1]) * zoom < 4;
  const page = g.page;
  switch (g.kind) {
    case "ink": if (g.points.length > 1) edit({ op: "comment", type: "ink", page, strokes: [g.points], ...style(), author: author() }); break;
    case "arrow": case "line": if (!small) edit({ op: "comment", type: g.kind, page, from: g.start, to: g.end, ...style(), author: author() }); break;
    case "rectangle": case "oval": if (!small) edit({ op: "comment", type: g.kind, page, rect: r, ...style(), fill: null, author: author() }); break;
    case "textbox": openEditor(page, small ? [r[0], r[1], r[0] + 180, r[1] + 40] : r, (text) => edit({ op: "comment", type: "textbox", page, rect: small ? [r[0], r[1], r[0] + 180, r[1] + 40] : r, contents: text, font_size: Number($("p-font").value) || 12, color: $("p-color").value, opacity: style().opacity, width: 1, author: author() })); break;
    case "addtext": {
      const box = small ? [r[0], r[1], r[0] + 240, r[1] + 30] : r;
      openEditor(page, box, (text) => edit({ op: "add_text", page, rect: box, text, size: Number($("p-text-size").value) || 14, color: $("p-text-color").value, family: $("p-family").value, align: $("p-text-align").value, bold: $("p-text-bold").checked, italic: $("p-text-italic").checked }), { size: Number($("p-text-size").value) || 14 });
      break;
    }
    case "addimage": pickImage(page, small ? [] : r); break;
    case "redact": if (!small) edit({ op: "redact_area", page, rect: r, author: author() }); break;
  }
});

function markupStyle() {
  const s = style();
  // Markup keeps the engine's conventional colours unless the user changed the colour.
  return $("p-color").dataset.touched ? { color: s.color, opacity: s.opacity } : { opacity: s.opacity };
}
$("p-color").addEventListener("input", (e) => (e.target.dataset.touched = "1"));

function click(page, at) {
  const [x, y] = at;
  switch (tool) {
    case "note": {
      if (edit({ op: "comment", type: "note", page, at: [x - 10, y - 10], color: $("p-color").dataset.touched ? $("p-color").value : undefined, author: author() })) {
        const c = active().state.comments.filter((k) => k.page === page && k.type === "Text").at(-1);
        if (c) { selectedComment = { page, index: c.index }; setTool("select"); renderSelected(); $("p-sel-text").focus(); }
      }
      break;
    }
    case "stamp": edit({ op: "comment", type: "stamp", page, at, stamp: $("p-stamp").value, author: author() }); break;
    case "type": openEditor(page, [x, y - 6, x + 200, y + 14], (text) => edit({ op: "type", page, at: [x, y - 6], text, author: author() }), { size: 10 }); break;
    case "check": case "cross": case "dot": edit({ op: "mark", page, rect: [x - 6, y - 6, x + 6, y + 6], mark: tool, author: author() }); break;
    case "sign": signAt(page, at); break;
  }
}

function signAt(page, at, fit) {
  if (!signature) { openSignatureDialog(() => signAt(page, at, fit)); return; }
  if (signature.kind === "drawn") edit({ op: "sign_drawn", page, at, strokes: signature.strokes, width: fit ? Math.min(150, (fit[2] - fit[0]) * 0.9) : 150, author: author() });
  else edit({ op: "sign_typed", page, at, text: signature.text, height: fit ? Math.min(32, (fit[3] - fit[1]) * 0.8) : 28, author: author() });
}

// An inline text box for typing straight onto the page.
function openEditor(page, rect, commit, { size = Number($("p-font").value) || 12 } = {}) {
  closeEditor(true);
  const el = document.createElement("textarea"); el.className = "p-editor";
  el.setAttribute("aria-label", "Text to add");
  editor = { page, rect, commit, el, size };
  pageEls[page].querySelector(".p-layer").append(el); placeEditor();
  el.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeEditor(true); }
  };
  el.onblur = () => setTimeout(() => { if (editor?.el === el) closeEditor(true); }, 0);
  requestAnimationFrame(() => el.focus());
}
function placeEditor() {
  if (!editor) return;
  place(editor.el, editor.rect);
  editor.el.style.fontSize = `${editor.size * zoom}px`;
}
function closeEditor(commit) {
  if (!editor) return;
  const { el, commit: done } = editor; editor = null;
  const text = el.value.replace(/\s+$/, "");
  el.remove();
  if (commit && text) done(text);
}

let pendingImage = null;
function pickImage(page, rect) { pendingImage = { page, rect }; $("p-image-file").click(); }
$("p-image-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !pendingImage) return;
  const { page, rect } = pendingImage; pendingImage = null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  run((id) => studio.add_image(id, page, new Float64Array(rect), f.name, bytes));
};

// Panning with the Hand tool or a held Space bar.
let pan = null;
$("p-scroll").addEventListener("pointerdown", (e) => {
  if (!(tool === "hand" || spaceDown) || e.button !== 0 || e.target.closest(".p-field, .p-editor")) return;
  const s = $("p-scroll"); pan = { x: e.clientX, y: e.clientY, l: s.scrollLeft, t: s.scrollTop };
  s.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
}, true);
$("p-scroll").addEventListener("pointermove", (e) => { if (!pan) return; const s = $("p-scroll"); s.scrollLeft = pan.l - (e.clientX - pan.x); s.scrollTop = pan.t - (e.clientY - pan.y); }, true);
for (const t of ["pointerup", "pointercancel"]) $("p-scroll").addEventListener(t, () => (pan = null), true);

// --- comments panel -------------------------------------------------------------------------

const TYPE_NAMES = { Text: "Note", Highlight: "Highlight", Underline: "Underline", StrikeOut: "Strikethrough", Squiggly: "Squiggly", FreeText: "Text", Square: "Rectangle", Circle: "Oval", Line: "Line", Ink: "Drawing", Polygon: "Polygon", Stamp: "Stamp", Redact: "Redaction mark", Caret: "Insert text" };

function renderComments() {
  const list = $("p-comments"); list.replaceChildren();
  const st = active()?.state; if (!st) return;
  const roots = st.comments.filter((c) => !c.reply_to && !c.state);
  if (!roots.length) { const p = document.createElement("li"); p.textContent = "No comments yet."; p.style.cursor = "default"; list.append(p); return; }
  for (const c of roots) {
    const li = document.createElement("li");
    li.setAttribute("aria-current", String(selectedComment?.page === c.page && selectedComment.index === c.index));
    const meta = document.createElement("div"); meta.className = "meta";
    meta.append(Object.assign(document.createElement("span"), { textContent: `${TYPE_NAMES[c.type] || c.type} · p. ${st.pages[c.page]?.label ?? c.page + 1}` }), Object.assign(document.createElement("span"), { textContent: c.author || "" }));
    li.append(meta);
    if (c.contents) li.append(Object.assign(document.createElement("div"), { className: "body", textContent: c.contents }));
    for (const r of st.comments.filter((k) => c.id && k.reply_to === c.id && !k.state)) li.append(Object.assign(document.createElement("div"), { className: "reply", textContent: `${r.author || ""}: ${r.contents || ""}` }));
    li.onclick = () => { selectedComment = { page: c.page, index: c.index }; setTool("select"); goToPage(c.page, c.rect); refreshOverlays(); };
    list.append(li);
  }
}

function renderSelected() {
  const st = active()?.state, c = selectedComment && st?.comments.find((k) => k.page === selectedComment.page && k.index === selectedComment.index);
  $("p-selected").hidden = !c;
  if (!c) return;
  if (document.activeElement !== $("p-sel-text")) $("p-sel-text").value = c.contents || "";
  const replies = $("p-sel-replies"); replies.replaceChildren();
  for (const r of st.comments.filter((k) => c.id && k.reply_to === c.id && !k.state)) {
    const li = document.createElement("li"); li.style.cursor = "default";
    li.append(Object.assign(document.createElement("div"), { className: "meta", textContent: r.author || "" }), Object.assign(document.createElement("div"), { className: "body", textContent: r.contents || "" }));
    replies.append(li);
  }
}
$("p-sel-text").onchange = (e) => { if (selectedComment) edit({ op: "comment_text", ...selectedComment, text: e.target.value }); };
$("p-sel-delete").onclick = () => { if (selectedComment) { const c = selectedComment; selectedComment = null; edit({ op: "comment_delete", ...c }); } };
$("p-sel-reply").onclick = () => {
  const text = $("p-sel-reply-text").value.trim();
  if (selectedComment && text && edit({ op: "comment_reply", ...selectedComment, text, author: author() })) $("p-sel-reply-text").value = "";
};

// --- search -------------------------------------------------------------------------------------

function runSearch() {
  const d = active(), q = $("p-find").value.trim();
  found = { hits: [], current: -1 };
  if (d && q) {
    try { found.hits = JSON.parse(studio.find(d.state.id, q, $("p-find-case").checked, $("p-find-whole").checked)); } catch (e) { fail(e); }
  }
  $("p-find-count").textContent = q ? `${found.hits.length}${found.hits.length >= 5000 ? "+" : ""} match${found.hits.length === 1 ? "" : "es"}` : "";
  const list = $("p-results"); list.replaceChildren();
  found.hits.slice(0, 500).forEach((h, k) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("div"), { className: "meta", textContent: `Page ${d.state.pages[h.page]?.label ?? h.page + 1}` }), Object.assign(document.createElement("div"), { textContent: h.text }));
    li.onclick = () => showHit(k); list.append(li);
  });
  if (found.hits.length) showHit(0); else refreshOverlays();
}
function showHit(k) {
  if (!found.hits.length) return;
  found.current = (k + found.hits.length) % found.hits.length;
  const h = found.hits[found.current];
  goToPage(h.page, h.rects[0]); refreshOverlays();
}
$("p-find").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") { e.preventDefault(); if (found.hits.length && e.target.dataset.query === e.target.value) showHit(found.current + (e.shiftKey ? -1 : 1)); else { e.target.dataset.query = e.target.value; runSearch(); } }
});
$("p-find").addEventListener("search", () => { $("p-find").dataset.query = $("p-find").value; runSearch(); });
for (const id of ["p-find-case", "p-find-whole"]) $(id).onchange = runSearch;

function setSide(which) {
  for (const b of document.querySelectorAll("[data-side]")) b.setAttribute("aria-pressed", String(b.dataset.side === which));
  for (const s of ["pages", "comments", "search"]) $("p-side-" + s).hidden = s !== which;
  if (which === "search") $("p-find").focus();
}
document.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => setSide(b.dataset.side)));

// --- fill & sign ----------------------------------------------------------------------------------

$("p-form-reset").onclick = () => edit({ op: "reset_form" });
$("p-flatten-fields").onclick = () => edit({ op: "flatten", comments: false, fields: true }) && say("Form fields flattened into the page.");
$("p-flatten-comments").onclick = () => edit({ op: "flatten", comments: true, fields: false }) && say("Comments flattened into the page.");
$("p-sig-edit").onclick = () => openSignatureDialog();

let sigMode = "draw", sigStrokes = [], sigAfter = null;
function openSignatureDialog(after) {
  sigAfter = after || null; sigStrokes = signature?.kind === "drawn" ? structuredClone(signature.strokes) : [];
  $("p-sig-name").value = signature?.kind === "typed" ? signature.text : "";
  setSigMode(signature?.kind === "typed" ? "type" : "draw");
  $("p-sig-dialog").showModal();
}
function setSigMode(m) {
  sigMode = m;
  for (const b of document.querySelectorAll("[data-sig]")) b.setAttribute("aria-pressed", String(b.dataset.sig === m));
  $("p-sig-typed").hidden = m !== "type";
  drawSigPad();
}
document.querySelectorAll("[data-sig]").forEach((b) => (b.onclick = () => setSigMode(b.dataset.sig)));
$("p-sig-name").oninput = drawSigPad;
function drawSigPad() {
  const c = $("p-sig-pad"), ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "#c9c4b8"; ctx.beginPath(); ctx.moveTo(40, c.height * 0.72); ctx.lineTo(c.width - 40, c.height * 0.72); ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle = "#0b1a3a"; ctx.lineWidth = 3.5; ctx.lineCap = ctx.lineJoin = "round";
  if (sigMode === "type") {
    ctx.font = "italic 72px 'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive"; ctx.textBaseline = "alphabetic";
    ctx.fillText($("p-sig-name").value || "", 50, c.height * 0.68, c.width - 100);
    return;
  }
  for (const s of sigStrokes) { ctx.beginPath(); s.forEach(([x, y], k) => (k ? ctx.lineTo(x * c.width, (1 - y) * c.height) : ctx.moveTo(x * c.width, (1 - y) * c.height))); ctx.stroke(); }
}
(() => {
  const c = $("p-sig-pad"); let down = false;
  const at = (e) => { const r = c.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)]; };
  c.onpointerdown = (e) => { if (sigMode !== "draw") return; down = true; c.setPointerCapture(e.pointerId); sigStrokes.push([at(e)]); drawSigPad(); };
  c.onpointermove = (e) => { if (!down) return; const s = sigStrokes.at(-1), p = at(e), q = s.at(-1); if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.003 && s.length < 3000) { s.push(p); drawSigPad(); } };
  c.onpointerup = c.onpointercancel = () => (down = false);
})();
$("p-sig-clear").onclick = () => { sigStrokes = []; $("p-sig-name").value = ""; drawSigPad(); };
$("p-sig-cancel").onclick = () => $("p-sig-dialog").close();
$("p-sig-save").onclick = () => {
  if (sigMode === "draw") {
    // Normalise to the drawing's own box, keeping its proportions (x 0–1, y up).
    const pts = sigStrokes.flat(); if (pts.length < 2) return say("Draw your signature in the box first.");
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
    const span = Math.max(x1 - x0, 1e-3), aspect = $("p-sig-pad").width / $("p-sig-pad").height;
    signature = { kind: "drawn", strokes: sigStrokes.map((s) => s.map(([x, y]) => [(x - x0) / span, ((y - y0) / span) / aspect])) };
  } else {
    const text = $("p-sig-name").value.trim(); if (!text) return say("Type your name first.");
    signature = { kind: "typed", text };
  }
  $("p-sig-dialog").close();
  $("p-sig-note").textContent = signature.kind === "drawn" ? "Drawn signature ready. Choose Sign, then click where it goes." : `Typed signature “${signature.text}” ready. Choose Sign, then click where it goes.`;
  if (sigAfter) { const f = sigAfter; sigAfter = null; f(); } else setTool("sign");
};

// --- redact, protect, properties -----------------------------------------------------------------

$("p-redact-mark").onclick = () => {
  const q = $("p-redact-find").value.trim(); if (!q) return say("Type the text to redact.");
  const before = active()?.state.redactions ?? 0;
  if (edit({ op: "redact_text", query: q, case: $("p-redact-case").checked, whole: $("p-redact-whole").checked, author: author() })) say(`Marked ${active().state.redactions - before} match${active().state.redactions - before === 1 ? "" : "es"} for redaction.`);
};
$("p-redact-apply").onclick = () => {
  const n = active()?.state.redactions ?? 0;
  if (n && confirm(`Permanently remove the content under ${n} redaction mark${n > 1 ? "s" : ""}? You can undo until you close the document.`)) edit({ op: "redact_apply" }) && say("Redactions applied. Save to keep the redacted copy.");
};
$("p-redact-clear").onclick = () => edit({ op: "redact_clear" });
$("p-protect").onclick = () => {
  const open = $("p-pw-open").value, owner = $("p-pw-owner").value;
  if (!open && !owner) return say("Enter a password to open the document, a permissions password, or both.");
  if (edit({ op: "protect", open_password: open, permissions_password: owner, printing: $("p-perm-print").value, changes: $("p-perm-changes").value, copy: $("p-perm-copy").checked })) {
    $("p-pw-open").value = $("p-pw-owner").value = "";
    say("Protection is set. It is applied when you save.");
  }
};
$("p-unprotect").onclick = () => edit({ op: "unprotect" }) && say("Security removed. Save to write an unprotected copy.");
$("p-meta-apply").onclick = () => edit({ op: "info", title: $("p-title").value, author: $("p-meta-author").value, subject: $("p-subject").value, keywords: $("p-keywords").value }) && say("Document properties updated.");

// --- chrome ---------------------------------------------------------------------------------------

function syncChrome() {
  const d = active(), st = d?.state;
  $("p-save").disabled = !st;
  $("p-undo").disabled = !st?.undo; $("p-undo").title = st?.undo ? `Undo ${st.undo} (Ctrl+Z)` : "Undo (Ctrl+Z)";
  $("p-redo").disabled = !st?.redo; $("p-redo").title = st?.redo ? `Redo ${st.redo} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)";
  $("p-pagecount").textContent = st ? st.pages.length : 0;
  $("p-pageno").max = st?.pages.length || 1;
  for (const id of ["p-rot-l", "p-rot-r", "p-del", "p-dup", "p-blank", "p-insert", "p-up", "p-down"]) $(id).disabled = !st || !st.allows.assemble || !st.editable;
  for (const id of ["p-extract", "p-split", "p-to-image"]) $(id).disabled = !st;
  if (!st) { $("p-comments").replaceChildren(); $("p-selected").hidden = true; return; }
  $("p-redact-count").textContent = st.redactions ? `${st.redactions} redaction mark${st.redactions > 1 ? "s" : ""} waiting to be applied.` : "No redaction marks.";
  $("p-redact-apply").disabled = $("p-redact-clear").disabled = !st.redactions;
  const sec = st.security;
  $("p-security").textContent = sec ? `Protected: ${sec.method}${sec.pending ? " — written when you save" : ""}${sec.owner ? " (opened with the permissions password)" : ""}.` : st.info.encrypted ? "Encrypted." : "Not protected.";
  $("p-unprotect").disabled = !sec && !st.info.encrypted;
  if (task === "props") {
    for (const [id, key] of [["p-title", "title"], ["p-meta-author", "author"], ["p-subject", "subject"], ["p-keywords", "keywords"]]) if (document.activeElement !== $(id)) $(id).value = st.info[key] || "";
    const facts = $("p-facts"); facts.replaceChildren();
    for (const [k, v] of [["Pages", st.pages.length], ["Page size", `${Math.round(st.pages[currentPage]?.w)} × ${Math.round(st.pages[currentPage]?.h)} pt`], ["PDF version", st.info.version], ["File size", st.info.size ? `${(st.info.size / 1048576).toFixed(2)} MB` : "—"], ["Producer", st.info.producer || "—"], ["Form fields", st.fields.length], ["Comments", st.comments.filter((c) => !c.reply_to).length]]) {
      const row = document.createElement("div"); row.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: String(v) })); facts.append(row);
    }
  }
}

$("p-undo").onclick = () => run((id) => studio.undo(id));
$("p-redo").onclick = () => run((id) => studio.redo(id));

$("p-to-image").onclick = async () => {
  const d = active(); if (!d) return;
  // The page at 2× its point size (144 dpi) as a PNG, imported like a dropped file.
  try {
    const bytes = studio.render(d.state.id, currentPage, 2), head = new DataView(bytes.buffer, bytes.byteOffset, 8);
    const w = head.getUint32(0, true), h = head.getUint32(4, true), c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, w * h * 4), w, h), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], `${d.state.name.replace(/\.pdf$/i, "")}-page-${currentPage + 1}.png`, { type: "image/png" }));
    $("mode-image").click();
    const input = $("file-images"); input.files = dt.files; input.dispatchEvent(new Event("change"));
  } catch (e) { fail(e); }
};

// Drag PDFs onto the viewer to open them.
const scrollEl = $("p-scroll");
["dragenter", "dragover"].forEach((t) => scrollEl.addEventListener(t, (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); }));
scrollEl.addEventListener("drop", (e) => { const files = [...e.dataTransfer.files]; if (!files.length) return; e.preventDefault(); openFiles(files); });

document.addEventListener("keydown", (e) => {
  if ($("pdf-workspace").hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "z") { e.preventDefault(); e.shiftKey ? $("p-redo").click() : $("p-undo").click(); }
    else if (k === "y") { e.preventDefault(); $("p-redo").click(); }
    else if (k === "o") { e.preventDefault(); $("p-open").click(); }
    else if (k === "s") { e.preventDefault(); if (active()) save(); }
    else if (k === "f") { e.preventDefault(); setSide("search"); }
    else if (k === "c" && textSel) { e.preventDefault(); navigator.clipboard?.writeText(selectedText()).then(() => say("Copied.")).catch(() => {}); }
    else if (k === "=" || k === "+") { e.preventDefault(); zoomStep(1); }
    else if (k === "-") { e.preventDefault(); zoomStep(-1); }
    else if (k === "0") { e.preventDefault(); setZoom("fit"); }
    return;
  }
  if (e.key === " ") { e.preventDefault(); spaceDown = true; $("p-scroll").classList.add("can-pan"); return; }
  if (e.key === "Escape") { textSel = null; selectedComment = null; setTool("select"); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedComment) { e.preventDefault(); $("p-sel-delete").click(); return; }
  const tools = { v: "select", h: "hand", n: "note", d: "draw", x: "textbox" };
  if (tools[k]) { e.preventDefault(); setTool(tools[k] === "draw" ? "ink" : tools[k]); }
});
document.addEventListener("keyup", (e) => { if (e.key === " ") { spaceDown = false; $("p-scroll").classList.toggle("can-pan", tool === "hand"); } });

window.addEventListener("beforeunload", (e) => { if ([...docs.values()].some((d) => d.state.dirty)) { e.preventDefault(); e.returnValue = ""; } });

document.addEventListener("workspacechange", (e) => {
  if (e.detail !== "pdf") { closeEditor(true); return; }
  ensureEngine();
  if (active()) { computeZoom(); sizePages(); }
});

setTool("select");
setTask("comment");
syncChrome();
