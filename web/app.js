

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
  gradients: [], shapes: [], strokes: [], lasso: null, artLayers: [], baseOpacity: 1,
  guides: { x: [], y: [] }, selection: null,
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

// Overlay layers are part of the operation stream, so history, thumbnails,
// full-resolution exports and .darkroom bundles all use the same compositor.
// Layers and groups form a tree: a group's `children` are a stack of their own,
// bottom first, exactly as the engine composites them.
let selectedArt = null, selectedSet = new Set(), textTool = false;
const MAX_LAYERS = 128;
const ICONS = { text: "T", photo: "▧", adjustment: "◐", fill: "■", source: "▣", retouch: "✚", paint: "✎", shapes: "◇", gradient: "◫", group: "▤" };
const makeArt = (name, content) => {
  const blend = content.op === "gradient" ? content.blend : "normal";
  if (content.op === "gradient") content = { ...content, blend: "normal" };
  return { op: "layer", id: crypto.randomUUID(), name, visible: true, opacity: 1, blend, content };
};
function* walkArt(list, parent = null, depth = 0) {
  for (const layer of list) {
    yield { layer, list, parent, depth };
    if (layer.op === "group") yield* walkArt(layer.children, layer, depth + 1);
  }
}
const allArt = (a) => [...walkArt(a.artLayers)].map((e) => e.layer);
function findArt(a, id) { for (const e of walkArt(a.artLayers)) if (e.layer.id === id) return e; return null; }
const isGroup = (l) => l?.op === "group";
const kindOf = (l) => (isGroup(l) ? "group" : l.content.op);
const kindIs = (l, kind) => !!l && kindOf(l) === kind;
/** Layers with pixels of their own, which transform, align and snap. */
const movable = (l) => !!l && !isGroup(l) && !["adjustment", "retouch"].includes(l.content.op);
/** The space a layer's mask is painted in: its own when it can be transformed. */
const maskSpace = (l) => (movable(l) ? l.transform : null);
function roomFor(a, n = 1) {
  if (allArt(a).length + n <= MAX_LAYERS) return true;
  say(`An image can hold up to ${MAX_LAYERS} layers and groups.`, true);
  return false;
}
function selectArt(id, { add = false } = {}) {
  if (!add) { selectedArt = id; selectedSet = new Set(id ? [id] : []); return; }
  if (selectedSet.has(id) && selectedSet.size > 1) {
    selectedSet.delete(id);
    if (selectedArt === id) selectedArt = [...selectedSet].pop();
  } else { selectedSet.add(id); selectedArt = id; }
}
/** Selected ids, leaving out anything inside a selected group. */
function topLevelSelection(a) {
  return [...selectedSet].filter((id) => {
    let e = findArt(a, id);
    if (!e) return false;
    while (e.parent) { if (selectedSet.has(e.parent.id)) return false; e = findArt(a, e.parent.id); }
    return true;
  });
}
/** New layers go just above the selected one, inside the same group. */
function insertArt(a, layer) {
  const at = selectedArt && findArt(a, selectedArt);
  if (at) {
    const i = at.list.indexOf(at.layer);
    // Inside a clipping run, a new layer joins the run.
    if (at.list[i + 1]?.clip) layer.clip = true;
    at.list.splice(i + 1, 0, layer);
  } else a.artLayers.push(layer);
  selectArt(layer.id);
  return layer;
}
function addArt(a, name, content) { return insertArt(a, makeArt(name, content)); }
const pruneArt = (list, drop) => list.filter((l) => !drop(l)).map((l) => (isGroup(l) ? { ...l, children: pruneArt(l.children, drop) } : l));
const selectedArtLayer = () => { const a = adjust.get(activeId); return a && selectedArt ? findArt(a, selectedArt)?.layer : undefined; };
const artCount = (a, kind) => allArt(a).reduce((n, l) => n + (!isGroup(l) && l.content.op === kind ? (kind === "paint" ? l.content.strokes.length : kind === "shapes" ? l.content.items.length : 1) : 0), 0);
const textChars = (a, except) => allArt(a).reduce((n, l) => n + (l.id !== except && !isGroup(l) && l.content.op === "text" ? [...l.content.text].length : 0), 0);
/** Applies a change only when the engine accepts the result, so limits such as
 *  group depth are enforced by the validator that also guards save and open. */
function structural(label, change) {
  const a = adjust.get(activeId); if (!a) return;
  // The trial run may select what it creates; the real run must start from
  // the same selection.
  const keep = [selectedArt, [...selectedSet]], restore = () => { selectedArt = keep[0]; selectedSet = new Set(keep[1]); };
  const candidate = structuredClone(a);
  const outcome = change(candidate);
  restore();
  if (outcome === false) return;
  try { ed.set_ops(activeId, JSON.stringify(buildOps(candidate))); } catch (e) { return fail(e); }
  edit(label, (s) => change(s));
  syncControls();
}
/** Photoshop-style stepping: a layer enters an open group it meets, and leaves
 *  its group at either end. */
function moveArt(s, id, dir) {
  const at = findArt(s, id); if (!at) return false;
  const { list, parent, layer } = at;
  const i = list.indexOf(layer), j = i + dir;
  if (j < 0 || j >= list.length) {
    if (!parent) return false;
    const outer = findArt(s, parent.id);
    list.splice(i, 1);
    const k = outer.list.indexOf(parent);
    outer.list.splice(dir > 0 ? k + 1 : k, 0, layer);
    return true;
  }
  const neighbour = list[j];
  if (isGroup(neighbour) && !neighbour.collapsed) {
    list.splice(i, 1);
    if (dir > 0) neighbour.children.unshift(layer); else neighbour.children.push(layer);
    return true;
  }
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}
function canMoveArt(a, l, dir) {
  const at = findArt(a, l.id); if (!at) return false;
  const j = at.list.indexOf(l) + dir;
  return (j >= 0 && j < at.list.length) || !!at.parent;
}
function groupSelected(s, gid) {
  const ids = topLevelSelection(s); if (!ids.length) return false;
  const order = [...walkArt(s.artLayers)].map((e) => e.layer.id);
  ids.sort((p, q) => order.indexOf(p) - order.indexOf(q));
  const anchor = findArt(s, ids.includes(selectedArt) ? selectedArt : ids[ids.length - 1]);
  const home = anchor.list;
  let index = home.indexOf(anchor.layer);
  index -= home.slice(0, index).filter((l) => ids.includes(l.id)).length;
  const members = ids.map((id) => findArt(s, id).layer);
  for (const m of members) { const e = findArt(s, m.id); e.list.splice(e.list.indexOf(m), 1); }
  home.splice(index, 0, { op: "group", id: gid, name: "Group", visible: true, opacity: 1, blend: "normal", pass_through: true, children: members, mask: null, clip: false, collapsed: false });
  selectArt(gid);
}
function ungroup(s, id) {
  const e = findArt(s, id); if (!isGroup(e?.layer)) return false;
  e.list.splice(e.list.indexOf(e.layer), 1, ...e.layer.children);
  selectArt(e.layer.children.at(-1)?.id ?? null);
  for (const c of e.layer.children) selectedSet.add(c.id);
}
/** A deep copy with fresh ids for the layer and everything inside it. */
function freshCopy(l) {
  const copy = structuredClone(l);
  (function reid(x) { x.id = crypto.randomUUID(); if (isGroup(x)) x.children.forEach(reid); })(copy);
  copy.name = (l.name + " copy").slice(0, 64);
  return copy;
}

function renderArtPanel() {
  const a = adjust.get(activeId); if (!a) return;
  for (const id of [...selectedSet]) if (!findArt(a, id)) selectedSet.delete(id);
  if (selectedArt && !findArt(a, selectedArt)) selectedArt = null;
  if (selectedArt) selectedSet.add(selectedArt); else selectedSet.clear();
  const list = $("art-layers"); list.replaceChildren();
  const rows = (items, depth) => {
    for (const layer of [...items].reverse()) {
      const row = document.createElement("div"); row.className = "art-row";
      row.style.paddingLeft = `${depth * 14}px`;
      const visible = document.createElement("input"); visible.type = "checkbox"; visible.checked = layer.visible;
      visible.setAttribute("aria-label", `Show ${layer.name}`);
      visible.onchange = () => { edit("Layer visibility", () => layer.visible = visible.checked); syncControls(); };
      row.append(visible);
      if (isGroup(layer)) {
        const twisty = document.createElement("button"); twisty.className = "btn sm twisty";
        twisty.textContent = layer.collapsed ? "▸" : "▾";
        twisty.setAttribute("aria-label", `${layer.collapsed ? "Expand" : "Collapse"} ${layer.name}`);
        twisty.setAttribute("aria-expanded", String(!layer.collapsed));
        // Folding is view state: it saves with the project but is not an edit.
        twisty.onclick = () => { layer.collapsed = !layer.collapsed; renderArtPanel(); };
        row.append(twisty);
      }
      const select = document.createElement("button"); select.className = "btn sm";
      select.textContent = `${layer.clip ? "↳ " : ""}${ICONS[kindOf(layer)] || "◇"}  ${layer.name}${layer.mask ? " ◑" : ""}`;
      if (layer.clip) { select.classList.add("clipped"); select.title = "Clipped to the layer below"; }
      select.setAttribute("aria-pressed", String(selectedArt === layer.id));
      if (selectedSet.has(layer.id) && selectedArt !== layer.id) select.classList.add("multi");
      select.onclick = (e) => {
        const add = e.shiftKey || e.ctrlKey || e.metaKey;
        leaveTools(); selectArt(layer.id, { add }); renderArtPanel();
        if (add) return;
        if (kindOf(layer) === "text") activateTool("text");
        else if (movable(layer) || isGroup(layer)) activateTool("transform");
      };
      row.append(select); list.append(row);
      if (isGroup(layer) && !layer.collapsed) rows(layer.children, depth + 1);
    }
  };
  rows(a.artLayers, 0);
  const base = document.createElement("button"); base.className = "btn sm wide";
  base.textContent = "▧  Original photo"; base.setAttribute("aria-pressed", String(!selectedArtLayer()));
  base.onclick = () => { leaveTools(); selectArt(null); renderArtPanel(); }; list.append(base);
  const multi = topLevelSelection(a).length;
  $("layer-multi").hidden = multi < 2;
  $("layer-multi").textContent = `${multi} layers selected — group, align, distribute or delete them together. Properties below are for the highlighted one.`;

  const layer = selectedArtLayer(), kind = layer && kindOf(layer), text = kind === "text" ? layer.content : null;
  $("layer-name").disabled = !layer; $("layer-name").value = layer?.name || "Original photo";
  $("layer-opacity").value = Math.round((layer?.opacity ?? a.baseOpacity)*100);
  $("layer-opacity-value").textContent = `${$("layer-opacity").value}%`;
  const blend = $("layer-blend"), through = blend.querySelector('option[value="pass_through"]');
  if (isGroup(layer) && !through) blend.prepend(new Option("Pass through", "pass_through"));
  if (!isGroup(layer) && through) through.remove();
  blend.disabled = !layer || kind === "adjustment" || kind === "retouch";
  blend.value = isGroup(layer) && layer.pass_through ? "pass_through" : layer?.blend || "normal";
  for (const id of ["layer-up", "layer-down", "layer-duplicate", "layer-delete", "layer-group", "layer-clip"]) $(id).disabled = !layer;
  if (layer) { $("layer-up").disabled = !canMoveArt(a, layer, 1); $("layer-down").disabled = !canMoveArt(a, layer, -1); }
  $("layer-ungroup").disabled = !isGroup(layer);
  $("layer-clip").setAttribute("aria-pressed", String(!!layer?.clip));
  if (layer) $("layer-clip").disabled = !layer.clip && findArt(a, layer.id).list.indexOf(layer) === 0;
  renderLayerExtras(layer);
  $("text-properties").hidden = !text;
  if (text) {
    renderFontOptions(text.font || "lato");
    $("text-content").value = text.text; $("text-bold").checked = text.bold; $("text-italic").checked = !!text.italic;
    $("text-color").value = rgbToHex(text.color.slice(0,3)); $("text-align").value = text.align;
    $("text-size").value = +(text.size*100).toFixed(2); $("text-leading").value = text.leading;
    $("text-x").value = +(text.x*100).toFixed(2); $("text-y").value = +(text.y*100).toFixed(2);
    $("text-tracking").value = Math.round((text.tracking || 0) * 1000);
    $("text-box").checked = text.box_width > 0; $("text-box-field").hidden = !(text.box_width > 0);
    $("text-box-width").value = +((text.box_width || 0) * 100).toFixed(2);
  }
}
function addTextLayer(at = null) {
  if (!activeId) return say("Import an image first.");
  const a = adjust.get(activeId); if (!roomFor(a)) return;
  if(textChars(a) > 3991) return say("An image can hold up to 4000 text characters.",true);
  const content = { op: "text", text: "Your text", x: .5, y: .4, size: .08, color: [255,255,255,255], bold: false, align: "center", leading: 1.2, font: "lato", italic: false, tracking: 0, box_width: 0, ...at };
  edit("Add text layer", s => addArt(s, "Text", content));
  leaveTools(); activateTool("text"); syncControls();
  $("text-content").focus(); $("text-content").select();
}
$("layer-add-text").onclick = () => addTextLayer();
$("layer-add-paint").onclick = () => {
  if (!activeId || !roomFor(adjust.get(activeId))) return;
  edit("Add drawing layer", a => addArt(a, "Drawing", { op: "paint", strokes: [] }));
  leaveTools(); activateTool("paint"); syncControls();
};
$("layer-name").onchange = e => { const l = selectedArtLayer(); if (l) { edit("Rename layer", () => l.name = e.target.value.trim().slice(0,64) || "Layer"); syncControls(); } };
$("layer-blend").onchange = e => {
  const l = selectedArtLayer(); if (!l) return;
  edit("Layer blend mode", () => {
    if (isGroup(l)) { l.pass_through = e.target.value === "pass_through"; if (!l.pass_through) l.blend = e.target.value; }
    else l.blend = e.target.value;
  });
  syncControls();
};
let propertyGesture = null;
function propertyInput(id, apply) {
  $(id).addEventListener("input", () => {
    if (!activeId) return;
    if (propertyGesture !== id) { pushHistory("Layer properties"); propertyGesture = id; }
    comparing = false; $("view-original").setAttribute("aria-pressed", "false");
    apply($(id)); scheduleRender();
  });
  $(id).addEventListener("change", () => { propertyGesture = null; syncControls(); requestAnimationFrame(refreshLayers); });
}
propertyInput("layer-opacity", e => { const l = selectedArtLayer(), value = Number(e.value)/100; if(l) l.opacity=value; else adjust.get(activeId).baseOpacity=value; $("layer-opacity-value").textContent=`${e.value}%`; });
const updateText = fn => { const l=selectedArtLayer(); if(l && kindOf(l) === "text") fn(l.content); };
propertyInput("text-content", e => updateText(t => {
  const others=textChars(adjust.get(activeId), selectedArt);
  t.text=[...e.value.split("\n").slice(0,50).join("\n")].slice(0,Math.min(1000,4000-others)).join("");
}));
propertyInput("text-color", e => updateText(t => t.color=[...hexToRgb(e.value),255]));
propertyInput("text-bold", e => { updateText(t => t.bold=e.checked); loadFontsThenRender(); });
propertyInput("text-italic", e => { updateText(t => t.italic=e.checked); loadFontsThenRender(); });
propertyInput("text-align", e => updateText(t => {
  // A paragraph box anchors at its left edge; point text at its alignment.
  if (!(t.box_width > 0)) t.x = clamp(t.x + anchorShift(t.align, e.value === "justify" ? "left" : e.value, textWidth()), 0, 1);
  t.align=e.value;
}));
propertyInput("text-tracking", e => updateText(t => t.tracking = clamp(Number(e.value) || 0, -500, 2000) / 1000));
propertyInput("text-box", e => updateText(t => {
  const width = textWidth();
  if (e.checked) { const bw = clamp(width || .4, .02, 1); t.x = clamp(t.x + anchorShift(t.align, "left", bw), 0, 1); t.box_width = bw; }
  else { t.x = clamp(t.x - anchorShift(t.align, "left", t.box_width), 0, 1); t.box_width = 0; if (t.align === "justify") t.align = "left"; }
}));
propertyInput("text-box-width", e => updateText(t => { if (t.box_width > 0) t.box_width = clamp(Number(e.value) || 1, 1, 100) / 100; }));
for(const [id,key,lo,hi,factor] of [["text-size","size",.1,25,100],["text-leading","leading",.5,3,1],["text-x","x",0,100,100],["text-y","y",0,100,100]]) {
  propertyInput(id,e=>updateText(t=>t[key]=clamp(Number(e.value)||lo,lo,hi)/factor));
}
/** Horizontal move that keeps text in place when its anchor changes. */
function anchorShift(from, to, width) {
  const offset = { left: 0, justify: 0, center: .5, right: 1 };
  return (offset[from] - offset[to]) * width;
}
/** Width of the selected text's content, in normalized source units. */
function textWidth() { const l = selectedArtLayer(); try { return l ? layerBounds(l)[2] : 0; } catch { return 0; } }
for(const [id,delta] of [["layer-up",1],["layer-down",-1]]) $(id).onclick=()=>{
  const l=selectedArtLayer(); if(l) structural("Reorder layer", s => moveArt(s, l.id, delta));
};
$("layer-duplicate").onclick=()=>{
  const a=adjust.get(activeId), l=selectedArtLayer(); if(!l)return;
  const copy=freshCopy(l); if(!roomFor(a, allArt({artLayers:[copy]}).length))return;
  // Ask the same engine validator used by save/open before committing limits.
  structural("Duplicate layer", s => { const e=findArt(s,l.id); e.list.splice(e.list.indexOf(e.layer)+1,0,structuredClone(copy)); selectArt(copy.id); });
};
$("layer-delete").onclick=()=>{
  const a=adjust.get(activeId); if(!a || !selectedArtLayer())return;
  const ids=topLevelSelection(a); leaveTools();
  edit(ids.length>1?"Delete layers":"Delete layer",s=>{ for(const id of ids){ const e=findArt(s,id); if(e) e.list.splice(e.list.indexOf(e.layer),1); } });
  selectArt(null); syncControls();
};
function groupLayers() {
  const a=adjust.get(activeId); if(!a || !selectedArtLayer())return say("Select the layers to group first.");
  if(!roomFor(a))return;
  const gid=crypto.randomUUID(); structural("Group layers", s => groupSelected(s, gid));
}
function ungroupLayers() { const l=selectedArtLayer(); if(isGroup(l)) structural("Ungroup", s => ungroup(s, l.id)); }
function toggleClip() {
  const l=selectedArtLayer(); if(!l)return;
  const at=findArt(adjust.get(activeId),l.id);
  if(!l.clip && at.list.indexOf(l)===0)return say("A layer clips to the layer directly below it. Move it above another layer first.");
  edit(l.clip?"Release clipping mask":"Create clipping mask",()=>l.clip=!l.clip); syncControls();
}
$("layer-group").onclick=groupLayers;
$("layer-ungroup").onclick=ungroupLayers;
$("layer-clip").onclick=toggleClip;

// --- text tool on the canvas ----------------------------------------------
// Drag the selected text to move it, or its paragraph box's edge handle to
// rewrap. With no text selected, click to place point text or drag out a box.
let typeDrag = null, typeCreate = null;
function canvasPoint(e) { const r=$("canvas").getBoundingClientRect(); return [(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height]; }
$("canvas").addEventListener("pointerdown", e => {
  if(!textTool || panning() || e.button!==0)return;
  const a=adjust.get(activeId), l=selectedArtLayer(), out=canvasPoint(e), [x,y]=screenToSource(...out,a);
  $("canvas").setPointerCapture(e.pointerId); e.preventDefault();
  if(!kindIs(l,"text")) { typeCreate={x,y,cx:e.clientX,cy:e.clientY}; return; }
  if(!l.visible)return say("Show this layer before positioning it.");
  const frame=textFrame(l,a), r=$("canvas").getBoundingClientRect();
  if(frame && Math.hypot((frame.handle[0]-out[0])*r.width,(frame.handle[1]-out[1])*r.height)<12) {
    pushHistory("Resize text box"); typeDrag={box:true}; return;
  }
  pushHistory("Move text"); typeDrag={x,y,startX:l.content.x,startY:l.content.y};
});
$("canvas").addEventListener("pointermove",e=>{
  if(!typeDrag)return;
  const a=adjust.get(activeId), [x,y]=screenToSource(...canvasPoint(e),a), l=selectedArtLayer();
  if(typeDrag.box) { const p=layerLocal(x,y,l?.transform); updateText(t=>t.box_width=clamp(p[0]-t.x,.01,1)); scheduleRender(); return; }
  const p=layerLocal(x,y,l?.transform), q=layerLocal(typeDrag.x,typeDrag.y,l?.transform);
  updateText(t=>{t.x=clamp(typeDrag.startX+p[0]-q[0],0,1);t.y=clamp(typeDrag.startY+p[1]-q[1],0,1);}); scheduleRender();
});
for(const event of ["pointerup","pointercancel"]) $("canvas").addEventListener(event,e=>{
  if(typeCreate) {
    const start=typeCreate; typeCreate=null; if(event==="pointercancel")return;
    const [x,y]=screenToSource(...canvasPoint(e),adjust.get(activeId));
    const at={x:clamp(Math.min(start.x,x),0,1),y:clamp(Math.min(start.y,y),0,1),align:"left",size:.05};
    if(Math.hypot(e.clientX-start.cx,e.clientY-start.cy)>8) at.box_width=clamp(Math.abs(x-start.x),.02,1);
    else { at.x=clamp(start.x,0,1); at.y=clamp(start.y,0,1); }
    addTextLayer(at); return;
  }
  if(typeDrag){typeDrag=null;syncControls();requestAnimationFrame(refreshLayers);}
});

// --- fonts -------------------------------------------------------------------
// Lato is compiled into the engine. The other bundled families are fetched the
// first time a text layer uses them; imported fonts live in the engine and are
// saved inside projects that use them.
const FONT_FAMILIES = {
  lato: { name: "Lato", files: {} },
  rubik: { name: "Rubik", files: { r: "Rubik-Regular.ttf", b: "Rubik-Bold.ttf", i: "Rubik-Italic.ttf", bi: "Rubik-BoldItalic.ttf" } },
  caladea: { name: "Caladea (serif)", files: { r: "Caladea-Regular.ttf", b: "Caladea-Bold.ttf", i: "Caladea-Italic.ttf", bi: "Caladea-BoldItalic.ttf" } },
  "liberation-mono": { name: "Liberation Mono", files: { r: "LiberationMono-Regular.ttf", b: "LiberationMono-Bold.ttf", i: "LiberationMono-Italic.ttf", bi: "LiberationMono-BoldItalic.ttf" } },
};
let wasmMod = null, userFonts = [];
const fontLoads = new Map();
const faceKey = (t) => `${t.font || "lato"}:${t.bold ? (t.italic ? "bi" : "b") : (t.italic ? "i" : "r")}`;
const faceFile = (key) => { const [family, style] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)]; return FONT_FAMILIES[family]?.files[style]; };
function loadFace(key) {
  if (!fontLoads.has(key)) {
    fontLoads.set(key, fetch(`fonts/${faceFile(key)}`)
      .then((r) => { if (!r.ok) throw new Error(`Couldn't load the font file ${faceFile(key)}.`); return r.arrayBuffer(); })
      .then((b) => wasmMod.register_font(key, new Uint8Array(b)))
      .catch((e) => { fail(e); }));
  }
  return fontLoads.get(key);
}
/** Fetches any bundled faces the given documents' text needs. Resolves to
 *  true when something new was loaded, so the caller can re-render. */
async function ensureFonts(states = [...adjust.values()]) {
  if (!wasmMod) return false;
  const keys = new Set();
  for (const a of states) for (const l of allArt(a)) if (kindOf(l) === "text") keys.add(faceKey(l.content));
  const pending = [...keys].filter((k) => faceFile(k) && !wasmMod.font_ready(k));
  if (!pending.length) return false;
  await Promise.all(pending.map(loadFace));
  return true;
}
function loadFontsThenRender() {
  ensureFonts().then((loaded) => { if (loaded) { scheduleRender(); requestAnimationFrame(refreshLayers); } });
}
function renderFontOptions(current) {
  const select = $("text-font"); select.replaceChildren();
  for (const [id, f] of Object.entries(FONT_FAMILIES)) select.append(new Option(f.name, id));
  for (const f of userFonts) select.append(new Option(`${f.name} (imported)`, f.id));
  select.append(new Option("Import font…", "__import__"));
  if (![...select.options].some((o) => o.value === current)) select.append(new Option("Missing font (shows as Lato)", current));
  select.value = current;
}
$("text-font").onchange = (e) => {
  const value = e.target.value;
  if (value === "__import__") { renderFontOptions(selectedArtLayer()?.content.font || "lato"); $("file-font").click(); return; }
  const l = selectedArtLayer(); if (!kindIs(l, "text")) return;
  edit("Font", () => (l.content.font = value)); syncControls(); loadFontsThenRender();
};
$("file-font").onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  if (file.size > 20 * 1024 * 1024) return say("Font files are limited to 20 MB.", true);
  try {
    const id = "user:" + crypto.randomUUID(), name = file.name.replace(/\.(ttf|otf)$/i, "").slice(0, 60) || "Imported font";
    ed.add_font(id, name, new Uint8Array(await file.arrayBuffer()));
    userFonts = JSON.parse(ed.fonts_json());
    const l = selectedArtLayer();
    if (kindIs(l, "text")) edit("Font", () => (l.content.font = id));
    syncControls();
    say(`Imported ${name}. Projects that use it carry a copy of the font file.`);
  } catch (error) { fail(error); }
};

// --- editable photo layers, transforms, masks and layer effects ------------
const identityTransform = () => ({tx:0,ty:0,sx:1,sy:1,rotation:0,anchor_x:.5,anchor_y:.5});
const defaultStyle = () => ({shadow:false,shadow_color:[0,0,0,160],shadow_blur:.015,shadow_x:.02,shadow_y:.02,outline:false,outline_color:[255,255,255,255],outline_width:.005,
  glow:false,glow_color:[255,214,120,190],glow_size:.02,inner_glow:false,inner_glow_color:[255,255,255,170],inner_glow_size:.01,
  bevel:false,bevel_size:.01,bevel_depth:1,bevel_angle:120,bevel_highlight:[255,255,255,190],bevel_shadow:[0,0,0,170]});
/** The layer's style with any fields older projects lack filled in. */
const styleOf = (l) => (l.style = { ...defaultStyle(), ...(l.style || {}) });
const adjustmentKeys = ['exposure','brightness','contrast','saturation','warmth'];
let layerTool = null, layerDrag = null, maskStroke = null, maskCursor = null, guideDrag = null;
const boundsCache = new Map();
function layerBounds(l) {
  const shaped=['fill','source'].includes(l.content.op);
  const key=JSON.stringify([layerDimensions(),l.content,shaped?l.mask:0]), old=boundsCache.get(l.id);
  if(old?.key===key) return old.bounds;
  ed.set_ops(activeId,JSON.stringify(buildOps(adjust.get(activeId))));
  const bounds=JSON.parse(ed.overlay_bounds(activeId,l.id,previewCap()));
  if(boundsCache.size>256)boundsCache.clear();
  boundsCache.set(l.id,{key,bounds});return bounds;
}
function transformFor(l) {
  if(!l.transform || (l.transform.sx===1 && l.transform.sy===1 && l.transform.rotation===0)) {
    const [x,y,w,h]=layerBounds(l);
    l.transform={...(l.transform||identityTransform()),anchor_x:clamp(x+w/2,0,1),anchor_y:clamp(y+h/2,0,1)};
  }
  return l.transform;
}
function layerDimensions() { const d=layers.find(l=>l.id===activeId); return [d?.width||1,d?.height||1]; }
function layerLocal(x,y,t) {
  if(!t)return [x,y];
  const [w,h]=layerDimensions(), r=t.rotation*Math.PI/180, c=Math.cos(r),s=Math.sin(r);
  const px=(x-t.anchor_x-t.tx)*w,py=(y-t.anchor_y-t.ty)*h;
  return [(px*c+py*s)/t.sx/w+t.anchor_x,(-px*s+py*c)/t.sy/h+t.anchor_y];
}
function layerWorld(x,y,t) {
  t=t||identityTransform();const [w,h]=layerDimensions(),r=t.rotation*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
  const px=(x-t.anchor_x)*w*t.sx,py=(y-t.anchor_y)*h*t.sy;
  return [(px*c-py*s)/w+t.anchor_x+t.tx,(px*s+py*c)/h+t.anchor_y+t.ty];
}
/** Output-space bounding box of a layer or group, normalized to the frame. */
function outBox(l, a) {
  if (isGroup(l)) {
    const boxes = l.children.filter((c) => c.visible).map((c) => outBox(c, a)).filter(Boolean);
    return boxes.length ? unionBox(boxes) : null;
  }
  if (!movable(l)) return null;
  const [x, y, w, h] = layerBounds(l);
  const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => sourceToOut(...layerWorld(...p, l.transform), a));
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}
const unionBox = (boxes) => ({ x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) });
/** A displacement on screen as a displacement in source coordinates. */
function outDeltaToSource(dx, dy, a) { const p = screenToSource(.5, .5, a), q = screenToSource(.5 + dx, .5 + dy, a); return [q[0] - p[0], q[1] - p[1]]; }
function translateArt(l, d) {
  if (isGroup(l)) { l.children.forEach((c) => translateArt(c, d)); return; }
  if (!movable(l)) return;
  const t = transformFor(l); t.tx = clamp(t.tx + d[0], -2, 2); t.ty = clamp(t.ty + d[1], -2, 2);
}
function renderLayerExtras(l) {
  $('layer-extra').hidden=!l;if(!l)return;
  const kind=kindOf(l), group=kind==='group';
  $('transform-properties').hidden=!movable(l);$('style-properties').hidden=!movable(l);
  $('adjustment-properties').hidden=kind!=='adjustment';
  $('group-note').hidden=!group;$('retouch-note').hidden=kind!=='retouch';$('fill-properties').hidden=kind!=='fill';
  if(kind==='fill')$('fill-color').value=rgbToHex(l.content.color.slice(0,3));
  const t=l.transform||identityTransform(), style={...defaultStyle(),...(l.style||{})};
  for(const key of ['tx','ty','sx','sy','rotation']) $('transform-'+key).value=+(t[key]*(key==='rotation'?1:100)).toFixed(2);
  if(kind==='adjustment') for(const key of adjustmentKeys) { const v=Math.round((l.content[key]||0)*100);$('adjust-'+key).value=v;$('adjust-'+key+'-value').textContent=v; }
  $('mask-add').hidden=!!l.mask;$('mask-properties').hidden=!l.mask;
  if(l.mask) {$('mask-enabled').checked=l.mask.enabled;$('mask-inverted').checked=l.mask.inverted;}
  for(const k of ['shadow','outline','glow','inner_glow']) {$('style-'+k).checked=style[k];$('style-'+k+'-color').value=rgbToHex(style[k+'_color'].slice(0,3));}
  for(const k of ['shadow','glow','inner_glow']) $('style-'+k+'-opacity').value=Math.round(style[k+'_color'][3]/255*100);
  for(const k of ['shadow_blur','shadow_x','shadow_y','outline_width']) $('style-'+k.replaceAll('_','-')).value=+(style[k]*100).toFixed(2);
  for(const k of ['glow','inner_glow','bevel']) $('style-'+k+'-size').value=+(style[k+'_size']*100).toFixed(2);
  $('style-bevel').checked=style.bevel;$('style-bevel-depth').value=Math.round(style.bevel_depth*100);$('style-bevel-angle').value=Math.round(style.bevel_angle);
  $('style-bevel-highlight').value=rgbToHex(style.bevel_highlight.slice(0,3));$('style-bevel-shadow').value=rgbToHex(style.bevel_shadow.slice(0,3));
}
for(const key of adjustmentKeys) {
  const row=document.createElement('label');row.className='slider';
  const label=document.createElement('span');label.textContent=key[0].toUpperCase()+key.slice(1);
  const output=document.createElement('output');output.id='adjust-'+key+'-value';
  const input=document.createElement('input');Object.assign(input,{id:'adjust-'+key,type:'range',min:-100,max:100,value:0});
  row.append(label,output,input);$('adjustment-sliders').append(row);
  propertyInput(input.id,e=>{const l=selectedArtLayer();if(kindIs(l,'adjustment')){l.content[key]=Number(e.value)/100;output.textContent=e.value;}});
}
propertyInput('fill-color',e=>{const l=selectedArtLayer();if(kindIs(l,'fill'))l.content.color=[...hexToRgb(e.value),255];});
$('layer-add-photo').onclick=()=>$('file-layer-photo').click();
$('file-layer-photo').onchange=async e=>{
  const file=e.target.files[0],id=activeId;e.target.value='';if(!file||!id)return;
  if(!roomFor(adjust.get(id)))return;
  if(file.size>LIMITS.maxImageBytes)return say('This photo exceeds the image size limit.',true);
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());if(activeId!==id)return say('Select the intended document and import the photo again.');
    const asset_id=crypto.randomUUID(),dims=JSON.parse(ed.add_photo_asset(id,asset_id,bytes));
    const [w,h]=layerDimensions(), scale=Math.min(w*.8/dims.width,h*.8/dims.height);
    edit('Add photo layer',a=>addArt(a,file.name.slice(0,64),{op:'photo',asset_id,width:Math.max(.001,dims.width*scale/w),height:Math.max(.001,dims.height*scale/h)}));
    leaveTools();activateTool('transform');syncControls();
  } catch(error){fail(error);}
};
$('layer-add-adjustment').onclick=()=>{
  if(!activeId || !roomFor(adjust.get(activeId)))return;
  leaveTools();edit('Add adjustment layer',a=>addArt(a,'Adjustment',{op:'adjustment',...Object.fromEntries(adjustmentKeys.map(k=>[k,0]))}));syncControls();
};
$('layer-transform').onclick=()=>activateTool('transform');
$('transform-reset').onclick=()=>{const l=selectedArtLayer();if(l){edit('Reset transform',()=>delete l.transform);syncControls();}};
for(const key of ['tx','ty','sx','sy','rotation']) propertyInput('transform-'+key,e=>{
  const l=selectedArtLayer();if(!movable(l))return;const t=transformFor(l),lo=Number(e.min),hi=Number(e.max);
  t[key]=clamp(Number(e.value)||0,lo,hi)/(key==='rotation'?1:100);
});
$('mask-add').onclick=()=>{
  const l=selectedArtLayer();if(!l)return;edit('Add layer mask',()=>l.mask={enabled:true,inverted:false,strokes:[]});syncControls();activateTool('mask');
};
$('mask-remove').onclick=()=>{const l=selectedArtLayer();if(!l)return;leaveTools();edit('Remove layer mask',()=>l.mask=null);syncControls();};
$('mask-paint').onclick=()=>activateTool('mask');
for(const k of ['enabled','inverted']) propertyInput('mask-'+k,e=>{const l=selectedArtLayer();if(l?.mask)l.mask[k]=e.checked;});
for(const k of ['shadow','outline','glow','inner_glow','bevel']) propertyInput('style-'+k,e=>{const l=selectedArtLayer();if(movable(l))styleOf(l)[k]=e.checked;});
for(const k of ['shadow','outline','glow','inner_glow']) propertyInput('style-'+k+'-color',e=>{const l=selectedArtLayer();if(movable(l)){const s=styleOf(l);s[k+'_color']=[...hexToRgb(e.value),s[k+'_color'][3]];}});
for(const k of ['shadow','glow','inner_glow']) propertyInput('style-'+k+'-opacity',e=>{const l=selectedArtLayer();if(movable(l))styleOf(l)[k+'_color'][3]=Math.round(clamp(Number(e.value),0,100)/100*255);});
for(const [k,id] of [['shadow_blur','shadow-blur'],['shadow_x','shadow-x'],['shadow_y','shadow-y'],['outline_width','outline-width'],['glow_size','glow-size'],['inner_glow_size','inner_glow-size'],['bevel_size','bevel-size']])propertyInput('style-'+id,e=>{
  const l=selectedArtLayer();if(movable(l))styleOf(l)[k]=clamp(Number(e.value),Number(e.min),Number(e.max))/100;
});
propertyInput('style-bevel-depth',e=>{const l=selectedArtLayer();if(movable(l))styleOf(l).bevel_depth=clamp(Number(e.value),0,300)/100;});
propertyInput('style-bevel-angle',e=>{const l=selectedArtLayer();if(movable(l))styleOf(l).bevel_angle=clamp(Number(e.value)||0,-360,360);});
for(const k of ['highlight','shadow']) propertyInput('style-bevel-'+k,e=>{const l=selectedArtLayer();if(movable(l)){const s=styleOf(l);s['bevel_'+k]=[...hexToRgb(e.value),s['bevel_'+k][3]];}});
function enterLayerTool(tool) {
  const l=selectedArtLayer();
  if(tool==='mask') {
    if(!l)return say('Select a layer from the Layers panel first.');
    if(!l.mask)return say('Add a mask to this layer first.');
  } else if(l && !movable(l) && !isGroup(l)) return say('Adjustment and retouch layers affect the layers below. Use a mask to target an area.');
  layerTool=tool;$('ink').hidden=false;requestAnimationFrame(drawLayerTool);
}
function handleGeometry(l) {
  const a=adjust.get(activeId), ink=$('ink');
  if(isGroup(l)) {
    const b=outBox(l,a); if(!b)return null;
    const corners=[[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]].map(p=>[p[0]*ink.width,p[1]*ink.height]);
    return {corners,group:true};
  }
  const [x,y,w,h]=layerBounds(l);
  const corners=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(p=>sourceToInk(...layerWorld(...p,l.transform),a));
  const center=corners.reduce((sum,p)=>[sum[0]+p[0]/4,sum[1]+p[1]/4],[0,0]);
  const top=[(corners[0][0]+corners[1][0])/2,(corners[0][1]+corners[1][1])/2];
  const dx=top[0]-center[0],dy=top[1]-center[1],len=Math.hypot(dx,dy)||1;
  return {corners,center,top,rotate:[top[0]+dx/len*28,top[1]+dy/len*28]};
}
function drawLayerTool() {
  if(!layerTool)return;const l=selectedArtLayer();if(!l && layerTool==='mask'){leaveTools();return;}
  syncInk();const ink=$('ink'),ctx=ink.getContext('2d');ink.style.cursor=layerTool==='mask'?'crosshair':'move';
  if(layerTool==='transform' && l) {
    const g=handleGeometry(l); if(!g)return;
    ctx.strokeStyle='#77ceff';ctx.lineWidth=1.5;ctx.fillStyle='#15232d';
    if(g.group)ctx.setLineDash([6,4]);
    ctx.beginPath();g.corners.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.stroke();ctx.setLineDash([]);
    if(g.group)return;
    ctx.beginPath();ctx.moveTo(...g.top);ctx.lineTo(...g.rotate);ctx.stroke();
    for(const p of g.corners){ctx.fillRect(p[0]-5,p[1]-5,10,10);ctx.strokeRect(p[0]-5,p[1]-5,10,10);}
    ctx.beginPath();ctx.arc(...g.rotate,6,0,Math.PI*2);ctx.fill();ctx.stroke();
  } else if(maskStroke) {
    ctx.strokeStyle='rgba(119,206,255,.7)';ctx.lineWidth=2;ctx.beginPath();
    for(let i=0;i<maskStroke.points.length;i+=2){const p=sourceToInk(...layerWorld(maskStroke.points[i],maskStroke.points[i+1],maskSpace(l)),adjust.get(activeId));i?ctx.lineTo(...p):ctx.moveTo(...p);}
    ctx.stroke();
  }
  if(layerTool==='mask' && maskCursor) {
    const t=maskSpace(l);
    const scale=t?Math.sqrt(t.sx*t.sy):1;
    const radius=clamp(Number($('mask-size').value),.1,100)/100*sourceShortOnScreen()*scale/2;
    ctx.beginPath();ctx.arc(maskCursor[0],maskCursor[1],Math.max(2,radius),0,Math.PI*2);
    ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();ctx.strokeStyle='#111';ctx.lineWidth=.5;ctx.stroke();
  }
}
function layerPointer(e) {const r=$('ink').getBoundingClientRect();return screenToSource((e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height,adjust.get(activeId));}
function inkOut(e) {const r=$('ink').getBoundingClientRect();return [(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height];}
function maskPoint(e) {
  const l=selectedArtLayer();const p=layerLocal(...layerPointer(e),maskSpace(l)).map(v=>clamp(v,0,1));
  const a=maskStroke.points;
  if(a.length>=20000)return;
  if(a.length && Math.hypot(p[0]-a[a.length-2],p[1]-a[a.length-1])<.002)return;
  a.push(...p);
}
/** The guide under the pointer, if any, within a few screen pixels. */
function guideAt(e) {
  const a=adjust.get(activeId); if(!view.guides||!a)return null;
  const r=$('ink').getBoundingClientRect(), [x,y]=inkOut(e);
  for(const axis of ['x','y']) {
    const size=axis==='x'?r.width:r.height, at=axis==='x'?x:y;
    const i=a.guides[axis].findIndex(v=>Math.abs(v-at)*size<5);
    if(i>=0)return {axis,i};
  }
  return null;
}
$('ink').addEventListener('pointerdown',e=>{
  if(!layerTool||panning()||e.button!==0)return;
  const l=selectedArtLayer();
  if(layerTool==='transform') {
    const g=guideAt(e);
    if(g) { pushHistory('Move guide'); guideDrag=g; $('ink').setPointerCapture(e.pointerId); e.preventDefault(); return; }
    if(!l)return;
  }
  if(!l?.visible)return say('Show this layer before editing it.');
  if(layerTool==='mask') {
    if(!l.mask?.enabled)return say('Enable this mask before painting.');
    const hide=$('mask-mode').value==='hide',color=hide?0:255;
    // Inverted masks still honor the requested Hide / Reveal action.
    const value=l.mask.inverted?255-color:color;
    maskStroke={color:[value,value,value,Math.round(clamp(Number($('mask-strength').value),1,100)/100*255)],width:clamp(Number($('mask-size').value),.1,100)/100,erase:false,points:[]};maskPoint(e);
  } else {
    const a=adjust.get(activeId), r=$('ink').getBoundingClientRect(),p=[e.clientX-r.left,e.clientY-r.top],g=handleGeometry(l);
    if(!g)return;
    const corner=g.group?-1:g.corners.findIndex(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<14);
    const mode=!g.group&&Math.hypot(g.rotate[0]-p[0],g.rotate[1]-p[1])<14?'rotate':corner>=0?'scale':'move';
    pushHistory('Transform layer');
    const members=isGroup(l)?allArt({artLayers:l.children}).filter(movable):[l];
    const bases=new Map(members.map(m=>[m.id,structuredClone(transformFor(m))]));
    const skip=new Set(isGroup(l)?[l.id,...allArt({artLayers:l.children}).map(m=>m.id)]:[l.id]);
    const t=isGroup(l)?null:bases.get(l.id);
    layerDrag={mode,t,bases,start:layerPointer(e),startOut:inkOut(e),local:t&&layerLocal(...layerPointer(e),t),
      box:mode==='move'&&view.snap?outBox(l,a):null,targets:mode==='move'&&view.snap?snapTargets(a,skip):null};
  }
  $('ink').setPointerCapture(e.pointerId);e.preventDefault();drawLayerTool();
});
$('ink').addEventListener('pointermove',e=>{
  if(!layerTool)return;
  if(guideDrag) { const a=adjust.get(activeId),o=inkOut(e); a.guides[guideDrag.axis][guideDrag.i]=guideDrag.axis==='x'?o[0]:o[1]; drawHud(); return; }
  if(layerTool==='transform'&&!layerDrag) { $('ink').style.cursor=guideAt(e)?(guideAt(e).axis==='x'?'ew-resize':'ns-resize'):'move'; }
  if(layerTool==='mask'){const r=$('ink').getBoundingClientRect();maskCursor=[e.clientX-r.left,e.clientY-r.top];if(maskStroke)maskPoint(e);drawLayerTool();return;}
  if(!layerDrag)return;
  const l=selectedArtLayer(),d=layerDrag,a=adjust.get(activeId);
  if(d.mode==='move') {
    const o=inkOut(e), delta=[o[0]-d.startOut[0],o[1]-d.startOut[1]];
    snapLines=[];
    if(d.box&&!e.altKey) { const r=$('ink').getBoundingClientRect(); snapLines=snapDelta(d.box,delta,d.targets,6/r.width,6/r.height); }
    const s=outDeltaToSource(...delta,a);
    for(const [id,base] of d.bases) { const m=findArt(a,id)?.layer; if(m){m.transform={...m.transform,tx:clamp(base.tx+s[0],-2,2),ty:clamp(base.ty+s[1],-2,2)};} }
    drawHud();
  } else {
    const p=layerPointer(e),t=l.transform,base=d.t;
    if(d.mode==='rotate') {
      const [w,h]=layerDimensions(),cx=base.anchor_x+base.tx,cy=base.anchor_y+base.ty;
      const delta=(Math.atan2((p[1]-cy)*h,(p[0]-cx)*w)-Math.atan2((d.start[1]-cy)*h,(d.start[0]-cx)*w))*180/Math.PI;
      let angle=((base.rotation+delta+540)%360)-180;if(e.shiftKey)angle=Math.round(angle/15)*15;t.rotation=angle;
    } else {
      const q=layerLocal(...p,base),dx=d.local[0]-base.anchor_x,dy=d.local[1]-base.anchor_y;
      let sx=Math.abs(dx)>.00001?(q[0]-base.anchor_x)/dx:1,sy=Math.abs(dy)>.00001?(q[1]-base.anchor_y)/dy:1;
      if($('transform-lock').checked) {const [w,h]=layerDimensions();const ux=dx*w,uy=dy*h;const f=(ux*(q[0]-base.anchor_x)*w+uy*(q[1]-base.anchor_y)*h)/(ux*ux+uy*uy||1);sx=sy=f;}
      t.sx=clamp(base.sx*sx,.01,10);t.sy=clamp(base.sy*sy,.01,10);
    }
  }
  scheduleRender();
});
$('ink').addEventListener('pointerleave',()=>{maskCursor=null;if(layerTool==='mask')drawLayerTool();});
for(const event of ['pointerup','pointercancel'])$('ink').addEventListener(event,e=>{
  if(guideDrag) {
    const g=guideDrag;guideDrag=null;const a=adjust.get(activeId),v=a.guides[g.axis][g.i];
    // Dragging a guide off the image removes it, as with Photoshop's rulers.
    if(event==='pointercancel'||!(v>=0&&v<=1)) a.guides[g.axis].splice(g.i,1);
    syncControls();scheduleRender();return;
  }
  if(maskStroke) {
    const stroke=maskStroke;maskStroke=null;const l=selectedArtLayer();
    if(event!=='pointercancel'&&l?.mask) {
      const candidate=structuredClone(adjust.get(activeId));findArt(candidate,l.id).layer.mask.strokes.push(stroke);
      try {ed.set_ops(activeId,JSON.stringify(buildOps(candidate)));edit('Paint layer mask',()=>l.mask.strokes.push(stroke));} catch(error){fail(error);}
    }
    scheduleRender();syncControls();requestAnimationFrame(refreshLayers);
  }
  if(layerDrag){
    if(event==='pointercancel'){const a=adjust.get(activeId);for(const [id,base] of layerDrag.bases){const m=findArt(a,id)?.layer;if(m)m.transform=base;}}
    layerDrag=null;snapLines=[];drawHud();scheduleRender();syncControls();requestAnimationFrame(refreshLayers);
  }
});

// --- snapping & alignment ------------------------------------------------------
// Everything here works in normalized output coordinates -- what you see --
// and converts to source space only when it moves a layer.
let snapLines = [];
function gridLines(axis) {
  const canvas=$('canvas'), short=Math.min(canvas.width,canvas.height), size=axis==='x'?canvas.width:canvas.height;
  const step=view.gridSize/100*short/size, out=[];
  if(step>0) for(let v=0;v<=1.0001&&out.length<400;v+=step) out.push(v);
  return out;
}
function snapTargets(a, skip) {
  const xs=[0,.5,1], ys=[0,.5,1];
  if(view.guides) { xs.push(...a.guides.x); ys.push(...a.guides.y); }
  if(view.grid) { xs.push(...gridLines('x')); ys.push(...gridLines('y')); }
  for(const l of allArt(a)) {
    if(skip.has(l.id)||!l.visible||!movable(l))continue;
    const b=outBox(l,a); if(!b)continue;
    xs.push(b.x0,(b.x0+b.x1)/2,b.x1); ys.push(b.y0,(b.y0+b.y1)/2,b.y1);
  }
  return {xs,ys};
}
/** Nudges `delta` so an edge or center of `box` lands on the nearest target
 *  within tolerance on each axis. Returns the lines it snapped to. */
function snapDelta(box, delta, targets, tolX, tolY) {
  const lines=[];
  for(const [axis,i,tol,edges,list] of [['x',0,tolX,[box.x0,(box.x0+box.x1)/2,box.x1],targets.xs],['y',1,tolY,[box.y0,(box.y0+box.y1)/2,box.y1],targets.ys]]) {
    let best=null;
    for(const v of edges) for(const t of list) { const diff=t-(v+delta[i]); if(Math.abs(diff)<=tol&&(!best||Math.abs(diff)<Math.abs(best.diff)))best={diff,t}; }
    if(best){delta[i]+=best.diff;lines.push({axis,pos:best.t});}
  }
  return lines;
}
function alignTargets() {
  const a=adjust.get(activeId); if(!a)return null;
  const items=topLevelSelection(a).map(id=>findArt(a,id).layer).map(l=>({l,box:outBox(l,a)})).filter(i=>i.box);
  if(!items.length){say('Select a layer, text, shape or group to arrange.');return null;}
  return {a,items};
}
function alignSelected(how) {
  const t=alignTargets(); if(!t)return;
  const ref=$('align-to').value==='layers'&&t.items.length>1?unionBox(t.items.map(i=>i.box)):{x0:0,y0:0,x1:1,y1:1};
  edit('Align layers',s=>{ for(const {l,box:b} of t.items) {
    const dx={left:ref.x0-b.x0,hcenter:(ref.x0+ref.x1-b.x0-b.x1)/2,right:ref.x1-b.x1}[how]??0;
    const dy={top:ref.y0-b.y0,vcenter:(ref.y0+ref.y1-b.y0-b.y1)/2,bottom:ref.y1-b.y1}[how]??0;
    translateArt(findArt(s,l.id).layer,outDeltaToSource(dx,dy,s));
  }});
  syncControls();
}
function distributeSelected(axis) {
  const t=alignTargets(); if(!t)return;
  if(t.items.length<3)return say('Select three or more layers to distribute them.');
  const c=(b)=>axis==='x'?(b.x0+b.x1)/2:(b.y0+b.y1)/2;
  const items=[...t.items].sort((p,q)=>c(p.box)-c(q.box)), first=c(items[0].box), last=c(items.at(-1).box);
  edit('Distribute layers',s=>items.forEach(({l,box},i)=>{
    const shift=first+(last-first)*i/(items.length-1)-c(box);
    translateArt(findArt(s,l.id).layer,outDeltaToSource(axis==='x'?shift:0,axis==='y'?shift:0,s));
  }));
  syncControls();
}
document.querySelectorAll('[data-align]').forEach(b=>b.onclick=()=>alignSelected(b.dataset.align));
$('distribute-h').onclick=()=>distributeSelected('x');
$('distribute-v').onclick=()=>distributeSelected('y');

// --- guides & grid -----------------------------------------------------------
const view = { guides: true, snap: true, grid: false, gridSize: 10 };
function addGuide(axis) {
  const a=adjust.get(activeId); if(!a)return say('Import an image first.');
  if(a.guides.x.length+a.guides.y.length>=(LIMITS?.maxGuides??64))return say('An image can hold up to 64 guides.',true);
  edit(axis==='x'?'Add vertical guide':'Add horizontal guide',s=>s.guides[axis].push(.5));
  view.guides=true; syncControls();
}
$('guide-add-v').onclick=()=>addGuide('x');
$('guide-add-h').onclick=()=>addGuide('y');
$('guide-clear').onclick=()=>{ const a=adjust.get(activeId); if(a&&(a.guides.x.length||a.guides.y.length)){edit('Clear guides',s=>s.guides={x:[],y:[]});syncControls();} };
function renderGuides() {
  const a=adjust.get(activeId), list=$('guide-list'); list.replaceChildren(); if(!a)return;
  for(const axis of ['x','y']) a.guides[axis].forEach((v,i)=>{
    const li=document.createElement('li'), label=document.createElement('span'), input=document.createElement('input'), drop=document.createElement('button');
    label.textContent=axis==='x'?'Vertical %':'Horizontal %';
    Object.assign(input,{type:'number',min:0,max:100,step:0.1,value:+(v*100).toFixed(2)});
    input.setAttribute('aria-label',`${label.textContent} guide position`);
    input.onchange=()=>{edit('Move guide',s=>s.guides[axis][i]=clamp(Number(input.value)||0,0,100)/100);syncControls();};
    drop.className='btn sm ghost';drop.textContent='×';drop.setAttribute('aria-label','Remove guide');
    drop.onclick=()=>{edit('Remove guide',s=>s.guides[axis].splice(i,1));syncControls();};
    li.append(label,input,drop);list.append(li);
  });
  $('view-guides').checked=view.guides;$('view-snap').checked=view.snap;$('view-grid').checked=view.grid;
}
$('view-guides').onchange=e=>{view.guides=e.target.checked;drawHud();};
$('view-snap').onchange=e=>{view.snap=e.target.checked;};
$('view-grid').onchange=e=>{view.grid=e.target.checked;drawHud();};
$('grid-size').onchange=e=>{view.gridSize=clamp(Number(e.target.value)||10,1,50);e.target.value=view.gridSize;drawHud();};

// --- HUD: guides, grid, selection outline, snap lines and text boxes ----------
// One overlay canvas that never takes the pointer. It is capped in area and
// stretched to the image, so deep zoom cannot ask for a gigapixel canvas.
const HUD_MAX_AREA = 16e6;
let antsPhase = 0, antsTimer = null, selCache = { key: null };
function syncHud() {
  const hud=$('hud'), canvas=$('canvas');
  if(canvas.hidden||!activeId||$('image-workspace').hidden){hud.hidden=true;return null;}
  hud.hidden=false;
  const r=canvas.getBoundingClientRect(), parent=hud.parentElement.getBoundingClientRect();
  const scale=Math.min(1,Math.sqrt(HUD_MAX_AREA/Math.max(1,r.width*r.height)));
  const w=Math.max(1,Math.round(r.width*scale)), h=Math.max(1,Math.round(r.height*scale));
  if(hud.width!==w||hud.height!==h){hud.width=w;hud.height=h;}
  Object.assign(hud.style,{left:`${r.left-parent.left}px`,top:`${r.top-parent.top}px`,width:`${r.width}px`,height:`${r.height}px`});
  return {w,h,ctx:hud.getContext('2d')};
}
function selectionEdges(a) {
  const canvas=$('canvas');
  // A lasso outline can hold hundreds of thousands of numbers, so it is keyed
  // by a checksum rather than serialized on every frame of the ants.
  const sum=(p)=>p.reduce((t,v,i)=>t+v*((i%7)+1),p.length);
  const sig=a.selection&&{...a.selection,shapes:a.selection.shapes.map(sh=>sh.points?{...sh,points:sum(sh.points)}:sh)};
  const key=JSON.stringify([sig,a.crop,a.lasso?sum(a.lasso):0,a.turns,a.flipH,a.flipV,canvas.width,canvas.height,activeId]);
  if(selCache.key===key)return selCache;
  selCache={key,edges:null};
  if(!a.selection?.shapes.length)return selCache;
  let mask;
  try { ed.set_ops(activeId,JSON.stringify(buildOps(a))); mask=ed.selection_preview(activeId,JSON.stringify(a.selection),previewCap()); } catch(e){ fail(e); return selCache; }
  const w=canvas.width,h=canvas.height; if(mask.length!==w*h)return selCache;
  const edges=[]; let any=false;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=y*w+x; if(mask[i]<128)continue; any=true;
    if(x===0||y===0||x===w-1||y===h-1||mask[i-1]<128||mask[i+1]<128||mask[i-w]<128||mask[i+w]<128) edges.push(i);
  }
  selCache={key,w,h,any,edges:Int32Array.from(edges)};
  return selCache;
}
/** Visible guides as screen lines, plus the text frame and its handle. */
function textFrame(l, a) {
  if(!kindIs(l,'text')||!(l.content.box_width>0))return null;
  const t=l.content, b=layerBounds(l), y1=Math.max(t.y+.02,b[1]+b[3]);
  const local=[[t.x,t.y],[t.x+t.box_width,t.y],[t.x+t.box_width,y1],[t.x,y1]];
  const poly=local.map(p=>sourceToOut(...layerWorld(...p,l.transform),a));
  return {poly,handle:sourceToOut(...layerWorld(t.x+t.box_width,(t.y+y1)/2,l.transform),a)};
}
function drawHud() {
  const s=syncHud(); if(!s)return;
  const {w,h,ctx}=s; ctx.clearRect(0,0,w,h);
  const a=adjust.get(activeId); if(!a||comparing)return;
  const line=(axis,v)=>{ctx.beginPath();if(axis==='x'){const x=Math.round(v*w)+.5;ctx.moveTo(x,0);ctx.lineTo(x,h);}else{const y=Math.round(v*h)+.5;ctx.moveTo(0,y);ctx.lineTo(w,y);}ctx.stroke();};
  if(view.grid){ctx.strokeStyle='rgba(255,255,255,.18)';ctx.lineWidth=1;for(const axis of ['x','y'])gridLines(axis).forEach(v=>line(axis,v));}
  if(view.guides){ctx.strokeStyle='#33d1ff';ctx.lineWidth=1;for(const axis of ['x','y'])a.guides[axis].forEach(v=>line(axis,v));}
  const sel=selectionEdges(a);
  if(sel.edges?.length){
    const sx=w/sel.w, sy=h/sel.h, size=Math.max(1,Math.ceil(Math.max(sx,sy)));
    const dark=new Path2D(), light=new Path2D();
    for(const i of sel.edges){const x=i%sel.w,y=(i/sel.w)|0;(((x+y+antsPhase)>>2)&1?dark:light).rect(Math.floor(x*sx),Math.floor(y*sy),size,size);}
    ctx.fillStyle='#000';ctx.fill(dark);ctx.fillStyle='#fff';ctx.fill(light);
  }
  if(snapLines.length){ctx.strokeStyle='#ff4fd8';ctx.lineWidth=1;for(const l of snapLines)line(l.axis,l.pos);}
  if(textTool){
    const f=textFrame(selectedArtLayer(),a);
    if(f){
      ctx.strokeStyle='#77ceff';ctx.setLineDash([5,4]);ctx.lineWidth=1;ctx.beginPath();
      f.poly.forEach((p,i)=>i?ctx.lineTo(p[0]*w,p[1]*h):ctx.moveTo(p[0]*w,p[1]*h));ctx.closePath();ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='#15232d';ctx.lineWidth=1.5;ctx.fillRect(f.handle[0]*w-5,f.handle[1]*h-5,10,10);ctx.strokeRect(f.handle[0]*w-5,f.handle[1]*h-5,10,10);
    }
  }
}
function updateAnts() {
  const a=adjust.get(activeId), want=!!a?.selection?.shapes.length && !$('image-workspace').hidden;
  if(want&&!antsTimer) antsTimer=setInterval(()=>{antsPhase=(antsPhase+1)%8;drawHud();},160);
  if(!want&&antsTimer){clearInterval(antsTimer);antsTimer=null;}
}

// --- selections ----------------------------------------------------------------
// A selection is a list of shapes in source coordinates plus refinements. It
// lives in the document state, so it is part of undo, but it is not an edit:
// it only does something when turned into a mask, a fill, a copy or a crop.
let selectTool = false, selectKind = "rect", selectDrag = null;
const emptySelection = () => ({ shapes: [], feather: 0, shift: 0, smooth: 0, refine: 0, invert: false });
function enterSelect() {
  if (!activeId) return;
  selectTool = true;
  $("select-bar").hidden = false; $("ink").hidden = false; $("ink").style.cursor = "crosshair";
  syncSelectBar(); requestAnimationFrame(syncInk);
}
function exitSelect() {
  if (!selectTool) return;
  selectTool = false; selectDrag = null;
  $("select-bar").hidden = true;
  const ink = $("ink"); ink.hidden = true; ink.getContext("2d").clearRect(0, 0, ink.width, ink.height);
  updateToolUI();
}
function syncSelectBar() {
  for (const b of document.querySelectorAll("#select-kind .btn")) b.setAttribute("aria-pressed", String(b.dataset.kind === selectKind));
  $("wand-options").hidden = selectKind !== "wand";
}
document.querySelectorAll("#select-kind .btn").forEach((b) => (b.onclick = () => { selectKind = b.dataset.kind; syncSelectBar(); }));
$("btn-select-done").onclick = exitSelect;
function commitSelection(shape, mode) {
  const a = adjust.get(activeId); if (!a) return;
  if (mode !== "new" && (a.selection?.shapes.length ?? 0) >= 64) return say("A selection can combine up to 64 shapes. Refine or deselect first.", true);
  const labels = { new: "Select", add: "Add to selection", subtract: "Subtract from selection", intersect: "Intersect selection" };
  edit(labels[mode], (s) => {
    if (mode === "new" || !s.selection) s.selection = emptySelection();
    s.selection.shapes.push({ ...shape, mode: mode === "new" ? "add" : mode });
  });
  syncControls();
}
const setSelection = (label, fn) => { if (!activeId) return; edit(label, fn); syncControls(); };
const selectAll = () => setSelection("Select all", (s) => (s.selection = { ...emptySelection(), shapes: [{ kind: "all", mode: "add" }] }));
const deselect = () => { if (adjust.get(activeId)?.selection) setSelection("Deselect", (s) => (s.selection = null)); };
const invertSelection = () => setSelection("Invert selection", (s) => {
  if (!s.selection) s.selection = { ...emptySelection(), shapes: [{ kind: "all", mode: "add" }] };
  s.selection.invert = !s.selection.invert;
});
$("select-all").onclick = selectAll;
$("select-none").onclick = deselect;
$("select-inverse").onclick = invertSelection;
$("sel-clear").onclick = deselect;
function inkPx(e) { const ink = $("ink"), r = ink.getBoundingClientRect(); return [(e.clientX - r.left) * ink.width / r.width, (e.clientY - r.top) * ink.height / r.height]; }
(() => {
  const ink = $("ink");
  ink.addEventListener("pointerdown", (e) => {
    if (!selectTool || !activeId || e.button !== 0 || panning()) return;
    const a = adjust.get(activeId);
    // Photoshop's modifiers: Shift adds, Alt subtracts, both intersect.
    const mode = e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : $("select-mode").value;
    const at = screenToSource(...inkOut(e), a).map((v) => clamp(v, 0, 1));
    e.preventDefault();
    if (selectKind === "wand") {
      commitSelection({ kind: "wand", x: at[0], y: at[1], tolerance: Number($("wand-tolerance").value) / 100, contiguous: $("wand-contiguous").checked }, mode);
      return;
    }
    ink.setPointerCapture(e.pointerId);
    selectDrag = { mode, a: inkPx(e), b: inkPx(e), start: at, end: at, points: [...at] };
  });
  ink.addEventListener("pointermove", (e) => {
    if (!selectTool || !selectDrag) return;
    const d = selectDrag, p = inkPx(e);
    d.b = e.shiftKey && selectKind !== "lasso" && d.mode === $("select-mode").value ? constrain(d.a, p, true) : p;
    d.end = screenToSource(d.b[0] / ink.width, d.b[1] / ink.height, adjust.get(activeId));
    if (selectKind === "lasso") {
      const q = screenToSource(...inkOut(e), adjust.get(activeId)).map((v) => clamp(v, 0, 1));
      const n = d.points.length;
      if (n < 400000 && Math.hypot(q[0] - d.points[n - 2], q[1] - d.points[n - 1]) > 0.002) d.points.push(...q);
    }
    const ctx = ink.getContext("2d");
    ctx.clearRect(0, 0, ink.width, ink.height);
    const path = new Path2D();
    if (selectKind === "rect") path.rect(Math.min(d.a[0], d.b[0]), Math.min(d.a[1], d.b[1]), Math.abs(d.b[0] - d.a[0]), Math.abs(d.b[1] - d.a[1]));
    else if (selectKind === "ellipse") path.ellipse((d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2, Math.abs(d.b[0] - d.a[0]) / 2, Math.abs(d.b[1] - d.a[1]) / 2, 0, 0, Math.PI * 2);
    else { for (let i = 0; i < d.points.length; i += 2) { const q = sourceToInk(d.points[i], d.points[i + 1], adjust.get(activeId)); i ? path.lineTo(...q) : path.moveTo(...q); } path.closePath(); }
    ctx.lineWidth = 1; ctx.strokeStyle = "#000"; ctx.stroke(path);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = "#fff"; ctx.stroke(path); ctx.setLineDash([]);
  });
  for (const t of ["pointerup", "pointercancel"]) {
    ink.addEventListener(t, () => {
      if (!selectTool || !selectDrag) return;
      const d = selectDrag; selectDrag = null;
      ink.getContext("2d").clearRect(0, 0, ink.width, ink.height);
      if (t === "pointercancel") return;
      const moved = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
      if (selectKind === "lasso") {
        if (d.points.length >= 6) commitSelection({ kind: "polygon", points: d.points }, d.mode);
        else if (d.mode === "new") deselect();
        return;
      }
      // A click without a drag clears the selection, as in Photoshop.
      if (moved < 3) { if (d.mode === "new") deselect(); return; }
      commitSelection({ kind: selectKind, x0: d.start[0], y0: d.start[1], x1: clamp(d.end[0], -1, 2), y1: clamp(d.end[1], -1, 2) }, d.mode);
    });
  }
})();
function renderSelectionPanel() {
  const sel = adjust.get(activeId)?.selection;
  $("selection-panel").hidden = !sel;
  if (!sel) return;
  for (const k of ["feather", "shift", "smooth", "refine"]) if (document.activeElement !== $("sel-" + k)) $("sel-" + k).value = +(sel[k] * 100).toFixed(2);
  $("sel-invert").checked = sel.invert;
  const l = selectedArtLayer();
  $("sel-mask").disabled = !l;
  $("sel-mask").title = l ? `Make the selection ${l.name}'s mask` : "Select a layer to mask";
}
let selGesture = null;
for (const k of ["feather", "shift", "smooth", "refine"]) {
  const input = $("sel-" + k);
  input.addEventListener("input", () => {
    const a = adjust.get(activeId); if (!a?.selection) return;
    if (selGesture !== k) { pushHistory("Refine selection"); selGesture = k; }
    a.selection[k] = clamp(Number(input.value) || 0, Number(input.min), Number(input.max)) / 100;
    drawHud();
  });
  input.addEventListener("change", () => { selGesture = null; drawHud(); });
}
$("sel-invert").onchange = invertSelection;
/** A layer mask that starts from the current selection. Masks live in layer
 *  space, so the layer's present transform pins the selection in place. */
function selectionMask(a, l) {
  return { enabled: true, inverted: false, strokes: [], selection: structuredClone(a.selection), origin: maskSpace(l) ? structuredClone(l.transform || identityTransform()) : identityTransform() };
}
function needSelection() { const a = adjust.get(activeId); if (!a?.selection) { say("Make a selection first (W)."); return null; } return a; }
$("sel-mask").onclick = () => {
  const a = needSelection(), l = selectedArtLayer(); if (!a) return;
  if (!l) return say("Select a layer to mask in the Layers panel.");
  // Painted strokes stay on top of the new selection base.
  edit("Mask from selection", (s) => { const t = findArt(s, l.id).layer; t.mask = { ...selectionMask(s, t), strokes: t.mask?.strokes || [] }; });
  syncControls();
};
function layerFromSelection(label, name, content) {
  const a = needSelection(); if (!a || !roomFor(a)) return;
  edit(label, (s) => { const l = addArt(s, name, content); l.mask = selectionMask(s, l); });
  syncControls();
}
$("sel-copy").onclick = () => layerFromSelection("Copy selection to layer", "Selection copy", { op: "source" });
$("sel-adjust").onclick = () => layerFromSelection("Add adjustment layer", "Adjustment", { op: "adjustment", ...Object.fromEntries(adjustmentKeys.map((k) => [k, 0])) });
$("sel-fill").onclick = () => layerFromSelection("Fill selection", "Fill", { op: "fill", color: [...hexToRgb($("sel-fill-color").value), 255] });
$("sel-crop").onclick = () => {
  const a = needSelection(); if (!a) return;
  let b;
  try { ed.set_ops(activeId, JSON.stringify(buildOps(a))); b = JSON.parse(ed.selection_bounds(activeId, JSON.stringify(a.selection), previewCap())); } catch (e) { return fail(e); }
  if (!b) return say("Nothing is selected.");
  edit("Crop to selection", (s) => (s.crop = { x: b[0], y: b[1], w: b[2], h: b[3] }));
  syncControls(); requestAnimationFrame(refreshLayers);
};

// --- retouching ------------------------------------------------------------------
// Clone, heal and dodge/burn paint onto a retouch layer that samples the layers
// beneath it, so the photograph itself is never altered.
let retouchTool = null, retouchSource = null, retouchOffset = null, retouchStroke = null, retouchCursor = null;
const retouchWidth = () => (Number($("retouch-size").value) / 100) * 0.18 + 0.002;
const RETOUCH_HINTS = {
  clone: "Alt/Option-click to set the source, then paint",
  heal: "Paint over a blemish · Alt/Option-click to pick a source",
  dodge: "Paint to lighten or darken",
};
function enterRetouch(kind) {
  if (!activeId) return;
  retouchTool = kind;
  $("retouch-bar").hidden = false; $("ink").hidden = false; $("ink").style.cursor = "crosshair";
  $("retouch-mode").hidden = $("retouch-range").hidden = kind !== "dodge";
  $("retouch-strength-label").textContent = kind === "dodge" ? "Exposure" : "Opacity";
  if (kind === "dodge" && Number($("retouch-strength").value) === 100) $("retouch-strength").value = 50;
  $("retouch-hint").textContent = RETOUCH_HINTS[kind];
  requestAnimationFrame(syncInk);
}
function exitRetouch() {
  if (!retouchTool) return;
  retouchTool = null; retouchStroke = null; retouchCursor = null;
  $("retouch-bar").hidden = true;
  const ink = $("ink"); ink.hidden = true; ink.getContext("2d").clearRect(0, 0, ink.width, ink.height);
  updateToolUI();
}
$("btn-retouch-done").onclick = exitRetouch;
function drawRetouch() {
  const ink = $("ink"), ctx = ink.getContext("2d"), a = adjust.get(activeId);
  ctx.clearRect(0, 0, ink.width, ink.height);
  if (!retouchTool || !a) return;
  const radius = Math.max(2, retouchWidth() * sourceShortOnScreen() / 2);
  if (retouchStroke?.points.length) {
    ctx.save(); ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = radius * 2;
    ctx.strokeStyle = retouchStroke.kind === "burn" ? "rgba(0,0,0,.25)" : "rgba(255,255,255,.25)";
    ctx.beginPath();
    for (let i = 0; i < retouchStroke.points.length; i += 2) { const p = sourceToInk(retouchStroke.points[i], retouchStroke.points[i + 1], a); i ? ctx.lineTo(...p) : ctx.moveTo(...p); }
    if (retouchStroke.points.length === 2) ctx.lineTo(...sourceToInk(retouchStroke.points[0] + 1e-4, retouchStroke.points[1], a));
    ctx.stroke(); ctx.restore();
  }
  if (!retouchCursor) return;
  const ring = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.strokeStyle = "#111"; ctx.lineWidth = .5; ctx.stroke(); };
  ring(...retouchCursor, radius);
  // Where the brush is sampling from right now.
  if (retouchTool !== "dodge" && retouchSource) {
    const here = screenToSource(retouchCursor[0] / ink.width, retouchCursor[1] / ink.height, a);
    const off = retouchOffset;
    const [sx, sy] = off ? sourceToInk(here[0] - off[0], here[1] - off[1], a) : sourceToInk(retouchSource[0], retouchSource[1], a);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy); ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8); ctx.stroke();
    ring(sx, sy, radius);
  }
}
(() => {
  const ink = $("ink");
  let last = null;
  ink.addEventListener("pointerdown", (e) => {
    if (!retouchTool || !activeId || e.button !== 0 || panning()) return;
    const a = adjust.get(activeId), at = screenToSource(...inkOut(e), a);
    e.preventDefault();
    if (e.altKey && retouchTool !== "dodge") {
      retouchSource = at.map((v) => clamp(v, 0, 1)); retouchOffset = null;
      say(retouchTool === "clone" ? "Clone source set. Paint to copy from it." : "Healing source set. Paint to heal from it.");
      drawRetouch(); return;
    }
    if (retouchTool === "clone" && !retouchSource) return say("Alt-click (Option-click on a Mac) where to copy from first.");
    const target = selectedArtLayer();
    if (!(kindIs(target, "retouch") && target.visible) && !roomFor(a)) return;
    // Aligned sampling: the first stroke after picking a source fixes the
    // offset, and later strokes keep it, as Photoshop's Aligned option does.
    if (retouchTool !== "dodge" && retouchSource && !retouchOffset) retouchOffset = [at[0] - retouchSource[0], at[1] - retouchSource[1]];
    const kind = retouchTool === "dodge" ? $("retouch-mode").value : retouchTool;
    const off = retouchTool !== "dodge" && retouchOffset ? retouchOffset : [0, 0];
    retouchStroke = {
      kind, width: retouchWidth(), hardness: Number($("retouch-hardness").value) / 100,
      strength: Number($("retouch-strength").value) / 100, range: $("retouch-range").value,
      dx: clamp(off[0], -2, 2), dy: clamp(off[1], -2, 2), points: at.map((v) => clamp(v, 0, 1)),
    };
    last = [e.clientX, e.clientY];
    ink.setPointerCapture(e.pointerId);
    drawRetouch();
  });
  ink.addEventListener("pointermove", (e) => {
    if (!retouchTool) return;
    retouchCursor = inkPx(e);
    if (retouchStroke && Math.hypot(e.clientX - last[0], e.clientY - last[1]) >= 2 && retouchStroke.points.length < 20000) {
      last = [e.clientX, e.clientY];
      retouchStroke.points.push(...screenToSource(...inkOut(e), adjust.get(activeId)).map((v) => clamp(v, 0, 1)));
    }
    drawRetouch();
  });
  ink.addEventListener("pointerleave", () => { if (retouchTool && !retouchStroke) { retouchCursor = null; drawRetouch(); } });
  for (const t of ["pointerup", "pointercancel"]) {
    ink.addEventListener(t, () => {
      if (!retouchTool || !retouchStroke) return;
      const stroke = retouchStroke; retouchStroke = null;
      if (t === "pointercancel") return drawRetouch();
      const a = adjust.get(activeId);
      try {
        // Spot healing: with no source picked, the engine finds a clean patch nearby.
        if (stroke.kind === "heal" && !retouchSource) {
          ed.set_ops(activeId, JSON.stringify(buildOps(a)));
          [stroke.dx, stroke.dy] = JSON.parse(ed.heal_offset(activeId, new Float32Array(stroke.points), stroke.width, previewCap())).map((v) => clamp(v, -2, 2));
        }
        const commit = (s) => {
          let target = findArt(s, selectedArt)?.layer;
          if (!(kindIs(target, "retouch") && target.visible)) target = addArt(s, "Retouch", { op: "retouch", strokes: [] });
          target.content.strokes.push(structuredClone(stroke));
        };
        const candidate = structuredClone(a), keep = [selectedArt, new Set(selectedSet)];
        commit(candidate);
        [selectedArt, selectedSet] = keep;
        ed.set_ops(activeId, JSON.stringify(buildOps(candidate)));
        const labels = { clone: "Clone stamp", heal: "Healing brush", dodge: "Dodge", burn: "Burn" };
        edit(labels[stroke.kind], commit);
      } catch (error) { fail(error); }
      drawRetouch(); syncControls();
    });
  }
})();

// --- ops translation -------------------------------------------------------
// Canonical order is geometry, then tone, then colour, then effects, then
// marks laid on top. Rust applies the array in sequence, so this function is
// the single place that order lives.

const isIdentity = (c) => c.length === 4 && c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1;
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function buildOps(a, { skipGeometry = false } = {}) {
  const ops = [];
  // Guides are layout metadata the engine ignores; they ride along so they
  // are saved with the project.
  if (a.guides.x.length || a.guides.y.length) ops.push({ op: "guides", x: a.guides.x, y: a.guides.y });
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
  if (a.baseOpacity !== 1) ops.push({ op: "base_opacity", value: a.baseOpacity });
  for (const g of a.gradients) ops.push({ op: "gradient", ...g });
  if (a.shapes.length) ops.push({ op: "shapes", items: a.shapes });
  // Paint goes last so a stroke sits on top of the tone adjustments instead of
  // being desaturated along with the photograph.
  if (a.strokes.length) ops.push({ op: "paint", strokes: a.strokes });
  ops.push(...a.artLayers);
  return ops;
}

function parseOps(ops) {
  const a = blank();
  const pct = (v) => Math.round(v * 100);
  for (const o of ops) {
    switch (o.op) {
      case "layer": case "group": a.artLayers.push(o); break;
      case "guides": a.guides = { x: o.x || [], y: o.y || [] }; break;
      case "base_opacity": a.baseOpacity = o.value; break;
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
  // v1–v3 documents had a fixed gradient -> shapes -> paint order.
  const migrated = [];
  for (const g of a.gradients) migrated.push(makeArt("Gradient", { op: "gradient", ...g }));
  if (a.shapes.length) migrated.push(makeArt("Shapes", { op: "shapes", items: a.shapes }));
  if (a.strokes.length) migrated.push(makeArt("Drawing", { op: "paint", strokes: a.strokes }));
  a.artLayers.unshift(...migrated);
  a.gradients = []; a.shapes = []; a.strokes = [];
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

  ed.set_ops(activeId, JSON.stringify(buildOps(a)));
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
  if (layerTool) requestAnimationFrame(drawLayerTool);
  if (lassoing) requestAnimationFrame(() => { syncInk(); drawLasso(); });
  if (selectTool || retouchTool) requestAnimationFrame(() => { syncInk(); if (retouchTool) drawRetouch(); });
  requestAnimationFrame(drawHud);
  updateAnts();
  // Text in a bundled family that is not loaded yet renders as Lato for a
  // frame, then again once the font arrives.
  if (!comparing) loadFontsThenRender();
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
  renderArtPanel();
  $("btn-clear-ink").hidden = !artCount(a, "paint");
  $("btn-clear-gradients").hidden = !artCount(a, "gradient");
  $("btn-clear-shapes").hidden = !artCount(a, "shapes");
  $("btn-unlasso").hidden = !a.lasso;
  renderSelectionPanel();
  renderGuides();
  updateAnts();
  drawCurves();
  requestAnimationFrame(drawHud);
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
  const [x, y] = sourceToOut(sx, sy, a), ink = $("ink");
  return [x * ink.width, y * ink.height];
}

/** Source coordinates to normalized output (what is on screen), the forward
 *  direction of screenToSource(). */
function sourceToOut(sx, sy, a) {
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
  return [x, y];
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
  edit("Clear drawing", (a) => (a.artLayers = pruneArt(a.artLayers, l => kindIs(l, "paint"))));
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
    if (artCount(adjust.get(activeId), "paint") >= (LIMITS?.maxStrokes ?? Infinity)) {
      return say(`This image has reached the limit of ${LIMITS.maxStrokes} brush strokes.`, true);
    }
    const picked = selectedArtLayer(), onDrawing = kindIs(picked, "paint") && picked.visible;
    if (brush.erase && !onDrawing) return say("Select a visible drawing layer to erase.");
    if (!onDrawing && !roomFor(adjust.get(activeId))) return;
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
      let target = selectedArtLayer();
      if (!kindIs(target, "paint") || !target.visible) target = addArt(adjust.get(activeId), "Drawing", { op: "paint", strokes: [] });
      target.content.strokes.push(stroke);
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
    const [sx, sy] = layerLocal(...screenToSource(nx, ny, a), kindIs(selectedArtLayer(), "paint") ? selectedArtLayer().transform : null);
    inkStroke.points.push(clamp(sx,0,1), clamp(sy,0,1));
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
$("btn-clear-gradients").addEventListener("click", () => { edit("Clear gradients", (a) => (a.artLayers = pruneArt(a.artLayers, l => kindIs(l, "gradient")))); syncControls(); });
$("btn-clear-shapes").addEventListener("click", () => { edit("Clear shapes", (a) => (a.artLayers = pruneArt(a.artLayers, l => kindIs(l, "shapes")))); syncControls(); });

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

  if (!roomFor(a)) return;
  if (drawTool === "gradient") {
    if (artCount(a, "gradient") >= LIMITS.maxGradients) return say(`An image can hold up to ${LIMITS.maxGradients} gradients.`, true);
    const to = rgba($("g-to").value, $("g-clear").checked ? 0 : 255);
    edit("Gradient", (s) => addArt(s, "Gradient", { op: "gradient",
      kind: $("g-kind").value, x0, y0, x1, y1,
      from: rgba($("g-from").value, 255), to,
      opacity: Number($("g-opacity").value) / 100, blend: $("g-blend").value,
    }));
  } else {
    if (artCount(a, "shapes") >= LIMITS.maxShapes) return say(`An image can hold up to ${LIMITS.maxShapes} shapes.`, true);
    const line = shapeKind === "line";
    const fill = !line && $("sh-fill-on").checked ? rgba($("sh-fill").value, 255) : null;
    // A line is all stroke; with Stroke unticked it borrows the fill colour.
    const strokeHex = $("sh-stroke-on").checked ? $("sh-stroke").value : line ? $("sh-fill").value : null;
    const stroke = strokeHex ? rgba(strokeHex, 255) : null;
    if (!fill && !stroke) return say("Turn on Fill or Stroke to draw a shape.");
    const names = { rect: "Rectangle", ellipse: "Ellipse", line: "Line" };
    edit(names[shapeKind], (s) => addArt(s, names[shapeKind], { op: "shapes", items: [{ kind: shapeKind, x0, y0, x1, y1, fill, stroke, width: shapeWidthFraction() }] }));
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

  await ensureFonts([adjust.get(activeId)]);
  let bytes, name;
  try {
    const q = Number($("s-quality").value);
    ed.set_ops(activeId, JSON.stringify(buildOps(adjust.get(activeId))));
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
  selectArt(null);
  userFonts = JSON.parse(ed.fonts_json());
  await ensureFonts();

  refreshLayers();
  syncControls();
  updateHistoryButtons();
  scheduleRender();
  say(`Opened ${file.name} — ${layers.length} image${layers.length === 1 ? "" : "s"}, edits intact.`);
}

$("btn-save").addEventListener("click", async () => {
  let bytes;
  try {
    for (const [id, state] of adjust) ed.set_ops(id, JSON.stringify(buildOps(state)));
    bytes = ed.save_bundle();
  } catch (e) { return fail(e); }
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
  if (layerTool) drawLayerTool();
  if (painting || lassoing || drawTool || selectTool || retouchTool) { syncInk(); if (lassoing) drawLasso(); if (retouchTool) drawRetouch(); }
  drawHud();
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
    // Letters by physical key: Option changes e.key on a Mac.
    const code = e.code;
    if (code === "KeyG") { e.preventDefault(); e.altKey ? toggleClip() : e.shiftKey ? ungroupLayers() : groupLayers(); return; }
    if (code === "KeyA" && activeId) { e.preventDefault(); selectAll(); return; }
    if (code === "KeyD" && activeId) { e.preventDefault(); deselect(); return; }
    if (code === "KeyI" && e.shiftKey && activeId) { e.preventDefault(); invertSelection(); return; }
    if (code === "Semicolon") { e.preventDefault(); if (e.shiftKey) view.snap = !view.snap; else view.guides = !view.guides; renderGuides(); drawHud(); say(e.shiftKey ? `Snapping ${view.snap ? "on" : "off"}` : `Guides ${view.guides ? "shown" : "hidden"}`); return; }
    if (code === "Quote") { e.preventDefault(); view.grid = !view.grid; renderGuides(); drawHud(); return; }
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
    } else if (retouchTool) {
      $("retouch-size").value = clamp(Number($("retouch-size").value) + d * 3, 1, 100); drawRetouch();
    }
    return;
  }

  const tool = { v: "transform", m: "mask", w: "select", s: "clone", j: "heal", o: "dodge", t: "text", h: "hand", b: "paint", c: "crop", l: "lasso", e: "eraser", g: "gradient", u: "shape", i: "eyedropper" }[k];
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
  if (layerTool) drawLayerTool();
  if (painting || drawTool || selectTool || retouchTool) syncInk();
  if (lassoing) { syncInk(); drawLasso(); }
  drawHud();
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
  exitSelect();
  exitRetouch();
  sampling = false;
  textTool = false;
  typeDrag = null; typeCreate = null; guideDrag = null; snapLines = [];
  if (layerTool) { layerTool = null; layerDrag = null; maskStroke = null; maskCursor = null; $("ink").hidden = true; }
  propertyGesture = null;
  handTool = false;
  $("canvas").style.cursor = "";
  updateToolUI();
}

function currentTool() {
  if (layerTool) return layerTool;
  if (selectTool) return "select";
  if (retouchTool) return retouchTool;
  if (textTool) return "text";
  if (cropping) return "crop";
  if (lassoing) return "lasso";
  if (painting) return brush.erase ? "eraser" : "paint";
  if (drawTool) return drawTool;
  if (handTool) return "hand";
  if (sampling) return "eyedropper";
  return null;
}

const TOOL_NAMES = { select: "Select", clone: "Clone stamp", heal: "Healing brush", dodge: "Dodge / burn", transform: "Transform layer", mask: "Mask brush", text: "Type — drag to position", crop: "Crop", lasso: "Scissors", paint: "Brush", eraser: "Eraser", gradient: "Gradient", shape: "Shapes", hand: "Hand", eyedropper: "Eyedropper" };

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
  if (tool === "transform" || tool === "mask") enterLayerTool(tool);
  if (tool === "select") enterSelect();
  if (tool === "clone" || tool === "heal" || tool === "dodge") enterRetouch(tool);
  if (tool === "crop") enterCrop();
  if (tool === "lasso") enterLasso();
  if (tool === "paint" || tool === "eraser") {
    enterPaint();
    if ((tool === "eraser") !== brush.erase) $("btn-eraser").click();
  }
  if (tool === "gradient" || tool === "shape") enterDrawTool(tool);
  if (tool === "text") { textTool = true; $("canvas").style.cursor = "text"; requestAnimationFrame(drawHud); }
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
  drawHud();
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
document.addEventListener("workspacechange", () => { leaveTools(); updateAnts(); drawHud(); });

(async () => {
  try {
    const mod = await import("./pkg/darkroom.js");
    wasm = await mod.default();
    wasmMod = mod;
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
