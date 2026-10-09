// End-to-end coverage of photo assets and the v5 compositor through the real UI.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'darkroom-photo-layers-'));
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
    await page.goto(process.env.DARKROOM_URL||'http://localhost:8080');
    await page.waitForFunction(()=>document.querySelector('#frames .sleeve-empty'));
    const fixture=async(w,h,color)=>Buffer.from(await page.evaluate(({w,h,color})=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,w,h);return c.toDataURL().split(',')[1];},{w,h,color}),'base64');
    await page.setInputFiles('#file-images',{name:'base.png',mimeType:'image/png',buffer:await fixture(640,400,'#29435c')});
    await page.waitForFunction(()=>document.getElementById('canvas').width===640);
    const settled=()=>page.waitForTimeout(150);
    const snap=()=>page.locator('#canvas').evaluate(c=>c.toDataURL());
    const pixel=(x,y)=>page.locator('#canvas').evaluate((c,{x,y})=>[...c.getContext('2d').getImageData(x,y,1,1).data],{x,y});
    const field=async(id,v)=>{await page.locator('#'+id).fill(String(v));await page.locator('#'+id).dispatchEvent('change');await settled();};
    const drag=async(x,y,dx,dy)=>{const r=await page.locator('#ink').boundingBox();await page.mouse.move(r.x+x,r.y+y);await page.mouse.down();await page.mouse.move(r.x+x+dx,r.y+y+dy,{steps:5});await page.mouse.up();await settled();};
    const base=await snap();
    await page.setInputFiles('#file-layer-photo',{name:'overlay.png',mimeType:'image/png',buffer:await fixture(200,160,'#ff0000')});
    await page.waitForFunction(()=>document.querySelectorAll('.art-row').length===1);await settled();
    assert.deepEqual(await pixel(320,200),[255,0,0,255]);assert.deepEqual(await pixel(20,20),[41,67,92,255]);
    const photo=await snap();assert.notEqual(photo,base);
    await drag(320,200,40,20);
    assert(Math.abs(Number(await page.inputValue('#transform-tx'))-6.25)<.1);
    assert(Math.abs(Number(await page.inputValue('#transform-ty'))-5)<.1);
    await page.click('#btn-undo');await settled();assert.equal(await snap(),photo);
    await drag(520,360,-40,-32);
    assert(Number(await page.inputValue('#transform-sx'))<95);assert.equal(await page.inputValue('#transform-sx'),await page.inputValue('#transform-sy'));
    await page.click('#btn-undo');await settled();
    await drag(320,12,188,188);
    assert(Math.abs(Number(await page.inputValue('#transform-rotation'))-90)<2);
    await page.click('#btn-undo');await settled();assert.equal(await snap(),photo);
    // Non-square source geometry: rotation stays in pixels, then follows document rotation.
    await field('transform-rotation',30);assert.notEqual(await snap(),photo);
    await page.click('#transform-reset');await settled();assert.equal(await snap(),photo);
    await page.click('#mask-add');await field('mask-size',20);
    await drag(320,200,1,0);assert.deepEqual(await pixel(320,200),[41,67,92,255]);
    const hidden=await snap();
    await page.uncheck('#mask-enabled');await settled();assert.equal(await snap(),photo);
    await page.check('#mask-enabled');await settled();assert.equal(await snap(),hidden);
    await page.check('#mask-inverted');await settled();assert.deepEqual(await pixel(320,200),[255,0,0,255]);assert.deepEqual(await pixel(150,150),[41,67,92,255]);
    await page.uncheck('#mask-inverted');await settled();
    await page.selectOption('#mask-mode','reveal');await drag(320,200,1,0);assert.deepEqual(await pixel(320,200),[255,0,0,255]);
    await page.click('#btn-undo');await settled();assert.equal(await snap(),hidden);
    await page.click('#layer-add-adjustment');await field('adjust-brightness',30);
    assert((await pixel(150,150))[1]>0);
    await page.click('#layer-down');await settled();assert.deepEqual(await pixel(150,150),[255,0,0,255]);assert((await pixel(320,200))[0]>41);
    // A mask targets an adjustment without altering the photo layer above.
    await page.click('#mask-add');await page.selectOption('#mask-mode','hide');await drag(320,200,1,0);assert.deepEqual(await pixel(320,200),[41,67,92,255]);
    await page.locator('.art-row button').filter({hasText:'overlay.png'}).click();
    await page.locator('#style-properties summary').click();
    await page.check('#style-outline');await field('style-outline-width',2);
    assert.deepEqual(await pixel(115,150),[255,255,255,255]);
    await page.check('#style-shadow');await field('style-shadow-blur',1);await field('style-shadow-x',4);await field('style-shadow-y',4);
    await field('transform-tx',5);await field('transform-rotation',12);
    const finished=await snap();
    // Keep an artifact for visual inspection of handles and the layer stack.
    await page.locator('#panel').evaluate(e=>e.scrollTop=0);
    await page.screenshot({path:path.join(dir,'layer-tools.png'),fullPage:true});
    await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    const download=page.waitForEvent('download');await page.click('#btn-save');const project=await download;
    const file=path.join(dir,'composite.darkroom');await project.saveAs(file);
    await page.setInputFiles('#file-project',file);await settled();assert.equal(await snap(),finished);
    await page.locator('.art-row button').filter({hasText:'overlay.png'}).click();
    assert.equal(await page.inputValue('#transform-tx'),'5');assert.equal(await page.inputValue('#transform-rotation'),'12');assert(await page.isChecked('#mask-enabled'));assert(await page.isChecked('#style-outline'));
    // A duplicated photo references the same asset and survives undo / redo.
    await page.click('#layer-duplicate');assert.equal(await page.locator('.art-row').count(),3);
    await page.click('#btn-undo');await settled();assert.equal(await snap(),finished);
    await page.click('#btn-export');const exporting=page.waitForEvent('download');await page.click('#btn-export-go');
    const png=path.join(dir,'composite.png');await(await exporting).saveAs(png);
    assert((await fs.stat(png)).size>1000);
    assert.deepEqual(errors,[]);
    console.log('PASS: photo imports, canvas move/resize/rotate, masks, adjustment order, styles, undo, project reopen and export.');console.log('Artifacts:',dir);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
