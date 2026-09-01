import init, { Editor } from "./pkg/darkroom.js";

// This app deliberately touches no persistence API. There is no localStorage,
// sessionStorage, indexedDB, caches, or OPFS call anywhere below except inside
// readLedger(), which only reads counts in order to display them.

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const PREVIEW_CAP = 1600;   // long edge, px
const THUMB = 240;
const HISTORY_CAP = 60;     // steps per image
const MIN_CROP_PX = 18;     // on screen, not in the source

let wasm, ed;
let layers = [];            // [{id, name, width, height, opCount}]
let activeId = null;
let adjust = new Map();     // id -> adjustment struct
let history = new Map();    // id -> {undo: [], redo: []}
let thumbUrls = new Map();  // id -> object URL (revoked on replace/remove)
let cropping = false;
let pendingCrop = null;     // normalized, live while crop mode is open
let gesture = null;         // active crop drag
let sliderGesture = false;
let exportFmt = "png";
let frameQueued = false;

const blank = () => ({
  crop: null, turns: 0, flipH: false, flipV: false,
  brightness: 0, contrast: 0, saturation: 0,
  grayscale: false, invert: false, blur: 0,
  strokes: [], lasso: null,
});

// --- ops translation -------------------------------------------------------
// Canonical order is geometry, then tone, then treatment. Rust applies the
// array in sequence, so this function is the single place that order lives.

function buildOps(a, { skipGeometry = false } = {}) {
  const ops = [];
  if (!skipGeometry) {
    if (a.crop) ops.push({ op: "crop", ...a.crop });
    if (a.lasso) ops.push({ op: "lasso", points: a.lasso });
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
  // Paint goes last so a stroke sits on top of the tone adjustments instead of
  // being desaturated along with the photograph.
  if (a.strokes.length) ops.push({ op: "paint", strokes: a.strokes });
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
      case "paint": a.strokes = o.strokes || []; break;
      case "lasso": a.lasso = o.points || null; break;
    }
  }
  return a;
}

// --- history ---------------------------------------------------------------
// The adjustment struct is small and flat, so whole-state snapshots are simpler
// and less error-prone than a command log, and cheap enough not to matter.

// Strokes need a real copy, not a shared reference, or undo would rewrite the
// history entries it is meant to restore.
const snap = (a) => ({
  ...a,
  crop: a.crop ? { ...a.crop } : null,
  strokes: a.strokes.map((s) => ({ ...s, points: s.points.slice() })),
  lasso: a.lasso ? a.lasso.slice() : null,
});

function hist(id) {
  if (!history.has(id)) history.set(id, { undo: [], redo: [] });
  return history.get(id);
}

/** Call before mutating, never after. */
function pushHistory(id = activeId) {
  if (!id || !adjust.has(id)) return;
  const h = hist(id);
  h.undo.push(snap(adjust.get(id)));
  if (h.undo.length > HISTORY_CAP) h.undo.shift();
  h.redo.length = 0;
  updateHistoryButtons();
}

function step(from, to) {
  if (!activeId) return;
  const h = hist(activeId);
  if (!h[from].length) return;
  h[to].push(snap(adjust.get(activeId)));
  adjust.set(activeId, h[from].pop());
  if (cropping) pendingCrop = adjust.get(activeId).crop;
  syncControls();
  scheduleRender();
  updateHistoryButtons();
  requestAnimationFrame(() => { refreshLayers(); if (cropping) paintCrop(); });
}

const undo = () => step("undo", "redo");
const redo = () => step("redo", "undo");

function updateHistoryButtons() {
  const h = activeId ? hist(activeId) : { undo: [], redo: [] };
  $("btn-undo").disabled = !h.undo.length;
  $("btn-redo").disabled = !h.redo.length;
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

  if (cropping) requestAnimationFrame(paintCrop);
  if (painting) requestAnimationFrame(syncInk);
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
  if (painting) exitPaint();
  if (lassoing) exitLasso();
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
  ed.remove_image(id);
  adjust.delete(id);
  history.delete(id);
  if (activeId === id) {
    if (cropping) exitCrop();
    if (painting) exitPaint();
    if (lassoing) exitLasso();
    const rest = layers.filter((l) => l.id !== id);
    activeId = rest.length ? rest[0].id : null;
  }
  refreshLayers();
  syncControls();
  updateHistoryButtons();
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
  $("btn-clear-ink").hidden = !a.strokes.length;
  $("btn-unlasso").hidden = !a.lasso;
}

function edit(fn) {
  if (!activeId) return;
  pushHistory();
  fn(adjust.get(activeId));
  scheduleRender();
  // Strip thumbnails carry the edit count, so refresh after the frame lands.
  requestAnimationFrame(refreshLayers);
}

for (const k of ["brightness", "contrast", "saturation", "blur"]) {
  $("s-" + k).addEventListener("input", (e) => {
    if (!activeId) return;
    // One history entry per drag, not one per pixel of travel.
    if (!sliderGesture) { sliderGesture = true; pushHistory(); }
    const v = Number(e.target.value);
    $("o-" + k).textContent = v;
    adjust.get(activeId)[k] = v;
    scheduleRender();
  });
  $("s-" + k).addEventListener("change", () => { sliderGesture = false; refreshLayers(); });
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
  pushHistory();
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

$("btn-crop").addEventListener("click", () => (cropping ? exitCrop() : enterCrop()));
$("btn-crop-cancel").addEventListener("click", exitCrop);

$("btn-crop-apply").addEventListener("click", () => {
  if (pendingCrop && pendingCrop.w > 0.005 && pendingCrop.h > 0.005) {
    pushHistory();
    adjust.get(activeId).crop = pendingCrop;
  }
  exitCrop();
  syncControls();
  requestAnimationFrame(refreshLayers);
});

function enterCrop() {
  if (!activeId) return;
  if (painting) exitPaint();
  if (lassoing) exitLasso();
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
  if (cropping) exitCrop();
  if (painting) exitPaint();
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
  pushHistory();
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

$("btn-lasso").addEventListener("click", () => (lassoing ? exitLasso() : enterLasso()));
$("btn-lasso-cancel").addEventListener("click", exitLasso);
$("btn-lasso-apply").addEventListener("click", applyLasso);
$("btn-lasso-undo").addEventListener("click", () => {
  lassoPts.splice(-2, 2);
  drawLasso();
});
$("btn-unlasso").addEventListener("click", () => {
  edit((a) => (a.lasso = null));
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

/** Brush width is a fraction of the source short edge, but the live overlay
 *  draws in screen pixels, so convert through the preview scale. */
function brushScreenPx() {
  const l = layers.find((x) => x.id === activeId);
  const canvas = $("canvas");
  if (!l || !canvas.width) return brush.size;
  const previewScale = Math.min(1, previewCap() / Math.max(l.width, l.height));
  const sourceShortInPreview = Math.min(l.width, l.height) * previewScale;
  const screenPerPreview = canvas.getBoundingClientRect().width / canvas.width;
  return widthFraction() * sourceShortInPreview * screenPerPreview;
}

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
  if (cropping) exitCrop();
  if (lassoing) exitLasso();
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
}

$("btn-paint").addEventListener("click", () => (painting ? exitPaint() : enterPaint()));
$("btn-paint-done").addEventListener("click", exitPaint);
$("btn-clear-ink").addEventListener("click", () => {
  edit((a) => (a.strokes = []));
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
    // Both tools share this overlay, so each has to check it owns the pointer.
    // Without this the brush also fires during a scissors click and commits a
    // one-point stroke, which renders as a stray dot.
    if (!painting || !activeId || e.button !== 0) return;
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
      pushHistory();
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

// --- export ----------------------------------------------------------------

$("btn-export").addEventListener("click", () => {
  if (!activeId) return;
  const l = layers.find((x) => x.id === activeId);
  exportFmt = /\.jpe?g$/i.test(l?.name || "") ? "jpeg" : "png";
  syncExport();
  $("export-dialog").showModal();
});

document.querySelectorAll("#fmt-seg .btn").forEach((b) => {
  b.addEventListener("click", () => { exportFmt = b.dataset.fmt; syncExport(); });
});

$("s-quality").addEventListener("input", (e) => ($("o-quality").textContent = e.target.value));
$("btn-export-cancel").addEventListener("click", () => $("export-dialog").close());

function syncExport() {
  for (const b of document.querySelectorAll("#fmt-seg .btn")) {
    b.setAttribute("aria-pressed", String(b.dataset.fmt === exportFmt));
  }
  $("quality-field").hidden = exportFmt !== "jpeg";
  $("fmt-hint").textContent = exportFmt === "png"
    ? "Lossless, and keeps transparency. Larger files."
    : "Much smaller files. Transparent areas are filled with white.";

  const l = layers.find((x) => x.id === activeId);
  const a = adjust.get(activeId);
  if (!l || !a) return;
  try {
    const [w, h] = ed.output_dims(activeId).split("x");
    $("x-size").textContent = `${w} × ${h} px`;
  } catch { $("x-size").textContent = "–"; }
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
    bytes = ed.export(activeId, exportFmt, q);
    name = ed.export_name(activeId, exportFmt);
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    return fail(e);
  }

  btn.disabled = false;
  btn.textContent = label;
  $("export-dialog").close();

  const type = exportFmt === "png" ? "image/png" : "image/jpeg";
  const ok = await putFile(new Blob([bytes], { type }), name, {
    description: exportFmt === "png" ? "PNG image" : "JPEG image",
    accept: { [type]: [exportFmt === "png" ? ".png" : ".jpg"] },
  });
  if (ok) say(`Exported ${name} — ${(bytes.length / 1024).toFixed(0)} KB.`);
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
  updateHistoryButtons();
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

// --- keyboard --------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cropping) { exitCrop(); return; }
  if (e.key === "Escape" && painting) { exitPaint(); return; }
  if (lassoing) {
    if (e.key === "Escape") { exitLasso(); return; }
    if (e.key === "Enter") { applyLasso(); return; }
  }
  if ($("export-dialog").open) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (k === "y") { e.preventDefault(); redo(); }
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

window.addEventListener("resize", () => {
  if (activeId) scheduleRender();
  if (cropping) paintCrop();
  if (painting) syncInk();
  if (lassoing) { syncInk(); drawLasso(); }
});

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