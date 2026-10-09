// Playback, decoding and export for the video studio.
//
// Browsers decode video through <video> elements, and each one can only be in
// one place at a time. A small pool of them is assigned to the clips that are
// on screen or coming up within the look-ahead window, so the next shot is
// already seeked and buffered when the cut arrives and a transition has both
// of its shots decoding at once. Audio from every element runs through Web
// Audio, which is where clip volume, fades, crossfades and the master bus
// live, and where export taps the mix.

import {
  layoutV1, activeV1, sourceTime, transitionProgress, fadeGain, motionAt, gradeUniforms,
  animState, itemEnd, sequenceDuration, ASPECTS, LIMITS,
} from "./model.js";
import { Renderer, paintText } from "./renderer.js";

const LOOKAHEAD = 1.5;     // seconds of upcoming clips to prepare while playing
const VIDEO_SLOTS = 4;     // two for a transition, two preparing
const AUDIO_SLOTS = 4;
const DRIFT = 0.2;         // seconds a playing decoder may wander before a re-seek

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255); };

function once(el, ok, bad = "error", ms = 10000) {
  return new Promise((resolve, reject) => {
    const done = (f, v) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener(bad, onBad); f(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error("The browser could not decode this file."));
    const timer = setTimeout(() => done(reject, new Error("Timed out reading this file.")), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener(bad, onBad);
  });
}

export class Engine {
  constructor(canvas, { getProject, onTick }) {
    this.getProject = getProject;
    this.onTick = onTick;
    this.renderer = new Renderer(canvas);
    this.canvas = canvas;
    this.runtime = new Map();   // mediaId -> {url, kind, bitmap, thumb, peaks, offline}
    this.texts = new Map();     // itemId -> {key, canvas, stamp}
    this.t = 0;
    this.playing = false;
    this.loop = false;
    this.exporting = null;
    this.queued = false;
    this.ctx = null;

    const mk = (tag, i) => {
      const el = document.createElement(tag);
      el.preload = "auto";
      el.playsInline = true;
      el.addEventListener("seeked", () => this.requestRender());
      el.addEventListener("loadeddata", () => this.requestRender());
      return { i, el, clipId: null, mediaId: null, gain: null };
    };
    this.vslots = Array.from({ length: VIDEO_SLOTS }, (_, i) => mk("video", i));
    this.aslots = Array.from({ length: AUDIO_SLOTS }, (_, i) => mk("audio", i));
  }

  // --- media ---------------------------------------------------------------

  /** Reads what is needed about a file without loading it all: metadata, a
   *  thumbnail, and for small audio files a waveform. */
  async probe(file) {
    const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : null;
    if (!kind) throw new Error(`${file.name} isn't a video, audio or image file.`);
    const cap = { video: LIMITS.videoBytes, audio: LIMITS.audioBytes, image: LIMITS.imageBytes }[kind];
    if (file.size > cap) throw new Error(`${file.name} is ${fmtBytes(file.size)}. ${kind[0].toUpperCase() + kind.slice(1)} files are limited to ${fmtBytes(cap)}.`);
    const url = URL.createObjectURL(file);
    try {
      const info = { name: file.name, type: file.type, size: file.size, kind, duration: 0, width: 0, height: 0 };
      const rt = { url, kind, offline: false };
      if (kind === "image") {
        const img = new Image();
        img.src = url;
        await once(img, "load");
        const { naturalWidth: w, naturalHeight: h } = img;
        if (!w || !h || w > LIMITS.imageEdge || h > LIMITS.imageEdge || w * h > LIMITS.imagePixels) {
          throw new Error(`${file.name} is ${w} × ${h}. Images in the video studio are limited to ${LIMITS.imageEdge} px and ${LIMITS.imagePixels / 1e6} MP.`);
        }
        // A video frame never needs more than 4K; keeping the full image
        // would hold hundreds of MB of GPU memory per still.
        const s = Math.min(1, 3840 / Math.max(w, h));
        rt.bitmap = await createImageBitmap(img, { resizeWidth: Math.round(w * s), resizeHeight: Math.round(h * s), resizeQuality: "high" });
        Object.assign(info, { width: w, height: h });
        rt.thumb = thumbFrom(rt.bitmap, w, h);
      } else {
        const el = document.createElement(kind);
        el.preload = "metadata";
        el.muted = true;
        el.src = url;
        await once(el, "loadedmetadata");
        // Recorded WebM often has no duration until the decoder seeks to the end.
        if (el.duration === Infinity) {
          el.currentTime = 1e10;
          await once(el, "durationchange", "error", 8000).catch(() => {});
        }
        if (!Number.isFinite(el.duration) || el.duration <= 0) throw new Error(`${file.name} has no readable duration.`);
        info.duration = Math.min(el.duration, LIMITS.sequenceSeconds);
        if (kind === "video" && !el.videoWidth) { info.kind = rt.kind = "audio"; }
        if (info.kind === "video") {
          info.width = el.videoWidth; info.height = el.videoHeight;
          el.currentTime = Math.min(1, info.duration * 0.1);
          await once(el, "seeked", "error", 5000).catch(() => {});
          rt.thumb = thumbFrom(el, el.videoWidth, el.videoHeight);
        }
        el.removeAttribute("src");
        el.load();
        if (info.kind === "audio" && file.size <= LIMITS.waveformBytes) {
          rt.peaks = await peaksOf(file).catch(() => null);
        }
      }
      return { info, rt };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  attach(mediaId, rt) {
    const old = this.runtime.get(mediaId);
    if (old?.url) URL.revokeObjectURL(old.url);
    this.runtime.set(mediaId, rt);
    this.renderer.forget(`img:${mediaId}`);
    this.renderer.forget(`imgp:${mediaId}`);
    this.requestRender();
  }

  detach(mediaId) {
    const rt = this.runtime.get(mediaId);
    for (const s of [...this.vslots, ...this.aslots]) {
      if (s.mediaId === mediaId) { s.el.pause(); s.el.removeAttribute("src"); s.el.load(); s.mediaId = s.clipId = null; }
    }
    if (rt?.url) URL.revokeObjectURL(rt.url);
    rt?.bitmap?.close?.();
    this.runtime.delete(mediaId);
  }

  reset() {
    for (const id of [...this.runtime.keys()]) this.detach(id);
    this.texts.clear();
    this.t = 0;
  }

  // --- audio ---------------------------------------------------------------

  ensureAudio() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.dest = ctx.createMediaStreamDestination();
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.master.connect(this.dest);
    for (const s of [...this.vslots, ...this.aslots]) {
      s.el.volume = 1;
      s.gain = ctx.createGain();
      s.gain.gain.value = 0;
      ctx.createMediaElementSource(s.el).connect(s.gain);
      s.gain.connect(this.master);
    }
  }

  setGain(slot, g) {
    if (slot.gain) slot.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.012);
    else slot.el.volume = clamp(g, 0, 1);
  }

  /** Peak level of the mix in dBFS, for the meter. */
  level() {
    if (!this.analyser) return -Infinity;
    const buf = this.levelBuf || (this.levelBuf = new Float32Array(this.analyser.fftSize));
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return 20 * Math.log10(peak || 1e-6);
  }

  // --- transport -----------------------------------------------------------

  duration() { return sequenceDuration(this.getProject()); }

  play() {
    if (this.playing) return;
    const dur = this.duration();
    if (!dur) return;
    this.ensureAudio();
    this.ctx.resume();
    if (this.t >= dur - 0.02) this.t = 0;
    this.playing = true;
    this.clock = { t: this.t, wall: performance.now() };
    this.requestRender();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const s of [...this.vslots, ...this.aslots]) { s.el.pause(); if (s.gain) this.setGain(s, 0); }
    this.requestRender();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.t = clamp(t, 0, Math.max(0, this.duration()));
    if (this.playing) this.clock = { t: this.t, wall: performance.now() };
    this.requestRender();
  }

  requestRender() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => this.frame());
  }

  frame() {
    this.queued = false;
    const p = this.getProject();
    const { w, h } = outputSize(p.settings);
    this.renderer.resize(w, h);
    const dur = this.duration();
    if (this.playing) {
      this.t = this.clock.t + (performance.now() - this.clock.wall) / 1000;
      if (this.t >= dur) {
        if (this.loop && !this.exporting && dur > 0) { this.t = 0; this.clock = { t: 0, wall: performance.now() }; }
        else { this.t = dur; this.pause(); this.exporting?.finish(); }
      }
    }
    this.sync(p, this.t);
    this.renderer.draw(this.build(p, this.t, w, h));
    this.onTick?.(this.t, this.playing);
    if (this.playing) this.requestRender();
  }

  /** Points the decoder pool at the clips around `t`, and sets their gain. */
  sync(p, t) {
    const lay = layoutV1(p.v1);
    const fps = p.settings.fps;
    const horizon = this.playing ? t + LOOKAHEAD : t;
    const master = p.settings.masterVolume / 100;
    const isLive = (id) => { const rt = this.runtime.get(id); return rt && !rt.offline && rt.kind !== "image"; };

    const assign = (slots, needs) => {
      for (const s of slots) {
        if (s.clipId && !needs.some((n) => n.id === s.clipId)) { s.clipId = null; s.el.pause(); this.setGain(s, 0); }
      }
      for (const n of needs) {
        let s = slots.find((x) => x.clipId === n.id);
        if (!s) {
          s = slots.find((x) => !x.clipId && x.mediaId === n.mediaId) || slots.find((x) => !x.clipId);
          if (!s) continue;
          s.clipId = n.id;
          if (s.mediaId !== n.mediaId) { s.el.src = this.runtime.get(n.mediaId).url; s.mediaId = n.mediaId; }
        }
        n.slot = s;
        const el = s.el;
        el.playbackRate = n.rate;
        if (this.playing && n.active) {
          if (el.paused) {
            if (Math.abs(el.currentTime - n.target) > 0.05) el.currentTime = n.target;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - n.target) > DRIFT) {
            el.currentTime = n.target;
          }
        } else {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - n.target) > 0.5 / fps) el.currentTime = n.target;
        }
        this.setGain(s, this.playing && n.active ? n.gain * master : 0);
      }
    };

    const vneeds = [];
    for (const e of lay) {
      if (e.end <= t || e.start > horizon || !isLive(e.clip.mediaId)) continue;
      const c = e.clip, local = t - e.start, active = t >= e.start && t < e.end;
      let g = c.muted ? 0 : (c.volume / 100) * fadeGain(local, e.len, c.fadeIn, c.fadeOut);
      // Constant-power crossfade across a transition, so the level doesn't dip.
      const tp = transitionProgress(e, t);
      if (tp !== null) g *= Math.sin((tp * Math.PI) / 2);
      const next = lay[e.index + 1];
      const np = next ? transitionProgress(next, t) : null;
      if (np !== null) g *= Math.cos((np * Math.PI) / 2);
      vneeds.push({
        id: c.id, mediaId: c.mediaId, active, gain: g, rate: c.speed,
        target: clamp(sourceTime(e, Math.max(t, e.start)), c.in, Math.max(c.in, c.out - 0.001)),
      });
    }
    assign(this.vslots, vneeds);
    this.vneeds = vneeds;

    const aneeds = [];
    for (const it of p.a2) {
      const end = itemEnd(it);
      if (end <= t || it.start > horizon || !isLive(it.mediaId)) continue;
      const local = t - it.start, len = end - it.start;
      aneeds.push({
        id: it.id, mediaId: it.mediaId, rate: 1, active: t >= it.start && t < end,
        gain: (it.volume / 100) * fadeGain(local, len, it.fadeIn, it.fadeOut),
        target: clamp(it.in + Math.max(0, local), it.in, it.out),
      });
    }
    assign(this.aslots, aneeds);
  }

  /** Everything the renderer needs for the frame at `t`. */
  build(p, t, W, H) {
    const r = this.renderer;
    const lay = layoutV1(p.v1);
    const layer = (e) => {
      const c = e.clip, rt = this.runtime.get(c.mediaId);
      let tex = null;
      if (!rt || rt.offline) tex = r.texture("offline", offlineCard());
      else if (rt.kind === "image") tex = r.texture(`img:${c.mediaId}`, rt.bitmap);
      else {
        const n = this.vneeds?.find((x) => x.id === c.id);
        if (n?.slot) tex = r.texture(`slot:${n.slot.i}`, n.slot.el, { live: true });
      }
      return { tex, grade: gradeUniforms(c.grade), motion: motionAt(c.motion, t - e.start, e.len) };
    };

    const frame = { bg: hexRgb(p.settings.background), a: null, b: null, progress: 0, transition: null, overlays: [] };
    const act = activeV1(lay, t);
    if (act.length >= 2) {
      const [ea, eb] = act;
      frame.a = layer(ea);
      frame.b = layer(eb);
      frame.progress = transitionProgress(eb, t) ?? 1;
      frame.transition = eb.clip.transition?.type || "dissolve";
    } else if (act.length === 1) {
      frame.a = layer(act[0]);
    }

    for (const it of p.v2) {
      if (t < it.start || t >= itemEnd(it)) continue;
      const st = animState(it, t - it.start);
      const base = {
        x: it.x / 100 - 0.5 + st.dx, y: it.y / 100 - 0.5 + st.dy,
        scale: (it.scale / 100) * st.scale, rotation: it.rotation, opacity: (it.opacity / 100) * st.opacity,
      };
      if (it.kind === "text") {
        const chars = Math.floor(it.text.length * st.reveal);
        const key = JSON.stringify([it.text, it.font, it.size, it.color, it.bold, it.italic, it.align, it.bg, it.bgColor, it.bgOpacity, it.outline, it.outlineColor, it.shadow, it.caption, W, H, chars]);
        let c = this.texts.get(it.id);
        if (!c) { c = { key: "", canvas: document.createElement("canvas"), stamp: 0 }; this.texts.set(it.id, c); }
        if (c.key !== key) { paintText(c.canvas, it, W, H, st.reveal); c.key = key; c.stamp++; }
        frame.overlays.push({ ...base, tex: r.texture(`txt:${it.id}`, c.canvas, { stamp: c.stamp, premultiply: true }), fullFrame: true });
      } else {
        const rt = this.runtime.get(it.mediaId);
        const tex = rt && !rt.offline ? r.texture(`imgp:${it.mediaId}`, rt.bitmap, { premultiply: true }) : r.texture("offline", offlineCard());
        frame.overlays.push({ ...base, tex, fullFrame: false });
      }
    }
    return frame;
  }

  // --- export --------------------------------------------------------------

  /** Waits until the decoders for the frame at `t` have a picture. */
  async ready(t) {
    const p = this.getProject();
    this.sync(p, t);
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      const waiting = (this.vneeds || []).filter((n) => n.active && n.slot && (n.slot.el.readyState < 2 || n.slot.el.seeking));
      if (!waiting.length) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Records the whole sequence in real time. Resolves with the file. */
  async record({ mimeType, videoBitsPerSecond, audioOnly, onProgress }) {
    const dur = this.duration();
    if (!dur) throw new Error("The timeline is empty.");
    if (dur > LIMITS.exportSeconds) throw new Error(`Exports are limited to ${LIMITS.exportSeconds / 60} minutes. This sequence is ${Math.ceil(dur / 60)} minutes.`);
    this.pause();
    this.ensureAudio();
    await this.ctx.resume();
    this.t = 0;
    await this.ready(0);
    this.frame();

    const fps = this.getProject().settings.fps;
    const stream = audioOnly ? new MediaStream() : this.canvas.captureStream(fps);
    // Clone, so stopping the export's tracks leaves the live mix intact.
    for (const tr of this.dest.stream.getAudioTracks()) stream.addTrack(tr.clone());
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    return new Promise((resolve, reject) => {
      let canceled = false;
      const stop = () => { stream.getTracks().forEach((tr) => tr.stop()); this.exporting = null; };
      rec.onstop = () => { stop(); canceled ? reject(new Error("Export canceled.")) : resolve(new Blob(chunks, { type: rec.mimeType })); };
      rec.onerror = () => { stop(); reject(new Error("The browser could not encode this export.")); };
      this.exporting = {
        dur,
        finish: () => { if (rec.state === "recording") rec.stop(); },
        cancel: () => { canceled = true; this.pause(); if (rec.state === "recording") rec.stop(); },
      };
      const tick = this.onTick;
      this.onTick = (t, playing) => { tick?.(t, playing); onProgress?.(Math.min(1, t / dur)); if (!this.exporting) this.onTick = tick; };
      rec.start(1000);
      this.play();
    });
  }

  cancelExport() { this.exporting?.cancel(); }

  /** The current frame as a PNG. */
  async still() {
    this.frame();
    return new Promise((r) => this.canvas.toBlob(r, "image/png"));
  }
}

export function outputSize(s) {
  const a = ASPECTS[s.aspect] || 16 / 9;
  // Encoders want even dimensions; the short side is the chosen resolution.
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return a >= 1 ? { w: even(s.height * a), h: even(s.height) } : { w: even(s.height), h: even(s.height / a) };
}

export function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function thumbFrom(src, w, h) {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 90;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#111"; ctx.fillRect(0, 0, 160, 90);
  const s = Math.min(160 / w, 90 / h);
  ctx.drawImage(src, (160 - w * s) / 2, (90 - h * s) / 2, w * s, h * s);
  return c.toDataURL("image/jpeg", 0.7);
}

/** Peak envelope at 50 points per second, for drawing waveforms. */
async function peaksOf(file) {
  const buf = await file.arrayBuffer();
  const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
  const per = Math.max(1, Math.floor(audio.sampleRate / 50));
  const n = Math.min(Math.ceil(audio.length / per), 200000);
  const out = new Float32Array(n);
  for (let ch = 0; ch < Math.min(2, audio.numberOfChannels); ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(data.length, (i + 1) * per);
      for (let j = i * per; j < end; j += 4) m = Math.max(m, Math.abs(data[j]));
      out[i] = Math.max(out[i], m);
    }
  }
  return out;
}

let offline;
function offlineCard() {
  if (offline) return offline;
  offline = document.createElement("canvas");
  offline.width = 640; offline.height = 360;
  const ctx = offline.getContext("2d");
  ctx.fillStyle = "#3a1414"; ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = "#ffb4a8"; ctx.font = "600 36px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("Media offline", 320, 170);
  ctx.font = "20px sans-serif"; ctx.fillText("Relink it from the media bin", 320, 210);
  return offline;
}
