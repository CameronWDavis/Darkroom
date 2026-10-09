//! Per-layer compositing in source space keeps masks and transforms editable.
use super::*;
use crate::project::Asset;
use std::collections::{BTreeMap, VecDeque};

fn content_image(content: &Op, dims: (u32,u32), assets: &BTreeMap<String,Asset>, full: bool) -> RgbaImage {
    let mut image = RgbaImage::new(dims.0,dims.1);
    if let Op::Photo { asset_id,width,height } = content {
        if let Some(asset) = assets.get(asset_id) {
            // Assets are decoded and validated on import and project load.
            let original;
            let photo = if full { original = crate::limits::decode("Photo layer", &asset.source).expect("validated photo asset"); &original } else { &asset.preview };
            let w = (width*dims.0 as f32).round().max(1.) as u32;
            let h = (height*dims.1 as f32).round().max(1.) as u32;
            let resized = imageops::resize(photo,w,h,imageops::FilterType::Triangle);
            imageops::overlay(&mut image,&resized,((dims.0-w)/2) as i64,((dims.1-h)/2) as i64);
        }
    } else { render_overlay(&mut image,content,&[],dims,dims.0.min(dims.1) as f32); }
    image
}

pub fn content_bounds(op: &Op, dims: (u32,u32), assets: &BTreeMap<String,Asset>) -> [f32;4] {
    let Op::Layer { content, .. } = op else { return [0.,0.,1.,1.] };
    if let Op::Photo { width,height,.. } = content.as_ref() { return [(1.-width)/2.,(1.-height)/2.,*width,*height]; }
    let scale = 512. / dims.0.max(dims.1) as f32;
    let image = content_image(content,((dims.0 as f32*scale).round().max(1.) as u32,(dims.1 as f32*scale).round().max(1.) as u32),assets,false);
    let (mut x0,mut y0,mut x1,mut y1) = (image.width(),image.height(),0,0);
    for (x,y,p) in image.enumerate_pixels() { if p[3]>0 { x0=x0.min(x);y0=y0.min(y);x1=x1.max(x+1);y1=y1.max(y+1); } }
    if x1<=x0 || y1<=y0 { return [0.25,0.25,0.5,0.5]; }
    [x0 as f32/image.width() as f32,y0 as f32/image.height() as f32,(x1-x0) as f32/image.width() as f32,(y1-y0) as f32/image.height() as f32]
}

fn mask_image(mask: &Option<LayerMask>, dims: (u32,u32)) -> Option<RgbaImage> {
    let m = mask.as_ref().filter(|m| m.enabled)?;
    let mut image = RgbaImage::from_pixel(dims.0,dims.1,Rgba([255;4]));
    paint(&mut image,&m.strokes,&[],dims.0.min(dims.1) as f32);
    if m.inverted { for p in image.pixels_mut() { p[0]=255-p[0]; } }
    Some(image)
}

/// Output coordinates back through the document's crop/rotate/flip operations.
fn unmap(mut x: f32, mut y: f32, geo: &[Op]) -> (f32,f32) {
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
/// Bilinear filtering in premultiplied space avoids dark rims around cut-outs.
fn sample(image: &RgbaImage, x: f32,y: f32) -> [f32;4] {
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
fn styles(image: RgbaImage,style: &LayerStyle) -> RgbaImage {
    if !style.shadow && !style.outline {return image;}
    let (w,h)=image.dimensions();let short=w.min(h) as f32;
    let alpha:Vec<u8>=image.pixels().map(|p|p[3]).collect();
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
    if style.outline && style.outline_width>0. {
        let grown=dilate(&alpha,w as usize,h as usize,(style.outline_width*short).round().max(1.) as usize);
        for (p,a) in out.pixels_mut().zip(grown) {blend_px(p,[style.outline_color[0] as f32/255.,style.outline_color[1] as f32/255.,style.outline_color[2] as f32/255.],a as f32/255.*style.outline_color[3] as f32/255.,Blend::Normal);}
    }
    imageops::overlay(&mut out,&image,0,0);out
}

pub fn composite_layer(img: &mut RgbaImage,op: &Op,geo: &[Op],dims: (u32,u32),assets: &BTreeMap<String,Asset>,full: bool) {
    let Op::Layer { content,opacity,blend,transform,mask,style,.. }=op else {return};
    let mask_bitmap=mask_image(mask,dims);
    if let Op::Adjustment { exposure,brightness,contrast,saturation,warmth }=content.as_ref() {
        let mut adjusted=img.clone();
        for op in [Op::Exposure{value:*exposure},Op::Brightness{value:*brightness},Op::Contrast{value:*contrast},Op::Saturation{value:*saturation},Op::Warmth{value:*warmth}] {adjusted=apply_one(adjusted,&op);}
        let (w,h)=img.dimensions();
        for (x,y,p) in img.enumerate_pixels_mut() {
            let (sx,sy)=unmap((x as f32+0.5)/w as f32,(y as f32+0.5)/h as f32,geo);
            let strength=opacity*mask_bitmap.as_ref().map_or(1.,|m|sample(m,sx,sy)[0]);
            let q=adjusted.get_pixel(x,y);
            for c in 0..3 {p[c]=(p[c] as f32*(1.-strength)+q[c] as f32*strength).round() as u8;}
        }
        return;
    }
    // Preserve the original v4 rasterizer exactly for unchanged legacy layers.
    if *transform==Transform::default() && mask_bitmap.is_none() && !style.shadow && !style.outline && !matches!(content.as_ref(),Op::Photo{..}) {
        let mut overlay=RgbaImage::new(img.width(),img.height());
        render_overlay(&mut overlay,content,geo,dims,dims.0.min(dims.1) as f32);
        for (p,q) in img.pixels_mut().zip(overlay.pixels()) {blend_px(p,[q[0] as f32/255.,q[1] as f32/255.,q[2] as f32/255.],q[3] as f32/255.*opacity,*blend);} return;
    }
    let mut overlay=content_image(content,dims,assets,full);
    if let Some(m)=mask_bitmap {for (p,q) in overlay.pixels_mut().zip(m.pixels()) {p[3]=(p[3] as f32*q[0] as f32/255.).round() as u8;}}
    let overlay=styles(overlay,style);
    let (w,h)=img.dimensions();
    for (x,y,p) in img.enumerate_pixels_mut() {
        let (sx,sy)=unmap((x as f32+0.5)/w as f32,(y as f32+0.5)/h as f32,geo);
        let (sx,sy)=inverse(sx,sy,transform,dims);
        let q=sample(&overlay,sx,sy);
        if q[3]>0. {blend_px(p,[q[0],q[1],q[2]],q[3]*opacity,*blend);}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn layer(content: Op) -> Op { Op::Layer { id:"layer".into(), name:"Layer".into(), visible:true, opacity:1., blend:Blend::Normal, content:Box::new(content), transform:Transform::default(), mask:None, style:LayerStyle::default() } }
    fn square() -> Op { layer(Op::Shapes { items:vec![Shape { kind:ShapeKind::Rect,x0:0.3,y0:0.3,x1:0.7,y1:0.7,fill:Some([255,0,0,255]),stroke:None,width:0.01 }] }) }
    fn blank() -> RgbaImage { RgbaImage::new(100,100) }
    fn mask_stroke(v:u8) -> Stroke {Stroke{color:[v,v,v,255],width:0.2,erase:false,points:vec![0.5,0.5]}}
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
        if let Op::Layer{mask,transform,..}=&mut op { *mask=Some(LayerMask{enabled:true,inverted:false,strokes:vec![mask_stroke(0)]});transform.tx=0.2; }
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
        if let Op::Layer{mask,..}=&mut masked{*mask=Some(LayerMask{enabled:true,inverted:false,strokes:vec![mask_stroke(0)]});}
        let out=apply_all(&base,&[masked]);assert_eq!(out.get_pixel(50,50).0,[50,60,70,128]);assert!(out.get_pixel(0,0)[0]>50);
    }
    #[test]
    fn shadows_and_outlines_expand_alpha_without_changing_the_source() {
        let mut op=square();
        if let Op::Layer{style:s,..}=&mut op {s.outline=true;s.outline_width=0.03;s.outline_color=[255,255,255,255];s.shadow=true;s.shadow_color=[0,0,0,180];s.shadow_x=0.1;s.shadow_y=0.1;}
        let out=apply_all(&blank(),&[op]);assert_eq!(out.get_pixel(28,50).0,[255;4]);assert_eq!(out.get_pixel(50,50).0,[255,0,0,255]);assert_eq!(out.get_pixel(75,75)[3],180);assert_eq!(out.get_pixel(20,20)[3],0);
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
        let mut op=square();if let Op::Layer{mask,..}=&mut op{*mask=Some(LayerMask{enabled:true,inverted:false,strokes:vec![Stroke{color:[0;4],width:0.1,erase:false,points:vec![f32::NAN,0.5]}]});}
        assert!(crate::limits::check_ops(&[op]).is_err());
    }
}
