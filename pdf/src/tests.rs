use super::*;

const LETTER: (f64, f64) = (612.0, 792.0);

fn state(json: &str) -> Value {
    serde_json::from_str(json).unwrap()
}
fn edit(s: &mut PdfStudio, id: f64, v: Value) -> Value {
    state(&s.edit(id, &v.to_string()).unwrap())
}
/// A studio with one text document open: (studio, id, state).
fn text_doc(text: &str) -> (PdfStudio, f64, Value) {
    let mut s = PdfStudio::new();
    let bytes = s.session.create_from_text("Notes", text).unwrap();
    let st = state(&s.open("notes.pdf", &bytes, None).unwrap());
    let id = st["id"].as_f64().unwrap();
    (s, id, st)
}
fn pixel(rendered: &[u8], x: usize, y: usize) -> [u8; 4] {
    let w = u32::from_le_bytes(rendered[0..4].try_into().unwrap()) as usize;
    let i = 8 + (y * w + x) * 4;
    rendered[i..i + 4].try_into().unwrap()
}

#[test]
fn opens_renders_and_reads_text() {
    let (mut s, id, st) = text_doc("Quarterly invoice total due\nPay by Friday");
    assert_eq!(st["pages"].as_array().unwrap().len(), 1);
    assert_eq!(st["pages"][0]["w"], 612.0);
    let r = s.render(id, 0, 1.0).unwrap();
    assert_eq!(u32::from_le_bytes(r[0..4].try_into().unwrap()), 612);
    assert_eq!(pixel(&r, 5, 5), [255; 4], "pages are composited onto white");
    let text = state(&s.text(id, 0).unwrap());
    assert!(text["text"].as_array().unwrap().len() > 20);
    let hits = state(&s.find(id, "TOTAL due", false, false).unwrap());
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["text"], "total due");
    assert!(state(&s.find(id, "TOTAL", true, false).unwrap()).as_array().unwrap().is_empty(), "case-sensitive search");
}

#[test]
fn organizes_pages_with_undo() {
    let mut s = PdfStudio::new();
    let st = state(&s.blank("new.pdf", LETTER.0, LETTER.1, 3).unwrap());
    let id = st["id"].as_f64().unwrap();
    let st = edit(&mut s, id, json!({ "op": "rotate", "pages": [0], "degrees": 90 }));
    assert_eq!(st["pages"][0]["rotation"], 90);
    assert_eq!(st["pages"][0]["w"], 792.0, "a quarter turn swaps the displayed size");
    let st = edit(&mut s, id, json!({ "op": "insert_blank", "at": 1, "width": 200, "height": 300 }));
    assert_eq!(st["pages"].as_array().unwrap().len(), 4);
    assert_eq!(st["pages"][1]["w"], 200.0);
    let st = edit(&mut s, id, json!({ "op": "move", "pages": [1], "to": 4 }));
    assert_eq!(st["pages"][3]["w"], 200.0);
    let st = edit(&mut s, id, json!({ "op": "duplicate", "pages": [3] }));
    assert_eq!(st["pages"].as_array().unwrap().len(), 5);
    let st = edit(&mut s, id, json!({ "op": "delete", "pages": [3, 4] }));
    assert_eq!(st["pages"].as_array().unwrap().len(), 3);
    assert!(s.edit(id, &json!({ "op": "delete", "pages": [0, 1, 2] }).to_string()).unwrap_err().contains("at least one page"));
    assert_eq!(st["undo"], "Delete pages");
    let st = state(&s.undo(id).unwrap());
    assert_eq!(st["pages"].as_array().unwrap().len(), 5);
    let st = state(&s.redo(id).unwrap());
    assert_eq!(st["pages"].as_array().unwrap().len(), 3);
    // Merge another PDF and extract pages into a new one.
    let other = s.session.create_from_text("Appendix", "Appendix A").unwrap();
    let st = state(&s.insert_pdf(id, "appendix.pdf", &other, 3, None).unwrap());
    assert_eq!(st["pages"].as_array().unwrap().len(), 4);
    let part = s.extract(id, &[3]).unwrap();
    let st = state(&s.open("part.pdf", &part, None).unwrap());
    assert_eq!(st["pages"].as_array().unwrap().len(), 1);
    assert_eq!(state(&s.find(st["id"].as_f64().unwrap(), "appendix", false, false).unwrap()).as_array().unwrap().len(), 1);
}

#[test]
fn comments_are_added_moved_edited_and_deleted() {
    let (mut s, id, _) = text_doc("Highlight this phrase please");
    let hits = state(&s.find(id, "this phrase", false, false).unwrap());
    edit(&mut s, id, json!({ "op": "comment", "page": 0, "type": "highlight", "rects": hits[0]["rects"], "contents": "Check" }));
    edit(&mut s, id, json!({ "op": "comment", "page": 0, "type": "rectangle", "rect": [100, 300, 200, 360], "color": "#0078d6" }));
    let st2 = edit(&mut s, id, json!({ "op": "comment", "page": 0, "type": "ink", "strokes": [[[50, 500], [80, 520], [120, 510]]] }));
    let comments = st2["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 3, "{comments:?}");
    assert!(comments.iter().any(|c| c["type"] == "Highlight" && c["contents"] == "Check"));
    let rect = comments.iter().find(|c| c["type"] == "Square").unwrap();
    let r: Vec<f64> = rect["rect"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert!((r[0] - 100.0).abs() < 3.0 && (r[1] - 300.0).abs() < 3.0, "view-space rect round-trips: {r:?}");
    let index = rect["index"].as_u64().unwrap();
    let st = edit(&mut s, id, json!({ "op": "comment_move", "page": 0, "index": index, "dx": 50, "dy": 20 }));
    let moved = st["comments"].as_array().unwrap().iter().find(|c| c["type"] == "Square").unwrap().clone();
    assert!((moved["rect"][0].as_f64().unwrap() - 150.0).abs() < 3.0 && (moved["rect"][1].as_f64().unwrap() - 320.0).abs() < 3.0, "{moved}");
    let st = edit(&mut s, id, json!({ "op": "comment_text", "page": 0, "index": index, "text": "Updated" }));
    assert!(st["comments"].as_array().unwrap().iter().any(|c| c["contents"] == "Updated"));
    let st = edit(&mut s, id, json!({ "op": "comment_delete", "page": 0, "index": index }));
    assert_eq!(st["comments"].as_array().unwrap().len(), 2);
    let _ = st;
    // Comments survive a save and reopen.
    let bytes = s.save(id).unwrap();
    let back = state(&s.open("back.pdf", &bytes, None).unwrap());
    assert_eq!(back["comments"].as_array().unwrap().len(), 2);
    assert_eq!(back["dirty"], false);
}

#[test]
fn fills_and_signs_forms() {
    let (mut s, id, _) = text_doc("Name:\n\nAgree:");
    let doc = DocId(id as u64);
    s.session.apply(doc, Edit::AddField { page: 0, rect: [150.0, 700.0, 350.0, 720.0], kind: pdfcraft_engine::NewField::Text { multiline: false }, name: Some("name".into()) }).unwrap();
    s.session.apply(doc, Edit::AddField { page: 0, rect: [150.0, 650.0, 165.0, 665.0], kind: pdfcraft_engine::NewField::CheckBox, name: Some("agree".into()) }).unwrap();
    let st = state(&s.state(id).unwrap());
    let fields = st["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 2);
    assert_eq!(fields.iter().find(|f| f["name"] == "name").unwrap()["kind"], "text");
    let st = edit(&mut s, id, json!({ "op": "field", "name": "name", "value": "Ada Lovelace" }));
    let st2 = edit(&mut s, id, json!({ "op": "field", "name": "agree", "value": true }));
    let _ = st;
    let fields = st2["fields"].as_array().unwrap();
    assert_eq!(fields.iter().find(|f| f["name"] == "name").unwrap()["value"][0], "Ada Lovelace");
    assert!(!fields.iter().find(|f| f["name"] == "agree").unwrap()["value"].as_array().unwrap().is_empty());
    // Fill & Sign: typed text, a check mark, drawn and typed signatures.
    edit(&mut s, id, json!({ "op": "type", "page": 0, "at": [300, 300], "text": "Signed in Paris" }));
    edit(&mut s, id, json!({ "op": "mark", "page": 0, "rect": [300, 340, 312, 352], "mark": "check" }));
    edit(&mut s, id, json!({ "op": "sign_drawn", "page": 0, "at": [300, 400], "strokes": [[[0, 0.2], [0.3, 0.8], [0.6, 0.1], [1, 0.6]]] }));
    let st = edit(&mut s, id, json!({ "op": "sign_typed", "page": 0, "at": [300, 450], "text": "Ada Lovelace" }));
    assert_eq!(st["comments"].as_array().unwrap().len(), 4);
    // Flattening bakes fields and comments into the page.
    let st = edit(&mut s, id, json!({ "op": "flatten", "comments": true, "fields": true }));
    assert!(st["fields"].as_array().unwrap().is_empty());
    assert!(st["comments"].as_array().unwrap().is_empty());
    let r = s.render(id, 0, 1.0).unwrap();
    assert!((395..405).any(|y| (300..450).any(|x| pixel(&r, x, y)[0] < 128)), "the drawn signature is on the page");
}

#[test]
fn redaction_removes_text_for_good() {
    let (mut s, id, _) = text_doc("Account 12345678 belongs to Ada\nKeep this line");
    let st = edit(&mut s, id, json!({ "op": "redact_text", "query": "12345678" }));
    assert_eq!(st["redactions"], 1);
    let st = edit(&mut s, id, json!({ "op": "redact_area", "page": 0, "rect": [0, 0, 20, 20] }));
    assert_eq!(st["redactions"], 2);
    let st = edit(&mut s, id, json!({ "op": "redact_apply" }));
    assert_eq!(st["redactions"], 0);
    let bytes = s.save(id).unwrap();
    let back = state(&s.open("redacted.pdf", &bytes, None).unwrap());
    let bid = back["id"].as_f64().unwrap();
    assert!(state(&s.find(bid, "12345678", false, false).unwrap()).as_array().unwrap().is_empty(), "the number is gone from the file");
    assert_eq!(state(&s.find(bid, "keep this line", false, false).unwrap()).as_array().unwrap().len(), 1);
    assert!(s.edit(bid, &json!({ "op": "redact_apply" }).to_string()).unwrap_err().contains("no redaction marks"));
}

#[test]
fn protects_with_passwords_and_edits_metadata() {
    let (mut s, id, _) = text_doc("Confidential");
    let st = edit(&mut s, id, json!({ "op": "info", "title": "Board pack", "author": "Ada" }));
    assert_eq!(st["info"]["title"], "Board pack");
    assert!(s.edit(id, &json!({ "op": "protect" }).to_string()).is_err(), "protection needs a password");
    edit(&mut s, id, json!({ "op": "protect", "open_password": "open sesame", "permissions_password": "owner", "printing": "low" }));
    let bytes = s.save(id).unwrap();
    assert_eq!(s.open("locked.pdf", &bytes, None).unwrap_err(), "password-required");
    assert_eq!(s.open("locked.pdf", &bytes, Some("nope".into())).unwrap_err(), "password-wrong");
    let st = state(&s.open("locked.pdf", &bytes, Some("open sesame".into())).unwrap());
    assert_eq!(st["info"]["encrypted"], true);
    assert_eq!(st["info"]["title"], "Board pack");
    assert_eq!(st["allows"]["modify"], false, "the user password alone keeps the restrictions");
    let lid = st["id"].as_f64().unwrap();
    assert_eq!(state(&s.find(lid, "confidential", false, false).unwrap()).as_array().unwrap().len(), 1);
    // The owner password lifts them and can remove protection.
    let st = state(&s.open("locked.pdf", &bytes, Some("owner".into())).unwrap());
    let oid = st["id"].as_f64().unwrap();
    edit(&mut s, oid, json!({ "op": "unprotect" }));
    let open = s.save(oid).unwrap();
    assert!(s.open("open.pdf", &open, None).is_ok());
}

#[test]
fn adds_page_text_and_images() {
    let (mut s, id, _) = text_doc("Body");
    let st = edit(&mut s, id, json!({ "op": "add_text", "page": 0, "rect": [72, 600, 300, 640], "text": "APPROVED COPY", "size": 18, "bold": true }));
    assert_eq!(st["undo"], "Add text");
    let hit = state(&s.find(id, "approved copy", false, false).unwrap());
    assert_eq!(hit.as_array().unwrap().len(), 1);
    let top = hit[0]["rects"][0][1].as_f64().unwrap();
    assert!((600.0..640.0).contains(&top), "added text sits where it was placed, measured from the top: {top}");
    let mut png = Vec::new();
    let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
    image::codecs::png::PngEncoder::new(&mut png).write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgba8).unwrap();
    s.add_image(id, 0, &[100.0, 100.0, 200.0, 200.0], "logo.png", &png).unwrap();
    let r = s.render(id, 0, 1.0).unwrap();
    assert_eq!(&pixel(&r, 150, 150)[..3], &[255, 0, 0]);
}

use image::ImageEncoder;

#[test]
fn moved_comments_stay_put_through_undo_and_redo() {
    let (mut s, id, _) = text_doc("Shapes");
    let st = edit(&mut s, id, json!({ "op": "comment", "page": 0, "type": "rectangle", "rect": [360, 560, 480, 620] }));
    let index = st["comments"][0]["index"].as_u64().unwrap();
    let rect = |st: &Value| -> Vec<i64> { st["comments"][0]["rect"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap().round() as i64).collect() };
    let moved = edit(&mut s, id, json!({ "op": "comment_move", "page": 0, "index": index, "dx": 30, "dy": 20 }));
    let undone = state(&s.undo(id).unwrap());
    let redone = state(&s.redo(id).unwrap());
    assert_eq!(rect(&undone), rect(&st));
    assert_eq!(rect(&redone), rect(&moved));
}
