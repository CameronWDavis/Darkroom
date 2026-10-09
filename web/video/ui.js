// The video studio's interface: media bin, monitor, inspector and timeline.
// All edits go through commit() or liveEdit(), which record history and
// redraw; the rules for what an edit does live in model.js.

import {
  LIMITS, ASPECTS, RESOLUTIONS, FRAME_RATES, SPEEDS, TRANSITIONS, ANIMS, EASES, FONTS, LOOKS,
  newProject, videoClip, textItem, captionItem, imageOverlay, audioItem, marker, defaultGrade, defaultMotion,
  layoutV1, itemEnd, itemLen, mediaLength, findTrack, canAdd, v1IndexAt, split, remove, moveV1, trimV1, trimItem,
  snap, snapPoints, History, timecode, parseSRT, formatSRT, serialize, sanitize, uid,
} from "./model.js";
import { Engine, outputSize, fmtBytes } from "./engine.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return el;
};

let project = newProject();
const history = new History(100);
let engine;
let selected = null;
let tool = "select";
let snapping = true;
let pps = 60;                 // timeline pixels per second
let gradeClipboard = null;
let liveGesture = false;
let drag = null;
let follow = true;
let started = false;

// --- edits -----------------------------------------------------------------

function commit(label, fn) {
  history.push(project, label);
  const result = fn(project);
  changed();
  return result;
}

/** For continuous controls: one history entry per drag, no inspector rebuild. */
function liveEdit(label, fn) {
  if (!liveGesture) { history.push(project, label); liveGesture = true; }
  fn(project);
  renderTimeline();
  updateHistory();
  engine.requestRender();
}
const endLive = () => { liveGesture = false; };

function changed({ inspector = true } = {}) {
  if (selected && !findTrack(project, selected)) selected = null;
  renderBin();
  renderTimeline();
  if (inspector) renderInspector();
  updateHistory();
  engine.seek(engine.t);
  $("v-empty").hidden = project.v1.length + project.v2.length > 0;
}

function updateHistory() {
  const u = history.undo.at(-1), r = history.redo.at(-1);
  $("v-undo").disabled = !u;
  $("v-redo").disabled = !r;
  $("v-undo").title = u ? `Undo ${u.label} (Ctrl+Z)` : "Undo (Ctrl+Z)";
  $("v-redo").title = r ? `Redo ${r.label} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)";
}

function undo() { const s = history.back(project); if (s) { project = s; changed(); } }
function redo() { const s = history.forward(project); if (s) { project = s; changed(); } }

/** m:ss.s, for durations a person reads rather than an editor types. */
const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const status = (msg, bad = false) => { const s = $("v-status"); s.textContent = msg; s.classList.toggle("bad", bad); };
const media = (id) => project.media.find((m) => m.id === id);
const isOffline = (id) => { const rt = engine.runtime.get(id); return !rt || rt.offline; };

function select(id) {
  selected = id;
  renderTimeline();
  renderInspector();
}

// --- media bin -------------------------------------------------------------

async function importMedia(files) {
  let added = 0;
  for (const file of files) {
    if (project.media.length >= LIMITS.mediaItems) { status(`The media bin holds up to ${LIMITS.mediaItems} files.`, true); break; }
    status(`Reading ${file.name}…`);
    try {
      const { info, rt } = await engine.probe(file);
      const id = uid("md");
      engine.attach(id, rt);
      commit(`Import ${file.name}`, (p) => p.media.push({ id, ...info }));
      added++;
    } catch (e) {
      status(e.message || String(e), true);
    }
  }
  if (added) status(`Imported ${added} file${added > 1 ? "s" : ""}. Drag to the timeline, or double-click to add.`);
}

/** Matches picked files to offline media by name, then size. */
async function relink(files) {
  let n = 0;
  for (const file of files) {
    const m = project.media.find((x) => isOffline(x.id) && x.name === file.name && (!x.size || x.size === file.size))
      || project.media.find((x) => isOffline(x.id) && x.name === file.name);
    if (!m) continue;
    try {
      const { rt } = await engine.probe(file);
      engine.attach(m.id, rt);
      n++;
    } catch (e) { status(e.message, true); }
  }
  const left = project.media.filter((m) => isOffline(m.id)).length;
  status(n ? `Relinked ${n} file${n > 1 ? "s" : ""}.${left ? ` ${left} still offline.` : ""}` : "None of those files match the offline media by name.", !n);
  changed();
}

function addToTimeline(m, track, t) {
  if (!canAdd(project)) return status(`A sequence holds up to ${LIMITS.timelineItems} items.`, true);
  if (track === "v1" || (!track && m.kind !== "audio")) {
    if (m.kind === "audio") return status("Audio goes on the A2 track.", true);
    const at = t === undefined ? project.v1.length : v1IndexAt(project, t);
    const c = videoClip(m);
    commit(`Add ${m.name}`, (p) => p.v1.splice(at, 0, c));
    select(c.id);
  } else if (track === "v2") {
    if (m.kind !== "image") return status("Only titles and images go on V2.", true);
    const it = imageOverlay(m, t ?? engine.t);
    commit(`Add ${m.name}`, (p) => p.v2.push(it));
    select(it.id);
  } else {
    if (m.kind !== "audio") return status("Only audio goes on the A2 track.", true);
    const it = audioItem(m, t ?? engine.t);
    commit(`Add ${m.name}`, (p) => p.a2.push(it));
    select(it.id);
  }
}

function renderBin() {
  const list = $("v-bin");
  list.replaceChildren();
  $("v-bin-empty").hidden = project.media.length > 0;
  const offline = project.media.filter((m) => isOffline(m.id)).length;
  $("v-relink").hidden = !offline;
  $("v-relink").textContent = `Relink ${offline} offline file${offline === 1 ? "" : "s"}…`;
  for (const m of project.media) {
    const rt = engine.runtime.get(m.id);
    const off = isOffline(m.id);
    const used = [...project.v1, ...project.v2, ...project.a2].filter((x) => x.mediaId === m.id).length;
    const thumb = rt?.thumb
      ? h("img", { src: rt.thumb, alt: "" })
      : h("span", { class: "bin-icon" }, m.kind === "audio" ? "♪" : off ? "!" : "▶");
    const meta = [m.kind, m.kind === "image" ? `${m.width}×${m.height}` : clock(m.duration), fmtBytes(m.size)];
    list.append(h("li", {
      class: "bin-item" + (off ? " offline" : ""), draggable: !off, title: off ? `${m.name} is offline` : `${m.name} — double-click to add`,
      ondragstart: (e) => { e.dataTransfer.setData("application/x-darkroom-media", m.id); e.dataTransfer.effectAllowed = "copy"; },
      ondblclick: () => !off && addToTimeline(m),
    },
      thumb,
      h("div", { class: "bin-text" }, h("strong", {}, m.name), h("span", {}, off ? "offline — relink" : meta.join(" · "))),
      h("span", { class: "bin-used", title: `Used ${used} time${used === 1 ? "" : "s"}` }, used ? `×${used}` : ""),
      h("button", { class: "bin-drop", title: `Remove ${m.name} and its clips`, onclick: (e) => {
        e.stopPropagation();
        commit(`Remove ${m.name}`, (p) => {
          p.media = p.media.filter((x) => x.id !== m.id);
          for (const k of ["v1", "v2", "a2"]) p[k] = p[k].filter((x) => x.mediaId !== m.id);
          if (p.v1[0]) p.v1[0].transition = null;
        });
      } }, "×"),
    ));
  }
}

// --- timeline --------------------------------------------------------------

const content = () => $("v-content");
const timeAt = (e) => Math.max(0, (e.clientX - content().getBoundingClientRect().left) / pps);

function renderTimeline() {
  const dur = engine.duration();
  const scroll = $("v-scroll");
  const width = Math.max(scroll.clientWidth, (dur + 15) * pps);
  content().style.width = `${width}px`;
  drawRuler();

  for (const track of ["v1", "v2", "a2"]) {
    const el = content().querySelector(`[data-track="${track}"]`);
    el.replaceChildren();
    if (track === "v1") {
      for (const e of layoutV1(project.v1)) {
        const c = e.clip, m = media(c.mediaId);
        const rt = engine.runtime.get(c.mediaId);
        const div = item(c.id, e.start, e.len, m?.name || "?", "v1");
        if (rt?.thumb) div.style.backgroundImage = `url(${rt.thumb})`;
        if (isOffline(c.mediaId)) div.classList.add("offline");
        if (c.speed !== 1) div.querySelector(".vi-label").append(h("em", {}, ` ${c.speed}×`));
        el.append(div);
        if (e.tr) {
          const label = TRANSITIONS.find((t) => t[0] === c.transition.type)?.[1] || "";
          el.append(h("div", { class: "vtrans", title: `${label} · ${e.tr.toFixed(2)} s`, dataset: { id: c.id },
            style: `left:${e.start * pps}px;width:${Math.max(6, e.tr * pps)}px` }));
        }
      }
    } else {
      const lane = lanes(project[track]);
      const rows = Math.max(1, ...lane.values());
      for (const it of project[track]) {
        const name = it.kind === "text" ? `T  ${it.text.split("\n")[0] || "Title"}` : media(it.mediaId)?.name || "?";
        const div = item(it.id, it.start, itemLen(it), name, track);
        // Overlapping items share the track in stacked rows, so each stays reachable.
        if (rows > 1) {
          const k = lane.get(it.id) - 1;
          div.style.top = `calc(4px + ${k} * (100% - 8px) / ${rows})`;
          div.style.bottom = "auto";
          div.style.height = `calc((100% - 8px) / ${rows} - 2px)`;
        }
        if (it.kind === "text") div.classList.add(it.caption ? "caption" : "title");
        if (it.kind === "image") { const rt = engine.runtime.get(it.mediaId); if (rt?.thumb) div.style.backgroundImage = `url(${rt.thumb})`; }
        if (track === "a2") drawWave(div, it);
        if (it.mediaId && isOffline(it.mediaId)) div.classList.add("offline");
        el.append(div);
      }
    }
  }
  movePlayhead(engine.t);
}

/** Greedy row assignment: each item takes the first row free at its start.
 *  Returns id -> row number, starting at 1. */
function lanes(list) {
  const ends = [];
  const out = new Map();
  for (const it of [...list].sort((a, b) => a.start - b.start)) {
    let row = ends.findIndex((e) => e <= it.start + 1e-6);
    if (row < 0) { row = ends.length; ends.push(0); }
    ends[row] = itemEnd(it);
    out.set(it.id, row + 1);
  }
  return out;
}

function item(id, start, len, label, track) {
  return h("div", {
    class: `vitem ${track}` + (id === selected ? " selected" : ""), dataset: { id, track },
    style: `left:${start * pps}px;width:${Math.max(4, len * pps)}px`,
  },
    h("i", { class: "edge s", dataset: { edge: "start" } }),
    h("span", { class: "vi-label" }, label),
    h("i", { class: "edge e", dataset: { edge: "end" } }),
  );
}

function drawWave(div, it) {
  const peaks = engine.runtime.get(it.mediaId)?.peaks;
  if (!peaks) return;
  const w = Math.min(4000, Math.max(4, Math.round(itemLen(it) * pps)));
  const c = h("canvas", { class: "wave", width: w, height: 40 });
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(170,230,190,0.75)";
  const per = 50, first = it.in * per, span = (it.out - it.in) * per;
  for (let x = 0; x < w; x++) {
    const i = Math.floor(first + (x / w) * span);
    const v = peaks[Math.min(peaks.length - 1, i)] || 0;
    const y = Math.max(1, v * 38);
    ctx.fillRect(x, 20 - y / 2, 1, y);
  }
  div.append(c);
}

const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function drawRuler() {
  const scroll = $("v-scroll");
  const c = $("v-ruler");
  const w = scroll.clientWidth;
  c.width = w * devicePixelRatio;
  c.height = 24 * devicePixelRatio;
  c.style.width = `${w}px`;
  c.style.left = `${scroll.scrollLeft}px`;
  const ctx = c.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, 24);
  const minor = TICKS.find((s) => s * pps >= 8) || 600;
  const major = TICKS.find((s) => s * pps >= 80 && s >= minor * 2) || 600;
  const t0 = scroll.scrollLeft / pps, t1 = t0 + w / pps;
  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = ctx.strokeStyle = "#8b909c";
  ctx.beginPath();
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round((t - t0) * pps) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.moveTo(x, isMajor ? 10 : 17);
    ctx.lineTo(x, 24);
    if (isMajor) ctx.fillText(timecode(t + 1e-6, project.settings.fps).slice(3, 8), x + 3, 9);
  }
  ctx.stroke();
  for (const mk of project.markers) {
    const x = (mk.time - t0) * pps;
    if (x < -6 || x > w + 6) continue;
    ctx.fillStyle = mk.color;
    ctx.beginPath(); ctx.moveTo(x - 5, 12); ctx.lineTo(x + 5, 12); ctx.lineTo(x + 5, 18); ctx.lineTo(x, 23); ctx.lineTo(x - 5, 18); ctx.fill();
    if (mk.id === selected) { ctx.strokeStyle = "#fff"; ctx.stroke(); }
  }
}

function movePlayhead(t) {
  $("v-playhead").style.left = `${t * pps}px`;
  if (follow && engine?.playing) {
    const s = $("v-scroll"), x = t * pps;
    if (x > s.scrollLeft + s.clientWidth - 40 || x < s.scrollLeft) s.scrollLeft = x - 60;
  }
}

function setZoom(v) {
  // Logarithmic: 2 px/s (a long overview) up to 600 px/s (frame-level work).
  const scroll = $("v-scroll");
  const centre = (scroll.scrollLeft + scroll.clientWidth / 2) / pps;
  pps = 2 * Math.pow(300, v / 100);
  $("v-zoom").value = v;
  renderTimeline();
  scroll.scrollLeft = centre * pps - scroll.clientWidth / 2;
  drawRuler();
}
const zoomValue = () => (Math.log(pps / 2) / Math.log(300)) * 100;

function fitTimeline() {
  const dur = engine.duration() || 10;
  const target = ($("v-scroll").clientWidth - 40) / dur;
  setZoom(clamp((Math.log(target / 2) / Math.log(300)) * 100, 0, 100));
  $("v-scroll").scrollLeft = 0;
}

function bindTimeline() {
  const scroll = $("v-scroll");
  scroll.addEventListener("scroll", drawRuler);
  scroll.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(clamp(zoomValue() + (e.deltaY < 0 ? 6 : -6), 0, 100));
  }, { passive: false });

  content().addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const t = timeAt(e);
    const it = e.target.closest(".vitem");
    const tr = e.target.closest(".vtrans");
    content().setPointerCapture(e.pointerId);

    if (e.target.id === "v-ruler") {
      const mk = project.markers.find((m) => Math.abs(m.time - t) * pps < 7);
      if (mk) { select(mk.id); engine.seek(mk.time); return; }
      drag = { kind: "scrub" };
      engine.seek(t);
      return;
    }
    if (tr) { select(tr.dataset.id); $("v-inspector").querySelector("[data-section=transition]")?.scrollIntoView({ block: "nearest" }); return; }
    if (!it) {
      selected = null;
      renderInspector();
      renderTimeline();
      drag = { kind: "scrub" };
      engine.seek(t);
      return;
    }
    const id = it.dataset.id, track = it.dataset.track;
    if (tool === "razor") {
      const snapped = snapping ? snap(t, [engine.t], 6 / pps) : t;
      history.push(project, "Razor cut");
      if (split(project, id, snapped)) changed();
      else { history.undo.pop(); status("Can't cut there: too close to an edge or inside a transition.", true); }
      return;
    }
    select(id);
    const found = findTrack(project, id);
    drag = {
      kind: e.target.dataset.edge ? "trim" : "move", edge: e.target.dataset.edge, id, track,
      x0: e.clientX, t0: t, orig: structuredClone(found.item), pushed: false, index: found.index,
    };
  });

  content().addEventListener("pointermove", (e) => {
    if (!drag) return;
    const t = timeAt(e);
    if (drag.kind === "scrub") { engine.seek(t); return; }
    const dx = e.clientX - drag.x0;
    if (!drag.pushed) {
      if (Math.abs(dx) < 3) return;
      history.push(project, drag.kind === "trim" ? "Trim" : "Move");
      drag.pushed = true;
    }
    const hit = findTrack(project, drag.id);
    if (!hit) return;
    const it = hit.item, o = drag.orig;
    let dt = dx / pps;
    const tol = snapping ? 8 / pps : 0;
    const pts = snapping ? snapPoints(project, drag.id, engine.t) : [];

    if (drag.kind === "trim") {
      Object.assign(it, structuredClone(o));
      if (drag.track === "v1") {
        trimV1(project, drag.id, drag.edge, dt, media(it.mediaId));
      } else {
        const edgeT = drag.edge === "start" ? o.start : itemEnd(o);
        if (snapping) dt = snap(edgeT + dt, pts, tol) - edgeT;
        trimItem(it, drag.edge, dt, it.mediaId ? media(it.mediaId) : null);
      }
    } else if (drag.track === "v1") {
      // Reordering: show where the clip would land; apply on release.
      drag.target = v1IndexAt(project, t);
      const lay = layoutV1(project.v1);
      const x = drag.target < lay.length ? lay[drag.target].start : lay.at(-1)?.end ?? 0;
      const ind = $("v-drop");
      ind.hidden = false;
      ind.style.left = `${x * pps}px`;
      ind.dataset.track = "v1";
    } else {
      let start = Math.max(0, o.start + dt);
      if (snapping) {
        const s = snap(start, pts, tol);
        if (s !== start) start = s;
        else start = Math.max(0, snap(start + itemLen(o), pts, tol) - itemLen(o));
      }
      it.start = start;
    }
    renderTimeline();
    engine.requestRender();
  });

  const end = () => {
    if (drag?.kind === "move" && drag.track === "v1" && drag.pushed) {
      if (drag.target !== undefined && drag.target !== drag.index && drag.target !== drag.index + 1) moveV1(project, drag.id, drag.target);
      else history.undo.pop(); // dropped where it started: nothing to undo
    }
    $("v-drop").hidden = true;
    const was = drag;
    drag = null;
    if (was && was.kind !== "scrub") changed();
  };
  content().addEventListener("pointerup", end);
  content().addEventListener("pointercancel", end);

  // Media dropped from the bin.
  for (const track of ["v1", "v2", "a2"]) {
    const el = content().querySelector(`[data-track="${track}"]`);
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-darkroom-media")) return;
      e.preventDefault();
      const ind = $("v-drop");
      ind.hidden = false;
      const t = timeAt(e);
      let x = t;
      if (track === "v1") {
        const lay = layoutV1(project.v1), i = v1IndexAt(project, t);
        x = i < lay.length ? lay[i].start : lay.at(-1)?.end ?? 0;
      }
      ind.style.left = `${x * pps}px`;
      ind.dataset.track = track;
    });
    el.addEventListener("dragleave", () => ($("v-drop").hidden = true));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      $("v-drop").hidden = true;
      const m = media(e.dataTransfer.getData("application/x-darkroom-media"));
      if (m) addToTimeline(m, track, timeAt(e));
    });
  }
}

// --- inspector -------------------------------------------------------------

const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const set = (obj, path, v) => { const ks = path.split("."); const last = ks.pop(); ks.reduce((o, k) => o[k], obj)[last] = v; };

const fmt = {
  int: (v) => String(Math.round(v)),
  pct: (v) => `${Math.round(v)}%`,
  deg: (v) => `${Math.round(v)}°`,
  sec: (v) => `${(+v).toFixed(1)} s`,
  ev: (v) => `${v > 0 ? "+" : ""}${(v / 100).toFixed(2)} EV`,
};

/** Field spec: {t: kind, label, path | get/set, min, max, step, fmt, options, live} */
function field(target, f, onSet) {
  const read = () => (f.get ? f.get(target()) : get(target(), f.path));
  const write = (v) => (f.set ? f.set(target(), v) : set(target(), f.path, v));
  const label = f.label;
  const apply = (v, live) => {
    const fn = () => { write(v); onSet?.(target()); };
    if (live) liveEdit(label, fn);
    else { commit(label, fn); }
  };
  if (f.t === "buttons") {
    return h("div", { class: "vbtns" }, ...f.buttons.map(([text, fn, title]) => h("button", { class: "btn sm", title: title || "", onclick: fn }, text)));
  }
  if (f.t === "note") return h("p", { class: "note tight" }, f.text);
  const v = read();
  if (f.t === "range") {
    const out = h("output", {}, (f.fmt || fmt.int)(v));
    const input = h("input", { type: "range", min: f.min, max: f.max, step: f.step || 1, value: v, disabled: !!f.disabled,
      oninput: (e) => { out.textContent = (f.fmt || fmt.int)(+e.target.value); apply(+e.target.value, true); },
      onchange: endLive,
      ondblclick: () => f.reset !== undefined && (commit(`Reset ${label.toLowerCase()}`, () => write(f.reset)), renderInspector()),
    });
    return h("label", { class: "slider", title: f.reset !== undefined ? "Double-click to reset" : "" }, h("span", {}, label), out, input);
  }
  if (f.t === "num") {
    return h("label", { class: "vfield" }, h("span", {}, label),
      h("input", { type: "number", min: f.min ?? 0, max: f.max ?? "", step: f.step || 0.01, value: (+v).toFixed(2),
        onchange: (e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) apply(f.min !== undefined ? Math.max(f.min, n) : n, false); renderInspector(); } }));
  }
  if (f.t === "select") {
    return h("label", { class: "vfield" }, h("span", {}, label),
      h("select", { disabled: !!f.disabled, onchange: (e) => { const raw = e.target.value; apply(f.num ? +raw : raw, false); renderInspector(); } },
        ...f.options.map(([val, text]) => h("option", { value: val, selected: String(val) === String(v) }, text))));
  }
  if (f.t === "check") {
    return h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!v, onchange: (e) => { apply(e.target.checked, false); renderInspector(); } }), h("span", {}, label));
  }
  if (f.t === "color") {
    return h("label", { class: "vfield inline-field" }, h("span", {}, label),
      h("input", { type: "color", value: v, oninput: (e) => apply(e.target.value, true), onchange: endLive }));
  }
  if (f.t === "text") {
    return h("label", { class: "vfield" }, h("span", {}, label),
      h("input", { type: "text", value: v, maxLength: 200, oninput: (e) => apply(e.target.value, true), onchange: endLive }));
  }
  if (f.t === "textarea") {
    return h("label", { class: "vfield" }, h("span", {}, label),
      h("textarea", { rows: 3, value: v, maxLength: LIMITS.textLength, oninput: (e) => apply(e.target.value, true), onchange: endLive }));
  }
  return null;
}

function section(title, fields, target, { open = true, key, onSet } = {}) {
  return h("details", { class: "group", open, dataset: { section: key || title } },
    h("summary", {}, title),
    ...fields.filter(Boolean).map((f) => field(target, f, onSet)));
}

const r = (label, path, min, max, extra = {}) => ({ t: "range", label, path, min, max, ...extra });
const opts = (list) => list.map((x) => (Array.isArray(x) ? x : [x, x]));

function clipSections(c, index) {
  const m = media(c.mediaId);
  const target = () => findTrack(project, c.id)?.item || c;
  const still = m.kind === "image";
  const tidy = (x) => {
    x.in = clamp(x.in, 0, mediaLength(m) - 0.05);
    x.out = clamp(x.out, x.in + 0.05, mediaLength(m));
  };
  const out = [];
  out.push(section("Clip", [
    { t: "note", text: `${m.name}${isOffline(m.id) ? " (offline)" : ""}` },
    still
      ? { t: "num", label: "Duration (s)", min: 0.1, get: (x) => x.out - x.in, set: (x, v) => (x.out = x.in + v) }
      : { t: "num", label: "In (s)", path: "in", min: 0 },
    still ? null : { t: "num", label: "Out (s)", path: "out", min: 0 },
    still ? null : { t: "select", label: "Speed", path: "speed", num: true, options: SPEEDS.map((s) => [s, `${s}×`]) },
  ], target, { onSet: tidy }));

  if (index > 0) {
    out.push(section("Transition in", [
      { t: "select", label: "Type", options: [["none", "None (cut)"], ...TRANSITIONS],
        get: (x) => x.transition?.type || "none",
        set: (x, v) => (x.transition = v === "none" ? null : { type: v, duration: x.transition?.duration || 1 }) },
      { t: "range", label: "Duration", min: 0.1, max: 3, step: 0.1, fmt: fmt.sec, disabled: !c.transition,
        get: (x) => x.transition?.duration ?? 1, set: (x, v) => x.transition && (x.transition.duration = v) },
      { t: "buttons", buttons: [["Apply to all cuts", () => {
        const tr = c.transition;
        commit("Apply transition to all", (p) => p.v1.forEach((x, i) => { if (i > 0) x.transition = tr ? { ...tr } : null; }));
      }, "Use this transition between every pair of clips"]] },
    ], target, { key: "transition" }));
  }

  if (!still) {
    out.push(section("Audio", [
      r("Volume", "volume", 0, 200, { fmt: fmt.pct, reset: 100 }),
      { t: "check", label: "Mute clip audio", path: "muted" },
      r("Fade in", "fadeIn", 0, 5, { step: 0.1, fmt: fmt.sec, reset: 0 }),
      r("Fade out", "fadeOut", 0, 5, { step: 0.1, fmt: fmt.sec, reset: 0 }),
    ], target, { open: false }));
  }

  const g = (label, key, min = -100, max = 100, extra = {}) => r(label, `grade.${key}`, min, max, { reset: defaultGrade()[key], ...extra });
  out.push(section("Color · Basic correction", [
    g("Exposure", "exposure", -300, 300, { fmt: fmt.ev }),
    g("Contrast", "contrast"), g("Highlights", "highlights"), g("Shadows", "shadows"),
    g("Whites", "whites"), g("Blacks", "blacks"),
    g("Temperature", "temperature"), g("Tint", "tint"),
    g("Saturation", "saturation"), g("Vibrance", "vibrance"),
  ], target));
  out.push(section("Color · Creative", [
    { t: "select", label: "Look", path: "grade.look", options: Object.entries(LOOKS).map(([k, v]) => [k, v.label]) },
    g("Look intensity", "lookAmount", 0, 100, { fmt: fmt.pct }),
    g("Faded film", "faded", 0, 100), g("Sharpen", "sharpen", 0, 100), g("Vignette", "vignette"),
  ], target, { open: false }));
  out.push(section("Color · Wheels", [
    { t: "color", label: "Shadows", path: "grade.shadowTint" }, g("Shadow tint", "shadowTintAmt", 0, 100),
    { t: "color", label: "Midtones", path: "grade.midTint" }, g("Midtone tint", "midTintAmt", 0, 100),
    { t: "color", label: "Highlights", path: "grade.highTint" }, g("Highlight tint", "highTintAmt", 0, 100),
  ], target, { open: false }));
  out.push(field(target, { t: "buttons", buttons: [
    ["Reset color", () => { commit("Reset color", () => (target().grade = defaultGrade())); }],
    ["Copy grade", () => { gradeClipboard = structuredClone(target().grade); status("Grade copied."); }],
    ["Paste grade", () => gradeClipboard ? commit("Paste grade", () => (target().grade = structuredClone(gradeClipboard))) : status("Copy a grade first.", true)],
    ["Paste to all", () => gradeClipboard ? commit("Paste grade to all", (p) => p.v1.forEach((x) => (x.grade = structuredClone(gradeClipboard)))) : status("Copy a grade first.", true)],
  ] }));

  const mo = (label, key, min, max, extra = {}) => r(label, `motion.${key}`, min, max, { reset: defaultMotion()[key], ...extra });
  out.push(section("Motion", [
    { t: "select", label: "Frame", path: "motion.fit", options: [["contain", "Fit (letterbox)"], ["cover", "Fill (crop)"]] },
    mo("Scale", "scale", 10, 400, { fmt: fmt.pct }), mo("Position X", "x", -100, 100), mo("Position Y", "y", -100, 100),
    mo("Rotation", "rotation", -180, 180, { fmt: fmt.deg }), mo("Opacity", "opacity", 0, 100, { fmt: fmt.pct }),
    { t: "check", label: "Animate to end values over the clip", path: "motion.animate" },
    c.motion.animate ? mo("End scale", "endScale", 10, 400, { fmt: fmt.pct }) : null,
    c.motion.animate ? mo("End X", "endX", -100, 100) : null,
    c.motion.animate ? mo("End Y", "endY", -100, 100) : null,
    c.motion.animate ? mo("End rotation", "endRotation", -180, 180, { fmt: fmt.deg }) : null,
    c.motion.animate ? mo("End opacity", "endOpacity", 0, 100, { fmt: fmt.pct }) : null,
    c.motion.animate ? { t: "select", label: "Easing", path: "motion.ease", options: EASES } : null,
    { t: "buttons", buttons: [
      ["Ken Burns", () => commit("Ken Burns", () => Object.assign(target().motion, { fit: "cover", animate: true, scale: 100, endScale: 120, x: -3, endX: 3, y: 2, endY: -2, ease: "ease_in_out" })), "Slow push-in with a gentle drift"],
      ["Reset motion", () => commit("Reset motion", () => (target().motion = defaultMotion()))],
    ] },
  ], target, { open: false }));
  return out;
}

function textSections(it) {
  const target = () => findTrack(project, it.id)?.item || it;
  return [
    section("Text", [
      { t: "textarea", label: "Text", path: "text" },
      { t: "select", label: "Font", path: "font", options: opts(FONTS) },
      r("Size", "size", 2, 30, { step: 0.5, fmt: (v) => `${(+v).toFixed(1)}%` }),
      { t: "color", label: "Color", path: "color" },
      { t: "check", label: "Bold", path: "bold" },
      { t: "check", label: "Italic", path: "italic" },
      { t: "select", label: "Align", path: "align", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]] },
      { t: "check", label: "Caption (included in SRT export)", path: "caption" },
    ], target),
    section("Box & effects", [
      { t: "check", label: "Background box", path: "bg" },
      it.bg ? { t: "color", label: "Box color", path: "bgColor" } : null,
      it.bg ? r("Box opacity", "bgOpacity", 0, 100, { fmt: fmt.pct }) : null,
      r("Outline", "outline", 0, 20),
      it.outline ? { t: "color", label: "Outline color", path: "outlineColor" } : null,
      { t: "check", label: "Drop shadow", path: "shadow" },
    ], target, { open: false }),
    section("Position", [
      r("X", "x", 0, 100, { fmt: fmt.pct, reset: 50 }), r("Y", "y", 0, 100, { fmt: fmt.pct, reset: 50 }),
      r("Scale", "scale", 10, 400, { fmt: fmt.pct, reset: 100 }), r("Rotation", "rotation", -180, 180, { fmt: fmt.deg, reset: 0 }),
      r("Opacity", "opacity", 0, 100, { fmt: fmt.pct, reset: 100 }),
      { t: "buttons", buttons: [
        ["Centered", () => commit("Centered title", () => Object.assign(target(), { x: 50, y: 50, align: "center", bg: false }))],
        ["Lower third", () => commit("Lower third", () => Object.assign(target(), { x: 8, y: 80, align: "left", size: 5, bg: true, bgOpacity: 70, animIn: "slide_left", animOut: "fade" })), "Name strap in the lower-left"],
        ["Caption", () => commit("Caption style", () => Object.assign(target(), { x: 50, y: 86, align: "center", size: 5, bold: false, bg: true, bgOpacity: 55, shadow: false, caption: true }))],
      ] },
    ], target),
    timingSection(target),
  ];
}

function timingSection(target, anim = true) {
  return section("Timing", [
    { t: "num", label: "Start (s)", path: "start", min: 0 },
    { t: "num", label: "Duration (s)", path: "duration", min: 0.1 },
    anim ? { t: "select", label: "Animate in", path: "animIn", options: ANIMS } : null,
    anim ? { t: "select", label: "Animate out", path: "animOut", options: ANIMS } : null,
    anim ? r("Animation length", "animDur", 0.1, 2, { step: 0.1, fmt: fmt.sec }) : null,
  ], target);
}

function renderInspector() {
  const box = $("v-inspector");
  // Keep the inspector's scroll position across rebuilds.
  const scrollTop = box.parentElement.scrollTop;
  const openState = new Map([...box.querySelectorAll("details")].map((d) => [d.dataset.section, d.open]));
  box.replaceChildren();
  const hit = selected && findTrack(project, selected);
  let title = "Sequence";
  if (!hit) {
    const s = project.settings;
    const { w, h: hh } = outputSize(s);
    const target = () => project.settings;
    box.append(
      section("Sequence settings", [
        { t: "select", label: "Aspect ratio", path: "aspect", options: Object.keys(ASPECTS).map((a) => [a, { "16:9": "16:9 Widescreen", "9:16": "9:16 Vertical", "1:1": "1:1 Square", "4:5": "4:5 Portrait", "4:3": "4:3 Classic", "21:9": "21:9 Cinema" }[a]]) },
        { t: "select", label: "Resolution", path: "height", num: true, options: RESOLUTIONS.map((r) => [r, `${r}p`]) },
        { t: "select", label: "Frame rate", path: "fps", num: true, options: FRAME_RATES.map((f) => [f, `${f} fps`]) },
        { t: "color", label: "Background", path: "background" },
        r("Master volume", "masterVolume", 0, 200, { fmt: fmt.pct, reset: 100 }),
        { t: "note", text: `Output ${w} × ${hh} · ${project.v1.length} clips · ${project.v2.length} titles & graphics · ${project.a2.length} audio · ${timecode(engine.duration(), s.fps)}` },
        { t: "buttons", buttons: [["New sequence", () => {
          if (!project.media.length || confirm("Start a new, empty sequence? Unsaved work in this one will be lost.")) {
            engine.reset(); project = newProject(); history.clear(); selected = null; changed();
          }
        }]] },
      ], target),
    );
    box.append(h("p", { class: "note" }, "Select a clip, title or audio item to edit it. Double-click a slider to reset it."));
  } else {
    const it = hit.item;
    if (hit.track === "v1") { title = "Video clip"; box.append(...clipSections(it, hit.index)); }
    else if (hit.track === "v2" && it.kind === "text") { title = it.caption ? "Caption" : "Title"; box.append(...textSections(it)); }
    else if (hit.track === "v2") {
      title = "Graphic";
      const target = () => findTrack(project, it.id)?.item || it;
      box.append(section("Position", [
        r("X", "x", 0, 100, { fmt: fmt.pct, reset: 50 }), r("Y", "y", 0, 100, { fmt: fmt.pct, reset: 50 }),
        r("Scale", "scale", 5, 200, { fmt: fmt.pct, reset: 40 }), r("Rotation", "rotation", -180, 180, { fmt: fmt.deg, reset: 0 }),
        r("Opacity", "opacity", 0, 100, { fmt: fmt.pct, reset: 100 }),
      ], target), timingSection(target));
    } else if (hit.track === "a2") {
      title = "Audio";
      const target = () => findTrack(project, it.id)?.item || it;
      const m = media(it.mediaId);
      box.append(section("Audio clip", [
        { t: "note", text: m?.name || "" },
        { t: "num", label: "Start (s)", path: "start", min: 0 },
        { t: "num", label: "In (s)", path: "in", min: 0 },
        { t: "num", label: "Out (s)", path: "out", min: 0 },
        r("Volume", "volume", 0, 200, { fmt: fmt.pct, reset: 100 }),
        r("Fade in", "fadeIn", 0, 10, { step: 0.1, fmt: fmt.sec, reset: 0 }),
        r("Fade out", "fadeOut", 0, 10, { step: 0.1, fmt: fmt.sec, reset: 0 }),
      ], target, { onSet: (x) => { x.in = clamp(x.in, 0, mediaLength(m) - 0.1); x.out = clamp(x.out, x.in + 0.1, mediaLength(m)); } }));
    } else if (hit.track === "markers") {
      title = "Marker";
      const target = () => findTrack(project, it.id)?.item || it;
      box.append(section("Marker", [
        { t: "text", label: "Name", path: "label" },
        { t: "num", label: "Time (s)", path: "time", min: 0 },
        { t: "color", label: "Color", path: "color" },
        { t: "buttons", buttons: [["Delete marker", () => commit("Delete marker", (p) => remove(p, it.id))]] },
      ], target));
    }
    box.append(field(() => it, { t: "buttons", buttons: [
      ...(hit.track !== "markers" ? [["Delete", () => deleteSelected(), "Delete (ripple on V1)"]] : []),
      ...(hit.track === "v1" || hit.track === "v2" ? [["Duplicate", () => duplicateSelected()]] : []),
    ] }));
  }
  for (const d of box.querySelectorAll("details")) if (openState.has(d.dataset.section)) d.open = openState.get(d.dataset.section);
  $("v-insp-title").textContent = title;
  box.parentElement.scrollTop = scrollTop;
}

// --- commands --------------------------------------------------------------

function deleteSelected() {
  if (!selected) return;
  const hit = findTrack(project, selected);
  if (!hit) return;
  commit(hit.track === "v1" ? "Ripple delete" : "Delete", (p) => remove(p, selected));
}

function duplicateSelected() {
  const hit = selected && findTrack(project, selected);
  if (!hit || !canAdd(project)) return;
  const copy = structuredClone(hit.item);
  copy.id = uid(hit.track === "v1" ? "c" : copy.kind === "text" ? "t" : "g");
  commit("Duplicate", (p) => {
    if (hit.track === "v1") { copy.transition = null; p.v1.splice(hit.index + 1, 0, copy); }
    else { copy.start = itemEnd(hit.item); p[hit.track].push(copy); }
  });
  select(copy.id);
}

function splitAtPlayhead() {
  const t = engine.t;
  const lay = layoutV1(project.v1);
  let id = selected;
  const hit = id && findTrack(project, id);
  const under = (x) => x && x.track !== "markers" && (x.track === "v1"
    ? (() => { const e = lay[x.index]; return t > e.start && t < e.end; })()
    : t > x.item.start && t < itemEnd(x.item));
  if (!under(hit)) id = lay.find((e) => t > e.start && t < e.end)?.clip.id;
  if (!id) return status("Nothing under the playhead to split.", true);
  history.push(project, "Split");
  if (!split(project, id, t)) { history.undo.pop(); return status("Can't split there: too close to an edge or inside a transition.", true); }
  changed();
}

function addTitle() {
  if (!canAdd(project)) return status(`A sequence holds up to ${LIMITS.timelineItems} items.`, true);
  const it = textItem(engine.t);
  commit("Add title", (p) => p.v2.push(it));
  select(it.id);
  $("v-inspector").querySelector("textarea")?.select();
}

function addMarker() {
  if (project.markers.length >= LIMITS.markers) return status(`Up to ${LIMITS.markers} markers.`, true);
  const mk = marker(engine.t, `Marker ${project.markers.length + 1}`);
  commit("Add marker", (p) => p.markers.push(mk));
}

function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll("[data-vtool]")) b.setAttribute("aria-pressed", String(b.dataset.vtool === t));
  content().classList.toggle("razor", t === "razor");
}

/** Every cut point on the timeline, for jumping between edits. */
function editPoints() {
  const pts = new Set([0]);
  for (const e of layoutV1(project.v1)) { pts.add(e.start); pts.add(e.end); }
  for (const i of [...project.v2, ...project.a2]) { pts.add(i.start); pts.add(itemEnd(i)); }
  for (const m of project.markers) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}

// --- files -----------------------------------------------------------------

async function putFile(blob, name, description, accept) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
    }
  }
  const url = URL.createObjectURL(blob);
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

async function openProject(file) {
  if (file.size > LIMITS.projectBytes) return status(`Project files are limited to ${fmtBytes(LIMITS.projectBytes)}; this one is ${fmtBytes(file.size)}.`, true);
  let next;
  try { next = sanitize(JSON.parse(await file.text())); }
  catch (e) { return status(e instanceof SyntaxError ? "That project file is damaged (invalid JSON)." : e.message, true); }
  engine.pause();
  engine.reset();
  project = next;
  history.clear();
  selected = null;
  changed();
  fitTimeline();
  const n = project.media.length;
  status(n ? `Opened ${file.name}. Relink its ${n} media file${n > 1 ? "s" : ""} to bring them online.` : `Opened ${file.name}.`);
}

// --- export ----------------------------------------------------------------

const FORMATS = [
  ["video/mp4;codecs=avc1.640028,mp4a.40.2", "MP4 · H.264 + AAC", "mp4"],
  ["video/mp4", "MP4", "mp4"],
  ["video/webm;codecs=vp9,opus", "WebM · VP9 + Opus", "webm"],
  ["video/webm;codecs=vp8,opus", "WebM · VP8 + Opus", "webm"],
  ["video/webm", "WebM", "webm"],
  ["audio/webm;codecs=opus", "Audio only · Opus", "weba", true],
];
const QUALITY = [["0.05", "Draft"], ["0.1", "Standard"], ["0.18", "High"], ["0.3", "Maximum"]];

function openExport() {
  if (!engine.duration()) return status("Add something to the timeline first.", true);
  const sel = $("vx-format");
  const supported = FORMATS.filter(([m]) => window.MediaRecorder?.isTypeSupported(m));
  if (!supported.length) return status("This browser can't record video. Use a current Chrome, Edge, Firefox or Safari.", true);
  sel.replaceChildren(...supported.map(([m, label]) => h("option", { value: m }, label)));
  $("vx-quality").replaceChildren(...QUALITY.map(([v, l]) => h("option", { value: v, selected: v === "0.18" }, l)));
  syncExport();
  $("vexport-dialog").showModal();
}

function syncExport() {
  const s = project.settings, { w, h: hh } = outputSize(s);
  const dur = engine.duration();
  const audioOnly = FORMATS.find((f) => f[0] === $("vx-format").value)?.[3];
  const bps = Math.round(w * hh * s.fps * +$("vx-quality").value);
  const est = ((audioOnly ? 192000 : bps + 192000) / 8) * dur;
  const over = dur > LIMITS.exportSeconds;
  $("vx-info").replaceChildren(
    ...[["Output", audioOnly ? "Audio only" : `${w} × ${hh} · ${s.fps} fps`],
      ["Length", timecode(dur, s.fps)],
      ["Bitrate", audioOnly ? "192 kbps" : `${(bps / 1e6).toFixed(1)} Mbps`],
      ["Estimated size", fmtBytes(est)]].map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))));
  $("vx-warn").textContent = over
    ? `Exports are limited to ${LIMITS.exportSeconds / 60} minutes. Shorten the sequence to export it.`
    : "Export plays the sequence in real time. Keep this tab visible until it finishes.";
  $("vx-warn").classList.toggle("bad", over);
  $("vx-go").disabled = over;
}

async function runExport() {
  const mime = $("vx-format").value;
  const fmtRow = FORMATS.find((f) => f[0] === mime);
  const s = project.settings, { w, h: hh } = outputSize(s);
  $("vexport-dialog").close();
  $("v-cancel").hidden = false;
  document.body.classList.add("v-exporting");
  try {
    const blob = await engine.record({
      mimeType: mime, audioOnly: !!fmtRow[3],
      videoBitsPerSecond: Math.round(w * hh * s.fps * +$("vx-quality").value),
      onProgress: (k) => status(`Exporting ${Math.round(k * 100)}% · keep this tab visible`),
    });
    const name = `sequence-${new Date().toISOString().slice(0, 10)}.${fmtRow[2]}`;
    const ok = await putFile(blob, name, fmtRow[1], { [mime.split(";")[0]]: [`.${fmtRow[2]}`] });
    status(ok ? `Exported ${name} · ${fmtBytes(blob.size)}` : "Export finished but was not saved.");
  } catch (e) {
    status(e.message || "Export failed.", true);
  } finally {
    $("v-cancel").hidden = true;
    document.body.classList.remove("v-exporting");
  }
}

// --- scopes & meter --------------------------------------------------------

let scopeFrame = 0;
const sample = document.createElement("canvas");
function drawScope() {
  const canvas = $("v-canvas");
  const sc = $("v-scope"), ctx = sc.getContext("2d");
  const SW = 128, SH = 72;
  sample.width = SW; sample.height = SH;
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, SW, SH);
  const px = sctx.getImageData(0, 0, SW, SH).data;
  const W = sc.width, H = sc.height;
  const img = ctx.createImageData(W, H);
  const acc = new Uint16Array(W * H);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      const sx = Math.floor((x / SW) * W), sy = Math.round((1 - l) * (H - 1));
      for (let k = 0; k < 2; k++) acc[sy * W + Math.min(W - 1, sx + k)]++;
    }
  }
  for (let i = 0; i < acc.length; i++) {
    const v = Math.min(255, acc[i] * 60);
    img.data[i * 4] = v * 0.55; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.65; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  for (const l of [0, 0.25, 0.5, 0.75, 1]) ctx.fillRect(0, Math.round((1 - l) * (H - 1)), W, 1);
}

function onTick(t, playing) {
  $("v-tc").textContent = timecode(t, project.settings.fps);
  $("v-dur").textContent = `/ ${timecode(engine.duration(), project.settings.fps)}`;
  $("v-play").textContent = playing ? "Pause" : "Play";
  movePlayhead(t);
  const db = engine.level();
  const m = $("v-meter");
  m.style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
  m.classList.toggle("hot", db > -3);
  if (!playing || ++scopeFrame % 6 === 0) {
    if ($("v-scope").closest("details").open) drawScope();
  }
}

// --- wiring ----------------------------------------------------------------

function bind() {
  $("v-import").onclick = () => $("file-video").click();
  $("file-video").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; importMedia(f); };
  $("v-relink").onclick = () => $("file-relink").click();
  $("file-relink").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; relink(f); };
  $("v-open").onclick = () => $("file-vproject").click();
  $("file-vproject").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openProject(f); };
  $("v-save").onclick = async () => {
    const ok = await putFile(new Blob([serialize(project)], { type: "application/json" }), "sequence.drvideo.json", "Darkroom video project", { "application/json": [".json"] });
    if (ok) status("Project saved. It references your media by name; keep the files to relink them later.");
  };
  $("v-srt-in").onclick = () => $("file-srt").click();
  $("file-srt").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > LIMITS.srtBytes) return status(`Caption files are limited to ${fmtBytes(LIMITS.srtBytes)}.`, true);
    try {
      const cues = parseSRT(await f.text());
      if (!canAdd(project, cues.length)) return status(`That would exceed ${LIMITS.timelineItems} timeline items.`, true);
      commit("Import captions", (p) => cues.forEach((c) => p.v2.push(captionItem(c.start, c.end, c.text))));
      status(`Imported ${cues.length} captions onto V2.`);
    } catch (err) { status(err.message, true); }
  };
  $("v-srt-out").onclick = async () => {
    const texts = project.v2.filter((x) => x.kind === "text");
    const caps = texts.filter((x) => x.caption);
    const list = caps.length ? caps : texts;
    if (!list.length) return status("There are no titles or captions to export.", true);
    await putFile(new Blob([formatSRT(list)], { type: "text/plain" }), "captions.srt", "SubRip captions", { "text/plain": [".srt"] });
  };

  $("v-play").onclick = () => engine.toggle();
  $("v-start").onclick = () => engine.seek(0);
  $("v-end").onclick = () => engine.seek(engine.duration());
  $("v-back").onclick = () => { engine.pause(); engine.seek(engine.t - 1 / project.settings.fps); };
  $("v-fwd").onclick = () => { engine.pause(); engine.seek(engine.t + 1 / project.settings.fps); };
  $("v-loop").onchange = (e) => (engine.loop = e.target.checked);
  $("v-still").onclick = async () => {
    const blob = await engine.still();
    await putFile(blob, `frame-${timecode(engine.t, project.settings.fps).replace(/:/g, "-")}.png`, "PNG image", { "image/png": [".png"] });
  };
  $("v-export").onclick = openExport;
  $("vx-format").onchange = syncExport;
  $("vx-quality").onchange = syncExport;
  $("vx-cancel").onclick = () => $("vexport-dialog").close();
  $("vx-go").onclick = runExport;
  $("v-cancel").onclick = () => engine.cancelExport();

  for (const b of document.querySelectorAll("[data-vtool]")) b.onclick = () => setTool(b.dataset.vtool);
  $("v-split").onclick = splitAtPlayhead;
  $("v-delete").onclick = deleteSelected;
  $("v-title").onclick = addTitle;
  $("v-marker").onclick = addMarker;
  $("v-snap").onclick = () => { snapping = !snapping; $("v-snap").setAttribute("aria-pressed", String(snapping)); };
  $("v-undo").onclick = undo;
  $("v-redo").onclick = redo;
  $("v-zoom").oninput = (e) => setZoom(+e.target.value);
  $("v-fit").onclick = fitTimeline;

  document.addEventListener("keydown", (e) => {
    if ($("video-workspace").hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector("dialog[open]")) return;
    const k = e.key.toLowerCase();
    const fps = project.settings.fps;
    if (e.ctrlKey || e.metaKey) {
      if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === "y") { e.preventDefault(); redo(); }
      else if (k === "k") { e.preventDefault(); splitAtPlayhead(); }
      else if (k === "s") { e.preventDefault(); $("v-save").click(); }
      else if (k === "o") { e.preventDefault(); $("v-open").click(); }
      else if (k === "m") { e.preventDefault(); openExport(); }
      else if (k === "d") { e.preventDefault(); duplicateSelected(); }
      return;
    }
    const pts = () => editPoints();
    const map = {
      " ": () => engine.toggle(),
      k: () => engine.pause(),
      l: () => engine.play(),
      j: () => { engine.pause(); engine.seek(engine.t - 1); },
      arrowleft: () => { engine.pause(); engine.seek(engine.t - (e.shiftKey ? 1 : 1 / fps)); },
      arrowright: () => { engine.pause(); engine.seek(engine.t + (e.shiftKey ? 1 : 1 / fps)); },
      arrowup: () => { const p = pts().filter((x) => x < engine.t - 1e-3).pop(); if (p !== undefined) engine.seek(p); },
      arrowdown: () => { const p = pts().find((x) => x > engine.t + 1e-3); if (p !== undefined) engine.seek(p); },
      home: () => engine.seek(0),
      end: () => engine.seek(engine.duration()),
      c: () => setTool("razor"),
      v: () => setTool("select"),
      s: () => $("v-snap").click(),
      m: addMarker,
      t: addTitle,
      delete: deleteSelected,
      backspace: deleteSelected,
      escape: () => { setTool("select"); select(null); },
      "=": () => setZoom(clamp(zoomValue() + 8, 0, 100)),
      "+": () => setZoom(clamp(zoomValue() + 8, 0, 100)),
      "-": () => setZoom(clamp(zoomValue() - 8, 0, 100)),
      "\\": fitTimeline,
    };
    const fn = map[k];
    if (fn) { e.preventDefault(); fn(); }
  });

  // A hidden tab stops painting frames, which would freeze the recording.
  document.addEventListener("visibilitychange", () => { if (document.hidden && engine.exporting) engine.cancelExport(); });
  window.addEventListener("pagehide", () => { engine.cancelExport(); engine.reset(); });
  window.addEventListener("resize", () => { if (!$("video-workspace").hidden) renderTimeline(); });
  bindTimeline();
}

export function isExporting() { return !!engine?.exporting; }

export function pauseVideo() { engine?.pause(); }

/** Builds the engine on first visit, so image-only sessions never create a
 *  WebGL context or decoders for video. */
export function startVideo() {
  if (started) { renderTimeline(); engine.requestRender(); return; }
  started = true;
  try {
    engine = new Engine($("v-canvas"), { getProject: () => project, onTick });
  } catch (e) {
    status(e.message, true);
    $("v-import").disabled = true;
    return;
  }
  $("v-limits").textContent = `Video up to ${fmtBytes(LIMITS.videoBytes)}, audio ${fmtBytes(LIMITS.audioBytes)}, images ${fmtBytes(LIMITS.imageBytes)}. ${LIMITS.mediaItems} files, ${LIMITS.timelineItems} timeline items, exports up to ${LIMITS.exportSeconds / 60} minutes.`;
  bind();
  setZoom(zoomValue());
  changed();
}
