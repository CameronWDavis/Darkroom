//! Retouching strokes: clone, heal, dodge and burn.
//!
//! A retouch layer samples whatever is beneath it in the stack, so it never
//! edits the photograph or another layer. Points are normalized source
//! coordinates like brush strokes; `dx, dy` is the vector from the sampled
//! source to the painted destination, also in source coordinates.
use super::*;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RetouchKind { Clone, Heal, Dodge, Burn }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToneRange { Shadows, #[default] Midtones, Highlights }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RetouchStroke {
    pub kind: RetouchKind,
    /// Brush diameter as a fraction of the source short edge.
    pub width: f32,
    /// 0 is a fully soft brush, 1 a hard edge.
    #[serde(default = "half")]
    pub hardness: f32,
    #[serde(default = "super::one")]
    pub strength: f32,
    #[serde(default)]
    pub range: ToneRange,
    #[serde(default)]
    pub dx: f32,
    #[serde(default)]
    pub dy: f32,
    pub points: Vec<f32>,
}
fn half() -> f32 { 0.5 }

pub fn check(s: &RetouchStroke) -> Result<(), String> {
    let ok = |v: f32, lo: f32, hi: f32| v.is_finite() && v >= lo && v <= hi;
    if !ok(s.width, 0.001, 1.) || !ok(s.hardness, 0., 1.) || !ok(s.strength, 0., 1.) || !ok(s.dx, -2., 2.) || !ok(s.dy, -2., 2.)
        || s.points.len() % 2 != 0 || s.points.iter().any(|v| !ok(*v, 0., 1.)) {
        return Err("Invalid retouching stroke.".into());
    }
    Ok(())
}

/// Brush coverage over a padded bounding box, maximum across segments so the
/// joints do not double up. Returns (x0, y0, w, h, coverage).
fn coverage(pts: &[(f32, f32)], r: f32, hardness: f32, pad: f32, size: (u32, u32)) -> Option<(i64, i64, usize, usize, Vec<f32>)> {
    let reach = r + pad + 1.;
    let x0 = (pts.iter().map(|p| p.0).fold(f32::MAX, f32::min) - reach).floor().max(0.) as i64;
    let y0 = (pts.iter().map(|p| p.1).fold(f32::MAX, f32::min) - reach).floor().max(0.) as i64;
    let x1 = (pts.iter().map(|p| p.0).fold(f32::MIN, f32::max) + reach).ceil().min(size.0 as f32) as i64;
    let y1 = (pts.iter().map(|p| p.1).fold(f32::MIN, f32::max) + reach).ceil().min(size.1 as f32) as i64;
    if x1 <= x0 || y1 <= y0 { return None; }
    let (w, h) = ((x1 - x0) as usize, (y1 - y0) as usize);
    let mut cov = vec![0f32; w * h];
    let core = r * hardness.clamp(0., 1.);
    let segs = if pts.len() == 1 { 1 } else { pts.len() - 1 };
    for i in 0..segs {
        let (a, b) = (pts[i], pts[(i + 1).min(pts.len() - 1)]);
        let sx0 = ((a.0.min(b.0) - r - 1.).floor() as i64).max(x0);
        let sx1 = ((a.0.max(b.0) + r + 1.).ceil() as i64).min(x1);
        let sy0 = ((a.1.min(b.1) - r - 1.).floor() as i64).max(y0);
        let sy1 = ((a.1.max(b.1) + r + 1.).ceil() as i64).min(y1);
        for y in sy0..sy1 { for x in sx0..sx1 {
            let d = dist_to_segment(x as f32 + 0.5, y as f32 + 0.5, a, b);
            let c = if r - core < 1. { (r + 0.5 - d).clamp(0., 1.) } else {
                let t = ((r - d) / (r - core)).clamp(0., 1.);
                t * t * (3. - 2. * t)
            };
            let k = (y - y0) as usize * w + (x - x0) as usize;
            if c > cov[k] { cov[k] = c; }
        }}
    }
    Some((x0, y0, w, h, cov))
}

fn sample_px(img: &RgbaImage, x: f32, y: f32) -> [f32; 4] {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let px = (x - 0.5).clamp(0., w - 1.); let py = (y - 0.5).clamp(0., h - 1.);
    let (ix, iy) = (px.floor() as u32, py.floor() as u32);
    let (jx, jy) = ((ix + 1).min(img.width() - 1), (iy + 1).min(img.height() - 1));
    let (fx, fy) = (px - ix as f32, py - iy as f32);
    let mut out = [0f32; 4];
    for (xx, yy, wt) in [(ix, iy, (1. - fx) * (1. - fy)), (jx, iy, fx * (1. - fy)), (ix, jy, (1. - fx) * fy), (jx, jy, fx * fy)] {
        let p = img.get_pixel(xx, yy);
        for c in 0..4 { out[c] += p[c] as f32 * wt; }
    }
    out
}

/// Low frequencies of `v` from the area outside the stroke only: a
/// normalized convolution, so a blemish under the brush does not leak into
/// the colour it is being matched to.
fn membrane(v: &[f32], weight: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut num: Vec<f32> = v.iter().zip(weight).map(|(a, b)| a * b).collect();
    let mut den = weight.to_vec();
    box_blur(&mut num, w, h, r);
    box_blur(&mut den, w, h, r);
    num.iter().zip(den).map(|(n, d)| if d > 1e-4 { n / d } else { 0. }).collect()
}

/// Applies the strokes to a copy of `img`, the stack beneath the layer.
pub fn render(img: &RgbaImage, strokes: &[RetouchStroke], geo: &[Op], base_short: f32) -> RgbaImage {
    let mut out = img.clone();
    let size = img.dimensions();
    let (w, h) = (size.0 as f32, size.1 as f32);
    for s in strokes {
        if s.points.len() < 2 { continue; }
        let pts: Vec<(f32, f32)> = s.points.chunks_exact(2).map(|c| { let (x, y) = map_point(c[0], c[1], geo); (x * w, y * h) }).collect();
        let r = (s.width * base_short * 0.5).max(0.5);
        let heal = s.kind == RetouchKind::Heal;
        let blur = (r * 0.6).round().max(1.) as usize;
        let Some((x0, y0, bw, bh, cov)) = coverage(&pts, r, s.hardness, if heal { blur as f32 * 3. } else { 0. }, size) else { continue };
        let strength = s.strength.clamp(0., 1.);
        match s.kind {
            RetouchKind::Clone | RetouchKind::Heal => {
                // The source offset is constant in output space because the
                // document geometry is affine.
                let (sx, sy) = (s.points[0], s.points[1]);
                let (ax, ay) = map_point(sx, sy, geo);
                let (bx, by) = map_point(sx - s.dx, sy - s.dy, geo);
                let (ox, oy) = ((bx - ax) * w, (by - ay) * h);
                let before = out.clone();
                let n = bw * bh;
                let mut source = vec![[0f32; 4]; n];
                let mut dest = vec![[0f32; 4]; n];
                for k in 0..n {
                    let (x, y) = ((x0 + (k % bw) as i64) as f32 + 0.5, (y0 + (k / bw) as i64) as f32 + 0.5);
                    source[k] = sample_px(&before, x + ox, y + oy);
                    dest[k] = before.get_pixel(x as u32, y as u32).0.map(|v| v as f32);
                }
                if heal {
                    let outside: Vec<f32> = cov.iter().map(|c| 1. - c).collect();
                    for c in 0..3 {
                        let d: Vec<f32> = dest.iter().map(|p| p[c]).collect();
                        let sv: Vec<f32> = source.iter().map(|p| p[c]).collect();
                        let (dl, sl) = (membrane(&d, &outside, bw, bh, blur), membrane(&sv, &outside, bw, bh, blur));
                        for k in 0..n { source[k][c] += dl[k] - sl[k]; }
                    }
                }
                let channels = if heal { 3 } else { 4 };
                for k in 0..n {
                    let a = cov[k] * strength;
                    if a <= 0. { continue; }
                    let p = out.get_pixel_mut((x0 + (k % bw) as i64) as u32, (y0 + (k / bw) as i64) as u32);
                    for c in 0..channels { p[c] = clamp8(dest[k][c] + (source[k][c] - dest[k][c]) * a + 0.5); }
                }
            }
            RetouchKind::Dodge | RetouchKind::Burn => {
                for k in 0..bw * bh {
                    if cov[k] <= 0. { continue; }
                    let p = out.get_pixel_mut((x0 + (k % bw) as i64) as u32, (y0 + (k / bw) as i64) as u32);
                    let l = luma(p) / 255.;
                    let range = match s.range { ToneRange::Shadows => (1. - l).powi(2), ToneRange::Midtones => 1. - (2. * l - 1.).powi(2), ToneRange::Highlights => l * l };
                    let a = cov[k] * strength * range * 0.6;
                    for c in 0..3 {
                        let v = p[c] as f32 / 255.;
                        let v = if s.kind == RetouchKind::Dodge { v + (1. - v) * a } else { v * (1. - a) };
                        p[c] = clamp8(v * 255. + 0.5);
                    }
                }
            }
        }
    }
    out
}

/// Picks a source for a spot-healing stroke: the nearby patch whose
/// surroundings best match the stroke's, in normalized `(dx, dy)` form.
pub fn suggest_offset(img: &RgbaImage, points: &[f32], width: f32) -> (f32, f32) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let pts: Vec<(f32, f32)> = points.chunks_exact(2).map(|c| (c[0] * w, c[1] * h)).collect();
    if pts.is_empty() { return (0., 0.); }
    let r = (width * w.min(h) * 0.5).max(1.);
    let Some((x0, y0, bw, bh, cov)) = coverage(&pts, r, 1., r, img.dimensions()) else { return (0., 0.) };
    // The ring just outside the brush is what the patch has to blend into.
    let mut ring = Vec::new();
    let mut inside = Vec::new();
    let step = ((bw * bh) as f32 / 4000.).sqrt().max(1.) as usize;
    for y in (0..bh).step_by(step) { for x in (0..bw).step_by(step) {
        let (px, py) = (x0 as f32 + x as f32 + 0.5, y0 as f32 + y as f32 + 0.5);
        let d = pts.windows(2).map(|s| dist_to_segment(px, py, s[0], s[1])).fold(dist_to_segment(px, py, pts[0], pts[0]), f32::min);
        if d > r && d <= r * 2. { ring.push((px, py)); } else if cov[y * bw + x] > 0.5 { inside.push((px, py)); }
    }}
    if ring.is_empty() { return (0., 0.); }
    let colour = |x: f32, y: f32| sample_px(img, x, y);
    let mean_ring = ring.iter().fold([0f32; 3], |acc, p| { let c = colour(p.0, p.1); [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]] }).map(|v| v / ring.len() as f32);
    let (mut best, mut cost) = ((r * 2.5, 0.), f32::MAX);
    for dist in [2.2, 3.0, 4.5] {
        for k in 0..16 {
            let a = k as f32 * std::f32::consts::TAU / 16.;
            let (vx, vy) = (a.cos() * r * dist, a.sin() * r * dist);
            let fits = |x: f32, y: f32| x >= 0. && y >= 0. && x < w && y < h;
            if !fits(x0 as f32 + vx, y0 as f32 + vy) || !fits(x0 as f32 + bw as f32 + vx - 1., y0 as f32 + bh as f32 + vy - 1.) { continue; }
            let diff = |p: [f32; 4], q: [f32; 4]| (0..3).map(|c| (p[c] - q[c]).powi(2)).sum::<f32>();
            let edge: f32 = ring.iter().map(|p| diff(colour(p.0, p.1), colour(p.0 + vx, p.1 + vy))).sum::<f32>() / ring.len() as f32;
            // Penalize patches that are themselves unlike the surroundings,
            // so the brush does not copy in another blemish.
            let body: f32 = if inside.is_empty() { 0. } else { inside.iter().map(|p| diff(colour(p.0 + vx, p.1 + vy), [mean_ring[0], mean_ring[1], mean_ring[2], 0.])).sum::<f32>() / inside.len() as f32 };
            let total = edge + body * 0.5 + dist * 4.;
            if total < cost { cost = total; best = (vx, vy); }
        }
    }
    (-best.0 / w, -best.1 / h)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stroke(kind: RetouchKind, points: Vec<f32>, dx: f32, dy: f32) -> RetouchStroke {
        RetouchStroke { kind, width: 0.1, hardness: 1., strength: 1., range: ToneRange::Midtones, dx, dy, points }
    }
    fn speckled() -> RgbaImage {
        let mut img = RgbaImage::new(200, 100);
        for (x, y, p) in img.enumerate_pixels_mut() { *p = Rgba([(x / 2) as u8, 100, 150 + (y / 4) as u8, 255]); }
        for y in 47..53 { for x in 47..53 { img.put_pixel(x, y, Rgba([0, 0, 0, 255])); } }
        img
    }
    #[test]
    fn clone_copies_the_offset_area_and_follows_geometry() {
        let img = speckled();
        let out = render(&img, &[stroke(RetouchKind::Clone, vec![0.25, 0.5], 0.0, 0.3)], &[], 100.);
        assert_eq!(out.get_pixel(50, 50).0, img.get_pixel(50, 20).0);
        assert_eq!(out.get_pixel(150, 50), img.get_pixel(150, 50));
        // Under a flip the same stroke lands on the mirrored pixels.
        let flipped = render(&imageops::flip_horizontal(&img), &[stroke(RetouchKind::Clone, vec![0.25, 0.5], 0.0, 0.3)], &[Op::FlipH], 100.);
        assert_eq!(imageops::flip_horizontal(&flipped), out);
    }
    #[test]
    fn healing_removes_a_blemish_and_matches_the_surroundings() {
        let img = speckled();
        // Source from a different tone: healing should still land on the
        // destination's colour, unlike a clone.
        let s = stroke(RetouchKind::Heal, vec![0.25, 0.5], -0.5, 0.0);
        let healed = render(&img, &[s.clone()], &[], 100.);
        let cloned = render(&img, &[RetouchStroke { kind: RetouchKind::Clone, ..s }], &[], 100.);
        let around = img.get_pixel(40, 50)[0] as i32;
        assert!((healed.get_pixel(50, 50)[0] as i32 - around).abs() < 12, "healed {} vs {around}", healed.get_pixel(50, 50)[0]);
        assert!((cloned.get_pixel(50, 50)[0] as i32 - around).abs() > 40);
        assert!(healed.get_pixel(50, 50)[1] > 80, "the black blemish is gone");
    }
    #[test]
    fn dodge_and_burn_respect_the_tonal_range() {
        let img = RgbaImage::from_pixel(100, 100, Rgba([128, 128, 128, 255]));
        let mut s = stroke(RetouchKind::Dodge, vec![0.5, 0.5], 0., 0.);
        assert!(render(&img, &[s.clone()], &[], 100.).get_pixel(50, 50)[0] > 170);
        s.kind = RetouchKind::Burn;
        assert!(render(&img, &[s.clone()], &[], 100.).get_pixel(50, 50)[0] < 80);
        s.range = ToneRange::Highlights;
        let dark = RgbaImage::from_pixel(100, 100, Rgba([20, 20, 20, 255]));
        assert!(render(&dark, &[s], &[], 100.).get_pixel(50, 50)[0] >= 19);
    }
    #[test]
    fn spot_healing_picks_a_clean_nearby_source() {
        let mut img = RgbaImage::from_pixel(200, 200, Rgba([120, 140, 160, 255]));
        for y in 97..103 { for x in 97..103 { img.put_pixel(x, y, Rgba([10, 10, 10, 255])); } }
        // Another blemish right of the first must not be chosen.
        for y in 90..110 { for x in 125..145 { img.put_pixel(x, y, Rgba([10, 10, 10, 255])); } }
        let (dx, dy) = suggest_offset(&img, &[0.5, 0.5], 0.08);
        assert!(dx != 0. || dy != 0.);
        let out = render(&img, &[RetouchStroke { kind: RetouchKind::Heal, width: 0.08, hardness: 0.8, strength: 1., range: ToneRange::Midtones, dx, dy, points: vec![0.5, 0.5] }], &[], 200.);
        assert!(out.get_pixel(100, 100)[0] > 100, "spot healed to {:?}", out.get_pixel(100, 100));
    }
}
