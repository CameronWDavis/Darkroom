//! Darkroom's PDF workspace engine.
//!
//! A thin WebAssembly bridge over PdfCraft's library crates (MIT OR Apache-2.0,
//! <https://github.com/storytold/pdfcraft>): its engine session opens, edits, undoes and saves
//! documents, and its renderer draws pages and reads their text. Everything here is
//! translation: JSON from the UI into engine edits, and document state back out as JSON.
//!
//! Geometry crosses the bridge in *view space*: PDF points from the top-left of the displayed
//! page, y down, after the page's `/Rotate`. The engine works in PDF user space; the
//! conversions live in this file only.

use std::collections::HashMap;
use std::sync::Arc;

use pdfcraft_engine::{
    Changes, DocId, Edit, FieldValue, FillMark, FormField, FormFieldKind, LineEnding, Markup, NewAnnotation, NoteIcon, Printing,
    Protection, Shape, StampGroup, StampKind, Style,
};
use pdfcraft_render::{PageInfo, PageRenderer, PageText, RenderConfig, RenderRequest, RequestKind};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Largest page raster handed to the UI, in pixels. A page is drawn at the zoom it is shown at,
/// so this only bites at extreme magnification of very large pages.
const MAX_RENDER_PIXELS: f32 = 40_000_000.0;
/// Author written into comments when the UI names none.
const AUTHOR: &str = "Darkroom";

// Errors are plain strings: wasm-bindgen throws them in JavaScript, and they stay usable in
// native tests, where touching a `JsValue` would panic.
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn bad(m: &str) -> String {
    m.to_string()
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Every open PDF and the caches derived from them.
#[wasm_bindgen]
pub struct PdfStudio {
    session: pdfcraft_engine::Session,
    /// Renderers keyed by document, rebuilt when the displayed bytes change.
    renderers: HashMap<u64, (Arc<Vec<u8>>, PageRenderer)>,
    /// Page text keyed by (document, page), valid for one version of the displayed bytes.
    texts: HashMap<(u64, usize), (Arc<Vec<u8>>, Arc<PageText>)>,
}

impl Default for PdfStudio {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl PdfStudio {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PdfStudio {
        PdfStudio { session: pdfcraft_engine::Session::new(), renderers: HashMap::new(), texts: HashMap::new() }
    }

    /// Opens a PDF. Fails with `password-required` or `password-wrong` for protected files.
    pub fn open(&mut self, name: &str, bytes: &[u8], password: Option<String>) -> Result<String, String> {
        let id = self.session.open(name, None, Arc::new(bytes.to_vec()), password.as_deref()).map_err(|e| {
            let text = format!("{e}");
            if text.contains("protected by a password") {
                bad("password-required")
            } else if text.contains("password is incorrect") {
                bad("password-wrong")
            } else {
                err(e)
            }
        })?;
        self.state(id.0 as f64)
    }

    /// A new document of `pages` blank pages, `width` × `height` points.
    pub fn blank(&mut self, name: &str, width: f64, height: f64, pages: usize) -> Result<String, String> {
        let bytes = self.session.create_blank(width, height, pages.clamp(1, 500)).map_err(err)?;
        let id = self.session.open_new(name, bytes).map_err(err)?;
        self.state(id.0 as f64)
    }

    pub fn close(&mut self, id: f64) {
        let id = id as u64;
        self.session.close(DocId(id));
        self.renderers.remove(&id);
        self.texts.retain(|k, _| k.0 != id);
    }

    /// Everything the UI shows about a document, as JSON.
    pub fn state(&self, id: f64) -> Result<String, String> {
        let doc = self.doc(id)?;
        let info = &doc.info;
        let pages: Vec<Value> = info.pages.iter().map(|p| json!({ "w": p.width, "h": p.height, "label": p.label, "rotation": p.rotation })).collect();
        let view = |page: usize, r: [f32; 4]| info.pages.get(page).map(|p| rect_to_view(p, r));
        let comments: Vec<Value> = info
            .annotations
            .iter()
            .filter(|c| !matches!(c.subtype.as_str(), "Popup" | "Link" | "Widget"))
            .map(|c| {
                json!({
                    "page": c.page, "index": c.index, "type": c.subtype, "author": c.author, "contents": c.contents,
                    "modified": c.modified, "id": c.name, "reply_to": c.in_reply_to, "state": c.state,
                    "rect": view(c.page, c.rect), "color": c.color, "locked": c.locked, "intent": c.intent,
                })
            })
            .collect();
        let fields: Vec<Value> = doc.form.iter().map(|f| field_json(f, info)).collect();
        let security = doc.security_summary().map(|s| json!({ "method": s.method, "owner": s.owner, "pending": s.pending }));
        Ok(json!({
            "id": doc.id.0,
            "name": doc.name,
            "dirty": doc.dirty,
            "editable": doc.editable(),
            "read_only_reason": doc.read_only_reason,
            "undo": doc.can_undo(),
            "redo": doc.can_redo(),
            "pages": pages,
            "info": {
                "title": doc.info_value("Title"), "author": doc.info_value("Author"), "subject": doc.info_value("Subject"),
                "keywords": doc.info_value("Keywords"), "creator": info.creator, "producer": info.producer,
                "version": info.pdf_version, "size": info.file_size, "encrypted": info.encrypted,
            },
            "allows": {
                "modify": doc.allows_modification(), "annotate": doc.allows_annotation(), "fill": doc.allows_form_filling(),
                "assemble": doc.allows_assembly(), "print": doc.allows_printing(), "security": doc.allows_security_change(),
            },
            "security": security,
            "comments": comments,
            "fields": fields,
            "redactions": doc.redaction_marks(),
            "warnings": info.warnings,
        })
        .to_string())
    }

    /// Page `page` at `scale` pixels per point, composited onto white. The first eight bytes
    /// are the width and height as little-endian `u32`s; RGBA rows follow.
    pub fn render(&mut self, id: f64, page: usize, scale: f32) -> Result<Vec<u8>, String> {
        let doc = self.doc(id)?;
        let info = doc.info.pages.get(page).ok_or_else(|| bad("No such page."))?;
        let area = (info.width * info.height).max(1.0);
        let scale = scale.clamp(0.05, 16.0).min((MAX_RENDER_PIXELS / area).sqrt());
        let out = self.renderer(id)?.render(RenderRequest { page, kind: RequestKind::Pixels, tile: None, scale, tag: 0 });
        if let Some(e) = out.error {
            return Err(bad(&format!("Page {} could not be drawn: {e}", page + 1)));
        }
        let mut bytes = Vec::with_capacity(8 + out.rgba.len());
        bytes.extend_from_slice(&out.width.to_le_bytes());
        bytes.extend_from_slice(&out.height.to_le_bytes());
        // Premultiplied over white: c + (1 - a) · 255 per channel.
        for p in out.rgba.chunks_exact(4) {
            let rest = 255 - p[3];
            bytes.extend_from_slice(&[p[0].saturating_add(rest), p[1].saturating_add(rest), p[2].saturating_add(rest), 255]);
        }
        Ok(bytes)
    }

    /// The page's text layer: `{ glyphs: [[x0, y0, x1, y1], …], text: [...], line: [...], space: [...] }`.
    pub fn text(&mut self, id: f64, page: usize) -> Result<String, String> {
        let t = self.page_text(id, page)?;
        let glyphs: Vec<[f32; 4]> = t.glyphs.iter().map(|g| g.rect).collect();
        let text: Vec<&str> = t.glyphs.iter().map(|g| g.text.as_str()).collect();
        Ok(json!({ "glyphs": glyphs, "text": text, "line": t.line_of, "space": t.space_before }).to_string())
    }

    /// Search every page: `[{ page, text, rects: [[x0, y0, x1, y1], …] }, …]` in view space.
    pub fn find(&mut self, id: f64, query: &str, case_sensitive: bool, whole_words: bool) -> Result<String, String> {
        let n = self.doc(id)?.info.pages.len();
        let mut hits = Vec::new();
        for page in 0..n {
            let t = self.page_text(id, page)?;
            for r in t.find_opts(query, case_sensitive, whole_words) {
                hits.push(json!({ "page": page, "text": t.text_of(r.clone()), "rects": t.line_rects(r) }));
                if hits.len() >= 5000 {
                    return Ok(Value::Array(hits).to_string());
                }
            }
        }
        Ok(Value::Array(hits).to_string())
    }

    /// Applies one edit described as JSON (see `translate`) and returns the new state.
    pub fn edit(&mut self, id: f64, json: &str) -> Result<String, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| bad(&format!("Bad edit: {e}")))?;
        let edit = self.translate(id, &v)?;
        self.apply(id, edit)
    }

    /// Inserts pages of another PDF at `at` (all of them when `pages` is empty).
    pub fn insert_pdf(&mut self, id: f64, name: &str, bytes: &[u8], at: usize, password: Option<String>) -> Result<String, String> {
        let bytes = Arc::new(bytes.to_vec());
        let mut source = bytes.clone();
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            // The engine inserts from unencrypted bytes: open the source with its password and
            // take a decrypted full copy.
            let tmp = self.session.open(name, None, bytes, Some(&pw)).map_err(err)?;
            let plain = self.session.save_full_bytes(tmp);
            self.session.close(tmp);
            source = plain.map_err(err)?;
        }
        let edit = Edit::InsertPagesFrom { name: name.to_string(), bytes: source, pages: None, at };
        self.apply(id, edit)
    }

    /// Places a picture (PNG or JPEG) as page content at `rect` (view space), or centred at its
    /// natural size when `rect` is empty.
    pub fn add_image(&mut self, id: f64, page: usize, rect: &[f64], name: &str, bytes: &[u8]) -> Result<String, String> {
        let height = self.doc(id)?.info.pages.get(page).ok_or_else(|| bad("No such page."))?.height as f64;
        let rect = <[f64; 4]>::try_from(rect).ok().map(|r| to_display(r, height));
        let edit = Edit::AddImage { page, rect, name: name.to_string(), bytes: Arc::new(bytes.to_vec()) };
        self.apply(id, edit)
    }

    pub fn undo(&mut self, id: f64) -> Result<String, String> {
        self.session.undo(DocId(id as u64)).map_err(err)?;
        self.state(id)
    }

    pub fn redo(&mut self, id: f64) -> Result<String, String> {
        self.session.redo(DocId(id as u64)).map_err(err)?;
        self.state(id)
    }

    /// The document as it should be saved. Unchanged bytes are appended to, so the original
    /// file stays intact inside the result; protection changes rewrite it in full.
    pub fn save(&mut self, id: f64) -> Result<Vec<u8>, String> {
        let doc_id = DocId(id as u64);
        let bytes = self.session.save_bytes(doc_id).map_err(err)?;
        self.session.mark_saved(doc_id, bytes.clone(), None).map_err(err)?;
        Ok(bytes.as_ref().clone())
    }

    /// A new PDF of the given 0-based pages, links and form fields intact.
    pub fn extract(&self, id: f64, pages: &[u32]) -> Result<Vec<u8>, String> {
        let pages: Vec<usize> = pages.iter().map(|p| *p as usize).collect();
        Ok(self.session.extract(DocId(id as u64), &pages).map_err(err)?.as_ref().clone())
    }
}

// --- internals ------------------------------------------------------------------------------

fn rect_to_view(p: &PageInfo, r: [f32; 4]) -> [f32; 4] {
    let (a, b) = (p.user_to_view(r[0], r[1]), p.user_to_view(r[2], r[3]));
    [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])]
}
fn to_user(p: &PageInfo, x: f64, y: f64) -> [f64; 2] {
    let [ux, uy] = p.view_to_user(x as f32, y as f32);
    [ux as f64, uy as f64]
}
fn rect_to_user(p: &PageInfo, r: [f64; 4]) -> [f64; 4] {
    let (a, b) = (to_user(p, r[0], r[1]), to_user(p, r[2], r[3]));
    [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])]
}
/// View space to the engine's "display space" for added content: the displayed page, y up.
fn to_display(r: [f64; 4], page_height: f64) -> [f64; 4] {
    [r[0].min(r[2]), page_height - r[1].max(r[3]), r[0].max(r[2]), page_height - r[1].min(r[3])]
}
fn quad(p: &PageInfo, r: [f64; 4]) -> [f64; 8] {
    p.view_rect_to_quad([r[0] as f32, r[1] as f32, r[2] as f32, r[3] as f32])
}

fn field_json(f: &FormField, info: &pdfcraft_render::DocInfo) -> Value {
    let kind = match f.kind {
        FormFieldKind::Text => "text",
        FormFieldKind::CheckBox => "checkbox",
        FormFieldKind::Radio => "radio",
        FormFieldKind::PushButton => "button",
        FormFieldKind::Combo => "combo",
        FormFieldKind::List => "list",
        FormFieldKind::Signature => "signature",
    };
    let widgets: Vec<Value> = f
        .widgets
        .iter()
        .filter_map(|w| {
            let page = w.page?;
            let p = info.pages.get(page)?;
            let r = w.rect.map(|v| v as f32);
            Some(json!({ "page": page, "rect": rect_to_view(p, r), "on": w.on_state, "state": w.state, "hidden": w.hidden }))
        })
        .collect();
    json!({
        "name": f.name, "kind": kind, "value": f.value, "options": f.options, "read_only": f.read_only(),
        "multiline": f.has(pdfcraft_engine::field_flags::MULTILINE), "max_len": f.max_len, "tooltip": f.tooltip, "widgets": widgets,
    })
}

fn color(v: &Value) -> Option<[f64; 3]> {
    let s = v.as_str()?.trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let c = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).ok().map(|b| b as f64 / 255.0);
    Some([c(0)?, c(2)?, c(4)?])
}

/// Typed accessors for an edit's JSON arguments, with messages the UI can show.
struct Args<'a>(&'a Value);
impl Args<'_> {
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.get(k).filter(|v| !v.is_null())
    }
    fn str(&self, k: &str) -> Result<&str, String> {
        self.get(k).and_then(Value::as_str).ok_or_else(|| bad(&format!("Missing {k}.")))
    }
    fn num(&self, k: &str) -> Result<f64, String> {
        self.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).ok_or_else(|| bad(&format!("Missing {k}.")))
    }
    fn opt_num(&self, k: &str) -> Option<f64> {
        self.get(k).and_then(Value::as_f64).filter(|v| v.is_finite())
    }
    fn usize(&self, k: &str) -> Result<usize, String> {
        self.get(k).and_then(Value::as_u64).map(|v| v as usize).ok_or_else(|| bad(&format!("Missing {k}.")))
    }
    fn bool(&self, k: &str) -> bool {
        self.get(k).and_then(Value::as_bool).unwrap_or(false)
    }
    fn nums<const N: usize>(&self, k: &str) -> Result<[f64; N], String> {
        let v: Option<Vec<f64>> = self.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_f64).collect());
        v.and_then(|v| <[f64; N]>::try_from(v).ok()).ok_or_else(|| bad(&format!("{k} must be {N} numbers.")))
    }
    fn pages(&self, k: &str, count: usize) -> Result<Vec<usize>, String> {
        let v: Vec<usize> = self.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).map(|p| p as usize).collect()).unwrap_or_default();
        if v.is_empty() || v.iter().any(|p| *p >= count) {
            return Err(bad("Choose pages that are in the document."));
        }
        Ok(v)
    }
    fn points(&self, k: &str, p: &PageInfo) -> Result<Vec<[f64; 2]>, String> {
        let a = self.get(k).and_then(Value::as_array).ok_or_else(|| bad(&format!("Missing {k}.")))?;
        a.iter()
            .map(|q| match q.as_array().map(|q| q.iter().filter_map(Value::as_f64).collect::<Vec<_>>()).as_deref() {
                Some([x, y]) => Ok(to_user(p, *x, *y)),
                _ => Err(bad("Points must be [x, y] pairs.")),
            })
            .collect()
    }
}

impl PdfStudio {
    fn doc(&self, id: f64) -> Result<&pdfcraft_engine::Document, String> {
        self.session.get(DocId(id as u64)).ok_or_else(|| bad("That document is no longer open."))
    }

    fn renderer(&mut self, id: f64) -> Result<&mut PageRenderer, String> {
        let doc = self.session.get(DocId(id as u64)).ok_or_else(|| bad("That document is no longer open."))?;
        let fresh = || {
            let config = RenderConfig { password: doc.password.as_deref().map(Arc::from), ..Default::default() };
            (doc.display.clone(), PageRenderer::new(doc.display.clone(), config))
        };
        let entry = self.renderers.entry(id as u64).or_insert_with(fresh);
        if !Arc::ptr_eq(&entry.0, &doc.display) {
            *entry = fresh();
        }
        Ok(&mut entry.1)
    }

    fn page_text(&mut self, id: f64, page: usize) -> Result<Arc<PageText>, String> {
        let display = self.doc(id)?.display.clone();
        if let Some((bytes, t)) = self.texts.get(&(id as u64, page)) {
            if Arc::ptr_eq(bytes, &display) {
                return Ok(t.clone());
            }
        }
        let out = self.renderer(id)?.render(RenderRequest { page, kind: RequestKind::Text, tile: None, scale: 1.0, tag: 0 });
        let text = out.text.unwrap_or_default();
        self.texts.insert((id as u64, page), (display, text.clone()));
        Ok(text)
    }

    fn apply(&mut self, id: f64, edit: Edit) -> Result<String, String> {
        self.session.apply(DocId(id as u64), edit).map_err(err)?;
        self.state(id)
    }

    fn page_info(&self, id: f64, a: &Args) -> Result<(usize, PageInfo), String> {
        let page = a.usize("page")?;
        let p = self.doc(id)?.info.pages.get(page).cloned().ok_or_else(|| bad("No such page."))?;
        Ok((page, p))
    }

    /// One UI edit as an engine edit. Pages are 0-based; geometry is view space.
    fn translate(&mut self, id: f64, v: &Value) -> Result<Edit, String> {
        let a = Args(v);
        let count = self.doc(id)?.info.pages.len();
        let author = a.get("author").and_then(Value::as_str).unwrap_or(AUTHOR).to_string();
        Ok(match a.str("op")? {
            // --- pages
            "rotate" => Edit::RotatePages { pages: a.pages("pages", count)?, degrees: a.num("degrees")? as i64 },
            "delete" => {
                let pages = a.pages("pages", count)?;
                if pages.len() >= count {
                    return Err(bad("A PDF needs at least one page. Keep one, or insert a blank page first."));
                }
                Edit::DeletePages { pages }
            }
            "move" => Edit::MovePages { pages: a.pages("pages", count)?, to: a.usize("to")?.min(count) },
            "duplicate" => Edit::DuplicatePages { pages: a.pages("pages", count)? },
            "insert_blank" => {
                let at = a.usize("at")?.min(count);
                let like = self.doc(id)?.info.pages.get(at.saturating_sub(1)).map(|p| (p.width as f64, p.height as f64)).unwrap_or((612.0, 792.0));
                Edit::InsertBlankPage { at, width: a.opt_num("width").unwrap_or(like.0), height: a.opt_num("height").unwrap_or(like.1) }
            }
            // --- comments and markup
            "comment" => {
                let (page, p) = self.page_info(id, &a)?;
                let kind = a.str("type")?;
                let shape = match kind {
                    "highlight" | "underline" | "strikeout" | "squiggly" => {
                        let markup = match kind {
                            "highlight" => Markup::Highlight,
                            "underline" => Markup::Underline,
                            "strikeout" => Markup::StrikeOut,
                            _ => Markup::Squiggly,
                        };
                        let rects = a.get("rects").and_then(Value::as_array).ok_or_else(|| bad("Select text to mark."))?;
                        let quads: Vec<[f64; 8]> = rects
                            .iter()
                            .filter_map(|r| r.as_array().map(|r| r.iter().filter_map(Value::as_f64).collect::<Vec<_>>()))
                            .filter_map(|r| <[f64; 4]>::try_from(r).ok())
                            .map(|r| quad(&p, r))
                            .collect();
                        if quads.is_empty() {
                            return Err(bad("Select text to mark."));
                        }
                        Shape::TextMarkup { kind: markup, quads }
                    }
                    "note" => {
                        let [x, y] = a.nums::<2>("at")?;
                        let r = rect_to_user(&p, [x, y, x + pdfcraft_engine::NOTE_SIZE, y + pdfcraft_engine::NOTE_SIZE]);
                        let icon = a.get("icon").and_then(Value::as_str).and_then(NoteIcon::from_name).unwrap_or(NoteIcon::Comment);
                        Shape::Note { at: [r[0], r[3]], icon }
                    }
                    "rectangle" => Shape::Rectangle { rect: rect_to_user(&p, a.nums::<4>("rect")?) },
                    "oval" => Shape::Oval { rect: rect_to_user(&p, a.nums::<4>("rect")?) },
                    "textbox" => Shape::TextBox { rect: rect_to_user(&p, a.nums::<4>("rect")?), font_size: a.opt_num("font_size").unwrap_or(12.0).clamp(4.0, 144.0) },
                    "line" | "arrow" => {
                        let (f, t) = (a.nums::<2>("from")?, a.nums::<2>("to")?);
                        let end = if kind == "arrow" { LineEnding::OpenArrow } else { LineEnding::None };
                        Shape::Line { from: to_user(&p, f[0], f[1]), to: to_user(&p, t[0], t[1]), start: LineEnding::None, end }
                    }
                    "ink" => {
                        let strokes = a.get("strokes").and_then(Value::as_array).ok_or_else(|| bad("Missing strokes."))?;
                        let strokes = strokes.iter().map(|s| Args(&json!({ "p": s })).points("p", &p)).collect::<Result<Vec<_>, _>>()?;
                        Shape::Ink { strokes: strokes.into_iter().filter(|s| !s.is_empty()).collect() }
                    }
                    "polygon" | "cloud" => Shape::Polygon { vertices: a.points("points", &p)?, cloud: kind == "cloud" },
                    "stamp" => {
                        let want = a.get("stamp").and_then(Value::as_str).unwrap_or("Approved").to_ascii_lowercase().replace(' ', "");
                        let stamp = StampKind::ALL
                            .into_iter()
                            .find(|k| k.group() != StampGroup::Dynamic && k.label().to_ascii_lowercase().replace(' ', "") == want)
                            .ok_or_else(|| bad("Unknown stamp."))?;
                        let (w, h) = stamp.size();
                        let [x, y] = a.nums::<2>("at")?;
                        Shape::Stamp { rect: rect_to_user(&p, [x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0]), stamp, by: None }
                    }
                    other => return Err(bad(&format!("Unknown comment type {other}."))),
                };
                let mut style = Style::default_for(&shape);
                if let Some(c) = a.get("color").and_then(color) {
                    style.color = c;
                }
                if let Some(f) = a.get("fill") {
                    style.fill = color(f);
                }
                if let Some(o) = a.opt_num("opacity") {
                    style.opacity = o.clamp(0.05, 1.0);
                }
                if let Some(w) = a.opt_num("width") {
                    style.width = w.clamp(0.0, 24.0);
                }
                let contents = a.get("contents").and_then(Value::as_str).unwrap_or("").to_string();
                Edit::AddAnnotation(NewAnnotation { page, shape, style, contents, author })
            }
            "comment_delete" => Edit::DeleteAnnotation { page: a.usize("page")?, index: a.usize("index")? },
            "comment_text" => Edit::SetAnnotationContents { page: a.usize("page")?, index: a.usize("index")?, text: a.str("text")?.to_string() },
            "comment_move" => {
                let (page, p) = self.page_info(id, &a)?;
                // A displacement in view space as one in user space.
                let (o, d) = (to_user(&p, 0.0, 0.0), to_user(&p, a.num("dx")?, a.num("dy")?));
                Edit::MoveAnnotation { page, index: a.usize("index")?, dx: d[0] - o[0], dy: d[1] - o[1] }
            }
            "comment_reply" => Edit::ReplyToAnnotation { page: a.usize("page")?, index: a.usize("index")?, text: a.str("text")?.to_string(), author },
            // --- forms
            "field" => {
                let name = a.str("name")?.to_string();
                let doc = self.doc(id)?;
                let f = doc.form.iter().find(|f| f.name == name).ok_or_else(|| bad("No such form field."))?;
                let raw = a.get("value");
                let text = || raw.and_then(Value::as_str).unwrap_or("").to_string();
                let value = match f.kind {
                    FormFieldKind::Text => FieldValue::Text(text()),
                    FormFieldKind::CheckBox => FieldValue::Check(raw.and_then(Value::as_bool).unwrap_or(false)),
                    FormFieldKind::Radio => FieldValue::Radio(raw.and_then(Value::as_str).map(str::to_string)),
                    FormFieldKind::Combo | FormFieldKind::List => FieldValue::Choice(match raw {
                        Some(Value::Array(v)) => v.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
                        _ => Vec::new(),
                    }),
                    _ => return Err(bad("That field can't be filled in here.")),
                };
                Edit::SetFieldValue { name, value }
            }
            "reset_form" => Edit::ResetForm { names: None },
            // --- fill & sign
            "type" => {
                let (page, p) = self.page_info(id, &a)?;
                let [x, y] = a.nums::<2>("at")?;
                let text = a.str("text")?.to_string();
                let size = a.opt_num("size").unwrap_or(10.0).clamp(4.0, 96.0);
                let at = to_user(&p, x, y);
                let shape = Shape::Typewriter { rect: text_box_rect(at, &text, size), font_size: size };
                let mut style = Style::default_for(&shape);
                if let Some(c) = a.get("color").and_then(color) {
                    style.color = c;
                }
                Edit::AddAnnotation(NewAnnotation { page, shape, style, contents: text, author })
            }
            "mark" => {
                let (page, p) = self.page_info(id, &a)?;
                let mark = match a.str("mark")? {
                    "check" => FillMark::Check,
                    "cross" => FillMark::Cross,
                    "dot" => FillMark::Dot,
                    _ => FillMark::Line,
                };
                let shape = Shape::Mark { rect: rect_to_user(&p, a.nums::<4>("rect")?), mark };
                Edit::AddAnnotation(NewAnnotation { page, style: Style::default_for(&shape), shape, contents: String::new(), author })
            }
            "sign_drawn" => {
                let (page, p) = self.page_info(id, &a)?;
                let [x, y] = a.nums::<2>("at")?;
                let width = a.opt_num("width").unwrap_or(150.0).clamp(20.0, 600.0);
                let strokes = a.get("strokes").and_then(Value::as_array).ok_or_else(|| bad("Draw a signature first."))?;
                let strokes: Vec<Vec<[f64; 2]>> = strokes
                    .iter()
                    .filter_map(Value::as_array)
                    .map(|s| s.iter().filter_map(|q| q.as_array()).filter_map(|q| Some([q.first()?.as_f64()?, q.get(1)?.as_f64()?])).collect())
                    .filter(|s: &Vec<[f64; 2]>| !s.is_empty())
                    .collect();
                signature_shape(&p, to_user(&p, x, y), &strokes, width)
                    .map(|shape| Edit::AddAnnotation(NewAnnotation { page, style: Style::default_for(&shape), shape, contents: String::new(), author }))
                    .ok_or_else(|| bad("Draw a signature first."))?
            }
            "sign_typed" => {
                let (page, p) = self.page_info(id, &a)?;
                let [x, y] = a.nums::<2>("at")?;
                let height = a.opt_num("height").unwrap_or(32.0).clamp(8.0, 200.0);
                let shape = pdfcraft_engine::typed_signature_shape(to_user(&p, x, y), a.str("text")?, height, i64::from(p.rotation))
                    .ok_or_else(|| bad("Type your name to sign."))?;
                Edit::AddAnnotation(NewAnnotation { page, style: Style::default_for(&shape), shape, contents: String::new(), author })
            }
            // --- page content
            "add_text" => {
                let (page, p) = self.page_info(id, &a)?;
                let family = match a.get("family").and_then(Value::as_str) {
                    Some("times") => pdfcraft_engine::FontFamily::Times,
                    Some("courier") => pdfcraft_engine::FontFamily::Courier,
                    _ => pdfcraft_engine::FontFamily::Helvetica,
                };
                let align = match a.get("align").and_then(Value::as_str) {
                    Some("center") => pdfcraft_engine::TextAlign::Center,
                    Some("right") => pdfcraft_engine::TextAlign::Right,
                    _ => pdfcraft_engine::TextAlign::Left,
                };
                let text = pdfcraft_engine::AddedText {
                    rect: to_display(a.nums::<4>("rect")?, p.height as f64),
                    text: a.str("text")?.to_string(),
                    family,
                    bold: a.bool("bold"),
                    italic: a.bool("italic"),
                    size: a.opt_num("size").unwrap_or(12.0).clamp(4.0, 144.0),
                    color: a.get("color").and_then(color).unwrap_or([0.0; 3]),
                    align,
                };
                Edit::AddText { page, text }
            }
            // --- redaction
            "redact_area" => {
                let (page, p) = self.page_info(id, &a)?;
                redact(page, vec![quad(&p, a.nums::<4>("rect")?)], &author)
            }
            "redact_text" => {
                let query = a.str("query")?.to_string();
                let mut edits = Vec::new();
                for page in 0..count {
                    let t = self.page_text(id, page)?;
                    let p = self.doc(id)?.info.pages[page].clone();
                    for r in t.find_opts(&query, a.bool("case"), a.bool("whole")) {
                        let quads: Vec<[f64; 8]> = t.line_rects(r).into_iter().map(|r| p.view_rect_to_quad(r)).collect();
                        if !quads.is_empty() {
                            edits.push(redact(page, quads, &author));
                        }
                    }
                }
                match edits.len() {
                    0 => return Err(bad("Nothing matched, so nothing was marked.")),
                    1 => edits.remove(0),
                    _ => Edit::Batch { label: "Mark for redaction".into(), edits },
                }
            }
            "redact_apply" => {
                if self.doc(id)?.redaction_marks() == 0 {
                    return Err(bad("There are no redaction marks to apply."));
                }
                Edit::ApplyRedactions { pages: None }
            }
            "redact_clear" => Edit::ClearRedactions,
            // --- document
            "info" => {
                let mut edits = Vec::new();
                for (key, field) in [("Title", "title"), ("Author", "author"), ("Subject", "subject"), ("Keywords", "keywords")] {
                    if let Some(value) = a.get(field).and_then(Value::as_str) {
                        edits.push(Edit::SetInfo { key: key.into(), value: value.chars().take(2000).collect() });
                    }
                }
                Edit::Batch { label: "Document properties".into(), edits }
            }
            "flatten" => Edit::Flatten { comments: a.bool("comments"), fields: a.bool("fields") },
            "protect" => {
                let pw = |k: &str| a.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                Edit::Protect(Protection {
                    open_password: pw("open_password"),
                    permissions_password: pw("permissions_password"),
                    printing: match a.get("printing").and_then(Value::as_str) {
                        Some("none") => Printing::None,
                        Some("low") => Printing::Low,
                        _ => Printing::High,
                    },
                    changes: match a.get("changes").and_then(Value::as_str) {
                        Some("pages") => Changes::Pages,
                        Some("fill_sign") => Changes::FillSign,
                        Some("comment") => Changes::CommentFillSign,
                        Some("any") => Changes::AnyExceptExtract,
                        _ => Changes::None,
                    },
                    copy: a.bool("copy"),
                    ..Protection::default()
                })
            }
            "unprotect" => Edit::RemoveProtection,
            other => return Err(bad(&format!("Unknown edit {other}."))),
        })
    }
}

fn redact(page: usize, quads: Vec<[f64; 8]>, author: &str) -> Edit {
    let shape = Shape::Redact { quads, overlay: String::new(), look: Default::default() };
    Edit::AddAnnotation(NewAnnotation { page, style: Style::default_for(&shape), shape, contents: String::new(), author: author.to_string() })
}

/// A text box sized to its text, hanging from its top-left corner (user space).
fn text_box_rect(at: [f64; 2], text: &str, size: f64) -> [f64; 4] {
    use pdfcraft_engine::annot_text::{text_width, wrap};
    let pad = 2.0;
    let longest = text.lines().map(|l| text_width(l, size)).fold(0.0, f64::max);
    let w = (longest + 2.0 * pad + 4.0).clamp(20.0, 500.0);
    let lines = wrap(text, size, w - 2.0 * pad).len().max(1);
    let h = lines as f64 * size * 1.2 + 2.0 * pad + 2.0;
    [at[0], at[1] - h, at[0] + w, at[1]]
}

/// A drawn signature (strokes normalised to a 0–1 box, y up) with its left edge at `at`
/// (user space, vertically centred), `width` points wide and upright as the page is displayed.
fn signature_shape(p: &PageInfo, at: [f64; 2], strokes: &[Vec<[f64; 2]>], width: f64) -> Option<Shape> {
    let (min_y, max_y) = strokes.iter().flatten().fold((f64::MAX, f64::MIN), |(a, b), q| (a.min(q[1]), b.max(q[1])));
    if !min_y.is_finite() {
        return None;
    }
    let h = (max_y - min_y).max(0.05) * width;
    // Displayed right and up as user-space unit vectors.
    let [a, b, c, d, ..] = pdfcraft_model::view_matrix_for(i64::from(p.rotation), [0.0; 4]);
    let strokes = strokes
        .iter()
        .map(|s| {
            s.iter()
                .map(|q| {
                    let (dx, dy) = (q[0] * width, (q[1] - min_y) * width - h / 2.0);
                    [at[0] + a * dx + c * dy, at[1] + b * dx + d * dy]
                })
                .collect()
        })
        .collect();
    Some(Shape::Signature { strokes })
}

#[cfg(test)]
mod tests;
