/* The basic page the headset's browser gets: the map with its selection box and Enter VR, nothing else.
 * Run scripts/browser_fixture_server.py (port 8001) first; TERRAIN_PLAYWRIGHT_PATH, TERRAIN_IWER_PATH, and
 * TERRAIN_CHROMIUM_PATH as for tests/browser-vr.cjs.
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const iwer=process.env.TERRAIN_IWER_PATH||require.resolve('iwer/build/iwer.min.js');
const QUEST='Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0.0.4.53 SamsungBrowser/4.0 Chrome/132.0.0.0 Mobile VR Safari/537.36';

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.TERRAIN_CHROMIUM_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  // The VR emulator also makes the browser report a Quest, so pages meant to look like a computer go without it.
  async function open(address,userAgent,emulator=true) {
    const context=await browser.newContext({viewport:{width:1280,height:720},userAgent});
    const page=await context.newPage();
    page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
    await page.route(/tile\.(opentopomap|openstreetmap)\.org/,route=>route.fulfill({status:404,body:''}));
    await page.route(/overpass|nominatim|3dhp/,route=>route.fulfill({status:503,body:'{}'}));
    if(emulator)await page.addInitScript({content:`${await fs.readFile(iwer,'utf8')}
      window.xrDevice=new IWER.XRDevice(IWER.metaQuest3);window.xrDevice.installRuntime({forceInstall:true});`});
    await page.goto(address);
    await page.waitForFunction(()=>/points/.test(document.getElementById('scene-detail').textContent),null,{timeout:30000});
    return page;
  }
  const visible=(page,selector)=>page.locator(selector).first().isVisible();
  const onScreen=(page,selector)=>page.locator(selector).first().evaluate(el=>{const r=el.getBoundingClientRect();return r.right>0&&r.bottom>0&&r.width>0;});

  // The Quest browser: only the map, its selection box, and Enter VR.
  const quest=await open(url,QUEST);
  assert.equal(await quest.evaluate(()=>document.documentElement.classList.contains('headset-page')),true,'The Quest browser gets the basic page');
  for(const selector of ['#map','#selection-frame','#enter-vr','.full-page-link'])assert.equal(await visible(quest,selector),true,`${selector} shows`);
  for(const selector of ['.sidebar','#style-sidebar','.stats-strip','.profile-panel','#restart-server'])assert.equal(await visible(quest,selector),false,`${selector} is hidden`);
  assert.equal(await onScreen(quest,'.terrain-panel'),false,'The 3D preview runs off screen');
  const mapBox=await quest.locator('#map').boundingBox();
  assert.ok(mapBox.width>900&&mapBox.height>=280,`The map fills the page (${Math.round(mapBox.width)} × ${Math.round(mapBox.height)})`);
  await quest.screenshot({path:path.join(__dirname,'..','test-results','headset-page.png')});
  // VR still starts from it.
  await quest.click('#enter-vr');
  await quest.waitForTimeout(800);
  assert.equal(await quest.evaluate(async()=>(await import('/static/vr.js')).currentVR().presenting),true,'Enter VR works from the basic page');
  await quest.evaluate(async()=>(await import('/static/vr.js')).currentVR().exit());

  // Full page on the headset, and the basic page anywhere with ?headset.
  const full=await open(`${url}/?full`,QUEST);
  assert.equal(await visible(full,'.sidebar'),true,'?full shows the whole page on the headset');
  const desk=await open(url,undefined,false);
  assert.equal(await visible(desk,'.sidebar'),true,'A computer gets the whole page');
  const forced=await open(`${url}/?headset`,undefined,false);
  assert.equal(await visible(forced,'.sidebar'),false,'?headset shows the basic page anywhere');

  for(const page of [quest,full,desk,forced])assert.deepEqual(page.errors,[],`No page errors: ${page.errors.join('; ')}`);
  await browser.close();
  console.log('Headset page browser test passed.');
})().catch(error=>{console.error(error);process.exit(1);});
