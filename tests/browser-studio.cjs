/* Design page (Print Studio) end-to-end test: run scripts/browser_fixture_server.py (port 8001) first.
 * TERRAIN_PLAYWRIGHT_PATH points at a Playwright package; TERRAIN_CHROMIUM_PATH at a Chromium binary if needed.
 * Studio endpoints are used when the server has them; on a 404 the test answers with a fixture from the spec,
 * so the UI flow is tested either way (exports then fall back to the original /api/export endpoint).
 */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const output=path.join(__dirname,'..','test-results');
const n=(value,min,max,label,unit='mm')=>({default:value,min,max,label,unit});
const CATALOG={font:'DejaVu Sans Bold',marker_ball:{name:'Push-pin marker ball',ball_diameter:10,height:12,exposed_nail_length:24.4,recommended_hole_diameter:1.8,nail:{shank_diameter:1.66}},
  marker_platform:{name:'Nail marker platform',deck_shape:'round',deck_size:30,deck_thickness:2.4,hub_top_diameter:8,deck_top_z:9,exposed_nail_length:26.5,recommended_hole_diameter:1.8},types:{
  hole:{label:'Hole',kind:'cut',params:{diameter:n(5,.5,30,'Diameter'),depth:n(8,.5,200,'Depth'),chamfer:n(.4,0,3,'Chamfer')}},
  nail_marker:{label:'Nail marker',kind:'cut',params:{hole_diameter:n(1.8,1,4,'Hole diameter'),depth:n(24.4,1,60,'Depth')}},
  pencil_holder:{label:'Pencil holder',kind:'cut',params:{diameter:n(10,4,30,'Diameter'),depth:n(40,5,200,'Depth'),count:n(1,1,12,'Count',''),spacing:n(14,4,100,'Spacing'),tilt_deg:n(0,0,30,'Tilt','°')}},
  pocket:{label:'Pocket',kind:'cut',params:{shape:{default:'rounded',choices:['rect','rounded','oval'],label:'Shape'},width:n(40,5,250,'Width'),length:n(25,5,250,'Length'),depth:n(6,.5,80,'Depth'),corner_radius:n(4,0,50,'Corner radius')}},
  plaque:{label:'Plaque',kind:'mixed',params:{shape:{default:'rounded',choices:['rect','rounded','oval'],label:'Shape'},width:n(60,10,250,'Width'),length:n(25,5,250,'Length'),corner_radius:n(4,0,50,'Corner radius'),mode:{default:'flatten',choices:['flatten','level','raise'],label:'Mode'},raise:n(2,0,30,'Raise'),text:{default:'',label:'Text'},text_size:n(6,2,40,'Text size'),text_style:{default:'deboss',choices:['emboss','deboss'],label:'Text style'},text_depth:n(.8,.2,5,'Text depth')}},
}};

(async()=>{
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:process.env.TERRAIN_CHROMIUM_PATH,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const errors=[],mocked=new Set();
  async function setup(context) {
    await context.route(/^https:\/\/tile\./,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'}));
    const fallback=(pattern,make)=>context.route(pattern,async route=>{
      const response=await route.fetch();
      if(response.status()!==404||(response.headers()['content-type']||'').includes('json'))return route.fulfill({response});
      mocked.add(pattern);return route.fulfill({json:make(route.request())});
    });
    await fallback('**/api/studio/catalog',()=>CATALOG);
    await fallback('**/api/studio/*/check',request=>{
      const project=request.postDataJSON().project,hole=project.addons.find(addon=>addon.type==='hole');
      return {checks:hole?[{addon_id:hole.id,level:'warning',message:`Fixture check: hole ${hole.params.diameter} mm`}]:[],colors:4,addons:[]};
    });
    await fallback('**/api/studio/*/text-outline',()=>({polygons:[{outer:[[-10,-3],[10,-3],[10,3],[-10,3]],holes:[]}],width:20,height:6}));
    // Print palette with features off fits the four-filament limit, so 3MF is available.
    await context.addInitScript(()=>{
      localStorage.setItem('terrain-style-defaults',JSON.stringify({version:1,controls:{'feature-roads':false,'feature-water':false}}));
      localStorage.setItem('terrain-water-source','osm');
    });
  }
  async function openStudio(page) {
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    await page.locator('#export-button').click();
    assert.equal(await page.locator('#studio').isVisible(),true,'Export opens the design page');
    await page.waitForSelector('[data-addon-type="hole"]');
    await page.waitForTimeout(300);
  }
  try {
    const context=await browser.newContext({viewport:{width:1500,height:950},acceptDownloads:true});
    await setup(context);
    const page=await context.newPage();
    await page.goto(url);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#export-button').click();
    assert.equal(await page.locator('#studio').isVisible(),true,'Export opens the design page');
    await page.waitForSelector('[data-addon-type="hole"]');
    // The surface palette is chosen in the design page's Colors card, and the studio's own 3D view follows it.
    assert.equal(await page.locator('#studio-colors').isVisible(),true,'The Colors card sits on the design page');
    assert.equal(await page.locator('[data-export="3mf"]').isDisabled(),true);
    assert.match(await page.locator('#export-3mf-hint').innerText(),/Print palette under Colors/);
    const colorsCard=await page.locator('#studio-colors').boundingBox(),rightColumn=await page.locator('#studio .studio-right').boundingBox();
    assert.ok(colorsCard.x>=rightColumn.x&&colorsCard.x+colorsCard.width<=rightColumn.x+rightColumn.width+.5,'The Colors card fits the right column');
    const studioShot=async()=>{await page.waitForTimeout(400);return page.locator('#studio-view').screenshot({mask:[page.locator('#studio-checks'),page.locator('#studio-view-hint')]});};
    const alpineView=await studioShot();
    await page.locator('[data-palette="print"]').click();
    await page.waitForFunction(()=>document.getElementById('cover-status').textContent.includes('loaded'));
    assert.equal(await page.locator('#print-controls').isVisible(),true,'Print colors open inline in the Colors card');
    assert.ok(!alpineView.equals(await studioShot()),'Choosing a palette repaints the design page\'s 3D view');
    assert.equal(await page.locator('#studio-view canvas').count(),1,'The studio has its own 3D view');
    assert.match(await page.locator('#studio-title').innerText(),/Roan Mountain/);
    assert.match(await page.locator('#studio-dimensions').innerText(),/mm/);

    // The Start from preview: hovering a template shows it turning, without placing anything.
    assert.equal(await page.locator('#studio-turntable-view canvas').count(),1,'The preview has its own canvas in the Start from card');
    const caption=()=>page.locator('#studio-turntable-title').innerText();
    await page.waitForFunction(()=>document.getElementById('studio-turntable-title').textContent==='Preview · Print as is · no add-ons');
    const placedBefore=await page.locator('#studio-addons').innerText();
    await page.locator('[data-template="Desk set"]').hover();
    await page.waitForFunction(()=>document.getElementById('studio-turntable-title').textContent==='Preview · Desk set · 2 add-ons');
    assert.match(await page.locator('#studio-turntable-size').innerText(),/^\d+ × \d+ × \d+ mm$/);
    assert.equal(await page.locator('#studio-addons').innerText(),placedBefore,'Hovering leaves the placed list alone');
    assert.equal(await page.locator('#studio-undo').isDisabled(),true,'Hovering records no undo step');
    await page.mouse.move(750,40);
    await page.waitForFunction(()=>document.getElementById('studio-turntable-title').textContent==='Preview · Print as is · no add-ons');
    await page.locator('[data-template="Desk set"]').click();
    assert.equal(await page.locator('#studio-addons li').count(),2,'Desk set places a pencil holder and a pocket');
    await page.mouse.move(750,40);
    await page.waitForFunction(()=>document.getElementById('studio-turntable-title').textContent==='Preview · Desk set · 2 add-ons');
    assert.ok((await caption()).startsWith('Preview · Desk set'),'The preview follows the applied template');
    assert.match(await page.locator('#studio-addons').innerText(),/Pencil holder[\s\S]*Pocket/);

    // Profile: the geography selection page's cross section, drawn as the printed silhouette and sharing one slice with the geography selection page.
    await page.locator('[data-studio-view="profile"]').click();
    assert.equal(await page.locator('#studio-profile').isVisible(),true);
    await page.locator('#studio-profile-position').evaluate(element=>{element.value='14';element.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.locator('#profile-position').inputValue(),'14','The studio slider moves the geography selection page slice');
    await page.locator('#studio-profile-direction').selectOption('ns');
    assert.equal(await page.locator('#profile-direction').inputValue(),'ns');
    await page.locator('#studio-profile-direction').selectOption('ew');
    const chart=await page.locator('#studio-profile-chart').boundingBox();
    await page.mouse.move(chart.x+chart.width*.6,chart.y+chart.height/2);
    assert.match(await page.locator('#studio-profile-readout').innerText(),/mm along · surface [\d.]+ mm/);
    await page.locator('#studio-profile-cut').check();
    await page.locator('#studio-profile-cut').uncheck();
    await page.locator('[data-studio-view="profile"]').click();
    assert.equal(await page.locator('#studio-profile').isVisible(),false);

    await page.locator('[data-addon-type="hole"]').click();
    assert.equal(await page.locator('[data-addon-type="hole"]').getAttribute('aria-pressed'),'true');
    const view=await page.locator('#studio-view canvas').boundingBox();
    await page.mouse.click(view.x+view.width*.42,view.y+view.height*.55);
    assert.equal(await page.locator('#studio-addons li').count(),3,'Clicking the model places the hole');
    assert.equal(await page.locator('#studio-addons li.selected').count(),1,'The new hole is selected');
    await page.locator('#studio-param-diameter').fill('7');
    await page.locator('#studio-param-diameter').press('Tab');
    const stored=await page.evaluate(()=>{
      const key=Object.keys(localStorage).find(name=>name.startsWith('terrain-studio-projects:v1:'));
      const store=JSON.parse(localStorage.getItem(key));return store.projects.find(project=>project.id===store.active);
    });
    assert.equal(stored.name,'Desk set');
    assert.equal(stored.addons.find(addon=>addon.type==='hole').params.diameter,7,'Edits persist in the project');
    await page.waitForFunction(()=>/hole|floor|bottom|edge|No problems|⚠|⛔/i.test(document.getElementById('studio-check-list').textContent)&&!document.getElementById('studio-check-list').textContent.includes('Checks appear'));
    const checks=await page.locator('#studio-check-list').innerText();
    assert.ok(checks.trim().length>0,'A check result is shown');

    // Undo/redo round-trip on the diameter edit.
    await page.locator('#studio-undo').click();
    assert.equal(await page.locator('#studio-param-diameter').inputValue(),'5');
    await page.locator('#studio-redo').click();
    assert.equal(await page.locator('#studio-param-diameter').inputValue(),'7');

    await page.screenshot({path:path.join(output,'studio-desktop.png')});
    assert.equal(await page.locator('[data-export="3mf"]').isDisabled(),false,'3MF is available with the Print palette');
    const request=page.waitForRequest(request=>/\/api\/(studio\/[^/]+\/)?export/.test(request.url())&&request.method()==='POST'&&request.postDataJSON()?.format==='3mf');
    const downloading=page.waitForEvent('download');
    await page.locator('[data-export="3mf"]').click();
    const body=(await request).postDataJSON(),file=await downloading;
    assert.equal(body.project.name,'Desk set');
    assert.equal(body.project.addons.length,3);
    assert.equal(body.project.addons.find(addon=>addon.type==='hole').params.diameter,7);
    assert.ok(body.project.marker_balls&&body.project.marker_balls.include===false);
    assert.ok(body.print_palette&&body.feature_layers,'The export carries the palette and layers as before');
    assert.match(file.suggestedFilename(),/\.3mf$/);
    const saved=path.join(output,'studio-project.3mf');await file.saveAs(saved);
    assert.equal((await fs.readFile(saved)).subarray(0,2).toString(),'PK');
    await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
    assert.match(await page.locator('#export-status').innerText(),/downloaded/);

    // Trail marker: a nail marker at the highest point and marker balls on; the ball color joins the 3MF count.
    await page.locator('[data-template="Trail marker"]').click();
    assert.equal(await page.locator('#studio-addons li').count(),1);
    assert.equal(await page.locator('#studio-marker-include').isChecked(),true);
    // Platform markers with a terrain top travel with the 3MF export; palette colors keep the print within four filaments.
    await page.locator('#studio-marker-style').selectOption('platform');
    assert.equal(await page.locator('#studio-platform-options').isVisible(),true,'Platform options appear');
    assert.equal(await page.locator('#studio-platform-area').isVisible(),false,'Terrain fields wait for a terrain top');
    await page.locator('#studio-platform-top').selectOption('terrain');
    assert.equal(await page.locator('#studio-platform-area').isVisible(),true,'Terrain tops show the area and exaggeration fields');
    const [dark,snow]=await page.evaluate(()=>[document.getElementById('print-dark_foliage').value,document.getElementById('print-snow').value]);
    await page.locator('#studio-marker-color').fill(dark);
    await page.locator('#studio-platform-top-color').fill(snow);
    await page.locator('#studio-platform-area').fill('24');await page.locator('#studio-platform-area').press('Tab');
    await page.waitForFunction(()=>!document.querySelector('[data-export="3mf"]').disabled);
    const platformRequest=page.waitForRequest(request=>/\/api\/(studio\/[^/]+\/)?export/.test(request.url())&&request.method()==='POST'&&request.postDataJSON()?.format==='3mf');
    const platformDownload=page.waitForEvent('download');
    await page.locator('[data-export="3mf"]').click();
    const platformBody=(await platformRequest).postDataJSON(),platformFile=await platformDownload;
    assert.deepEqual([platformBody.project.marker_balls.style,platformBody.project.marker_balls.top,platformBody.project.marker_balls.top_area_mm],['platform','terrain',24]);
    assert.equal(platformBody.project.marker_balls.top_color,snow);
    assert.equal(platformBody.project.marker_balls.include,true);
    assert.match(platformFile.suggestedFilename(),/\.3mf$/);
    await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
    assert.match(await page.locator('#export-status').innerText(),/downloaded/);
    for(let step=0;step<3;step++)await page.locator('#studio-undo').click();  // area, top, style
    assert.equal(await page.locator('#studio-marker-style').inputValue(),'ball');
    await page.locator('#studio-undo').click();
    assert.equal(await page.locator('#studio-addons li').count(),3,'Undo restores the Desk set');
    // The GPS route's color appears in the Colors card only once a route is loaded; its thickness stays on the geography page.
    assert.equal(await page.locator('#route-color-row').isHidden(),true,'No route color without a route');
    await page.locator('#studio-back').click();
    assert.equal(await page.locator('#studio').isVisible(),false);
    assert.equal(await page.locator('.sidebar #route-color').count(),0);
    const gpx=`<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Colors test</name><trkseg>${Array.from({length:40},(_,i)=>`<trkpt lat="${(36.09+.04*i/39).toFixed(6)}" lon="${(-82.15+.08*i/39).toFixed(6)}"><ele>${900+i}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;
    await page.locator('#route-file').setInputFiles({name:'colors.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from(gpx)});
    await page.waitForFunction(()=>!document.getElementById('route-controls').hidden);
    await page.locator('#export-button').click();
    assert.equal(await page.locator('#route-color-row').isVisible(),true,'The route color joins the Colors card');
    await page.locator('#route-color').evaluate(element=>{element.value='#3366ff';element.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#studio-back').click();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('terrain-route')).color),'#3366ff');
    await page.locator('#route-remove').click();
    await context.close();

    const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await setup(mobile);
    const phone=await mobile.newPage();
    await openStudio(phone);
    await phone.locator('[data-template="Photo stand"]').click();
    assert.equal(await phone.evaluate(()=>document.getElementById('studio').scrollWidth<=innerWidth&&document.documentElement.scrollWidth<=innerWidth),true,'No horizontal scroll on a phone');
    await phone.screenshot({path:path.join(output,'studio-mobile.png')});
    await phone.locator('#studio').evaluate(element=>element.scrollTo(0,element.scrollHeight));
    await phone.screenshot({path:path.join(output,'studio-mobile-bottom.png')});
    await mobile.close();
    assert.deepEqual(errors,[]);
    console.log(`Design page browser test passed${mocked.size?` (fixtures for missing endpoints: ${[...mocked].join(', ')})`:''}.`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
