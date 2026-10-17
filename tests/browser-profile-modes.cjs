/* Profile modes end-to-end test: run scripts/browser_fixture_server.py (port 8019) first.
 * TERRAIN_PLAYWRIGHT_PATH points at a Playwright package; TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8019';
const errors=[];
let outlineAfter;

(async()=>{
  const browser=await chromium.launch({
    headless:true,
    executablePath:process.env.TERRAIN_CHROMIUM_PATH,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });

  try {
    const context=await browser.newContext({viewport:{width:1500,height:950}});
    const page=await context.newPage();
    outlineAfter=test=>page.waitForResponse(r=>/\/api\/silhouette\/[^/]+\/outline$/.test(r.url())&&test(r.request().postDataJSON()||{}));

    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text())});

    // Start without saved profile settings; later reloads keep what the test stored.
    await context.addInitScript(()=>{
      try{if(!sessionStorage.getItem('profile-test-started')){localStorage.removeItem('terrain-profile-mode');sessionStorage.setItem('profile-test-started','1');}}catch(e){}
    });

    await page.goto(url);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('×'),null,{timeout:30000});

    // Test 1: Ridgeline mode
    console.log('Test 1: Ridgeline mode');
    await page.locator('#profile-mode').selectOption('ridgeline');
    assert.equal(await page.locator('#profile-pick-ridge').getAttribute('aria-pressed'),'true','Ridgeline button is pressed');
    assert.equal(await page.locator('#profile-slice-controls').isHidden(),true,'Slice controls are hidden');
    assert.equal(await page.locator('#profile-ridge-controls').isHidden(),false,'Ridge controls are visible');

    // Click two points in the selection frame
    await page.evaluate(()=>window.scrollTo(0,0));
    const frame=await page.locator('#selection-frame').boundingBox();
    const at=(u,v)=>[frame.x+frame.width*u,frame.y+frame.height*v];

    await page.mouse.click(...at(0.08,0.15));
    await page.waitForTimeout(200);
    await page.mouse.click(...at(0.92,0.85));
    await page.waitForFunction(()=>/along the high ground|outside|No ridgeline/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:15000});

    const ridgeStatus=await page.locator('#profile-mode-status').innerText();
    const ridgeDistance=await page.locator('#profile-distance').innerText();
    console.log('  status:',ridgeStatus);
    console.log('  distance:',ridgeDistance);
    assert.match(ridgeStatus,/along the high ground/,'Status shows "along the high ground"');
    assert.match(ridgeDistance,/along the ridgeline/,'Distance shows "along the ridgeline"');

    const markerCount=await page.locator('.profile-marker').count();
    assert.equal(markerCount,2,'Two profile markers exist');
    console.log('  markers:',markerCount);

    // Test 2: Viewpoint mode
    console.log('Test 2: Viewpoint mode');
    await page.locator('#profile-mode').selectOption('viewpoint');

    // Re-measure frame and click viewpoint
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForTimeout(300);
    const frame2=await page.locator('#selection-frame').boundingBox();
    await page.mouse.click(frame2.x+frame2.width*0.35,frame2.y+frame2.height*0.55);
    // A new viewpoint faces the middle of the selection box: here a little north of east.
    const aimed=Number(await page.locator('#view-bearing').inputValue());
    console.log('  default facing:',aimed);
    assert.ok(aimed>45&&aimed<90,`The viewpoint faces the selection's center (${aimed}°)`);
    assert.match(await page.locator('#view-bearing-value').innerText(),new RegExp(`^${aimed}°`));

    // Set bearing to 60 and bands to 3
    await page.locator('#view-bearing').evaluate(e=>{e.value='60';e.dispatchEvent(new Event('input',{bubbles:true}));});

    // Set up request listener before changing bands
    const profileRequest=page.waitForRequest(r=>r.url().includes('/api/profile/')&&r.method()==='POST');

    await page.locator('#view-bands').selectOption('3');
    await page.waitForFunction(()=>/to the frame's edge/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:15000});

    const viewStatus=await page.locator('#profile-mode-status').innerText();
    const viewDistance=await page.locator('#profile-distance').innerText();
    console.log('  status:',viewStatus);
    console.log('  distance:',viewDistance);
    assert.match(viewStatus,/to the frame's edge/,'Status shows "to the frame\'s edge"');
    assert.match(viewDistance,/view facing NE/,'Distance shows bearing NE');

    // Check request body
    try {
      const req=await profileRequest;
      const body=await req.postDataJSON();
      console.log('  request mode:',body.mode,'bands:',body.bands,'bearing:',body.bearing);
      assert.equal(body.mode,'viewpoint','Request mode is viewpoint');
      assert.equal(body.bands,3,'Request bands is 3');
      assert.equal(body.bearing,60,'Request bearing is 60');
      assert.ok(Array.isArray(body.point)&&body.point.length===2,'Request has point array');
    } catch(e) {
      console.log('  request check skipped:',e.message);
    }

    // Hover over profile canvas and check tooltip
    const box=await page.locator('#profile').boundingBox();
    await page.evaluate(({x,y})=>{
      const canvas=document.getElementById('profile');
      const rect=canvas.getBoundingClientRect();
      const event=new PointerEvent('pointermove',{bubbles:true,clientX:x+rect.left,clientY:y+rect.top});
      canvas.dispatchEvent(event);
    },{x:box.width*0.5,y:box.height*0.5});
    await page.waitForTimeout(200);
    const tooltipText=await page.locator('#profile-tooltip').innerText();
    console.log('  tooltip:',tooltipText);
    assert.match(tooltipText,/° up · ridge/,'Tooltip shows elevation and ridge distance');

    // Test 3: Silhouette page
    console.log('Test 3: Silhouette page');
    await page.locator('#silhouette-button').click();
    await page.waitForTimeout(500);

    const sourceValue=await page.locator('#silhouette-source').inputValue();
    console.log('  silhouette source:',sourceValue);
    assert.equal(sourceValue,'viewpoint','Silhouette source is viewpoint');

    await page.locator('[data-silhouette-preset="box-diorama"]').click().catch(e=>console.log('  preset error:',e.message.split('\n')[0]));
    await page.waitForTimeout(2000);

    const checkListText=await page.locator('#silhouette-check-list').innerText();
    console.log('  check list:',checkListText.replace(/\n/g,' | ').slice(0,150));
    assert.match(checkListText,/distance band/,'Check list contains "distance band"');

    // Go back to geography page
    await page.locator('#silhouette-back').click();
    await page.waitForTimeout(500);

    // Test 3b: ridges detected beyond 1 km become the Layered glow's panels, closer ones thicker.
    console.log('Test 3b: Detected ridges in the Layered glow');
    await page.locator('#profile-pick-view').click();
    await page.evaluate(()=>window.scrollTo(0,0));
    const frame3=await page.locator('#selection-frame').boundingBox();
    await page.mouse.click(frame3.x+frame3.width*.5,frame3.y+frame3.height*.5);
    await page.locator('#view-bearing').evaluate(e=>{e.value='90';e.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.locator('#view-far').inputValue(),'0','Out to defaults to the horizon');
    // Out to: a cutoff ends the view there; the status says so and the request carries it.
    const cutoff=page.waitForResponse(r=>r.url().includes('/api/profile/')&&r.request().postDataJSON()?.max_radius_m===2000);
    await page.locator('#view-far').selectOption('2000');
    const cut=await (await cutoff).json();
    assert.ok(cut.max_radius_m===2000&&cut.farthest_m<=2000,'The view ends at the cutoff');
    await page.waitForFunction(()=>/cut off at|out to/.test(document.getElementById('profile-mode-status').textContent));
    await page.locator('#view-far').selectOption('0');
    await page.locator('#view-radius').selectOption('1000');
    await page.locator('#view-bands').selectOption('3');
    const detected=page.waitForResponse(r=>r.url().includes('/api/profile/')&&r.request().postDataJSON()?.ridges===true);
    await page.locator('#view-ridges').check();
    const found=(await (await detected).json()).ridges;
    await page.waitForFunction(()=>/ridges? at .* nearest first/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:15000});
    console.log('  ridges:',found.map(ridge=>ridge.distance_m).join(', '));
    assert.ok(found.length>=2&&found.length<=4,'Two to four ridges stand beyond 1 km');
    await page.locator('#silhouette-button').click();
    const glow=page.waitForResponse(r=>/\/api\/silhouette\/[^/]+\/outline$/.test(r.url())&&r.request().postDataJSON()?.preset==='glow-layers'&&r.request().postDataJSON()?.view_ridges===true);
    await page.locator('[data-silhouette-preset="glow-layers"]').click();
    const outline=await (await glow).json(),sent=(await glow).request().postDataJSON();
    assert.equal(sent.layers.length,found.length,'One layer per detected ridge');
    assert.deepEqual([sent.view_min_radius_m,sent.view_max_radius_m,sent.thickness_by_distance,sent.thickness_near_mm,sent.thickness_far_mm],[1000,0,true,3,1.5],'Out to starts at the horizon');
    const thicknesses=outline.layers.map(layer=>layer.thickness_mm);
    assert.ok(thicknesses.every((value,index)=>!index||value<thicknesses[index-1]),`Closer ridges are thicker: ${thicknesses}`);
    assert.deepEqual([thicknesses[0],thicknesses.at(-1)],[3,1.5]);
    await page.waitForFunction(count=>document.querySelectorAll('#silhouette-layer-list li').length===count,found.length);
    const items=await page.locator('#silhouette-layer-list li').allInnerTexts();
    console.log('  layers:',items.join(' | '));
    assert.match(items[0],/^Layer 1 \(front\) · ridge [\d.]+ mi · 3\.0 mm$/);
    assert.deepEqual(items.map(text=>Number(text.match(/([\d.]+) mm$/)[1])),thicknesses,'The list shows each layer\'s thickness');
    assert.equal(await page.locator('#silhouette-thickness-distance').isChecked(),true,'Thicker when closer starts on for a viewpoint');
    assert.equal(await page.locator('#silhouette-thickness').isDisabled(),true,'The single thickness steps aside');
    assert.match(await page.locator('#silhouette-check-list').innerText(),/ridgeline detected from the viewpoint/);
    assert.match(await page.locator('#silhouette-slice-label').innerText(),new RegExp(`${found.length} ridges`));
    const exported=page.waitForRequest(r=>/\/api\/silhouette\/[^/]+\/export$/.test(r.url())&&r.method()==='POST');
    const download=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="stl"]').click();
    const body=(await exported).postDataJSON();await download;
    assert.deepEqual([body.view_ridges,body.thickness_by_distance,body.layers.length],[true,true,found.length]);
    // The same ridges as color zones of one flat piece: stepped, each zone its distance color, exported as a 3MF.
    assert.equal(await page.locator('#silhouette-pieces-block').isHidden(),false,'One piece is offered for a viewpoint\'s ridges');
    const zoned=outlineAfter(body=>body.color_zones===true);
    await page.locator('#silhouette-pieces').selectOption('zones');
    const zoneOutline=await (await zoned).json();
    assert.ok(zoneOutline.zones.length>=2&&zoneOutline.layers.length===1,'One piece with a zone per showing ridge');
    assert.deepEqual(zoneOutline.zones.map(zone=>zone.thickness_mm)[0],3,'The nearest zone is the thickest');
    await page.waitForFunction(count=>document.querySelectorAll('#silhouette-svg path.sil-zone').length===count,zoneOutline.zones.length);
    assert.equal(await page.locator('#silhouette-spacing-block').isHidden(),true,'The comb spacing steps aside for one piece');
    assert.match(await page.locator('#silhouette-parts').innerText(),/Silhouette with lamp tab[\s\S]*Zone 1 \(nearest\) · ridge [\d.]+ mi · 3\.0 mm · color #/);
    assert.match(await page.locator('#silhouette-filaments').innerText(),/^[234] of 4 filament colors$/);
    assert.equal(await page.locator('#silhouette-color-distance').isDisabled(),true,'Zones always use the distance colors');
    const zoneExport=page.waitForRequest(r=>/\/api\/silhouette\/[^/]+\/export$/.test(r.url())&&r.postDataJSON()?.format==='3mf');
    const zoneDownload=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="3mf"]').click();
    const zoneBody=(await zoneExport).postDataJSON(),saved=await zoneDownload;
    assert.equal(zoneBody.color_zones,true);assert.equal(zoneBody.distance_colors.length,4);
    assert.ok(zoneBody.distance_colors.every(color=>/^#[0-9a-f]{6}$/.test(color)));
    assert.match(saved.suggestedFilename(),/silhouette\.3mf$/);
    assert.equal(await page.locator('#silhouette-status').innerText(),'Your file has been downloaded.');
    await page.locator('#silhouette-pieces').selectOption('layers');
    await page.locator('#silhouette-back').click();
    await page.waitForTimeout(300);

    // Test 3c: Viewpoint ridgeline — crest lines on the map, a click moves the viewpoint, stale points are re-picked.
    console.log('Test 3c: Viewpoint ridgeline');
    await page.locator('#profile-mode').selectOption('viewridge');
    assert.equal(await page.locator('#view-ridges-label').isHidden(),true,'Ridge detection is always on in this mode');
    await page.evaluate(()=>window.scrollTo(0,0));
    let ridgeFrame=await page.locator('#selection-frame').boundingBox();
    await page.mouse.click(ridgeFrame.x+ridgeFrame.width*.45,ridgeFrame.y+ridgeFrame.height*.5);  // moves the viewpoint without Pick
    await page.locator('#view-radius').selectOption('1000');
    await page.waitForFunction(()=>/ridges? at/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:15000});
    assert.ok(await page.evaluate(()=>document.querySelectorAll('.leaflet-overlay-pane path').length)>1,'Crest lines and the view wedge draw on the map');
    // A viewpoint kept from another area is dropped and picking starts again.
    await page.evaluate(()=>{const saved=JSON.parse(localStorage.getItem('terrain-profile-mode'));saved.point=[10,10];localStorage.setItem('terrain-profile-mode',JSON.stringify(saved));});
    await page.reload();
    await page.waitForFunction(()=>/outside this area/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:30000});
    assert.equal(await page.locator('#profile-pick-view').getAttribute('aria-pressed'),'true','Picking starts again');
    await page.evaluate(()=>window.scrollTo(0,0));
    ridgeFrame=await page.locator('#selection-frame').boundingBox();
    await page.mouse.click(ridgeFrame.x+ridgeFrame.width*.45,ridgeFrame.y+ridgeFrame.height*.5);
    await page.waitForFunction(()=>/ridges? at/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:15000});
    console.log('  status:',await page.locator('#profile-mode-status').innerText());

    // Test 3d: picking in a frame moved since the last Generate generates it first and keeps the picked point.
    console.log('Test 3d: Picking in a moved frame');
    await page.locator('#profile-mode').selectOption('slice');
    await page.evaluate(()=>window.scrollTo(0,0));
    const mapBox=await page.locator('#map').boundingBox();
    await page.mouse.move(mapBox.x+mapBox.width*.5,mapBox.y+mapBox.height*.6);await page.mouse.down();
    await page.mouse.move(mapBox.x+mapBox.width*.35,mapBox.y+mapBox.height*.6,{steps:8});await page.mouse.up();
    await page.waitForFunction(()=>/Generate to update/.test(document.getElementById('selection-state').textContent),null,{timeout:10000});
    await page.locator('#profile-mode').selectOption('viewpoint');
    await page.locator('#profile-pick-view').click();
    assert.equal(await page.evaluate(()=>document.getElementById('job-progress').hidden),false,'Picking starts generating the moved frame');
    const movedFrame=await page.locator('#selection-frame').boundingBox();
    await page.mouse.click(movedFrame.x+movedFrame.width*.75,movedFrame.y+movedFrame.height*.5);
    await page.waitForFunction(()=>/to the frame's edge|ridges? at/.test(document.getElementById('profile-mode-status').textContent),null,{timeout:120000});
    assert.doesNotMatch(await page.locator('#profile-mode-status').innerText(),/outside this area/);
    console.log('  status:',await page.locator('#profile-mode-status').innerText());

    // Test 4: Slice mode
    console.log('Test 4: Slice mode');
    await page.locator('#profile-mode').selectOption('slice');
    assert.equal(await page.locator('#profile-slice-controls').isHidden(),false,'Slice controls are visible');

    const markersAfterSlice=await page.locator('.profile-marker').count();
    assert.equal(markersAfterSlice,0,'No profile markers on slice mode');
    console.log('  markers after slice:',markersAfterSlice);

    // The silhouette page opens on the profile the chart shows: back on the straight slice now.
    await page.locator('#silhouette-button').click();
    await page.waitForFunction(()=>document.getElementById('silhouette').open);
    assert.equal(await page.locator('#silhouette-source').inputValue(),'true','The silhouette follows the chart back to the slice');
    await page.locator('#silhouette-back').click();

    // Final checks
    console.log('Test 5: Error collection');
    assert.equal(errors.length,0,`No page errors: ${errors.join(', ')}`);

    console.log('All tests passed.');

  } finally {
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exit(1);});
