mod limits;
mod ops;
mod project;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage};
use limits::{MAX_DOCUMENTS, MAX_EDGE, MAX_PIXELS, MAX_SESSION_BYTES};
use ops::Op;
use project::Layer;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// The tone curve lookup table for flat x,y control points, exposed so the
/// curves editor draws exactly the curve the engine applies.
#[wasm_bindgen]
pub fn curve_lut(points: &[f32]) -> Vec<u8> {
    ops::curve_lut(points).to_vec()
}

fn err(e: impl Into<String>) -> JsValue {
    JsValue::from_str(&e.into())
}

/// How many documents keep a full-size decode resident. The rest hold only
/// their original file bytes and a thumbnail, so thirty open 60 MP images do
/// not need thirty 240 MB buffers.
const DECODED_RESIDENT: usize = 2;

#[wasm_bindgen]
pub struct Editor {
    layers: Vec<Layer>,
    next_id: u32,
    /// Last rendered preview. JS reads this directly out of wasm memory.
    preview: RgbaImage,
    /// Downscaled source, keyed by (layer id, requested max edge). Rescaling a
    /// 24MP source on every slider tick is what makes naive versions of this
    /// feel broken, so we pay for it once per image.
    scaled: Option<(String, u32, RgbaImage)>,
    /// Most recently used first; only these keep their full decode.
    recent: Vec<String>,
}

#[wasm_bindgen]
impl Editor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Editor {
        Editor {
            layers: Vec::new(),
            next_id: 1,
            preview: RgbaImage::new(1, 1),
            scaled: None,
            recent: Vec::new(),
        }
    }

    /// The engine's hard limits as JSON, for the UI's pre-flight checks.
    pub fn limits(&self) -> String {
        limits::as_json()
    }

    /// Returns the new layer's id.
    pub fn add_image(&mut self, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        if self.layers.len() >= MAX_DOCUMENTS {
            return Err(err(format!(
                "Darkroom keeps up to {MAX_DOCUMENTS} images open. Close one from the filmstrip first."
            )));
        }
        limits::check_image_bytes(name, bytes.len()).map_err(err)?;
        let held: u64 = self.layers.iter().map(|l| l.source.len() as u64).sum();
        if held + bytes.len() as u64 > MAX_SESSION_BYTES {
            return Err(err(format!(
                "Opening '{name}' would hold more than {} of images in memory. Close some images first.",
                limits::mib(MAX_SESSION_BYTES)
            )));
        }
        let format = image::guess_format(bytes)
            .map_err(|_| err(format!("'{name}' isn't an image this build can read.")))?;
        let ext = format.extensions_str().first().unwrap_or(&"bin").to_string();

        let id = format!("l{}", self.next_id);
        self.next_id += 1;

        let mut layer = Layer::new(id.clone(), name.to_string(), ext, bytes.to_vec(), Vec::new());
        // Decode eagerly so a corrupt or oversized file fails at import, not
        // three clicks later. The decode stays as the newest resident one.
        layer.decode().map_err(err)?;
        self.layers.push(layer);
        self.touch(&id);
        Ok(id)
    }

    pub fn remove_image(&mut self, id: &str) {
        if let Some(i) = self.layers.iter().position(|l| l.id == id) {
            self.layers[i].wipe();
            self.layers.remove(i);
        }
        self.recent.retain(|r| r != id);
        self.invalidate_cache(id);
    }

    /// Drops every image and zeroes its buffers.
    pub fn clear(&mut self) {
        for l in self.layers.iter_mut() {
            l.wipe();
        }
        self.layers.clear();
        self.recent.clear();
        self.scaled = None;
        self.preview = RgbaImage::new(1, 1);
    }

    pub fn set_ops(&mut self, id: &str, ops_json: &str) -> Result<(), JsValue> {
        let parsed: Vec<Op> =
            serde_json::from_str(ops_json).map_err(|e| err(format!("Bad ops list: {e}")))?;
        limits::check_ops(&parsed).map_err(err)?;
        let layer = self.layer_mut(id)?;
        layer.ops = parsed;
        Ok(())
    }

    pub fn get_ops(&self, id: &str) -> Result<String, JsValue> {
        let layer = self.layer(id)?;
        serde_json::to_string(&layer.ops).map_err(|e| err(e.to_string()))
    }

    /// `[{id, name, width, height, opCount, bytes}]`
    pub fn layers_json(&mut self) -> Result<String, JsValue> {
        let mut out = Vec::new();
        for l in self.layers.iter_mut() {
            let (w, h) = l.dims().map_err(err)?;
            out.push(serde_json::json!({
                "id": l.id, "name": l.name,
                "width": w, "height": h,
                "opCount": l.ops.len(),
                "bytes": l.source.len(),
            }));
        }
        serde_json::to_string(&out).map_err(|e| err(e.to_string()))
    }

    /// Renders `id` at up to `max_dim` on its long edge into the preview buffer.
    /// Read the result via `preview_ptr` / `preview_width` / `preview_height`.
    pub fn render_preview(&mut self, id: &str, max_dim: u32) -> Result<(), JsValue> {
        let base = self.scaled_source(id, max_dim)?.clone();
        let ops = self.layer(id)?.ops.clone();
        self.preview = ops::apply_all(&base, &ops);
        Ok(())
    }

    pub fn preview_ptr(&self) -> *const u8 {
        self.preview.as_raw().as_ptr()
    }
    pub fn preview_width(&self) -> u32 {
        self.preview.width()
    }
    pub fn preview_height(&self) -> u32 {
        self.preview.height()
    }

    /// Small PNG for the filmstrip, with edits applied.
    pub fn thumbnail(&mut self, id: &str, max_dim: u32) -> Result<Vec<u8>, JsValue> {
        let layer = self.layer_mut(id)?;
        let small = layer.thumb_source(max_dim).map_err(err)?.clone();
        let ops = layer.ops.clone();
        encode_png(&ops::apply_all(&small, &ops)).map_err(err)
    }

    /// Full-resolution render. `format` is "png", "jpeg" or "webp" (lossless).
    /// `scale` resizes the finished render, 1.0 being the native size.
    pub fn export(&mut self, id: &str, format: &str, quality: u8, scale: f32) -> Result<Vec<u8>, JsValue> {
        let (tw, th) = self.scaled_dims(id, scale)?;
        let src = self.full(id)?.clone();
        let ops = self.layer(id)?.ops.clone();
        let mut out = ops::apply_all(&src, &ops);
        drop(src);
        if out.dimensions() != (tw, th) {
            out = image::imageops::resize(&out, tw, th, FilterType::Lanczos3);
        }
        match format {
            "png" => encode_png(&out).map_err(err),
            "jpeg" | "jpg" => encode_jpeg(&out, quality.clamp(1, 100)).map_err(err),
            "webp" => encode_webp(&out).map_err(err),
            other => Err(err(format!("Can't export to '{other}'. Use png, jpeg or webp."))),
        }
    }

    pub fn export_name(&self, id: &str, format: &str) -> Result<String, JsValue> {
        let l = self.layer(id)?;
        let stem = l.name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&l.name);
        let ext = match format {
            "png" => "png",
            "webp" => "webp",
            _ => "jpg",
        };
        Ok(format!("{stem}-edited.{ext}"))
    }

    /// `"WIDTHxHEIGHT"` for the current ops at `scale`, computed without
    /// rendering. Lives here so the crop, lasso and resize maths have exactly
    /// one home. Errors when the result would exceed the export limits.
    pub fn output_dims(&mut self, id: &str, scale: f32) -> Result<String, JsValue> {
        let (w, h) = self.scaled_dims(id, scale)?;
        Ok(format!("{w}x{h}"))
    }

    /// Suggested Levels input points for the current edit, as `"black,white"`
    /// in 0..1: the luminance values that clip 0.1% of pixels at each end.
    /// Levels and curves themselves are left out of the measurement, so
    /// pressing Auto twice gives the same answer rather than compounding.
    pub fn auto_levels(&mut self, id: &str) -> Result<String, JsValue> {
        let ops: Vec<Op> = self
            .layer(id)?
            .ops
            .iter()
            .filter(|o| {
                !matches!(o, Op::Levels { .. } | Op::Curves { .. } | Op::Paint { .. } | Op::Shapes { .. } | Op::Gradient { .. })
            })
            .cloned()
            .collect();
        let base = self.scaled_source(id, 512)?.clone();
        let img = ops::apply_all(&base, &ops);
        let mut hist = [0u64; 256];
        let mut total = 0u64;
        for p in img.pixels().filter(|p| p[3] > 0) {
            let l = 0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32;
            hist[(l as usize).min(255)] += 1;
            total += 1;
        }
        if total == 0 {
            return Ok("0,1".into());
        }
        let clip = (total as f64 * 0.001) as u64;
        let pick = |iter: &mut dyn Iterator<Item = usize>| {
            let mut acc = 0;
            for i in iter {
                acc += hist[i];
                if acc > clip {
                    return i;
                }
            }
            0
        };
        let lo = pick(&mut (0..256));
        let hi = pick(&mut (0..256).rev()).max(lo + 1);
        Ok(format!("{},{}", lo as f32 / 255.0, hi as f32 / 255.0))
    }

    pub fn save_bundle(&self) -> Result<Vec<u8>, JsValue> {
        project::write_bundle(&self.layers).map_err(err)
    }

    /// Replaces the current session wholesale, wiping what was there first.
    pub fn load_bundle(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        // Parse and validate before destroying anything, so a bad file leaves
        // your work intact. Each image is decoded once to prove it is sound,
        // then released, so memory peaks at one image rather than all of them.
        let mut loaded = project::read_bundle(bytes).map_err(err)?;
        for l in loaded.iter_mut() {
            l.decode().map_err(err)?;
            l.evict();
        }
        self.clear();
        // Bundle ids are trusted only within their own bundle; renumber so a
        // later import can never collide with one.
        self.next_id = 1;
        for l in loaded.iter_mut() {
            let fresh = format!("l{}", self.next_id);
            self.next_id += 1;
            l.id = fresh;
        }
        self.layers = loaded;
        Ok(())
    }

    // --- internals ---

    fn layer(&self, id: &str) -> Result<&Layer, JsValue> {
        self.layers
            .iter()
            .find(|l| l.id == id)
            .ok_or_else(|| err(format!("No image with id '{id}'.")))
    }

    fn layer_mut(&mut self, id: &str) -> Result<&mut Layer, JsValue> {
        self.layers
            .iter_mut()
            .find(|l| l.id == id)
            .ok_or_else(|| err(format!("No image with id '{id}'.")))
    }

    /// Marks `id` as in use and releases full decodes beyond the resident set.
    fn touch(&mut self, id: &str) {
        self.recent.retain(|r| r != id);
        self.recent.insert(0, id.to_string());
        self.recent.truncate(DECODED_RESIDENT);
        for l in self.layers.iter_mut() {
            if !self.recent.contains(&l.id) {
                l.evict();
            }
        }
    }

    fn full(&mut self, id: &str) -> Result<&RgbaImage, JsValue> {
        self.touch(id);
        self.layer_mut(id)?.decode().map_err(err)
    }

    fn scaled_dims(&mut self, id: &str, scale: f32) -> Result<(u32, u32), JsValue> {
        let (w, h) = self.layer_mut(id)?.dims().map_err(err)?;
        let ops = self.layer(id)?.ops.clone();
        let (ow, oh) = ops::dims_after(w, h, &ops);
        let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
        let (tw, th) = (((ow as f32 * s).round() as u32).max(1), ((oh as f32 * s).round() as u32).max(1));
        if tw > MAX_EDGE || th > MAX_EDGE || tw as u64 * th as u64 > MAX_PIXELS {
            return Err(err(format!(
                "{tw} × {th} is larger than Darkroom can export ({MAX_EDGE} px per edge, {} MP). Choose a smaller size.",
                MAX_PIXELS / 1_000_000
            )));
        }
        Ok((tw, th))
    }

    fn invalidate_cache(&mut self, id: &str) {
        if matches!(&self.scaled, Some((cid, _, _)) if cid == id) {
            self.scaled = None;
        }
    }

    fn scaled_source(&mut self, id: &str, max_dim: u32) -> Result<&RgbaImage, JsValue> {
        let hit = matches!(&self.scaled, Some((cid, cd, _)) if cid == id && *cd == max_dim);
        if !hit {
            let small = fit(self.full(id)?, max_dim, FilterType::Lanczos3);
            self.scaled = Some((id.to_string(), max_dim, small));
        }
        Ok(&self.scaled.as_ref().unwrap().2)
    }
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn fit(img: &RgbaImage, max_dim: u32, filter: FilterType) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= max_dim {
        return img.clone();
    }
    let s = max_dim as f32 / w.max(h) as f32;
    image::imageops::resize(img, ((w as f32 * s) as u32).max(1), ((h as f32 * s) as u32).max(1), filter)
}

fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::new());
    PngEncoder::new(&mut buf)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

fn encode_webp(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::new());
    WebPEncoder::new_lossless(&mut buf)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    // JPEG has no alpha. Compositing onto white rather than letting the encoder
    // discard the channel avoids transparent regions turning black.
    let mut rgb = Vec::with_capacity((img.width() * img.height() * 3) as usize);
    for p in img.pixels() {
        let a = p[3] as f32 / 255.0;
        for c in 0..3 {
            rgb.push((p[c] as f32 * a + 255.0 * (1.0 - a)) as u8);
        }
    }
    let mut buf = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut buf, quality)
        .encode(&rgb, img.width(), img.height(), ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}
