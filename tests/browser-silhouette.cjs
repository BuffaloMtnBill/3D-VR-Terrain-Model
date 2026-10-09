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
    await page.locator('#silhouette-back').click();
    await context.close();

    const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await setup(mobile);
    const phone=await mobile.newPage();
    await openSilhouette(phone);
    assert.equal(await phone.evaluate(()=>document.getElementById('silhouette').scrollWidth<=innerWidth),true,'No horizontal scroll on a phone');
    await phone.screenshot({path:path.join(output,'silhouette-mobile.png')});
    await mobile.close();
    assert.deepEqual(errors,[]);
    console.log('Silhouette design page browser test passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
