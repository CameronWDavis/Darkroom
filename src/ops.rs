//! The edit pipeline.
//!
//! Most ops are resolution-independent parameterized transforms: geometry is
//! stored in normalized 0..1 coordinates and effect radii as a fraction of the
//! image's short edge. That is what lets the same `Vec<Op>` render identically
//! against a 1200px preview and a 6000px export without any conversion step.
//!
//! `Paint` is the exception, and the reason `apply_all` is not a plain fold.
//! Stroke points are stored in *source* coordinates so they survive a later
//! crop or rotation, which means painting has to know which geometry ops ran
//! ahead of it. The pipeline therefore carries a running geometry transform.

use image::{imageops, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Stroke {
    /// Straight (non-premultiplied) RGBA.
    pub color: [u8; 4],
    /// Brush diameter as a fraction of the source short edge.
    pub width: f32,
    #[serde(default)]
    pub erase: bool,
    /// Flat x,y pairs in normalized source coordinates. Flat rather than
    /// nested to keep the manifest small; a long session is a lot of numbers.
    pub points: Vec<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Normalized against the *source* dimensions, before any rotation.
    Crop { x: f32, y: f32, w: f32, h: f32 },
    /// Quarter turns clockwise, 0..3.
    Rotate { turns: u8 },
    FlipH,
    FlipV,
    /// -1.0 .. 1.0, additive in 8-bit space.
    Brightness { value: f32 },
    /// -1.0 .. 1.0, pivots around mid-grey.
    Contrast { value: f32 },
    /// -1.0 .. 1.0, where -1.0 is fully desaturated.
    Saturation { value: f32 },
    Grayscale,
    Invert,
    /// 0.0 .. 1.0 as a fraction of the short edge.
    Blur { amount: f32 },
    /// Always last in the array, so paint sits on top of tone adjustments
    /// rather than being desaturated along with the photograph.
    Paint { strokes: Vec<Stroke> },
    /// Free-form cut-out. Flat x,y pairs in normalized source coordinates,
    /// implicitly closed. Crops to the shape's bounding box and clears alpha
    /// outside the shape, so this is the one op that can introduce
    /// transparency into an otherwise opaque photograph.
    Lasso { points: Vec<f32> },
}

fn is_geometry(op: &Op) -> bool {
    matches!(op, Op::Crop { .. } | Op::Rotate { .. } | Op::FlipH | Op::FlipV)
}

/// Applies ops in array order. The caller supplies them in a sensible order;
/// the UI enforces geometry -> tone -> effects -> paint.
pub fn apply_all(src: &RgbaImage, ops: &[Op]) -> RgbaImage {
    // Brush radius is anchored to the image handed in here, so a stroke keeps
    // the same apparent thickness on a preview and on a full export, and does
    // not thicken when a later crop shrinks the frame.
    let base_short = src.width().min(src.height()).max(1) as f32;

    let mut img = src.clone();
    let mut geo: Vec<Op> = Vec::new();
    for op in ops {
        match op {
            Op::Paint { strokes } => paint(&mut img, strokes, &geo, base_short),
            Op::Lasso { points } => {
                // A lasso shifts the frame just as a crop does, so anything
                // applied afterwards has to be mapped through it. Recording
                // the resulting bounding box as an equivalent Crop lets
                // map_point stay ignorant of lassos entirely.
                let pre = (img.width(), img.height());
                if let Some(bb) = lasso_bbox(points, &geo, pre.0, pre.1) {
                    img = cut_out(&img, points, &geo, bb);
                    geo.push(bbox_as_crop(bb, pre));
                }
            }
            _ => {
                if is_geometry(op) {
                    geo.push(op.clone());
                }
                img = apply_one(img, op);
            }
        }
    }
    img
}

fn apply_one(img: RgbaImage, op: &Op) -> RgbaImage {
    match *op {
        Op::Crop { x, y, w, h } => crop_normalized(&img, x, y, w, h),
        Op::Rotate { turns } => match turns % 4 {
            1 => imageops::rotate90(&img),
            2 => imageops::rotate180(&img),
            3 => imageops::rotate270(&img),
            _ => img,
        },
        Op::FlipH => imageops::flip_horizontal(&img),
        Op::FlipV => imageops::flip_vertical(&img),
        Op::Brightness { value } => per_pixel(img, |c| {
            let d = value * 255.0;
            [
                clamp8(c[0] as f32 + d),
                clamp8(c[1] as f32 + d),
                clamp8(c[2] as f32 + d),
                c[3],
            ]
        }),
        Op::Contrast { value } => {
            let f = 1.0 + value.clamp(-1.0, 1.0);
            per_pixel(img, |c| {
                [
                    clamp8((c[0] as f32 - 127.5) * f + 127.5),
                    clamp8((c[1] as f32 - 127.5) * f + 127.5),
                    clamp8((c[2] as f32 - 127.5) * f + 127.5),
                    c[3],
                ]
            })
        }
        Op::Saturation { value } => {
            let f = 1.0 + value.clamp(-1.0, 1.0);
            per_pixel(img, |c| {
                let l = luma(c);
                [
                    clamp8(l + (c[0] as f32 - l) * f),
                    clamp8(l + (c[1] as f32 - l) * f),
                    clamp8(l + (c[2] as f32 - l) * f),
                    c[3],
                ]
            })
        }
        Op::Grayscale => per_pixel(img, |c| {
            let l = clamp8(luma(c));
            [l, l, l, c[3]]
        }),
        Op::Invert => per_pixel(img, |c| [255 - c[0], 255 - c[1], 255 - c[2], c[3]]),
        Op::Blur { amount } => {
            let short = img.width().min(img.height()) as f32;
            let sigma = amount.clamp(0.0, 1.0) * short * 0.02;
            if sigma < 0.35 {
                img
            } else {
                imageops::blur(&img, sigma)
            }
        }
        // Both handled in apply_all, which has the geometry context they need.
        Op::Paint { .. } | Op::Lasso { .. } => img,
    }
}

fn crop_normalized(img: &RgbaImage, x: f32, y: f32, w: f32, h: f32) -> RgbaImage {
    let (iw, ih) = (img.width(), img.height());
    if iw == 0 || ih == 0 {
        return img.clone();
    }
    // The origin has to leave at least one pixel of room. Rounding can push it
    // one past the last valid index, and `crop_imm` then clamps the region
    // against an out-of-bounds start and returns an empty image -- which the
    // encoders accept before failing somewhere much less obvious.
    let px = ((x.clamp(0.0, 1.0) * iw as f32).round() as u32).min(iw - 1);
    let py = ((y.clamp(0.0, 1.0) * ih as f32).round() as u32).min(ih - 1);
    // `iw - px` is >= 1 by the clamp above, so the range is always valid.
    let pw = ((w.clamp(0.0, 1.0) * iw as f32).round() as u32).clamp(1, iw - px);
    let ph = ((h.clamp(0.0, 1.0) * ih as f32).round() as u32).clamp(1, ih - py);
    imageops::crop_imm(img, px, py, pw, ph).to_image()
}

// --- lasso -----------------------------------------------------------------

/// Pixel-space bounding box of the shape, mapped through prior geometry.
fn lasso_bbox(points: &[f32], geo: &[Op], w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let pts = mapped_points(points, geo, w, h);
    if pts.len() < 3 {
        return None;
    }
    let x0 = pts.iter().map(|p| p.0).fold(f32::MAX, f32::min).floor().max(0.0) as u32;
    let y0 = pts.iter().map(|p| p.1).fold(f32::MAX, f32::min).floor().max(0.0) as u32;
    let x1 = (pts.iter().map(|p| p.0).fold(f32::MIN, f32::max).ceil().min(w as f32) as u32).max(x0 + 1);
    let y1 = (pts.iter().map(|p| p.1).fold(f32::MIN, f32::max).ceil().min(h as f32) as u32).max(y0 + 1);
    if x0 >= w || y0 >= h {
        return None;
    }
    Some((x0, y0, (x1 - x0).min(w - x0), (y1 - y0).min(h - y0)))
}

fn bbox_as_crop(bb: (u32, u32, u32, u32), dims: (u32, u32)) -> Op {
    let (w, h) = (dims.0.max(1) as f32, dims.1.max(1) as f32);
    Op::Crop { x: bb.0 as f32 / w, y: bb.1 as f32 / h, w: bb.2 as f32 / w, h: bb.3 as f32 / h }
}

fn mapped_points(points: &[f32], geo: &[Op], w: u32, h: u32) -> Vec<(f32, f32)> {
    points
        .chunks_exact(2)
        .map(|c| {
            let (nx, ny) = map_point(c[0], c[1], geo);
            (nx * w as f32, ny * h as f32)
        })
        .collect()
}

/// Vertical subsamples per output row. Four is enough to hide the stair-step
/// on a near-horizontal edge without the cost showing up.
const SUBSAMPLES: usize = 4;

fn cut_out(img: &RgbaImage, points: &[f32], geo: &[Op], bb: (u32, u32, u32, u32)) -> RgbaImage {
    let pts = mapped_points(points, geo, img.width(), img.height());
    let (bx, by, bw, bh) = bb;
    let (bw_i, bh_i) = (bw as usize, bh as usize);

    // Testing each pixel against every edge would be O(edges) per pixel, which
    // does not survive a large export. Scanline conversion is O(edges) per row
    // and gives exact horizontal coverage for free.
    let mut cov = vec![0.0f32; bw_i * bh_i];
    let weight = 1.0 / SUBSAMPLES as f32;
    let mut xs: Vec<f32> = Vec::with_capacity(pts.len());

    for row in 0..bh_i {
        for s in 0..SUBSAMPLES {
            let y = by as f32 + row as f32 + (s as f32 + 0.5) / SUBSAMPLES as f32;
            xs.clear();
            for i in 0..pts.len() {
                let a = pts[i];
                let b = pts[(i + 1) % pts.len()];
                // Half-open comparison, so a vertex exactly on the scanline is
                // counted once rather than zero or twice.
                if (a.1 <= y) != (b.1 <= y) {
                    let t = (y - a.1) / (b.1 - a.1);
                    xs.push(a.0 + t * (b.0 - a.0));
                }
            }
            xs.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
            // Even-odd rule: fill between alternating pairs, which handles a
            // self-crossing lasso the way a person would expect.
            for pair in xs.chunks_exact(2) {
                add_span(&mut cov, bw_i, row, pair[0] - bx as f32, pair[1] - bx as f32, weight);
            }
        }
    }

    let mut out = RgbaImage::new(bw, bh);
    for y in 0..bh {
        for x in 0..bw {
            let c = cov[y as usize * bw_i + x as usize].clamp(0.0, 1.0);
            if c <= 0.0 {
                continue;
            }
            let mut p = *img.get_pixel(x + bx, y + by);
            p[3] = clamp8(p[3] as f32 * c);
            out.put_pixel(x, y, p);
        }
    }
    out
}

fn add_span(cov: &mut [f32], w: usize, row: usize, x0: f32, x1: f32, weight: f32) {
    let a = x0.max(0.0);
    let b = x1.min(w as f32);
    if b <= a {
        return;
    }
    let ia = a.floor() as usize;
    let ib = (b.ceil() as usize).min(w);
    for i in ia..ib {
        // Partial coverage at each end of the span, full in between.
        let l = (i as f32).max(a);
        let r = ((i + 1) as f32).min(b);
        if r > l {
            cov[row * w + i] += (r - l) * weight;
        }
    }
}

/// Output dimensions without doing the work. One source of truth for the
/// export dialog, replacing a duplicate of the crop maths in app.js.
pub fn dims_after(w: u32, h: u32, ops: &[Op]) -> (u32, u32) {
    let (mut cw, mut ch) = (w.max(1), h.max(1));
    let mut geo: Vec<Op> = Vec::new();
    for op in ops {
        match op {
            Op::Crop { .. } => {
                let probe = RgbaImage::new(cw, ch);
                let d = apply_one(probe, op).dimensions();
                cw = d.0;
                ch = d.1;
                geo.push(op.clone());
            }
            Op::Rotate { turns } => {
                if turns % 2 == 1 {
                    std::mem::swap(&mut cw, &mut ch);
                }
                geo.push(op.clone());
            }
            Op::FlipH | Op::FlipV => geo.push(op.clone()),
            Op::Lasso { points } => {
                if let Some(bb) = lasso_bbox(points, &geo, cw, ch) {
                    geo.push(bbox_as_crop(bb, (cw, ch)));
                    cw = bb.2;
                    ch = bb.3;
                }
            }
            _ => {}
        }
    }
    (cw, ch)
}

// --- painting --------------------------------------------------------------

/// Walks a normalized source point through the geometry applied so far. This
/// is the forward direction; `app.js` implements the inverse, so a pointer
/// position on screen can be turned back into source coordinates.
fn map_point(mut x: f32, mut y: f32, geo: &[Op]) -> (f32, f32) {
    for op in geo {
        match *op {
            Op::Crop { x: cx, y: cy, w: cw, h: ch } => {
                x = (x - cx) / cw.max(1e-6);
                y = (y - cy) / ch.max(1e-6);
            }
            Op::Rotate { turns } => {
                let (nx, ny) = match turns % 4 {
                    1 => (1.0 - y, x),
                    2 => (1.0 - x, 1.0 - y),
                    3 => (y, 1.0 - x),
                    _ => (x, y),
                };
                x = nx;
                y = ny;
            }
            Op::FlipH => x = 1.0 - x,
            Op::FlipV => y = 1.0 - y,
            _ => {}
        }
    }
    (x, y)
}

fn paint(img: &mut RgbaImage, strokes: &[Stroke], geo: &[Op], base_short: f32) {
    let (w, h) = (img.width() as i64, img.height() as i64);
    if w == 0 || h == 0 || strokes.is_empty() {
        return;
    }

    // An eraser has to remove paint without punching a hole in the photograph,
    // so it needs its own transparent layer to subtract from. With no eraser
    // present we composite straight onto the image and skip the allocation,
    // which at export resolution is worth a few hundred megabytes.
    let needs_layer = strokes.iter().any(|s| s.erase);
    let mut layer = needs_layer.then(|| RgbaImage::new(img.width(), img.height()));

    // Coverage accumulates per stroke before compositing. Blending each segment
    // as it is drawn would darken every joint where consecutive stamps overlap.
    let mut mask = vec![0u8; (w * h) as usize];

    for s in strokes {
        if s.points.len() < 2 {
            continue;
        }
        let r = (s.width * base_short * 0.5).max(0.5);

        let pts: Vec<(f32, f32)> = s
            .points
            .chunks_exact(2)
            .map(|c| {
                let (nx, ny) = map_point(c[0], c[1], geo);
                (nx * w as f32, ny * h as f32)
            })
            .collect();

        let pad = r + 2.0;
        let bx0 = (pts.iter().map(|p| p.0).fold(f32::MAX, f32::min) - pad).floor().max(0.0) as i64;
        let bx1 = (pts.iter().map(|p| p.0).fold(f32::MIN, f32::max) + pad).ceil().clamp(0.0, w as f32) as i64;
        let by0 = (pts.iter().map(|p| p.1).fold(f32::MAX, f32::min) - pad).floor().max(0.0) as i64;
        let by1 = (pts.iter().map(|p| p.1).fold(f32::MIN, f32::max) + pad).ceil().clamp(0.0, h as f32) as i64;
        if bx1 <= bx0 || by1 <= by0 {
            continue;
        }
        let bb = (bx0, by0, bx1, by1);

        for y in by0..by1 {
            let row = (y * w) as usize;
            mask[row + bx0 as usize..row + bx1 as usize].fill(0);
        }

        // A single tap is a zero-length segment, which the distance function
        // treats as a plain point, so it lands as a round dot.
        let segs = if pts.len() == 1 { 1 } else { pts.len() - 1 };
        for i in 0..segs {
            let a = pts[i];
            let b = pts[(i + 1).min(pts.len() - 1)];
            stamp(&mut mask, w, bb, a, b, r);
        }

        composite(img, layer.as_mut(), &mask, w, bb, s);
    }

    if let Some(l) = layer {
        over(img, &l);
    }
}

fn stamp(mask: &mut [u8], w: i64, bb: (i64, i64, i64, i64), a: (f32, f32), b: (f32, f32), r: f32) {
    let pad = r + 2.0;
    let x0 = ((a.0.min(b.0) - pad).floor() as i64).max(bb.0);
    let x1 = ((a.0.max(b.0) + pad).ceil() as i64).min(bb.2);
    let y0 = ((a.1.min(b.1) - pad).floor() as i64).max(bb.1);
    let y1 = ((a.1.max(b.1) + pad).ceil() as i64).min(bb.3);

    for y in y0..y1 {
        for x in x0..x1 {
            let d = dist_to_segment(x as f32 + 0.5, y as f32 + 0.5, a, b);
            // One pixel of feathering at the edge: cheap antialiasing.
            let cov = (r + 0.5 - d).clamp(0.0, 1.0);
            if cov > 0.0 {
                let i = (y * w + x) as usize;
                let v = (cov * 255.0) as u8;
                if v > mask[i] {
                    mask[i] = v;
                }
            }
        }
    }
}

fn dist_to_segment(px: f32, py: f32, a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= f32::EPSILON {
        0.0
    } else {
        (((px - a.0) * dx + (py - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    let (cx, cy) = (a.0 + t * dx, a.1 + t * dy);
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

fn composite(
    img: &mut RgbaImage,
    layer: Option<&mut RgbaImage>,
    mask: &[u8],
    w: i64,
    bb: (i64, i64, i64, i64),
    s: &Stroke,
) {
    let target = match layer {
        Some(l) => l,
        None => img,
    };
    for y in bb.1..bb.3 {
        for x in bb.0..bb.2 {
            let cov = mask[(y * w + x) as usize] as f32 / 255.0;
            if cov <= 0.0 {
                continue;
            }
            let dst = target.get_pixel_mut(x as u32, y as u32);
            if s.erase {
                // Destination-out against the paint layer only.
                dst[3] = (dst[3] as f32 * (1.0 - cov)) as u8;
            } else {
                let sa = cov * (s.color[3] as f32 / 255.0);
                let da = dst[3] as f32 / 255.0;
                let out_a = sa + da * (1.0 - sa);
                if out_a > 0.0 {
                    for c in 0..3 {
                        let v = (s.color[c] as f32 * sa + dst[c] as f32 * da * (1.0 - sa)) / out_a;
                        dst[c] = clamp8(v);
                    }
                }
                dst[3] = clamp8(out_a * 255.0);
            }
        }
    }
}

/// Source-over of the paint layer onto the photograph.
fn over(img: &mut RgbaImage, layer: &RgbaImage) {
    for (dst, src) in img.pixels_mut().zip(layer.pixels()) {
        let sa = src[3] as f32 / 255.0;
        if sa <= 0.0 {
            continue;
        }
        let da = dst[3] as f32 / 255.0;
        let out_a = sa + da * (1.0 - sa);
        if out_a > 0.0 {
            for c in 0..3 {
                let v = (src[c] as f32 * sa + dst[c] as f32 * da * (1.0 - sa)) / out_a;
                dst[c] = clamp8(v);
            }
        }
        dst[3] = clamp8(out_a * 255.0);
    }
}

// --- helpers ---------------------------------------------------------------

#[inline]
fn luma(c: &Rgba<u8>) -> f32 {
    0.2126 * c[0] as f32 + 0.7152 * c[1] as f32 + 0.0722 * c[2] as f32
}

#[inline]
fn clamp8(v: f32) -> u8 {
    v.clamp(0.0, 255.0) as u8
}

fn per_pixel<F>(mut img: RgbaImage, f: F) -> RgbaImage
where
    F: Fn(&Rgba<u8>) -> [u8; 4],
{
    for p in img.pixels_mut() {
        *p = Rgba(f(p));
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_is_resolution_independent() {
        let small = RgbaImage::new(100, 100);
        let large = RgbaImage::new(1000, 1000);
        let op = Op::Crop { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
        assert_eq!(apply_one(small, &op).dimensions(), (50, 50));
        assert_eq!(apply_one(large, &op).dimensions(), (500, 500));
    }

    /// A crop must never produce an empty image, whatever the caller passes.
    /// Origins near 1.0 round past the last valid index, which is easy to miss
    /// on a large preview and then reachable at export resolution.
    #[test]
    fn crop_never_yields_an_empty_image() {
        let sizes = [1u32, 2, 10, 37, 100, 1600];
        let coords = [0.0f32, 0.001, 0.25, 0.5, 0.9, 0.99, 0.999, 0.9999, 1.0];
        for &s in &sizes {
            for &x in &coords {
                for &w in &coords {
                    let out = apply_one(
                        RgbaImage::new(s, s),
                        &Op::Crop { x, y: x, w, h: w },
                    );
                    assert!(
                        out.width() >= 1 && out.height() >= 1,
                        "empty crop from {s}px at x={x} w={w}"
                    );
                    assert!(out.width() <= s && out.height() <= s, "crop grew the image");
                }
            }
        }
    }

    #[test]
    fn ops_survive_a_json_round_trip() {
        let ops = vec![
            Op::Crop { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
            Op::Rotate { turns: 1 },
            Op::Saturation { value: -0.4 },
            Op::Paint {
                strokes: vec![Stroke {
                    color: [220, 40, 40, 255],
                    width: 0.02,
                    erase: false,
                    points: vec![0.1, 0.1, 0.5, 0.5],
                }],
            },
        ];
        let json = serde_json::to_string(&ops).unwrap();
        let back: Vec<Op> = serde_json::from_str(&json).unwrap();
        assert_eq!(ops, back);
    }

    fn white(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255]))
    }

    #[test]
    fn a_stroke_marks_the_image() {
        let mut img = white(64, 64);
        let strokes = vec![Stroke {
            color: [255, 0, 0, 255],
            width: 0.1,
            erase: false,
            points: vec![0.2, 0.5, 0.8, 0.5],
        }];
        paint(&mut img, &strokes, &[], 64.0);
        assert_eq!(img.get_pixel(32, 32).0[0..3], [255, 0, 0], "centre should be painted");
        assert_eq!(img.get_pixel(2, 2).0[0..3], [255, 255, 255], "corner should be untouched");
    }

    #[test]
    fn an_eraser_removes_paint_without_holing_the_photo() {
        let mut img = white(64, 64);
        let strokes = vec![
            Stroke { color: [255, 0, 0, 255], width: 0.2, erase: false, points: vec![0.2, 0.5, 0.8, 0.5] },
            Stroke { color: [0, 0, 0, 255], width: 0.5, erase: true, points: vec![0.2, 0.5, 0.8, 0.5] },
        ];
        paint(&mut img, &strokes, &[], 64.0);
        let p = *img.get_pixel(32, 32);
        assert_eq!(p.0[3], 255, "the photograph must stay opaque");
        assert_eq!(p.0[0..3], [255, 255, 255], "the paint should be gone");
    }

    /// Paint is stored in source coordinates, so a stroke has to stay on the
    /// same part of the subject after the frame is rotated.
    #[test]
    fn paint_follows_the_geometry() {
        let stroke = Stroke {
            color: [0, 0, 255, 255],
            width: 0.3,
            erase: false,
            // A dot in the top-left quadrant. Two points so it is a segment.
            points: vec![0.25, 0.25, 0.25, 0.25],
        };

        let mut plain = white(80, 80);
        paint(&mut plain, std::slice::from_ref(&stroke), &[], 80.0);
        assert_eq!(plain.get_pixel(20, 20).0[2], 255);

        // One turn clockwise sends the top-left quadrant to the top-right.
        let mut turned = white(80, 80);
        paint(&mut turned, std::slice::from_ref(&stroke), &[Op::Rotate { turns: 1 }], 80.0);
        assert_eq!(turned.get_pixel(60, 20).0[2], 255, "should follow the rotation");
        assert_ne!(turned.get_pixel(20, 20).0[2], 255, "and leave its old position");
    }

    /// The same stroke must cover the same fraction of the frame whether it is
    /// drawn on a preview or on a full-size export.
    #[test]
    fn strokes_scale_with_the_render_size() {
        let stroke = Stroke {
            color: [0, 0, 0, 255],
            width: 0.25,
            erase: false,
            points: vec![0.5, 0.5, 0.5, 0.5],
        };
        let covered = |n: u32| {
            let mut img = white(n, n);
            paint(&mut img, std::slice::from_ref(&stroke), &[], n as f32);
            img.pixels().filter(|p| p.0[0] < 128).count() as f32 / (n * n) as f32
        };
        let small = covered(100);
        let large = covered(400);
        assert!((small - large).abs() < 0.005, "coverage drifted: {small} vs {large}");
    }

    fn diamond() -> Vec<f32> {
        // A diamond inscribed in the middle half of the frame.
        vec![0.5, 0.25, 0.75, 0.5, 0.5, 0.75, 0.25, 0.5]
    }

    #[test]
    fn a_lasso_crops_to_its_bounding_box() {
        let img = white(200, 200);
        let out = apply_all(&img, &[Op::Lasso { points: diamond() }]);
        assert_eq!(out.dimensions(), (100, 100), "should crop to the diamond's box");
    }

    #[test]
    fn a_lasso_clears_alpha_outside_the_shape() {
        let img = white(200, 200);
        let out = apply_all(&img, &[Op::Lasso { points: diamond() }]);
        assert_eq!(out.get_pixel(50, 50).0[3], 255, "centre stays opaque");
        assert_eq!(out.get_pixel(1, 1).0[3], 0, "corner outside the diamond is cleared");
        assert_eq!(out.get_pixel(98, 1).0[3], 0, "and the opposite corner too");
    }

    #[test]
    fn lasso_coverage_is_resolution_independent() {
        // The diamond occupies half of its bounding box at any render size.
        let frac = |n: u32| {
            let out = apply_all(&white(n, n), &[Op::Lasso { points: diamond() }]);
            let total = (out.width() * out.height()) as f32;
            out.pixels().filter(|p| p.0[3] > 127).count() as f32 / total
        };
        for n in [120u32, 400, 900] {
            let f = frac(n);
            assert!((f - 0.5).abs() < 0.02, "at {n}px coverage was {f}, expected ~0.5");
        }
    }

    #[test]
    fn dims_after_agrees_with_actually_rendering() {
        let cases: Vec<Vec<Op>> = vec![
            vec![],
            vec![Op::Crop { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }],
            vec![Op::Rotate { turns: 1 }],
            vec![Op::Lasso { points: diamond() }],
            vec![Op::Crop { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, Op::Rotate { turns: 3 }],
            vec![Op::Lasso { points: diamond() }, Op::Rotate { turns: 1 }],
            vec![Op::Crop { x: 0.2, y: 0.0, w: 0.6, h: 1.0 }, Op::Lasso { points: diamond() }],
        ];
        for ops in cases {
            let img = white(240, 180);
            assert_eq!(
                dims_after(240, 180, &ops),
                apply_all(&img, &ops).dimensions(),
                "prediction diverged for {ops:?}"
            );
        }
    }

    /// Paint applied after a lasso has to land in the same place on the
    /// subject, because the lasso moved the frame under it.
    #[test]
    fn paint_survives_a_lasso() {
        let dot = Stroke {
            color: [0, 0, 255, 255],
            width: 0.06,
            erase: false,
            // Dead centre of the source, which is inside the diamond.
            points: vec![0.5, 0.5, 0.5, 0.5],
        };
        let ops = vec![
            Op::Lasso { points: diamond() },
            Op::Paint { strokes: vec![dot] },
        ];
        let out = apply_all(&white(200, 200), &ops);
        assert_eq!(out.dimensions(), (100, 100));
        assert_eq!(out.get_pixel(50, 50).0[2], 255, "the dot should be centred after the cut");
    }
}