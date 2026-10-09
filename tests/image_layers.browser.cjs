// Run against a built, locally served app. Requires Playwright + Chromium.
// DARKROOM_URL, PLAYWRIGHT_MODULE and CHROME_PATH can override local defaults.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}) });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'darkroom-layers-'));
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error' && !m.text().includes('404')) errors.push(m.text());});
    await page.goto(process.env.DARKROOM_URL || 'http://localhost:8080');
    await page.waitForFunction(()=>document.querySelector('#frames .sleeve-empty'));
    const fixture=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=400;const x=c.getContext('2d');x.fillStyle='#29435c';x.fillRect(0,0,640,400);return c.toDataURL().split(',')[1];});
    await page.setInputFiles('#file-images',{name:'layers.png',mimeType:'image/png',buffer:Buffer.from(fixture,'base64')});
    await page.waitForFunction(()=>document.getElementById('canvas').width===640);
    const snapshot=()=>page.locator('#canvas').evaluate(c=>c.toDataURL());
    const base=await snapshot();
    // Legacy flat artwork migrates to layers without changing its blend mode.
    const legacy=await page.evaluate(async base64=>{
      const {Editor}=await import('./pkg/darkroom.js');const ed=new Editor();
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const id=ed.add_image('legacy.png',bytes);
      ed.set_ops(id,JSON.stringify([
        {op:'gradient',kind:'linear',x0:0,y0:0,x1:1,y1:0,from:[240,80,30,255],to:[50,120,220,255],opacity:.6,blend:'multiply'},
        {op:'paint',strokes:[{color:[255,255,255,255],width:.03,erase:false,points:[.1,.1,.8,.1]}]}
      ]));
      const project=Array.from(ed.save_bundle()),expected=Array.from(ed.export(id,'png',92,1));ed.free();
      return {project,expected};
    },fixture);
    await page.setInputFiles('#file-project',{name:'legacy.darkroom',mimeType:'application/zip',buffer:Buffer.from(legacy.project)});
    await page.waitForFunction(()=>document.querySelectorAll('.art-row').length===2);
    await page.waitForTimeout(100);
    const difference=await page.evaluate(async bytes=>{
      const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
      const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      const expected=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const actual=document.getElementById('canvas').getContext('2d').getImageData(0,0,c.width,c.height).data;
      return expected.reduce((max,v,i)=>Math.max(max,Math.abs(v-actual[i])),0);
    },legacy.expected);
    assert(difference<=2,`Legacy layer migration changed pixels by ${difference}`);
    await page.click('#btn-reset');await page.waitForTimeout(100);
    assert.equal(await snapshot(),base);
    await page.click('#layer-add-text');
    await page.fill('#text-content','MAKE SOMETHING\nWORTH KEEPING');
    await page.locator('#text-content').dispatchEvent('change');
    await page.check('#text-bold');
    await page.waitForTimeout(150);
    const withText=await snapshot();assert.notEqual(withText,base);
    await page.locator('#art-layers input[type=checkbox]').uncheck();
    await page.waitForTimeout(100);assert.equal(await snapshot(),base);
    await page.locator('#art-layers input[type=checkbox]').check();
    await page.click('#layer-duplicate');assert.equal(await page.locator('.art-row').count(),2);
    await page.click('#layer-delete');assert.equal(await page.locator('.art-row').count(),1);
    await page.click('#btn-undo');assert.equal(await page.locator('.art-row').count(),2);
    await page.click('#btn-redo');assert.equal(await page.locator('.art-row').count(),1);
    await page.locator('.art-row button').click();
    await page.locator('#layer-opacity').fill('45');await page.locator('#layer-opacity').dispatchEvent('change');
    await page.selectOption('#layer-blend','screen');
    await page.fill('#text-x','35');await page.locator('#text-x').dispatchEvent('change');
    // The Type tool moves the selected layer in normalized source coordinates.
    await page.locator('[data-tool="text"]').evaluate(b=>{ if(b.getAttribute('aria-pressed')!=='true')b.click(); });
    const frame=await page.locator('#canvas').boundingBox();
    await page.mouse.move(frame.x+200,frame.y+180);await page.mouse.down();
    await page.mouse.move(frame.x+264,frame.y+220,{steps:4});await page.mouse.up();
    assert(Math.abs(Number(await page.inputValue('#text-x'))-45)<0.1);
    await page.click('#btn-undo');assert.equal(await page.inputValue('#text-x'),'35');
    // Brush strokes stay on their own selected drawing layer.
    await page.click('#layer-add-paint');
    const paint=await page.locator('#ink').boundingBox();
    await page.mouse.move(paint.x+30,paint.y+250);await page.mouse.down();await page.mouse.move(paint.x+180,paint.y+250);await page.mouse.up();
    assert.equal(await page.locator('.art-row').count(),2);
    await page.keyboard.press('Escape');await page.click('#layer-delete');
    assert.equal(await page.locator('.art-row').count(),1);
    // Add a shape layer through the actual drawing tool.
    await page.click('[data-tool="shape"]');
    const ink=await page.locator('#ink').boundingBox();
    await page.mouse.move(ink.x+20,ink.y+20);await page.mouse.down();await page.mouse.move(ink.x+220,ink.y+130);await page.mouse.up();
    assert.equal(await page.locator('.art-row').count(),2);
    await page.keyboard.press('Escape');
    await page.click('#layer-down');
    assert((await page.locator('.art-row button').first().textContent()).includes('Text'));
    // Compare + save must preserve the complete layer stream.
    await page.click('#view-original');
    await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    const save=page.waitForEvent('download');await page.click('#btn-save');const bundle=await save;
    const file=path.join(dir,'layers.darkroom');await bundle.saveAs(file);
    await page.setInputFiles('#file-project',file);
    await page.waitForFunction(()=>document.querySelectorAll('.art-row').length===2);
    await page.locator('.art-row button').first().click();
    assert.equal(await page.inputValue('#text-content'),'MAKE SOMETHING\nWORTH KEEPING');
    assert.equal(await page.inputValue('#text-x'),'35');
    assert.equal(await page.inputValue('#layer-opacity'),'45');
    assert.equal(await page.inputValue('#layer-blend'),'screen');
    // Export image must include the reopened text and geometry layers.
    await page.click('#btn-export');
    const exported=page.waitForEvent('download');await page.click('#btn-export-go');
    const png=await exported;const pngFile=path.join(dir,'export.png');await png.saveAs(pngFile);
    assert((await fs.stat(pngFile)).size>1000);
    await page.screenshot({path:path.join(dir,'layers.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: editable text, visibility, duplicate/delete, undo/redo, shape layers, order, blend/opacity, save/reopen and PNG export.');
    console.log('Artifacts:',dir);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
