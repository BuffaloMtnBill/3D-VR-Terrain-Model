/* Silhouette design page end-to-end test: run scripts/browser_fixture_server.py (port 8001) first.
 * TERRAIN_PLAYWRIGHT_PATH points at a Playwright package; TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const output=path.join(__dirname,'..','test-results');
const exportRequest=(page,format)=>page.waitForRequest(request=>/\/api\/silhouette\/[^/]+\/export$/.test(request.url())&&request.method()==='POST'&&request.postDataJSON()?.format===format);
const outlineAfter=(page,test)=>page.waitForResponse(response=>/\/api\/silhouette\/[^/]+\/outline$/.test(response.url())&&test(response.request().postDataJSON()));
// A 10 km route inside the Roan Mountain frame with two climbs, a name, and a start time.
function routeGPX() {
  const points=Array.from({length:300},(_,index)=>{const t=index/299;return `<trkpt lat="${(36.09+.045*t).toFixed(6)}" lon="${(-82.16+.1*t).toFixed(6)}"><ele>${(900+300*Math.sin(t*Math.PI*2)**2).toFixed(1)}</ele><time>2026-05-04T13:00:00Z</time></trkpt>`;});
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Roan Highlands 10K</name><trkseg>${points.join('')}</trkseg></trk></gpx>`;
}

(async()=>{
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:process.env.TERRAIN_CHROMIUM_PATH,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const errors=[];
  async function setup(context) {
    await context.route(/^https:\/\/tile\./,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'}));
  }
  async function openSilhouette(page) {
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    const first=outlineAfter(page,()=>true);
    await page.locator('#silhouette-button').click();
    assert.equal(await page.locator('#silhouette').isVisible(),true,'Silhouette design opens its page');
    await first;
    await page.waitForSelector('#silhouette-svg path.sil-body');
  }
  try {
    const context=await browser.newContext({viewport:{width:1500,height:950},acceptDownloads:true});
    await setup(context);
    const page=await context.newPage();
    await openSilhouette(page);
    assert.match(await page.locator('#silhouette .eyebrow').innerText(),/STEP 2 · SILHOUETTE DESIGN/i);
    assert.match(await page.locator('#silhouette-title').innerText(),/Roan Mountain/);
    assert.equal(await page.locator('#silhouette-text').inputValue(),'Roan Mountain','The caption starts as the place name');
    assert.equal(await page.locator('#silhouette-vertical').inputValue(),await page.locator('#exaggeration').inputValue(),'Vertical scale follows the elevation multiplier');
    assert.match(await page.locator('#silhouette-dimensions').innerText(),/^180 × [\d.]+ × 4 mm$/);
    assert.ok(await page.locator('#silhouette-svg path.sil-text').count()===1,'The caption is drawn on the piece');

    // The slice is shared with the geography selection page, both ways.
    let moved=outlineAfter(page,body=>body.position===22);
    await page.locator('#silhouette-position').evaluate(element=>{element.value='22';element.dispatchEvent(new Event('input',{bubbles:true}));});
    await moved;
    assert.equal(await page.locator('#profile-position').inputValue(),'22','The slider moves the geography page slice');
    assert.equal(await page.locator('#profile-position-value').innerText(),'22%');
    moved=outlineAfter(page,body=>body.direction==='ns');
    await page.locator('#silhouette-direction').selectOption('ns');
    await moved;
    assert.equal(await page.locator('#profile-direction').inputValue(),'ns');
    await page.locator('#profile-position').evaluate(element=>{element.value='64';element.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.locator('#silhouette-position').inputValue(),'64','The geography page slice moves this slider');
    assert.match(await page.locator('#silhouette-slice-label').innerText(),/64% across/);

    // Trim keeps 5% between its handles; text, mount and shape settings reach the server.
    await page.locator('#silhouette-trim-start').evaluate(element=>{element.value='40';element.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#silhouette-trim-end').evaluate(element=>{element.value='42';element.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.deepEqual([await page.locator('#silhouette-trim-start').inputValue(),await page.locator('#silhouette-trim-end').inputValue()],['37','42']);
    await page.locator('#silhouette-trim-start').evaluate(element=>{element.value='10';element.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#silhouette-trim-end').evaluate(element=>{element.value='90';element.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#silhouette-text').fill('ROAN HIGHLANDS');
    await page.locator('#silhouette-text-style').selectOption('emboss');
    await page.locator('#silhouette-mount').selectOption('holes');
    assert.equal(await page.locator('#silhouette-hole').isVisible(),true,'Hole size appears for wall holes');
    const thicker=outlineAfter(page,body=>body.thickness_mm===5&&body.width_mm===150);
    await page.locator('#silhouette-width').fill('150');
    await page.locator('#silhouette-thickness').fill('5');
    await thicker;
    await page.waitForFunction(()=>/^150 × [\d.]+ × 5 mm$/.test(document.getElementById('silhouette-dimensions').textContent));

    let request=exportRequest(page,'stl'),downloading=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="stl"]').click();
    let body=(await request).postDataJSON(),file=await downloading;
    assert.deepEqual([body.direction,body.position,body.trim,body.width_mm,body.thickness_mm,body.text,body.text_style,body.mount],
      ['ns',64,[10,90],150,5,'ROAN HIGHLANDS','emboss','holes']);
    assert.equal(file.suggestedFilename(),'roan-mountain-silhouette.stl');
    const stl=await fs.readFile(await file.path());
    assert.equal(stl.length,84+50*stl.readUInt32LE(80),'A complete binary STL');
    request=exportRequest(page,'svg');downloading=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="svg"]').click();
    body=(await request).postDataJSON();file=await downloading;
    assert.equal(body.mount,'holes');
    const drawing=await fs.readFile(await file.path(),'utf8');
    assert.match(drawing,/<svg[^>]+width="150\.000mm"[^>]+viewBox="0 0 150\.000 /);
    assert.equal((drawing.match(/<path /g)||[]).length,2,'Outline and text paths');
    await page.waitForFunction(()=>!document.querySelector('[data-silhouette-export="stl"]').disabled);
    assert.match(await page.locator('#silhouette-status').innerText(),/downloaded/);

    await page.locator('[data-silhouette-view="3d"]').click();
    assert.equal(await page.locator('#silhouette-3d canvas').count(),1,'The 3D view has its own canvas');
    await page.waitForTimeout(400);
    await page.screenshot({path:path.join(output,'silhouette-3d.png')});

    // Settings are remembered for this framed area.
    await page.locator('#silhouette-back').click();
    assert.equal(await page.locator('#silhouette').isVisible(),false,'Back returns to the geography selection page');
    assert.equal(await page.locator('#map').isVisible(),true);
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    await page.locator('#silhouette-button').click();
    assert.equal(await page.locator('#silhouette-text').inputValue(),'ROAN HIGHLANDS');
    assert.equal(await page.locator('#silhouette-mount').inputValue(),'holes');

    // Start from: presets grouped under their headings.
    assert.deepEqual(await page.locator('.silhouette-preset-heading').allInnerTexts(),['GLOW LAMPS','SHADOW BOXES','FLAT PIECES','RACE PROFILE']);
    assert.equal(await page.locator('[data-silhouette-preset]').count(),11);
    assert.equal(await page.locator('#silhouette-fit-card').isVisible(),false,'Custom has no preset settings');
    // The preview: hovering a preset shows it turning in the Start from card without applying it.
    assert.equal(await page.locator('.silhouette-start #silhouette-turntable-view canvas').count(),1,'The preview has its own canvas in the Start from card');
    await page.waitForFunction(()=>/^Preview · Custom$/.test(document.getElementById('silhouette-turntable-title').textContent)&&/ mm · 1 piece$/.test(document.getElementById('silhouette-turntable-size').textContent));
    const before=await page.evaluate(()=>localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('terrain-silhouette:v1:'))));
    const previewed=outlineAfter(page,body=>body.preset==='glow-layers'&&body.fit==='lamp'&&body.layers?.length===3);
    await page.locator('[data-silhouette-preset="glow-layers"]').hover();
    await previewed;
    await page.waitForFunction(()=>document.getElementById('silhouette-turntable-title').textContent==='Preview · Layered glow'&&/ × [\d.–]+ mm · 3 layers$/.test(document.getElementById('silhouette-turntable-size').textContent));
    assert.equal(await page.locator('[data-silhouette-preset="custom"]').getAttribute('aria-checked'),'true','Hovering does not apply the preset');
    assert.equal(await page.locator('[data-silhouette-preset="glow-layers"]').getAttribute('aria-checked'),'false');
    assert.equal(await page.locator('#silhouette-fit-card').isVisible(),false);
    assert.equal(await page.evaluate(()=>localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('terrain-silhouette:v1:')))),before,'Hovering leaves the saved settings alone');
    await page.mouse.move(5,900);
    await page.waitForFunction(()=>document.getElementById('silhouette-turntable-title').textContent==='Preview · Custom');
    // Keyboard focus previews too (served from the cache this time).
    await page.locator('[data-silhouette-preset="custom"]').focus();await page.keyboard.press('Tab');
    await page.waitForFunction(()=>document.getElementById('silhouette-turntable-title').textContent!=='Preview · Custom');
    await page.locator('#silhouette-text').focus();
    await page.waitForFunction(()=>document.getElementById('silhouette-turntable-title').textContent==='Preview · Custom');
    // A glow lamp: layered panels in a comb base with the lamp-base slot fields.
    let next=outlineAfter(page,body=>body.preset==='glow-layers'&&body.fit==='lamp'&&body.layers?.length===3);
    await page.locator('[data-silhouette-preset="glow-layers"]').click();
    body=(await next).request().postDataJSON();
    assert.equal(body.mount,'none','A lamp holds the design, so the mount resets');
    assert.deepEqual(body.layers.map(layer=>layer.base_mm),[14,22,30],'Each layer stands a step higher');
    assert.ok(body.layers[0].color!==body.layers[2].color,'Layers fade from front to back');
    for(const id of ['silhouette-slot-width','silhouette-slot-length','silhouette-slot-depth','silhouette-slot-clearance','silhouette-layer-positions','silhouette-layer-spacing'])
      assert.equal(await page.locator(`#${id}`).isVisible(),true,`${id} appears for the layered glow`);
    assert.equal(await page.locator('#silhouette-box-depth').isVisible(),false);
    await page.waitForFunction(()=>document.getElementById('silhouette-parts').textContent.startsWith('Parts: 3 layers, comb base'));
    assert.match(await page.locator('#silhouette-preset-hint').innerText(),/translucent PETG/);
    await page.waitForSelector('#silhouette-svg rect.sil-fit');
    assert.equal(await page.locator('#silhouette-svg path.sil-layer').count(),2,'The rear layers are drawn behind the front one');
    await page.waitForFunction(()=>document.querySelectorAll('#silhouette-layer-axis rect[data-layer]').length===3);
    assert.deepEqual(await page.locator('#silhouette-layer-axis rect[data-layer]').evaluateAll(elements=>elements.map(element=>Number(element.dataset.start))),body.layers.map(layer=>layer.position));
    assert.match(await page.locator('#silhouette-layer-axis-hint').innerText(),/slice positions/);
    await page.screenshot({path:path.join(output,'silhouette-glow-layers.png')});
    next=outlineAfter(page,body=>body.preset==='glow-layers'&&body.clouds===true);
    await page.locator('#silhouette-clouds').check();
    const cloudData=await (await next).json();
    assert.equal(cloudData.layers.length,4);assert.equal(cloudData.layers[3].kind,'cloud');
    assert.equal(cloudData.fit.comb_base.slots.length,4);
    await page.waitForFunction(()=>!document.getElementById('silhouette-cloud-key').hidden);
    assert.equal(await page.locator('#silhouette-layer-axis rect[data-layer]').count(),3,'The decorative cloud panel has no terrain region');
    assert.match(await page.locator('#silhouette-cloud-key').innerText(),/decorative rear panel/);
    await page.screenshot({path:path.join(output,'silhouette-cloud-background.png')});
    request=exportRequest(page,'stl');downloading=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="stl"]').click();
    body=(await request).postDataJSON();file=await downloading;
    assert.equal(body.layers.length,3);assert.equal(body.slot_width,4);
    assert.equal(body.clouds,true,'The cloud option is included in the exported model');
    assert.equal(file.suggestedFilename(),'roan-mountain-silhouette-parts.zip','Several parts download as a ZIP of STLs');
    assert.equal((await fs.readFile(await file.path())).subarray(0,2).toString(),'PK');
    await page.waitForFunction(()=>!document.querySelector('[data-silhouette-export="stl"]').disabled);

    // A shadow box: the diorama's layers and spacer combs; the box's width sets the pieces'.
    next=outlineAfter(page,body=>body.preset==='box-diorama'&&body.fit==='box'&&body.layers?.length===5);
    await page.locator('[data-silhouette-preset="box-diorama"]').click();
    await next;
    for(const id of ['silhouette-box-width','silhouette-box-height','silhouette-box-depth','silhouette-led'])
      assert.equal(await page.locator(`#${id}`).isVisible(),true,`${id} appears for the diorama`);
    assert.equal(await page.locator('#silhouette-slot-width').isVisible(),false);
    assert.equal(await page.locator('#silhouette-width').isDisabled(),true,'Box pieces follow the inner width');
    next=outlineAfter(page,body=>body.layers?.length===4);
    await page.locator('#silhouette-layer-count').fill('4');
    body=(await next).request().postDataJSON();
    assert.deepEqual(body.layers.map(layer=>layer.position),[85,61.7,38.3,15],'The near (south) side of a west → east slice is the front');
    await page.waitForFunction(()=>document.getElementById('silhouette-parts').textContent.startsWith('Parts: 4 layers, 2 spacer combs'));
    await page.locator('[data-silhouette-view="3d"]').click();await page.waitForTimeout(400);
    await page.screenshot({path:path.join(output,'silhouette-diorama-3d.png')});
    await page.locator('[data-silhouette-view="front"]').click();
    request=exportRequest(page,'3mf');downloading=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="3mf"]').click();
    body=(await request).postDataJSON();file=await downloading;
    assert.deepEqual([body.fit,body.layers.length,body.box_width,body.width_mm],['box',4,200,199]);
    assert.equal(file.suggestedFilename(),'roan-mountain-silhouette.3mf');
    await page.waitForFunction(()=>!document.querySelector('[data-silhouette-export="3mf"]').disabled);

    // A race profile from an uploaded GPX: ticks, START and FINISH, medal pegs, and the finish time in the caption.
    await page.locator('#route-file').setInputFiles({name:'roan-10k.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from(routeGPX())});
    await page.waitForFunction(()=>document.getElementById('route-name').textContent==='Roan Highlands 10K');
    next=outlineAfter(page,body=>body.preset==='race'&&body.source==='route'&&/^[0-9a-f]{24}$/.test(body.route_id||''));
    await page.locator('[data-silhouette-preset="race"]').click();
    body=(await next).request().postDataJSON();
    assert.deepEqual([body.peg_count,body.ticks,body.start_finish,body.tick_every,body.units,body.mount],[3,true,true,1,'ft','keyholes']);
    assert.ok(body.vertical_scale>2,'A route profile gets a taller vertical scale');
    for(const id of ['silhouette-finish-time','silhouette-peg-count','silhouette-tick-every','silhouette-route-status'])
      assert.equal(await page.locator(`#${id}`).isVisible(),true,`${id} appears for the race profile`);
    assert.match(await page.locator('#silhouette-route-status').innerText(),/Roan Highlands 10K/);
    next=outlineAfter(page,body=>body.text?.endsWith('3:42:15'));
    await page.locator('#silhouette-finish-time').fill('3:42:15');
    body=(await next).request().postDataJSON();
    assert.equal(body.text.split('\n').length,3,'Race name, date, and finish time');
    assert.match(body.text,/^Roan Highlands 10K\n.*2026/);
    next=outlineAfter(page,body=>body.tick_every===10);
    await page.locator('[data-race-kind="cycling"]').click();
    await next;
    await page.waitForSelector('#silhouette-svg circle.sil-peg');
    assert.equal(await page.locator('#silhouette-svg circle.sil-peg').count(),3);
    assert.match(await page.locator('#silhouette-slice-label').innerText(),/along the route/);
    await page.screenshot({path:path.join(output,'silhouette-race.png')});
    request=exportRequest(page,'stl');downloading=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="stl"]').click();
    body=(await request).postDataJSON();file=await downloading;
    assert.equal(file.suggestedFilename(),'roan-mountain-silhouette.stl','One race piece is one STL');
    assert.equal(body.source,'route');
    await page.waitForFunction(()=>!document.querySelector('[data-silhouette-export="stl"]').disabled);
    // The chosen preset and its fields are remembered for this area; Custom returns to a plain piece.
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    await page.locator('#silhouette-button').click();
    assert.equal(await page.locator('[data-silhouette-preset="race"]').getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('#silhouette-finish-time').inputValue(),'3:42:15');
    next=outlineAfter(page,body=>body.preset==='custom'&&body.fit==='none'&&!body.layers&&body.peg_count===0);
    await page.locator('[data-silhouette-preset="custom"]').click();
    await next;
    await page.locator('#silhouette-back').click();
    await context.close();

    const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await setup(mobile);
    const phone=await mobile.newPage();
    await openSilhouette(phone);
    const mobileLayers=outlineAfter(phone,body=>body.preset==='glow-layers');
    await phone.locator('[data-silhouette-preset="glow-layers"]').click();await mobileLayers;
    await phone.waitForFunction(()=>document.querySelectorAll('#silhouette-layer-axis rect[data-layer]').length===3);
    assert.equal(await phone.evaluate(()=>document.getElementById('silhouette').scrollWidth<=innerWidth),true,'No horizontal scroll on a phone');
    await phone.screenshot({path:path.join(output,'silhouette-mobile.png')});
    await mobile.close();
    assert.deepEqual(errors,[]);
    console.log('Silhouette design page browser test passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
