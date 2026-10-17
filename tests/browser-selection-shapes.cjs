/* Circle/oval explorer selection and transfer into 3D model design. Uses the fixture server's synthetic round terrains. */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');
// The page fetches the surface in binary; the same request as JSON is easier to check.
const surfaceJSON=async(page,response)=>(await page.request.get(response.url().replace('format=binary','format=json'))).json();
const fs=require('node:fs/promises');
const path=require('node:path');
const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const selected=page=>page.locator('#selection-parameters').evaluate(e=>JSON.parse(e.value).bounds);
const frame=page=>page.locator('#selection-frame').evaluate(e=>({width:parseFloat(e.style.width),height:parseFloat(e.style.height),
  angle:parseFloat(e.style.transform.match(/rotate\(([^)]+)/)[1])}));
async function drag(page,side,dx,dy) {
  const box=await page.locator(`[data-resize="${side}"]`).boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:6});await page.mouse.up();
}
async function rotate(page,degrees) {
  const center=await page.locator('#selection-frame').evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  const hook=await page.locator('[data-rotate]').boundingBox(),x=hook.x+hook.width/2,y=hook.y+hook.height/2;
  const angle=Math.atan2(y-center.y,x-center.x)+degrees*Math.PI/180,r=Math.hypot(x-center.x,y-center.y);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(center.x+r*Math.cos(angle),center.y+r*Math.sin(angle),{steps:8});await page.mouse.up();
}
function glbPositions(bytes) {
  const jsonLength=bytes.readUInt32LE(12),document=JSON.parse(bytes.subarray(20,20+jsonLength).toString());
  const binary=20+jsonLength+8,points=[];
  for(const mesh of document.meshes)for(const primitive of mesh.primitives) {
    const accessor=document.accessors[primitive.attributes.POSITION],view=document.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType,5126);
    for(let i=0;i<accessor.count;i++) {
      const offset=binary+(view.byteOffset||0)+(accessor.byteOffset||0)+i*(view.byteStride||12);
      points.push([bytes.readFloatLE(offset),bytes.readFloatLE(offset+4),bytes.readFloatLE(offset+8)]);
    }
  }
  return {document,points};
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.TERRAIN_CHROMIUM_PATH,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1500,height:950},acceptDownloads:true}),errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});
    await page.route(/^https:\/\/tile\./,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'}));
    await page.goto(url);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    await page.locator('#selection-shape').selectOption('circle');
    assert.equal((await selected(page)).shape,'circle');
    let before=await frame(page);assert.ok(Math.abs(before.width-before.height)<.001);
    await drag(page,'width',-25,0);
    let after=await frame(page);assert.ok(after.width<before.width);assert.ok(Math.abs(after.width-after.height)<.001);
    before=after;
    await page.locator('[data-resize="left"]').focus();await page.keyboard.press('ArrowLeft');
    after=await frame(page);assert.ok(after.width>before.width);assert.ok(Math.abs(after.width-after.height)<.001);
    await rotate(page,25);
    assert.ok(Math.abs((await selected(page)).rotation_deg-25)<1);
    await page.locator('#selection-shape').selectOption('oval');
    before=await frame(page);
    const radians=before.angle*Math.PI/180;
    await drag(page,'width',40*Math.cos(radians),40*Math.sin(radians));
    after=await frame(page);assert.ok(after.width>before.width+30);assert.ok(Math.abs(after.height-before.height)<.001);
    const bounds=await selected(page);assert.equal(bounds.shape,'oval');
    let request=page.waitForRequest(r=>/\/api\/terrain$/.test(r.url())&&r.method()==='POST');
    let response=page.waitForResponse(r=>/\/api\/terrain\/[^/?]+(?:\?|$)/.test(r.url())&&r.request().method()==='GET');
    await page.locator('#generate').click();
    assert.deepEqual((await request).postDataJSON().bounds,bounds);
    const surface=await surfaceJSON(page,await response);
    assert.equal(surface.bounds.shape,'oval');assert.ok(Math.abs(surface.bounds.rotation_deg-25)<1);
    assert.equal(surface.footprint.length,128);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('oval footprint'));
    const output=path.join(__dirname,'../test-results');await fs.mkdir(output,{recursive:true});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'selection-oval-explorer.png')});
    await page.locator('#export-button').click();
    assert.equal(await page.locator('#studio').isVisible(),true);
    await page.screenshot({path:path.join(output,'selection-oval-studio.png')});
    // A GLB exported from the editable view must have no rectangular corners, including roads/water.
    const download=page.waitForEvent('download');await page.locator('[data-export="glb"]').click();
    const file=await download,{points}=glbPositions(await fs.readFile(await file.path()));
    let maxX=0,maxZ=0;
    for(const [x,,z] of points){maxX=Math.max(maxX,Math.abs(x));maxZ=Math.max(maxZ,Math.abs(z));}
    assert.ok(points.length>100);
    assert.ok(points.every(([x,,z])=>(x/maxX)**2+(z/maxZ)**2<=1.001),'GLB terrain, walls and features share the oval footprint');
    await page.waitForFunction(()=>!document.querySelector('[data-export="metadata"]').disabled);
    const metadataDownload=page.waitForEvent('download');await page.locator('[data-export="metadata"]').click();
    const metadata=JSON.parse(await fs.readFile(await (await metadataDownload).path(),'utf8'));
    assert.equal(metadata.bounds.shape,'oval');assert.equal(metadata.bounds.rotation_deg,surface.bounds.rotation_deg);
    await page.locator('#studio-back').click();
    await page.locator('#selection-shape').selectOption('circle');
    response=page.waitForResponse(r=>/\/api\/terrain\/[^/?]+(?:\?|$)/.test(r.url())&&r.request().method()==='GET');
    await page.locator('#generate').click();
    const circle=await surfaceJSON(page,await response);assert.equal(circle.width_m,circle.height_m);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('circle footprint'));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'selection-circle-explorer.png')});
    await page.locator('#selection-shape').selectOption('rectangle');
    before=await frame(page);await drag(page,'width',-15,0);after=await frame(page);
    assert.ok(after.width<before.width);assert.equal(after.height,before.height);
    assert.equal((await selected(page)).shape,undefined,'Rectangle selection retains the original bounds format');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Shape controls fit a narrow explorer');
    assert.deepEqual(errors,[]);
    console.log('Circle/oval borders, aspect lock, rotation, generation, 3D design, clipped GLB and export metadata passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
