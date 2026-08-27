//! The edit pipeline.
//!
//! Every op here is resolution-independent: geometry is stored in normalized
//! 0..1 coordinates and effect radii are stored as a fraction of the image's
//! short edge. That is what lets the same `Vec<Op>` render identically against
//! a 1200px preview and a 6000px export without any conversion step.

use image::{imageops, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

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
}

/// Applies ops in array order. The caller is responsible for supplying them in
/// a sensible order; the UI enforces geometry -> color -> effects.
pub fn apply_all(src: &RgbaImage, ops: &[Op]) -> RgbaImage {
    let mut img = src.clone();
    for op in ops {
        img = apply_one(img, op);
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
        ];
        let json = serde_json::to_string(&ops).unwrap();
        let back: Vec<Op> = serde_json::from_str(&json).unwrap();
        assert_eq!(ops, back);
    }
}