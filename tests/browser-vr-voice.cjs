/* VR voice commands on an emulated Meta Quest 3, with real speech: each spoken fixture (tests/fixtures/voice-*.wav,
 * made with espeak-ng) is played into Chromium's fake microphone, so the headset's own speech detection runs on real
 * audio. The computer's transcription is stood in for by default (tests/test_live.py covers the server); set
 * TERRAIN_REAL_SPEECH=1 to send the speech to the fixture server's Whisper instead (it downloads the model once).
 * Run scripts/browser_fixture_server.py first, or use `npm test -- vr-voice`.
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const iwer=process.env.TERRAIN_IWER_PATH||require.resolve('iwer/build/iwer.min.js');
const real=process.env.TERRAIN_REAL_SPEECH==='1';

// heardAs: what the computer "hears" for each spoken clip in turn (then nothing).
async function session(command,heardAs) {
  const replies=[].concat(heardAs);
  const browser=await chromium.launch({executablePath:process.env.TERRAIN_CHROMIUM_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${path.join(__dirname,'fixtures',`voice-${command}.wav`)}`]});
  const page=await browser.newPage({viewport:{width:1400,height:950},permissions:['microphone']});
  page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
  await page.route(/tile\.(opentopomap|openstreetmap)\.org/,route=>route.fulfill({status:404,body:''}));
  await page.route(/overpass|nominatim|3dhp/,route=>route.fulfill({status:503,body:'{}'}));
  page.sent=[];
  await page.route('**/api/transcribe',async route=>{
    const body=route.request().postDataJSON();page.sent.push(body);
    if(real)return route.continue();
    route.fulfill({json:{text:replies.shift()??''}});
  });
  await page.addInitScript({content:`${await fs.readFile(iwer,'utf8')}
    window.xrDevice=new IWER.XRDevice(IWER.metaQuest3);window.xrDevice.installRuntime({forceInstall:true});`});
  await page.goto(url);
  await page.waitForFunction(()=>/points/.test(document.getElementById('scene-detail').textContent),null,{timeout:30000});
  await page.click('#enter-vr');
  await page.evaluate(async()=>{const vr=await import('/static/vr.js');window.testVR=()=>vr.currentVR();});
  await page.waitForFunction(()=>window.testVR().presenting,null,{timeout:10000});
  await page.waitForFunction(()=>window.testVR().state.commands.state==='listening',null,{timeout:10000});
  return {browser,page};
}
const segmentSeconds=body=>Buffer.from(body.samples,'base64').length/32000;

(async()=>{
  // "Open menu": the watch's menu opens, with a caption saying what was heard.
  // With the menu open, its options can be said: here the next clips are heard as "Multiplier", "Plus", and "Back".
  let {browser,page}=await session('open-menu',real?'Open menu.':['Open menu.','Multiplier.','Plus.','Back.']);
  await page.waitForFunction(()=>window.testVR().state.watch.menu==='root',null,{timeout:20000});
  assert.equal((await page.evaluate(()=>window.testVR().state.watch.caption)),true,'A caption shows what was heard');
  const first=page.sent[0];
  assert.equal(first.purpose,'command','Voice commands are transcribed expecting commands');
  assert.ok(segmentSeconds(first)>.5&&segmentSeconds(first)<3.6,`Only the speech is sent, not the silence around it (${segmentSeconds(first).toFixed(2)} s)`);
  if(!real) {
    const multiplier=Number(await page.inputValue('#exaggeration'));
    await page.waitForFunction(()=>window.testVR().state.watch.menu==='multiplier',null,{timeout:20000});
    assert.ok(page.sent.at(-1).vocabulary.includes('Multiplier'),'Whisper is told the names on show');
    await page.waitForFunction(m=>Math.abs(Number(document.getElementById('exaggeration').value)-(m+.1))<1e-9,multiplier,{timeout:20000});
    assert.ok(page.sent.at(-1).vocabulary.includes('+'),'and the new menu\'s names after it changes');
    await page.waitForFunction(()=>window.testVR().state.watch.menu==='root',null,{timeout:20000});   // "Back"
  }
  // The watch switches listening off.
  await page.evaluate(()=>{window.xrDevice.controllers.left.position.set(-.15,1.2,-.3);window.xrDevice.controllers.right.position.set(.3,1.1,-.1);});
  const point=await page.evaluate(()=>window.testVR().watchPoint('radial:root:voice'));
  await page.evaluate(([p])=>window.xrDevice.controllers.right.position.set(p[0],p[1],p[2]+.12),[point]);await page.waitForTimeout(150);
  await page.evaluate(([p])=>window.xrDevice.controllers.right.position.set(p[0],p[1],p[2]+.06),[point]);await page.waitForTimeout(150);
  await page.evaluate(()=>window.xrDevice.controllers.right.position.set(.3,1.1,-.1));await page.waitForTimeout(300);
  const off=await page.evaluate(()=>window.testVR().state.commands);
  assert.equal(off.on,false);assert.equal(off.state,'off','Voice: off on the watch stops listening');
  assert.deepEqual(page.errors,[],`No page errors: ${page.errors.join('; ')}`);
  await browser.close();

  // "Generate terrain": the box's area is generated and shown as the model.
  ({browser,page}=await session('generate','Generate terrain.'));
  await page.waitForFunction(()=>window.testVR().state.mode==='model',null,{timeout:120000});
  assert.deepEqual(page.errors,[],`No page errors: ${page.errors.join('; ')}`);
  await browser.close();

  // "Exit program": back to the page.
  ({browser,page}=await session('exit','Exit program.'));
  await page.waitForFunction(()=>!window.testVR().presenting,null,{timeout:20000});
  assert.equal(await page.evaluate(()=>window.testVR().state.commands.state),'off','Leaving VR stops listening');
  assert.deepEqual(page.errors,[],`No page errors: ${page.errors.join('; ')}`);
  await browser.close();
  console.log(`VR voice commands browser test passed${real?' (with real speech recognition)':''}.`);
})().catch(error=>{console.error(error);process.exit(1);});
