//! Per-layer compositing in source space keeps masks and transforms editable.
//!
//! A stack is rendered bottom to top. Groups recurse, and a run of clipped
//! layers is rendered against its base layer's alpha before the result is
//! blended into the stack, which is how Photoshop clipping masks behave.
use super::*;
use crate::project::Asset;
use std::cell::OnceCell;
use std::collections::{BTreeMap, VecDeque};

/// Everything a layer needs from the document it sits in.
pub struct Ctx<'a> {
    pub geo: &'a [Op],
    /// Source dimensions at the render resolution.
    pub dims: (u32, u32),
    /// The source at the render resolution, before any edits.
    pub src: &'a RgbaImage,
    pub assets: &'a BTreeMap<String, Asset>,
    pub full: bool,
    ops: &'a [Op],
    toned: OnceCell<RgbaImage>,
}

impl<'a> Ctx<'a> {
    pub fn new(geo: &'a [Op], src: &'a RgbaImage, ops: &'a [Op], assets: &'a BTreeMap<String, Asset>, full: bool) -> Self {
        Ctx { geo, dims: src.dimensions(), src, assets, full, ops, toned: OnceCell::new() }
    }
    fn short(&self) -> f32 { self.dims.0.min(self.dims.1).max(1) as f32 }
    /// The photograph with the document's tone and colour edits but none of
    /// its geometry, in source space. Computed once per render, on demand.
    fn toned(&self) -> &RgbaImage {
        self.toned.get_or_init(|| {
            let tone: Vec<Op> = self.ops.iter().filter(|o| !is_geometry(o) && !matches!(o, Op::Lasso { .. } | Op::Layer { .. } | Op::Group { .. })).cloned().collect();
            apply_with_assets(self.src, &tone, self.assets, self.full)
        })
    }
}

/// Every layer and group in a stack, depth first.
pub fn walk_layers<'a>(ops: &'a [Op], f: &mut dyn FnMut(&'a Op)) {
    for op in ops {
        if matches!(op, Op::Layer { .. } | Op::Group { .. }) { f(op); }
        if let Op::Group { children, .. } = op { walk_layers(children, f); }
    }
}

pub fn find_layer<'a>(ops: &'a [Op], wanted: &str) -> Option<&'a Op> {
    let mut found = None;
    walk_layers(ops, &mut |op| if let Op::Layer { id, .. } | Op::Group { id, .. } = op { if id == wanted && found.is_none() { found = Some(op); } });
    found
}

fn content_image(content: &Op, dims: (u32,u32), ctx: Option<&Ctx>, assets: &BTreeMap<String,Asset>, full: bool) -> RgbaImage {
    let mut image = RgbaImage::new(dims.0,dims.1);
    match content {
        Op::Photo { asset_id,width,height } => {
            if let Some(asset) = assets.get(asset_id) {
                // Assets are decoded and validated on import and project load.
                let original;
                let photo = if full { original = crate::limits::decode("Photo layer", &asset.source).expect("validated photo asset"); &original } else { &asset.preview };
                let w = (width*dims.0 as f32).round().max(1.) as u32;
                let h = (height*dims.1 as f32).round().max(1.) as u32;
                let resized = imageops::resize(photo,w,h,imageops::FilterType::Triangle);
                imageops::overlay(&mut image,&resized,((dims.0-w)/2) as i64,((dims.1-h)/2) as i64);
            }
        }
        Op::Fill { color } => { for p in image.pixels_mut() { *p = Rgba(*color); } }
        Op::Source => if let Some(ctx) = ctx { image = ctx.toned().clone(); },
        _ => render_overlay(&mut image,content,&[],dims,dims.0.min(dims.1) as f32),
    }
    image
}

/// Bounds of a layer's untransformed content in normalized source space,
/// for placing transform handles. `src` is a small copy of the source, used
/// when the content is the masked photograph itself.
pub fn content_bounds(op: &Op, dims: (u32,u32), assets: &BTreeMap<String,Asset>, src: &RgbaImage) -> [f32;4] {
    let Op::Layer { content, mask, .. } = op else { return [0.,0.,1.,1.] };
    let alpha_bounds = |image: &RgbaImage, channel: usize| {
        let (mut x0,mut y0,mut x1,mut y1) = (image.width(),image.height(),0,0);
        for (x,y,p) in image.enumerate_pixels() { if p[channel]>8 && p[3]>0 { x0=x0.min(x);y0=y0.min(y);x1=x1.max(x+1);y1=y1.max(y+1); } }
        (x1>x0 && y1>y0).then(|| [x0 as f32/image.width() as f32,y0 as f32/image.height() as f32,(x1-x0) as f32/image.width() as f32,(y1-y0) as f32/image.height() as f32])
    };
    match content.as_ref() {
        Op::Photo { width,height,.. } => return [(1.-width)/2.,(1.-height)/2.,*width,*height],
        Op::Fill { .. } | Op::Source => {
            // The content fills the frame; what shapes it is the mask.
            let m = mask_image(mask, src.dimensions(), src);
            return m.and_then(|m| alpha_bounds(&m, 0)).unwrap_or([0.,0.,1.,1.]);
        }
        Op::Adjustment { .. } | Op::Retouch { .. } => return [0.,0.,1.,1.],
        _ => {}
    }
    let scale = 512. / dims.0.max(dims.1) as f32;
    let image = content_image(content,((dims.0 as f32*scale).round().max(1.) as u32,(dims.1 as f32*scale).round().max(1.) as u32),None,assets,false);
    alpha_bounds(&image, 3).unwrap_or([0.25,0.25,0.5,0.5])
}

/// The mask as greyscale in red, at `dims`, in the layer's own space.
fn mask_image(mask: &Option<LayerMask>, dims: (u32,u32), src: &RgbaImage) -> Option<RgbaImage> {
    let m = mask.as_ref().filter(|m| m.enabled)?;
    let mut image = match &m.selection {
        Some(sel) => {
            let raster = select::rasterize_cached(sel, src);
            RgbaImage::from_fn(dims.0, dims.1, |x, y| {
                let (lx, ly) = ((x as f32 + 0.5) / dims.0 as f32, (y as f32 + 0.5) / dims.1 as f32);
                let (wx, wy) = forward(lx, ly, &m.origin, dims);
                let v = clamp8(raster.sample(wx, wy) * 255.0 + 0.5);
                Rgba([v, v, v, 255])
            })
        }
        None => RgbaImage::from_pixel(dims.0,dims.1,Rgba([255;4])),
    };
    paint(&mut image,&m.strokes,&[],dims.0.min(dims.1) as f32);
    if m.inverted { for p in image.pixels_mut() { p[0]=255-p[0]; } }
    Some(image)
}

/// Output coordinates back through the document's crop/rotate/flip operations.
pub fn unmap(mut x: f32, mut y: f32, geo: &[Op]) -> (f32,f32) {
    for op in geo.iter().rev() {
        match *op {
            Op::Crop { x:cx,y:cy,w,h } => { x=cx+x*w; y=cy+y*h; }
            Op::Rotate { turns } => for _ in 0..turns%4 { (x,y)=(y,1.-x); },
            Op::FlipH => x=1.-x,
            Op::FlipV => y=1.-y,
            _=>{}
        }
    }
    (x,y)
}
fn inverse(x: f32,y: f32,t: &Transform,dims: (u32,u32)) -> (f32,f32) {
    let px=(x-t.anchor_x-t.tx)*dims.0 as f32;
    let py=(y-t.anchor_y-t.ty)*dims.1 as f32;
    let (sin,cos)=t.rotation.to_radians().sin_cos();
    ((px*cos+py*sin)/t.sx/dims.0 as f32+t.anchor_x,(-px*sin+py*cos)/t.sy/dims.1 as f32+t.anchor_y)
}
/// Layer space to document source space; the inverse of `inverse`.
fn forward(x: f32,y: f32,t: &Transform,dims: (u32,u32)) -> (f32,f32) {
    let px=(x-t.anchor_x)*dims.0 as f32*t.sx;
    let py=(y-t.anchor_y)*dims.1 as f32*t.sy;
    let (sin,cos)=t.rotation.to_radians().sin_cos();
    ((px*cos-py*sin)/dims.0 as f32+t.anchor_x+t.tx,(px*sin+py*cos)/dims.1 as f32+t.anchor_y+t.ty)
}
/// Bilinear filtering in premultiplied space avoids dark rims around cut-outs.
pub(crate) fn sample(image: &RgbaImage, x: f32,y: f32) -> [f32;4] {
    let px=x*image.width() as f32-0.5; let py=y*image.height() as f32-0.5;
    let ix=px.floor() as i32; let iy=py.floor() as i32;
    let fx=px-ix as f32; let fy=py-iy as f32;
    let mut out=[0.;4];
    for (dx,dy,w) in [(0,0,(1.-fx)*(1.-fy)),(1,0,fx*(1.-fy)),(0,1,(1.-fx)*fy),(1,1,fx*fy)] {
        let xx=ix+dx; let yy=iy+dy;
        if xx<0 || yy<0 || xx>=image.width() as i32 || yy>=image.height() as i32 {continue;}
        let p=image.get_pixel(xx as u32,yy as u32); let a=p[3] as f32/255.*w;
        for c in 0..3 {out[c]+=p[c] as f32/255.*a;} out[3]+=a;
    }
    if out[3]>0. {for c in 0..3 {out[c]/=out[3];}} out
}

// Separable maximum filter: linear work per pixel, even on large exports.
fn dilate(alpha: &[u8],w: usize,h: usize,r: usize) -> Vec<u8> {
    let mut tmp=vec![0;w*h]; let mut out=vec![0;w*h];
    for (src,dst,rows,cols,vertical) in [(alpha,&mut tmp,w,h,true)] {
        for row in 0..rows { let mut q: VecDeque<usize>=VecDeque::new(); let mut next=0;
            let index=|c:usize| if vertical {c*w+row} else {row*w+c};
            for c in 0..cols {
                while next<cols && next<=c+r { while q.back().is_some_and(|&b|src[index(b)]<=src[index(next)]) {q.pop_back();} q.push_back(next);next+=1; }
                while q.front().is_some_and(|&f|f<c.saturating_sub(r)) {q.pop_front();}
                dst[index(c)]=src[index(*q.front().unwrap())];
            }
        }
    }
    for row in 0..h { let mut q: VecDeque<usize>=VecDeque::new();let mut next=0;
        for c in 0..w {
            while next<w && next<=c+r {while q.back().is_some_and(|&b|tmp[row*w+b]<=tmp[row*w+next]) {q.pop_back();}q.push_back(next);next+=1;}
            while q.front().is_some_and(|&f|f<c.saturating_sub(r)) {q.pop_front();}
            out[row*w+c]=tmp[row*w+*q.front().unwrap()];
        }
    } out
}
fn rgbf(c: [u8;4]) -> [f32;3] { [c[0] as f32/255.,c[1] as f32/255.,c[2] as f32/255.] }
fn blurred_alpha(alpha: &[f32], w: usize, h: usize, r: f32) -> Vec<f32> {
    let mut out = alpha.to_vec();
    box_blur(&mut out, w, h, (r / 1.7).round().max(1.) as usize);
    out
}
/// Applies layer styles within the content's bounding box, padded by how far
/// the effects reach. Layers are usually much smaller than the frame, and
/// every effect below works per pixel.
fn styles(image: RgbaImage,style: &LayerStyle) -> RgbaImage {
    if !style.any() {return image;}
    let (w,h)=image.dimensions();let short=w.min(h) as f32;
    let (mut x0,mut y0,mut x1,mut y1)=(w,h,0,0);
    for (x,y,p) in image.enumerate_pixels() { if p[3]>0 { x0=x0.min(x);y0=y0.min(y);x1=x1.max(x+1);y1=y1.max(y+1); } }
    if x1<=x0 {return image;}
    let reach=|on: bool,v: f32| if on {v} else {0.};
    let pad=(short*(reach(style.shadow,style.shadow_x.abs().max(style.shadow_y.abs())+style.shadow_blur*3.)
        +reach(style.glow,style.glow_size*3.)+reach(style.outline,style.outline_width))).ceil() as u32+4;
    let (cx,cy)=(x0.saturating_sub(pad),y0.saturating_sub(pad));
    let (cw,ch)=((x1+pad).min(w)-cx,(y1+pad).min(h)-cy);
    if cw==w && ch==h {return styles_in(image,style,short);}
    let styled=styles_in(imageops::crop_imm(&image,cx,cy,cw,ch).to_image(),style,short);
    let mut out=RgbaImage::new(w,h);
    imageops::replace(&mut out,&styled,cx as i64,cy as i64);
    out
}
fn styles_in(image: RgbaImage,style: &LayerStyle,short: f32) -> RgbaImage {
    let (w,h)=image.dimensions();
    let alpha:Vec<u8>=image.pixels().map(|p|p[3]).collect();
    let alpha_f:Vec<f32>=alpha.iter().map(|a|*a as f32/255.).collect();
    let mut out=RgbaImage::new(w,h);
    if style.shadow {
        let mut shadow=RgbaImage::new(w,h);
        for (p,a) in shadow.pixels_mut().zip(&alpha) {*p=Rgba([0,0,0,*a]);}
        let shadow=if style.shadow_blur>0. {imageops::blur(&shadow,(style.shadow_blur*short).max(0.1))} else {shadow};
        let ox=(style.shadow_x*short).round() as i64;let oy=(style.shadow_y*short).round() as i64;
        for (x,y,p) in out.enumerate_pixels_mut() {
            let sx=x as i64-ox;let sy=y as i64-oy;
            if sx>=0 && sy>=0 && sx<w as i64 && sy<h as i64 {*p=Rgba(style.shadow_color);p[3]=(shadow.get_pixel(sx as u32,sy as u32)[3] as f32*style.shadow_color[3] as f32/255.).round() as u8;}
        }
    }
    if style.glow && style.glow_size>0. {
        // A soft halo behind the content, boosted so it reads at the edge
        // instead of fading to nothing right where the shape begins.
        let halo=blurred_alpha(&alpha_f,w as usize,h as usize,style.glow_size*short);
        for (p,g) in out.pixels_mut().zip(halo) {blend_px(p,rgbf(style.glow_color),(g*2.).min(1.)*style.glow_color[3] as f32/255.,Blend::Normal);}
    }
    if style.outline && style.outline_width>0. {
        let grown=dilate(&alpha,w as usize,h as usize,(style.outline_width*short).round().max(1.) as usize);
        for (p,a) in out.pixels_mut().zip(grown) {blend_px(p,rgbf(style.outline_color),a as f32/255.*style.outline_color[3] as f32/255.,Blend::Normal);}
    }
    imageops::overlay(&mut out,&image,0,0);
    // Effects that sit on the content keep its alpha: they change colour only
    // where the layer already has pixels.
    let atop=|out: &mut RgbaImage, amount: &dyn Fn(usize)->f32, color: [u8;4], lighten: Option<bool>| {
        for (i,p) in out.pixels_mut().enumerate() {
            let a=alpha_f[i]*amount(i)*color[3] as f32/255.;
            if a<=0. {continue;}
            for c in 0..3 {
                let v=p[c] as f32/255.;
                let target=match lighten { Some(true)=>v+(1.-v)*color[c] as f32/255., Some(false)=>v*color[c] as f32/255., None=>color[c] as f32/255. };
                p[c]=clamp8((v+(target-v)*a)*255.+0.5);
            }
        }
    };
    if style.inner_glow && style.inner_glow_size>0. {
        let soft=blurred_alpha(&alpha_f,w as usize,h as usize,style.inner_glow_size*short);
        atop(&mut out,&|i|((1.-soft[i])*2.).clamp(0.,1.),style.inner_glow_color,None);
    }
    if style.bevel && style.bevel_size>0. {
        // A height field from the blurred alpha, lit from bevel_angle at 30°
        // elevation. Slopes are scaled by the bevel size, so the look does not
        // change with the render resolution.
        let r=(style.bevel_size*short).max(1.);
        let height=blurred_alpha(&alpha_f,w as usize,h as usize,r);
        let (wi,hi)=(w as usize,h as usize);
        // At depth 1 the steepest part of the bevel is close to 45°.
        let k=style.bevel_depth*r*3.;
        let (az,alt)=(style.bevel_angle.to_radians(),30f32.to_radians());
        let light=[az.cos()*alt.cos(),-az.sin()*alt.cos(),alt.sin()];
        let at=|x: usize,y: usize| height[y.min(hi-1)*wi+x.min(wi-1)];
        let mut shade=vec![0f32;wi*hi];
        for y in 0..hi { for x in 0..wi {
            if alpha[y*wi+x]==0 {continue;}
            let gx=(at(x+1,y)-at(x.saturating_sub(1),y))*0.5*k;
            let gy=(at(x,y+1)-at(x,y.saturating_sub(1)))*0.5*k;
            let n=[-gx,-gy,1.];let len=(n[0]*n[0]+n[1]*n[1]+1.).sqrt();
            shade[y*wi+x]=(n[0]*light[0]+n[1]*light[1]+n[2]*light[2])/len-light[2];
        }}
        // Highlights screen and shadows multiply, the usual bevel modes.
        atop(&mut out,&|i|(shade[i]*3.).clamp(0.,1.),style.bevel_highlight,Some(true));
        atop(&mut out,&|i|(-shade[i]*3.).clamp(0.,1.),style.bevel_shadow,Some(false));
    }
    out
}

fn is_clipped(op: &Op) -> bool { matches!(op, Op::Layer { clip: true, .. } | Op::Group { clip: true, .. }) }
fn is_visible(op: &Op) -> bool { matches!(op, Op::Layer { visible: true, .. } | Op::Group { visible: true, .. }) }
/// Adjustments and retouching have no pixels of their own to clip against.
fn has_pixels(op: &Op) -> bool { match op { Op::Layer { content, .. } => !matches!(content.as_ref(), Op::Adjustment { .. } | Op::Retouch { .. }), _ => true } }

/// Composites a stack of layers and groups onto `img`, bottom first.
pub fn render_items(img: &mut RgbaImage, items: &[Op], ctx: &Ctx) {
    let mut i = 0;
    while i < items.len() {
        let base = &items[i];
        let end = items[i + 1..].iter().position(|o| !is_clipped(o)).map_or(items.len(), |n| i + 1 + n);
        // Clipped layers vanish with a hidden base, as in Photoshop.
        if !is_visible(base) { i = end; continue; }
        if end == i + 1 || !has_pixels(base) {
            for item in &items[i..end] { composite_item(img, item, ctx, None); }
            i = end;
            continue;
        }
        let (w, h) = img.dimensions();
        let mut group = RgbaImage::new(w, h);
        composite_item(&mut group, base, ctx, Some((1.0, Blend::Normal)));
        let alpha: Vec<u8> = group.pixels().map(|p| p[3]).collect();
        if alpha.iter().any(|a| *a > 0) {
            // With the base made opaque, source-over equals source-atop once
            // the base's alpha is put back, blend modes included.
            for p in group.pixels_mut() { p[3] = 255; }
            for item in &items[i + 1..end] { composite_item(&mut group, item, ctx, None); }
            for (p, a) in group.pixels_mut().zip(&alpha) { p[3] = *a; }
            let (opacity, blend) = match base { Op::Layer { opacity, blend, .. } | Op::Group { opacity, blend, .. } => (*opacity, *blend), _ => (1.0, Blend::Normal) };
            for (p, q) in img.pixels_mut().zip(group.pixels()) {
                if q[3] > 0 { blend_px(p, rgbf(q.0), q[3] as f32 / 255. * opacity, blend); }
            }
        }
        i = end;
    }
}

/// Per-pixel strength from opacity and a document-space mask.
fn mix(img: &mut RgbaImage, result: &RgbaImage, opacity: f32, mask: Option<&RgbaImage>, geo: &[Op], channels: usize) {
    let (w, h) = img.dimensions();
    for (x, y, p) in img.enumerate_pixels_mut() {
        let strength = opacity * mask.map_or(1., |m| {
            let (sx, sy) = unmap((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32, geo);
            sample(m, sx, sy)[0]
        });
        if strength <= 0. { continue; }
        let q = result.get_pixel(x, y);
        for c in 0..channels { p[c] = (p[c] as f32 * (1. - strength) + q[c] as f32 * strength).round() as u8; }
    }
}

fn composite_item(img: &mut RgbaImage, op: &Op, ctx: &Ctx, over: Option<(f32, Blend)>) {
    match op {
        Op::Layer { visible, opacity, .. } => {
            let opacity = over.map_or(*opacity, |o| o.0);
            if *visible && opacity > 0.0 { composite_layer(img, op, ctx, over); }
        }
        Op::Group { visible, opacity, blend, pass_through, children, mask, .. } => {
            let (opacity, blend) = over.unwrap_or((*opacity, *blend));
            if !*visible || opacity <= 0.0 { return; }
            let mask_bitmap = mask_image(mask, ctx.dims, ctx.src);
            if *pass_through && over.is_none() {
                let mut result = img.clone();
                render_items(&mut result, children, ctx);
                mix(img, &result, opacity, mask_bitmap.as_ref(), ctx.geo, 4);
                return;
            }
            let (w, h) = img.dimensions();
            let mut group = RgbaImage::new(w, h);
            render_items(&mut group, children, ctx);
            for (x, y, p) in img.enumerate_pixels_mut() {
                let q = group.get_pixel(x, y);
                if q[3] == 0 { continue; }
                let m = mask_bitmap.as_ref().map_or(1., |m| {
                    let (sx, sy) = unmap((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32, ctx.geo);
                    sample(m, sx, sy)[0]
                });
                blend_px(p, rgbf(q.0), q[3] as f32 / 255. * opacity * m, blend);
            }
        }
        _ => {}
    }
}

fn composite_layer(img: &mut RgbaImage, op: &Op, ctx: &Ctx, over: Option<(f32, Blend)>) {
    let Op::Layer { content,opacity,blend,transform,mask,style,.. }=op else {return};
    let (opacity, blend) = over.unwrap_or((*opacity, *blend));
    let (geo, dims) = (ctx.geo, ctx.dims);
    let mask_bitmap=mask_image(mask,dims,ctx.src);
    match content.as_ref() {
        Op::Adjustment { exposure,brightness,contrast,saturation,warmth } => {
            let mut adjusted=img.clone();
            for op in [Op::Exposure{value:*exposure},Op::Brightness{value:*brightness},Op::Contrast{value:*contrast},Op::Saturation{value:*saturation},Op::Warmth{value:*warmth}] {adjusted=apply_one(adjusted,&op);}
            mix(img, &adjusted, opacity, mask_bitmap.as_ref(), geo, 3);
            return;
        }
        Op::Retouch { strokes } => {
            let retouched = retouch::render(img, strokes, geo, ctx.short());
            mix(img, &retouched, opacity, mask_bitmap.as_ref(), geo, 4);
            return;
        }
        _ => {}
    }
    // Preserve the original v4 rasterizer exactly for unchanged legacy layers.
    if *transform==Transform::default() && mask_bitmap.is_none() && !style.any() && !matches!(content.as_ref(),Op::Photo{..} | Op::Fill{..} | Op::Source) {
        let mut overlay=RgbaImage::new(img.width(),img.height());
        render_overlay(&mut overlay,content,geo,dims,dims.0.min(dims.1) as f32);
        for (p,q) in img.pixels_mut().zip(overlay.pixels()) {blend_px(p,[q[0] as f32/255.,q[1] as f32/255.,q[2] as f32/255.],q[3] as f32/255.*opacity,blend);} return;
    }
    let mut overlay=content_image(content,dims,Some(ctx),ctx.assets,ctx.full);
    if let Some(m)=mask_bitmap {for (p,q) in overlay.pixels_mut().zip(m.pixels()) {p[3]=(p[3] as f32*q[0] as f32/255.).round() as u8;}}
    let overlay=styles(overlay,style);
    let (w,h)=img.dimensions();
    for (x,y,p) in img.enumerate_pixels_mut() {
        let (sx,sy)=unmap((x as f32+0.5)/w as f32,(y as f32+0.5)/h as f32,geo);
        let (sx,sy)=inverse(sx,sy,transform,dims);
        let q=sample(&overlay,sx,sy);
        if q[3]>0. {blend_px(p,[q[0],q[1],q[2]],q[3]*opacity,blend);}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn layer(content: Op) -> Op { Op::Layer { id:"layer".into(), name:"Layer".into(), visible:true, opacity:1., blend:Blend::Normal, content:Box::new(content), transform:Transform::default(), mask:None, style:LayerStyle::default(), clip:false } }
    fn rect(x0:f32,y0:f32,x1:f32,y1:f32,c:[u8;4]) -> Op { layer(Op::Shapes { items:vec![Shape { kind:ShapeKind::Rect,x0,y0,x1,y1,fill:Some(c),stroke:None,width:0.01 }] }) }
    fn square() -> Op { rect(0.3,0.3,0.7,0.7,[255,0,0,255]) }
    fn blank() -> RgbaImage { RgbaImage::new(100,100) }
    fn mask_stroke(v:u8) -> Stroke {Stroke{color:[v,v,v,255],width:0.2,erase:false,points:vec![0.5,0.5]}}
    fn plain_mask(strokes: Vec<Stroke>) -> Option<LayerMask> { Some(LayerMask{enabled:true,inverted:false,strokes,selection:None,origin:Transform::default()}) }
    fn group(children: Vec<Op>, pass_through: bool) -> Op { Op::Group { id:"g".into(), name:"Group".into(), visible:true, opacity:1., blend:Blend::Normal, pass_through, children, mask:None, clip:false, collapsed:false } }
    fn set_clip(op: &mut Op) { if let Op::Layer{clip,..}|Op::Group{clip,..}=op {*clip=true;} }
    #[test]
    fn transform_moves_and_scales_content_and_survives_document_geometry() {
        let mut op=square();
        if let Op::Layer{transform:t,..}=&mut op { t.tx=0.2;t.sx=0.5;t.sy=0.5; }
        let out=apply_all(&blank(),&[op.clone()]);
        assert_eq!(out.get_pixel(50,50)[3],0);assert_eq!(out.get_pixel(70,50).0,[255,0,0,255]);
        let turned=apply_all(&blank(),&[Op::Rotate{turns:1},Op::FlipH,op]);
        assert_eq!(turned.get_pixel(50,70).0,[255,0,0,255]);assert_eq!(turned.get_pixel(70,50)[3],0);
    }
    #[test]
    fn mask_can_hide_restore_invert_disable_and_follow_transform() {
        let mut op=square();
        if let Op::Layer{mask,transform,..}=&mut op { *mask=plain_mask(vec![mask_stroke(0)]);transform.tx=0.2; }
        let out=apply_all(&blank(),&[op.clone()]);assert_eq!(out.get_pixel(70,50)[3],0);assert_eq!(out.get_pixel(55,50)[3],255);
        if let Op::Layer{mask:Some(m),..}=&mut op {m.inverted=true;}
        let out=apply_all(&blank(),&[op.clone()]);assert_eq!(out.get_pixel(70,50)[3],255);assert_eq!(out.get_pixel(55,50)[3],0);
        if let Op::Layer{mask:Some(m),..}=&mut op {m.inverted=false;m.strokes.push(mask_stroke(255));}
        assert_eq!(apply_all(&blank(),&[op.clone()]).get_pixel(70,50)[3],255);
        if let Op::Layer{mask:Some(m),..}=&mut op {m.strokes=vec![mask_stroke(0)];m.enabled=false;}
        assert_eq!(apply_all(&blank(),&[op]).get_pixel(70,50)[3],255);
    }
    #[test]
    fn adjustment_affects_only_lower_layers_and_preserves_alpha() {
        let base=RgbaImage::from_pixel(100,100,Rgba([50,60,70,128]));
        let a=layer(Op::Adjustment{exposure:0.,brightness:0.5,contrast:0.,saturation:0.,warmth:0.});
        let above=apply_all(&base,&[square(),a.clone()]);
        let below=apply_all(&base,&[a.clone(),square()]);
        assert_eq!(below.get_pixel(50,50).0,[255,0,0,255]);assert!(above.get_pixel(50,50)[1]>0);
        assert_eq!(above.get_pixel(0,0)[3],128);assert!(above.get_pixel(0,0)[0]>50);
        let mut masked=a;
        if let Op::Layer{mask,..}=&mut masked{*mask=plain_mask(vec![mask_stroke(0)]);}
        let out=apply_all(&base,&[masked]);assert_eq!(out.get_pixel(50,50).0,[50,60,70,128]);assert!(out.get_pixel(0,0)[0]>50);
    }
    #[test]
    fn shadows_and_outlines_expand_alpha_without_changing_the_source() {
        let mut op=square();
        if let Op::Layer{style:s,..}=&mut op {s.outline=true;s.outline_width=0.03;s.outline_color=[255,255,255,255];s.shadow=true;s.shadow_color=[0,0,0,180];s.shadow_x=0.1;s.shadow_y=0.1;}
        let out=apply_all(&blank(),&[op]);assert_eq!(out.get_pixel(28,50).0,[255;4]);assert_eq!(out.get_pixel(50,50).0,[255,0,0,255]);assert_eq!(out.get_pixel(75,75)[3],180);assert_eq!(out.get_pixel(20,20)[3],0);
    }
    #[test]
    fn glows_and_bevels_light_the_right_places() {
        let base=RgbaImage::from_pixel(200,200,Rgba([0,0,0,255]));
        let mut op=rect(0.3,0.3,0.7,0.7,[128,128,128,255]);
        if let Op::Layer{style:s,..}=&mut op {s.glow=true;s.glow_color=[255,200,0,255];s.glow_size=0.03;}
        let out=apply_all(&base,&[op.clone()]);
        assert!(out.get_pixel(56,100)[0]>40,"outer glow lights the backdrop beside the edge");
        assert_eq!(out.get_pixel(5,5).0,[0,0,0,255]);assert_eq!(out.get_pixel(100,100).0,[128,128,128,255]);
        if let Op::Layer{style:s,..}=&mut op {s.glow=false;s.inner_glow=true;s.inner_glow_color=[255,255,255,255];s.inner_glow_size=0.03;}
        let out=apply_all(&base,&[op.clone()]);
        assert!(out.get_pixel(61,100)[0]>170,"inner glow brightens inside the edge");assert_eq!(out.get_pixel(100,100).0,[128,128,128,255]);
        assert_eq!(out.get_pixel(55,100).0,[0,0,0,255],"inner glow stays inside the shape");
        if let Op::Layer{style:s,..}=&mut op {s.inner_glow=false;s.bevel=true;s.bevel_size=0.03;s.bevel_angle=120.;}
        let out=apply_all(&base,&[op]);
        let (lit,shaded)=(out.get_pixel(62,100)[0],out.get_pixel(138,100)[0]);
        assert!(lit>150 && shaded<100,"upper-left light: left edge {lit}, right edge {shaded}");
        assert_eq!(out.get_pixel(100,100).0,[128,128,128,255]);
    }
    #[test]
    fn clipped_layers_only_paint_inside_their_base() {
        let base=RgbaImage::from_pixel(100,100,Rgba([0,0,0,255]));
        let mut clipped=rect(0.,0.,1.,0.5,[0,0,255,255]);set_clip(&mut clipped);
        let out=apply_all(&base,&[square(),clipped.clone()]);
        assert_eq!(out.get_pixel(50,40).0,[0,0,255,255],"inside the base and the clipped shape");
        assert_eq!(out.get_pixel(50,60).0,[255,0,0,255],"inside the base only");
        assert_eq!(out.get_pixel(10,10).0,[0,0,0,255],"outside the base");
        // A hidden base hides its clipped layers too.
        let mut hidden=square();if let Op::Layer{visible,..}=&mut hidden{*visible=false;}
        assert_eq!(apply_all(&base,&[hidden,clipped.clone()]),base);
        // A clipped adjustment changes only the base.
        let mut adj=layer(Op::Adjustment{exposure:0.,brightness:-1.,contrast:0.,saturation:0.,warmth:0.});set_clip(&mut adj);
        let grey=RgbaImage::from_pixel(100,100,Rgba([90,90,90,255]));
        let out=apply_all(&grey,&[square(),adj]);
        assert_eq!(out.get_pixel(50,50).0,[0,0,0,255]);assert_eq!(out.get_pixel(10,10).0,[90,90,90,255]);
        // Base opacity applies to the clipping group as a whole.
        let mut faint=square();if let Op::Layer{opacity,..}=&mut faint{*opacity=0.5;}
        let out=apply_all(&base,&[faint,clipped]);
        assert!((out.get_pixel(50,40)[2] as i32-128).abs()<=1);assert_eq!(out.get_pixel(50,40)[0],0);
    }
    #[test]
    fn pass_through_and_isolated_groups() {
        let grey=RgbaImage::from_pixel(100,100,Rgba([90,90,90,255]));
        let adj=layer(Op::Adjustment{exposure:0.,brightness:-1.,contrast:0.,saturation:0.,warmth:0.});
        // Pass-through: the adjustment reaches the photo below the group.
        let out=apply_all(&grey,&[group(vec![adj.clone()],true)]);
        assert_eq!(out.get_pixel(10,10).0,[0,0,0,255]);
        // Isolated: it only reaches layers inside the group.
        let out=apply_all(&grey,&[group(vec![square(),adj.clone()],false)]);
        assert_eq!(out.get_pixel(10,10).0,[90,90,90,255]);assert_eq!(out.get_pixel(50,50).0,[0,0,0,255]);
        // Group opacity and visibility apply to the children together.
        let mut g=group(vec![square()],false);
        if let Op::Group{opacity,..}=&mut g{*opacity=0.5;}
        assert!((apply_all(&grey,&[g.clone()]).get_pixel(50,50)[0] as i32-173).abs()<=1);
        if let Op::Group{visible,..}=&mut g{*visible=false;}
        assert_eq!(apply_all(&grey,&[g]),grey);
        // A group mask hides part of every child.
        let mut g=group(vec![square()],true);
        if let Op::Group{mask,..}=&mut g{*mask=plain_mask(vec![mask_stroke(0)]);}
        let out=apply_all(&grey,&[g]);
        assert_eq!(out.get_pixel(50,50).0,[90,90,90,255]);assert_eq!(out.get_pixel(32,32).0,[255,0,0,255]);
        // Layers clip to a group like any other base, and groups nest.
        let mut clipped=rect(0.,0.,1.,0.5,[0,0,255,255]);set_clip(&mut clipped);
        let out=apply_all(&grey,&[group(vec![group(vec![square()],false)],true),clipped]);
        assert_eq!(out.get_pixel(50,40).0,[0,0,255,255]);assert_eq!(out.get_pixel(50,60).0,[255,0,0,255]);assert_eq!(out.get_pixel(50,10).0,[90,90,90,255]);
    }
    #[test]
    fn selections_shape_fill_and_copied_source_layers() {
        let mut src=RgbaImage::from_pixel(100,100,Rgba([20,20,20,255]));
        for y in 0..100 { for x in 50..100 { src.put_pixel(x,y,Rgba([200,40,40,255])); } }
        let sel=|shapes: Vec<select::SelShape>| Selection{shapes,..Default::default()};
        let mut fill=layer(Op::Fill{color:[0,255,0,255]});
        if let Op::Layer{mask,..}=&mut fill{*mask=Some(LayerMask{enabled:true,inverted:false,strokes:vec![],selection:Some(sel(vec![select::SelShape::Rect{x0:0.1,y0:0.1,x1:0.3,y1:0.3,mode:Default::default()}])),origin:Transform::default()});}
        let out=apply_all(&src,&[fill.clone()]);
        assert_eq!(out.get_pixel(20,20).0,[0,255,0,255]);assert_eq!(out.get_pixel(40,40).0,[20,20,20,255]);
        // The selection is pinned where the layer was, then moves with it.
        if let Op::Layer{transform,..}=&mut fill{transform.tx=0.5;}
        let out=apply_all(&src,&[fill]);assert_eq!(out.get_pixel(20,20).0,[20,20,20,255]);assert_eq!(out.get_pixel(70,20).0,[0,255,0,255]);
        // A magic-wand copy of the red half, with the document's edits, moved left.
        let mut copy=layer(Op::Source);
        if let Op::Layer{mask,transform,..}=&mut copy{*mask=Some(LayerMask{enabled:true,inverted:false,strokes:vec![],selection:Some(sel(vec![select::SelShape::Wand{x:0.8,y:0.5,tolerance:0.1,contiguous:true,mode:Default::default()}])),origin:Transform::default()});transform.tx=-0.5;}
        let out=apply_all(&src,&[Op::Invert,copy]);
        assert_eq!(out.get_pixel(20,50).0,[55,215,215,255]);assert_eq!(out.get_pixel(70,50).0,[55,215,215,255]);
    }
    #[test]
    fn bilinear_sampling_keeps_transparent_edges_bright() {
        let mut img=RgbaImage::new(2,1);img.put_pixel(0,0,Rgba([255,255,255,255]));
        assert_eq!(sample(&img,0.5,0.5),[1.,1.,1.,0.5]);
    }
    #[test]
    fn v4_layers_gain_identity_defaults_and_invalid_new_fields_are_rejected() {
        let legacy=r#"{"op":"layer","id":"a","name":"A","visible":true,"opacity":1,"blend":"normal","content":{"op":"paint","strokes":[]}}"#;
        let mut op:Op=serde_json::from_str(legacy).unwrap();assert!(crate::limits::check_ops(&[op.clone()]).is_ok());
        if let Op::Layer{transform,..}=&mut op {assert_eq!(*transform,Transform::default());transform.sx=0.;}
        assert!(crate::limits::check_ops(&[op]).is_err());
        let mut op=square();if let Op::Layer{mask,..}=&mut op{*mask=plain_mask(vec![Stroke{color:[0;4],width:0.1,erase:false,points:vec![f32::NAN,0.5]}]);}
        assert!(crate::limits::check_ops(&[op]).is_err());
    }
}
