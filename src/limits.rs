//! Hard ceilings on what the engine will accept.
//!
//! Everything Darkroom opens comes from a file the user picked, but a file can
//! still be hostile or simply enormous. A 40 KB zip can inflate to gigabytes,
//! and a 60 KB PNG can declare a 100 000 × 100 000 canvas of zeros. Inside a
//! 32-bit wasm heap either one ends the tab, so the checks here run *before*
//! any allocation sized by untrusted numbers.
//!
//! The JavaScript side reads these through `Editor::limits()` for its own
//! pre-flight checks, so there is exactly one place to tune them.

use crate::ops::Op;
use image::{ImageReader, Limits, RgbaImage};
use std::io::Cursor;

pub const MIB: u64 = 1024 * 1024;

/// Largest single image file accepted on import or inside a bundle.
pub const MAX_IMAGE_BYTES: u64 = 100 * MIB;
/// Longest edge, in pixels, of a decoded image or an export.
pub const MAX_EDGE: u32 = 16_384;
/// Decoded pixel budget. 64 MP is a 9200 × 6900 frame: room for nearly every
/// camera, while a full-resolution export (source, working copy and output)
/// still fits comfortably in wasm's address space.
pub const MAX_PIXELS: u64 = 64_000_000;
/// Open documents per session, which bounds the filmstrip and the bundle.
pub const MAX_DOCUMENTS: usize = 32;
/// Original files held in memory across all open documents.
pub const MAX_SESSION_BYTES: u64 = 768 * MIB;

/// Largest `.darkroom` file accepted, before it is even opened.
pub const MAX_BUNDLE_BYTES: u64 = 800 * MIB;
/// Entries in the zip's central directory. A real bundle has one per image
/// plus the manifest; anything far beyond that is not one of ours.
pub const MAX_BUNDLE_ENTRIES: usize = MAX_DOCUMENTS * 2 + 72;
/// The manifest is JSON instructions. Long brush sessions are the bulk of it.
pub const MAX_MANIFEST_BYTES: u64 = 16 * MIB;
/// Sum of every inflated entry we read out of one bundle.
pub const MAX_BUNDLE_INFLATED: u64 = MAX_SESSION_BYTES;
/// Inflated-to-compressed ratio past which an entry is treated as a zip bomb.
/// Media is stored, not deflated (ratio ~1), and JSON rarely passes 20:1;
/// classic bombs run at 1000:1 and beyond.
pub const MAX_COMPRESSION_RATIO: u64 = 100;
/// Below this size, ratio is not meaningful (a tiny file of repeated bytes
/// legitimately compresses very well) and cannot hurt anyone.
pub const RATIO_FLOOR_BYTES: u64 = MIB;

/// Upper bounds on edit instructions, so a doctored manifest cannot pin the
/// CPU by asking for a million full-frame shapes.
pub const MAX_STROKES: usize = 5_000;
pub const MAX_STROKE_POINTS: usize = 2_000_000;
pub const MAX_SHAPES: usize = 500;
pub const MAX_GRADIENTS: usize = 64;
pub const MAX_CURVE_POINTS: usize = 64;
pub const MAX_LASSO_POINTS: usize = 200_000;

pub fn mib(bytes: u64) -> String {
    let m = bytes as f64 / MIB as f64;
    if m >= 1024.0 {
        format!("{:.1} GB", m / 1024.0)
    } else if m >= 10.0 {
        format!("{m:.0} MB")
    } else {
        format!("{m:.1} MB")
    }
}

pub fn check_image_bytes(name: &str, len: usize) -> Result<(), String> {
    if len as u64 > MAX_IMAGE_BYTES {
        return Err(format!(
            "'{name}' is {}. Images are limited to {} each.",
            mib(len as u64),
            mib(MAX_IMAGE_BYTES)
        ));
    }
    Ok(())
}

pub fn check_dims(name: &str, w: u32, h: u32) -> Result<(), String> {
    if w == 0 || h == 0 {
        return Err(format!("'{name}' has no pixels."));
    }
    if w > MAX_EDGE || h > MAX_EDGE {
        return Err(format!(
            "'{name}' is {w} × {h}. The longest edge Darkroom can open is {MAX_EDGE} px."
        ));
    }
    if w as u64 * h as u64 > MAX_PIXELS {
        return Err(format!(
            "'{name}' is {:.0} megapixels. Darkroom opens images up to {} megapixels.",
            (w as f64 * h as f64) / 1e6,
            MAX_PIXELS / 1_000_000
        ));
    }
    Ok(())
}

/// Decodes with the dimensions checked from the header *first*, then decodes
/// under an allocation cap as a second line of defence against formats whose
/// header understates what the decoder will actually allocate.
pub fn decode(name: &str, bytes: &[u8]) -> Result<RgbaImage, String> {
    check_image_bytes(name, bytes.len())?;
    let unreadable = |e: image::ImageError| format!("Can't read {name}: {e}");

    let (w, h) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Can't read {name}: {e}"))?
        .into_dimensions()
        .map_err(unreadable)?;
    check_dims(name, w, h)?;

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Can't read {name}: {e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    // RGBA8 output plus the decoder's own working buffers.
    limits.max_alloc = Some(MAX_PIXELS * 4 * 2);
    reader.limits(limits);
    Ok(reader.decode().map_err(unreadable)?.to_rgba8())
}

pub fn check_ops(ops: &[Op]) -> Result<(), String> {
    let mut strokes = 0usize;
    let mut points = 0usize;
    let mut shapes = 0usize;
    let mut gradients = 0usize;
    let mut flattened = Vec::new();
    let mut layer_count = 0;
    for op in ops {
        if let Op::Layer { id, name, opacity, content, transform: t, mask, style, .. } = op {
            layer_count += 1;
            if id.len() > 100 || name.len() > 300 || !opacity.is_finite() || !(0.0..=1.0).contains(opacity) {
                return Err("Invalid layer properties.".into());
            }
            if !matches!(content.as_ref(), Op::Text { .. } | Op::Paint { .. } | Op::Shapes { .. } | Op::Gradient { .. } | Op::Photo { .. } | Op::Adjustment { .. }) {
                return Err("Layers can contain text, paint, shapes or gradients; nested layers are unsupported.".into());
            }
            let range = |v: f32, lo, hi| v.is_finite() && v >= lo && v <= hi;
            if !range(t.tx,-2.,2.) || !range(t.ty,-2.,2.) || !range(t.sx,0.01,10.) || !range(t.sy,0.01,10.) || !range(t.rotation,-360.,360.) || !range(t.anchor_x,0.,1.) || !range(t.anchor_y,0.,1.) { return Err("Invalid layer transform.".into()); }
            if !range(style.shadow_blur,0.,0.05) || !range(style.shadow_x,-0.5,0.5) || !range(style.shadow_y,-0.5,0.5) || !range(style.outline_width,0.,0.05) { return Err("Invalid layer style.".into()); }
            if let Some(m) = mask {
                strokes += m.strokes.len(); points += m.strokes.iter().map(|s| s.points.len()/2).sum::<usize>();
                for s in &m.strokes {
                    if !range(s.width,0.001,1.) || s.erase || s.points.len()%2 != 0 || s.points.iter().any(|v| !range(*v,0.,1.)) { return Err("Invalid mask stroke.".into()); }
                }
            }
            flattened.push(content.as_ref());
        } else { flattened.push(op); }
    }
    if layer_count > 128 { return Err("An image can contain up to 128 overlay layers.".into()); }
    let mut text_chars = 0;
    for op in flattened {
        match op {
            Op::Photo { asset_id, width, height } => {
                if asset_id.is_empty() || asset_id.len()>100 || !width.is_finite() || !height.is_finite() || !(0.001..=1.).contains(width) || !(0.001..=1.).contains(height) { return Err("Invalid photo layer.".into()); }
            }
            Op::Adjustment { exposure, brightness, contrast, saturation, warmth } => {
                if [exposure,brightness,contrast,saturation,warmth].iter().any(|v| !v.is_finite() || v.abs()>1.) { return Err("Invalid adjustment layer.".into()); }
            }
            Op::Text { text, x, y, size, leading, .. } => {
                text_chars += text.chars().count();
                if text.chars().count() > 1000 || text.lines().count() > 50 || !x.is_finite() || !y.is_finite()
                    || !(0.0..=1.0).contains(x) || !(0.0..=1.0).contains(y)
                    || !size.is_finite() || !(0.001..=0.25).contains(size)
                    || !leading.is_finite() || !(0.5..=3.0).contains(leading) {
                    return Err("Text exceeds the supported length, position or size limits.".into());
                }
            }
            Op::BaseOpacity { value } if !value.is_finite() || !(0.0..=1.0).contains(value) => return Err("Invalid background opacity.".into()),
            Op::Paint { strokes: s } => {
                strokes += s.len();
                points += s.iter().map(|s| s.points.len() / 2).sum::<usize>();
            }
            Op::Shapes { items } => shapes += items.len(),
            Op::Gradient { .. } => gradients += 1,
            Op::Lasso { points: p } if p.len() / 2 > MAX_LASSO_POINTS => {
                return Err(format!("A cut-out has more than {MAX_LASSO_POINTS} points."));
            }
            Op::Curves { rgb, red, green, blue } => {
                if [rgb, red, green, blue].iter().any(|c| c.len() / 2 > MAX_CURVE_POINTS) {
                    return Err(format!("A curve has more than {MAX_CURVE_POINTS} points."));
                }
            }
            _ => {}
        }
    }
    if text_chars > 4000 { return Err("An image can contain up to 4000 text characters.".into()); }
    if strokes > MAX_STROKES || points > MAX_STROKE_POINTS {
        return Err(format!(
            "Too much brushwork on one image ({strokes} strokes, {points} points). \
             The limit is {MAX_STROKES} strokes and {MAX_STROKE_POINTS} points."
        ));
    }
    if shapes > MAX_SHAPES {
        return Err(format!("Too many shapes on one image ({shapes}). The limit is {MAX_SHAPES}."));
    }
    if gradients > MAX_GRADIENTS {
        return Err(format!("Too many gradients on one image ({gradients}). The limit is {MAX_GRADIENTS}."));
    }
    Ok(())
}

/// The numbers the UI needs for its own pre-flight checks and messages.
pub fn as_json() -> String {
    serde_json::json!({
        "maxImageBytes": MAX_IMAGE_BYTES,
        "maxBundleBytes": MAX_BUNDLE_BYTES,
        "maxSessionBytes": MAX_SESSION_BYTES,
        "maxDocuments": MAX_DOCUMENTS,
        "maxEdge": MAX_EDGE,
        "maxPixels": MAX_PIXELS,
        "maxShapes": MAX_SHAPES,
        "maxGradients": MAX_GRADIENTS,
        "maxStrokes": MAX_STROKES,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversize_dimensions_are_refused_before_decoding() {
        assert!(check_dims("x", MAX_EDGE + 1, 10).is_err());
        assert!(check_dims("x", 10_000, 10_000).is_err(), "100 MP exceeds the pixel budget");
        assert!(check_dims("x", 8_000, 8_000).is_ok());
        assert!(check_dims("x", 0, 10).is_err());
    }

    /// A PNG header claiming a canvas far beyond the budget must be rejected
    /// from the header alone, without allocating the canvas.
    #[test]
    fn a_decompression_bomb_png_is_refused() {
        // A tiny real image, then rewrite its IHDR to claim 60000 × 60000.
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0u8; 4], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        // IHDR width/height live at bytes 16..24; its CRC covers 12..29.
        png[16..20].copy_from_slice(&60_000u32.to_be_bytes());
        png[20..24].copy_from_slice(&60_000u32.to_be_bytes());
        let crc = crc32(&png[12..29]);
        png[29..33].copy_from_slice(&crc.to_be_bytes());
        let e = decode("bomb.png", &png).unwrap_err();
        assert!(e.contains("16384"), "unexpected error: {e}");
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut c = !0u32;
        for &b in bytes {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }

    #[test]
    fn oversize_files_are_refused() {
        assert!(check_image_bytes("x", (MAX_IMAGE_BYTES + 1) as usize).is_err());
        assert!(check_image_bytes("x", 10).is_ok());
    }

    use image::ImageEncoder;
}
