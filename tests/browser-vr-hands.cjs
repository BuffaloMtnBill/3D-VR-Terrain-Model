/* Hand-tracking VR cut workflow on an emulated Meta Quest 3, then the handoff to the computer's page.
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

  // Palm toward you shows the Menu button; tapping it with the other index finger opens the menu.
  await place('left',[-.1,1.4,-.3],PALM_TOWARD_YOU);await frames(6);
  state=await vrState();
  assert.ok(state.palmButton,'The palm button shows when the palm faces you');
  const tip=state.hands[1].indexTip,rightAt=await handPosition('right');
  await place('right',rightAt.map((value,i)=>value+state.palmButton[i]-tip[i]));await frames(6);
  assert.equal((await vrState()).menuOpen,true,'Tapping the palm button opens the menu');
  await place('left',[-.25,1.2,-.4]);await place('right',[.25,1.2,-.4]);await frames(6);
  assert.equal((await vrState()).palmButton,null,'The button hides when the palm turns away');

  // The Cut tab shows the surroundings with the cut's fence and handles.
  await tap('right','^tab:cut$');
  state=await vrState();
  assert.equal(state.menuTab,'cut');
  state=await until(s=>s.cut.ready&&Object.values(s.cut.handles).some(Boolean),120000,'the surroundings to load');
  await frames(10);
  state=await vrState();
  assert.equal(state.cut.active,true);
  assert.ok(Object.values(state.cut.handles).filter(Boolean).length>=4,`The cut has handles: ${JSON.stringify(state.cut)}`);
  const start=state.cut.frame;
  // The surroundings stand on the ground map, north up, at the cut's scale.
  assert.equal(state.ground.parent,'Scene');assert.equal(state.ground.rotation,0,'Under the surroundings the map is north up');
  near(state.ground.scale,state.cut.scale,1e-9,'and scaled like the surroundings');
  state=await until(s=>s.ground.layers.length===2,30000,'the ground map layers');
  assert.ok(state.ground.layers.every(layer=>layer.tiles>0),'The ground map is made of map tiles');

  async function dragHandle(name,move) {
    const s=await vrState(),room=toRoom(s,s.cut.handles[name]);
    await pinchAt('right',room);
    await pinch('right',1);await frames();
    assert.equal((await vrState()).hands[1].mode,'handle',`Pinching the ${name} handle takes it`);
    for(let step=1;step<=4;step++){await pinchAt('right',room.map((value,i)=>value+move[i]*step/4));}
    await pinch('right',0);await frames(8);
    return (await vrState()).cut.frame;
  }
  // Each drag finishes by setting the page's selection; the fence then follows the page (cut.frame is read back from it).
  let moved=await dragHandle('move',[.08,0,0]);
  assert.ok(moved.cx-start.cx>0,`Moving the middle handle east moves the cut east (${moved.cx-start.cx} m)`);
  near(moved.w,start.w,start.w*.01,'Moving keeps the width');
  const wider=await dragHandle('width',[.05,0,0]);
  assert.ok(wider.w>moved.w*1.05,`The side handle widens the cut (${moved.w} → ${wider.w} m)`);
  near(wider.h,moved.h,moved.h*.01,'Widening keeps the height');
  const scaled=await dragHandle('scale',[.04,0,.04]);
  assert.ok(scaled.w>wider.w*1.05&&scaled.h>wider.h*1.05,'The corner handle scales both sides');
  near(scaled.w/scaled.h,wider.w/wider.h,.02,'Scaling keeps the proportions');
  // The ring sits north of the middle; pulling it east turns the cut clockwise, as on the map.
  const turned=await dragHandle('rotate',[.06,0,0]);
  assert.ok(Math.abs(turned.angle)>=5,`The ring turns the cut (${turned.angle}°)`);
  const selection=await page.evaluate(()=>document.getElementById('selection-rotation').textContent);
  assert.match(selection,new RegExp(`${Math.abs(turned.angle)}`),`The page's own selection is turned too (${selection})`);
  // The computer's map frame follows the cut live, before anything is generated.
  await computer.waitForFunction(text=>document.getElementById('selection-rotation').textContent===text,selection,{timeout:10000});
  assert.equal(await computer.locator('#selection-size').innerText(),await page.locator('#selection-size').innerText(),'The computer shows the same cut size');

  // Scale: the elevation multiplier raises the surroundings while you watch.
  await tap('right','^cut:exaggeration:plus$');
  await page.screenshot({path:path.join(output,'vr-hands-cut.png')});

  // Generate this cut: the new model replaces the surroundings.
  const generate=(await vrState()).regions.find(r=>/^cut:button\d+$/.test(r.id)&&!r.disabled);
  assert.ok(generate,'Generate this cut is available');
  await tap('right',`^${generate.id}$`);
  await until(s=>s.menuTab==='terrain'&&!s.cut.active,120000,'the generated cut to replace the surroundings');
  await page.waitForFunction(()=>document.getElementById('selection-state').textContent==='Terrain generated',null,{timeout:30000});
  assert.match(await page.locator('#scene-detail').innerText(),new RegExp(`${Math.abs(turned.angle)}° selection`));
  // Under the model, the map turns with the cut, so the model sits on it in its real place.
  state=await until(s=>Math.abs(s.ground.rotation-turned.angle*Math.PI/180)<1e-6,10000,'the ground map to turn with the model');
  for(const label of ['terrain','off','streets']) {
    await tap('right','^terrain:ground-map$');
    state=await vrState();assert.equal(state.ground.style,label,`The Ground map switch cycles to ${label}`);
  }

  // The computer's page followed along: same cut, same model, without touching it.
  const mirrored=async()=>({rotation:await computer.locator('#selection-rotation').innerText(),detail:await computer.locator('#scene-detail').innerText(),
    exaggeration:await computer.locator('#exaggeration').inputValue()});
  await computer.waitForFunction(text=>document.getElementById('scene-detail').textContent===text,await page.locator('#scene-detail').innerText(),{timeout:30000});
  assert.deepEqual(await mirrored(),{rotation:await page.locator('#selection-rotation').innerText(),detail:await page.locator('#scene-detail').innerText(),
    exaggeration:await page.locator('#exaggeration').inputValue()},'The computer mirrors the headset as you edit');
  assert.equal(await computer.locator('#live-offer').isHidden(),true,'Following needs no Continue here');

  // Not following: the computer keeps its own view and offers the headset's work instead.
  await computer.locator('#follow-headset').uncheck();
  const kept=await computer.locator('#exaggeration').inputValue();
  await tap('right','^tab:terrain$');
  await tap('right','^terrain:exaggeration:plus$');
  await computer.waitForFunction(()=>!document.getElementById('live-offer').hidden,null,{timeout:10000});
  assert.equal(await computer.locator('#exaggeration').inputValue(),kept,'Unfollowed, the computer keeps its own settings');
  assert.equal(await computer.locator('#live-offer-open').innerText(),'Continue here');

  // Taking off the headset: Continue here brings the latest work over.
  await tap('right','^exit-vr$');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(async()=>(await import('/static/vr.js')).currentVR().presenting),false,'Exit VR leaves the headset view');
  await computer.click('#live-offer-open');
  await computer.waitForFunction(()=>/Continued from the headset/.test(document.getElementById('toast').textContent),null,{timeout:30000});
  assert.equal(await computer.locator('#exaggeration').inputValue(),await page.locator('#exaggeration').inputValue(),'Continue here brings the latest settings');
  assert.equal(await computer.locator('#scene-detail').innerText(),await page.locator('#scene-detail').innerText(),'and the same model');
  // Exporting on the computer is the ordinary page export.
  await computer.click('#export-button');
  const download=computer.waitForEvent('download',{timeout:60000});
  await computer.locator('[data-export="stl"]').click();
  assert.match((await download).suggestedFilename(),/\.stl$/);

  for(const [name,p] of [['headset',page],['computer',computer]])assert.deepEqual(p.errors,[],`No ${name} page errors: ${p.errors.join('; ')}`);
  await browser.close();
  console.log('VR hands browser test passed.');
})().catch(error=>{console.error(error);process.exit(1);});
