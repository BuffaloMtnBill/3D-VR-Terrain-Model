/* Run against scripts/browser_fixture_server.py; no public services are queried. */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.TERRAIN_CHROMIUM_PATH,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    await context.route(/^https:\/\/tile\./,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'}));
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.url().includes('/api/features/')&&request.method()==='POST')requests.push(request.url());});
    await page.goto(process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001');
    await page.waitForFunction(()=>document.getElementById('feature-count-water').textContent.trim()!==''&&document.getElementById('feature-status').textContent.includes('shown'));
    assert.equal(await page.locator('#water-source').inputValue(),'usgs');
    assert.ok(requests.some(url=>url.includes('layer=water&source=usgs')));
    const count=await page.locator('#feature-count-water').textContent();
    assert.ok(Number(count.replaceAll(',',''))>0);
    await page.locator('#water-source').selectOption('osm');
    await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('shown'));
    assert.equal(await page.locator('#water-credit').isVisible(),false);
    const before=requests.length;
    await page.locator('#water-source').selectOption('usgs');
    await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('shown'));
    assert.equal(requests.length,before,'Switching back reuses the loaded source');
    assert.equal(await page.locator('#feature-count-water').textContent(),count);
    const metadata=await page.evaluate(async()=>{
      const response=await fetch('/api/export/example',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:'metadata',feature_layers:{water:{enabled:true,color:'#619ea5',source:document.getElementById('water-source').value}}})});
      return response.json();
    });
    assert.equal(metadata.feature_layers.water.source,'usgs');
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('shown'));
    assert.equal(await page.locator('#water-source').inputValue(),'usgs');
    // A late USGS response must not overwrite a newer OSM selection.
    const other=await browser.newContext({viewport:{width:1440,height:1100}});
    await other.route(/^https:\/\/tile\./,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'}));
    let release,started;
    const waiting=new Promise(resolve=>{release=resolve;});
    const requested=new Promise(resolve=>{started=resolve;});
    await other.route('**/api/features/*?layer=water&source=usgs',async route=>{
      if(route.request().method()==='POST')return route.continue();
      started();await waiting;
      await route.fulfill({json:{state:'ready',water:[],source_url:'https://www.usgs.gov/3d-hydrography-program'}});
    });
    const race=await other.newPage();race.on('pageerror',error=>errors.push(error.message));
    await race.goto(process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001');
    await requested;
    await race.locator('#water-source').selectOption('osm');
    await race.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('shown'));
    const osmCount=await race.locator('#feature-count-water').textContent();
    release();await race.waitForTimeout(350);
    assert.equal(await race.locator('#feature-count-water').textContent(),osmCount);
    assert.equal(await race.locator('#water-source').inputValue(),'osm');
    await other.close();
    assert.deepEqual(errors,[]);
    console.log('Water source browser checks passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
