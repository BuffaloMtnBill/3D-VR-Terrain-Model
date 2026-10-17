/* VR explorer end-to-end test on an emulated Meta Quest 3: run scripts/browser_fixture_server.py (port 8001) first.
 * TERRAIN_PLAYWRIGHT_PATH points at a Playwright package, TERRAIN_IWER_PATH at the IWER WebXR emulator's
 * build/iwer.min.js (npm package "iwer"), and TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const iwer=process.env.TERRAIN_IWER_PATH||require.resolve('iwer/build/iwer.min.js');
const output=path.join(__dirname,'..','test-results');
const near=(actual,expected,tolerance,label)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} is not within ${tolerance} of ${expected}`);

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.TERRAIN_CHROMIUM_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(/tile\.(opentopomap|openstreetmap)\.org/,route=>route.fulfill({status:404,body:''}));
  await page.route(/overpass|nominatim|3dhp/,route=>route.fulfill({status:503,body:'{}'}));
  await page.addInitScript({content:`${await fs.readFile(iwer,'utf8')}
    window.xrDevice=new IWER.XRDevice(IWER.metaQuest3);window.xrDevice.installRuntime({forceInstall:true});`});
  await page.goto(url);
  await page.waitForFunction(()=>/points/.test(document.getElementById('scene-detail').textContent),null,{timeout:30000});

  const vrState=()=>page.evaluate(async()=>(await import('/static/vr.js')).currentVR().state);
  const frames=(count=4)=>page.waitForTimeout(count*45);
  const pose=(hand,position,quaternion=[0,0,0,1])=>page.evaluate(([hand,position,quaternion])=>{
    const controller=window.xrDevice.controllers[hand];controller.position.set(...position);controller.quaternion.set(...quaternion);
  },[hand,position,quaternion]);
  const button=(hand,name,value)=>page.evaluate(([hand,name,value])=>window.xrDevice.controllers[hand].updateButtonValue(name,value),[hand,name,value]);
  const stick=(hand,x,y)=>page.evaluate(([hand,x,y])=>window.xrDevice.controllers[hand].updateAxes('thumbstick',x,y),[hand,x,y]);
  // Aim a controller at a menu region from 35 cm in front of the panel; `along` picks a point across it (sliders).
  async function aim(hand,pattern,along=.5) {
    await page.evaluate(async([hand,pattern,along])=>{
      const THREE=await import('three'),state=(await import('/static/vr.js')).currentVR().state;
      const region=state.regions.find(r=>new RegExp(pattern).test(r.id));
      if(!region)throw new Error(`No menu region matches ${pattern}: ${state.regions.map(r=>r.id).join(', ')}`);
      const matrix=new THREE.Matrix4().fromArray(state.panel);
      const target=new THREE.Vector3(((region.x+region.w*along)/1024-.5)*.62,(.5-(region.y+region.h/2)/1536)*.93,0).applyMatrix4(matrix);
      const origin=target.clone().addScaledVector(new THREE.Vector3(0,0,1).transformDirection(matrix),.35);
      const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),target.clone().sub(origin).normalize());
      const controller=window.xrDevice.controllers[hand];
      controller.position.set(origin.x,origin.y,origin.z);controller.quaternion.set(rotation.x,rotation.y,rotation.z,rotation.w);
    },[hand,pattern,along]);
    await frames();
  }
  async function click(hand,pattern,along) {
    await aim(hand,pattern,along);
    await button(hand,'trigger',1);await frames();await button(hand,'trigger',0);await frames(8);
  }

  // Enter VR: the model starts as a 1 m tabletop model in front of you.
  assert.equal(await page.isVisible('#enter-vr'),true,'The VR button shows when WebXR is available');
  await page.click('#enter-vr');
  // waitForFunction does not await an async predicate, so keep a synchronous handle on the VR explorer.
  await page.evaluate(async()=>{const vr=await import('/static/vr.js');window.testVR=()=>vr.currentVR();});
  await page.waitForFunction(()=>window.testVR().presenting,null,{timeout:10000});
  await frames(10);
  // The ground map's tiles load in the first moments; wait for them so the timed flights below run at an even frame rate.
  await page.waitForFunction(()=>window.testVR().state.ground.layers.length===2,null,{timeout:30000});
  await frames(10);
  let state=await vrState();
  assert.equal(state.ground.parent,'Scene','The model sits on the ground map');
  near(state.scale,6.4,.01,'Initial world units per room meter (a 6.4-unit model shown 1 m wide)');
  assert.equal(state.menuOpen,false);
  // In VR the surface is drawn as tiles, so ground out of view is skipped; together they hold every triangle.
  const surfaceTriangles=await page.evaluate(()=>{const vr=document.getElementById('scene-detail').textContent.match(/([\d,]+) surface faces/);return Number(vr[1].replace(/,/g,''));});
  assert.ok(state.tiles>1,`The surface is tiled in VR (${state.tiles} tiles)`);
  assert.equal(state.tileTriangles,surfaceTriangles,'The tiles hold the whole surface');
  assert.equal(state.surfaceHidden,true,'The single page mesh is not drawn twice');

  // The live link drops (a headset going to sleep) and comes back by itself.
  await page.waitForFunction(()=>document.getElementById('live-status').textContent.trim()==='LIVE');
  await page.evaluate(async()=>(await import('/static/vr.js')).currentVR().live.drop());
  await page.waitForFunction(()=>/RECONNECTING/.test(document.getElementById('live-status').textContent));
  await page.waitForFunction(()=>document.getElementById('live-status').textContent.trim()==='LIVE',null,{timeout:10000});

  // Flying: full stick forward moves where the hand points (-Z here), at the same room speed at any zoom.
  // Speeds are per second of flying as the headset counts it (its frame times), not the test's wall clock, so a
  // slow software renderer dropping frames does not change them.
  async function flight() {
    const start=await vrState(),before=start.position;
    await stick('right',0,-1);await page.waitForTimeout(600);await stick('right',0,0);await frames();
    const after=await vrState();
    return {dx:after.position[0]-before[0],dz:after.position[2]-before[2],scale:after.scale,seconds:after.flownSeconds-start.flownSeconds};
  }
  await pose('right',[.2,1.2,-.3]);await pose('left',[-.2,1.2,-.3]);await frames();
  const first=await flight();
  assert.ok(first.dz<-.5,`Stick forward moves toward -Z (${first.dz})`);
  near(first.dx,0,Math.abs(first.dz)*.05,'No sideways drift');

  // Two hands: pulling apart zooms in (the world grows), twisting turns it.
  await pose('left',[-.1,1.2,-.4]);await pose('right',[.1,1.2,-.4]);await frames();
  const beforeZoom=await vrState();
  await button('left','trigger',1);await button('right','trigger',1);await frames();
  await pose('left',[-.2,1.2,-.4]);await pose('right',[.2,1.2,-.4]);await frames();
  let zoomed=await vrState();
  near(zoomed.scale,beforeZoom.scale/2,beforeZoom.scale*.02,'Hands twice as far apart: world twice as large');
  await pose('left',[0,1.2,-.2]);await pose('right',[0,1.2,-.6]);await frames();
  const turned=await vrState();
  near(Math.abs(turned.yaw-zoomed.yaw),Math.PI/2,.02,'A quarter turn of the hands turns the world a quarter turn');
  near(turned.scale,zoomed.scale,zoomed.scale*.02,'Turning keeps the zoom');
  await pose('left',[-.05,1.2,-.4]);await pose('right',[.05,1.2,-.4]);await frames();
  zoomed=await vrState();
  near(zoomed.scale,beforeZoom.scale*2,beforeZoom.scale*.04,'Hands together zoom out');
  await button('left','trigger',0);await button('right','trigger',0);await frames();

  // At a different zoom, the same stick time covers ground in proportion to the zoom.
  await pose('right',[.2,1.2,-.3],[0,0,0,1]);await frames();
  const second=await flight();
  const firstRate=Math.hypot(first.dx,first.dz)/first.scale/first.seconds,secondRate=Math.hypot(second.dx,second.dz)/second.scale/second.seconds;
  near(secondRate/firstRate,1,.05,`Room speed is the same at ${second.scale.toFixed(2)} and ${first.scale.toFixed(2)} units per meter`);

  // A / X opens the menu in front of you.
  await button('right','a-button',1);await frames();await button('right','a-button',0);await frames(8);
  state=await vrState();
  assert.equal(state.menuOpen,true,'A opens the menu');

  // Map layers: the menu's switches are the page's own checkboxes.
  await click('right','^tab:layers$');
  assert.equal((await vrState()).menuTab,'layers');
  assert.equal(await page.isChecked('#feature-railways'),false);
  await click('right','^layers:feature-railways$');
  assert.equal(await page.isChecked('#feature-railways'),true,'Train tracks switched on from VR');
  await page.screenshot({path:path.join(output,'vr-page.png')});

  // Terrain: the elevation multiplier slider and the View buttons.
  await click('right','^tab:terrain$');
  const before=Number(await page.inputValue('#exaggeration'));
  await click('right','^terrain:exaggeration$',.75);
  const after=Number(await page.inputValue('#exaggeration'));
  assert.ok(Math.abs(after-(.1+.75*11.9))<.3,`Slider at 75% sets about ${(.1+.75*11.9).toFixed(1)}× (was ${before}, now ${after})`);
  assert.equal(await page.textContent('#exaggeration-value'),`${after.toFixed(1)}×`);
  await click('right','^terrain:segment\\d+:2$');
  assert.equal(await page.getAttribute('[data-view="wireframe"]','aria-pressed'),'true','Wireframe chosen from VR');
  await click('right','^terrain:segment\\d+:0$');

  // Nothing can be saved from VR: the menu has no Save tab, and an export started anyway writes nothing.
  assert.ok(!(await vrState()).regions.some(r=>r.id==='tab:save'),'The VR menu has no Save tab');
  const downloads=[];page.on('download',d=>downloads.push(d));
  await page.evaluate(()=>document.querySelector('[data-export="stl"]')?.click());
  await page.waitForTimeout(3000);
  assert.equal(downloads.length,0,'No file is downloaded while in VR');
  assert.equal((await page.request.post(`${url}/api/saved?filename=t.stl`,{data:{model:'solid'}})).status(),404,'The server has no save endpoint');

  // Reset view puts the tabletop model back; Exit VR returns to the page.
  await click('right','^reset-view$');
  near((await vrState()).scale,6.4,.01,'Reset view');
  await click('right','^exit-vr$');
  await page.waitForFunction(()=>!window.testVR().presenting,null,{timeout:5000});
  const left=await vrState();
  assert.equal(left.tiles,0,'The VR tiles are gone after leaving VR');
  assert.equal(left.surfaceHidden,false,'The page shows its own surface again');
  assert.deepEqual(errors,[],`No page errors: ${errors.join('; ')}`);
  await browser.close();
  console.log('VR browser test passed.');
})().catch(error=>{console.error(error);process.exit(1);});
