/* VR explorer end-to-end test on an emulated Meta Quest 3: run scripts/browser_fixture_server.py (port 8001) first.
 * TERRAIN_PLAYWRIGHT_PATH points at a Playwright package, TERRAIN_IWER_PATH at the IWER WebXR emulator's
 * build/iwer.min.js (npm package "iwer"), and TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const iwer=process.env.TERRAIN_IWER_PATH||require.resolve('iwer/build/iwer.min.js');
const output=path.join(__dirname,'..','test-results');
const near=(actual,expected,tolerance,label)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} is not within ${tolerance} of ${expected}`);

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.TERRAIN_CHROMIUM_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});   // a fake microphone, for voice search
  const page=await browser.newPage({viewport:{width:1400,height:950},permissions:['microphone']});
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
  // Standing, looking down at the table: the box is placed 45° below the line of sight, straight ahead.
  await page.evaluate(()=>{window.xrDevice.position.set(0,1.55,.05);const a=-.75;window.xrDevice.quaternion.set(Math.sin(a/2),0,0,Math.cos(a/2));});
  await page.click('#enter-vr');
  // waitForFunction does not await an async predicate, so keep a synchronous handle on the VR explorer.
  await page.evaluate(async()=>{const vr=await import('/static/vr.js');window.testVR=()=>vr.currentVR();});
  await page.waitForFunction(()=>window.testVR().presenting,null,{timeout:10000});
  await pose('left',[-.4,1,.1]);await pose('right',[.4,1,.1]);
  await page.waitForFunction(()=>window.testVR().state.map.tiles.shown>20,null,{timeout:30000});
  let state=await vrState();
  assert.equal(state.mode,'map','VR starts in Map Selection');
  assert.equal(await page.evaluate(()=>{let lines=0;window.testVR().camera.parent.traverse(o=>{if(o.isLine)lines++;});return lines;}),0,'There are no laser lines');
  const C=state.map.center;
  near(C[1],1.55-.55,.03,'The box sits 55 cm below your eyes');
  near(C[2],.05-.55,.03,'and 55 cm ahead: 45° below your line of sight');
  near(state.map.heading,0,1e-6,'facing you');
  const onTable=x=>[C[0]+x,C[1],C[2]];
  const start=state.pageSelection;
  for(const key of ['north','south','west','east'])assert.ok(Math.abs(state.map.selection[key]-start[key])<1e-6,`The box covers the page's selection (${key})`);
  assert.ok(tileRequests.some(address=>address.includes('opentopomap')),'The map is the topographic style (shading and contours)');
  assert.ok(await viewColors('vr-map.png')>40,'The headset shows the map');

  // Leaning in loads finer tiles near your eyes.
  const deepest=s=>Math.max(...Object.keys(s.map.tiles.zooms).map(Number));
  const far=deepest(state);
  await page.evaluate(C=>window.xrDevice.position.set(C[0],C[1]+.25,C[2]+.12),C);
  await page.waitForFunction(far=>Math.max(...Object.keys(window.testVR().state.map.tiles.zooms).map(Number))>far,far,{timeout:20000});
  await page.evaluate(()=>window.xrDevice.position.set(0,1.55,.05));await frames(6);

  // The map stands in relief: each tile draped over heights from the server, raised by the elevation multiplier.
  await page.waitForFunction(()=>window.testVR().state.map.tiles.relief>10,null,{timeout:60000});
  state=await vrState();
  assert.ok(state.map.tiles.reliefSpan>0,`The relief stands up (${state.map.tiles.reliefSpan} m)`);
  near(state.map.tiles.lift,Number(await page.inputValue('#exaggeration')),1e-9,'at the page\'s elevation multiplier');
  assert.ok(state.map.tiles.triangles<400000,`and stays light enough for the headset (${state.map.tiles.triangles} triangles)`);

  // The watch's menu (more of it below) switches the relief off for a flat map: the precise drag checks run flat.
  // There are no lasers: options are tapped. A controller taps with the dot 6 cm in front of it.
  async function tapWith(hand,id) {
    const point=await page.evaluate(id=>window.testVR().watchPoint(id),id);
    assert.ok(point,`${id} is on show`);
    const rest=hand==='right'?[.3,1.1,-.1]:[-.3,1.1,-.1];
    await pose(hand,[point[0],point[1],point[2]+.12]);await frames(3);    // coming in
    await pose(hand,[point[0],point[1],point[2]+.06]);await frames(3);    // the dot touches it
    await pose(hand,rest);await frames(6);                                // and away
  }
  const press=id=>tapWith('right',id);
  await pose('left',[-.15,1.2,-.3]);await pose('right',[.3,1.1,-.1]);await frames(6);
  await press('watch:face');await press('radial:root:relief');await press('radial:center');
  state=await vrState();
  assert.equal(state.map.relief,false,'Flat map from the watch');
  await page.waitForFunction(()=>window.testVR().state.map.tiles.reliefSpan===0);
  await pose('left',[-.4,1,.1]);await pose('right',[.4,1,.1]);await frames(4);

  // Gripping the map with one hand (here the controller's grip button) moves it with the hand, so the selection
  // moves the other way under the box.
  const metersPerDegree=111320*Math.cos(center(start).y*Math.PI/180);
  state=await vrState();
  await pose('right',[.2,1.1,-.4]);await frames();
  await button('right','squeeze',1);await frames();
  assert.equal((await vrState()).hands[1].mode,'grab','The grip button takes the map');
  for(const x of [.23,.26,.3]){await pose('right',[x,1.1,-.4]);await frames();}
  await button('right','squeeze',0);await frames(6);
  const moved=(await vrState()).pageSelection;
  near((center(moved).x-center(start).x)*metersPerDegree,-.1*state.scale,.1*state.scale*.05,'Dragging the map 10 cm east moves the selection 10 cm of ground west');
  near(center(moved).y,center(start).y,1e-6,'and not north or south');
  near(widthOf(moved),widthOf(start),widthOf(start)*1e-6,'Dragging keeps the size');

  // Both hands: apart zooms in (the box covers less ground), turning turns the selection.
  await pose('left',[-.1,1.1,-.5]);await pose('right',[.1,1.1,-.5]);await frames();
  await button('left','trigger',1);await button('right','trigger',1);await frames();
  await pose('left',[-.2,1.1,-.5]);await pose('right',[.2,1.1,-.5]);await frames();
  // Lifting both hands does not lift the map: it stays at the box's level.
  await pose('left',[-.2,1.3,-.5]);await pose('right',[.2,1.3,-.5]);await frames();
  state=await vrState();near(state.position[1]/state.scale,-C[1],1e-6,'The map never moves up or down');
  await pose('left',[-.2,1.1,-.5]);await pose('right',[.2,1.1,-.5]);await frames();
  await pose('left',[0,1.1,-.3]);await pose('right',[0,1.1,-.7]);await frames();
  await button('left','trigger',0);await button('right','trigger',0);await frames(6);
  const zoomedIn=(await vrState()).pageSelection;
  near(widthOf(zoomedIn)/widthOf(moved),.5,.02,'Hands twice as far apart: the box covers half the ground');
  near(Math.abs(zoomedIn.rotation_deg),90,1,'A quarter turn of the hands turns the selection a quarter turn');
  assert.match(await page.locator('#selection-rotation').innerText(),/90/,'The page\'s own selection is turned too');

  // Relief back on; gripping moves it just the same (the trigger grips too).
  await pose('left',[-.15,1.2,-.3]);await pose('right',[.3,1.1,-.1]);await frames(6);
  await press('watch:face');await press('radial:root:relief');await press('radial:center');
  await page.waitForFunction(()=>window.testVR().state.map.relief&&window.testVR().state.map.tiles.reliefSpan>0,null,{timeout:60000});
  const reliefFrom=(await vrState()).pageSelection;
  await pose('right',[.2,1.1,-.4]);await frames();
  await button('right','trigger',1);await frames();
  for(const x of [.23,.26,.3]){await pose('right',[x,1.1,-.4]);await frames();}
  await button('right','trigger',0);await frames(6);
  const reliefTo=(await vrState()).pageSelection,scaleNow=(await vrState()).scale;
  // The map is turned by now, so check the distance: the 10 cm the hand moved.
  const movedMeters=Math.hypot((center(reliefTo).x-center(reliefFrom).x)*metersPerDegree,(center(reliefTo).y-center(reliefFrom).y)*111320);
  near(movedMeters,.1*scaleNow,.1*scaleNow*.05,'Gripping moves the map over the relief too');

  // The watch on the left controller (the left wrist with hands): tapping its dial opens a large radial menu of the
  // map generator's options in front of you, each one the page's own control, tapped the same way.
  await pose('left',[-.15,1.2,-.3]);await pose('right',[.3,1.1,-.1]);await frames(6);
  assert.ok((await vrState()).watch.face,'The watch is on the left controller');
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
  await press('radial:root:multiplier');assert.equal((await vrState()).watch.menu,'multiplier');
  await press(await item('multiplier','+'));
  near(Number(await page.inputValue('#exaggeration')),multiplier+.1,1e-9,'Multiplier + adds a step to the page\'s multiplier');
  await page.waitForFunction(m=>Math.abs(window.testVR().state.map.tiles.lift-m)<1e-9,multiplier+.1);   // the relief rises with it
  await press('radial:center');assert.equal((await vrState()).watch.menu,'root','The middle goes back');
  // While a menu is up the map stays put: a grip and a sweep leave the selection alone.
  const lockedFrom=(await vrState()).pageSelection;
  await pose('right',[.35,1,-.3]);await frames();await button('right','trigger',1);await frames();
  await pose('right',[.45,1,-.3]);await frames();await button('right','trigger',0);await frames(4);
  assert.deepEqual((await vrState()).pageSelection,lockedFrom,'The map cannot be dragged while the menu is up');
  await pose('right',[.3,1.1,-.1]);await frames();

  // Shape: one editing window floating upright in front of you, for the shape, its proportions, and its turn.
  await press('radial:root:shape');
  state=await vrState();
  assert.ok(state.watch.editor,'Shape opens the editor');assert.equal(state.watch.menu,null);
  await press('editor:shape:circle');
  await page.waitForFunction(()=>window.testVR().state.map.box.shape==='circle');
  assert.equal(await page.inputValue('#selection-shape'),'circle','The page\'s selection is a circle');
  assert.equal((await vrState()).watch.regions.editor.includes('editor:handle:width'),false,'A circle has no width or height handles');
  await press('editor:shape:rectangle');await page.waitForFunction(()=>window.testVR().state.map.box.shape==='rectangle');
  // Aspect presets: 16:9, and the box takes the page's new proportions.
  await press('editor:aspect:16:9');
  await page.waitForFunction(()=>{const b=window.testVR().state.map.box;return Math.abs(b.w/b.h-16/9)<.02;},null,{timeout:5000});
  // Handles: grip one (the controller's dot on it, then the trigger) and drag it in the window: outward from the
  // shape's middle, or for the ring, around it (the shape may already be turned, so directions come from the handle).
  async function dragHandle(name,distance,around=false) {
    const point=await page.evaluate(id=>window.testVR().watchPoint(id),`editor:handle:${name}`);
    assert.ok(point,`The ${name} handle is on show`);
    const middle=await page.evaluate(()=>{const e=window.testVR().state.watch.surfaces['shape editor'];
      // The preview's middle sits a little below the window's center (canvas 690 of 1219, on a 0.5 m tall window).
      const m=e.matrix,up=[m[4],m[5],m[6]];return [m[12]-up[0]*(690/1219-.5)*.5,m[13]-up[1]*(690/1219-.5)*.5,m[14]-up[2]*(690/1219-.5)*.5];});
    let out=[point[0]-middle[0],point[1]-middle[1]];const length=Math.hypot(...out);out=out.map(v=>v/length);
    if(around)out=[out[1],-out[0]];
    const [dx,dy]=out.map(v=>v*distance);
    const at=[point[0],point[1],point[2]+.06];
    await pose('right',at);await frames(3);
    await button('right','trigger',1);await frames();
    assert.equal((await vrState()).watch.editor.dragging,name,`Gripping the ${name} handle takes it`);
    for(const t of [.33,.66,1]){await pose('right',[at[0]+dx*t,at[1]+dy*t,at[2]]);await frames();}
    await button('right','trigger',0);await frames(6);
    await pose('right',[.3,1.1,-.1]);await frames(4);
  }
  const ratioOf=b=>(b.east-b.west)/(b.north-b.south);
  const wideFrom=ratioOf((await vrState()).pageSelection);
  await dragHandle('width',.05);
  assert.ok(ratioOf((await vrState()).pageSelection)>wideFrom*1.2,'Dragging the side handle out makes the selection wider');
  const before16=(await vrState()).watch.editor.ratio;
  await dragHandle('height',.04);
  assert.ok((await vrState()).watch.editor.ratio<before16*.9,'Dragging the top handle up makes it taller');
  const angleFrom=(await vrState()).watch.editor.angle;
  await dragHandle('rotate',.06,true);
  state=await vrState();
  assert.ok(Math.abs(state.watch.editor.angle-angleFrom)>=10,`The ring turns the shape (${angleFrom}° to ${state.watch.editor.angle}°)`);
  near(state.pageSelection.rotation_deg,state.watch.editor.angle,.11,'and the page\'s selection with it');
  await page.waitForFunction(a=>Math.abs(window.testVR().state.map.selection.rotation_deg-a)<.11,state.watch.editor.angle);   // and the map under the box
  // OK returns to the menu.
  await press('editor:ok');
  state=await vrState();
  assert.equal(state.watch.editor,null);assert.equal(state.watch.menu,'root','OK returns to the menu');
  // Map features: the first switch is the page's own checkbox.
  await press('radial:root:features');
  const firstFeature=await page.evaluate(()=>[...document.querySelectorAll('#style-editor input[type=checkbox][id^="feature-"]')].filter(el=>!el.closest('[hidden]'))[0].id);
  const wasOn=await page.isChecked(`#${firstFeature}`);
  await press('radial:features:0');
  assert.equal(await page.isChecked(`#${firstFeature}`),!wasOn,'A feature switch toggles the page\'s checkbox');
  await press('radial:center');
  // Elevation source.
  await press('radial:root:source');await press(await item('source','usgs3dep'));
  assert.equal(await page.inputValue('#elevation-source'),'usgs3dep','Source chosen from the watch');
  await press(await item('source','mapzen'));await press('radial:center');
  // Search: a keyboard; coordinates (or an address or ZIP) move the map there.
  await press('radial:root:search');
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
  // Voice search: Speak records from the microphone, Stop sends 16 kHz samples to the computer, and the words heard
  // fill the box (the computer's speech recognition is stood in for here; tests/test_live.py covers the server).
  let heard=null;
  await page.route('**/api/transcribe',route=>{heard=route.request().postDataJSON();route.fulfill({json:{text:'Roan Mountain, Tennessee'}});});
  await press('watch:face');await press('radial:root:search');
  await press('key:voice');
  await page.waitForFunction(()=>window.testVR().state.watch.voice==='listening',null,{timeout:10000});
  await page.waitForTimeout(800);
  await press('key:voice');
  await page.waitForFunction(()=>window.testVR().state.watch.text==='Roan Mountain, Tennessee',null,{timeout:10000});
  assert.equal(heard.rate,16000,'The recording is sent as 16 kHz samples');
  assert.ok(Buffer.from(heard.samples,'base64').length>16000*2*.3,`of what was said (${Buffer.from(heard.samples,'base64').length/32000} s)`);
  assert.equal((await vrState()).watch.voice,'idle');
  await press('key:cancel');await page.unroute('**/api/transcribe');
  await press('watch:face');assert.equal((await vrState()).watch.menu,'root','The watch opens the menu again');
  await press('watch:face');assert.equal((await vrState()).watch.menu,null,'and tapping it again closes it');

  // The right wrist (here the right controller) has Generate: the box's area is generated, then shown as the model.
  const pressWrist=()=>tapWith('left','wrist:button');   // tapped with the other hand
  await pose('right',[.15,1.2,-.3]);await pose('left',[-.3,1.1,-.1]);await frames(6);
  assert.equal((await vrState()).watch.buttonLabel,'Generate');
  const generatedFrom=await page.locator('#scene-detail').innerText();
  await pressWrist();
  await page.waitForFunction(()=>window.testVR().state.mode==='model',null,{timeout:120000});
  assert.notEqual(await page.locator('#scene-detail').innerText(),generatedFrom,'The box\'s area was generated');
  const turnedTo=Math.round(Math.abs((await vrState()).pageSelection.rotation_deg||0));
  assert.match(await page.locator('#scene-detail').innerText(),new RegExp(`${turnedTo}° selection`),'with the turned selection');
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
  await page.evaluate(()=>{const turn=Math.PI/4;window.xrDevice.quaternion.set(0,Math.sin(turn),0,Math.cos(turn));});   // now facing left
  await pressWrist();
  state=await vrState();
  assert.equal(state.mode,'map','◀ Map returns to Map Selection');
  near(state.map.heading,Math.PI/2,1e-3,'The box is placed in front of you again, wherever you face');
  near(state.map.center[0],-.55,.03,'(a quarter turn to the left puts it to the left)');
  await page.evaluate(()=>{const a=-.75;window.xrDevice.quaternion.set(Math.sin(a/2),0,0,Math.cos(a/2));});

  // Nothing can be saved from VR: an export started anyway writes nothing.
  const downloads=[];page.on('download',d=>downloads.push(d));
  await page.evaluate(()=>document.querySelector('[data-export="stl"]')?.click());
  await page.waitForTimeout(3000);
  assert.equal(downloads.length,0,'No file is downloaded while in VR');
  assert.equal((await page.request.post(`${url}/api/saved?filename=t.stl`,{data:{model:'solid'}})).status(),404,'The server has no save endpoint');

  // Leaving VR returns to the page.
  await page.screenshot({path:path.join(output,'vr-page.png')});
  await pose('left',[-.15,1.2,-.3]);await pose('right',[.3,1.1,-.1]);await frames(6);
  await press('watch:face');await press('radial:root:exit');   // Exit VR, on the watch
  await page.waitForFunction(()=>!window.testVR().presenting,null,{timeout:5000});
  const left=await vrState();
  assert.equal(left.tiles,0,'The VR tiles are gone after leaving VR');
  assert.equal(left.surfaceHidden,false,'The page shows its own surface again');
  assert.deepEqual(errors,[],`No page errors: ${errors.join('; ')}`);
  await browser.close();
  console.log('VR browser test passed.');
})().catch(error=>{console.error(error);process.exit(1);});
