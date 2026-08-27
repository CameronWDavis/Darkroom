//! The `.darkroom` bundle: a plain zip containing a JSON manifest and the
//! original, unmodified source files.
//!

use crate::ops::Op;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const FORMAT: &str = "darkroom-project";
pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub media: String,
    pub ops: Vec<Op>,
}

/// Runtime state for one imported image. `source` is the untouched file as
/// imported; `decoded` is a lazily-populated cache we can drop at any time.
pub struct Layer {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub source: Vec<u8>,
    pub ops: Vec<Op>,
    pub decoded: Option<RgbaImage>,
}

impl Layer {
    pub fn decode(&mut self) -> Result<&RgbaImage, String> {
        if self.decoded.is_none() {
            let img = image::load_from_memory(&self.source)
                .map_err(|e| format!("Can't read {}: {e}", self.name))?
                .to_rgba8();
            self.decoded = Some(img);
        }
        Ok(self.decoded.as_ref().unwrap())
    }

    /// Overwrite before dropping. This does not guarantee the bytes leave RAM
    /// -- the allocator may already have copied them, and the OS may have
    /// paged them out -- but it removes the obvious in-process copy.
    pub fn wipe(&mut self) {
        self.source.iter_mut().for_each(|b| *b = 0);
        self.source.clear();
        self.source.shrink_to_fit();
        if let Some(img) = self.decoded.as_mut() {
            img.iter_mut().for_each(|b| *b = 0);
        }
        self.decoded = None;
    }
}

pub fn write_bundle(layers: &[Layer]) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::<u8>::new()));

    // Media is already compressed (PNG/JPEG/WebP). Deflating it again costs
    // real time in wasm and buys back roughly nothing.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut entries = Vec::with_capacity(layers.len());
    for l in layers {
        let path = format!("media/{}.{}", l.id, l.ext);
        zip.start_file(&path, stored).map_err(z)?;
        zip.write_all(&l.source).map_err(|e| e.to_string())?;
        entries.push(Entry {
            id: l.id.clone(),
            name: l.name.clone(),
            media: path,
            ops: l.ops.clone(),
        });
    }

    let manifest = Manifest { format: FORMAT.into(), version: VERSION, entries };
    zip.start_file("manifest.json", deflated).map_err(z)?;
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.write_all(&json).map_err(|e| e.to_string())?;

    Ok(zip.finish().map_err(z)?.into_inner())
}

pub fn read_bundle(bytes: &[u8]) -> Result<Vec<Layer>, String> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        "That file isn't a project bundle. Open a .darkroom file, or import an image instead."
            .to_string()
    })?;

    let manifest: Manifest = {
        let mut f = zip
            .by_name("manifest.json")
            .map_err(|_| "This zip has no manifest.json, so it isn't a project bundle.".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| format!("The manifest is malformed: {e}"))?
    };

    if manifest.format != FORMAT {
        return Err(format!("Unrecognized project format '{}'.", manifest.format));
    }
    if manifest.version > VERSION {
        return Err(format!(
            "This project was saved by a newer version (v{}). This build reads up to v{VERSION}.",
            manifest.version
        ));
    }

    let mut layers = Vec::with_capacity(manifest.entries.len());
    for e in manifest.entries {
        let mut f = zip
            .by_name(&e.media)
            .map_err(|_| format!("The bundle is missing {} (referenced by '{}').", e.media, e.name))?;
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let ext = e.media.rsplit('.').next().unwrap_or("bin").to_string();
        layers.push(Layer { id: e.id, name: e.name, ext, source: buf, ops: e.ops, decoded: None });
    }
    Ok(layers)
}

fn z(e: zip::result::ZipError) -> String {
    e.to_string()
}