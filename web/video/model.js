// The video project: plain data, no DOM. Everything the editor can do to a
// sequence is a function in here, which keeps the UI thin and lets the rules
// be tested in Node without a browser.
//
// Times are seconds (floats). Clip `in`/`out` are positions in the *source*
// media; where a clip sits on the timeline is derived, never stored, for the
// main track (V1), which is magnetic like Premiere's ripple editing: clips
// butt up against each other and a transition overlaps its two neighbours.

export const LIMITS = {
  videoBytes: 8 * 1024 ** 3,     // streamed from disk, so this can be large
  audioBytes: 1024 ** 3,
  imageBytes: 50 * 1024 ** 2,
  imageEdge: 16384,
  imagePixels: 64e6,
  mediaItems: 64,
  timelineItems: 500,
  markers: 200,
  projectBytes: 5 * 1024 ** 2,   // project files are JSON instructions only
  srtBytes: 2 * 1024 ** 2,
  waveformBytes: 40 * 1024 ** 2, // audio decoded in full only below this
  exportSeconds: 20 * 60,        // recorded output accumulates in memory
  textLength: 2000,
  sequenceSeconds: 4 * 3600,
};

export const ASPECTS = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5, "4:3": 4 / 3, "21:9": 21 / 9 };
export const RESOLUTIONS = [480, 720, 1080];
export const FRAME_RATES = [24, 25, 30, 60];
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

// Order matters: the index is the transition id the shader switches on.
export const TRANSITIONS = [
  ["dissolve", "Cross dissolve"], ["dip_black", "Dip to black"], ["dip_white", "Dip to white"],
  ["wipe_left", "Wipe left"], ["wipe_right", "Wipe right"], ["wipe_up", "Wipe up"], ["wipe_down", "Wipe down"],
  ["push_left", "Push left"], ["push_right", "Push right"], ["slide_left", "Slide in"],
  ["iris", "Iris round"], ["zoom", "Cross zoom"], ["clock", "Clock wipe"], ["film", "Film dissolve"],
];
export const TRANSITION_IDS = TRANSITIONS.map((t) => t[0]);

export const ANIMS = [["none", "None"], ["fade", "Fade"], ["slide_up", "Slide up"], ["slide_left", "Slide from right"], ["pop", "Pop"], ["typewriter", "Typewriter"]];
export const EASES = [["linear", "Linear"], ["ease_in", "Ease in"], ["ease_out", "Ease out"], ["ease_in_out", "Ease in & out"]];
export const FONTS = ["Instrument Sans", "Bricolage Grotesque", "IBM Plex Mono", "Georgia", "Arial", "Impact", "Times New Roman", "Courier New", "Trebuchet MS"];

// Creative looks are offsets on top of the clip's own grade, scaled by the
// look intensity, the way Lumetri layers a look over basic correction.
export const LOOKS = {
  none: { label: "None", d: {} },
  teal_orange: { label: "Teal & orange", d: { contrast: 15, saturation: 10, shadowTint: "#1f8fb0", shadowTintAmt: 40, highTint: "#ffa040", highTintAmt: 35 } },
  faded: { label: "Faded film", d: { faded: 45, contrast: -10, saturation: -20, highTint: "#ffe0b0", highTintAmt: 20 } },
  bw: { label: "Black & white", d: { saturation: -100, contrast: 10 } },
  noir: { label: "Noir", d: { saturation: -100, contrast: 45, blacks: -25, vignette: -45 } },
  warm_vintage: { label: "Warm vintage", d: { temperature: 35, faded: 25, saturation: -10, midTint: "#c08040", midTintAmt: 25, vignette: -25 } },
  cool: { label: "Cool blue", d: { temperature: -40, tint: 5, contrast: 8 } },
  bleach: { label: "Bleach bypass", d: { saturation: -55, contrast: 35, highlights: 10 } },
  vivid: { label: "Vivid", d: { vibrance: 40, contrast: 12, saturation: 12 } },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
let counter = 0;
export const uid = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// --- defaults --------------------------------------------------------------
// UI units throughout: percentages and degrees as integers, seconds as floats.
// gradeUniforms() and motionAt() turn them into renderer values.

export const defaultGrade = () => ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0,
  look: "none", lookAmount: 100, faded: 0, sharpen: 0, vignette: 0,
  shadowTint: "#1f8fb0", shadowTintAmt: 0,
  midTint: "#c08040", midTintAmt: 0,
  highTint: "#ffa040", highTintAmt: 0,
});

export const defaultMotion = () => ({
  fit: "contain", scale: 100, x: 0, y: 0, rotation: 0, opacity: 100,
  animate: false, ease: "ease_in_out",
  endScale: 115, endX: 0, endY: 0, endRotation: 0, endOpacity: 100,
});

export const newProject = () => ({
  format: "darkroom-video",
  version: 1,
  settings: { aspect: "16:9", height: 1080, fps: 30, background: "#000000", masterVolume: 100 },
  media: [],
  v1: [],
  v2: [],
  a2: [],
  markers: [],
});

/** Image clips have no natural length; this is what one gets on the timeline. */
export const STILL_SECONDS = 5;
const STILL_MAX = 3600;

export function mediaLength(m) {
  return m.kind === "image" ? STILL_MAX : Math.max(0.05, m.duration || 0);
}

export function videoClip(media) {
  return {
    id: uid("c"), mediaId: media.id,
    in: 0, out: media.kind === "image" ? STILL_SECONDS : mediaLength(media),
    speed: 1, volume: 100, muted: false, fadeIn: 0, fadeOut: 0,
    transition: null,
    grade: defaultGrade(), motion: defaultMotion(),
  };
}

export function textItem(start) {
  return {
    id: uid("t"), kind: "text", start, duration: 4,
    text: "Your title", font: "Bricolage Grotesque", size: 8, color: "#ffffff",
    bold: true, italic: false, align: "center", x: 50, y: 50,
    bg: false, bgColor: "#000000", bgOpacity: 60,
    outline: 0, outlineColor: "#000000", shadow: true,
    animIn: "fade", animOut: "fade", animDur: 0.5,
    scale: 100, rotation: 0, opacity: 100,
    caption: false,
  };
}

/** Captions are text items with a subtitle style and the caption flag set. */
export function captionItem(start, end, text) {
  return {
    ...textItem(start), duration: Math.max(0.1, end - start), text,
    font: "Instrument Sans", size: 5, bold: false, y: 86,
    bg: true, bgOpacity: 55, shadow: false, animIn: "none", animOut: "none", caption: true,
  };
}

export function imageOverlay(media, start) {
  return {
    id: uid("g"), kind: "image", mediaId: media.id, start, duration: STILL_SECONDS,
    x: 50, y: 50, scale: 40, rotation: 0, opacity: 100,
    animIn: "fade", animOut: "fade", animDur: 0.5,
  };
}

export function audioItem(media, start) {
  return { id: uid("a"), mediaId: media.id, start, in: 0, out: mediaLength(media), volume: 100, fadeIn: 0, fadeOut: 0 };
}

export const marker = (time, label = "") => ({ id: uid("m"), time, label, color: "#e0a032" });

// --- timeline maths --------------------------------------------------------

export const clipLen = (c) => Math.max(0.05, (c.out - c.in) / (c.speed || 1));
export const itemLen = (i) => (i.kind ? i.duration : Math.max(0.05, i.out - i.in));
export const itemEnd = (i) => i.start + itemLen(i);

/** Where each V1 clip lands. A transition into clip i overlaps it with clip
 *  i-1 by its duration, clamped so it can never eat more than half of either
 *  neighbour; that keeps every clip at least partly on screen on its own. */
export function layoutV1(v1) {
  const out = [];
  let t = 0;
  for (let i = 0; i < v1.length; i++) {
    const c = v1[i];
    const len = clipLen(c);
    let tr = 0;
    if (i > 0 && c.transition) {
      tr = Math.min(c.transition.duration, len / 2, out[i - 1].len / 2);
    }
    const start = t - tr;
    out.push({ clip: c, index: i, start, end: start + len, len, tr });
    t = start + len;
  }
  return out;
}

export function sequenceDuration(p) {
  const lay = layoutV1(p.v1);
  let end = lay.length ? lay[lay.length - 1].end : 0;
  for (const i of p.v2) end = Math.max(end, itemEnd(i));
  for (const i of p.a2) end = Math.max(end, itemEnd(i));
  return end;
}

/** Source position of a V1 clip at sequence time `t`. */
export const sourceTime = (entry, t) => entry.clip.in + (t - entry.start) * entry.clip.speed;

/** The V1 clips visible at `t`: one, or two during a transition. */
export function activeV1(layout, t) {
  return layout.filter((e) => t >= e.start && t < e.end);
}

/** Transition progress 0..1 into `entry` at `t`, or null outside it. */
export function transitionProgress(entry, t) {
  if (!entry.tr || t < entry.start || t >= entry.start + entry.tr) return null;
  return (t - entry.start) / entry.tr;
}

/** Linear fade envelope for audio or opacity, 0..1. */
export function fadeGain(local, len, fadeIn, fadeOut) {
  let g = 1;
  if (fadeIn > 0 && local < fadeIn) g = Math.min(g, local / fadeIn);
  if (fadeOut > 0 && local > len - fadeOut) g = Math.min(g, (len - local) / fadeOut);
  return clamp(g, 0, 1);
}

export function ease(k, kind) {
  k = clamp(k, 0, 1);
  switch (kind) {
    case "ease_in": return k * k * k;
    case "ease_out": return 1 - (1 - k) ** 3;
    case "ease_in_out": return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    default: return k;
  }
}

/** Motion at a point through a clip, interpolating start → end values when
 *  the clip is animated (a two-keyframe move: Ken Burns, push-ins, drifts). */
export function motionAt(m, local, len) {
  const k = m.animate ? ease(len > 0 ? local / len : 0, m.ease) : 0;
  const lerp = (a, b) => a + (b - a) * k;
  return {
    fit: m.fit,
    scale: lerp(m.scale, m.endScale) / 100,
    x: lerp(m.x, m.endX) / 100,
    y: lerp(m.y, m.endY) / 100,
    rotation: lerp(m.rotation, m.endRotation),
    opacity: clamp(lerp(m.opacity, m.endOpacity) / 100, 0, 1),
  };
}

/** Entrance and exit animation state for a text or graphic item. */
export function animState(item, local) {
  const d = Math.max(0.05, Math.min(item.animDur, item.duration / 2));
  const st = { opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };
  const apply = (kind, k) => {
    // k runs 0 → 1 as the item becomes fully present.
    const e = ease(k, "ease_out");
    switch (kind) {
      case "fade": st.opacity *= e; break;
      case "slide_up": st.opacity *= e; st.dy += (1 - e) * 0.08; break;
      case "slide_left": st.opacity *= e; st.dx += (1 - e) * 0.12; break;
      case "pop": {
        st.opacity *= Math.min(1, k * 2);
        const c = 1.70158;
        st.scale *= 0.6 + 0.4 * (1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2);
        break;
      }
      case "typewriter": st.reveal = Math.min(st.reveal, k); break;
    }
  };
  if (local < d) apply(item.animIn, local / d);
  if (local > item.duration - d) apply(item.animOut, (item.duration - local) / d);
  return st;
}

/** Plain renderer values for a grade, with the creative look folded in. */
export function gradeUniforms(g) {
  const look = (LOOKS[g.look] || LOOKS.none).d;
  const amt = clamp(g.lookAmount, 0, 100) / 100;
  const v = (k) => (g[k] || 0) + (look[k] || 0) * amt;
  const chroma = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return c.map((x) => x - l);
  };
  const zone = (k) => {
    const own = chroma(g[k]).map((x) => x * (g[k + "Amt"] / 100));
    if (look[k]) {
      const add = chroma(look[k]).map((x) => x * ((look[k + "Amt"] || 0) / 100) * amt);
      return own.map((x, i) => x + add[i]);
    }
    return own;
  };
  return {
    exposure: v("exposure") / 100,         // stops
    contrast: clamp(v("contrast") / 100, -1, 1),
    highlights: clamp(v("highlights") / 100, -1, 1),
    shadows: clamp(v("shadows") / 100, -1, 1),
    whites: clamp(v("whites") / 100, -1, 1),
    blacks: clamp(v("blacks") / 100, -1, 1),
    temperature: clamp(v("temperature") / 100, -1, 1),
    tint: clamp(v("tint") / 100, -1, 1),
    saturation: clamp(1 + v("saturation") / 100, 0, 2),
    vibrance: clamp(v("vibrance") / 100, -1, 1),
    faded: clamp(v("faded") / 100, 0, 1),
    sharpen: clamp(v("sharpen") / 100, 0, 1),
    vignette: clamp(v("vignette") / 100, -1, 1),
    tintS: zone("shadowTint"), tintM: zone("midTint"), tintH: zone("highTint"),
  };
}

// --- edits -----------------------------------------------------------------
// These mutate the project in place. The caller records history first.

const findTrack = (p, id) => {
  for (const k of ["v1", "v2", "a2"]) {
    const i = p[k].findIndex((x) => x.id === id);
    if (i >= 0) return { track: k, index: i, item: p[k][i] };
  }
  const m = p.markers.findIndex((x) => x.id === id);
  if (m >= 0) return { track: "markers", index: m, item: p.markers[m] };
  return null;
};
export { findTrack };

export function itemCount(p) {
  return p.v1.length + p.v2.length + p.a2.length;
}

export function canAdd(p, n = 1) {
  return itemCount(p) + n <= LIMITS.timelineItems;
}

/** V1 index a clip dropped at time `t` should take: before the first clip
 *  whose midpoint is past `t`. */
export function v1IndexAt(p, t) {
  const lay = layoutV1(p.v1);
  const i = lay.findIndex((e) => t < (e.start + e.end) / 2);
  return i < 0 ? lay.length : i;
}

/** Splits whatever is under `t` on the given track. Returns the new item. */
export function split(p, id, t) {
  const hit = findTrack(p, id);
  if (!hit || hit.track === "markers") return null;
  const { track, index, item } = hit;
  const MIN = 0.05;
  if (track === "v1") {
    const e = layoutV1(p.v1)[index];
    // Cutting inside a transition would leave half a transition behind.
    if (t <= e.start + e.tr + MIN || t >= e.end - MIN) return null;
    const at = sourceTime(e, t);
    const b = structuredClone(item);
    b.id = uid("c");
    b.in = at;
    b.transition = null;
    b.fadeIn = 0;
    item.out = at;
    item.fadeOut = 0;
    p.v1.splice(index + 1, 0, b);
    return b;
  }
  if (t <= item.start + MIN || t >= itemEnd(item) - MIN) return null;
  const b = structuredClone(item);
  b.id = uid(track === "a2" ? "a" : item.kind === "text" ? "t" : "g");
  const cut = t - item.start;
  if (track === "a2") {
    item.out = item.in + cut;
    b.start = t;
    b.in = item.out;
  } else {
    b.start = t;
    b.duration = item.duration - cut;
    item.duration = cut;
  }
  p[track].splice(index + 1, 0, b);
  return b;
}

/** Deletes an item. On V1 the gap closes (ripple delete); elsewhere it stays. */
export function remove(p, id) {
  const hit = findTrack(p, id);
  if (!hit) return false;
  p[hit.track].splice(hit.index, 1);
  // A transition needs a clip before it.
  if (hit.track === "v1" && hit.index === 0 && p.v1[0]) p.v1[0].transition = null;
  return true;
}

export function moveV1(p, id, toIndex) {
  const from = p.v1.findIndex((c) => c.id === id);
  if (from < 0) return;
  const [c] = p.v1.splice(from, 1);
  const to = clamp(from < toIndex ? toIndex - 1 : toIndex, 0, p.v1.length);
  p.v1.splice(to, 0, c);
  if (p.v1[0]) p.v1[0].transition = null;
}

/** Ripple trim on V1: moves the clip's in or out point in source time.
 *  `delta` is in timeline seconds, so speed is accounted for here. */
export function trimV1(p, id, edge, delta, media) {
  const c = p.v1.find((x) => x.id === id);
  if (!c) return;
  const max = mediaLength(media);
  const MIN = 0.1 * c.speed;
  if (edge === "start") c.in = clamp(c.in + delta * c.speed, 0, c.out - MIN);
  else c.out = clamp(c.out + delta * c.speed, c.in + MIN, max);
}

export function trimItem(item, edge, delta, media) {
  const MIN = 0.1;
  if (item.kind) {
    if (edge === "start") {
      const d = clamp(delta, -item.start, item.duration - MIN);
      item.start += d;
      item.duration -= d;
    } else {
      item.duration = Math.max(MIN, item.duration + delta);
    }
    return;
  }
  // Audio: trimming the head moves both the timeline start and the source in.
  if (edge === "start") {
    const d = clamp(delta, Math.max(-item.in, -item.start), item.out - item.in - MIN);
    item.start += d;
    item.in += d;
  } else {
    item.out = clamp(item.out + delta, item.in + MIN, mediaLength(media));
  }
}

/** Snaps `t` to the nearest candidate within `tol` seconds. */
export function snap(t, candidates, tol) {
  let best = t, bestD = tol;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

export function snapPoints(p, exceptId, playhead) {
  const pts = [0, playhead];
  for (const e of layoutV1(p.v1)) pts.push(e.start, e.end);
  for (const i of [...p.v2, ...p.a2]) if (i.id !== exceptId) pts.push(i.start, itemEnd(i));
  for (const m of p.markers) pts.push(m.time);
  return pts;
}

// --- history ---------------------------------------------------------------

export class History {
  constructor(cap = 100) { this.cap = cap; this.undo = []; this.redo = []; }
  push(state, label) {
    this.undo.push({ state: structuredClone(state), label });
    if (this.undo.length > this.cap) this.undo.shift();
    this.redo.length = 0;
  }
  step(from, to, current) {
    const e = this[from].pop();
    if (!e) return null;
    this[to].push({ state: structuredClone(current), label: e.label });
    return e.state;
  }
  back(current) { return this.step("undo", "redo", current); }
  forward(current) { return this.step("redo", "undo", current); }
  clear() { this.undo.length = 0; this.redo.length = 0; }
}

// --- files -----------------------------------------------------------------

export function timecode(t, fps) {
  t = Math.max(0, t);
  const f = Math.floor((t % 1) * fps + 1e-6);
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(Math.min(f, fps - 1))}`;
}

const srtTime = (t) => {
  const ms = Math.round(Math.max(0, t) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function parseSRT(text) {
  if (text.length > LIMITS.srtBytes) throw new Error(`Caption files are limited to ${LIMITS.srtBytes / 1024 ** 2} MB.`);
  const time = (s) => {
    const m = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(s);
    if (!m) return NaN;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
  };
  const cues = [];
  for (const block of text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const start = time(a), end = time(b);
    if (!(end > start) || start > LIMITS.sequenceSeconds) continue;
    // Strip the markup some subtitle tools add; we render plain text.
    const body = lines.slice(at + 1).join("\n").replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "").slice(0, LIMITS.textLength);
    if (body.trim()) cues.push({ start, end, text: body });
    if (cues.length > LIMITS.timelineItems) throw new Error(`This caption file has more than ${LIMITS.timelineItems} captions.`);
  }
  if (!cues.length) throw new Error("No captions were found in that file.");
  return cues;
}

export function formatSRT(items) {
  return items
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((it, i) => `${i + 1}\n${srtTime(it.start)} --> ${srtTime(it.start + it.duration)}\n${it.text}\n`)
    .join("\n");
}

/** What goes in a saved project: everything but the media bytes. Media is
 *  referenced by name and size and relinked on open, like offline media in
 *  Premiere, because video files are far too large to bundle. */
export function serialize(p) {
  return JSON.stringify(p, null, 1);
}

// --- validation ------------------------------------------------------------
// A project file is untrusted input. Rather than validating it in place, a
// fresh project is rebuilt from the defaults, copying across only known keys
// with values coerced to the right type and range. Unknown keys (including
// __proto__) never make it in, and every reference is checked.

const ENUMS = {
  aspect: Object.keys(ASPECTS),
  look: Object.keys(LOOKS),
  fit: ["contain", "cover"],
  ease: EASES.map((e) => e[0]),
  animIn: ANIMS.map((a) => a[0]),
  animOut: ANIMS.map((a) => a[0]),
  align: ["left", "center", "right"],
  font: FONTS,
};

function clean(def, raw, key = "") {
  if (Array.isArray(def)) return def;
  if (def !== null && typeof def === "object") {
    const src = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const k of Object.keys(def)) out[k] = clean(def[k], Object.hasOwn(src, k) ? src[k] : undefined, k);
    return out;
  }
  if (typeof def === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n, -1e6, 1e6) : def;
  }
  if (typeof def === "boolean") return typeof raw === "boolean" ? raw : def;
  if (typeof def === "string") {
    if (typeof raw !== "string") return def;
    if (/^#[0-9a-f]{6}$/i.test(def)) return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : def;
    if (ENUMS[key]) return ENUMS[key].includes(raw) ? raw : def;
    return raw.slice(0, LIMITS.textLength);
  }
  return def;
}

export function sanitize(raw) {
  if (!raw || typeof raw !== "object" || raw.format !== "darkroom-video") {
    throw new Error("That isn't a Darkroom video project.");
  }
  if (raw.version > 1) throw new Error(`This project was saved by a newer version (v${raw.version}).`);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const p = newProject();
  p.settings = clean(p.settings, raw.settings);
  if (!RESOLUTIONS.includes(p.settings.height)) p.settings.height = 1080;
  if (!FRAME_RATES.includes(p.settings.fps)) p.settings.fps = 30;
  p.settings.masterVolume = clamp(p.settings.masterVolume, 0, 200);

  const media = arr(raw.media);
  if (media.length > LIMITS.mediaItems) throw new Error(`This project uses ${media.length} media files; the limit is ${LIMITS.mediaItems}.`);
  const total = arr(raw.v1).length + arr(raw.v2).length + arr(raw.a2).length;
  if (total > LIMITS.timelineItems) throw new Error(`This project has ${total} timeline items; the limit is ${LIMITS.timelineItems}.`);
  if (arr(raw.markers).length > LIMITS.markers) throw new Error(`This project has more than ${LIMITS.markers} markers.`);

  // Ids from the file are replaced, so a crafted file cannot collide with
  // anything the session creates later.
  const ids = new Map();
  for (const m of media) {
    const kind = ["video", "audio", "image"].includes(m?.kind) ? m.kind : null;
    if (!kind || typeof m.id !== "string") continue;
    const c = clean({ name: "", type: "", size: 0, duration: 0, width: 0, height: 0 }, m);
    const id = uid("md");
    ids.set(m.id, id);
    p.media.push({ id, kind, ...c, duration: clamp(c.duration, 0, LIMITS.sequenceSeconds) });
  }
  const known = (m) => ids.get(m);

  for (const c of arr(raw.v1)) {
    const mediaId = known(c?.mediaId);
    if (!mediaId) continue;
    const m = p.media.find((x) => x.id === mediaId);
    const base = { ...videoClip(m), transition: null };
    const out = clean({ ...base, transition: undefined }, c);
    delete out.transition;
    out.id = uid("c");
    out.mediaId = mediaId;
    out.speed = SPEEDS.includes(out.speed) ? out.speed : 1;
    out.in = clamp(out.in, 0, mediaLength(m));
    out.out = clamp(out.out, out.in + 0.05, mediaLength(m));
    out.volume = clamp(out.volume, 0, 200);
    const t = c.transition;
    if (t && typeof t === "object" && TRANSITION_IDS.includes(t.type) && p.v1.length) {
      out.transition = { type: t.type, duration: clamp(Number(t.duration) || 1, 0.1, 5) };
    } else out.transition = null;
    p.v1.push(out);
  }
  for (const it of arr(raw.v2)) {
    if (it?.kind === "text") {
      p.v2.push({ ...clean(textItem(0), it), id: uid("t"), kind: "text" });
    } else if (it?.kind === "image" && known(it.mediaId)) {
      const m = p.media.find((x) => x.id === known(it.mediaId));
      p.v2.push({ ...clean(imageOverlay(m, 0), it), id: uid("g"), kind: "image", mediaId: m.id });
    }
  }
  for (const it of arr(raw.a2)) {
    const mediaId = known(it?.mediaId);
    if (!mediaId) continue;
    const m = p.media.find((x) => x.id === mediaId);
    const out = clean(audioItem(m, 0), it);
    p.a2.push({ ...out, id: uid("a"), mediaId, volume: clamp(out.volume, 0, 200) });
  }
  for (const it of [...p.v2, ...p.a2]) {
    it.start = clamp(it.start, 0, LIMITS.sequenceSeconds);
    if (it.kind) it.duration = clamp(it.duration, 0.05, LIMITS.sequenceSeconds);
  }
  for (const mk of arr(raw.markers)) p.markers.push({ ...clean(marker(0), mk), id: uid("m") });
  return p;
}
