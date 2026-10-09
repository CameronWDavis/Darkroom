// Unit tests for the video studio's sequence model. Run with:
//   node --test tests/
// model.js is a browser ES module with no imports; loading it from a data URL
// lets Node treat it as ESM without a package.json in the published site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile(new URL("../web/video/model.js", import.meta.url), "utf8");
const M = await import("data:text/javascript," + encodeURIComponent(src));

const vid = (id, duration = 10) => ({ id, kind: "video", name: `${id}.mp4`, duration, size: 1, type: "video/mp4", width: 1920, height: 1080 });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

function project(...lens) {
  const p = M.newProject();
  lens.forEach((len, i) => {
    const m = vid(`m${i}`, 20);
    p.media.push(m);
    const c = M.videoClip(m);
    c.out = len;
    p.v1.push(c);
  });
  return p;
}

test("V1 clips butt together and transitions overlap them", () => {
  const p = project(4, 6, 5);
  let lay = M.layoutV1(p.v1);
  assert.deepEqual(lay.map((e) => [e.start, e.end]), [[0, 4], [4, 10], [10, 15]]);
  p.v1[1].transition = { type: "dissolve", duration: 1 };
  lay = M.layoutV1(p.v1);
  near(lay[1].start, 3, "clip 2 starts 1 s early");
  near(M.sequenceDuration(p), 14, "sequence shortens by the overlap");
  assert.equal(M.activeV1(lay, 3.5).length, 2, "both shots visible mid-transition");
  near(M.transitionProgress(lay[1], 3.5), 0.5, "halfway through");
  // A transition can never eat more than half of either neighbour.
  p.v1[1].transition.duration = 10;
  near(M.layoutV1(p.v1)[1].tr, 2, "clamped to half the 4 s clip");
});

test("speed changes timeline length and source mapping", () => {
  const p = project(8);
  p.v1[0].speed = 2;
  const [e] = M.layoutV1(p.v1);
  near(e.len, 4, "8 s at 2× takes 4 s");
  near(M.sourceTime(e, 1), 2, "1 s in shows source second 2");
});

test("split, ripple delete and reorder", () => {
  const p = project(4, 6);
  const b = M.split(p, p.v1[1].id, 7);
  assert.ok(b, "split succeeds");
  assert.equal(p.v1.length, 3);
  near(p.v1[1].out, 3, "first half ends at source 3");
  near(p.v1[2].in, 3, "second half starts at source 3");
  near(M.sequenceDuration(p), 10, "splitting doesn't change the length");
  assert.equal(M.split(p, p.v1[0].id, 0.01), null, "too close to an edge");

  M.remove(p, p.v1[0].id);
  near(M.sequenceDuration(p), 6, "ripple delete closes the gap");
  M.moveV1(p, p.v1[1].id, 0);
  assert.equal(p.v1[0].id, b.id, "moved to the front");
  assert.equal(p.v1[0].transition, null, "the first clip can't have a transition");
});

test("trims respect media bounds", () => {
  const p = project(4);
  const m = p.media[0];
  M.trimV1(p, p.v1[0].id, "end", 100, m);
  near(p.v1[0].out, 20, "can't extend past the media");
  M.trimV1(p, p.v1[0].id, "start", -5, m);
  near(p.v1[0].in, 0, "can't start before the media");
  M.trimV1(p, p.v1[0].id, "start", 50, m);
  assert.ok(p.v1[0].out - p.v1[0].in >= 0.1 - 1e-9, "a clip keeps a minimum length");

  const t = M.textItem(5);
  M.trimItem(t, "start", -10, null);
  near(t.start, 0, "titles can't start before zero");
  near(t.duration, 9, "and the end stays put");
});

test("audio envelopes and animations", () => {
  near(M.fadeGain(0.5, 10, 1, 1), 0.5, "halfway through a fade in");
  near(M.fadeGain(5, 10, 1, 1), 1, "full level in the middle");
  near(M.fadeGain(9.75, 10, 1, 1), 0.25, "fading out");
  const t = { ...M.textItem(0), animIn: "fade", animOut: "none", animDur: 1, duration: 4 };
  near(M.animState(t, 0).opacity, 0, "starts invisible");
  near(M.animState(t, 2).opacity, 1, "fully visible after the entrance");
  const tw = { ...t, animIn: "typewriter" };
  assert.ok(M.animState(tw, 0.5).reveal < 1, "typewriter reveals progressively");
});

test("a neutral grade is neutral", () => {
  const u = M.gradeUniforms(M.defaultGrade());
  for (const k of ["exposure", "contrast", "highlights", "shadows", "temperature", "tint", "vibrance", "faded", "vignette"]) {
    assert.equal(u[k], 0, k);
  }
  assert.equal(u.saturation, 1);
  assert.deepEqual(u.tintS.map((x) => Math.abs(x)), [0, 0, 0]);
  const bw = M.gradeUniforms({ ...M.defaultGrade(), look: "bw" });
  assert.equal(bw.saturation, 0, "black & white look removes colour");
});

test("SRT round-trips", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,500\nHello <i>there</i>\n\n2\r\n00:00:04,000 --> 00:00:05,000\r\nTwo\r\nlines\r\n";
  const cues = M.parseSRT(srt);
  assert.deepEqual(cues, [{ start: 1, end: 3.5, text: "Hello there" }, { start: 4, end: 5, text: "Two\nlines" }]);
  const items = cues.map((c) => M.captionItem(c.start, c.end, c.text));
  assert.deepEqual(M.parseSRT(M.formatSRT(items)), cues);
  assert.throws(() => M.parseSRT("not captions"), /No captions/);
});

test("timecode", () => {
  assert.equal(M.timecode(3661.5, 30), "01:01:01:15");
  assert.equal(M.timecode(0, 24), "00:00:00:00");
});

test("project files are rebuilt, not trusted", () => {
  const p = project(4, 6);
  p.v1[1].transition = { type: "iris", duration: 1.5 };
  p.v2.push(M.textItem(2));
  const back = M.sanitize(JSON.parse(M.serialize(p)));
  assert.equal(back.v1.length, 2);
  assert.equal(back.v1[1].transition.type, "iris");
  assert.equal(back.v1[1].mediaId, back.media[1].id, "references are remapped together");
  assert.notEqual(back.v1[0].id, p.v1[0].id, "ids are regenerated");

  const evil = JSON.parse(M.serialize(p));
  evil.v1[0].__proto__ = { polluted: true };
  evil.v1[0].grade = JSON.parse('{"__proto__": {"polluted": true}, "exposure": "lots"}');
  evil.v1[0].speed = 1000;
  evil.v1[0].out = 1e9;
  evil.v1[1].transition = { type: "<script>", duration: 1 };
  evil.v2[0].font = "url(javascript:alert(1))";
  evil.v2[0].color = "red; background:url(x)";
  evil.v2.push({ kind: "image", mediaId: "nope" });
  evil.a2.push({ mediaId: "missing" });
  const s = M.sanitize(evil);
  assert.equal({}.polluted, undefined, "no prototype pollution");
  assert.equal(s.v1[0].grade.exposure, 0, "non-numbers fall back to defaults");
  assert.equal(s.v1[0].speed, 1, "unknown speeds are reset");
  near(s.v1[0].out, 20, "out is clamped to the media length");
  assert.equal(s.v1[1].transition, null, "unknown transitions are dropped");
  assert.equal(s.v2[0].font, "Bricolage Grotesque");
  assert.equal(s.v2[0].color, "#ffffff");
  assert.equal(s.v2.length, 1, "items pointing at unknown media are dropped");
  assert.equal(s.a2.length, 0);

  assert.throws(() => M.sanitize({ format: "something-else" }), /isn't a Darkroom/);
  assert.throws(() => M.sanitize({ ...JSON.parse(M.serialize(p)), version: 99 }), /newer version/);
  const huge = JSON.parse(M.serialize(p));
  huge.v2 = Array.from({ length: M.LIMITS.timelineItems + 1 }, () => M.textItem(0));
  assert.throws(() => M.sanitize(huge), /limit/);
});

test("history round-trips", () => {
  const h = new M.History();
  const a = { n: 1 };
  h.push(a, "one");
  const b = { n: 2 };
  assert.deepEqual(h.back(b), { n: 1 });
  assert.deepEqual(h.forward({ n: 1 }), { n: 2 });
});
