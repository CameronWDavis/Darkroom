//! Live text: font registry, paragraph layout and rasterization.
//!
//! Lato is compiled in so text always renders. Other families are registered
//! at runtime -- the bundled extras are fetched by the UI when first used, and
//! imported fonts travel inside the project -- under keys of the form
//! `family:r`, `family:b`, `family:i` or `family:bi`. A face that is missing
//! falls back to the family's regular face with synthetic bold or italic, and a
//! family that is missing falls back to Lato, so a project never fails to open
//! because of a font.
use super::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

thread_local! {
    static FONTS: RefCell<HashMap<String, Rc<fontdue::Font>>> = RefCell::new(HashMap::new());
}

pub const MAX_FONT_BYTES: usize = 20 * 1024 * 1024;

fn parse(bytes: &[u8]) -> Result<fontdue::Font, String> {
    if bytes.len() > MAX_FONT_BYTES { return Err("Font files are limited to 20 MB.".into()); }
    let font = fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).map_err(|e| format!("That font can't be read: {e}"))?;
    if font.glyph_count() < 2 || font.lookup_glyph_index('a') == 0 && font.lookup_glyph_index('A') == 0 {
        return Err("That font has no Latin letters Darkroom can draw.".into());
    }
    Ok(font)
}

/// Makes a face available to the renderer under `key` (`family:style`).
pub fn register(key: &str, bytes: &[u8]) -> Result<(), String> {
    if key.is_empty() || key.len() > 120 { return Err("Invalid font name.".into()); }
    let font = parse(bytes)?;
    FONTS.with(|f| f.borrow_mut().insert(key.to_string(), Rc::new(font)));
    Ok(())
}

/// Checks a font file without registering it.
pub fn validate(bytes: &[u8]) -> Result<(), String> { parse(bytes).map(|_| ()) }

pub fn is_registered(key: &str) -> bool { builtin(key).is_some() || FONTS.with(|f| f.borrow().contains_key(key)) }

fn builtin(key: &str) -> Option<Rc<fontdue::Font>> {
    thread_local! {
        static LATO: RefCell<[Option<Rc<fontdue::Font>>; 2]> = const { RefCell::new([None, None]) };
    }
    let (slot, bytes): (usize, &[u8]) = match key {
        "lato:r" => (0, include_bytes!("../../web/fonts/Lato-Regular.ttf")),
        "lato:b" => (1, include_bytes!("../../web/fonts/Lato-Bold.ttf")),
        _ => return None,
    };
    Some(LATO.with(|l| l.borrow_mut()[slot].get_or_insert_with(|| Rc::new(fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).expect("bundled Lato font"))).clone()))
}

fn lookup(key: &str) -> Option<Rc<fontdue::Font>> { builtin(key).or_else(|| FONTS.with(|f| f.borrow().get(key).cloned())) }

/// The face to draw with, plus whether bold and italic must be synthesized.
fn face(family: &str, bold: bool, italic: bool) -> (Rc<fontdue::Font>, bool, bool) {
    for family in [family, "lato"] {
        let wanted = match (bold, italic) { (false, false) => "r", (true, false) => "b", (false, true) => "i", (true, true) => "bi" };
        if let Some(f) = lookup(&format!("{family}:{wanted}")) { return (f, false, false); }
        if bold && italic {
            if let Some(f) = lookup(&format!("{family}:b")) { return (f, false, true); }
            if let Some(f) = lookup(&format!("{family}:i")) { return (f, true, false); }
        }
        if let Some(f) = lookup(&format!("{family}:r")) { return (f, bold, italic); }
    }
    unreachable!("Lato is compiled in")
}

struct Line { chars: Vec<char>, width: f32, justify: bool }

/// Advance of each character, kerning folded into the character it precedes
/// and tracking added after every character but the last.
fn advances(font: &fontdue::Font, chars: &[char], px: f32, tracking: f32) -> Vec<f32> {
    let mut out = Vec::with_capacity(chars.len());
    for (i, &ch) in chars.iter().enumerate() {
        let kern = if i > 0 { font.horizontal_kern(chars[i - 1], ch, px).unwrap_or(0.0) } else { 0.0 };
        if let Some(last) = out.last_mut() { *last += kern; }
        out.push(font.metrics(ch, px).advance_width + if i + 1 < chars.len() { tracking } else { 0.0 });
    }
    out
}
fn measure(font: &fontdue::Font, chars: &[char], px: f32, tracking: f32) -> f32 { advances(font, chars, px, tracking).iter().sum() }

fn layout(font: &fontdue::Font, text: &str, px: f32, tracking: f32, box_px: Option<f32>) -> Vec<Line> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let chars: Vec<char> = para.chars().collect();
        let Some(limit) = box_px else {
            lines.push(Line { width: measure(font, &chars, px, tracking), chars, justify: false });
            continue;
        };
        // Greedy fill by words; a word wider than the box is broken by
        // characters rather than overflowing it.
        let mut current: Vec<char> = Vec::new();
        let flush = |current: &mut Vec<char>, lines: &mut Vec<Line>, last: bool| {
            while current.last() == Some(&' ') { current.pop(); }
            lines.push(Line { width: measure(font, current, px, tracking), chars: std::mem::take(current), justify: !last });
        };
        for word in para.split(' ') {
            let mut candidate = current.clone();
            if !candidate.is_empty() { candidate.push(' '); }
            candidate.extend(word.chars());
            if measure(font, &candidate, px, tracking) <= limit || current.is_empty() && word.is_empty() {
                current = candidate;
                continue;
            }
            if !current.is_empty() { flush(&mut current, &mut lines, false); }
            for ch in word.chars() {
                current.push(ch);
                if current.len() > 1 && measure(font, &current, px, tracking) > limit {
                    current.pop();
                    flush(&mut current, &mut lines, false);
                    current.push(ch);
                }
            }
        }
        flush(&mut current, &mut lines, true);
    }
    lines
}

/// Rasterize live text at the render resolution, then map it through the same
/// source geometry as brush marks. Never persist a flattened text bitmap.
pub fn render(img: &mut RgbaImage, op: &Op, geo: &[Op], dims: (u32, u32), short: f32) {
    let Op::Text { text, x, y, size, color, bold, align, leading, font, italic, tracking, box_width } = op else { return };
    let (face, fake_bold, fake_italic) = face(font, *bold, *italic);
    let px = (size * short).clamp(1.0, 4096.0);
    let ascent = face.horizontal_line_metrics(px).map_or(px * 0.8, |m| m.ascent);
    let track = tracking * px;
    let box_px = (*box_width > 0.0).then(|| box_width * dims.0 as f32);
    let rgb = [color[0] as f32 / 255.0, color[1] as f32 / 255.0, color[2] as f32 / 255.0];
    let embolden = if fake_bold { (px * 0.035).round().max(1.0) as usize } else { 0 };
    let left = x * dims.0 as f32;

    for (row, line) in layout(&face, text, px, track, box_px).iter().enumerate() {
        let gaps = line.chars.iter().filter(|c| **c == ' ').count();
        let (mut pen, stretch) = match (box_px, align) {
            (Some(b), TextAlign::Justify) if line.justify && gaps > 0 => (left, (b - line.width) / gaps as f32),
            (Some(_), TextAlign::Left | TextAlign::Justify) => (left, 0.0),
            (Some(b), TextAlign::Center) => (left + (b - line.width) / 2.0, 0.0),
            (Some(b), TextAlign::Right) => (left + b - line.width, 0.0),
            (None, TextAlign::Left | TextAlign::Justify) => (left, 0.0),
            (None, TextAlign::Center) => (left - line.width / 2.0, 0.0),
            (None, TextAlign::Right) => (left - line.width, 0.0),
        };
        let baseline = y * dims.1 as f32 + ascent + row as f32 * px * leading;
        let advance = advances(&face, &line.chars, px, track);
        for (i, &ch) in line.chars.iter().enumerate() {
            let (m, bitmap) = face.rasterize(ch, px);
            let gw = m.width + embolden;
            for gy in 0..m.height {
                let top = baseline.floor() - m.ymin as f32 - m.height as f32 + gy as f32;
                // Synthetic italic shears about the baseline, like an oblique.
                let shear = if fake_italic { (baseline - top) * 0.2 } else { 0.0 };
                for gx in 0..gw {
                    // Synthetic bold smears each row sideways by a few pixels.
                    let coverage = (gx.saturating_sub(embolden)..=gx.min(m.width.saturating_sub(1))).map(|sx| bitmap[gy * m.width + sx]).max().unwrap_or(0);
                    if coverage == 0 { continue; }
                    let sx = (pen.floor() + m.xmin as f32 + gx as f32 + shear.round() + 0.5) / dims.0 as f32;
                    let sy = (top + 0.5) / dims.1 as f32;
                    let (nx, ny) = map_point(sx, sy, geo);
                    if !(0.0..1.0).contains(&nx) || !(0.0..1.0).contains(&ny) { continue; }
                    let ix = (nx * img.width() as f32) as u32;
                    let iy = (ny * img.height() as f32) as u32;
                    blend_px(img.get_pixel_mut(ix, iy), rgb, coverage as f32 / 255.0 * color[3] as f32 / 255.0, Blend::Normal);
                }
            }
            pen += advance[i] + if ch == ' ' { stretch } else { 0.0 };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn text(t: &str, align: TextAlign, box_width: f32, tracking: f32) -> Op {
        Op::Text { text: t.into(), x: 0.1, y: 0.1, size: 0.12, color: [255, 255, 255, 255], bold: false, align, leading: 1.2, font: "lato".into(), italic: false, tracking, box_width }
    }
    fn ink_columns(img: &RgbaImage) -> (u32, u32) {
        let cols: Vec<u32> = (0..img.width()).filter(|&x| (0..img.height()).any(|y| img.get_pixel(x, y)[3] > 0)).collect();
        (*cols.first().unwrap(), *cols.last().unwrap())
    }
    fn ink_rows(img: &RgbaImage) -> u32 { (0..img.height()).filter(|&y| (0..img.width()).any(|x| img.get_pixel(x, y)[3] > 0)).count() as u32 }

    #[test]
    fn paragraph_boxes_wrap_and_justify_within_their_width() {
        let words = "darkroom keeps every layer editable and every edit undoable";
        let small = |mut op: Op| { if let Op::Text { size, .. } = &mut op { *size = 0.05; } op };
        let mut point = RgbaImage::new(400, 300);
        render(&mut point, &small(text(words, TextAlign::Left, 0.0, 0.0)), &[], (400, 300), 300.0);
        let mut boxed = RgbaImage::new(400, 300);
        render(&mut boxed, &small(text(words, TextAlign::Left, 0.4, 0.0)), &[], (400, 300), 300.0);
        assert!(ink_rows(&boxed) > ink_rows(&point) * 2, "the paragraph should wrap onto several lines");
        assert!(ink_columns(&boxed).1 <= 40 + 160 + 1, "wrapped text stays inside the box");
        let mut justified = RgbaImage::new(400, 300);
        render(&mut justified, &small(text(words, TextAlign::Justify, 0.4, 0.0)), &[], (400, 300), 300.0);
        assert!(ink_columns(&justified).1 > ink_columns(&boxed).1, "justified lines reach the right edge");
        assert!(ink_columns(&justified).1 <= 40 + 160 + 1);
    }

    #[test]
    fn tracking_widens_and_italic_falls_back_to_a_synthetic_oblique() {
        let mut tight = RgbaImage::new(500, 200);
        render(&mut tight, &text("SPACE", TextAlign::Left, 0.0, 0.0), &[], (500, 200), 200.0);
        let mut loose = RgbaImage::new(500, 200);
        render(&mut loose, &text("SPACE", TextAlign::Left, 0.0, 0.3), &[], (500, 200), 200.0);
        let (w0, w1) = (ink_columns(&tight).1 - ink_columns(&tight).0, ink_columns(&loose).1 - ink_columns(&loose).0);
        assert!(w1 as f32 > w0 as f32 * 1.2);
        let mut slanted = RgbaImage::new(500, 200);
        let mut op = text("I", TextAlign::Left, 0.0, 0.0);
        if let Op::Text { italic, font, .. } = &mut op { *italic = true; *font = "missing-family".into(); }
        render(&mut slanted, &op, &[], (500, 200), 200.0);
        let mut upright = RgbaImage::new(500, 200);
        render(&mut upright, &text("I", TextAlign::Left, 0.0, 0.0), &[], (500, 200), 200.0);
        assert_ne!(slanted, upright);
        assert!(ink_columns(&slanted).1 > ink_columns(&upright).1);
    }

    #[test]
    fn registered_fonts_are_used_and_bad_files_are_refused() {
        assert!(register("bad:r", b"not a font").is_err());
        register("copy:r", include_bytes!("../../web/fonts/Lato-Bold.ttf")).unwrap();
        let mut bold = RgbaImage::new(300, 120);
        let mut op = text("Bold", TextAlign::Left, 0.0, 0.0);
        if let Op::Text { bold: b, .. } = &mut op { *b = true; }
        render(&mut bold, &op, &[], (300, 120), 120.0);
        let mut copy = RgbaImage::new(300, 120);
        if let Op::Text { bold: b, font, .. } = &mut op { *b = false; *font = "copy".into(); }
        render(&mut copy, &op, &[], (300, 120), 120.0);
        assert_eq!(bold, copy);
    }
}
