/* Hand-tracking VR on an emulated Meta Quest 3, with a second page standing in for the computer.
 * Run scripts/browser_fixture_server.py (port 8001) first. TERRAIN_PLAYWRIGHT_PATH points at a Playwright package,
 * TERRAIN_IWER_PATH at the IWER emulator's build/iwer.min.js, and TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 * The surroundings of the cut are real elevation downloads (through the fixture server's normal tile cache).
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');
const {aim:aimLaser}=require('./vr-aim.cjs');
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
  // The watch and the wrist button stand out from the backs of the wrists on short stalks, clear of the wrist itself.
  state=await until(s=>s.watch.stalks.face&&s.watch.stalks.button,5000,'the watch and wrist button on their stalks');
  assert.ok(state.watch.stalks.face>.04&&state.watch.stalks.button>.04,`They stand well out from the wrist (${JSON.stringify(state.watch.stalks)})`);

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

  // Map Selection with hands: pinch to grip the map and move your hand; the map moves with it under the box.
  assert.equal((await vrState()).mode,'map','VR starts in Map Selection');
  const startSelection=(await vrState()).pageSelection;
  await place('right',[.25,1.3,-.35]);await frames();
  await pinch('right',1);await frames();
  for(const x of [.28,.31,.35]){await place('right',[x,1.3,-.35]);await frames();}
  // Held still, then letting go the way fingers do: they open part way while the pinch still counts, then fully.
  // The map follows the knuckle, not the opening fingertips, so it does not jerk back as they open.
  await page.waitForTimeout(400);
  const heldAt=(await vrState()).position;
  await pinch('right',.55);await frames(4);
  // Half open, the fingertips are already 4 cm apart while the headset still reports its pinch: the grip lets go now.
  assert.equal((await vrState()).hands[1].mode,null,'Fingers apart let go, whatever the headset still reports');
  assert.deepEqual((await vrState()).position,heldAt,'Opening the fingers does not move the map');
  await pinch('right',0);await frames(6);
  assert.deepEqual((await vrState()).position,heldAt,'nor does letting go');
  assert.equal((await vrState()).gliding,false);
  const panned=(await vrState()).pageSelection;
  assert.ok((panned.west+panned.east)/2<(startSelection.west+startSelection.east)/2,'Moving the gripped map east moves the selection west');
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
  // Point at a segment with the hand's laser and pinch: Multiplier, then +. Choosing never moves the map.
  const beforeMenu=(await vrState()).pageSelection,multiplier=Number(await page.inputValue('#exaggeration'));
  assert.deepEqual((await vrState()).watch.lasers,[true,true],'The hands\' lasers show while the menu is up');
  const choose=async id=>{
    await aimLaser(page,'hand','right',id);
    await pinch('right',1);await frames(3);await pinch('right',0);await frames(4);
  };
  await choose('radial:root:terrain');await choose('radial:terrain:multiplier');assert.equal((await vrState()).watch.menu,'multiplier');
  await choose('radial:multiplier:2');
  near(Number(await page.inputValue('#exaggeration')),multiplier+.1,1e-9,'Tapping + raises the multiplier');
  assert.deepEqual((await vrState()).pageSelection,beforeMenu,'Tapping the menu leaves the map alone');
  // The keyboard is chosen the same way.
  await choose('radial:center');await choose('radial:center');await choose('radial:root:search');
  assert.equal((await vrState()).watch.keyboard,true);
  await choose('key:7');
  assert.equal((await vrState()).watch.text,'7','A pinch on a key types it');
  await choose('key:cancel');assert.equal((await vrState()).watch.keyboard,false,'Cancel puts the keyboard away');
  // The shape editor: point at a handle, pinch, and sweep the laser (here the side handle, outward: wider).
  await place('right',[.3,1.1,-.2]);await frames(4);
  await touch((await vrState()).watch.face);await choose('radial:root:shape');
  assert.ok((await vrState()).watch.editor,'Shape opens the editor');
  const ratioFrom=(await vrState()).watch.editor.ratio;
  await aimLaser(page,'hand','right','editor:handle:width');
  await pinch('right',1);await frames(3);
  assert.equal((await vrState()).watch.editor.dragging,'width','A pinch with the laser on a handle takes it');
  const aimedFrom=await handPosition('right'),aimedTurn=await page.evaluate(()=>[...window.xrDevice.hands.right.quaternion.quat]);
  for(const x of [.05,.1,.15])await place('right',[aimedFrom[0]+x,aimedFrom[1],aimedFrom[2]],aimedTurn),await frames(3);
  await pinch('right',0);await frames(6);
  assert.ok((await vrState()).watch.editor.ratio>ratioFrom*1.15,'Dragging it out makes the shape wider');
  await choose('editor:ok');assert.equal((await vrState()).watch.menu,'root','OK returns to the menu');
  await place('right',[.3,1.1,-.2]);await frames(4);
  await touch((await vrState()).watch.face);assert.equal((await vrState()).watch.menu,null);
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

  // A fist turns the model as the fist turns, about the model's center, which stays where it is. (IWER has no fist
  // pose, so one is made from its relaxed pose with the index, middle, and ring fingertips curled in to the palm.)
  const makeFist=(hand,on)=>page.evaluate(([hand,on])=>{
    const h=window.xrDevice.hands[hand],inner=Object.getOwnPropertySymbols(h).map(key=>h[key]).find(value=>value?.poses);
    if(!inner.poses.fist) {
      const fist=structuredClone(inner.poses.default),wrist=fist.jointTransforms.wrist.offsetMatrix;
      for(const finger of ['index','middle','ring']) {
        const tip=fist.jointTransforms[`${finger}-finger-tip`].offsetMatrix;
        for(let i=0;i<3;i++)tip[12+i]=wrist[12+i]+(tip[12+i]-wrist[12+i])*.35;
      }
      inner.poses.fist=fist;
    }
    h.poseId=on?'fist':'default';
  },[hand,on]);
  await place('right',[.25,1.3,-.35]);await frames();
  const unturned=await vrState();
  await makeFist('right',true);await frames();
  state=await vrState();
  assert.equal(state.hands[1].mode,'spin',`A fist takes the model to turn it (${JSON.stringify(state.hands[1])})`);
  for(const step of [.25,.5,.75,1]) {
    const half=Math.PI/12*step;
    await place('right',[.25,1.3,-.35],[Math.sin(half),0,0,Math.cos(half)]);await frames(2);
  }
  await frames(10);
  state=await vrState();
  near(2*Math.acos(Math.min(1,Math.abs(state.spin[3]))),Math.PI/6,.02,`The model turns with the fist (${state.spin})`);
  near(Math.abs(state.spin[0]),Math.sin(Math.PI/12),.02,'about the same axis');
  state.position.forEach((value,i)=>near(value,unturned.position[i],.001*state.scale,'and stays where it is (to a millimeter)'));
  assert.equal(state.scale,unturned.scale);
  await makeFist('right',false);await frames();
  state=await vrState();
  assert.equal(state.hands[1].mode,null,'Opening the fist lets go');
  await place('right',[.25,1.3,-.35]);await frames();
  near(2*Math.acos(Math.min(1,Math.abs((await vrState()).spin[3]))),Math.PI/6,.02,'and the model stays turned');
  // A pinch in the air in the model view still moves the model.
  await pinch('right',1);await frames();
  assert.equal((await vrState()).hands[1].mode,'grab','A pinch in the air moves the model');
  await pinch('right',0);await frames();
  // A pinch on the model itself picks it up and it is held as a real thing would be: the spot pinched stays between the
  // fingertips however the hand moves and turns, and the model turns with the hand.
  const c0=(await vrState()).modelCenter;
  await pinchAt('right',[c0[0]+.1,c0[1],c0[2]]);await pinch('right',1);await frames();
  state=await vrState();
  assert.equal(state.hands[1].mode,'hold',`A pinch on the model holds it (${JSON.stringify(state.hands[1])})`);
  const spun=state.spin;
  const pinched=await page.evaluate(async([matrix,tip])=>{const THREE=await import('three');
    return new THREE.Vector3(...tip).applyMatrix4(new THREE.Matrix4().fromArray(matrix).invert()).toArray();},[state.modelMatrix,state.hands[1].pinchTip]);
  const theta=Math.PI/6;
  for(const step of [.25,.5,.75,1]) {
    const half=theta*step/2;
    await place('right',[c0[0]+.1-pinchOffset[0]-.1*step,c0[1]-pinchOffset[1]+.05*step,c0[2]-pinchOffset[2]],[Math.sin(half)*.6,Math.sin(half)*.8,0,Math.cos(half)]);await frames(2);
  }
  await frames(14);
  state=await vrState();
  const held=await page.evaluate(async([matrix,point])=>{const THREE=await import('three');
    return new THREE.Vector3(...point).applyMatrix4(new THREE.Matrix4().fromArray(matrix)).toArray();},[state.modelMatrix,pinched]);
  for(let i=0;i<3;i++)near(held[i],state.hands[1].pinchTip[i],.004,`The pinched spot stays between the fingertips (axis ${i})`);
  assert.ok(Math.abs(state.spin[1]-spun[1])>.1,`and the model turns with the hand (${spun} → ${state.spin})`);
  await pinch('right',0);await frames();
  state=await vrState();
  assert.equal(state.hands[1].mode,null,'Opening the fingers puts it down');
  await place('right',[.25,1.3,-.35]);await frames();

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
