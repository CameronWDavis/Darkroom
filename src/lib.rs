mod ops;
mod project;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage};
use ops::Op;
use project::Layer;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn err(e: impl Into<String>) -> JsValue {
    JsValue::from_str(&e.into())
}

#[wasm_bindgen]
pub struct Editor {
    layers: Vec<Layer>,
    next_id: u32,
    preview: RgbaImage,
    scaled: Option<(String, u32, RgbaImage)>,
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
        }
    }

    /// Returns the new layer's id.
    pub fn add_image(&mut self, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        let format = image::guess_format(bytes)
            .map_err(|_| err(format!("'{name}' isn't an image this build can read.")))?;
        let ext = format.extensions_str().first().unwrap_or(&"bin").to_string();

        let id = format!("l{}", self.next_id);
        self.next_id += 1;

        let mut layer = Layer {
            id: id.clone(),
            name: name.to_string(),
            ext,
            source: bytes.to_vec(),
            ops: Vec::new(),
            decoded: None,
        };
        layer.decode().map_err(err)?;
        self.layers.push(layer);
        Ok(id)
    }

    pub fn remove_image(&mut self, id: &str) {
        if let Some(i) = self.layers.iter().position(|l| l.id == id) {
            self.layers[i].wipe();
            self.layers.remove(i);
        }
        self.invalidate_cache(id);
    }

    /// Drops every image and zeroes its buffers.
    pub fn clear(&mut self) {
        for l in self.layers.iter_mut() {
            l.wipe();
        }
        self.layers.clear();
        self.scaled = None;
        self.preview = RgbaImage::new(1, 1);
    }

    pub fn set_ops(&mut self, id: &str, ops_json: &str) -> Result<(), JsValue> {
        let parsed: Vec<Op> =
            serde_json::from_str(ops_json).map_err(|e| err(format!("Bad ops list: {e}")))?;
        let layer = self.layer_mut(id)?;
        layer.ops = parsed;
        Ok(())
    }

    pub fn get_ops(&self, id: &str) -> Result<String, JsValue> {
        let layer = self.layer(id)?;
        serde_json::to_string(&layer.ops).map_err(|e| err(e.to_string()))
    }

    /// `[{id, name, width, height, opCount}]`
    pub fn layers_json(&mut self) -> Result<String, JsValue> {
        let mut out = Vec::new();
        for i in 0..self.layers.len() {
            let l = &mut self.layers[i];
            let (w, h) = l.decode().map_err(err)?.dimensions();
            out.push(serde_json::json!({
                "id": l.id, "name": l.name,
                "width": w, "height": h,
                "opCount": l.ops.len(),
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
        let src = self.layer_mut(id)?.decode().map_err(err)?.clone();
        let small = fit(&src, max_dim, FilterType::Triangle);
        let ops = self.layer(id)?.ops.clone();
        encode_png(&ops::apply_all(&small, &ops)).map_err(err)
    }

    /// Full-resolution render. `format` is "png" or "jpeg".
    pub fn export(&mut self, id: &str, format: &str, quality: u8) -> Result<Vec<u8>, JsValue> {
        let src = self.layer_mut(id)?.decode().map_err(err)?.clone();
        let ops = self.layer(id)?.ops.clone();
        let out = ops::apply_all(&src, &ops);
        match format {
            "png" => encode_png(&out).map_err(err),
            "jpeg" | "jpg" => encode_jpeg(&out, quality.clamp(1, 100)).map_err(err),
            other => Err(err(format!("Can't export to '{other}'. Use png or jpeg."))),
        }
    }

    pub fn export_name(&self, id: &str, format: &str) -> Result<String, JsValue> {
        let l = self.layer(id)?;
        let stem = l.name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&l.name);
        let ext = if format == "png" { "png" } else { "jpg" };
        Ok(format!("{stem}-edited.{ext}"))
    }

    pub fn save_bundle(&self) -> Result<Vec<u8>, JsValue> {
        project::write_bundle(&self.layers).map_err(err)
    }

    /// Replaces the current session wholesale, wiping what was there first.
    pub fn load_bundle(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        // Parse before destroying anything, so a bad file leaves your work intact.
        let mut loaded = project::read_bundle(bytes).map_err(err)?;
        for l in loaded.iter_mut() {
            l.decode().map_err(err)?;
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

    fn invalidate_cache(&mut self, id: &str) {
        if matches!(&self.scaled, Some((cid, _, _)) if cid == id) {
            self.scaled = None;
        }
    }

    fn scaled_source(&mut self, id: &str, max_dim: u32) -> Result<&RgbaImage, JsValue> {
        let hit = matches!(&self.scaled, Some((cid, cd, _)) if cid == id && *cd == max_dim);
        if !hit {
            let full = self.layer_mut(id)?.decode().map_err(err)?;
            let small = fit(full, max_dim, FilterType::Lanczos3);
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

fn fit(img: &RgbaImage, max_dim: u32, filter: FilterType) -> RgbaImage {
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