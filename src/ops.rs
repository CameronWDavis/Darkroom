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
    Exposure { value: f32 },
    Warmth { value: f32 },
    Sharpen { value: f32 },
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

    // --- v3 ---------------------------------------------------------------
    /// Photoshop's Levels. Input and output points are 0..1; `gamma` is the
    /// midtone exponent, where 1.0 is neutral and larger values brighten.
    Levels { in_black: f32, in_white: f32, gamma: f32, out_black: f32, out_white: f32 },
    /// Tone curves as flat x,y control points in 0..1, endpoints included.
    /// `rgb` runs first, then each channel's own curve. An empty or two-point
    /// identity list leaves that channel alone.
    Curves {
        #[serde(default)]
        rgb: Vec<f32>,
        #[serde(default)]
        red: Vec<f32>,
        #[serde(default)]
        green: Vec<f32>,
        #[serde(default)]
        blue: Vec<f32>,
    },
    /// Rotates hue, in degrees, -180..180.
    Hue { degrees: f32 },
    /// -1.0 .. 1.0. Saturation that favours muted colours and leaves already
    /// vivid ones (often skin) mostly alone.
    Vibrance { value: f32 },
    /// -1.0 .. 1.0 each. Positive shadows opens dark regions; positive
    /// highlights recovers bright ones. Driven by a blurred luminance mask, so
    /// it works on regions rather than flattening global contrast.
    ShadowsHighlights { shadows: f32, highlights: f32 },
    /// Luminosity-preserving colour tint, like a filter on a lens. Density 0..1.
    PhotoFilter { color: [u8; 3], density: f32 },
    /// -1.0 .. 1.0. Negative darkens the corners, positive lightens them.
    Vignette { amount: f32 },
    /// Film grain, 0..1. `mono` adds the same noise to every channel.
    Noise {
        amount: f32,
        #[serde(default)]
        mono: bool,
    },
    /// Tonal levels per channel, 2..=64.
    Posterize { levels: u8 },
    /// Pure black and white split at this luminance, 0..1.
    Threshold { level: f32 },
    /// Mosaic cell edge, 0..1, mapping to up to 10% of the short edge.
    Pixelate { size: f32 },
    /// A colour ramp laid over the frame. Endpoints are normalized *source*
    /// coordinates, like paint, so the ramp stays put under a later crop.
    Gradient {
        kind: GradientKind,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        from: [u8; 4],
        to: [u8; 4],
        #[serde(default = "one")]
        opacity: f32,
        #[serde(default)]
        blend: Blend,
    },
    /// Vector shapes, rendered resolution-independently in source space.
    Shapes { items: Vec<Shape> },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum GradientKind {
    Linear,
    Radial,
}

/// The separable blend modes from the W3C compositing spec, which match
/// Photoshop's for 8-bit RGB.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Blend {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    SoftLight,
    HardLight,
    Darken,
    Lighten,
    Difference,
    ColorDodge,
    ColorBurn,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ShapeKind {
    Rect,
    Ellipse,
    Line,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Shape {
    pub kind: ShapeKind,
    /// Opposite corners (or line endpoints) in normalized source coordinates.
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    #[serde(default)]
    pub fill: Option<[u8; 4]>,
    #[serde(default)]
    pub stroke: Option<[u8; 4]>,
    /// Stroke width as a fraction of the source short edge, like a brush.
    #[serde(default)]
    pub width: f32,
}

fn one() -> f32 {
    1.0
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
            Op::Gradient { kind, x0, y0, x1, y1, from, to, opacity, blend } => {
                gradient(&mut img, *kind, (*x0, *y0), (*x1, *y1), *from, *to, *opacity, *blend, &geo)
            }
            Op::Shapes { items } => shapes(&mut img, items, &geo, base_short),
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
        Op::Exposure { value } => {
            let gain = 2.0f32.powf(value.clamp(-1.0, 1.0) * 2.0);
            per_pixel(img, |c| [clamp8(c[0] as f32 * gain), clamp8(c[1] as f32 * gain), clamp8(c[2] as f32 * gain), c[3]])
        }
        Op::Warmth { value } => {
            let shift = value.clamp(-1.0, 1.0) * 40.0;
            per_pixel(img, |c| [clamp8(c[0] as f32 + shift), c[1], clamp8(c[2] as f32 - shift), c[3]])
        }
        Op::Sharpen { value } => {
            let amount = value.clamp(0.0, 1.0) * 2.0;
            let radius = (img.width().min(img.height()) as f32 * 0.001).max(0.5);
            let soft = imageops::blur(&img, radius);
            let mut result = img.clone();
            for ((out, original), blurred) in result.pixels_mut().zip(img.pixels()).zip(soft.pixels()) {
                for channel in 0..3 {
                    out[channel] = clamp8(original[channel] as f32 + amount * (original[channel] as f32 - blurred[channel] as f32));
                }
            }
            result
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
        Op::Levels { in_black, in_white, gamma, out_black, out_white } => {
            let lut = levels_lut(in_black, in_white, gamma, out_black, out_white);
            apply_luts(img, &lut, &lut, &lut)
        }
        Op::Curves { ref rgb, ref red, ref green, ref blue } => {
            let master = curve_lut(rgb);
            let chan = |pts: &[f32]| {
                let own = curve_lut(pts);
                let mut out = [0u8; 256];
                for (i, o) in out.iter_mut().enumerate() {
                    *o = own[master[i] as usize];
                }
                out
            };
            apply_luts(img, &chan(red), &chan(green), &chan(blue))
        }
        Op::Hue { degrees } => {
            let shift = degrees.clamp(-180.0, 180.0);
            if shift == 0.0 {
                return img;
            }
            per_pixel(img, |c| {
                let (h, s, v) = rgb_to_hsv(c[0], c[1], c[2]);
                let [r, g, b] = hsv_to_rgb((h + shift).rem_euclid(360.0), s, v);
                [r, g, b, c[3]]
            })
        }
        Op::Vibrance { value } => {
            let v = value.clamp(-1.0, 1.0);
            per_pixel(img, |c| {
                let mx = c[0].max(c[1]).max(c[2]) as f32;
                let mn = c[0].min(c[1]).min(c[2]) as f32;
                let sat = if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
                // Muted colours get the full push, saturated ones very little.
                let f = 1.0 + v * (1.0 - sat).powi(2) * 1.5;
                let l = luma(c);
                [
                    clamp8(l + (c[0] as f32 - l) * f),
                    clamp8(l + (c[1] as f32 - l) * f),
                    clamp8(l + (c[2] as f32 - l) * f),
                    c[3],
                ]
            })
        }
        Op::ShadowsHighlights { shadows, highlights } => {
            shadows_highlights(img, shadows.clamp(-1.0, 1.0), highlights.clamp(-1.0, 1.0))
        }
        Op::PhotoFilter { color, density } => {
            let d = density.clamp(0.0, 1.0);
            let tint = [color[0] as f32 / 255.0, color[1] as f32 / 255.0, color[2] as f32 / 255.0];
            per_pixel(img, |c| {
                let l = luma(c);
                // Multiply through the filter colour, then put the original
                // luminance back so the image is tinted, not darkened.
                let m: Vec<f32> = (0..3).map(|i| c[i] as f32 * (1.0 - d + d * tint[i] * 1.6)).collect();
                let ml = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
                let k = l - ml;
                [clamp8(m[0] + k), clamp8(m[1] + k), clamp8(m[2] + k), c[3]]
            })
        }
        Op::Vignette { amount } => vignette(img, amount.clamp(-1.0, 1.0)),
        Op::Noise { amount, mono } => {
            let a = amount.clamp(0.0, 1.0) * 80.0;
            if a <= 0.0 {
                return img;
            }
            let mut img = img;
            for (x, y, p) in img.enumerate_pixels_mut() {
                let n0 = hash_noise(x, y, 0);
                let (n1, n2) = if mono { (n0, n0) } else { (hash_noise(x, y, 1), hash_noise(x, y, 2)) };
                p[0] = clamp8(p[0] as f32 + n0 * a);
                p[1] = clamp8(p[1] as f32 + n1 * a);
                p[2] = clamp8(p[2] as f32 + n2 * a);
            }
            img
        }
        Op::Posterize { levels } => {
            let n = levels.clamp(2, 64) as f32 - 1.0;
            let mut lut = [0u8; 256];
            for (i, o) in lut.iter_mut().enumerate() {
                *o = clamp8(((i as f32 / 255.0) * n).round() / n * 255.0);
            }
            apply_luts(img, &lut, &lut, &lut)
        }
        Op::Threshold { level } => {
            let cut = level.clamp(0.0, 1.0) * 255.0;
            per_pixel(img, |c| {
                let v = if luma(c) >= cut { 255 } else { 0 };
                [v, v, v, c[3]]
            })
        }
        Op::Pixelate { size } => {
            let short = img.width().min(img.height()) as f32;
            let cell = (size.clamp(0.0, 1.0) * short * 0.1).round() as u32;
            if cell < 2 {
                img
            } else {
                pixelate(img, cell)
            }
        }
        // All handled in apply_all, which has the geometry context they need.
        Op::Paint { .. } | Op::Lasso { .. } | Op::Gradient { .. } | Op::Shapes { .. } => img,
    }
}

// --- tone ------------------------------------------------------------------

fn levels_lut(in_black: f32, in_white: f32, gamma: f32, out_black: f32, out_white: f32) -> [u8; 256] {
    let ib = in_black.clamp(0.0, 1.0);
    let iw = in_white.clamp(0.0, 1.0).max(ib + 1.0 / 255.0);
    let inv_gamma = 1.0 / gamma.clamp(0.1, 9.99);
    let (ob, ow) = (out_black.clamp(0.0, 1.0), out_white.clamp(0.0, 1.0));
    let mut lut = [0u8; 256];
    for (i, o) in lut.iter_mut().enumerate() {
        let t = ((i as f32 / 255.0 - ib) / (iw - ib)).clamp(0.0, 1.0).powf(inv_gamma);
        *o = clamp8((ob + t * (ow - ob)) * 255.0 + 0.5);
    }
    lut
}

/// A 256-entry table through the control points, using monotone cubic
/// (Fritsch–Carlson) interpolation. Monotone matters: a plain spline
/// overshoots between close points and folds the tone curve back on itself.
pub fn curve_lut(flat: &[f32]) -> [u8; 256] {
    let mut identity = [0u8; 256];
    for (i, o) in identity.iter_mut().enumerate() {
        *o = i as u8;
    }
    let mut pts: Vec<(f32, f32)> = flat
        .chunks_exact(2)
        .map(|c| (c[0].clamp(0.0, 1.0), c[1].clamp(0.0, 1.0)))
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-4);
    if pts.len() < 2 {
        return identity;
    }

    let n = pts.len();
    let d: Vec<f32> = (0..n - 1)
        .map(|i| (pts[i + 1].1 - pts[i].1) / (pts[i + 1].0 - pts[i].0))
        .collect();
    let mut m = vec![0.0f32; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
        let s = a * a + b * b;
        if s > 9.0 {
            let t = 3.0 / s.sqrt();
            m[i] = t * a * d[i];
            m[i + 1] = t * b * d[i];
        }
    }

    let mut lut = [0u8; 256];
    for (i, o) in lut.iter_mut().enumerate() {
        let x = i as f32 / 255.0;
        let y = if x <= pts[0].0 {
            pts[0].1
        } else if x >= pts[n - 1].0 {
            pts[n - 1].1
        } else {
            let k = pts.windows(2).position(|w| x <= w[1].0).unwrap_or(n - 2);
            let (p0, p1) = (pts[k], pts[k + 1]);
            let h = p1.0 - p0.0;
            let t = (x - p0.0) / h;
            let (t2, t3) = (t * t, t * t * t);
            (2.0 * t3 - 3.0 * t2 + 1.0) * p0.1
                + (t3 - 2.0 * t2 + t) * h * m[k]
                + (-2.0 * t3 + 3.0 * t2) * p1.1
                + (t3 - t2) * h * m[k + 1]
        };
        *o = clamp8(y * 255.0 + 0.5);
    }
    lut
}

fn apply_luts(mut img: RgbaImage, r: &[u8; 256], g: &[u8; 256], b: &[u8; 256]) -> RgbaImage {
    for p in img.pixels_mut() {
        p[0] = r[p[0] as usize];
        p[1] = g[p[1] as usize];
        p[2] = b[p[2] as usize];
    }
    img
}

fn shadows_highlights(mut img: RgbaImage, shadows: f32, highlights: f32) -> RgbaImage {
    if shadows == 0.0 && highlights == 0.0 {
        return img;
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut mask: Vec<f32> = img.pixels().map(|p| luma(p) / 255.0).collect();
    // A wide radius is what makes this regional rather than a global curve.
    let radius = ((w.min(h) as f32) * 0.03).round().max(1.0) as usize;
    box_blur(&mut mask, w, h, radius);

    for (p, &l) in img.pixels_mut().zip(mask.iter()) {
        let ws = (1.0 - l).powi(2);
        let wh = l * l;
        for c in 0..3 {
            let mut v = p[c] as f32 / 255.0;
            if shadows > 0.0 {
                v += shadows * ws * (1.0 - v) * 0.75;
            } else {
                v *= 1.0 + shadows * ws * 0.75;
            }
            if highlights > 0.0 {
                v *= 1.0 - highlights * wh * 0.5;
            } else {
                v += -highlights * wh * (1.0 - v) * 0.75;
            }
            p[c] = clamp8(v * 255.0);
        }
    }
    img
}

/// Three box passes approximate a Gaussian closely, at a cost independent of
/// the radius. That independence is the point: a 3% radius on a 60 MP export
/// would make a direct Gaussian crawl.
fn box_blur(buf: &mut [f32], w: usize, h: usize, r: usize) {
    if w == 0 || h == 0 || r == 0 {
        return;
    }
    let mut tmp = vec![0.0f32; buf.len()];
    for _ in 0..3 {
        blur_line(buf, &mut tmp, w, h, r, true);
        blur_line(&tmp, buf, w, h, r, false);
    }
}

fn blur_line(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize, horizontal: bool) {
    let (lines, len) = if horizontal { (h, w) } else { (w, h) };
    let at = |line: usize, i: usize| if horizontal { line * w + i } else { i * w + line };
    let norm = 1.0 / (2 * r + 1) as f32;
    for line in 0..lines {
        // Clamp-to-edge so borders are not darkened by imaginary black.
        let sample = |i: isize| src[at(line, i.clamp(0, len as isize - 1) as usize)];
        let mut acc: f32 = (-(r as isize)..=r as isize).map(sample).sum();
        for i in 0..len {
            dst[at(line, i)] = acc * norm;
            acc += sample(i as isize + r as isize + 1) - sample(i as isize - r as isize);
        }
    }
}

fn vignette(mut img: RgbaImage, amount: f32) -> RgbaImage {
    if amount == 0.0 {
        return img;
    }
    let (w, h) = (img.width() as f32, img.height() as f32);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let dx = (x as f32 + 0.5) / w - 0.5;
        let dy = (y as f32 + 0.5) / h - 0.5;
        // 0 at the centre, 1 in the corners, elliptical to follow the frame.
        let d = (dx * dx + dy * dy).sqrt() * std::f32::consts::SQRT_2;
        let t = ((d - 0.3) / 0.7).clamp(0.0, 1.0);
        let f = t * t * (3.0 - 2.0 * t);
        for c in 0..3 {
            let v = p[c] as f32;
            p[c] = clamp8(if amount < 0.0 { v * (1.0 + amount * f) } else { v + amount * f * (255.0 - v) });
        }
    }
    img
}

fn pixelate(mut img: RgbaImage, cell: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    for by in (0..h).step_by(cell as usize) {
        for bx in (0..w).step_by(cell as usize) {
            let (x1, y1) = ((bx + cell).min(w), (by + cell).min(h));
            let mut sum = [0u64; 4];
            for y in by..y1 {
                for x in bx..x1 {
                    let p = img.get_pixel(x, y);
                    for c in 0..4 {
                        sum[c] += p[c] as u64;
                    }
                }
            }
            let n = ((x1 - bx) * (y1 - by)) as u64;
            let avg = Rgba([(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8, (sum[3] / n) as u8]);
            for y in by..y1 {
                for x in bx..x1 {
                    img.put_pixel(x, y, avg);
                }
            }
        }
    }
    img
}

/// Stateless per-pixel noise in -1..1. Hashing the position instead of
/// running an RNG means re-rendering the same frame gives the same grain, so
/// a slider drag elsewhere doesn't make the image shimmer.
fn hash_noise(x: u32, y: u32, channel: u32) -> f32 {
    let mut h = x.wrapping_mul(0x8da6_b343) ^ y.wrapping_mul(0xd816_3841) ^ channel.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    // Sum of two uniforms: a softer, more film-like distribution than flat.
    let a = (h & 0xffff) as f32 / 65535.0;
    let b = (h >> 16) as f32 / 65535.0;
    a + b - 1.0
}

fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let mx = r.max(g).max(b);
    let mn = r.min(g).min(b);
    let d = mx - mn;
    let h = if d == 0.0 {
        0.0
    } else if mx == r {
        60.0 * ((g - b) / d).rem_euclid(6.0)
    } else if mx == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h, if mx > 0.0 { d / mx } else { 0.0 }, mx)
}

fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [u8; 3] {
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match (h / 60.0) as u32 % 6 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    [clamp8((r + m) * 255.0 + 0.5), clamp8((g + m) * 255.0 + 0.5), clamp8((b + m) * 255.0 + 0.5)]
}

// --- compositing -----------------------------------------------------------

fn blend_channel(mode: Blend, cb: f32, cs: f32) -> f32 {
    match mode {
        Blend::Normal => cs,
        Blend::Multiply => cb * cs,
        Blend::Screen => cb + cs - cb * cs,
        Blend::Overlay => blend_channel(Blend::HardLight, cs, cb),
        Blend::HardLight => {
            if cs <= 0.5 {
                cb * 2.0 * cs
            } else {
                let s = 2.0 * cs - 1.0;
                cb + s - cb * s
            }
        }
        Blend::SoftLight => {
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 { ((16.0 * cb - 12.0) * cb + 4.0) * cb } else { cb.sqrt() };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        Blend::Darken => cb.min(cs),
        Blend::Lighten => cb.max(cs),
        Blend::Difference => (cb - cs).abs(),
        Blend::ColorDodge => {
            if cb == 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        Blend::ColorBurn => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
    }
}

/// Source-over with a blend mode, per the W3C formula: where the backdrop is
/// transparent the source shows unblended, where it is opaque the blend wins.
fn blend_px(dst: &mut Rgba<u8>, src: [f32; 3], sa: f32, mode: Blend) {
    if sa <= 0.0 {
        return;
    }
    let da = dst[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    for c in 0..3 {
        let cb = dst[c] as f32 / 255.0;
        let cs = src[c];
        let mixed = (1.0 - da) * cs + da * blend_channel(mode, cb, cs);
        let v = (sa * mixed + (1.0 - sa) * da * cb) / out_a;
        dst[c] = clamp8(v * 255.0 + 0.5);
    }
    dst[3] = clamp8(out_a * 255.0 + 0.5);
}

#[allow(clippy::too_many_arguments)]
fn gradient(
    img: &mut RgbaImage,
    kind: GradientKind,
    a: (f32, f32),
    b: (f32, f32),
    from: [u8; 4],
    to: [u8; 4],
    opacity: f32,
    mode: Blend,
    geo: &[Op],
) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let (ax, ay) = map_point(a.0, a.1, geo);
    let (bx, by) = map_point(b.0, b.1, geo);
    let (ax, ay, bx, by) = (ax * w, ay * h, bx * w, by * h);
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let opacity = opacity.clamp(0.0, 1.0);
    if len2 < 1e-6 || opacity <= 0.0 {
        return;
    }
    let len = len2.sqrt();
    let f = |i: usize| (from[i] as f32 / 255.0, to[i] as f32 / 255.0);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let (px, py) = (x as f32 + 0.5 - ax, y as f32 + 0.5 - ay);
        let t = match kind {
            GradientKind::Linear => (px * dx + py * dy) / len2,
            GradientKind::Radial => (px * px + py * py).sqrt() / len,
        }
        .clamp(0.0, 1.0);
        let lerp = |i: usize| {
            let (s, e) = f(i);
            s + (e - s) * t
        };
        let alpha = lerp(3);
        // Interpolate colour premultiplied, so fading to transparent does not
        // drag a dark fringe through the middle of the ramp.
        let rgb = if alpha > 0.0 {
            let pm = |i: usize| {
                let (s, e) = f(i);
                let (sa, ea) = f(3);
                (s * sa + (e * ea - s * sa) * t) / alpha
            };
            [pm(0), pm(1), pm(2)]
        } else {
            [lerp(0), lerp(1), lerp(2)]
        };
        blend_px(p, rgb, alpha * opacity, mode);
    }
}

fn shapes(img: &mut RgbaImage, items: &[Shape], geo: &[Op], base_short: f32) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    for s in items {
        let (ax, ay) = map_point(s.x0, s.y0, geo);
        let (bx, by) = map_point(s.x1, s.y1, geo);
        let (a, b) = ((ax * w, ay * h), (bx * w, by * h));
        let hw = (s.width * base_short * 0.5).max(0.5);
        let stroke = s.stroke.filter(|c| c[3] > 0 && s.width > 0.0);
        let fill = s.fill.filter(|c| c[3] > 0 && s.kind != ShapeKind::Line);
        if stroke.is_none() && fill.is_none() {
            continue;
        }

        let (cx, cy) = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
        let (rx, ry) = (((b.0 - a.0) / 2.0).abs(), ((b.1 - a.1) / 2.0).abs());
        // Signed distance to the outline; negative inside.
        let sdf = |px: f32, py: f32| -> f32 {
            match s.kind {
                ShapeKind::Rect => {
                    let (qx, qy) = ((px - cx).abs() - rx, (py - cy).abs() - ry);
                    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
                    outside + qx.max(qy).min(0.0)
                }
                ShapeKind::Ellipse => {
                    // The usual first-order ellipse distance: exact on the
                    // outline, which is all antialiasing needs.
                    let (rx, ry) = (rx.max(0.5), ry.max(0.5));
                    let (ux, uy) = ((px - cx) / rx, (py - cy) / ry);
                    let k0 = (ux * ux + uy * uy).sqrt();
                    let k1 = ((ux / rx).powi(2) + (uy / ry).powi(2)).sqrt();
                    if k1 == 0.0 { -rx.min(ry) } else { k0 * (k0 - 1.0) / k1 }
                }
                ShapeKind::Line => dist_to_segment(px, py, a, b),
            }
        };

        let pad = hw + 2.0;
        let x0 = (a.0.min(b.0) - pad).floor().clamp(0.0, w) as u32;
        let x1 = (a.0.max(b.0) + pad).ceil().clamp(0.0, w) as u32;
        let y0 = (a.1.min(b.1) - pad).floor().clamp(0.0, h) as u32;
        let y1 = (a.1.max(b.1) + pad).ceil().clamp(0.0, h) as u32;
        let rgb = |c: [u8; 4]| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0];

        for y in y0..y1 {
            for x in x0..x1 {
                let d = sdf(x as f32 + 0.5, y as f32 + 0.5);
                let p = img.get_pixel_mut(x, y);
                if let Some(c) = fill {
                    let cov = (0.5 - d).clamp(0.0, 1.0);
                    blend_px(p, rgb(c), cov * c[3] as f32 / 255.0, Blend::Normal);
                }
                if let Some(c) = stroke {
                    let edge = if s.kind == ShapeKind::Line { d } else { d.abs() };
                    let cov = (hw + 0.5 - edge).clamp(0.0, 1.0);
                    blend_px(p, rgb(c), cov * c[3] as f32 / 255.0, Blend::Normal);
                }
            }
        }
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
    fn exposure_and_temperature_preserve_alpha() {
        let pixel = RgbaImage::from_pixel(1, 1, Rgba([80, 100, 120, 77]));
        let exposed = apply_all(&pixel, &[Op::Exposure { value: 0.5 }]);
        assert_eq!(exposed.get_pixel(0, 0).0, [160, 200, 240, 77]);
        let warm = apply_all(&pixel, &[Op::Warmth { value: 0.5 }]);
        assert_eq!(warm.get_pixel(0, 0).0, [100, 100, 100, 77]);
    }

    #[test]
    fn sharpen_increases_edge_contrast_and_keeps_alpha() {
        let mut source = RgbaImage::from_pixel(20, 20, Rgba([80, 80, 80, 123]));
        for y in 0..20 { for x in 10..20 { source.put_pixel(x, y, Rgba([160, 160, 160, 123])); } }
        let output = apply_all(&source, &[Op::Sharpen { value: 1.0 }]);
        assert!(output.get_pixel(9, 10)[0] < 80);
        assert!(output.get_pixel(10, 10)[0] > 160);
        assert!(output.pixels().all(|p| p[3] == 123));
        assert_eq!(apply_all(&source, &[Op::Sharpen { value: 0.0 }]), source);
    }

    #[test]
    fn studio_operations_round_trip() {
        let ops = vec![Op::Exposure { value: -0.4 }, Op::Warmth { value: 0.2 }, Op::Sharpen { value: 0.6 }];
        let serialized = serde_json::to_string(&ops).unwrap();
        assert_eq!(serde_json::from_str::<Vec<Op>>(&serialized).unwrap(), ops);
    }

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
        assert_eq!(plain.get_pixel(20, 20).0[0..3], [0, 0, 255]);

        // One turn clockwise sends the top-left quadrant to the top-right.
        let mut turned = white(80, 80);
        paint(&mut turned, std::slice::from_ref(&stroke), &[Op::Rotate { turns: 1 }], 80.0);
        assert_eq!(turned.get_pixel(60, 20).0[0..3], [0, 0, 255], "should follow the rotation");
        assert_eq!(turned.get_pixel(20, 20).0[0..3], [255, 255, 255], "and leave its old position");
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

    // --- v3 ops ------------------------------------------------------------

    fn grey(v: u8) -> RgbaImage {
        RgbaImage::from_pixel(8, 8, Rgba([v, v, v, 200]))
    }

    #[test]
    fn neutral_levels_and_curves_change_nothing() {
        let img = RgbaImage::from_fn(16, 16, |x, y| Rgba([(x * 16) as u8, (y * 16) as u8, 77, 255]));
        let levels = Op::Levels { in_black: 0.0, in_white: 1.0, gamma: 1.0, out_black: 0.0, out_white: 1.0 };
        assert_eq!(apply_all(&img, &[levels]), img);
        let curves = Op::Curves { rgb: vec![0.0, 0.0, 1.0, 1.0], red: vec![], green: vec![], blue: vec![] };
        assert_eq!(apply_all(&img, &[curves]), img);
    }

    #[test]
    fn levels_stretch_the_input_range() {
        let op = Op::Levels { in_black: 0.25, in_white: 0.75, gamma: 1.0, out_black: 0.0, out_white: 1.0 };
        assert_eq!(apply_all(&grey(63), std::slice::from_ref(&op)).get_pixel(0, 0)[0], 0);
        assert_eq!(apply_all(&grey(191), std::slice::from_ref(&op)).get_pixel(0, 0)[0], 255);
        let mid = apply_all(&grey(128), &[op]).get_pixel(0, 0)[0];
        assert!((126..=130).contains(&mid), "midpoint drifted to {mid}");
        // Gamma above 1 brightens midtones, and alpha is never touched.
        let bright = Op::Levels { in_black: 0.0, in_white: 1.0, gamma: 2.0, out_black: 0.0, out_white: 1.0 };
        let p = *apply_all(&grey(128), &[bright]).get_pixel(0, 0);
        assert!(p[0] > 160, "gamma 2 should lift mid-grey, got {}", p[0]);
        assert_eq!(p[3], 200);
    }

    #[test]
    fn curves_are_monotone_and_pass_through_their_points() {
        let lut = curve_lut(&[0.0, 0.0, 0.25, 0.4, 0.5, 0.45, 1.0, 1.0]);
        assert!(lut.windows(2).all(|w| w[0] <= w[1]), "curve folded back on itself");
        assert!((lut[64] as i32 - 102).abs() <= 2, "should pass near (0.25, 0.4), got {}", lut[64]);
        assert_eq!(lut[0], 0);
        assert_eq!(lut[255], 255);
        // A per-channel curve only touches its own channel.
        let op = Op::Curves { rgb: vec![], red: vec![0.0, 1.0, 1.0, 1.0], green: vec![], blue: vec![] };
        assert_eq!(apply_all(&grey(40), &[op]).get_pixel(0, 0).0, [255, 40, 40, 200]);
    }

    #[test]
    fn hue_rotation_moves_red_to_green() {
        let red = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
        assert_eq!(apply_all(&red, &[Op::Hue { degrees: 120.0 }]).get_pixel(0, 0).0, [0, 255, 0, 255]);
    }

    #[test]
    fn threshold_and_posterize_quantize() {
        let t = apply_all(&grey(100), &[Op::Threshold { level: 0.5 }]);
        assert_eq!(t.get_pixel(0, 0).0, [0, 0, 0, 200]);
        let t = apply_all(&grey(200), &[Op::Threshold { level: 0.5 }]);
        assert_eq!(t.get_pixel(0, 0).0, [255, 255, 255, 200]);
        let p = apply_all(&grey(100), &[Op::Posterize { levels: 2 }]);
        assert_eq!(p.get_pixel(0, 0)[0], 0);
    }

    #[test]
    fn vignette_darkens_corners_not_the_centre() {
        let img = RgbaImage::from_pixel(101, 101, Rgba([200, 200, 200, 255]));
        let out = apply_all(&img, &[Op::Vignette { amount: -1.0 }]);
        assert_eq!(out.get_pixel(50, 50)[0], 200);
        assert!(out.get_pixel(0, 0)[0] < 40);
    }

    #[test]
    fn pixelate_makes_flat_cells() {
        let img = RgbaImage::from_fn(100, 100, |x, y| Rgba([(x * 2) as u8, (y * 2) as u8, 0, 255]));
        let out = apply_all(&img, &[Op::Pixelate { size: 1.0 }]);
        assert_eq!(out.get_pixel(0, 0), out.get_pixel(9, 9), "a 10px cell should be uniform");
        assert_ne!(out.get_pixel(0, 0), out.get_pixel(10, 0));
    }

    #[test]
    fn noise_is_deterministic_and_keeps_alpha() {
        let a = apply_all(&grey(128), &[Op::Noise { amount: 0.5, mono: false }]);
        let b = apply_all(&grey(128), &[Op::Noise { amount: 0.5, mono: false }]);
        assert_eq!(a, b);
        assert_ne!(a, grey(128));
        assert!(a.pixels().all(|p| p[3] == 200));
    }

    #[test]
    fn shadows_lift_dark_regions_more_than_bright_ones() {
        let mut img = RgbaImage::from_pixel(60, 30, Rgba([30, 30, 30, 255]));
        for y in 0..30 { for x in 30..60 { img.put_pixel(x, y, Rgba([220, 220, 220, 255])); } }
        let out = apply_all(&img, &[Op::ShadowsHighlights { shadows: 1.0, highlights: 0.0 }]);
        let dark_gain = out.get_pixel(5, 15)[0] as i32 - 30;
        let bright_gain = out.get_pixel(55, 15)[0] as i32 - 220;
        assert!(dark_gain > 40, "shadows barely moved: +{dark_gain}");
        assert!(bright_gain < 10, "highlights moved too much: +{bright_gain}");
    }

    #[test]
    fn a_linear_gradient_ramps_across_the_frame() {
        let op = Op::Gradient {
            kind: GradientKind::Linear,
            x0: 0.0, y0: 0.5, x1: 1.0, y1: 0.5,
            from: [0, 0, 0, 255], to: [255, 255, 255, 255],
            opacity: 1.0, blend: Blend::Normal,
        };
        let out = apply_all(&grey(0), &[op]);
        assert!(out.get_pixel(0, 4)[0] < 30);
        assert!(out.get_pixel(7, 4)[0] > 220);
        assert_eq!(out.get_pixel(0, 0)[3], 255, "opaque paint over translucent backdrop");
    }

    #[test]
    fn multiply_blend_darkens() {
        let op = Op::Gradient {
            kind: GradientKind::Radial,
            x0: 0.5, y0: 0.5, x1: 1.0, y1: 1.0,
            from: [128, 128, 128, 255], to: [128, 128, 128, 255],
            opacity: 1.0, blend: Blend::Multiply,
        };
        let img = RgbaImage::from_pixel(8, 8, Rgba([200, 200, 200, 255]));
        let p = apply_all(&img, &[op]).get_pixel(3, 3).0;
        assert!((99..=102).contains(&p[0]), "200 × 0.5 should be ~100, got {}", p[0]);
    }

    #[test]
    fn shapes_fill_and_stroke_where_drawn() {
        let rect = Shape {
            kind: ShapeKind::Rect, x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75,
            fill: Some([255, 0, 0, 255]), stroke: Some([0, 0, 255, 255]), width: 0.05,
        };
        let out = apply_all(&white(100, 100), &[Op::Shapes { items: vec![rect.clone()] }]);
        assert_eq!(out.get_pixel(50, 50).0, [255, 0, 0, 255], "inside is filled");
        assert_eq!(out.get_pixel(25, 50).0, [0, 0, 255, 255], "the edge is stroked");
        assert_eq!(out.get_pixel(5, 5).0, [255, 255, 255, 255], "outside is untouched");

        // Like paint, shapes stay on the subject when the frame rotates.
        let dot = Shape { kind: ShapeKind::Ellipse, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3, fill: Some([0, 0, 0, 255]), stroke: None, width: 0.0 };
        let turned = apply_all(&white(100, 100), &[Op::Rotate { turns: 1 }, Op::Shapes { items: vec![dot] }]);
        assert_eq!(turned.get_pixel(80, 20).0, [0, 0, 0, 255]);
        assert_eq!(turned.get_pixel(20, 20).0, [255, 255, 255, 255]);
    }

    #[test]
    fn v3_ops_round_trip_through_json() {
        let ops = vec![
            Op::Levels { in_black: 0.1, in_white: 0.9, gamma: 1.2, out_black: 0.0, out_white: 1.0 },
            Op::Curves { rgb: vec![0.0, 0.0, 0.5, 0.6, 1.0, 1.0], red: vec![], green: vec![], blue: vec![] },
            Op::Hue { degrees: 30.0 },
            Op::PhotoFilter { color: [236, 138, 0], density: 0.25 },
            Op::Shapes { items: vec![Shape { kind: ShapeKind::Line, x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0, fill: None, stroke: Some([1, 2, 3, 4]), width: 0.01 }] },
        ];
        let json = serde_json::to_string(&ops).unwrap();
        assert_eq!(serde_json::from_str::<Vec<Op>>(&json).unwrap(), ops);
        // Optional fields may be omitted by hand-written manifests.
        let g: Op = serde_json::from_str(r#"{"op":"gradient","kind":"radial","x0":0,"y0":0,"x1":1,"y1":1,"from":[0,0,0,255],"to":[0,0,0,0]}"#).unwrap();
        assert!(matches!(g, Op::Gradient { opacity, blend: Blend::Normal, .. } if opacity == 1.0));
    }
}