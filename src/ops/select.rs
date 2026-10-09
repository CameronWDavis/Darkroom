//! Selections, stored as descriptions and rasterized on demand.
//!
//! Shapes combine in order -- add, subtract or intersect -- and the result is
//! then refined: smoothed, grown or shrunk, snapped to edges in the photo, and
//! feathered. Coordinates are normalized source coordinates and radii are
//! fractions of the short edge, so a selection means the same thing on a
//! preview and on a full-size export. Rasters are capped at `MAX_RES` on the
//! long edge, which keeps edge refinement affordable on a 60 MP export; masks
//! sample them bilinearly.
use super::*;
use image::imageops::FilterType;
use std::borrow::Cow;

const MAX_RES: f32 = 2048.0;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SelMode { #[default] Add, Subtract, Intersect }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelShape {
    Rect { x0: f32, y0: f32, x1: f32, y1: f32, #[serde(default)] mode: SelMode },
    Ellipse { x0: f32, y0: f32, x1: f32, y1: f32, #[serde(default)] mode: SelMode },
    /// Flat x,y pairs, implicitly closed, even-odd fill.
    Polygon { points: Vec<f32>, #[serde(default)] mode: SelMode },
    /// Pixels within `tolerance` (0..1 of full range, per channel) of the
    /// colour under (x, y); `contiguous` limits it to the connected region.
    Wand { x: f32, y: f32, tolerance: f32, #[serde(default = "super::yes")] contiguous: bool, #[serde(default)] mode: SelMode },
    All { #[serde(default)] mode: SelMode },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Selection {
    pub shapes: Vec<SelShape>,
    /// Gaussian softening of the edge, fraction of the short edge.
    pub feather: f32,
    /// Grow (positive) or shrink (negative) the selection, fraction of the short edge.
    pub shift: f32,
    /// Rounds off jagged corners and specks, fraction of the short edge.
    pub smooth: f32,
    /// Edge-aware refinement radius: the edge is pulled onto edges in the
    /// photograph with a guided filter, which keeps hair and foliage soft.
    pub refine: f32,
    pub invert: bool,
}

pub fn check(sel: &Selection) -> Result<(), String> {
    let ok = |v: f32, lo: f32, hi: f32| v.is_finite() && v >= lo && v <= hi;
    if sel.shapes.len() > 64 { return Err("A selection can combine up to 64 shapes.".into()); }
    if !ok(sel.feather, 0., 0.1) || !ok(sel.shift, -0.1, 0.1) || !ok(sel.smooth, 0., 0.1) || !ok(sel.refine, 0., 0.1) { return Err("Invalid selection refinement.".into()); }
    let mut points = 0;
    for s in &sel.shapes {
        let valid = match s {
            SelShape::Rect { x0, y0, x1, y1, .. } | SelShape::Ellipse { x0, y0, x1, y1, .. } => [x0, y0, x1, y1].iter().all(|v| ok(**v, -1., 2.)),
            SelShape::Polygon { points: p, .. } => { points += p.len() / 2; p.len() % 2 == 0 && p.iter().all(|v| ok(*v, -1., 2.)) }
            SelShape::Wand { x, y, tolerance, .. } => ok(*x, 0., 1.) && ok(*y, 0., 1.) && ok(*tolerance, 0., 1.),
            SelShape::All { .. } => true,
        };
        if !valid { return Err("Invalid selection shape.".into()); }
    }
    if points > crate::limits::MAX_LASSO_POINTS { return Err("A selection outline has too many points.".into()); }
    Ok(())
}

pub struct Raster { pub w: usize, pub h: usize, pub data: Vec<f32> }

impl Raster {
    /// Bilinear, clamped to the edge, at normalized coordinates.
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        let px = (x * self.w as f32 - 0.5).clamp(0., (self.w - 1) as f32);
        let py = (y * self.h as f32 - 0.5).clamp(0., (self.h - 1) as f32);
        let (ix, iy) = (px.floor() as usize, py.floor() as usize);
        let (jx, jy) = ((ix + 1).min(self.w - 1), (iy + 1).min(self.h - 1));
        let (fx, fy) = (px - ix as f32, py - iy as f32);
        let at = |x: usize, y: usize| self.data[y * self.w + x];
        (at(ix, iy) * (1. - fx) + at(jx, iy) * fx) * (1. - fy) + (at(ix, jy) * (1. - fx) + at(jx, jy) * fx) * fy
    }
    /// Normalized bounding box of the clearly selected area.
    pub fn bounds(&self) -> Option<[f32; 4]> {
        let (mut x0, mut y0, mut x1, mut y1) = (self.w, self.h, 0, 0);
        for (i, v) in self.data.iter().enumerate() {
            if *v >= 0.5 { let (x, y) = (i % self.w, i / self.w); x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x + 1); y1 = y1.max(y + 1); }
        }
        (x1 > x0 && y1 > y0).then(|| [x0 as f32 / self.w as f32, y0 as f32 / self.h as f32, (x1 - x0) as f32 / self.w as f32, (y1 - y0) as f32 / self.h as f32])
    }
}

fn wand(img: &RgbaImage, x: f32, y: f32, tolerance: f32, contiguous: bool) -> Vec<f32> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let sx = ((x * w as f32) as usize).min(w - 1);
    let sy = ((y * h as f32) as usize).min(h - 1);
    let seed = *img.get_pixel(sx as u32, sy as u32);
    let limit = (tolerance * 255.0).round() as i32;
    let near = |i: usize| {
        let p = img.as_raw();
        (0..4).all(|c| (p[i * 4 + c] as i32 - seed[c] as i32).abs() <= limit)
    };
    let mut out = vec![0f32; w * h];
    if contiguous {
        let mut stack = vec![sy * w + sx];
        out[sy * w + sx] = 1.0;
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            let mut visit = |j: usize| if out[j] == 0.0 && near(j) { out[j] = 1.0; stack.push(j); };
            if x > 0 { visit(i - 1); }
            if x + 1 < w { visit(i + 1); }
            if y > 0 { visit(i - w); }
            if y + 1 < h { visit(i + w); }
        }
    } else {
        for (i, o) in out.iter_mut().enumerate() { if near(i) { *o = 1.0; } }
    }
    // A pixel of anti-aliasing, as Photoshop's wand applies by default.
    box_blur(&mut out, w, h, 1);
    out
}

fn polygon(points: &[f32], w: usize, h: usize) -> Vec<f32> {
    let pts: Vec<(f32, f32)> = points.chunks_exact(2).map(|c| (c[0] * w as f32, c[1] * h as f32)).collect();
    let mut cov = vec![0f32; w * h];
    if pts.len() < 3 { return cov; }
    let weight = 1.0 / SUBSAMPLES as f32;
    let mut xs = Vec::new();
    for row in 0..h {
        for s in 0..SUBSAMPLES {
            let y = row as f32 + (s as f32 + 0.5) / SUBSAMPLES as f32;
            xs.clear();
            for i in 0..pts.len() {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                if (a.1 <= y) != (b.1 <= y) { xs.push(a.0 + (y - a.1) / (b.1 - a.1) * (b.0 - a.0)); }
            }
            xs.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
            for pair in xs.chunks_exact(2) { add_span(&mut cov, w, row, pair[0], pair[1], weight); }
        }
    }
    for c in cov.iter_mut() { *c = c.min(1.0); }
    cov
}

/// Two-pass chamfer distance (1, √2) from each pixel to the nearest pixel
/// where `target` holds: near-Euclidean at linear cost.
fn distance(target: &[bool], w: usize, h: usize) -> Vec<f32> {
    let mut d: Vec<f32> = target.iter().map(|t| if *t { 0. } else { f32::MAX / 4. }).collect();
    let diag = std::f32::consts::SQRT_2;
    for y in 0..h { for x in 0..w {
        let i = y * w + x; let mut v = d[i];
        if x > 0 { v = v.min(d[i - 1] + 1.); }
        if y > 0 { v = v.min(d[i - w] + 1.); if x > 0 { v = v.min(d[i - w - 1] + diag); } if x + 1 < w { v = v.min(d[i - w + 1] + diag); } }
        d[i] = v;
    }}
    for y in (0..h).rev() { for x in (0..w).rev() {
        let i = y * w + x; let mut v = d[i];
        if x + 1 < w { v = v.min(d[i + 1] + 1.); }
        if y + 1 < h { v = v.min(d[i + w] + 1.); if x + 1 < w { v = v.min(d[i + w + 1] + diag); } if x > 0 { v = v.min(d[i + w - 1] + diag); } }
        d[i] = v;
    }}
    d
}

/// He et al.'s guided filter with the photo's luminance as the guide.
fn guided(mask: &mut [f32], guide: &RgbaImage, r: usize) {
    let (w, h) = (guide.width() as usize, guide.height() as usize);
    let i: Vec<f32> = guide.pixels().map(|p| luma(p) / 255.0).collect();
    let mean = |v: &[f32]| { let mut o = v.to_vec(); box_blur(&mut o, w, h, r); o };
    let (mi, mp) = (mean(&i), mean(mask));
    let ii: Vec<f32> = i.iter().map(|v| v * v).collect();
    let ip: Vec<f32> = i.iter().zip(mask.iter()).map(|(a, b)| a * b).collect();
    let (mii, mip) = (mean(&ii), mean(&ip));
    const EPS: f32 = 0.002;
    let a: Vec<f32> = (0..w * h).map(|k| (mip[k] - mi[k] * mp[k]) / (mii[k] - mi[k] * mi[k] + EPS)).collect();
    let b: Vec<f32> = (0..w * h).map(|k| mp[k] - a[k] * mi[k]).collect();
    let (ma, mb) = (mean(&a), mean(&b));
    for k in 0..w * h { mask[k] = (ma[k] * i[k] + mb[k]).clamp(0., 1.); }
}

/// `rasterize`, remembered for preview-sized sources. A mask made from a
/// selection is re-rendered on every frame of a slider drag while nothing
/// about it changes, and the magic wand and edge refinement are the costly
/// part of that frame.
pub fn rasterize_cached(sel: &Selection, src: &RgbaImage) -> std::rc::Rc<Raster> {
    use std::cell::RefCell;
    use std::hash::{Hash, Hasher};
    use std::rc::Rc;
    thread_local! { static CACHE: RefCell<Vec<(u64, Rc<Raster>)>> = const { RefCell::new(Vec::new()) }; }
    const CACHEABLE_PIXELS: u32 = 1600 * 1600;
    if src.width() * src.height() > CACHEABLE_PIXELS { return Rc::new(rasterize(sel, src)); }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(sel).unwrap_or_default().hash(&mut h);
    src.dimensions().hash(&mut h);
    // The wand reads pixels, so sample the source too. Sources are original
    // photographs that never change in place, so a stride is enough.
    let raw = src.as_raw();
    raw.iter().step_by((raw.len() / 8192).max(1)).for_each(|b| b.hash(&mut h));
    let key = h.finish();
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if let Some(i) = c.iter().position(|(k, _)| *k == key) { let hit = c.remove(i); c.insert(0, hit.clone()); return hit.1; }
        let raster = Rc::new(rasterize(sel, src));
        c.insert(0, (key, raster.clone()));
        c.truncate(6);
        raster
    })
}

pub fn rasterize(sel: &Selection, src: &RgbaImage) -> Raster {
    let (sw, sh) = src.dimensions();
    let scale = (MAX_RES / sw.max(sh) as f32).min(1.0);
    let w = ((sw as f32 * scale).round() as usize).max(1);
    let h = ((sh as f32 * scale).round() as usize).max(1);
    let short = w.min(h) as f32;
    let needs_pixels = sel.refine > 0. || sel.shapes.iter().any(|s| matches!(s, SelShape::Wand { .. }));
    let pixels: Option<Cow<RgbaImage>> = needs_pixels.then(|| {
        if (w as u32, h as u32) == (sw, sh) { Cow::Borrowed(src) } else { Cow::Owned(imageops::resize(src, w as u32, h as u32, FilterType::Triangle)) }
    });

    let mut m = vec![0f32; w * h];
    for shape in &sel.shapes {
        let (mode, cov): (SelMode, Vec<f32>) = match shape {
            SelShape::Rect { x0, y0, x1, y1, mode } => {
                let (ax, bx) = (x0.min(*x1) * w as f32, x0.max(*x1) * w as f32);
                let (ay, by) = (y0.min(*y1) * h as f32, y0.max(*y1) * h as f32);
                // Exact area coverage of each pixel by the rectangle.
                let span = |p: f32, a: f32, b: f32| ((p + 1.).min(b) - p.max(a)).clamp(0., 1.);
                (*mode, (0..w * h).map(|i| span((i % w) as f32, ax, bx) * span((i / w) as f32, ay, by)).collect())
            }
            SelShape::Ellipse { x0, y0, x1, y1, mode } => {
                let (cx, cy) = ((x0 + x1) / 2. * w as f32, (y0 + y1) / 2. * h as f32);
                let (rx, ry) = (((x1 - x0) / 2. * w as f32).abs().max(0.5), ((y1 - y0) / 2. * h as f32).abs().max(0.5));
                (*mode, (0..w * h).map(|i| {
                    let (ux, uy) = (((i % w) as f32 + 0.5 - cx) / rx, ((i / w) as f32 + 0.5 - cy) / ry);
                    let k0 = (ux * ux + uy * uy).sqrt();
                    let k1 = ((ux / rx).powi(2) + (uy / ry).powi(2)).sqrt();
                    let d = if k1 == 0. { -rx.min(ry) } else { k0 * (k0 - 1.) / k1 };
                    (0.5 - d).clamp(0., 1.)
                }).collect())
            }
            SelShape::Polygon { points, mode } => (*mode, polygon(points, w, h)),
            SelShape::Wand { x, y, tolerance, contiguous, mode } => (*mode, wand(pixels.as_ref().unwrap(), *x, *y, *tolerance, *contiguous)),
            SelShape::All { mode } => (*mode, vec![1.; w * h]),
        };
        for (v, c) in m.iter_mut().zip(cov) {
            *v = match mode { SelMode::Add => v.max(c), SelMode::Subtract => v.min(1. - c), SelMode::Intersect => v.min(c) };
        }
    }

    let radius = |f: f32| f * short;
    if radius(sel.smooth) >= 0.5 {
        let mut soft = m.clone();
        box_blur(&mut soft, w, h, radius(sel.smooth).round().max(1.) as usize);
        for (v, s) in m.iter_mut().zip(soft) { *v = ((s - 0.5) * 5. + 0.5).clamp(0., 1.); }
    }
    let r = radius(sel.shift);
    if r.abs() >= 0.5 {
        if r > 0. {
            let d = distance(&m.iter().map(|v| *v >= 0.5).collect::<Vec<_>>(), w, h);
            for (v, d) in m.iter_mut().zip(d) { *v = v.max((r + 1. - d).clamp(0., 1.)); }
        } else {
            let d = distance(&m.iter().map(|v| *v < 0.5).collect::<Vec<_>>(), w, h);
            for (v, d) in m.iter_mut().zip(d) { *v = v.min((d + r).clamp(0., 1.)); }
        }
    }
    if radius(sel.refine) >= 0.5 { guided(&mut m, pixels.as_ref().unwrap(), radius(sel.refine).round().max(1.) as usize); }
    if radius(sel.feather) >= 0.5 { box_blur(&mut m, w, h, radius(sel.feather).round().max(1.) as usize); }
    if sel.invert { for v in m.iter_mut() { *v = 1. - *v; } }
    Raster { w, h, data: m }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sel(shapes: Vec<SelShape>) -> Selection { Selection { shapes, ..Default::default() } }
    fn rect(x0: f32, y0: f32, x1: f32, y1: f32, mode: SelMode) -> SelShape { SelShape::Rect { x0, y0, x1, y1, mode } }
    fn at(r: &Raster, x: usize, y: usize) -> f32 { r.data[y * r.w + x] }
    #[test]
    fn shapes_combine_in_order() {
        let img = RgbaImage::new(100, 100);
        let r = rasterize(&sel(vec![rect(0.1, 0.1, 0.6, 0.6, SelMode::Add), rect(0.4, 0.4, 0.9, 0.9, SelMode::Add), rect(0.0, 0.0, 0.3, 1.0, SelMode::Subtract)]), &img);
        assert!(at(&r, 35, 35) > 0.99); assert!(at(&r, 80, 80) > 0.99); assert!(at(&r, 20, 20) < 0.01); assert!(at(&r, 80, 20) < 0.01);
        let r = rasterize(&sel(vec![rect(0.1, 0.1, 0.6, 0.6, SelMode::Add), SelShape::Ellipse { x0: 0.3, y0: 0.3, x1: 0.9, y1: 0.9, mode: SelMode::Intersect }]), &img);
        assert!(at(&r, 50, 50) > 0.99); assert!(at(&r, 15, 15) < 0.01); assert!(at(&r, 32, 32) < 0.01, "outside the ellipse's corner");
        let mut inverted = sel(vec![rect(0.1, 0.1, 0.6, 0.6, SelMode::Add)]); inverted.invert = true;
        let r = rasterize(&inverted, &img); assert!(at(&r, 50, 50) < 0.01); assert!(at(&r, 80, 80) > 0.99);
        // Half-pixel edges get partial coverage.
        let r = rasterize(&sel(vec![rect(0.105, 0.0, 1.0, 1.0, SelMode::Add)]), &img); assert!((at(&r, 10, 50) - 0.5).abs() < 0.01);
    }
    #[test]
    fn polygons_and_the_wand() {
        let mut img = RgbaImage::from_pixel(100, 100, Rgba([10, 10, 10, 255]));
        for y in 20..40 { for x in 20..40 { img.put_pixel(x, y, Rgba([200, 30, 30, 255])); } }
        for y in 60..80 { for x in 60..80 { img.put_pixel(x, y, Rgba([205, 35, 30, 255])); } }
        let near = rasterize(&sel(vec![SelShape::Wand { x: 0.3, y: 0.3, tolerance: 0.05, contiguous: true, mode: SelMode::Add }]), &img);
        assert!(at(&near, 30, 30) > 0.99); assert!(at(&near, 70, 70) < 0.01); assert!(at(&near, 5, 5) < 0.01);
        let all = rasterize(&sel(vec![SelShape::Wand { x: 0.3, y: 0.3, tolerance: 0.05, contiguous: false, mode: SelMode::Add }]), &img);
        assert!(at(&all, 70, 70) > 0.99);
        let tri = rasterize(&sel(vec![SelShape::Polygon { points: vec![0.1, 0.1, 0.9, 0.1, 0.1, 0.9], mode: SelMode::Add }]), &img);
        assert!(at(&tri, 20, 20) > 0.99); assert!(at(&tri, 80, 80) < 0.01);
    }
    #[test]
    fn refinements_grow_shrink_soften_and_snap_to_edges() {
        let img = RgbaImage::new(200, 200);
        let base = sel(vec![rect(0.3, 0.3, 0.7, 0.7, SelMode::Add)]);
        let grown = rasterize(&Selection { shift: 0.05, ..base.clone() }, &img);
        assert!(at(&grown, 55, 100) > 0.99); assert!(at(&grown, 45, 100) < 0.01);
        let shrunk = rasterize(&Selection { shift: -0.05, ..base.clone() }, &img);
        assert!(at(&shrunk, 65, 100) < 0.01); assert!(at(&shrunk, 75, 100) > 0.99);
        let feathered = rasterize(&Selection { feather: 0.03, ..base.clone() }, &img);
        let edge = at(&feathered, 60, 100); assert!(edge > 0.3 && edge < 0.7, "{edge}"); assert!(at(&feathered, 100, 100) > 0.99);
        // A sloppy rectangle snaps onto a bright square in the photo.
        let mut photo = RgbaImage::from_pixel(200, 200, Rgba([0, 0, 0, 255]));
        for y in 60..140 { for x in 60..140 { photo.put_pixel(x, y, Rgba([255, 255, 255, 255])); } }
        let sloppy = sel(vec![rect(0.27, 0.27, 0.73, 0.73, SelMode::Add)]);
        let refined = rasterize(&Selection { refine: 0.04, ..sloppy.clone() }, &photo);
        let plain = rasterize(&sloppy, &photo);
        assert!(at(&plain, 57, 100) > 0.99); assert!(at(&refined, 57, 100) < 0.5, "pulled in to the photo's edge");
        assert!(at(&refined, 65, 100) > 0.9);
        assert!(check(&Selection { feather: 2., ..base }).is_err());
    }
}
