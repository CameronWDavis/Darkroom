// End-to-end coverage of the Edit PDF workspace through the real UI: open,
// forms, comments, Fill & Sign, page content, organizing, search, redaction,
// protection, properties, save/reopen and Page → Image studio.
// Needs both engines built and the app served at DARKROOM_URL.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'darkroom-pdf-'));
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
    page.on('dialog',d=>d.accept());
    await page.goto(process.env.DARKROOM_URL||'http://localhost:8080');
    await page.waitForFunction(()=>document.querySelector('#frames .sleeve-empty'));
    await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    await page.click('#mode-pdf');
    assert(await page.isVisible('#pdf-workspace'));
    const fixture=path.join(__dirname,'fixtures/form.pdf');
    await page.setInputFiles('#p-file',fixture);
    await page.waitForFunction(()=>document.querySelectorAll('.p-page').length===3&&document.querySelector('.p-page canvas').width>400,null,{timeout:60000});
    const settled=()=>page.waitForTimeout(250);
    const comments=()=>page.locator('#p-comments li').allTextContents();
    const layerBox=async(i=0)=>page.locator(`.p-page[data-page="${i}"] .p-layer`).boundingBox();
    const zoomOf=async()=>(await layerBox()).width/612;
    // Page points (view space) to screen.
    const at=async(x,y,i=0)=>{const b=await layerBox(i),z=b.width/612;return [b.x+x*z,b.y+y*z];};
    const dragPts=async(a,b,i=0,steps=8)=>{const p=await at(...a,i),q=await at(...b,i);await page.mouse.move(...p);await page.mouse.down();await page.mouse.move(...q,{steps});await page.mouse.up();await settled();};
    const clickPt=async(x,y,i=0)=>{const p=await at(x,y,i);await page.mouse.click(...p);await settled();};
    const tool=async(t)=>{await page.click(`[data-ptool="${t}"]`);};
    const task=async(t)=>{await page.click(`[data-task="${t}"]`);};
    const search=async(q)=>{await page.click('[data-side="search"]');await page.fill('#p-find',q);await page.press('#p-find','Enter');await settled();return page.textContent('#p-find-count');};
    const pixelAt=async(x,y,i=0)=>page.locator(`.p-page[data-page="${i}"] canvas`).evaluate((c,{x,y})=>{const s=c.width/612;return [...c.getContext('2d').getImageData(Math.round(x*s),Math.round(y*s),1,1).data];},{x,y});
    await page.waitForFunction(()=>document.querySelector('.p-page').dataset.rendered);
    // Fit the whole page in view so every point below is on screen.
    await page.selectOption('#p-zoom','page');await settled();

    // --- Forms: fill a text field, a combo box and a check box on the page.
    const fields=page.locator('.p-field');
    assert.equal(await fields.count(),3);
    await page.locator('input.p-field[type="text"], input.p-field:not([type])').first().fill('Ada Lovelace');
    await page.keyboard.press('Enter');await settled();
    await page.locator('select.p-field').selectOption('Japan');await settled();
    await page.locator('input.p-field[type="checkbox"]').check();await settled();
    assert.equal(await page.locator('input.p-field[type="checkbox"]').isChecked(),true);
    assert.equal(await page.locator('select.p-field').inputValue(),'Japan');

    // --- Comments: highlight found text, add a note, shapes, drawing and a stamp.
    assert.match(await search('quick brown fox'),/^1 match/);
    const hl=await page.locator('.p-hl').first().boundingBox();
    await page.click('[data-side="comments"]');
    await tool('highlight');
    await page.mouse.move(hl.x+1,hl.y+hl.height/2);await page.mouse.down();await page.mouse.move(hl.x+hl.width-1,hl.y+hl.height/2,{steps:6});await page.mouse.up();await settled();
    assert((await comments()).some(t=>t.startsWith('Highlight')),'text highlighted');
    await tool('note');await clickPt(480,120);
    assert(await page.isVisible('#p-selected'),'a new note is selected for typing');
    await page.fill('#p-sel-text','Looks good');await page.locator('#p-sel-text').dispatchEvent('change');await settled();
    await page.fill('#p-sel-reply-text','Agreed');await page.click('#p-sel-reply');await settled();
    assert((await comments()).some(t=>t.includes('Looks good')&&t.includes('Agreed')),`note with reply: ${await comments()}`);
    await tool('rectangle');await dragPts([360,560],[480,620]);
    await tool('ink');await dragPts([100,640],[220,700],0,12);
    await tool('stamp');await page.selectOption('#p-stamp','Draft');await clickPt(450,700);
    const kinds=(await comments()).map(t=>t.split(' ·')[0]);
    for(const k of ['Highlight','Note','Rectangle','Drawing','Stamp']) assert(kinds.includes(k),`${k} in ${kinds}`);
    // Move the rectangle with the Select tool, then undo and redo.
    await tool('select');
    const square=page.locator('.p-cmt[title^="Square"]');
    const before=await square.boundingBox(),z=await zoomOf();
    await dragPts([420,590],[450,610]);
    const after=await square.boundingBox();
    assert(Math.abs(after.x-before.x-30*z)<3&&Math.abs(after.y-before.y-20*z)<3,`moved by 30×20 pt: ${JSON.stringify([before,after])}`);
    assert.equal(await page.getAttribute('#p-undo','title'),'Undo Move comment (Ctrl+Z)');
    await page.click('#p-undo');await settled();
    assert(Math.abs((await square.boundingBox()).x-before.x)<3,'undo puts it back');
    await page.click('#p-redo');await settled();
    assert(Math.abs((await square.boundingBox()).x-after.x)<3,'redo moves it again');

    // --- Fill & Sign: typed text, a check mark and a drawn signature.
    await task('fill');await tool('type');await clickPt(80,340);
    await page.keyboard.type('Signed in Paris');await page.keyboard.press('Control+Enter');await settled();
    await tool('check');await clickPt(80,370);
    await page.click('#p-sig-edit');
    const pad=await page.locator('#p-sig-pad').boundingBox();
    await page.mouse.move(pad.x+pad.width*0.1,pad.y+pad.height*0.7);await page.mouse.down();
    for(const [x,y] of [[.2,.25],[.3,.75],[.42,.3],[.55,.7],[.7,.35]]) await page.mouse.move(pad.x+pad.width*x,pad.y+pad.height*y,{steps:4});
    await page.mouse.up();await page.click('#p-sig-save');
    assert.match(await page.textContent('#p-sig-note'),/Drawn signature ready/);
    await clickPt(80,400);
    const signed=await comments();
    assert(signed.length>=8,`fill & sign marks were added: ${signed}`);
    const ink=await page.locator('.p-page[data-page="0"] canvas').evaluate(c=>{const s=c.width/612,d=c.getContext('2d').getImageData(Math.round(80*s),Math.round(370*s),Math.round(150*s),Math.round(60*s)).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]<100&&d[i+2]<140)n++;return n;});
    assert(ink>40,`the signature is drawn on the page (${ink} dark pixels)`);

    // --- Edit: add page text and an image.
    await task('edit');await tool('addtext');await dragPts([300,330],[560,360]);
    await page.keyboard.type('APPROVED FOR RELEASE');await page.keyboard.press('Control+Enter');await settled();
    assert.match(await search('approved for release'),/^1 match/);
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=8;const x=c.getContext('2d');x.fillStyle='#00a000';x.fillRect(0,0,8,8);return c.toDataURL().split(',')[1];});
    await tool('addimage');
    const chooser=page.waitForEvent('filechooser');await dragPts([480,40],[560,100]);
    await(await chooser).setFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(()=>document.getElementById('p-undo').title.includes('Add image'));
    await page.waitForTimeout(600);
    const green=await pixelAt(520,70);assert(green[1]>120&&green[0]<80,`image placed: ${green}`);

    // --- Organize: rotate, insert, delete, reorder, with undo.
    await page.click('[data-side="pages"]');
    await page.click('.p-thumb[data-page="0"]');await page.click('#p-rot-r');await settled();
    let box=await layerBox(0);assert(box.width>box.height,'page 1 turned a quarter');
    await page.click('#p-undo');await settled();
    await page.click('.p-thumb[data-page="2"]');await page.click('#p-blank');await settled();
    assert.equal(await page.locator('.p-page').count(),4);
    await page.click('.p-thumb[data-page="3"]');await page.click('#p-del');await settled();
    assert.equal(await page.locator('.p-page').count(),3);
    await page.click('.p-thumb[data-page="1"]');await page.click('#p-up');await settled();
    assert.equal(await page.getAttribute('.p-thumb[data-page="0"]','aria-selected'),'true','the moved page stays selected');
    assert.match(await search('appendix marker'),/^2 matches/);
    assert.equal(await page.textContent('#p-results li .meta'),'Page 1','the appendix page moved to the front');
    await page.click('#p-undo');await settled();
    // Extract the first page.
    await page.click('[data-side="pages"]');await page.click('.p-thumb[data-page="0"]');
    let download=page.waitForEvent('download');await page.click('#p-extract');
    const extracted=path.join(dir,'extract.pdf');await(await download).saveAs(extracted);
    assert((await fs.readFile(extracted)).subarray(0,5).toString()==='%PDF-');

    // --- Redaction removes text for good.
    await task('redact');await page.fill('#p-redact-find','12345678');await page.click('#p-redact-mark');await settled();
    assert.match(await page.textContent('#p-redact-count'),/^1 redaction mark/);
    await page.click('#p-redact-apply');await settled();
    assert.match(await page.textContent('#p-redact-count'),/No redaction marks/);
    assert.match(await search('12345678'),/^0 matches/);

    // --- Properties, then protection, save and reopen with the password.
    await task('props');await page.fill('#p-title','Signed application');await page.click('#p-meta-apply');await settled();
    await task('protect');await page.fill('#p-pw-open','open sesame');await page.fill('#p-pw-owner','owner pw');await page.click('#p-protect');await settled();
    assert.match(await page.textContent('#p-security'),/written when you save/);
    // Compare renders at one fixed zoom; fitting depends on the window.
    await page.selectOption('#p-zoom','1');await page.waitForFunction(()=>document.querySelector('.p-page').dataset.rendered.endsWith('@1'));
    const shown=await page.locator('.p-page[data-page="0"] canvas').evaluate(c=>c.toDataURL());
    assert.equal(await page.locator('.p-tab .dirty').count(),1);
    download=page.waitForEvent('download');await page.click('#p-save');
    const saved=path.join(dir,'saved.pdf');await(await download).saveAs(saved);
    assert.equal(await page.locator('.p-tab .dirty').count(),0,'saving clears the unsaved marker');
    await page.click('.p-tab .x');await settled();
    assert.equal(await page.locator('.p-page').count(),0);
    await page.setInputFiles('#p-file',saved);
    await page.waitForSelector('#p-password[open]');
    await page.fill('#p-password-input','wrong');await page.click('#p-password-ok');
    await page.waitForFunction(()=>document.getElementById('p-password-msg').textContent.includes("didn't open"));
    await page.fill('#p-password-input','open sesame');await page.click('#p-password-ok');
    await page.waitForFunction(()=>document.querySelectorAll('.p-page').length===3&&document.querySelector('.p-page').dataset.rendered,null,{timeout:60000});
    await page.waitForFunction(()=>document.querySelector('.p-page').dataset.rendered.endsWith('@1'));
    const reopened=await page.locator('.p-page[data-page="0"] canvas').evaluate(c=>c.toDataURL());
    if(reopened!==shown){await fs.writeFile(path.join(dir,'before.png'),Buffer.from(shown.split(',')[1],'base64'));await fs.writeFile(path.join(dir,'after.png'),Buffer.from(reopened.split(',')[1],'base64'));}
    assert.equal(reopened,shown,`the reopened PDF looks the same (see ${dir})`);
    assert.equal(await page.locator('input.p-field[type="checkbox"]').isChecked(),true);
    assert.equal(await page.locator('select.p-field').inputValue(),'Japan');
    assert.equal(await page.locator('input.p-field:not([type="checkbox"])').first().inputValue(),'Ada Lovelace');
    await page.click('[data-side="comments"]');
    assert((await comments()).some(t=>t.includes('Looks good')));
    await task('props');assert.equal(await page.inputValue('#p-title'),'Signed application');
    await task('protect');assert.match(await page.textContent('#p-security'),/AES/);
    // The saved file is encrypted: the account number appears nowhere in plain text.
    const raw=await fs.readFile(saved);
    assert(!raw.includes(Buffer.from('12345678'))&&!raw.includes(Buffer.from('Ada Lovelace')));
    await page.locator('#p-tasks, .p-tasks').first().evaluate(e=>e.scrollTop=0);
    await page.screenshot({path:path.join(dir,'pdf-editor.png')});

    // --- Page → Image studio hands the page to the image editor at 144 dpi.
    await task('edit');await page.click('#p-to-image');
    await page.waitForFunction(()=>document.querySelector('#frames .frame button')?.title.includes('1224×1584'),null,{timeout:20000});
    assert.match(await page.getAttribute('#frames .frame button','title'),/^saved-page-1\.png/);
    assert(await page.isVisible('#image-workspace'));
    assert.deepEqual(errors,[]);
    console.log('PASS: open, forms, comments & replies, fill & sign, page text & images, organize & extract, search, redaction, properties, protection, save & reopen, page to Image studio.');
    console.log('Artifacts:',dir);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
