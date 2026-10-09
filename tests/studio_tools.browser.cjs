// End-to-end coverage of selections, layer styles, groups and clipping,
// typography, retouching, and guides/snapping/alignment through the real UI.
// Needs a built engine served at DARKROOM_URL (default http://localhost:8080).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'darkroom-studio-'));
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
    await page.goto(process.env.DARKROOM_URL||'http://localhost:8080');
    await page.waitForFunction(()=>document.querySelector('#frames .sleeve-empty'));
    // A flat backdrop, a red disc to select, and a dark speck to heal.
    const fixture=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=400;const x=c.getContext('2d');
      x.fillStyle='#29435c';x.fillRect(0,0,640,400);x.fillStyle='#ff0000';x.beginPath();x.arc(480,140,60,0,7);x.fill();
      x.fillStyle='#000000';x.fillRect(156,296,8,8);return c.toDataURL().split(',')[1];}),'base64');
    await page.setInputFiles('#file-images',{name:'studio.png',mimeType:'image/png',buffer:fixture});
    await page.waitForFunction(()=>document.getElementById('canvas').width===640);
    const settled=()=>page.waitForTimeout(160);
    const snap=()=>page.locator('#canvas').evaluate(c=>c.toDataURL());
    const pixel=(x,y)=>page.locator('#canvas').evaluate((c,{x,y})=>[...c.getContext('2d').getImageData(x,y,1,1).data],{x,y});
    const near=(p,q,tol)=>p.slice(0,3).every((v,i)=>Math.abs(v-q[i])<=tol);
    const BG=[41,67,92];
    const field=async(id,v)=>{await page.locator('#'+id).fill(String(v));await page.locator('#'+id).dispatchEvent('change');await settled();};
    const drag=async(x,y,dx,dy,opts={})=>{const r=await page.locator('#ink').boundingBox();await page.mouse.move(r.x+x,r.y+y);await page.mouse.down();await page.mouse.move(r.x+x+dx,r.y+y+dy,{steps:8});await page.mouse.up();await settled();};
    const click=async(x,y,mods=[])=>{const r=await page.locator('#ink').boundingBox();for(const m of mods)await page.keyboard.down(m);await page.mouse.click(r.x+x,r.y+y);for(const m of mods)await page.keyboard.up(m);await settled();};
    const key=async(k)=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(k);await settled();};
    const row=(name)=>page.locator('.art-row .btn:not(.twisty)').filter({hasText:name});
    const rows=()=>page.locator('.art-row').evaluateAll(rs=>rs.map(r=>`${r.style.paddingLeft||'0px'} ${r.textContent.replace(/\s+/g,' ').trim()}`));
    const base=await snap();

    // --- Selections: the magic wand picks the disc; copy it to a layer and move it.
    await key('w');await page.click('#select-kind [data-kind="wand"]');
    await click(480,140);
    assert(await page.isVisible('#selection-panel'),'a selection opens the Selection panel');
    await page.click('#sel-copy');await settled();
    assert.deepEqual(await rows(),['0px ▣ Selection copy ◑']);
    await key('v');await drag(480,140,-200,0);
    assert.deepEqual(await pixel(280,140),[255,0,0,255]);assert.deepEqual(await pixel(480,140),[255,0,0,255]);
    assert(near(await pixel(280,205),BG,1),'only the disc was copied');
    // Shift adds to and Alt subtracts from the selection; Ctrl+D deselects.
    await key('w');await page.click('#select-kind [data-kind="rect"]');
    await drag(20,20,40,40);await page.keyboard.down('Shift');await drag(100,20,40,40);await page.keyboard.up('Shift');
    assert.equal((await page.locator('#history-list button').allTextContents()).slice(-2).join('|'),'Select|Add to selection');
    await key('Control+d');assert(!(await page.isVisible('#selection-panel')));

    // --- Layer styles: bevel lights the upper left and shades the lower right.
    await row('Selection copy').click();
    await page.locator('#style-properties summary').click();
    const plain=await snap();
    await page.check('#style-bevel');await field('style-bevel-size',3);
    const lit=await pixel(241,101),shade=await pixel(319,179);
    assert(lit[1]>30,`bevel highlight ${lit}`);assert(shade[0]<220,`bevel shadow ${shade}`);
    await page.check('#style-glow');await field('style-glow-size',3);
    const halo=await pixel(280,206);assert(!near(halo,BG,4),`outer glow reaches the backdrop ${halo}`);
    await page.uncheck('#style-glow');await page.uncheck('#style-bevel');await settled();assert.equal(await snap(),plain);

    // --- Clipping: a clipped adjustment greys only its base layer.
    await page.click('#layer-add-adjustment');await page.click('#layer-clip');
    await page.locator('#adjust-saturation').fill('-100');await page.locator('#adjust-saturation').dispatchEvent('change');await settled();
    const grey=await pixel(280,140);assert(Math.abs(grey[0]-grey[1])<3,`clipped adjustment desaturates its base ${grey}`);
    assert.deepEqual(await pixel(480,140),[255,0,0,255],'the photo below is untouched');
    assert.deepEqual(await rows(),['0px ↳ ◐ Adjustment','0px ▣ Selection copy ◑']);

    // --- Groups: Ctrl/Shift-click selects several layers; Ctrl+G groups them.
    await row('Selection copy').click({modifiers:['Shift']});
    await key('Control+g');
    assert.deepEqual(await rows(),['0px ▾▤ Group','14px ↳ ◐ Adjustment','14px ▣ Selection copy ◑']);
    await field('layer-opacity',50);
    assert(!near(await pixel(280,140),grey,10)&&!near(await pixel(280,140),BG,10),'group opacity fades its children together');
    await page.click('#btn-undo');await settled();
    // Moving a group moves everything inside it.
    await key('v');await drag(280,140,0,100);
    assert(near(await pixel(280,240),grey,2)&&near(await pixel(280,140),BG,1),'the group moved');
    await page.locator('.art-row .twisty').click();assert.deepEqual(await rows(),['0px ▸▤ Group']);
    await page.locator('.art-row .twisty').click();

    // --- Guides and snapping: a guide at 50% catches the group's center.
    await page.click('#guide-add-v');assert.equal(await page.inputValue('#guide-list input'),'50');
    await row('Group').click();await drag(280,240,36,0);
    await row('Selection copy').click();
    assert(Math.abs(Number(await page.inputValue('#transform-tx'))+25)<0.3,'snapped to the guide');
    // Holding Alt moves freely past the guide.
    await page.keyboard.down('Alt');await drag(300,240,3,0);await page.keyboard.up('Alt');
    {const tx=Number(await page.inputValue('#transform-tx'));assert(Math.abs(tx+25-3/6.4)<0.2,`Alt bypasses snapping ${tx}`);}
    await page.click('#btn-undo');await settled();
    // Alignment to the canvas.
    await page.click('[data-align="left"]');await settled();
    assert(Math.abs(Number(await page.inputValue('#transform-tx'))-(60-480)/6.4)<0.5,'aligned to the left edge');
    assert(near(await pixel(60,240),grey,2));
    await page.click('#btn-undo');await settled();

    // --- Typography: drag a paragraph box with the Type tool.
    await page.locator('#art-layers > button').click();
    await key('t');
    const canvas=await page.locator('#canvas').boundingBox();
    await page.mouse.move(canvas.x+40,canvas.y+20);await page.mouse.down();await page.mouse.move(canvas.x+300,canvas.y+60,{steps:4});await page.mouse.up();await settled();
    assert(await page.isChecked('#text-box'));assert(Math.abs(Number(await page.inputValue('#text-box-width'))-40.6)<0.5);
    await page.fill('#text-content','Every layer, mask and effect stays editable in Darkroom projects.');await page.locator('#text-content').dispatchEvent('change');await settled();
    const lato=await snap();
    await page.selectOption('#text-font','rubik');
    await page.waitForFunction(async()=>(await import('./pkg/darkroom.js')).font_ready('rubik:r'));await settled();await settled();
    const rubik=await snap();assert.notEqual(rubik,lato,'Rubik renders differently from Lato');
    await page.selectOption('#text-align','justify');await field('text-tracking',50);
    assert.notEqual(await snap(),rubik);
    await page.check('#text-italic');await settled();
    await page.waitForFunction(async()=>(await import('./pkg/darkroom.js')).font_ready('rubik:i'));
    // Imported fonts appear in the menu and travel with the project.
    await page.setInputFiles('#file-font',{name:'House Serif.ttf',mimeType:'font/ttf',buffer:await fs.readFile(path.join(__dirname,'../web/fonts/Caladea-Regular.ttf'))});await settled();
    assert((await page.inputValue('#text-font')).startsWith('user:'));
    assert((await page.locator('#text-font option').allTextContents()).includes('House Serif (imported)'));

    // --- Retouching: spot healing, cloning and dodging on a retouch layer.
    await page.locator('#art-layers > button').click();
    await key('j');await page.locator('#retouch-size').fill('30');
    await drag(160,300,2,0);
    assert(near(await pixel(160,300),BG,6),`healed ${await pixel(160,300)}`);
    assert((await rows())[0].includes('Retouch'));
    await key('s');await click(600,330,['Alt']);await drag(480,140,1,0);
    assert(near(await pixel(480,140),BG,2),'cloned the backdrop over the disc');
    await key('o');await page.locator('#retouch-strength').fill('100');await drag(600,40,10,0);
    assert((await pixel(605,40))[2]>BG[2]+15,'dodged lighter');
    await key('Escape');

    const finished=await snap();
    await page.locator('#panel').evaluate(e=>e.scrollTop=0);
    await page.screenshot({path:path.join(dir,'studio.png'),fullPage:true});

    // --- Save and reopen: groups, clipping, guides, text and fonts intact.
    const before={rows:await rows(),guides:await page.locator('#guide-list input').evaluateAll(i=>i.map(x=>x.value))};
    await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    const download=page.waitForEvent('download');await page.click('#btn-save');
    const file=path.join(dir,'studio.darkroom');await(await download).saveAs(file);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#frames .sleeve-empty'));
    await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    await page.setInputFiles('#file-project',file);
    await page.waitForFunction(()=>document.getElementById('canvas').width===640);await settled();await settled();
    assert.equal(await snap(),finished,'the reopened project renders identically');
    assert.deepEqual({rows:await rows(),guides:await page.locator('#guide-list input').evaluateAll(i=>i.map(x=>x.value))},before);
    await row('Text').click();
    assert((await page.inputValue('#text-font')).startsWith('user:'));
    // A selection crop changes the frame, and guides stay with it.
    await key('w');await page.click('#select-kind [data-kind="ellipse"]');await drag(100,50,200,200);
    await page.click('#sel-crop');await settled();
    assert.equal(await page.locator('#canvas').evaluate(c=>c.width),200);
    await page.click('#btn-export');const exporting=page.waitForEvent('download');await page.click('#btn-export-go');
    const png=path.join(dir,'studio-export.png');await(await exporting).saveAs(png);
    assert((await fs.stat(png)).size>1000);
    assert.deepEqual(errors,[]);
    assert.notEqual(finished,base);
    console.log('PASS: selections, styles, clipping, groups, guides/snapping/alignment, typography, imported fonts, retouching, save/reopen, crop and export.');console.log('Artifacts:',dir);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
