/* Hand-tracking VR on an emulated Meta Quest 3, with a second page standing in for the computer.
 * Run scripts/browser_fixture_server.py (port 8001) first. TERRAIN_PLAYWRIGHT_PATH points at a Playwright package,
 * TERRAIN_IWER_PATH at the IWER emulator's build/iwer.min.js, and TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 * The surroundings of the cut are real elevation downloads (through the fixture server's normal tile cache).
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const iwer=process.env.TERRAIN_IWER_PATH||require.resolve('iwer/build/iwer.min.js');
const output=path.join(__dirname,'..','test-results');
const near=(actual,expected,tolerance,label)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} is not within ${tolerance} of ${expected}`);
const PALM_TOWARD_YOU=[-Math.SQRT1_2,0,0,Math.SQRT1_2];   // fingers up, palm facing the eyes

async function openPage(browser,headset) {
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
  await page.route(/tile\.(opentopomap|openstreetmap)\.org/,route=>route.fulfill({status:404,body:''}));
  await page.route(/overpass|nominatim|3dhp/,route=>route.fulfill({status:503,body:'{}'}));
  if(headset)await page.addInitScript({content:`${await fs.readFile(iwer,'utf8')}
    window.xrDevice=new IWER.XRDevice(IWER.metaQuest3);window.xrDevice.installRuntime({forceInstall:true});window.xrDevice.primaryInputMode='hand';`});
  await page.goto(url);
  await page.waitForFunction(()=>/points/.test(document.getElementById('scene-detail').textContent),null,{timeout:30000});
  await page.waitForFunction(()=>document.getElementById('live-status').textContent.trim()==='LIVE');
  return page;
}

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.TERRAIN_CHROMIUM_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const computer=await openPage(browser,false);
  const page=await openPage(browser,true);

  const vrState=()=>page.evaluate(async()=>(await import('/static/vr.js')).currentVR().state);
  // waitForFunction does not await an async predicate (a pending promise counts as true), so poll the VR state here.
  async function until(test,timeout,label) {
    const end=Date.now()+timeout;
    for(;;){const state=await vrState();if(test(state))return state;if(Date.now()>end)throw new Error(`Timed out: ${label} (${JSON.stringify(state.cut)})`);await page.waitForTimeout(150);}
  }
  const frames=(count=4)=>page.waitForTimeout(count*45);
  const place=(hand,position,quaternion=[0,0,0,1])=>page.evaluate(([hand,position,quaternion])=>{
    const h=window.xrDevice.hands[hand];h.position.set(...position);h.quaternion.set(...quaternion);},[hand,position,quaternion]);
  const pinch=(hand,value)=>page.evaluate(([hand,value])=>window.xrDevice.hands[hand].updatePinchValue(value),[hand,value]);
  const handIndex={left:0,right:1};
  const handPosition=hand=>page.evaluate(hand=>{const p=window.xrDevice.hands[hand].position.vec3;return [p[0],p[1],p[2]];},hand);
  // Point a hand's ray at a menu region from 35 cm in front of the panel, then pinch and release.
  async function aim(hand,pattern) {
    await page.evaluate(async([hand,pattern])=>{
      const THREE=await import('three'),state=(await import('/static/vr.js')).currentVR().state;
      const region=state.regions.find(r=>new RegExp(pattern).test(r.id));
      if(!region)throw new Error(`No menu region matches ${pattern}: ${state.regions.map(r=>r.id).join(', ')}`);
      const matrix=new THREE.Matrix4().fromArray(state.panel);
      const target=new THREE.Vector3(((region.x+region.w/2)/1024-.5)*.62,(.5-(region.y+region.h/2)/1536)*.93,0).applyMatrix4(matrix);
      const origin=target.clone().addScaledVector(new THREE.Vector3(0,0,1).transformDirection(matrix),.35);
      const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),target.clone().sub(origin).normalize());
      const h=window.xrDevice.hands[hand];h.position.set(origin.x,origin.y,origin.z);h.quaternion.set(rotation.x,rotation.y,rotation.z,rotation.w);
    },[hand,pattern]);
    await frames();
  }
  async function tap(hand,pattern){await aim(hand,pattern);await pinch(hand,1);await frames();await pinch(hand,0);await frames(8);}
  // Move a hand so its pinch point (between thumb and index tips, pinched) lands on a room point.
  let pinchOffset=null;
  async function pinchAt(hand,room) {
    await place(hand,room.map((value,i)=>value-pinchOffset[i]),[0,0,0,1]);await frames();
  }
  const toRoom=(state,world)=>{
    const d=world.map((value,i)=>(value-state.position[i])/state.scale),c=Math.cos(-state.yaw),s=Math.sin(-state.yaw);
    return [d[0]*c+d[2]*s,d[1],-d[0]*s+d[2]*c];
  };

  // Enter VR with hands: both are tracked and drawn; no controller is involved.
  await page.click('#enter-vr');
  let state=await until(s=>s.hands.every(hand=>hand.tracked),10000,'entering VR with tracked hands');
  assert.deepEqual(state.hands.map(hand=>hand.tracked),[true,true],'Both hands are tracked');
  // Drawn as the outlined hand model (from static/vendor/hands), not joint dots.
  state=await until(s=>s.hands.every(hand=>hand.model),15000,'the hand models to load');

  // A pinch in open air grabs the world, and moving the pinched hand drags it.
  await place('right',[.25,1.3,-.35]);await frames();
  await pinch('right',1);await frames();
  state=await vrState();
  assert.equal(state.hands[1].mode,'grab','A pinch grabs the world');
  pinchOffset=state.hands[1].point.map((value,i)=>value-[.25,1.3,-.35][i]);
  const before=state.position;
  await place('right',[.35,1.3,-.35]);await frames();
  state=await vrState();
  near(state.position[0]-before[0],-.1*state.scale,.01*state.scale,'Dragging the pinch moves the world with the hand');
  await pinch('right',0);await frames();
  assert.equal((await vrState()).hands[1].mode,null,'Opening the fingers lets go');

  // Map Selection with hands: point at the map, pinch, and sweep the ray to drag the map under the box.
  assert.equal((await vrState()).mode,'map','VR starts in Map Selection');
  const aimHand=(hand,from,target)=>page.evaluate(async([hand,from,target])=>{
    const THREE=await import('three'),direction=new THREE.Vector3(...target).sub(new THREE.Vector3(...from)).normalize();
    const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),direction);
    const h=window.xrDevice.hands[hand];h.position.set(...from);h.quaternion.set(q.x,q.y,q.z,q.w);
  },[hand,from,target]);
  const startSelection=(await vrState()).pageSelection;
  await aimHand('right',[.25,1.2,-.3],[0,.75,-.8]);await frames();
  await pinch('right',1);await frames();
  assert.equal((await vrState()).hands[1].mode,'pan','A pinch while pointing at the map takes it');
  for(const x of [.03,.06,.1]){await aimHand('right',[.25,1.2,-.3],[x,.75,-.8]);await frames();}
  await pinch('right',0);await frames(6);
  const panned=(await vrState()).pageSelection;
  assert.ok((panned.west+panned.east)/2<(startSelection.west+startSelection.east)/2,'Sweeping the ray east drags the map east, so the selection moves west');
  await place('right',[.25,1.3,-.35]);await frames();

  // The watch on the back of the left wrist: touch it with the right index finger to open the radial menu.
  await place('left',[-.06,1.32,-.32]);await place('right',[.3,1.1,-.2]);await frames(6);
  state=await vrState();
  assert.ok(state.watch.face,'The watch is on the left wrist');
  // Measure the fingertip with the hand held level first: pointing turns the hand, which moves the tip.
  const touch=async point=>{
    await place('right',[.3,1.1,-.2]);await frames(4);
    const s=await vrState(),tip=s.hands[1].indexTip,at=await handPosition('right');
    await place('right',at.map((value,i)=>value+point[i]-tip[i]));await frames(4);
    await place('right',[.3,1.1,-.2]);await frames(4);
  };
  await touch(state.watch.face);
  assert.equal((await vrState()).watch.menu,'root','Touching the watch opens the radial menu');
  // Point at a segment and pinch: Multiplier, then +. A pinch on the menu never drags the map.
  const beforeMenu=(await vrState()).pageSelection,multiplier=Number(await page.inputValue('#exaggeration'));
  const choose=async id=>{
    const point=await page.evaluate(async id=>(await import('/static/vr.js')).currentVR().watchPoint(id),id);
    assert.ok(point,`${id} is on show`);
    await aimHand('right',[.1,1.45,.05],point);await frames();
    await pinch('right',1);await frames();await pinch('right',0);await frames(6);
  };
  await choose('radial:root:4');assert.equal((await vrState()).watch.menu,'multiplier');
  await choose('radial:multiplier:2');
  near(Number(await page.inputValue('#exaggeration')),multiplier+.1,1e-9,'Pointing and pinching on + raises the multiplier');
  assert.deepEqual((await vrState()).pageSelection,beforeMenu,'Pinching on the menu leaves the map alone');
  // The keyboard takes fingertip presses too.
  await choose('radial:center');await choose('radial:root:0');
  assert.equal((await vrState()).watch.keyboard,true);
  await touch(await page.evaluate(async()=>(await import('/static/vr.js')).currentVR().watchPoint('key:7')));
  assert.equal((await vrState()).watch.text.endsWith('7'),true,'Touching a key types it');
  await choose('key:cancel');assert.equal((await vrState()).watch.keyboard,false,'Cancel puts the keyboard away');
  await place('left',[-.25,1.2,-.4]);await place('right',[.25,1.2,-.4]);await frames(4);

  // The computer's page follows the box as you move the map.
  const selectionText=async p=>[await p.locator('#selection-size').innerText(),await p.locator('#selection-rotation').innerText()];
  await computer.waitForFunction(text=>document.getElementById('selection-size').textContent===text,(await selectionText(page))[0],{timeout:10000});
  assert.deepEqual(await selectionText(computer),await selectionText(page),'The computer\'s map frame follows the headset');

  // Generate from the right wrist, touched with the left index finger: the model view shows the new terrain.
  await place('right',[.12,1.32,-.32]);await place('left',[-.3,1.1,-.2]);await frames(6);
  state=await vrState();
  assert.equal(state.watch.buttonLabel,'Generate');
  const touchLeft=async point=>{
    await place('left',[-.3,1.1,-.2]);await frames(4);
    const s=await vrState(),tip=s.hands[0].indexTip,at=await handPosition('left');
    await place('left',at.map((value,i)=>value+point[i]-tip[i]));await frames(4);
    await place('left',[-.3,1.1,-.2]);await frames(4);
  };
  const wanted=state.pageSelection;
  await touchLeft(state.watch.button);
  state=await until(s=>s.mode==='model',120000,'the generated model');
  for(const key of ['north','south','west','east'])near(state.area.bounds[key],wanted[key],1e-6,`The box's area was generated (${key})`);
  assert.ok(state.tiles>0,'and shown as the model');
  // The computer opens the same model by itself.
  await computer.waitForFunction(()=>document.getElementById('selection-state').textContent==='Terrain generated',null,{timeout:30000});
  assert.deepEqual(await selectionText(computer),await selectionText(page),'The computer shows the same cut');

  // ◀ Map on the same button goes back to Map Selection.
  await place('right',[.12,1.32,-.32]);await frames(6);
  assert.equal((await vrState()).watch.buttonLabel,'◀ Map');
  await touchLeft((await vrState()).watch.button);
  assert.equal((await vrState()).mode,'map','◀ Map returns to Map Selection');

  // Leaving VR returns to the page; the computer exports the model with the page's usual export.
  await page.evaluate(async()=>(await import('/static/vr.js')).currentVR().exit());
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(async()=>(await import('/static/vr.js')).currentVR().presenting),false,'Leaving VR returns to the page');
  assert.equal(await computer.locator('#scene-detail').innerText(),await page.locator('#scene-detail').innerText(),'The computer has the headset\'s model');
  await computer.click('#export-button');
  const download=computer.waitForEvent('download',{timeout:60000});
  await computer.locator('[data-export="stl"]').click();
  assert.match((await download).suggestedFilename(),/\.stl$/,'and exports it');

  for(const [name,p] of [['headset',page],['computer',computer]])assert.deepEqual(p.errors,[],`No ${name} page errors: ${p.errors.join('; ')}`);
  await browser.close();
  console.log('VR hands browser test passed.');
})().catch(error=>{console.error(error);process.exit(1);});
