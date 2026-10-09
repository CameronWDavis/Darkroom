// GPU compositor for the video studio. Each frame is drawn in three passes:
//
//   1. every visible V1 clip is graded and placed into its own framebuffer,
//   2. those are combined (a transition, or a straight copy) onto the canvas,
//   3. titles and graphics from V2 are alpha-blended over the top.
//
// Grading runs per pixel in a fragment shader, which is what makes Lumetri-
// style controls (white balance, shadows/highlights, colour wheels) affordable
// at 1080p and 60 fps where CSS filters or a CPU loop are not.

import { TRANSITION_IDS } from "./model.js";

const VERT_LAYER = `#version 300 es
in vec2 aPos;
uniform vec2 uHalf;     // half-size of the placed quad in NDC before motion
uniform float uAspect;  // output width / height
uniform float uScale;
uniform float uRot;     // radians, counter-clockwise
uniform vec2 uPos;      // NDC offset
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  vec2 p = aPos * uHalf;
  p.x *= uAspect;                       // rotate in square pixels, not NDC
  float c = cos(uRot), s = sin(uRot);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p.x /= uAspect;
  gl_Position = vec4(p * uScale + uPos, 0.0, 1.0);
}`;

const VERT_FULL = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG_GRADE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uOpacity;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uSat, uVib, uFaded, uSharpen, uVignette;
uniform vec3 uTintS, uTintM, uTintH;
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 c = texture(uTex, vUv).rgb;
  if (uSharpen > 0.0) {
    vec3 blur = (texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb +
                 texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb + texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb) * 0.25;
    c += (c - blur) * uSharpen * 1.5;
  }
  c *= exp2(uExposure);
  // White balance: temperature trades red against blue, tint green against magenta.
  c *= vec3(1.0 + uTemp * 0.12 + uTint * 0.05, 1.0 - uTint * 0.10, 1.0 - uTemp * 0.12 + uTint * 0.05);
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  float l = clamp(luma(c), 0.0, 1.0);
  float sh = 1.0 - smoothstep(0.0, 0.55, l);
  float hi = smoothstep(0.45, 1.0, l);
  float mid = clamp(1.0 - sh - hi, 0.0, 1.0);
  c += uShadows * sh * 0.30;
  c += uHighlights * hi * 0.30;
  c += uBlacks * (1.0 - smoothstep(0.0, 0.25, l)) * 0.15;
  c += uWhites * smoothstep(0.75, 1.0, l) * 0.15;
  // Three-way colour: tints weighted by tonal zone, like lift/gamma/gain wheels.
  c += uTintS * sh + uTintM * mid + uTintH * hi;

  l = luma(c);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float s = mx > 0.0 ? (mx - mn) / mx : 0.0;
  c = mix(vec3(l), c, uSat * (1.0 + uVib * (1.0 - s) * 1.5));

  c = mix(c, c * 0.82 + 0.10, uFaded);
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.25, 0.75, length(d) * 1.41421);
  c = uVignette < 0.0 ? c * (1.0 + uVignette * v) : c + (1.0 - c) * uVignette * v;
  outColor = vec4(clamp(c, 0.0, 1.0), uOpacity);
}`;

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA;
out vec4 outColor;
void main() { outColor = vec4(texture(uA, vUv).rgb, 1.0); }`;

const FRAG_TRANSITION = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA, uB;
uniform float uP, uAspect;
uniform int uType;
out vec4 outColor;
vec3 A(vec2 uv) { return texture(uA, clamp(uv, 0.0, 1.0)).rgb; }
vec3 B(vec2 uv) { return texture(uB, clamp(uv, 0.0, 1.0)).rgb; }
float edge(float e, float x) { return smoothstep(e - 0.015, e + 0.015, x); }
void main() {
  vec2 uv = vUv; float p = uP; vec3 c;
  // FBO textures are bottom-up: vUv.y = 1 is the top of the frame.
  if (uType == 0) c = mix(A(uv), B(uv), p);
  else if (uType == 1) c = p < 0.5 ? mix(A(uv), vec3(0.0), p * 2.0) : mix(vec3(0.0), B(uv), p * 2.0 - 1.0);
  else if (uType == 2) c = p < 0.5 ? mix(A(uv), vec3(1.0), p * 2.0) : mix(vec3(1.0), B(uv), p * 2.0 - 1.0);
  else if (uType == 3) c = mix(A(uv), B(uv), edge(1.0 - p, uv.x));
  else if (uType == 4) c = mix(A(uv), B(uv), 1.0 - edge(p, uv.x));
  else if (uType == 5) c = mix(A(uv), B(uv), 1.0 - edge(p, uv.y));
  else if (uType == 6) c = mix(A(uv), B(uv), edge(1.0 - p, uv.y));
  else if (uType == 7) c = uv.x < 1.0 - p ? A(uv + vec2(p, 0.0)) : B(uv - vec2(1.0 - p, 0.0));
  else if (uType == 8) c = uv.x > p ? A(uv - vec2(p, 0.0)) : B(uv + vec2(1.0 - p, 0.0));
  else if (uType == 9) c = uv.x > 1.0 - p ? B(uv - vec2(1.0 - p, 0.0)) : A(uv);
  else if (uType == 10) {
    float r = p * length(vec2(uAspect, 1.0)) * 0.5;
    float d = length((uv - 0.5) * vec2(uAspect, 1.0));
    c = mix(B(uv), A(uv), smoothstep(r - 0.01, r + 0.01, d));
  } else if (uType == 11) {
    vec3 a = A((uv - 0.5) / (1.0 + p * 1.2) + 0.5);
    vec3 b = B((uv - 0.5) / (1.0 + (1.0 - p) * 0.6) + 0.5);
    c = mix(a, b, smoothstep(0.35, 0.65, p));
  } else if (uType == 12) {
    float ang = fract(atan(uv.x - 0.5, uv.y - 0.5) / 6.2831853 + 1.0); // 0 at 12 o'clock, clockwise
    c = mix(A(uv), B(uv), 1.0 - smoothstep(p - 0.005, p + 0.005, ang));
  } else {
    // Film dissolve: highlights of the incoming shot burn through first.
    vec3 b = B(uv);
    float k = clamp(p * 1.6 - (1.0 - dot(b, vec3(0.333))) * 0.6, 0.0, 1.0);
    c = mix(A(uv), b, k);
  }
  outColor = vec4(c, 1.0);
}`;

const FRAG_OVERLAY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv) * uOpacity; }`; // premultiplied

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const loc = new Proxy({}, { get: (cache, name) => (name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(prog, name))) });
  return { prog, loc };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer lets "Export frame" and the scopes read the
    // canvas after the frame was presented.
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("This browser has no WebGL 2, which the video studio needs for preview and export.");
    this.gl = gl;
    this.grade = compile(gl, VERT_LAYER, FRAG_GRADE);
    this.copy = compile(gl, VERT_FULL, FRAG_COPY);
    this.trans = compile(gl, VERT_FULL, FRAG_TRANSITION);
    this.overlay = compile(gl, VERT_LAYER, FRAG_OVERLAY);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.textures = new Map();   // key -> {tex, w, h, stamp, used}
    this.frame = 0;
    this.fbos = [];
    this.w = this.h = 0;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.canvas.width = this.w = w;
    this.canvas.height = this.h = h;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos = [0, 1].map(() => {
      const tex = this.makeTex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  makeTex() {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** A texture for `source`. Static sources upload once per `stamp`; video
   *  uploads every frame it has new data. Returns null if nothing to show. */
  texture(key, source, { stamp = 0, live = false, premultiply = false } = {}) {
    const gl = this.gl;
    let t = this.textures.get(key);
    const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
    if (!w || !h) return t && t.ready ? t : null;
    if (live && source.readyState < 2) return t && t.ready ? t : null;
    if (!t) { t = { tex: this.makeTex(), stamp: -1, ready: false }; this.textures.set(key, t); }
    t.used = this.frame;
    if (live || t.stamp !== stamp) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        t.ready = true;
      } catch { /* a decoder mid-seek can briefly refuse; keep the last frame */ }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      t.stamp = stamp; t.w = w; t.h = h;
    }
    return t.ready ? t : null;
  }

  /** Frees textures nobody has drawn for a while (removed titles, old media). */
  collect() {
    for (const [k, t] of this.textures) {
      if (this.frame - t.used > 120) { this.gl.deleteTexture(t.tex); this.textures.delete(k); }
    }
  }

  forget(prefix) {
    for (const [k, t] of this.textures) {
      if (k.startsWith(prefix)) { this.gl.deleteTexture(t.tex); this.textures.delete(k); }
    }
  }

  setLayerTransform(prog, tw, th, m, fullFrame = false) {
    const gl = this.gl, aspect = this.w / this.h;
    let hx = 1, hy = 1;
    if (!fullFrame) {
      // Contain fits the whole picture; cover fills the frame and crops.
      const ma = tw / th;
      const wide = ma > aspect;
      if ((m.fit === "cover") === wide) { hy = 1; hx = ma / aspect; } else { hx = 1; hy = aspect / ma; }
    }
    gl.uniform2f(prog.loc.uHalf, hx, hy);
    gl.uniform1f(prog.loc.uAspect, aspect);
    gl.uniform1f(prog.loc.uScale, m.scale);
    gl.uniform1f(prog.loc.uRot, (-m.rotation * Math.PI) / 180);
    gl.uniform2f(prog.loc.uPos, m.x * 2, -m.y * 2);
  }

  drawLayer(target, layer, bg) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!layer.tex) return;
    const p = this.grade, u = layer.grade;
    gl.useProgram(p.prog);
    this.setLayerTransform(p, layer.tex.w, layer.tex.h, layer.motion);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layer.tex.tex);
    gl.uniform1i(p.loc.uTex, 0);
    gl.uniform2f(p.loc.uTexel, 1 / layer.tex.w, 1 / layer.tex.h);
    gl.uniform1f(p.loc.uOpacity, layer.motion.opacity);
    gl.uniform1f(p.loc.uExposure, u.exposure);
    gl.uniform1f(p.loc.uContrast, u.contrast);
    gl.uniform1f(p.loc.uHighlights, u.highlights);
    gl.uniform1f(p.loc.uShadows, u.shadows);
    gl.uniform1f(p.loc.uWhites, u.whites);
    gl.uniform1f(p.loc.uBlacks, u.blacks);
    gl.uniform1f(p.loc.uTemp, u.temperature);
    gl.uniform1f(p.loc.uTint, u.tint);
    gl.uniform1f(p.loc.uSat, u.saturation);
    gl.uniform1f(p.loc.uVib, u.vibrance);
    gl.uniform1f(p.loc.uFaded, u.faded);
    gl.uniform1f(p.loc.uSharpen, u.sharpen);
    gl.uniform1f(p.loc.uVignette, u.vignette);
    gl.uniform3fv(p.loc.uTintS, u.tintS);
    gl.uniform3fv(p.loc.uTintM, u.tintM);
    gl.uniform3fv(p.loc.uTintH, u.tintH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  /** frame: {bg: [r,g,b], a, b, progress, transition, overlays: [{tex, x, y, scale, rotation, opacity, fullFrame}]} */
  draw(frame) {
    const gl = this.gl;
    this.frame++;
    gl.bindVertexArray(this.vao);
    const bg = frame.bg;
    if (frame.a) this.drawLayer(this.fbos[0], frame.a, bg);
    if (frame.b) this.drawLayer(this.fbos[1], frame.b, bg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
    if (frame.a && frame.b) {
      const p = this.trans;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.fbos[1].tex);
      gl.uniform1i(p.loc.uA, 0);
      gl.uniform1i(p.loc.uB, 1);
      gl.uniform1f(p.loc.uP, frame.progress);
      gl.uniform1f(p.loc.uAspect, this.w / this.h);
      gl.uniform1i(p.loc.uType, Math.max(0, TRANSITION_IDS.indexOf(frame.transition)));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (frame.a) {
      gl.useProgram(this.copy.prog);
      gl.uniform1i(this.copy.loc.uA, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (frame.overlays.length) {
      const p = this.overlay;
      gl.useProgram(p.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(p.loc.uTex, 0);
      for (const o of frame.overlays) {
        if (!o.tex) continue;
        gl.bindTexture(gl.TEXTURE_2D, o.tex.tex);
        this.setLayerTransform(p, o.tex.w, o.tex.h, { fit: "contain", scale: o.scale, x: o.x, y: o.y, rotation: o.rotation }, o.fullFrame);
        gl.uniform1f(p.loc.uOpacity, o.opacity);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.disable(gl.BLEND);
    }
    if (this.frame % 60 === 0) this.collect();
  }
}

// --- text ------------------------------------------------------------------

/** Lays out and paints a title into a full-frame 2D canvas, centred, so the
 *  compositor can move, scale and rotate it about its own middle. */
export function paintText(canvas, item, W, H, reveal = 1) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const px = Math.max(4, (item.size / 100) * H);
  ctx.font = `${item.italic ? "italic " : ""}${item.bold ? 700 : 400} ${px}px "${item.font}", sans-serif`;
  ctx.textBaseline = "middle";

  // Word-wrap at 90% of the frame width, keeping explicit line breaks.
  const maxW = W * 0.9;
  const lines = [];
  for (const para of item.text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line.trim() && ctx.measureText(next).width > maxW) { lines.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    lines.push(line);
  }

  // Typewriter reveal counts characters across all lines.
  let budget = Math.floor(item.text.replace(/\n/g, "").length * reveal);
  const shown = lines.map((l) => { const s = l.slice(0, Math.max(0, budget)); budget -= l.length; return s; });

  const lh = px * 1.2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const blockH = lh * lines.length;
  const cx = W / 2, top = H / 2 - blockH / 2;
  const x0 = item.align === "left" ? cx - blockW / 2 : item.align === "right" ? cx + blockW / 2 : cx;
  ctx.textAlign = item.align;

  if (item.bg) {
    const pad = px * 0.35;
    ctx.fillStyle = item.bgColor;
    ctx.globalAlpha = item.bgOpacity / 100;
    // Caption style hugs each line; titles get one box around the block.
    if (item.caption) {
      lines.forEach((l, i) => {
        if (!shown[i]) return;
        const w = widths[i];
        const lx = item.align === "left" ? x0 : item.align === "right" ? x0 - w : x0 - w / 2;
        ctx.fillRect(lx - pad, top + i * lh - pad * 0.3, w + pad * 2, lh + pad * 0.6);
      });
    } else {
      ctx.fillRect(cx - blockW / 2 - pad, top - pad, blockW + pad * 2, blockH + pad * 2);
    }
    ctx.globalAlpha = 1;
  }
  if (item.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = px * 0.18;
    ctx.shadowOffsetY = px * 0.06;
  }
  shown.forEach((l, i) => {
    const y = top + lh * (i + 0.5);
    if (item.outline > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = (item.outline / 100) * px * 2;
      ctx.strokeStyle = item.outlineColor;
      ctx.strokeText(l, x0, y);
    }
    ctx.fillStyle = item.color;
    ctx.fillText(l, x0, y);
  });
}
