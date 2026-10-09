

// This app deliberately touches no persistence API. There is no localStorage,
// sessionStorage, indexedDB, caches, or OPFS call anywhere below.

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const PREVIEW_CAP = 1600;   // long edge, px
const THUMB = 240;
const HISTORY_CAP = 60;     // steps per image
const MIN_CROP_PX = 18;     // on screen, not in the source

let wasm, ed, curveLut;
let LIMITS = null;          // from the engine; see src/limits.rs
let layers = [];            // [{id, name, width, height, opCount, bytes}]
let activeId = null;
let adjust = new Map();     // id -> adjustment struct
let history = new Map();    // id -> {undo: [], redo: [], trimmed}
let thumbUrls = new Map();  // id -> object URL (revoked on replace/remove)
let cropping = false;
let pendingCrop = null;     // normalized, live while crop mode is open
let gesture = null;         // active crop drag
let sliderGesture = false;
let exportFmt = "png";
let frameQueued = false;
let comparing = false;
let sampling = false;
let handTool = false;

const IDENTITY_CURVE = [0, 0, 1, 1];

const blank = () => ({
  crop: null, turns: 0, flipH: false, flipV: false,
  brightness: 0, contrast: 0, saturation: 0,
  grayscale: false, invert: false, blur: 0, exposure: 0, warmth: 0, sharpen: 0,
  lvBlack: 0, lvGamma: 100, lvWhite: 255, lvOutBlack: 0, lvOutWhite: 255,
  curves: { rgb: [...IDENTITY_CURVE], red: [...IDENTITY_CURVE], green: [...IDENTITY_CURVE], blue: [...IDENTITY_CURVE] },
  hue: 0, vibrance: 0, shadows: 0, highlights: 0,
  filterColor: "#ec8a00", filterDensity: 0,
  noise: 0, noiseMono: false, vignette: 0, pixelate: 0, posterize: 1, threshold: 0,
  gradients: [], shapes: [], strokes: [], lasso: null,
});

// Every slider in the panel, generated so the range, label and default live in
// one place. [section, key, label, min, max, format]
const SLIDERS = [
  ["basic", "brightness", "Brightness", -100, 100],
  ["basic", "contrast", "Contrast", -100, 100],
  ["basic", "exposure", "Exposure", -100, 100],
  ["basic", "saturation", "Saturation", -100, 100],
  ["basic", "warmth", "Temperature", -100, 100],
  ["levels", "lvBlack", "Input black", 0, 253],
  ["levels", "lvGamma", "Midtones", 10, 400, (v) => (v / 100).toFixed(2)],
  ["levels", "lvWhite", "Input white", 2, 255],
  ["levels", "lvOutBlack", "Output black", 0, 255],
  ["levels", "lvOutWhite", "Output white", 0, 255],
  ["color", "hue", "Hue", -180, 180, (v) => `${v}°`],
  ["color", "vibrance", "Vibrance", -100, 100],
  ["color", "shadows", "Shadows", -100, 100],
  ["color", "highlights", "Highlights", -100, 100],
  ["filter", "filterDensity", "Filter density", 0, 100, (v) => `${v}%`],
  ["effects", "sharpen", "Sharpen", 0, 100],
  ["effects", "blur", "Blur", 0, 100],
  ["effects", "noise", "Noise", 0, 100],
  ["effects", "vignette", "Vignette", -100, 100],
  ["effects", "pixelate", "Pixelate", 0, 100],
  ["effects", "posterize", "Posterize", 1, 32, (v) => (v <= 1 ? "Off" : `${v} levels`)],
  ["effects", "threshold", "Threshold", 0, 255, (v) => (v ? v : "Off")],
];
const SLIDER_KEYS = SLIDERS.map((s) => s[1]);
const sliderFmt = (key, v) => (SLIDERS.find((s) => s[1] === key)[5] || String)(v);

// --- ops translation -------------------------------------------------------
// Canonical order is geometry, then tone, then colour, then effects, then
// marks laid on top. Rust applies the array in sequence, so this function is
// the single place that order lives.

const isIdentity = (c) => c.length === 4 && c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1;
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function buildOps(a, { skipGeometry = false } = {}) {
  const ops = [];
  if (!skipGeometry) {
    if (a.crop) ops.push({ op: "crop", ...a.crop });
    if (a.lasso) ops.push({ op: "lasso", points: a.lasso });
    if (a.turns % 4) ops.push({ op: "rotate", turns: a.turns % 4 });
    if (a.flipH) ops.push({ op: "flip_h" });
    if (a.flipV) ops.push({ op: "flip_v" });
  }
  if (a.lvBlack || a.lvWhite !== 255 || a.lvGamma !== 100 || a.lvOutBlack || a.lvOutWhite !== 255) {
    ops.push({
      op: "levels",
      in_black: a.lvBlack / 255, in_white: a.lvWhite / 255, gamma: a.lvGamma / 100,
      out_black: a.lvOutBlack / 255, out_white: a.lvOutWhite / 255,
    });
  }
  const c = a.curves;
  if (["rgb", "red", "green", "blue"].some((k) => !isIdentity(c[k]))) {
    const pick = (k) => (isIdentity(c[k]) ? [] : c[k]);
    ops.push({ op: "curves", rgb: pick("rgb"), red: pick("red"), green: pick("green"), blue: pick("blue") });
  }
  if (a.brightness) ops.push({ op: "brightness", value: a.brightness / 100 });
  if (a.contrast) ops.push({ op: "contrast", value: a.contrast / 100 });
  if (a.saturation) ops.push({ op: "saturation", value: a.saturation / 100 });
  for (const key of ["exposure", "warmth"]) {
    if (a[key]) ops.push({ op: key, value: a[key] / 100 });
  }
  if (a.hue) ops.push({ op: "hue", degrees: a.hue });
  if (a.vibrance) ops.push({ op: "vibrance", value: a.vibrance / 100 });
  if (a.shadows || a.highlights) {
    ops.push({ op: "shadows_highlights", shadows: a.shadows / 100, highlights: a.highlights / 100 });
  }
  if (a.sharpen) ops.push({ op: "sharpen", value: a.sharpen / 100 });
  if (a.grayscale) ops.push({ op: "grayscale" });
  if (a.invert) ops.push({ op: "invert" });
  // After black & white, so a warm filter on a monochrome image gives a toned print.
  if (a.filterDensity) ops.push({ op: "photo_filter", color: hexToRgb(a.filterColor), density: a.filterDensity / 100 });
  if (a.posterize > 1) ops.push({ op: "posterize", levels: a.posterize });
  if (a.threshold) ops.push({ op: "threshold", level: a.threshold / 255 });
  if (a.blur) ops.push({ op: "blur", amount: a.blur / 100 });
  if (a.pixelate) ops.push({ op: "pixelate", size: a.pixelate / 100 });
  if (a.noise) ops.push({ op: "noise", amount: a.noise / 100, mono: a.noiseMono });
  if (a.vignette) ops.push({ op: "vignette", amount: a.vignette / 100 });
  for (const g of a.gradients) ops.push({ op: "gradient", ...g });
  if (a.shapes.length) ops.push({ op: "shapes", items: a.shapes });
  // Paint goes last so a stroke sits on top of the tone adjustments instead of
  // being desaturated along with the photograph.
  if (a.strokes.length) ops.push({ op: "paint", strokes: a.strokes });
  return ops;
}

function parseOps(ops) {
  const a = blank();
  const pct = (v) => Math.round(v * 100);
  for (const o of ops) {
    switch (o.op) {
      case "exposure": case "warmth": case "sharpen": case "vibrance": a[o.op] = pct(o.value); break;
      case "crop": a.crop = { x: o.x, y: o.y, w: o.w, h: o.h }; break;
      case "rotate": a.turns = o.turns % 4; break;
      case "flip_h": a.flipH = true; break;
      case "flip_v": a.flipV = true; break;
      case "brightness": a.brightness = pct(o.value); break;
      case "contrast": a.contrast = pct(o.value); break;
      case "saturation": a.saturation = pct(o.value); break;
      case "grayscale": a.grayscale = true; break;
      case "invert": a.invert = true; break;
      case "blur": a.blur = pct(o.amount); break;
      case "paint": a.strokes = o.strokes || []; break;
      case "lasso": a.lasso = o.points || null; break;
      case "levels":
        a.lvBlack = Math.round(o.in_black * 255); a.lvWhite = Math.round(o.in_white * 255);
        a.lvGamma = pct(o.gamma);
        a.lvOutBlack = Math.round(o.out_black * 255); a.lvOutWhite = Math.round(o.out_white * 255);
        break;
      case "curves":
        for (const k of ["rgb", "red", "green", "blue"]) {
          if (o[k] && o[k].length >= 4) a.curves[k] = o[k].slice();
        }
        break;
      case "hue": a.hue = Math.round(o.degrees); break;
      case "shadows_highlights": a.shadows = pct(o.shadows); a.highlights = pct(o.highlights); break;
      case "photo_filter": a.filterColor = rgbToHex(o.color); a.filterDensity = pct(o.density); break;
      case "noise": a.noise = pct(o.amount); a.noiseMono = !!o.mono; break;
      case "vignette": a.vignette = pct(o.amount); break;
      case "pixelate": a.pixelate = pct(o.size); break;
      case "posterize": a.posterize = o.levels; break;
      case "threshold": a.threshold = Math.round(o.level * 255); break;
      case "gradient": { const { op, ...g } = o; a.gradients.push(g); break; }
      case "shapes": a.shapes = o.items || []; break;
    }
  }
  return a;
}

// --- history ---------------------------------------------------------------
// The adjustment struct is small, so whole-state snapshots are simpler and
// less error-prone than a command log, and cheap enough not to matter. Each
// entry carries the name of the action that left that state, which is what
// the History panel lists.

// A real copy, not a shared reference, or undo would rewrite the history
// entries it is meant to restore.
const snap = (a) => structuredClone(a);

function hist(id) {
  if (!history.has(id)) history.set(id, { undo: [], redo: [], trimmed: false });
  return history.get(id);
}

/** Call before mutating, never after. `label` names the action about to happen. */
function pushHistory(label = "Edit", id = activeId) {
  if (!id || !adjust.has(id)) return;
  const h = hist(id);
  h.undo.push({ state: snap(adjust.get(id)), label });
  if (h.undo.length > HISTORY_CAP) { h.undo.shift(); h.trimmed = true; }
  h.redo.length = 0;
  updateHistoryButtons();
}

/** Moves one step between the stacks without redrawing anything. */
function shift(from, to) {
  const h = hist(activeId);
  if (!h[from].length) return false;
  const e = h[from].pop();
  h[to].push({ state: snap(adjust.get(activeId)), label: e.label });
  adjust.set(activeId, e.state);
  return true;
}

function afterHistoryMove() {
  if (cropping) pendingCrop = adjust.get(activeId).crop;
  syncControls();
  scheduleRender();
  updateHistoryButtons();
  requestAnimationFrame(() => { refreshLayers(); if (cropping) paintCrop(); });
}

function step(from, to) {
  if (!activeId || !shift(from, to)) return;
  afterHistoryMove();
}

const undo = () => step("undo", "redo");
const redo = () => step("redo", "undo");

/** Jumps straight to entry `k` of the History panel. */
function jumpHistory(k) {
  if (!activeId) return;
  const h = hist(activeId);
  let moved = false;
  while (h.undo.length > k && shift("undo", "redo")) moved = true;
  while (h.undo.length < k && shift("redo", "undo")) moved = true;
  if (moved) afterHistoryMove();
}

function updateHistoryButtons() {
  const h = activeId ? hist(activeId) : { undo: [], redo: [] };
  $("btn-undo").disabled = !h.undo.length;
  $("btn-redo").disabled = !h.redo.length;
  renderHistory();
}

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  if (!activeId) return;
  const h = hist(activeId);
  const labels = [
    h.trimmed ? "Earliest kept state" : "Opened",
    ...h.undo.map((e) => e.label),
    ...h.redo.slice().reverse().map((e) => e.label),
  ];
  const current = h.undo.length;
  labels.forEach((label, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = label;
    b.className = i === current ? "current" : i > current ? "future" : "";
    b.onclick = () => jumpHistory(i);
    li.append(b);
    list.append(li);
  });
  const cur = list.children[current];
  if (cur) list.scrollTop = cur.offsetTop - list.clientHeight / 2;
}

$("btn-undo").addEventListener("click", undo);
$("btn-redo").addEventListener("click", redo);

// --- rendering -------------------------------------------------------------

function scheduleRender() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; draw(); });
}

function draw() {
  if ($("image-workspace").hidden) return;
  const canvas = $("canvas");
  if (!activeId) { canvas.hidden = true; return; }

  const a = adjust.get(activeId);
  // While cropping we show the ungeometried image, so a selection rectangle
  // maps straight onto source coordinates with no composition math.
  const ops = comparing ? [] : buildOps(a, { skipGeometry: cropping });

  try {
    ed.set_ops(activeId, JSON.stringify(ops));
    ed.render_preview(activeId, previewCap());
  } catch (e) { return fail(e); }

  if (comparing) ed.set_ops(activeId, JSON.stringify(buildOps(a)));
  const w = ed.preview_width(), h = ed.preview_height();
  // The view must be built after every wasm call in this frame: growing wasm
  // memory detaches the old ArrayBuffer.
  const view = new Uint8ClampedArray(wasm.memory.buffer, ed.preview_ptr(), w * h * 4);
  canvas.width = w; canvas.height = h; canvas.hidden = false;
  canvas.getContext("2d").putImageData(new ImageData(view, w, h), 0, 0);

  applyZoom();
  updateHistogram(canvas);
  $("document-info").textContent = `${layers.find(l => l.id === activeId)?.name || "Image"} · Preview ${w} × ${h}`;
  if (cropping) requestAnimationFrame(paintCrop);
  if (painting || drawTool) requestAnimationFrame(syncInk);
  if (lassoing) requestAnimationFrame(() => { syncInk(); drawLasso(); });
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
    pick.title = `${l.name} — ${l.width}×${l.height} · ${formatBytes(l.bytes)}`;
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
  comparing = false; $("view-original").setAttribute("aria-pressed", "false");
  leaveTools();
  activeId = id;
  if (!adjust.has(id)) adjust.set(id, blank());
  syncControls();
  updateHistoryButtons();
  renderStrip();
  scheduleRender();
}

function removeLayer(id) {
  const url = thumbUrls.get(id);
  if (url) { URL.revokeObjectURL(url); thumbUrls.delete(id); }
  if (activeId === id) leaveTools();
  ed.remove_image(id);
  adjust.delete(id);
  history.delete(id);
  if (activeId === id) {
    const rest = layers.filter((l) => l.id !== id);
    activeId = rest.length ? rest[0].id : null;
  }
  refreshLayers();
  syncControls();
  updateHistoryButtons();
  scheduleRender();
}

// --- controls --------------------------------------------------------------

function buildSliders() {
  for (const [section, key, label, min, max] of SLIDERS) {
    const host = document.querySelector(`.sliders[data-section="${section}"]`);
    const wrap = document.createElement("label");
    wrap.className = "slider";
    wrap.title = "Double-click the slider to reset";
    const name = document.createElement("span");
    name.textContent = label;
    const out = document.createElement("output");
    out.id = "o-" + key;
    const input = document.createElement("input");
    Object.assign(input, { type: "range", id: "s-" + key, min, max, value: blank()[key] });
    out.textContent = sliderFmt(key, input.value);
    wrap.append(name, out, input);
    host.append(wrap);

    input.addEventListener("input", (e) => {
      if (!activeId) return;
      // One history entry per drag, not one per pixel of travel.
      if (!sliderGesture) { sliderGesture = true; pushHistory(label); }
      comparing = false; $("view-original").setAttribute("aria-pressed", "false");
      const v = Number(e.target.value);
      out.textContent = sliderFmt(key, v);
      adjust.get(activeId)[key] = v;
      scheduleRender();
    });
    input.addEventListener("change", () => { sliderGesture = false; refreshLayers(); });
    input.addEventListener("dblclick", () => {
      const v = blank()[key];
      if (!activeId || adjust.get(activeId)[key] === v) return;
      edit(`Reset ${label.toLowerCase()}`, (a) => (a[key] = v));
      syncControls();
    });
  }
}
buildSliders();

function syncControls() {
  if (!activeId) return;
  const a = adjust.get(activeId);
  for (const k of SLIDER_KEYS) {
    $("s-" + k).value = a[k];
    $("o-" + k).textContent = sliderFmt(k, a[k]);
  }
  $("c-grayscale").checked = a.grayscale;
  $("c-invert").checked = a.invert;
  $("c-noiseMono").checked = a.noiseMono;
  $("filter-color").value = a.filterColor;
  $("btn-uncrop").hidden = !a.crop;
  $("btn-clear-ink").hidden = !a.strokes.length;
  $("btn-clear-gradients").hidden = !a.gradients.length;
  $("btn-clear-shapes").hidden = !a.shapes.length;
  $("btn-unlasso").hidden = !a.lasso;
  drawCurves();
}

function edit(label, fn) {
  if (!activeId) return;
  comparing = false; $("view-original").setAttribute("aria-pressed", "false");
  pushHistory(label);
  fn(adjust.get(activeId));
  scheduleRender();
  // Strip thumbnails carry the edit count, so refresh after the frame lands.
  requestAnimationFrame(refreshLayers);
}

for (const [id, key, label] of [["c-grayscale", "grayscale", "Black & white"], ["c-invert", "invert", "Invert"], ["c-noiseMono", "noiseMono", "Monochrome noise"]]) {
  $(id).addEventListener("change", (e) => edit(label, (a) => (a[key] = e.target.checked)));
}

function setFilterColor(hex) {
  edit("Photo filter", (a) => {
    a.filterColor = hex;
    // Picking a filter with zero density would look like nothing happened.
    if (!a.filterDensity) a.filterDensity = 25;
  });
  syncControls();
}
$("filter-color").addEventListener("change", (e) => setFilterColor(e.target.value));
$("filter-preset").addEventListener("change", (e) => {
  if (e.target.value) setFilterColor(e.target.value);
  e.target.value = "";
});

document.querySelectorAll("[data-act]").forEach((b) => {
  const labels = { "rot-cw": "Rotate right", "rot-ccw": "Rotate left", "flip-h": "Flip horizontal", "flip-v": "Flip vertical" };
  b.addEventListener("click", () => edit(labels[b.dataset.act], (a) => {
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
  pushHistory("Reset all edits");
  adjust.set(activeId, blank());
  syncControls();
  scheduleRender();
  requestAnimationFrame(refreshLayers);
});

$("btn-uncrop").addEventListener("click", () => {
  edit("Remove crop", (a) => (a.crop = null));
  syncControls();
});

// --- levels ----------------------------------------------------------------

$("btn-auto-levels").addEventListener("click", () => {
  if (!activeId) return;
  let black, white;
  try {
    ed.set_ops(activeId, JSON.stringify(buildOps(adjust.get(activeId))));
    [black, white] = ed.auto_levels(activeId).split(",").map(Number);
  } catch (e) { return fail(e); }
  edit("Auto levels", (a) => {
    a.lvBlack = Math.min(253, Math.round(black * 255));
    a.lvWhite = Math.max(a.lvBlack + 2, Math.round(white * 255));
    a.lvGamma = 100;
  });
  syncControls();
});

$("btn-reset-levels").addEventListener("click", () => {
  edit("Reset levels", (a) => {
    const b = blank();
    for (const k of ["lvBlack", "lvGamma", "lvWhite", "lvOutBlack", "lvOutWhite"]) a[k] = b[k];
  });
  syncControls();
});

// --- curves ----------------------------------------------------------------

let curveChan = "rgb";
let curveDrag = null;        // {i, remove}
const CURVE_HIT_PX = 10;
const CURVE_COLOURS = { rgb: "#e6e8ee", red: "#ff6b6b", green: "#5fd38a", blue: "#6aa8ff" };

function curveAt(e) {
  const r = $("curves").getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height, r };
}

function nearestCurvePoint(pts, p) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const d = Math.hypot((pts[i] - p.x) * p.r.width, (pts[i + 1] - p.y) * p.r.height);
    if (d < bestD) { bestD = d; best = i / 2; }
  }
  return bestD <= CURVE_HIT_PX ? best : -1;
}

function drawCurves() {
  const c = $("curves"), ctx = c.getContext("2d"), n = c.width;
  ctx.clearRect(0, 0, n, n);
  if (!activeId || !curveLut) return;
  const a = adjust.get(activeId);
  const pts = a.curves[curveChan];

  // Histogram of the channel being edited, faint, behind everything.
  if (lastHist) {
    const bins = lastHist[curveChan === "rgb" ? "l" : curveChan[0]];
    const max = Math.max(1, ...bins);
    ctx.fillStyle = "rgba(160,170,190,0.16)";
    const bw = n / bins.length;
    bins.forEach((v, i) => { const h = (v / max) * n * 0.9; ctx.fillRect(i * bw, n - h, bw + 0.5, h); });
  }

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = Math.round((i * n) / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, n); ctx.moveTo(0, p); ctx.lineTo(n, p); ctx.stroke();
  }
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, n); ctx.lineTo(n, 0); ctx.stroke();
  ctx.setLineDash([]);

  // The other channels' curves, dimmed, so their combined effect is visible.
  const trace = (flat, colour, width) => {
    const lut = curveLut(new Float32Array(flat));
    ctx.strokeStyle = colour; ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * n, y = n - (lut[i] / 255) * n;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  };
  for (const k of ["rgb", "red", "green", "blue"]) {
    if (k !== curveChan && !isIdentity(a.curves[k])) trace(a.curves[k], CURVE_COLOURS[k] + "55", 2);
  }
  trace(pts, CURVE_COLOURS[curveChan], 3);

  for (let i = 0; i < pts.length; i += 2) {
    if (curveDrag?.remove && curveDrag.i === i / 2) continue;
    ctx.beginPath();
    ctx.arc(pts[i] * n, n - pts[i + 1] * n, 7, 0, Math.PI * 2);
    ctx.fillStyle = curveDrag?.i === i / 2 ? CURVE_COLOURS[curveChan] : "#1b1c1f";
    ctx.strokeStyle = CURVE_COLOURS[curveChan];
    ctx.lineWidth = 2.5;
    ctx.fill(); ctx.stroke();
  }
}

document.querySelectorAll("#curve-chan .btn").forEach((b) => {
  b.addEventListener("click", () => {
    curveChan = b.dataset.chan;
    for (const o of document.querySelectorAll("#curve-chan .btn")) o.setAttribute("aria-pressed", String(o === b));
    drawCurves();
  });
});

$("btn-reset-curve").addEventListener("click", () => {
  edit(`Reset ${curveChan === "rgb" ? "RGB" : curveChan} curve`, (a) => (a.curves[curveChan] = [...IDENTITY_CURVE]));
  drawCurves();
});

(() => {
  const c = $("curves");

  c.addEventListener("pointerdown", (e) => {
    if (!activeId || e.button !== 0) return;
    const p = curveAt(e);
    const pts = adjust.get(activeId).curves[curveChan];
    let i = nearestCurvePoint(pts, p);
    pushHistory("Curves");
    if (i < 0) {
      if (pts.length / 2 >= 16) { say("A curve can have up to 16 points."); return; }
      const x = clamp(p.x, 0, 1);
      // Insert in x order so the flat list stays sorted.
      i = 0;
      while (i < pts.length / 2 && pts[i * 2] < x) i++;
      pts.splice(i * 2, 0, x, clamp(p.y, 0, 1));
    }
    curveDrag = { i, remove: false };
    c.setPointerCapture(e.pointerId);
    drawCurves();
    scheduleRender();
    e.preventDefault();
  });

  c.addEventListener("pointermove", (e) => {
    if (!curveDrag) return;
    const p = curveAt(e);
    const pts = adjust.get(activeId).curves[curveChan];
    const i = curveDrag.i, last = pts.length / 2 - 1;
    const endpoint = i === 0 || i === last;
    // Dragging an inner point well off the graph removes it, as in Photoshop.
    curveDrag.remove = !endpoint && (p.x < -0.12 || p.x > 1.12 || p.y < -0.12 || p.y > 1.12);
    const lo = i > 0 ? pts[(i - 1) * 2] + 0.01 : 0;
    const hi = i < last ? pts[(i + 1) * 2] - 0.01 : 1;
    pts[i * 2] = clamp(p.x, lo, hi);
    pts[i * 2 + 1] = clamp(p.y, 0, 1);
    drawCurves();
    scheduleRender();
  });

  for (const t of ["pointerup", "pointercancel"]) {
    c.addEventListener(t, () => {
      if (!curveDrag) return;
      if (curveDrag.remove) adjust.get(activeId).curves[curveChan].splice(curveDrag.i * 2, 2);
      curveDrag = null;
      drawCurves();
      scheduleRender();
      requestAnimationFrame(refreshLayers);
    });
  }

  c.addEventListener("dblclick", (e) => {
    if (!activeId) return;
    const pts = adjust.get(activeId).curves[curveChan];
    const i = nearestCurvePoint(pts, curveAt(e));
    if (i <= 0 || i >= pts.length / 2 - 1) return;
    edit("Remove curve point", (a) => a.curves[curveChan].splice(i * 2, 2));
    drawCurves();
  });
})();

// --- crop ------------------------------------------------------------------

const cropRect = () => $("canvas").getBoundingClientRect();
const toPx = (c, r) => ({ x: c.x * r.width, y: c.y * r.height, w: c.w * r.width, h: c.h * r.height });
const toNorm = (b, r) => ({ x: b.x / r.width, y: b.y / r.height, w: b.w / r.width, h: b.h / r.height });

function currentAspect() {
  const v = $("crop-aspect").value;
  if (v === "0") return 0;
  if (v === "orig") {
    const l = layers.find((x) => x.id === activeId);
    return l ? l.width / l.height : 0;
  }
  return Number(v) || 0;
}

function moveBox(base, dx, dy, r) {
  return {
    x: clamp(base.x + dx, 0, r.width - base.w),
    y: clamp(base.y + dy, 0, r.height - base.h),
    w: base.w, h: base.h,
  };
}

function resizeBox(base, handle, dx, dy, r, aspect) {
  let x0 = base.x, y0 = base.y, x1 = base.x + base.w, y1 = base.y + base.h;
  if (handle.includes("w")) x0 += dx;
  if (handle.includes("e")) x1 += dx;
  if (handle.includes("n")) y0 += dy;
  if (handle.includes("s")) y1 += dy;

  // Dragging a handle past its opposite edge flips the box rather than
  // producing a negative-width rectangle.
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
  if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }

  x0 = clamp(x0, 0, r.width);  x1 = clamp(x1, 0, r.width);
  y0 = clamp(y0, 0, r.height); y1 = clamp(y1, 0, r.height);

  let box = {
    x: x0, y: y0,
    w: Math.max(x1 - x0, MIN_CROP_PX),
    h: Math.max(y1 - y0, MIN_CROP_PX),
  };
  if (aspect) box = fitAspect(box, handle, aspect, r);

  box.w = Math.min(box.w, r.width);
  box.h = Math.min(box.h, r.height);
  box.x = clamp(box.x, 0, r.width - box.w);
  box.y = clamp(box.y, 0, r.height - box.h);
  return box;
}

/** The canvas is uniformly scaled, so its display aspect equals the source
 *  aspect and ratios can be enforced in screen pixels. */
function fitAspect(box, handle, aspect, r) {
  let { x, y, w, h } = box;
  const vertical = handle === "n" || handle === "s";
  if (vertical) w = h * aspect; else h = w / aspect;

  if (w > r.width) { w = r.width; h = w / aspect; }
  if (h > r.height) { h = r.height; w = h * aspect; }

  // Anchor whichever edges this handle is not dragging.
  if (handle.includes("w")) x = box.x + box.w - w;
  if (handle.includes("n")) y = box.y + box.h - h;
  if (vertical) x = box.x + box.w / 2 - w / 2;
  if (handle === "e" || handle === "w") y = box.y + box.h / 2 - h / 2;

  return { x, y, w, h };
}

function paintCrop() {
  const box = $("crop-box"), layer = $("crop-layer");
  if (!pendingCrop || pendingCrop.w <= 0 || pendingCrop.h <= 0) {
    box.classList.remove("on");
    layer.classList.add("no-sel");
    $("crop-size").textContent = "drag to select";
    return;
  }
  const r = cropRect(), lr = layer.getBoundingClientRect();
  const b = toPx(pendingCrop, r);
  box.style.left = `${r.left - lr.left + b.x}px`;
  box.style.top = `${r.top - lr.top + b.y}px`;
  box.style.width = `${b.w}px`;
  box.style.height = `${b.h}px`;
  box.classList.add("on");
  layer.classList.remove("no-sel");

  const src = layers.find((x) => x.id === activeId);
  if (src) {
    const w = Math.max(1, Math.round(pendingCrop.w * src.width));
    const h = Math.max(1, Math.round(pendingCrop.h * src.height));
    $("crop-size").textContent = `${w} × ${h} px`;
  }
}

(() => {
  const layer = $("crop-layer");

  layer.addEventListener("pointerdown", (e) => {
    if (!activeId) return;
    const r = cropRect();
    const handle = e.target.dataset ? e.target.dataset.h : undefined;
    const onBox = handle || e.target === $("crop-box");

    if (handle) {
      gesture = { mode: "resize", handle, sx: e.clientX, sy: e.clientY, r, base: toPx(pendingCrop, r) };
    } else if (onBox && pendingCrop) {
      gesture = { mode: "move", sx: e.clientX, sy: e.clientY, r, base: toPx(pendingCrop, r) };
    } else {
      // A fresh drag is just a resize from a zero-size box at the pointer.
      const x = clamp(e.clientX - r.left, 0, r.width);
      const y = clamp(e.clientY - r.top, 0, r.height);
      gesture = { mode: "resize", handle: "se", sx: e.clientX, sy: e.clientY, r, base: { x, y, w: 0, h: 0 } };
    }
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  layer.addEventListener("pointermove", (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
    const box = gesture.mode === "move"
      ? moveBox(gesture.base, dx, dy, gesture.r)
      : resizeBox(gesture.base, gesture.handle, dx, dy, gesture.r, currentAspect());
    pendingCrop = toNorm(box, gesture.r);
    paintCrop();
  });

  for (const t of ["pointerup", "pointercancel"]) {
    layer.addEventListener(t, () => (gesture = null));
  }
})();

$("crop-aspect").addEventListener("change", () => {
  const aspect = currentAspect();
  if (!aspect || !pendingCrop) return;
  const r = cropRect();
  let box = fitAspect(toPx(pendingCrop, r), "se", aspect, r);
  box.x = clamp(box.x, 0, r.width - box.w);
  box.y = clamp(box.y, 0, r.height - box.h);
  pendingCrop = toNorm(box, r);
  paintCrop();
});

$("btn-crop").addEventListener("click", () => (cropping ? exitCrop() : activateTool("crop")));
$("btn-crop-cancel").addEventListener("click", exitCrop);

$("btn-crop-apply").addEventListener("click", () => {
  if (pendingCrop && pendingCrop.w > 0.005 && pendingCrop.h > 0.005) {
    pushHistory("Crop");
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
  gesture = null;
  $("crop-layer").hidden = true;
  $("crop-bar").hidden = true;
  $("crop-box").classList.remove("on");
  $("btn-crop").textContent = "Crop";
  scheduleRender();
  updateToolUI();
}



// --- scissors --------------------------------------------------------------

let lassoing = false;
let lassoPts = [];       // flat x,y pairs in source coordinates
let lassoHover = null;   // cursor position for the rubber band, in ink pixels
let lassoDrag = null;

const CLOSE_PX = 12;     // how near the first point counts as closing the shape
// A click is never perfectly still. Below this much travel it stays a click,
// so placing single vertices actually works with a real mouse.
const DRAG_PX = 10;

function enterLasso() {
  if (!activeId) return;
  lassoing = true;
  lassoPts = [];
  lassoHover = null;
  $("lasso-bar").hidden = false;
  $("ink").hidden = false;
  $("btn-lasso").textContent = "Close scissors";
  requestAnimationFrame(() => { syncInk(); drawLasso(); });
}

function exitLasso() {
  lassoing = false;
  lassoPts = [];
  lassoHover = null;
  lassoDrag = null;
  $("lasso-bar").hidden = true;
  $("ink").hidden = true;
  $("btn-lasso").textContent = "Scissors";
  const ink = $("ink");
  ink.getContext("2d").clearRect(0, 0, ink.width, ink.height);
  updateToolUI();
}

/** Source coordinates back to a position on the overlay, for drawing. */
function sourceToInk(sx, sy, a) {
  let x = sx, y = sy;
  if (a.crop) { x = (x - a.crop.x) / a.crop.w; y = (y - a.crop.y) / a.crop.h; }
  if (a.lasso) {
    const b = lassoBounds(a.lasso);
    x = (x - b.x) / b.w; y = (y - b.y) / b.h;
  }
  const t = a.turns % 4;
  if (t === 1) { const u = x; x = 1 - y; y = u; }
  else if (t === 2) { x = 1 - x; y = 1 - y; }
  else if (t === 3) { const u = x; x = y; y = 1 - u; }
  if (a.flipH) x = 1 - x;
  if (a.flipV) y = 1 - y;
  const ink = $("ink");
  return [x * ink.width, y * ink.height];
}

function drawLasso() {
  const ink = $("ink"), ctx = ink.getContext("2d");
  ctx.clearRect(0, 0, ink.width, ink.height);
  if (!activeId) return;
  const a = adjust.get(activeId);
  const pts = [];
  for (let i = 0; i < lassoPts.length; i += 2) {
    pts.push(sourceToInk(lassoPts[i], lassoPts[i + 1], a));
  }

  const n = pts.length;
  $("btn-lasso-apply").disabled = n < 3;
  $("btn-lasso-undo").disabled = n === 0;
  const hint = $("lasso-hint");
  hint.classList.toggle("ready", n >= 3);
  hint.textContent = n === 0
    ? "Click to place points, or drag to draw freehand"
    : n < 3
      ? `${n} point${n > 1 ? "s" : ""} — at least 3 needed`
      : `${n} points — right-click, or click the first point, to cut`;

  if (!n) return;

  const path = new Path2D();
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n; i++) path.lineTo(pts[i][0], pts[i][1]);
  if (lassoHover && !lassoDrag) path.lineTo(lassoHover[0], lassoHover[1]);
  path.closePath();

  // Dim everything that would be discarded. Even-odd against a full-canvas
  // rect leaves the interior of the shape untouched.
  if (n >= 3) {
    const outside = new Path2D();
    outside.rect(0, 0, ink.width, ink.height);
    outside.addPath(path);
    ctx.fillStyle = "rgba(10,8,4,0.62)";
    ctx.fill(outside, "evenodd");
  }

  ctx.strokeStyle = "#e0a032";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke(path);
  ctx.setLineDash([]);

  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.arc(pts[i][0], pts[i][1], i === 0 ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "#e0a032" : "#14120e";
    ctx.strokeStyle = "#e0a032";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }
}

function addLassoPoint(e) {
  const ink = $("ink"), r = ink.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  const [sx, sy] = screenToSource(nx, ny, adjust.get(activeId));
  lassoPts.push(sx, sy);
}

/** True when the pointer is back on the first vertex. */
function overFirstPoint(e) {
  if (lassoPts.length < 6) return false;
  const ink = $("ink"), r = ink.getBoundingClientRect();
  const [fx, fy] = sourceToInk(lassoPts[0], lassoPts[1], adjust.get(activeId));
  const scale = ink.width / r.width;
  return Math.hypot((e.clientX - r.left) * scale - fx, (e.clientY - r.top) * scale - fy) < CLOSE_PX * scale;
}

function applyLasso() {
  if (lassoPts.length < 6) return;
  const pts = lassoPts.slice();
  pushHistory("Cut out");
  const a = adjust.get(activeId);
  // Points are captured in source space, but any earlier lasso already
  // reframed the image. Committing a second cut on top would need the points
  // re-expressed against the first, so replace rather than compose.
  a.lasso = pts;
  exitLasso();
  syncControls();
  scheduleRender();
  requestAnimationFrame(refreshLayers);
}

$("btn-lasso").addEventListener("click", () => (lassoing ? exitLasso() : activateTool("lasso")));
$("btn-lasso-cancel").addEventListener("click", exitLasso);
$("btn-lasso-apply").addEventListener("click", applyLasso);
$("btn-lasso-undo").addEventListener("click", () => {
  lassoPts.splice(-2, 2);
  drawLasso();
});
$("btn-unlasso").addEventListener("click", () => {
  edit("Remove cut-out", (a) => (a.lasso = null));
  syncControls();
});

(() => {
  const ink = $("ink");
  let downAt = null;

  ink.addEventListener("pointerdown", (e) => {
    // Right-click is reserved for finishing the shape, so it must not also
    // drop a vertex on the way through.
    if (!lassoing || !activeId || e.button !== 0) return;
    ink.setPointerCapture(e.pointerId);
    downAt = [e.clientX, e.clientY];
    lassoDrag = null;
    e.preventDefault();
  });

  ink.addEventListener("pointermove", (e) => {
    if (!lassoing) return;
    const r = ink.getBoundingClientRect();
    const scale = ink.width / r.width;
    lassoHover = [(e.clientX - r.left) * scale, (e.clientY - r.top) * scale];

    if (downAt) {
      // A press that travels turns into a freehand trace; a press that does
      // not is a single placed vertex. One tool, both interaction styles.
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      if (!lassoDrag && moved > DRAG_PX) lassoDrag = [e.clientX, e.clientY];
      if (lassoDrag) {
        if (Math.hypot(e.clientX - lassoDrag[0], e.clientY - lassoDrag[1]) >= 3) {
          addLassoPoint(e);
          lassoDrag = [e.clientX, e.clientY];
        }
      }
    }
    drawLasso();
  });

  ink.addEventListener("contextmenu", (e) => {
    if (!lassoing) return;
    e.preventDefault();
    // Right-click closes the shape and cuts, the way polygon lasso tools have
    // always worked. Enter does the same for keyboard users.
    if (lassoPts.length >= 6) applyLasso();
  });

  for (const t of ["pointerup", "pointercancel"]) {
    ink.addEventListener(t, (e) => {
      if (!lassoing || !downAt) return;
      const wasDrag = !!lassoDrag;
      downAt = null;
      lassoDrag = null;
      if (wasDrag) { drawLasso(); return; }
      if (overFirstPoint(e)) { applyLasso(); return; }
      addLassoPoint(e);
      drawLasso();
    });
  }
})();

// --- painting --------------------------------------------------------------

let painting = false;
let inkStroke = null;        // stroke being drawn, in source coordinates
let brush = { h: 355, s: 0.78, v: 0.85, alpha: 1, size: 14, erase: false };
let recent = ["#e0a032", "#d24b3f", "#3f7dd2", "#4caf6d", "#f2f0e8", "#14120e"];

/** Undoes the geometry ops, so a point on screen becomes a point on the source.
 *  This is the exact inverse of map_point() in src/ops.rs -- if the forward
 *  mapping there changes, this has to change with it. */
function screenToSource(nx, ny, a) {
  let x = nx, y = ny;
  if (a.flipV) y = 1 - y;
  if (a.flipH) x = 1 - x;
  const t = a.turns % 4;
  if (t === 1) { const u = x; x = y; y = 1 - u; }
  else if (t === 2) { x = 1 - x; y = 1 - y; }
  else if (t === 3) { const u = x; x = 1 - y; y = u; }
  // A lasso reframes the image to its bounding box, so undo that before the
  // rectangular crop -- the reverse of the order buildOps emits them in.
  if (a.lasso) {
    const b = lassoBounds(a.lasso);
    x = x * b.w + b.x;
    y = y * b.h + b.y;
  }
  if (a.crop) { x = x * a.crop.w + a.crop.x; y = y * a.crop.h + a.crop.y; }
  return [x, y];
}

/** Bounding box of a flat point list, in the same normalized space. */
function lassoBounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  return { x: x0, y: y0, w: Math.max(x1 - x0, 1e-6), h: Math.max(y1 - y0, 1e-6) };
}

/** Brush and stroke widths are fractions of the source short edge, but the
 *  live overlay draws in screen pixels, so convert through the preview scale. */
function sourceShortOnScreen() {
  const l = layers.find((x) => x.id === activeId);
  const canvas = $("canvas");
  if (!l || !canvas.width) return 0;
  const previewScale = Math.min(1, previewCap() / Math.max(l.width, l.height));
  const sourceShortInPreview = Math.min(l.width, l.height) * previewScale;
  const screenPerPreview = canvas.getBoundingClientRect().width / canvas.width;
  return sourceShortInPreview * screenPerPreview;
}

const brushScreenPx = () => widthFraction() * sourceShortOnScreen() || brush.size;
const widthFraction = () => (brush.size / 100) * 0.18 + 0.002;

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h / 60) % 6];
  return t.map((n) => Math.round((n + m) * 255));
}

function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: mx ? d / mx : 0, v: mx };
}

const brushRgb = () => hsvToRgb(brush.h, brush.s, brush.v);

function drawWheel() {
  const c = $("wheel"), ctx = c.getContext("2d");
  const n = c.width, r = n / 2;
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - r + 0.5, dy = y - r + 0.5;
      const dist = Math.hypot(dx, dy);
      const i = (y * n + x) * 4;
      if (dist > r) { img.data[i + 3] = 0; continue; }
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const [rr, gg, bb] = hsvToRgb(hue, Math.min(dist / r, 1), brush.v);
      img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb;
      // Feather the rim so the disc does not look jagged.
      img.data[i + 3] = Math.round(255 * Math.min(1, r - dist));
    }
  }
  ctx.putImageData(img, 0, 0);

  const ang = brush.h * Math.PI / 180, rad = brush.s * r;
  const px = r + Math.cos(ang) * rad, py = r + Math.sin(ang) * rad;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.strokeStyle = brush.v > 0.55 ? "#14120e" : "#e8e2d4";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function syncBrush() {
  const hex = rgbToHex(brushRgb());
  $("swatch").style.setProperty("--sw", hex);
  $("swatch").style.opacity = String(brush.alpha);
  if (document.activeElement !== $("hex")) $("hex").value = hex;
  $("btn-eraser").setAttribute("aria-pressed", String(brush.erase));
  drawWheel();
  updateToolUI();
}

function renderSwatches() {
  const box = $("swatches");
  box.replaceChildren();
  for (const hex of recent.slice(0, 16)) {
    const b = document.createElement("button");
    b.style.background = hex;
    b.title = hex;
    b.onclick = () => {
      const c = hexToHsv(hex);
      if (c) { Object.assign(brush, c); syncBrush(); }
    };
    box.append(b);
  }
}

function rememberColour(hex) {
  recent = [hex, ...recent.filter((c) => c !== hex)].slice(0, 16);
  renderSwatches();
}

function syncInk() {
  const ink = $("ink"), canvas = $("canvas");
  const r = canvas.getBoundingClientRect();
  const parent = ink.parentElement.getBoundingClientRect();
  ink.width = Math.round(r.width);
  ink.height = Math.round(r.height);
  ink.style.left = `${r.left - parent.left}px`;
  ink.style.top = `${r.top - parent.top}px`;
}

function enterPaint() {
  if (!activeId) return;
  painting = true;
  $("paint-bar").hidden = false;
  $("ink").hidden = false;
  $("btn-paint").textContent = "Close brush";
  syncBrush();
  renderSwatches();
  requestAnimationFrame(syncInk);
}

function exitPaint() {
  painting = false;
  inkStroke = null;
  $("paint-bar").hidden = true;
  $("wheel-pop").hidden = true;
  $("ink").hidden = true;
  $("btn-paint").textContent = "Brush";
  updateToolUI();
}

$("btn-paint").addEventListener("click", () => (painting ? exitPaint() : activateTool("paint")));
$("btn-paint-done").addEventListener("click", exitPaint);
$("btn-clear-ink").addEventListener("click", () => {
  edit("Clear drawing", (a) => (a.strokes = []));
  syncControls();
});

$("swatch").addEventListener("click", () => {
  const p = $("wheel-pop");
  p.hidden = !p.hidden;
  if (!p.hidden) drawWheel();
});

$("s-brush").addEventListener("input", (e) => (brush.size = Number(e.target.value)));
$("s-alpha").addEventListener("input", (e) => { brush.alpha = Number(e.target.value) / 100; syncBrush(); });
$("s-value").addEventListener("input", (e) => { brush.v = Number(e.target.value) / 100; syncBrush(); });
$("btn-eraser").addEventListener("click", () => { brush.erase = !brush.erase; syncBrush(); });

$("hex").addEventListener("change", (e) => {
  const c = hexToHsv(e.target.value);
  if (c) { Object.assign(brush, c); $("s-value").value = Math.round(c.v * 100); syncBrush(); }
  else syncBrush();
});

(() => {
  const c = $("wheel");
  let down = false;
  const pick = (e) => {
    const r = c.getBoundingClientRect(), rad = r.width / 2;
    const dx = e.clientX - r.left - rad, dy = e.clientY - r.top - rad;
    brush.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    brush.s = Math.min(Math.hypot(dx, dy) / rad, 1);
    syncBrush();
  };
  c.addEventListener("pointerdown", (e) => { down = true; c.setPointerCapture(e.pointerId); pick(e); });
  c.addEventListener("pointermove", (e) => down && pick(e));
  for (const t of ["pointerup", "pointercancel"]) {
    c.addEventListener(t, () => { down = false; rememberColour(rgbToHex(brushRgb())); });
  }
})();

(() => {
  const ink = $("ink");
  let last = null;

  const at = (e) => {
    const r = ink.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  ink.addEventListener("pointerdown", (e) => {
    // Several tools share this overlay, so each has to check it owns the
    // pointer. Without this the brush also fires during a scissors click and
    // commits a one-point stroke, which renders as a stray dot.
    if (!painting || !activeId || e.button !== 0) return;
    if (adjust.get(activeId).strokes.length >= (LIMITS?.maxStrokes ?? Infinity)) {
      return say(`This image has reached the limit of ${LIMITS.maxStrokes} brush strokes.`, true);
    }
    ink.setPointerCapture(e.pointerId);
    const [rgb, a] = [brushRgb(), adjust.get(activeId)];
    inkStroke = {
      color: [...rgb, Math.round(brush.alpha * 255)],
      width: widthFraction(),
      erase: brush.erase,
      points: [],
    };
    last = at(e);
    pushPoint(e, a);
    paintLive(last, last);
    e.preventDefault();
  });

  ink.addEventListener("pointermove", (e) => {
    if (!painting || !inkStroke) return;
    const p = at(e);
    // Thin out the point list: anything closer than a couple of pixels adds
    // bytes to the project file without changing the visible line.
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) return;
    pushPoint(e, adjust.get(activeId));
    paintLive(last, p);
    last = p;
  });

  for (const t of ["pointerup", "pointercancel", "pointerleave"]) {
    ink.addEventListener(t, () => {
      if (!inkStroke) return;
      const stroke = inkStroke;
      inkStroke = null;
      ink.getContext("2d").clearRect(0, 0, ink.width, ink.height);
      if (stroke.points.length < 2) return;
      // One history entry per stroke, so Ctrl+Z lifts the last line.
      pushHistory(stroke.erase ? "Eraser" : "Brush stroke");
      adjust.get(activeId).strokes.push(stroke);
      if (!stroke.erase) rememberColour(rgbToHex(stroke.color.slice(0, 3)));
      scheduleRender();
      syncControls();
      requestAnimationFrame(refreshLayers);
    });
  }

  function pushPoint(e, a) {
    const ink = $("ink"), r = ink.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    const [sx, sy] = screenToSource(nx, ny, a);
    inkStroke.points.push(sx, sy);
  }

  /** Immediate feedback on a plain 2D context. The authoritative render still
   *  happens in Rust when the stroke is committed. */
  function paintLive(a, b) {
    const ctx = $("ink").getContext("2d");
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brushScreenPx();
    if (brush.erase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.strokeStyle = `rgba(${brushRgb().join(",")},${brush.alpha})`;
    }
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
  }
})();

// --- gradient & shape tools ------------------------------------------------
// Both are drag tools on the shared ink overlay. The overlay previews with a
// plain 2D context; Rust renders the committed result, in source space, so it
// survives crops and rotations like brushwork does.

let drawTool = null;         // "gradient" | "shape" | null
let shapeKind = "rect";
let dragLine = null;         // {a: [x, y], b: [x, y]} in ink pixels

const shapeWidthFraction = () => (Number($("sh-width").value) / 100) * 0.05;
const rgba = (hex, alpha) => [...hexToRgb(hex), alpha];

function enterDrawTool(kind) {
  if (!activeId) return;
  drawTool = kind;
  $(kind + "-bar").hidden = false;
  $("ink").hidden = false;
  $("ink").style.cursor = "crosshair";
  $("btn-" + kind).setAttribute("aria-pressed", "true");
  requestAnimationFrame(syncInk);
}

function exitDrawTool() {
  if (!drawTool) return;
  $(drawTool + "-bar").hidden = true;
  $("btn-" + drawTool).setAttribute("aria-pressed", "false");
  drawTool = null;
  dragLine = null;
  const ink = $("ink");
  ink.hidden = true;
  ink.style.mixBlendMode = "";
  ink.getContext("2d").clearRect(0, 0, ink.width, ink.height);
  updateToolUI();
}

$("btn-gradient").addEventListener("click", () => (drawTool === "gradient" ? exitDrawTool() : activateTool("gradient")));
$("btn-shape").addEventListener("click", () => (drawTool === "shape" ? exitDrawTool() : activateTool("shape")));
$("btn-gradient-done").addEventListener("click", exitDrawTool);
$("btn-shape-done").addEventListener("click", exitDrawTool);
$("btn-clear-gradients").addEventListener("click", () => { edit("Clear gradients", (a) => (a.gradients = [])); syncControls(); });
$("btn-clear-shapes").addEventListener("click", () => { edit("Clear shapes", (a) => (a.shapes = [])); syncControls(); });

document.querySelectorAll("#shape-kind .btn").forEach((b) => {
  b.addEventListener("click", () => {
    shapeKind = b.dataset.kind;
    for (const o of document.querySelectorAll("#shape-kind .btn")) o.setAttribute("aria-pressed", String(o === b));
  });
});

/** Shift snaps lines to 45° and boxes to squares, as in Photoshop. */
function constrain(a, b, square) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (square) {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + Math.sign(dx || 1) * d, a[1] + Math.sign(dy || 1) * d];
  }
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
}

function previewDrag() {
  const ink = $("ink"), ctx = ink.getContext("2d");
  ctx.clearRect(0, 0, ink.width, ink.height);
  if (!dragLine) return;
  const [ax, ay] = dragLine.a, [bx, by] = dragLine.b;

  if (drawTool === "gradient") {
    const from = $("g-from").value, to = $("g-to").value;
    const g = $("g-kind").value === "linear"
      ? ctx.createLinearGradient(ax, ay, bx, by)
      : ctx.createRadialGradient(ax, ay, 0, ax, ay, Math.hypot(bx - ax, by - ay));
    g.addColorStop(0, from);
    g.addColorStop(1, $("g-clear").checked ? `rgba(${hexToRgb(to).join(",")},0)` : to);
    // CSS blend modes match the engine's names, so the overlay previews the
    // composite against the real image underneath.
    ink.style.mixBlendMode = $("g-blend").value.replace("_", "-");
    ctx.globalAlpha = Number($("g-opacity").value) / 100;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ink.width, ink.height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
    }
    return;
  }

  ctx.save();
  ctx.lineWidth = Math.max(1, shapeWidthFraction() * sourceShortOnScreen());
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = $("sh-fill").value;
  ctx.strokeStyle = $("sh-stroke").value;
  const path = new Path2D();
  if (shapeKind === "rect") path.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  else if (shapeKind === "ellipse") path.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
  else { path.moveTo(ax, ay); path.lineTo(bx, by); }
  if (shapeKind !== "line" && $("sh-fill-on").checked) ctx.fill(path);
  if (shapeKind === "line" || $("sh-stroke-on").checked) {
    if (shapeKind === "line") ctx.strokeStyle = $("sh-stroke-on").checked ? $("sh-stroke").value : $("sh-fill").value;
    ctx.stroke(path);
  }
  ctx.restore();
}

function commitDrag() {
  const ink = $("ink");
  const a = adjust.get(activeId);
  const [x0, y0] = screenToSource(dragLine.a[0] / ink.width, dragLine.a[1] / ink.height, a);
  const [x1, y1] = screenToSource(dragLine.b[0] / ink.width, dragLine.b[1] / ink.height, a);

  if (drawTool === "gradient") {
    if (a.gradients.length >= LIMITS.maxGradients) return say(`An image can hold up to ${LIMITS.maxGradients} gradients.`, true);
    const to = rgba($("g-to").value, $("g-clear").checked ? 0 : 255);
    edit("Gradient", (s) => s.gradients.push({
      kind: $("g-kind").value, x0, y0, x1, y1,
      from: rgba($("g-from").value, 255), to,
      opacity: Number($("g-opacity").value) / 100, blend: $("g-blend").value,
    }));
  } else {
    if (a.shapes.length >= LIMITS.maxShapes) return say(`An image can hold up to ${LIMITS.maxShapes} shapes.`, true);
    const line = shapeKind === "line";
    const fill = !line && $("sh-fill-on").checked ? rgba($("sh-fill").value, 255) : null;
    // A line is all stroke; with Stroke unticked it borrows the fill colour.
    const strokeHex = $("sh-stroke-on").checked ? $("sh-stroke").value : line ? $("sh-fill").value : null;
    const stroke = strokeHex ? rgba(strokeHex, 255) : null;
    if (!fill && !stroke) return say("Turn on Fill or Stroke to draw a shape.");
    const names = { rect: "Rectangle", ellipse: "Ellipse", line: "Line" };
    edit(names[shapeKind], (s) => s.shapes.push({ kind: shapeKind, x0, y0, x1, y1, fill, stroke, width: shapeWidthFraction() }));
  }
  syncControls();
}

(() => {
  const ink = $("ink");
  const at = (e) => {
    const r = ink.getBoundingClientRect();
    return [(e.clientX - r.left) * (ink.width / r.width), (e.clientY - r.top) * (ink.height / r.height)];
  };

  ink.addEventListener("pointerdown", (e) => {
    if (!drawTool || !activeId || e.button !== 0) return;
    ink.setPointerCapture(e.pointerId);
    const p = at(e);
    dragLine = { a: p, b: p };
    e.preventDefault();
  });

  ink.addEventListener("pointermove", (e) => {
    if (!drawTool || !dragLine) return;
    const p = at(e);
    const boxy = drawTool === "shape" && shapeKind !== "line";
    dragLine.b = e.shiftKey ? constrain(dragLine.a, p, boxy) : p;
    previewDrag();
  });

  for (const t of ["pointerup", "pointercancel"]) {
    ink.addEventListener(t, (e) => {
      if (!drawTool || !dragLine) return;
      const moved = Math.hypot(dragLine.b[0] - dragLine.a[0], dragLine.b[1] - dragLine.a[1]);
      if (t === "pointerup" && moved > 3) commitDrag();
      dragLine = null;
      // Leave the preview up until the engine's render replaces it.
      requestAnimationFrame(() => requestAnimationFrame(previewDrag));
    });
  }
})();

// --- export ----------------------------------------------------------------

const FORMATS = {
  png: { type: "image/png", ext: ".png", description: "PNG image", hint: "Lossless, and keeps transparency. Larger files." },
  jpeg: { type: "image/jpeg", ext: ".jpg", description: "JPEG image", hint: "Much smaller files. Transparent areas are filled with white." },
  webp: { type: "image/webp", ext: ".webp", description: "WebP image", hint: "Lossless with transparency, usually smaller than PNG." },
};

function openExport() {
  if (!activeId) return;
  const l = layers.find((x) => x.id === activeId);
  const name = l?.name || "";
  exportFmt = /\.jpe?g$/i.test(name) ? "jpeg" : /\.webp$/i.test(name) ? "webp" : "png";
  syncExport();
  $("export-dialog").showModal();
}
$("btn-export").addEventListener("click", openExport);

document.querySelectorAll("#fmt-seg .btn").forEach((b) => {
  b.addEventListener("click", () => { exportFmt = b.dataset.fmt; syncExport(); });
});

$("s-quality").addEventListener("input", (e) => ($("o-quality").textContent = e.target.value));
$("x-scale").addEventListener("change", syncExport);
$("btn-export-cancel").addEventListener("click", () => $("export-dialog").close());

function syncExport() {
  for (const b of document.querySelectorAll("#fmt-seg .btn")) {
    b.setAttribute("aria-pressed", String(b.dataset.fmt === exportFmt));
  }
  $("quality-field").hidden = exportFmt !== "jpeg";
  $("fmt-hint").textContent = FORMATS[exportFmt].hint;

  if (!activeId) return;
  try {
    const [w, h] = ed.output_dims(activeId, Number($("x-scale").value)).split("x");
    $("x-size").textContent = `${w} × ${h} px`;
    $("x-size").classList.remove("bad");
    $("btn-export-go").disabled = false;
  } catch (e) {
    // Too large to export: say why where the size would be, and block the button.
    $("x-size").textContent = String(e?.message || e).split(".")[0];
    $("x-size").classList.add("bad");
    $("btn-export-go").disabled = true;
  }
  try { $("x-name").textContent = ed.export_name(activeId, exportFmt); } catch {}
}

$("btn-export-go").addEventListener("click", async () => {
  const btn = $("btn-export-go");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Rendering…";
  // Full-resolution rendering blocks the main thread. Yield two frames so the
  // label actually paints before we do. A worker is the real fix.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  let bytes, name;
  try {
    const q = Number($("s-quality").value);
    bytes = ed.export(activeId, exportFmt, q, Number($("x-scale").value));
    name = ed.export_name(activeId, exportFmt);
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    return fail(e);
  }

  btn.disabled = false;
  btn.textContent = label;
  $("export-dialog").close();

  const f = FORMATS[exportFmt];
  const ok = await putFile(new Blob([bytes], { type: f.type }), name, {
    description: f.description,
    accept: { [f.type]: [f.ext] },
  });
  if (ok) say(`Exported ${name} — ${formatBytes(bytes.length)}.`);
});

// --- files -----------------------------------------------------------------

function formatBytes(n) {
  if (!Number.isFinite(n)) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

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

/** Checks a file against the engine's limits before a single byte is read,
 *  so an oversized file never reaches memory. Rust re-checks everything. */
function preflightImage(f, count, held) {
  if (count >= LIMITS.maxDocuments) {
    return `Darkroom keeps up to ${LIMITS.maxDocuments} images open. Close one from the filmstrip first.`;
  }
  if (f.size > LIMITS.maxImageBytes) {
    return `'${f.name}' is ${formatBytes(f.size)}. Images are limited to ${formatBytes(LIMITS.maxImageBytes)} each.`;
  }
  if (held + f.size > LIMITS.maxSessionBytes) {
    return `Opening '${f.name}' would hold more than ${formatBytes(LIMITS.maxSessionBytes)} of images in memory. Close some images first.`;
  }
  return null;
}

async function importFiles(files) {
  if (!ed) return say("Build the image engine first; see README.", true);
  leaveTools(); comparing = false; $("view-original").setAttribute("aria-pressed", "false");
  let added = 0, refused = 0;
  let count = layers.length;
  let held = layers.reduce((n, l) => n + (l.bytes || 0), 0);
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const problem = preflightImage(f, count, held);
    if (problem) { fail(problem); refused++; if (count >= LIMITS.maxDocuments) break; continue; }
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const id = ed.add_image(f.name, buf);
      adjust.set(id, blank());
      activeId = id;
      added++; count++; held += f.size;
    } catch (e) { fail(e); refused++; }
  }
  if (!added) return;
  refreshLayers();
  syncControls();
  updateHistoryButtons();
  scheduleRender();
  // Leave an error toast up if something was refused; it says more.
  if (!refused) say(`Imported ${added} image${added > 1 ? "s" : ""}.`);
}

async function openProject(file) {
  if (!ed) return say("Build the image engine first; see README.", true);
  if (file.size > LIMITS.maxBundleBytes) {
    return fail(`'${file.name}' is ${formatBytes(file.size)}. Darkroom opens projects up to ${formatBytes(LIMITS.maxBundleBytes)}.`);
  }
  leaveTools(); comparing = false; $("view-original").setAttribute("aria-pressed", "false");
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    ed.load_bundle(buf);
  } catch (e) { return fail(e); }

  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  adjust.clear();
  history.clear();
  activeId = null;

  try { layers = JSON.parse(ed.layers_json()); } catch (e) { return fail(e); }
  for (const l of layers) adjust.set(l.id, parseOps(JSON.parse(ed.get_ops(l.id))));
  activeId = layers.length ? layers[0].id : null;

  refreshLayers();
  syncControls();
  updateHistoryButtons();
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

// --- view: zoom & pan ------------------------------------------------------

const ZOOMS = [...$("view-zoom").options].map((o) => Number(o.value));

function onZoom() {
  applyZoom();
  if (cropping) paintCrop();
  if (painting || lassoing || drawTool) { syncInk(); if (lassoing) drawLasso(); }
}

function zoomStep(dir) {
  const cur = Number($("view-zoom").value);
  let i = ZOOMS.indexOf(cur);
  if (i < 0) i = 0;
  const next = ZOOMS[clamp(i + dir, 0, ZOOMS.length - 1)];
  if (next === cur) return;
  // Keep the centre of the view where it was, rather than jumping to a corner.
  const cx = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, stage.scrollWidth);
  const cy = (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, stage.scrollHeight);
  $("view-zoom").value = String(next);
  onZoom();
  stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
  stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
}

function applyZoom() {
  if (!activeId || $("image-workspace").hidden) return;
  const canvas = $("canvas");
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.min(1, Math.max(1,width)/canvas.width, Math.max(1,height)/canvas.height) * Number($("view-zoom").value);
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
}

$("view-zoom").onchange = onZoom;
$("view-fit").onclick = () => { $("view-zoom").value = "1"; onZoom(); };
$("view-in").onclick = () => zoomStep(1);
$("view-out").onclick = () => zoomStep(-1);

stage.addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !activeId) return;
  e.preventDefault();
  zoomStep(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// Panning with the Hand tool or a held Space bar. Listening in the capture
// phase lets it take the pointer before whichever tool overlay is on top.
let spaceDown = false;
let pan = null;
const panning = () => (spaceDown || handTool) && !!activeId;
const BARS = ".view-bar, .tool-bar, .paint-bar, .crop-bar, .lasso-bar";

stage.addEventListener("pointerdown", (e) => {
  if (!panning() || e.button !== 0 || e.target.closest(BARS)) return;
  e.stopPropagation(); e.preventDefault();
  pan = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("grabbing");
}, true);
stage.addEventListener("pointermove", (e) => {
  if (!pan) return;
  e.stopPropagation();
  stage.scrollLeft = pan.sl - (e.clientX - pan.x);
  stage.scrollTop = pan.st - (e.clientY - pan.y);
}, true);
for (const t of ["pointerup", "pointercancel"]) {
  stage.addEventListener(t, (e) => {
    if (!pan) return;
    e.stopPropagation();
    pan = null;
    stage.classList.remove("grabbing");
  }, true);
}

function setSpace(down) {
  spaceDown = down;
  stage.classList.toggle("can-pan", panning());
}

// --- keyboard --------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if ($("image-workspace").hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if ($("export-dialog").open || $("shortcuts-dialog").open) return;
  const k = e.key.toLowerCase();

  if (e.ctrlKey || e.metaKey) {
    if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === "y") { e.preventDefault(); redo(); }
    else if (k === "=" || k === "+") { e.preventDefault(); zoomStep(1); }
    else if (k === "-") { e.preventDefault(); zoomStep(-1); }
    else if (k === "0") { e.preventDefault(); $("view-fit").click(); }
    else if (k === "o") { e.preventDefault(); $("btn-open").click(); }
    else if (k === "s") { e.preventDefault(); if (!$("btn-save").disabled) $("btn-save").click(); }
    else if (k === "e" && e.shiftKey) { e.preventDefault(); openExport(); }
    return;
  }

  if (e.key === " ") {
    // Space must not also press whichever button has focus.
    e.preventDefault();
    if (!e.repeat) setSpace(true);
    return;
  }
  if (e.key === "Escape") { leaveTools(); return; }
  if (lassoing && e.key === "Enter") { applyLasso(); return; }
  if (e.key === "?") { $("shortcuts-dialog").showModal(); return; }
  if (e.key === "\\") { $("view-original").click(); return; }
  if (e.key === "[" || e.key === "]") {
    const d = e.key === "]" ? 1 : -1;
    if (painting) {
      brush.size = clamp(brush.size + d * 3, 1, 100);
      $("s-brush").value = brush.size;
    } else if (drawTool === "shape") {
      $("sh-width").value = clamp(Number($("sh-width").value) + d * 3, 1, 100);
    }
    return;
  }

  const tool = { h: "hand", b: "paint", c: "crop", l: "lasso", e: "eraser", g: "gradient", u: "shape", i: "eyedropper" }[k];
  if (tool) { e.preventDefault(); activateTool(tool); }
});

document.addEventListener("keyup", (e) => { if (e.key === " ") setSpace(false); });
window.addEventListener("blur", () => setSpace(false));

$("btn-shortcuts").onclick = () => $("shortcuts-dialog").showModal();
$("btn-shortcuts-close").onclick = () => $("shortcuts-dialog").close();

// --- chrome ----------------------------------------------------------------

let toastTimer;
function say(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 7000 : 4200);
}

function fail(e) {
  say(typeof e === "string" ? e : e?.message || String(e), true);
  console.error(e);
}

window.addEventListener("resize", () => {
  if (activeId) scheduleRender();
  if (cropping) paintCrop();
  if (painting || drawTool) syncInk();
  if (lassoing) { syncInk(); drawLasso(); }
});

// Best-effort scrub on unload. The tab teardown does the real work.
window.addEventListener("pagehide", () => {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  try { ed?.clear(); } catch {}
});

function leaveTools() {
  if (cropping) exitCrop();
  if (painting) exitPaint();
  if (lassoing) exitLasso();
  if (drawTool) exitDrawTool();
  sampling = false;
  handTool = false;
  $("canvas").style.cursor = "";
  updateToolUI();
}

function currentTool() {
  if (cropping) return "crop";
  if (lassoing) return "lasso";
  if (painting) return brush.erase ? "eraser" : "paint";
  if (drawTool) return drawTool;
  if (handTool) return "hand";
  if (sampling) return "eyedropper";
  return null;
}

const TOOL_NAMES = { crop: "Crop", lasso: "Scissors", paint: "Brush", eraser: "Eraser", gradient: "Gradient", shape: "Shapes", hand: "Hand", eyedropper: "Eyedropper" };

function updateToolUI() {
  const t = currentTool();
  for (const b of document.querySelectorAll(".tool-rail [data-tool]")) {
    b.setAttribute("aria-pressed", String(b.dataset.tool === t));
  }
  $("view-tool").textContent = t ? `Tool: ${TOOL_NAMES[t]}` : "";
  stage.classList.toggle("can-pan", panning());
}

function activateTool(tool) {
  if (!activeId) return say("Import an image first.");
  comparing = false;
  $("view-original").setAttribute("aria-pressed", "false");
  const same = currentTool() === tool;
  leaveTools();
  scheduleRender();
  // Choosing the active tool again puts it down, like the panel buttons do.
  if (same) return;
  if (tool === "crop") enterCrop();
  if (tool === "lasso") enterLasso();
  if (tool === "paint" || tool === "eraser") {
    enterPaint();
    if ((tool === "eraser") !== brush.erase) $("btn-eraser").click();
  }
  if (tool === "gradient" || tool === "shape") enterDrawTool(tool);
  if (tool === "hand") handTool = true;
  if (tool === "eyedropper") {
    sampling = true;
    $("canvas").style.cursor = "crosshair";
    say("Click the image to sample a brush color.");
  }
  updateToolUI();
}
document.querySelectorAll(".tool-rail [data-tool]").forEach((button) => (button.onclick = () => activateTool(button.dataset.tool)));

$("view-original").onclick = () => {
  if (!activeId) return;
  leaveTools();
  comparing = !comparing;
  $("view-original").setAttribute("aria-pressed", String(comparing));
  draw();
  // Keep the saved/exported operation list intact while showing the original.
  ed.set_ops(activeId, JSON.stringify(buildOps(adjust.get(activeId))));
};
$("canvas").addEventListener("click", e => {
  if (!sampling) return;
  const c = $("canvas"), r = c.getBoundingClientRect();
  const pixel = c.getContext("2d").getImageData(clamp(Math.floor((e.clientX-r.left)/r.width*c.width),0,c.width-1), clamp(Math.floor((e.clientY-r.top)/r.height*c.height),0,c.height-1),1,1).data;
  $("hex").value = rgbToHex([...pixel].slice(0,3));
  $("hex").dispatchEvent(new Event("change"));
  sampling = false;
  activateTool("paint");
});

// RGB channels plus luminance. Kept for the curves editor, which draws the
// channel being edited behind the curve.
let lastHist = null;
function updateHistogram(canvas) {
  const sample = document.createElement("canvas"); sample.width = 128; sample.height = 128;
  const ctx = sample.getContext("2d", { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0, 128, 128);
  const pixels = ctx.getImageData(0, 0, 128, 128).data;
  const N = 128, bins = { r: new Array(N).fill(0), g: new Array(N).fill(0), b: new Array(N).fill(0), l: new Array(N).fill(0) };
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    bins.r[r >> 1]++; bins.g[g >> 1]++; bins.b[b >> 1]++;
    bins.l[Math.min(N - 1, Math.floor((r * .2126 + g * .7152 + b * .0722) / 2))]++;
  }
  lastHist = bins;
  const h = $("histogram"), hc = h.getContext("2d");
  // Shared scale, ignoring the extreme end bins so a clipped sky does not
  // flatten everything else.
  const max = Math.max(1, ...["r", "g", "b"].flatMap((k) => bins[k].slice(1, -1)));
  const bw = h.width / N;
  hc.clearRect(0, 0, h.width, h.height);
  hc.globalCompositeOperation = "lighter";
  for (const [k, col] of [["r", "rgba(230,70,70,0.75)"], ["g", "rgba(70,200,110,0.75)"], ["b", "rgba(80,130,240,0.75)"]]) {
    hc.fillStyle = col;
    bins[k].forEach((v, i) => { const y = Math.min(1, v / max) * h.height; hc.fillRect(i * bw, h.height - y, bw + 0.5, y); });
  }
  hc.globalCompositeOperation = "source-over";
  hc.strokeStyle = "rgba(235,238,245,0.8)";
  hc.lineWidth = 1.5;
  hc.beginPath();
  bins.l.forEach((v, i) => { const y = h.height - Math.min(1, v / max) * h.height; i ? hc.lineTo(i * bw + bw / 2, y) : hc.moveTo(bw / 2, y); });
  hc.stroke();
  if (!curveDrag) drawCurves();
}
document.addEventListener("workspacechange", leaveTools);

(async () => {
  try {
    const mod = await import("./pkg/darkroom.js");
    wasm = await mod.default();
    ed = new mod.Editor();
    curveLut = mod.curve_lut;
    LIMITS = JSON.parse(ed.limits());
    $("limits-note").textContent =
      `Images up to ${formatBytes(LIMITS.maxImageBytes)} and ${LIMITS.maxPixels / 1e6} megapixels, ` +
      `${LIMITS.maxDocuments} open at once. Projects up to ${formatBytes(LIMITS.maxBundleBytes)}.`;
    refreshLayers();
  } catch (e) {
    console.error(e);
    fail("Image engine unavailable. Build the WebAssembly package first (see README). Video studio is still available.");
  }
})();
