import init, { Editor } from "./pkg/darkroom.js";

// This app deliberately touches no persistence API. There is no localStorage,
// sessionStorage, indexedDB, caches, or OPFS call anywhere below except inside
// readLedger(), which only reads counts in order to display them.

const $ = (id) => document.getElementById(id);
const PREVIEW_CAP = 1600;   // long edge, px
const THUMB = 240;

let wasm, ed;
let layers = [];            // [{id, name, width, height, opCount}]
let activeId = null;
let adjust = new Map();     // id -> adjustment struct
let thumbUrls = new Map();  // id -> object URL (revoked on replace/remove)
let cropping = false;
let pendingCrop = null;     // {x,y,w,h} normalized, while crop mode is open
let frameQueued = false;

const blank = () => ({
  crop: null, turns: 0, flipH: false, flipV: false,
  brightness: 0, contrast: 0, saturation: 0,
  grayscale: false, invert: false, blur: 0,
});

// --- ops translation -------------------------------------------------------
// Canonical order is geometry, then tone, then treatment. Rust applies the
// array in sequence, so this function is the single place that order lives.

function buildOps(a, { skipGeometry = false } = {}) {
  const ops = [];
  if (!skipGeometry) {
    if (a.crop) ops.push({ op: "crop", ...a.crop });
    if (a.turns % 4) ops.push({ op: "rotate", turns: a.turns % 4 });
    if (a.flipH) ops.push({ op: "flip_h" });
    if (a.flipV) ops.push({ op: "flip_v" });
  }
  if (a.brightness) ops.push({ op: "brightness", value: a.brightness / 100 });
  if (a.contrast) ops.push({ op: "contrast", value: a.contrast / 100 });
  if (a.saturation) ops.push({ op: "saturation", value: a.saturation / 100 });
  if (a.grayscale) ops.push({ op: "grayscale" });
  if (a.invert) ops.push({ op: "invert" });
  if (a.blur) ops.push({ op: "blur", amount: a.blur / 100 });
  return ops;
}

function parseOps(ops) {
  const a = blank();
  for (const o of ops) {
    switch (o.op) {
      case "crop": a.crop = { x: o.x, y: o.y, w: o.w, h: o.h }; break;
      case "rotate": a.turns = o.turns % 4; break;
      case "flip_h": a.flipH = true; break;
      case "flip_v": a.flipV = true; break;
      case "brightness": a.brightness = Math.round(o.value * 100); break;
      case "contrast": a.contrast = Math.round(o.value * 100); break;
      case "saturation": a.saturation = Math.round(o.value * 100); break;
      case "grayscale": a.grayscale = true; break;
      case "invert": a.invert = true; break;
      case "blur": a.blur = Math.round(o.amount * 100); break;
    }
  }
  return a;
}

// --- rendering -------------------------------------------------------------

function scheduleRender() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; draw(); });
}

function draw() {
  const canvas = $("canvas");
  if (!activeId) { canvas.hidden = true; return; }

  const a = adjust.get(activeId);
  // While cropping we show the ungeometried image, so a selection rectangle
  // maps straight onto source coordinates with no composition math.
  const ops = buildOps(a, { skipGeometry: cropping });

  try {
    ed.set_ops(activeId, JSON.stringify(ops));
    ed.render_preview(activeId, previewCap());
  } catch (e) { return fail(e); }

  const w = ed.preview_width(), h = ed.preview_height();
  // The view must be built after every wasm call in this frame: growing wasm
  // memory detaches the old ArrayBuffer.
  const view = new Uint8ClampedArray(wasm.memory.buffer, ed.preview_ptr(), w * h * 4);
  canvas.width = w; canvas.height = h; canvas.hidden = false;
  canvas.getContext("2d").putImageData(new ImageData(view, w, h), 0, 0);

  if (cropping) requestAnimationFrame(positionCropBox);
}

function previewCap() {
  const stage = $("stage").getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return Math.min(PREVIEW_CAP, Math.round(Math.max(stage.width, stage.height) * dpr));
}

// --- filmstrip -------------------------------------------------------------

function refreshLayers() {
  try { layers = JSON.parse(ed.layers_json()); } catch (e) { return fail(e); }
  const has = layers.length > 0;
  $("btn-save").disabled = !has;
  $("btn-export").disabled = !has;
  $("panel-empty").hidden = has;
  $("panel-body").hidden = !has;
  $("stage-empty").hidden = has;
  renderStrip();
}

function renderStrip() {
  const frames = $("frames");
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  frames.replaceChildren();

  if (!layers.length) {
    const p = document.createElement("p");
    p.className = "sleeve-empty";
    p.textContent = "sleeve empty";
    frames.append(p);
    return;
  }

  for (const l of layers) {
    const cell = document.createElement("div");
    cell.className = "frame" + (l.id === activeId ? " active" : "");

    const pick = document.createElement("button");
    pick.style.cssText = "all:unset;display:block;width:100%;height:100%;cursor:pointer";
    pick.title = `${l.name} — ${l.width}×${l.height}`;
    pick.onclick = () => selectLayer(l.id);

    try {
      const png = ed.thumbnail(l.id, THUMB);
      const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      thumbUrls.set(l.id, url);
      const img = document.createElement("img");
      img.src = url; img.alt = l.name;
      pick.append(img);
    } catch { /* a thumbnail failing shouldn't take the strip down */ }

    const tag = document.createElement("span");
    tag.className = "frame-tag";
    tag.textContent = l.name;
    if (l.opCount) {
      const n = document.createElement("span");
      n.className = "frame-edits";
      n.textContent = `  ·  ${l.opCount} edit${l.opCount > 1 ? "s" : ""}`;
      tag.append(n);
    }

    const drop = document.createElement("button");
    drop.className = "frame-drop";
    drop.textContent = "×";
    drop.title = `Remove ${l.name}`;
    drop.onclick = (e) => { e.stopPropagation(); removeLayer(l.id); };

    cell.append(pick, tag, drop);
    frames.append(cell);
  }
}

function selectLayer(id) {
  if (cropping) exitCrop();
  activeId = id;
  if (!adjust.has(id)) adjust.set(id, blank());
  syncControls();
  renderStrip();
  scheduleRender();
}

function removeLayer(id) {
  const url = thumbUrls.get(id);
  if (url) { URL.revokeObjectURL(url); thumbUrls.delete(id); }
  ed.remove_image(id);
  adjust.delete(id);
  if (activeId === id) {
    if (cropping) exitCrop();
    const rest = layers.filter((l) => l.id !== id);
    activeId = rest.length ? rest[0].id : null;
  }
  refreshLayers();
  syncControls();
  scheduleRender();
}

// --- controls --------------------------------------------------------------

function syncControls() {
  if (!activeId) return;
  const a = adjust.get(activeId);
  for (const k of ["brightness", "contrast", "saturation", "blur"]) {
    $("s-" + k).value = a[k];
    $("o-" + k).textContent = a[k];
  }
  $("c-grayscale").checked = a.grayscale;
  $("c-invert").checked = a.invert;
  $("btn-uncrop").hidden = !a.crop;
}

function edit(fn) {
  if (!activeId) return;
  fn(adjust.get(activeId));
  scheduleRender();
  // Strip thumbnails carry the edit count, so refresh after the frame lands.
  requestAnimationFrame(refreshLayers);
}

for (const k of ["brightness", "contrast", "saturation", "blur"]) {
  $("s-" + k).addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("o-" + k).textContent = v;
    if (activeId) { adjust.get(activeId)[k] = v; scheduleRender(); }
  });
  $("s-" + k).addEventListener("change", () => refreshLayers());
}
$("c-grayscale").addEventListener("change", (e) => edit((a) => (a.grayscale = e.target.checked)));
$("c-invert").addEventListener("change", (e) => edit((a) => (a.invert = e.target.checked)));

document.querySelectorAll("[data-act]").forEach((b) => {
  b.addEventListener("click", () => edit((a) => {
    switch (b.dataset.act) {
      case "rot-cw": a.turns = (a.turns + 1) % 4; break;
      case "rot-ccw": a.turns = (a.turns + 3) % 4; break;
      case "flip-h": a.flipH = !a.flipH; break;
      case "flip-v": a.flipV = !a.flipV; break;
    }
  }));
});

$("btn-reset").addEventListener("click", () => {
  if (!activeId) return;
  adjust.set(activeId, blank());
  syncControls();
  scheduleRender();
  requestAnimationFrame(refreshLayers);
});

$("btn-uncrop").addEventListener("click", () => {
  edit((a) => (a.crop = null));
  syncControls();
});

// --- crop ------------------------------------------------------------------

$("btn-crop").addEventListener("click", () => (cropping ? exitCrop() : enterCrop()));
$("btn-crop-cancel").addEventListener("click", exitCrop);
$("btn-crop-apply").addEventListener("click", () => {
  if (pendingCrop && pendingCrop.w > 0.005 && pendingCrop.h > 0.005) {
    adjust.get(activeId).crop = pendingCrop;
  }
  exitCrop();
  syncControls();
  requestAnimationFrame(refreshLayers);
});

function enterCrop() {
  if (!activeId) return;
  cropping = true;
  pendingCrop = adjust.get(activeId).crop;
  $("crop-layer").hidden = false;
  $("crop-bar").hidden = false;
  $("btn-crop").textContent = "Close crop";
  scheduleRender();
}

function exitCrop() {
  cropping = false;
  pendingCrop = null;
  $("crop-layer").hidden = true;
  $("crop-bar").hidden = true;
  $("crop-box").classList.remove("on");
  $("btn-crop").textContent = "Crop";
  scheduleRender();
}

function positionCropBox() {
  const box = $("crop-box");
  if (!pendingCrop) { box.classList.remove("on"); return; }
  const r = $("canvas").getBoundingClientRect();
  const l = $("crop-layer").getBoundingClientRect();
  box.style.left = `${r.left - l.left + pendingCrop.x * r.width}px`;
  box.style.top = `${r.top - l.top + pendingCrop.y * r.height}px`;
  box.style.width = `${pendingCrop.w * r.width}px`;
  box.style.height = `${pendingCrop.h * r.height}px`;
  box.classList.add("on");
}

(() => {
  const layer = $("crop-layer");
  let origin = null;
  layer.addEventListener("pointerdown", (e) => {
    const r = $("canvas").getBoundingClientRect();
    origin = { x: e.clientX, y: e.clientY, r };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener("pointermove", (e) => {
    if (!origin) return;
    const { r } = origin;
    const nx = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const x0 = nx(Math.min(origin.x, e.clientX), r.left, r.right);
    const x1 = nx(Math.max(origin.x, e.clientX), r.left, r.right);
    const y0 = nx(Math.min(origin.y, e.clientY), r.top, r.bottom);
    const y1 = nx(Math.max(origin.y, e.clientY), r.top, r.bottom);
    pendingCrop = {
      x: (x0 - r.left) / r.width,
      y: (y0 - r.top) / r.height,
      w: (x1 - x0) / r.width,
      h: (y1 - y0) / r.height,
    };
    positionCropBox();
  });
  layer.addEventListener("pointerup", () => (origin = null));
})();

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cropping) exitCrop();
});

// --- files -----------------------------------------------------------------

$("btn-import").addEventListener("click", () => $("file-images").click());
$("file-images").addEventListener("change", (e) => {
  importFiles([...e.target.files]);
  e.target.value = "";
});

$("btn-open").addEventListener("click", () => $("file-project").click());
$("file-project").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) await openProject(f);
});

async function importFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const id = ed.add_image(f.name, buf);
      adjust.set(id, blank());
      activeId = id;
      added++;
    } catch (e) { fail(e); }
  }
  if (!added) return;
  refreshLayers();
  syncControls();
  scheduleRender();
  say(`Imported ${added} image${added > 1 ? "s" : ""}.`);
}

async function openProject(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    ed.load_bundle(buf);
  } catch (e) { return fail(e); }

  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  adjust.clear();
  activeId = null;

  try { layers = JSON.parse(ed.layers_json()); } catch (e) { return fail(e); }
  for (const l of layers) adjust.set(l.id, parseOps(JSON.parse(ed.get_ops(l.id))));
  activeId = layers.length ? layers[0].id : null;

  refreshLayers();
  syncControls();
  scheduleRender();
  say(`Opened ${file.name} — ${layers.length} image${layers.length === 1 ? "" : "s"}, edits intact.`);
}

$("btn-save").addEventListener("click", async () => {
  let bytes;
  try { bytes = ed.save_bundle(); } catch (e) { return fail(e); }
  const ok = await putFile(new Blob([bytes], { type: "application/zip" }), "project.darkroom", {
    description: "Darkroom project", accept: { "application/zip": [".darkroom"] },
  });
  if (ok) say("Project saved. Nothing was written to this browser.");
});

$("btn-export").addEventListener("click", async () => {
  if (!activeId) return;
  const png = !/\.jpe?g$/i.test(layers.find((l) => l.id === activeId)?.name || "");
  const fmt = png ? "png" : "jpeg";
  let bytes, name;
  try {
    bytes = ed.export(activeId, fmt, 92);
    name = ed.export_name(activeId, fmt);
  } catch (e) { return fail(e); }
  const type = png ? "image/png" : "image/jpeg";
  const ok = await putFile(new Blob([bytes], { type }), name, {
    description: png ? "PNG image" : "JPEG image",
    accept: { [type]: [png ? ".png" : ".jpg"] },
  });
  if (ok) say(`Exported ${name}.`);
});

/** Writes to a location the user picks. Falls back to a download on browsers
 *  without the File System Access API. */
async function putFile(blob, suggestedName, type) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [type] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
      // Fall through: some browsers advertise the API but reject in this context.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

// --- drag and drop ---------------------------------------------------------

const stage = $("stage");
["dragenter", "dragover"].forEach((t) =>
  stage.addEventListener(t, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
["dragleave", "drop"].forEach((t) =>
  stage.addEventListener(t, () => stage.classList.remove("dragover")));
stage.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const proj = files.find((f) => f.name.endsWith(".darkroom"));
  if (proj) await openProject(proj);
  else await importFiles(files);
});

// --- storage ledger --------------------------------------------------------

async function readLedger() {
  const out = { local: 0, session: 0, idb: 0, cache: 0 };
  try { out.local = localStorage.length; } catch {}
  try { out.session = sessionStorage.length; } catch {}
  try { if (indexedDB.databases) out.idb = (await indexedDB.databases()).length; } catch {}
  try { if (window.caches) out.cache = (await caches.keys()).length; } catch {}
  return out;
}

async function tickLedger() {
  const r = await readLedger();
  const el = $("ledger");
  for (const [k, id] of [["local", "m-local"], ["session", "m-session"], ["idb", "m-idb"], ["cache", "m-cache"]]) {
    const cell = $(id);
    cell.textContent = r[k];
    cell.classList.toggle("hot", r[k] > 0);
  }
  el.classList.remove("tick");
  void el.offsetWidth;
  el.classList.add("tick");
}

// --- chrome ----------------------------------------------------------------

let toastTimer;
function say(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}

function fail(e) {
  say(typeof e === "string" ? e : e?.message || String(e), true);
  console.error(e);
}

window.addEventListener("resize", () => { if (activeId) scheduleRender(); });

// Best-effort scrub on unload. The tab teardown does the real work.
window.addEventListener("pagehide", () => {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  try { ed?.clear(); } catch {}
});

(async () => {
  wasm = await init();
  ed = new Editor();
  refreshLayers();
  tickLedger();
  setInterval(tickLedger, 2000);
})();