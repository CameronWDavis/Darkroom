//! The `.darkroom` bundle: a plain zip containing a JSON manifest and the
//! original, unmodified source files.
//!
//! Two properties matter here. First, the originals go in byte-for-byte, so a
//! bundle is always a superset of what you imported and an edit can never
//! destroy the source. Second, the manifest is human-readable JSON -- open the
//! zip in any archive tool and you can see exactly what is stored about you,
//! which is the whole point.
//!
//! Reading is the dangerous direction. A bundle is a zip somebody else may
//! have made, so every size it claims is checked against what actually comes
//! out of the decompressor; see `read_entry` and `limits.rs`.

use crate::limits::{
    self, check_ops, mib, MAX_BUNDLE_BYTES, MAX_BUNDLE_ENTRIES, MAX_BUNDLE_INFLATED,
    MAX_COMPRESSION_RATIO, MAX_DOCUMENTS, MAX_IMAGE_BYTES, MAX_MANIFEST_BYTES, RATIO_FLOOR_BYTES,
};
use crate::ops::Op;
use image::{imageops::FilterType, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const FORMAT: &str = "darkroom-project";
/// v2 added the `paint` op; v3 added levels, curves, colour, effects,
/// gradients and shapes. Older bundles still load: serde simply never sees
/// the ops they did not have.
pub const VERSION: u32 = 4;

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
/// imported; `decoded` and `thumb` are caches we can drop at any time.
pub struct Layer {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub source: Vec<u8>,
    pub ops: Vec<Op>,
    pub decoded: Option<RgbaImage>,
    /// Read from the file header, so listing documents never needs a decode.
    dims: Option<(u32, u32)>,
    /// A small copy of the source for filmstrip thumbnails. Without it every
    /// strip refresh would decode every open image at full size.
    thumb: Option<(u32, RgbaImage)>,
}

impl Layer {
    pub fn new(id: String, name: String, ext: String, source: Vec<u8>, ops: Vec<Op>) -> Layer {
        Layer { id, name, ext, source, ops, decoded: None, dims: None, thumb: None }
    }

    pub fn decode(&mut self) -> Result<&RgbaImage, String> {
        if self.decoded.is_none() {
            let img = limits::decode(&self.name, &self.source)?;
            self.dims = Some(img.dimensions());
            self.decoded = Some(img);
        }
        Ok(self.decoded.as_ref().unwrap())
    }

    pub fn dims(&mut self) -> Result<(u32, u32), String> {
        if let Some(d) = self.dims {
            return Ok(d);
        }
        let d = ImageReader::new(Cursor::new(&self.source))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .into_dimensions()
            .map_err(|e| format!("Can't read {}: {e}", self.name))?;
        self.dims = Some(d);
        Ok(d)
    }

    pub fn thumb_source(&mut self, max_dim: u32) -> Result<&RgbaImage, String> {
        if !matches!(&self.thumb, Some((m, _)) if *m == max_dim) {
            let had_full = self.decoded.is_some();
            let small = crate::fit(self.decode()?, max_dim, FilterType::Triangle);
            // Don't let a thumbnail pass leave a full decode resident.
            if !had_full {
                self.evict();
            }
            self.thumb = Some((max_dim, small));
        }
        Ok(&self.thumb.as_ref().unwrap().1)
    }

    /// Drops the full-size decode; the next use decodes again from `source`.
    pub fn evict(&mut self) {
        if let Some(img) = self.decoded.as_mut() {
            img.iter_mut().for_each(|b| *b = 0);
        }
        self.decoded = None;
    }

    /// Overwrite before dropping. This does not guarantee the bytes leave RAM
    /// -- the allocator may already have copied them, and the OS may have
    /// paged them out -- but it removes the obvious in-process copy.
    pub fn wipe(&mut self) {
        self.source.iter_mut().for_each(|b| *b = 0);
        self.source.clear();
        self.source.shrink_to_fit();
        self.evict();
        if let Some((_, t)) = self.thumb.as_mut() {
            t.iter_mut().for_each(|b| *b = 0);
        }
        self.thumb = None;
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
    if bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err(format!(
            "This project is {}. Darkroom opens projects up to {}.",
            mib(bytes.len() as u64),
            mib(MAX_BUNDLE_BYTES)
        ));
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        "That file isn't a project bundle. Open a .darkroom file, or import an image instead."
            .to_string()
    })?;
    // The central directory is parsed eagerly, so a file with millions of
    // entries has already cost its memory by now -- but refusing here stops
    // us walking it, and nothing legitimate looks like that.
    if zip.len() > MAX_BUNDLE_ENTRIES {
        return Err(format!(
            "This bundle holds {} files; a Darkroom project never needs more than {MAX_BUNDLE_ENTRIES}.",
            zip.len()
        ));
    }

    let mut budget = MAX_BUNDLE_INFLATED;
    let manifest: Manifest = {
        let buf = read_entry(&mut zip, "manifest.json", MAX_MANIFEST_BYTES, &mut budget).map_err(|e| {
            e.unwrap_or_else(|| "This zip has no manifest.json, so it isn't a project bundle.".to_string())
        })?;
        let s = String::from_utf8(buf).map_err(|_| "The manifest isn't valid UTF-8.".to_string())?;
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
    if manifest.entries.len() > MAX_DOCUMENTS {
        return Err(format!(
            "This project has {} images. Darkroom opens up to {MAX_DOCUMENTS} at once.",
            manifest.entries.len()
        ));
    }

    let mut layers = Vec::with_capacity(manifest.entries.len());
    for e in manifest.entries {
        check_ops(&e.ops).map_err(|m| format!("'{}': {m}", e.name))?;
        let buf = read_entry(&mut zip, &e.media, MAX_IMAGE_BYTES, &mut budget).map_err(|err| {
            err.unwrap_or_else(|| format!("The bundle is missing {} (referenced by '{}').", e.media, e.name))
        })?;
        let ext = e.media.rsplit('.').next().unwrap_or("bin").to_string();
        layers.push(Layer::new(e.id, e.name, ext, buf, e.ops));
    }
    Ok(layers)
}

/// Reads one entry with every size claim verified against what actually
/// inflates. The sizes in a zip's headers are written by whoever made the
/// file, so they decide nothing on their own: the reader is capped with
/// `take`, and the real output is what gets measured.
///
/// `budget` is what may still come out of the bundle as a whole. `Err(None)`
/// means the entry does not exist, so callers can word that case themselves.
fn read_entry(
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    cap: u64,
    budget: &mut u64,
) -> Result<Vec<u8>, Option<String>> {
    let f = zip.by_name(name).map_err(|e| match e {
        zip::result::ZipError::FileNotFound => None,
        other => Some(format!("Can't read {name} from the bundle: {other}")),
    })?;
    let too_big = || Some(format!("{name} inside this bundle is larger than the {} limit.", mib(cap)));
    let over_budget = || {
        Some(format!(
            "This project expands to more than {} in total, which is over Darkroom's limit.",
            mib(MAX_BUNDLE_INFLATED)
        ))
    };
    let bomb = || {
        Some(format!(
            "{name} inside this bundle expands far more than real media does, so it was refused as a possible zip bomb."
        ))
    };
    let is_bomb = |inflated: u64, packed: u64| {
        inflated > RATIO_FLOOR_BYTES && inflated / packed.max(1) > MAX_COMPRESSION_RATIO
    };

    let declared = f.size();
    let packed = f.compressed_size();
    if declared > cap {
        return Err(too_big());
    }
    if declared > *budget {
        return Err(over_budget());
    }
    if is_bomb(declared, packed) {
        return Err(bomb());
    }

    // The declared size passed every check above, so it is now safe to size
    // the allocation from it. If it was a lie, `take` still stops the read.
    let limit = cap.min(*budget);
    let mut buf = Vec::with_capacity(declared as usize);
    f.take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| Some(format!("Can't read {name} from the bundle: {e}")))?;
    let got = buf.len() as u64;
    if got > limit {
        return Err(if got > cap { too_big() } else { over_budget() });
    }
    if is_bomb(got, packed) {
        return Err(bomb());
    }
    *budget -= got;
    Ok(buf)
}

fn z(e: zip::result::ZipError) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        RgbaImage::from_pixel(w, h, image::Rgba([10, 20, 30, 255]))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn bundle(entries: &[(&str, &[u8], CompressionMethod)]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
        for (name, data, method) in entries {
            zip.start_file(*name, SimpleFileOptions::default().compression_method(*method)).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn manifest(n: usize) -> Vec<u8> {
        let entries: Vec<Entry> = (0..n)
            .map(|i| Entry { id: format!("l{i}"), name: format!("{i}.png"), media: "media/a.png".into(), ops: vec![] })
            .collect();
        serde_json::to_vec(&Manifest { format: FORMAT.into(), version: VERSION, entries }).unwrap()
    }

    #[test]
    fn a_saved_bundle_reads_back() {
        let mut layers = vec![Layer::new("l1".into(), "a.png".into(), "png".into(), png(4, 3), vec![Op::Invert])];
        let bytes = write_bundle(&layers).unwrap();
        let back = read_bundle(&bytes).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].ops, vec![Op::Invert]);
        assert_eq!(back[0].source, layers[0].source);
        assert_eq!(layers[0].dims().unwrap(), (4, 3));
    }

    /// 64 MB of zeros deflates to roughly 64 KB: a 1000:1 bomb. It must be
    /// refused from its header, before anything is inflated.
    #[test]
    fn a_zip_bomb_entry_is_refused() {
        let zeros = vec![0u8; 64 * MIB_USIZE];
        let bytes = bundle(&[
            ("manifest.json", &manifest(1), CompressionMethod::Deflated),
            ("media/a.png", &zeros, CompressionMethod::Deflated),
        ]);
        assert!(bytes.len() < 1024 * 1024, "the bomb should be small on disk");
        let e = read_bundle(&bytes).err().unwrap();
        assert!(e.contains("zip bomb"), "unexpected error: {e}");
    }

    /// The same bomb with its headers rewritten to claim a 1000-byte file.
    /// The header checks all pass, so this exercises the measured path: the
    /// capped read and the ratio of what actually came out.
    #[test]
    fn a_bomb_that_lies_about_its_size_is_refused() {
        let zeros = vec![0u8; 64 * MIB_USIZE];
        let mut bytes = bundle(&[
            ("manifest.json", &manifest(1), CompressionMethod::Stored),
            ("media/a.png", &zeros, CompressionMethod::Deflated),
        ]);
        let mut patched = 0;
        for i in 0..bytes.len() - 4 {
            let sig = u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
            let method = |at: usize| u16::from_le_bytes([bytes[i + at], bytes[i + at + 1]]);
            if sig == 0x0403_4b50 && method(8) == 8 {
                bytes[i + 22..i + 26].copy_from_slice(&1000u32.to_le_bytes());
                patched += 1;
            } else if sig == 0x0201_4b50 && method(10) == 8 {
                bytes[i + 24..i + 28].copy_from_slice(&1000u32.to_le_bytes());
                patched += 1;
            }
        }
        assert_eq!(patched, 2, "expected one local and one central header");
        let e = read_bundle(&bytes).err().unwrap();
        assert!(e.contains("zip bomb"), "unexpected error: {e}");
    }

    #[test]
    fn a_bloated_manifest_is_refused() {
        let mut huge = b"{\"format\":\"darkroom-project\",\"version\":3,\"entries\":[],\"pad\":\"".to_vec();
        huge.extend(std::iter::repeat(b'a').take((MAX_MANIFEST_BYTES + 10) as usize));
        huge.extend(b"\"}");
        let bytes = bundle(&[("manifest.json", &huge, CompressionMethod::Stored)]);
        let e = read_bundle(&bytes).err().unwrap();
        assert!(e.contains("larger than"), "unexpected error: {e}");
    }

    #[test]
    fn too_many_documents_are_refused() {
        let img = png(1, 1);
        let bytes = bundle(&[
            ("manifest.json", &manifest(MAX_DOCUMENTS + 1), CompressionMethod::Deflated),
            ("media/a.png", &img, CompressionMethod::Stored),
        ]);
        let e = read_bundle(&bytes).err().unwrap();
        assert!(e.contains("opens up to"), "unexpected error: {e}");
    }

    #[test]
    fn too_many_zip_entries_are_refused() {
        let names: Vec<String> = (0..MAX_BUNDLE_ENTRIES + 1).map(|i| format!("junk/{i}")).collect();
        let entries: Vec<(&str, &[u8], CompressionMethod)> =
            names.iter().map(|n| (n.as_str(), &b""[..], CompressionMethod::Stored)).collect();
        let e = read_bundle(&bundle(&entries)).err().unwrap();
        assert!(e.contains("never needs more"), "unexpected error: {e}");
    }

    /// The same media entry referenced over and over must not be able to
    /// multiply its size past the session budget.
    #[test]
    fn repeated_references_count_against_the_total() {
        let big = vec![7u8; 30 * MIB_USIZE];
        let bytes = bundle(&[
            ("manifest.json", &manifest(MAX_DOCUMENTS), CompressionMethod::Deflated),
            ("media/a.png", &big, CompressionMethod::Stored),
        ]);
        let e = read_bundle(&bytes).err().unwrap();
        assert!(e.contains("in total"), "unexpected error: {e}");
    }

    const MIB_USIZE: usize = 1024 * 1024;
}
