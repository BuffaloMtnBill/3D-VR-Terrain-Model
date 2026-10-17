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
  // Every map tile is the same small fixture image, so tiles load (and are counted) without the internet.
  const tile=await fs.readFile(path.join(__dirname,'fixtures','map-tile.png'));
  const tileRequests=[];
  await page.route(/tile\.(opentopomap|openstreetmap)\.org/,route=>{tileRequests.push(route.request().url());route.fulfill({status:200,contentType:'image/png',body:tile,headers:{'Access-Control-Allow-Origin':'*'}});});
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
  // Point a controller from where it is at a point in the room.
  const aimAt=(hand,from,target)=>page.evaluate(async([hand,from,target])=>{
    const THREE=await import('three'),direction=new THREE.Vector3(...target).sub(new THREE.Vector3(...from)).normalize();
    const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),direction);
    const controller=window.xrDevice.controllers[hand];controller.position.set(...from);controller.quaternion.set(q.x,q.y,q.z,q.w);
  },[hand,from,target]);
  const center=s=>({x:(s.west+s.east)/2,y:(s.north+s.south)/2});
  const widthOf=s=>s.east-s.west;
  // Pixel variety in the headset's view, to tell a drawn scene from an empty sky.
  async function viewColors(name) {
    const file=path.join(output,name);await page.screenshot({path:file,clip:{x:380,y:300,width:640,height:350}});
    return page.evaluate(async src=>{const image=new Image();image.src=src;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
      const x=c.getContext('2d');x.drawImage(image,0,0);const data=x.getImageData(0,0,c.width,c.height).data,seen=new Set();
      for(let i=0;i<data.length;i+=16)seen.add((data[i]>>3)<<10|(data[i+1]>>3)<<5|data[i+2]>>3);return seen.size;},
      `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`);
  }

  // Enter VR: it starts in Map Selection, the page's map and selection box on the table.
  assert.equal(await page.isVisible('#enter-vr'),true,'The VR button shows when WebXR is available');
  await page.click('#enter-vr');
  // waitForFunction does not await an async predicate, so keep a synchronous handle on the VR explorer.
  await page.evaluate(async()=>{const vr=await import('/static/vr.js');window.testVR=()=>vr.currentVR();});
  await page.waitForFunction(()=>window.testVR().presenting,null,{timeout:10000});
  await page.evaluate(()=>{window.xrDevice.position.set(0,1.55,.05);const a=-.75;window.xrDevice.quaternion.set(Math.sin(a/2),0,0,Math.cos(a/2));});
  await pose('left',[-.4,1,.1]);await pose('right',[.4,1,.1]);
  await page.waitForFunction(()=>window.testVR().state.map.tiles.shown>20,null,{timeout:30000});
  let state=await vrState();
  assert.equal(state.mode,'map','VR starts in Map Selection');
  const start=state.pageSelection;
  for(const key of ['north','south','west','east'])assert.ok(Math.abs(state.map.selection[key]-start[key])<1e-6,`The box covers the page's selection (${key})`);
  assert.ok(tileRequests.some(address=>address.includes('opentopomap')),'The map is the topographic style (shading and contours)');
  assert.ok(await viewColors('vr-map.png')>40,'The headset shows the map');

  // Leaning in loads finer tiles near your eyes.
  const deepest=s=>Math.max(...Object.keys(s.map.tiles.zooms).map(Number));
  const far=deepest(state);
  await page.evaluate(()=>window.xrDevice.position.set(0,.95,-.5));
  await page.waitForFunction(far=>Math.max(...Object.keys(window.testVR().state.map.tiles.zooms).map(Number))>far,far,{timeout:20000});
  await page.evaluate(()=>window.xrDevice.position.set(0,1.55,.05));await frames(6);

  // Dragging the map with the ray: the map moves under the box, so the selection moves the other way.
  const metersPerDegree=111320*Math.cos(center(start).y*Math.PI/180);
  state=await vrState();
  await aimAt('right',[.25,1.2,-.3],[0,.75,-.8]);await frames();
  await button('right','trigger',1);await frames();
  assert.equal((await vrState()).hands[1].mode,'pan','Pointing at the map and pulling the trigger takes the map');
  for(const x of [.03,.06,.1]){await aimAt('right',[.25,1.2,-.3],[x,.75,-.8]);await frames();}
  await button('right','trigger',0);await frames(6);
  const moved=(await vrState()).pageSelection;
  near((center(moved).x-center(start).x)*metersPerDegree,-.1*state.scale,.1*state.scale*.05,'Dragging the map 10 cm east moves the selection 10 cm of ground west');
  near(center(moved).y,center(start).y,1e-6,'and not north or south');
  near(widthOf(moved),widthOf(start),widthOf(start)*1e-6,'Dragging keeps the size');

  // Both hands: apart zooms in (the box covers less ground), turning turns the selection.
  await pose('left',[-.1,1.1,-.5]);await pose('right',[.1,1.1,-.5]);await frames();
  await button('left','trigger',1);await button('right','trigger',1);await frames();
  await pose('left',[-.2,1.1,-.5]);await pose('right',[.2,1.1,-.5]);await frames();
  await pose('left',[0,1.1,-.3]);await pose('right',[0,1.1,-.7]);await frames();
  await button('left','trigger',0);await button('right','trigger',0);await frames(6);
  const zoomedIn=(await vrState()).pageSelection;
  near(widthOf(zoomedIn)/widthOf(moved),.5,.02,'Hands twice as far apart: the box covers half the ground');
  near(Math.abs(zoomedIn.rotation_deg),90,1,'A quarter turn of the hands turns the selection a quarter turn');
  assert.match(await page.locator('#selection-rotation').innerText(),/90/,'The page\'s own selection is turned too');

  // The watch on the left controller (the left wrist with hands): pointing at it and pulling the trigger opens a
  // radial menu of the map generator's options, each one the page's own control.
  await pose('left',[-.15,1.2,-.3]);await pose('right',[.3,1.1,-.1]);await frames(6);
  assert.ok((await vrState()).watch.face,'The watch is on the left controller');
  async function press(id) {
    const point=await page.evaluate(id=>window.testVR().watchPoint(id),id);
    assert.ok(point,`${id} is on show`);
    await aimAt('right',[.12,1.42,.05],point);await frames();
    await button('right','trigger',1);await frames();await button('right','trigger',0);await frames(6);
  }
  await press('watch:face');
  assert.equal((await vrState()).watch.menu,'root','The watch opens the radial menu');
  const item=async(menu,label)=>{   // a menu's segment by its label, read from the page's own control
    const ids=(await vrState()).watch.regions.radial;
    const labels={multiplier:['−−','−','+','++']}[menu];
    const index=labels?labels.indexOf(label):await page.evaluate(([menu,label])=>{
      const select={source:'elevation-source',detail:'resolution',profile:'relief-method',shape:'selection-shape'}[menu];
      if(select)return [...document.getElementById(select).options].filter(o=>!o.disabled&&!o.hidden&&o.value!=='custom').findIndex(o=>o.value===label);
      if(menu==='aspect')return [...document.querySelectorAll('[data-aspect]')].findIndex(b=>b.dataset.aspect===label);
      return -1;},[menu,label]);
    assert.ok(index>=0&&ids.includes(`radial:${menu}:${index}`),`${menu} has ${label}`);
    return `radial:${menu}:${index}`;
  };
  // Elevation multiplier: + adds one step.
  const multiplier=Number(await page.inputValue('#exaggeration'));
  await press('radial:root:4');assert.equal((await vrState()).watch.menu,'multiplier');
  await press(await item('multiplier','+'));
  near(Number(await page.inputValue('#exaggeration')),multiplier+.1,1e-9,'Multiplier + adds a step to the page\'s multiplier');
  await press('radial:center');assert.equal((await vrState()).watch.menu,'root','The middle goes back');
  // Shape: a circle, then a rectangle again; the box on the table changes with it.
  await press('radial:root:6');await press(await item('shape','circle'));
  await page.waitForFunction(()=>window.testVR().state.map.box.shape==='circle');
  assert.equal(await page.inputValue('#selection-shape'),'circle','The page\'s selection is a circle');
  await press(await item('shape','rectangle'));await page.waitForFunction(()=>window.testVR().state.map.box.shape==='rectangle');
  await press('radial:center');
  // Aspect ratio 16:9: the box takes the page's new proportions.
  await press('radial:root:7');await press(await item('aspect','16:9'));
  await page.waitForFunction(()=>{const b=window.testVR().state.map.box;return Math.abs(b.w/b.h-16/9)<.02;},null,{timeout:5000});
  await press('radial:center');
  // Map features: the first switch is the page's own checkbox.
  await press('radial:root:8');
  const firstFeature=await page.evaluate(()=>[...document.querySelectorAll('#style-editor input[type=checkbox][id^="feature-"]')].filter(el=>!el.closest('[hidden]'))[0].id);
  const wasOn=await page.isChecked(`#${firstFeature}`);
  await press('radial:features:0');
  assert.equal(await page.isChecked(`#${firstFeature}`),!wasOn,'A feature switch toggles the page\'s checkbox');
  await press('radial:center');
  // Elevation source.
  await press('radial:root:1');await press(await item('source','usgs3dep'));
  assert.equal(await page.inputValue('#elevation-source'),'usgs3dep','Source chosen from the watch');
  await press(await item('source','mapzen'));await press('radial:center');
  // Search: a keyboard; coordinates (or an address or ZIP) move the map there.
  await press('radial:root:0');
  assert.equal((await vrState()).watch.keyboard,true,'Search opens the keyboard');
  for(const key of [...'36.2','space','-',...'81.9'])await press(`key:${key===' '?'space':key}`);
  assert.equal((await vrState()).watch.text.endsWith('36.2 -81.9'),true,'The keys type');
  await press('key:search');
  await page.waitForFunction(()=>{const s=window.testVR().state.pageSelection;return Math.abs((s.north+s.south)/2-36.2)<.05&&Math.abs((s.west+s.east)/2+81.9)<.05;},null,{timeout:10000});
  await frames(6);
  const found=(await vrState()).map.selection;
  near((found.north+found.south)/2,36.2,.05,'The map moved to the search: the box is over it');
  state=await vrState();
  assert.equal(state.watch.keyboard,false,'Searching puts the keyboard away');
  await press('watch:face');assert.equal((await vrState()).watch.menu,'root','The watch opens the menu again');
  await press('watch:face');assert.equal((await vrState()).watch.menu,null,'and tapping it again closes it');

  // The right wrist (here the right controller) has Generate: the box's area is generated, then shown as the model.
  async function pressWrist() {
    const point=await page.evaluate(()=>window.testVR().watchPoint('wrist:button'));
    assert.ok(point,'The wrist button is on show');
    await aimAt('left',[-.12,1.42,.05],point);await frames();
    await button('left','trigger',1);await frames();await button('left','trigger',0);await frames(6);
  }
  await pose('right',[.15,1.2,-.3]);await pose('left',[-.3,1.1,-.1]);await frames(6);
  assert.equal((await vrState()).watch.buttonLabel,'Generate');
  const generatedFrom=await page.locator('#scene-detail').innerText();
  await pressWrist();
  await page.waitForFunction(()=>window.testVR().state.mode==='model',null,{timeout:120000});
  assert.notEqual(await page.locator('#scene-detail').innerText(),generatedFrom,'The box\'s area was generated');
  assert.match(await page.locator('#scene-detail').innerText(),/90° selection/,'with the turned selection');
  await frames(10);
  state=await vrState();
  assert.equal(state.mode,'model');
  near(state.scale,6.4,.01,'Initial world units per room meter (a 6.4-unit model shown 1 m wide)');
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

  // Back to the map from the right wrist.
  await pose('right',[.15,1.2,-.3]);await pose('left',[-.3,1.1,-.1]);await frames(6);
  assert.equal((await vrState()).watch.buttonLabel,'◀ Map');
  await pressWrist();
  assert.equal((await vrState()).mode,'map','◀ Map returns to Map Selection');

  // Nothing can be saved from VR: an export started anyway writes nothing.
  const downloads=[];page.on('download',d=>downloads.push(d));
  await page.evaluate(()=>document.querySelector('[data-export="stl"]')?.click());
  await page.waitForTimeout(3000);
  assert.equal(downloads.length,0,'No file is downloaded while in VR');
  assert.equal((await page.request.post(`${url}/api/saved?filename=t.stl`,{data:{model:'solid'}})).status(),404,'The server has no save endpoint');

  // Leaving VR returns to the page.
  await page.screenshot({path:path.join(output,'vr-page.png')});
  await pose('left',[-.15,1.2,-.3]);await pose('right',[.3,1.1,-.1]);await frames(6);
  await press('watch:face');await press('radial:root:9');   // Exit VR, on the watch
  await page.waitForFunction(()=>!window.testVR().presenting,null,{timeout:5000});
  const left=await vrState();
  assert.equal(left.tiles,0,'The VR tiles are gone after leaving VR');
  assert.equal(left.surfaceHidden,false,'The page shows its own surface again');
  assert.deepEqual(errors,[],`No page errors: ${errors.join('; ')}`);
  await browser.close();
  console.log('VR browser test passed.');
})().catch(error=>{console.error(error);process.exit(1);});
