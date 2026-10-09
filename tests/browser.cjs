/* Optional end-to-end test: run scripts/browser_fixture_server.py on port 8001.
 * Install Playwright separately, or set TERRAIN_PLAYWRIGHT_PATH to its package.
 * Map, ZIP, and feature requests use fixtures; public services are not queried.
 * TERRAIN_CHROMIUM_PATH optionally selects the Chromium binary. The design page (Print Studio) has its own test (browser-studio.cjs).
 */
const { chromium } = require(process.env.TERRAIN_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const example={south:37.695,west:-119.665,north:37.785,east:-119.525};
const roan={south:36.080,west:-82.165,north:36.145,east:-82.055};
const rainier={south:46.775,west:-121.865,north:46.930,east:-121.645};
const mapTiles=/^https:\/\/tile\.(openstreetmap\.org|opentopomap\.org)\//;
const testTile = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e3ebdc"/><path d="M0 128H256M128 0V256" stroke="#c5d2b8"/><text x="128" y="123" text-anchor="middle" fill="#819075" font-family="Arial" font-size="9">MAP TILE FIXTURE</text></svg>');
const output=path.join(__dirname,'..','test-results');
const layerNames=['roads','railways','borders','water','cities','parks','buildings','at','trails'];
const labels={roads:'Roads',railways:'Train tracks',borders:'Borders',water:'Water',cities:'City boundaries',parks:'Park boundaries',buildings:'Buildings',at:'AT (Appalachian Trail)',trails:'Other trails'};
const coverNames=['dark_foliage','light_foliage','dirt','snow','water','buildings'];
const lake={outer:[[.2,.2],[.6,.2],[.6,.6],[.2,.6],[.2,.2]],holes:[[[.35,.35],[.45,.35],[.45,.45],[.35,.45],[.35,.35]]]};
function featureFixture() {
  const lines={at:[[.15,.6],[.5,.25],[.85,.55]],trails:[[.1,.5],[.5,.85],[.9,.45]],roads:[[.05,.3],[.5,.5],[.95,.7]],railways:[[.1,.85],[.45,.6],[.9,.1]],
    borders:[[.1,.1],[.9,.9]],water:[[.1,.2],[.25,.45],[.4,.65]],
    cities:[[.1,.1],[.6,.1],[.6,.8],[.1,.8],[.1,.1]],parks:[[.4,.2],[.9,.2],[.9,.6],[.4,.6],[.4,.2]],buildings:[[.72,.3],[.85,.3],[.85,.4],[.72,.4],[.72,.3]]};
  const data={state:'ready',layers:Object.fromEntries(layerNames.map(name=>[name,[{id:'fixture/'+name,name:'TEST FIXTURE',lines:[lines[name]],height_m:12,
    kind:name==='roads'?'primary':name==='water'?'lake':name,area_m2:50000,
    polygons:name==='water'?[lake]:name==='buildings'?[{outer:lines[name],holes:[]}]:[]}]])),
    source:'© OpenStreetMap contributors',source_url:'https://www.openstreetmap.org/copyright',fetched_at:'2026-10-01T00:00:00Z'};
  data.layers.roads.push({id:'fixture/minor-road',name:'TEST SERVICE ROAD',kind:'service',lines:[[[.1,.7],[.6,.75],[.9,.8]]],polygons:[]});
  data.layers.water.push({id:'fixture/creek',name:'TEST CREEK',kind:'stream',lines:[[[.2,.8],[.6,.4],[.8,.2]]],polygons:[]});
  // One mapped 3D building: its outline is replaced in 3D mode by a pyramidal-roofed part standing on it.
  data.layers.buildings[0].has_parts=true;
  data.layers.buildings.push({id:'fixture/part',name:'TEST PART',lines:[],part:true,parent:'fixture/buildings',height_m:40,min_height_m:0,roof_shape:'pyramidal',roof_height_m:20,
    polygons:[{outer:lines.buildings,holes:[]}],mesh:{positions:[.72,.3,0,.85,.3,0,.85,.4,0,.72,.4,0,.72,.3,400,.85,.3,400,.85,.4,400,.72,.4,400,.785,.35,900],
      indices:[0,1,2,0,2,3,0,5,1,0,4,5,1,6,2,1,5,6,2,7,3,2,6,7,3,4,0,3,7,4,4,8,5,5,8,6,6,8,7,7,8,4]}});
  data.counts=Object.fromEntries(layerNames.map(name=>[name,data.layers[name].length]));
  return data;
}

async function slider(page,id,value) {
  await page.locator('#'+id).evaluate((element,value)=>{element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));},String(value));
}

async function selection(page) {
  await page.locator('#edit-bounds').click();
  const result={};
  for(const key of ['north','south','east','west'])result[key]=Number(await page.locator('#bound-'+key).inputValue());
  const angle=Number(await page.locator('#bound-rotation').inputValue());if(angle)result.rotation_deg=angle;
  await page.locator('#close-bounds').click();
  return result;
}

function fixedFrame(before,after,dimensions=['x','y','width','height']) {
  for(const key of dimensions)assert.ok(Math.abs(before[key]-after[key])<.1,`Frame ${key} changed: ${before[key]} → ${after[key]}`);
}

async function dragHandle(page,axis,dx,dy) {
  const handle=await page.locator(`[data-resize="${axis}"]`).boundingBox();
  const x=handle.x+handle.width/2,y=handle.y+handle.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+dx,y+dy,{steps:6});await page.mouse.up();
}

async function frameGeometry(page) {
  return page.locator('#selection-frame').evaluate(element=>{
    const rect=document.getElementById('map').getBoundingClientRect(),style=element.style;
    const left=parseFloat(style.left),top=parseFloat(style.top),width=parseFloat(style.width),height=parseFloat(style.height);
    return {width,height,x:rect.left+left+width/2,y:rect.top+top+height/2,angle:parseFloat(style.transform.match(/rotate\(([^)]+)/)[1])};
  });
}

async function rotateCorner(page,degrees,cancel=false,snap=false) {
  const frame=await frameGeometry(page),handle=await page.locator('[data-rotate]').boundingBox();
  const x=handle.x+handle.width/2,y=handle.y+handle.height/2;
  const angle=Math.atan2(y-frame.y,x-frame.x)+degrees*Math.PI/180,radius=Math.hypot(x-frame.x,y-frame.y);
  if(snap)await page.keyboard.down('Shift');
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(frame.x+radius*Math.cos(angle),frame.y+radius*Math.sin(angle),{steps:8});
  if(cancel)await page.keyboard.press('Escape');
  await page.mouse.up();
  if(snap)await page.keyboard.up('Shift');
}

async function snapRatios(page) {
  for(const [label,ratio] of [['1:1',1],['3:4',3/4],['16:9',16/9]]) {
    const before=await frameGeometry(page);
    const button=page.locator(`[data-aspect="${label}"]`);
    await button.click();
    let after=await frameGeometry(page);
    // Clicking an already-selected canonical ratio swaps it; restore first.
    if(Math.abs(after.width/after.height-ratio)>1e-5){await button.click();after=await frameGeometry(page);}
    fixedFrame(before,after,['x','y','angle']);
    assert.ok(Math.abs(after.width/after.height-ratio)<1e-5,`${label} must set the width-to-height ratio within CSS pixel precision: ${after.width} × ${after.height}`);
    assert.equal(await page.locator(`[data-aspect="${label}"]`).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-aspect][aria-pressed="true"]').count(),1);
    await button.click();
    const flipped=await frameGeometry(page);
    fixedFrame(after,flipped,['x','y','angle']);
    assert.ok(Math.abs(flipped.width/flipped.height-1/ratio)<1e-5,'Reclicking must swap portrait and landscape');
    assert.equal(await button.innerText(),label.split(':').reverse().join(':'));
    if(ratio!==1)await button.click();
  }
}

async function alignTwoPoints(page,first=[110,100],second=[250,175],touch=false) {
  // On a phone the map sits below the taller settings column; taps outside the viewport are lost.
  await page.locator('#map').evaluate(element=>element.scrollIntoView({block:'center'}));await page.waitForTimeout(100);
  await page.locator('#align-selection').click();
  assert.equal(await page.locator('#align-selection').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#alignment-status').innerText(),/first point/);
  // Activating the toolbar can scroll the page; measure tap positions afterwards.
  await page.locator('#map').evaluate(element=>element.scrollIntoView({block:'center'}));await page.waitForTimeout(100);
  const before=await frameGeometry(page),map=await page.locator('#map').boundingBox();
  const click=point=>touch?page.touchscreen.tap(map.x+point[0],map.y+point[1]):page.mouse.click(map.x+point[0],map.y+point[1]);
  await click(first);
  fixedFrame(before,await frameGeometry(page),['x','y','width','height','angle']);
  assert.match(await page.locator('#alignment-status').innerText(),/second point/);
  await click(second);
  const after=await frameGeometry(page);
  fixedFrame(before,after,['width','height']);
  assert.ok(Math.abs(after.x-map.x-(first[0]+second[0])/2)<.6,'Box must center on the two points horizontally');
  assert.ok(Math.abs(after.y-map.y-(first[1]+second[1])/2)<.6,'Box must center on the two points vertically');
  const expected=Math.atan2(second[1]-first[1],second[0]-first[0])*180/Math.PI;
  assert.ok(Math.abs(((after.angle-expected+180)%360+360)%360-180)<.6,'Horizontal axis must pass through both points');
  assert.equal(await page.locator('#align-selection').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#alignment-status').isHidden(),true);
}

function readGLB(bytes) {
  const length=bytes.readUInt32LE(12),document=JSON.parse(bytes.subarray(20,20+length).toString());
  return {document,binary:bytes.subarray(28+length)};
}

async function verifyFeatureGLB(page,bytes) {
  const {document,binary}=readGLB(bytes);
  const root=document.nodes.find(node=>node.name==='Terrain Studio');
  assert.equal(root.extras.feature_layers.roads.color,'#ff3300');
  function positions(node) {
    const primitive=document.meshes[node.mesh].primitives[0],accessor=document.accessors[primitive.attributes.POSITION];
    const view=document.bufferViews[accessor.bufferView],stride=view.byteStride||12,offset=(view.byteOffset||0)+(accessor.byteOffset||0);
    return Array.from({length:accessor.count},(_,index)=>[0,1,2].map(axis=>binary.readFloatLE(offset+index*stride+axis*4)));
  }
  const surface=positions(document.nodes.find(node=>node.name==='Terrain surface'));
  const {columns,rows}=root.extras;
  const width=surface[columns-1][0]-surface[0][0],height=surface[(rows-1)*columns][2]-surface[0][2];
  for(const name of layerNames) {
    const node=document.nodes.find(node=>node.name===labels[name]);assert.ok(node,`${labels[name]} must be geometry in the GLB`);
    const primitive=document.meshes[node.mesh].primitives[0];
    assert.ok(document.accessors[primitive.attributes.POSITION].count>10);
    const material=document.materials[primitive.material];
    const rgb=await page.locator('#color-'+name).inputValue();
    const expected=rgb.match(/[0-9a-f]{2}/g).map(hex=>{const v=parseInt(hex,16)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
    expected.forEach((value,i)=>assert.ok(Math.abs(material.pbrMetallicRoughness.baseColorFactor[i]-value)<1e-6,`${labels[name]} should retain its chosen color`));
    // Check exported line vertices against the actual exported terrain triangles.
    const points=positions(node),step=Math.max(1,Math.floor(points.length/32));
    if(name==='buildings') {
      const height=Math.max(...points.map(point=>point[1]))-Math.min(...points.map(point=>point[1]));
      assert.ok(height>.001,'Buildings must have raised, finite geometry');
      assert.ok(points.every(point=>point.every(Number.isFinite)));
      continue;
    }
    for(let index=0;index<points.length;index+=step) {
      const [px,py,pz]=points[index],x=(px-surface[0][0])/width*(columns-1),y=(pz-surface[0][2])/height*(rows-1);
      const column=Math.max(0,Math.min(columns-2,Math.floor(x))),row=Math.max(0,Math.min(rows-2,Math.floor(y)));
      const rx=x-column,ry=y-row,a=row*columns+column;
      const heights=[surface[a][1],surface[a+1][1],surface[a+columns][1],surface[a+columns+1][1]];
      const onTerrain=rx+ry<=1?heights[0]*(1-rx-ry)+heights[1]*rx+heights[2]*ry:
        heights[3]*(rx+ry-1)+heights[1]*(1-ry)+heights[2]*(1-rx);
      assert.ok(Math.abs(py-onTerrain-.01)<2e-5,`${labels[name]} must follow the smoothed, exaggerated terrain`);
    }
  }
  const water=document.nodes.find(node=>node.name==='Water areas');assert.ok(water);
  const material=document.materials[document.meshes[water.mesh].primitives[0].material];
  const image=document.images[document.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
  const view=document.bufferViews[image.bufferView],png=binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  await fs.writeFile(path.join(output,'water-mask.png'),png);
  const alpha=await page.evaluate(async url=>{
    const image=new Image();image.src=url;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    // Exported image follows the terrain's UVs: v = 1 - selection fraction.
    return [[.1,.1],[.25,.25],[.4,.4]].map(([u,v])=>ctx.getImageData(u*canvas.width,(1-v)*canvas.height,1,1).data[3]);
  },'data:image/png;base64,'+png.toString('base64'));
  assert.deepEqual(alpha,[0,255,0],'Water mask must preserve transparent land outside water and inside islands');
}

async function main() {
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:process.env.TERRAIN_CHROMIUM_PATH,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  await context.route(mapTiles,route=>route.fulfill({status:200,contentType:'image/svg+xml',body:testTile,headers:{'access-control-allow-origin':'*'}}));
  let featurePosts=0,buildingPosts=0,failFeatures=true;
  let failCoverGet=true;
  await context.route('**/api/landcover/*',route=>{
    if(route.request().method()==='GET'&&failCoverGet){failCoverGet=false;return route.fulfill({json:{state:'error',message:'Surface map fixture is busy. Retry.'}});}
    return route.continue();
  });
  await context.route('**/api/features/*',route=>{
    if(route.request().method()==='POST'){if(route.request().url().includes('layer=buildings'))buildingPosts++;else featurePosts++;if(failFeatures)return route.fulfill({status:202,json:{state:'queued'}});return route.continue();}
    if(failFeatures)return route.fulfill({json:{state:'error',message:'Fixture feature service is busy. Retry.'}});
    return route.continue();
  });
  await context.route('**/api/location/zip/*',route=>{
    const zip=route.request().url().split('/').pop().slice(0,5);
    return route.fulfill(zip==='00000'?{status:404,json:{error:'That ZIP code was not found.'}}:
      {json:{zip,latitude:36.1773,longitude:-82.081,city:'Roan Mountain',state:'TN'}});
  });
  const page=await context.newPage();
  // Roads and Water are on for a first start; begin the feature checks from an empty selection.
  await page.addInitScript(()=>localStorage.setItem('terrain-style-defaults',JSON.stringify({version:1,controls:{'feature-roads':false,'feature-water':false}})));
  // Existing feature fixtures exercise OSM; USGS switching has its own browser test.
  await page.addInitScript(()=>localStorage.setItem('terrain-water-source','osm'));
  const errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error('Browser exception:',error.message);});
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('net::')&&!message.location().url.includes('/api/location/zip/00000')){errors.push(message.text());console.error('Browser error:',message.text());}});
  await page.goto(process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001');
  await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
  await page.waitForTimeout(350);
  assert.match(await page.locator('#stat-low').innerText(),/2,949.*ft ASL/);
  assert.equal(await page.locator('.topbar-description').textContent(),'Print the world.');
  assert.equal(await page.locator('.intro h1').textContent(),'Geography selection');
  assert.equal(await page.locator('label[for=place]').textContent(),'Famous landscapes');
  assert.equal(await page.locator('.export-section h2').textContent(),'Design and export');
  assert.equal(await page.locator('.step,.panel-number').count(),0);
  const parameters=JSON.parse(await page.locator('#selection-parameters').inputValue());
  assert.deepEqual(Object.keys(parameters).sort(),['bounds','settings','zoom']);
  assert.deepEqual(Object.keys(parameters.bounds).sort(),['east','north','rotation_deg','south','west']);
  assert.equal(parameters.bounds.rotation_deg,0);
  assert.equal(parameters.settings.palette,'alpine');
  assert.equal(parameters.settings.controls['feature-roads'],false);
  assert.ok(Number.isFinite(parameters.zoom));
  assert.equal(await page.locator('details.selection-parameters').getAttribute('open'),null,'Box parameters start collapsed');
  assert.equal(await page.locator('#solid').count()+await page.locator('#faceted').count(),0);
  assert.equal(await page.locator('.sidebar #exaggeration').count()+await page.locator('.sidebar #base').count()+await page.locator('.sidebar #contours').count(),3);
  assert.equal(await page.locator('#landscape-title').innerText(),'Roan Mountain');
  assert.equal(await page.locator('#place').inputValue(),'roan');
  assert.equal(await page.locator('#style-editor').isVisible(),true,'The style editor is always open');
  assert.equal(await page.locator('#edit-style').count()+await page.locator('#style-summary').count(),0);
  assert.match(await page.locator('#stat-low').innerText(),/ft ASL/);
  await page.locator('[data-units="m"]').click();
  assert.match(await page.locator('#stat-low').innerText(),/899.*m ASL/);
  assert.match(await page.locator('#profile-distance').innerText(),/km across/);
  assert.match(await page.locator('#selection-size').innerText(),/ m$/);
  assert.equal(await page.locator('#profile-units-note').innerText(),'Heights in meters above sea level');
  await page.locator('[data-units="ft"]').click();
  assert.match(await page.locator('#stat-low').innerText(),/2,949.*ft ASL/);
  assert.match(await page.locator('#profile-distance').innerText(),/mi across/);
  const leftExport=await page.locator('#export-button').boundingBox(),rightPanel=await page.locator('#style-sidebar').boundingBox();
  assert.ok(leftExport.x<rightPanel.x,'Export stays left and styling lives on the right');
  await page.waitForTimeout(150);
  assert.deepEqual(await selection(page),roan);
  assert.equal(await page.locator('#map-style').inputValue(),'terrain');
  assert.equal(await page.locator('#contours').isChecked(),true);
  assert.match(await page.locator('.leaflet-control-attribution').innerText(),/OpenTopoMap/);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'dark');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(16, 27, 20)');
  assert.equal(await page.locator('#scene-container canvas').count(),1);
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  await page.locator('#place').selectOption('rainier');
  assert.deepEqual(await selection(page),rainier);
  assert.equal(await page.locator('#selection-state').innerText(),'Generate to update');
  await page.locator('#place').selectOption('roan');
  assert.deepEqual(await selection(page),roan);
  await snapRatios(page);
  assert.equal(await page.locator('#fit-selection').count(),0);
  await alignTwoPoints(page);
  const aligned=await frameGeometry(page);
  await page.locator('#align-selection').click();
  const mapRect=await page.locator('#map').boundingBox();
  await page.mouse.click(mapRect.x+110,mapRect.y+100);
  await page.keyboard.press('Escape');
  fixedFrame(aligned,await frameGeometry(page),['x','y','width','height','angle']);
  assert.equal(await page.locator('#alignment-status').isHidden(),true);
  await alignTwoPoints(page,[200,80],[200,195]);
  await alignTwoPoints(page,[250,160],[95,160]);
  await page.locator('#align-selection').click();await page.locator('#align-selection').click();
  assert.equal(await page.locator('#alignment-status').isHidden(),true);
  await page.locator('#place').selectOption('roan');
  await page.locator('[data-aspect="16:9"]').click();
  const zipFrame=await frameGeometry(page);
  await page.locator('#place-search').fill('37687-1234');
  await page.locator('#place-form button').click();
  await page.waitForFunction(()=>document.getElementById('place-status').textContent.includes('Roan Mountain'));
  fixedFrame(zipFrame,await frameGeometry(page),['x','y','width','height','angle']);
  const zipBounds=await selection(page);
  assert.ok(Math.abs(((zipBounds.east+zipBounds.west)/2+82.081)/360*256*2**12)<.6,'ZIP longitude must be centered within Leaflet pixel rounding');
  const mercatorLat=lat=>Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
  assert.ok(Math.abs(((mercatorLat(zipBounds.north)+mercatorLat(zipBounds.south))/2-mercatorLat(36.1773))*256*2**12/(2*Math.PI))<.6,'ZIP latitude must be centered within Leaflet pixel rounding');
  await page.locator('#place-search').fill('00000');await page.locator('#place-form button').click();
  await page.waitForFunction(()=>document.getElementById('place-status').classList.contains('error'));
  assert.deepEqual(await selection(page),zipBounds);
  await page.locator('#place-search').fill('00501');await page.locator('#place-form button').click();
  await page.waitForFunction(()=>document.getElementById('place-status').textContent.includes('00501'));
  await page.locator('#place').selectOption('roan');
  assert.equal(await page.locator('[data-feature]').count(),9);
  assert.equal(await page.locator('#studio-colors [data-feature-color]').count(),9,'Feature colors live in the design page\'s Colors card');
  assert.equal(await page.locator('#style-sidebar input[type=color]').count()+await page.locator('.sidebar input[type=color]').count(),0,'The geography page has no color pickers');
  assert.equal(await page.locator('#studio-colors #route-color').count()+await page.locator('#studio-colors [data-palette]').count()+await page.locator('#studio-colors [data-print-color]').count(),1+4+6);
  await page.locator('#feature-roads').check();
  await page.waitForFunction(()=>document.getElementById('feature-retry').hidden===false);
  assert.match(await page.locator('#feature-status').innerText(),/busy/);
  failFeatures=false;
  await page.locator('#feature-retry').click();
  await page.waitForFunction(()=>document.getElementById('feature-status').textContent.includes('mapped features shown'));
  assert.equal(featurePosts,2);
  assert.equal(buildingPosts,0,'Buildings are not downloaded until Buildings is checked');
  for(const [group,panel,names] of [['boundaries','boundary-options',['borders','cities','parks']],['trails','trail-options',['at','trails']]]) {
    assert.equal(await page.locator('#'+panel).isHidden(),true,'Submenus stay closed until their category is checked');
    await page.locator('#group-'+group).check();
    assert.equal(await page.locator('#'+panel).isVisible(),true);
    for(const name of names)assert.equal(await page.locator('#feature-'+name).isChecked(),true,'Opening a category selects its layers');
  }
  assert.equal(await page.locator('#building-options').isHidden(),true);
  for(const name of layerNames)await page.locator('#feature-'+name).check();
  assert.equal(await page.locator('#building-options').isVisible(),true);
  // Buildings arrive from their own request (polled), so wait for the count rather than reading it at once.
  await page.waitForFunction(()=>document.getElementById('feature-count-buildings').textContent==='1');
  const sceneImage=async()=>{await page.waitForTimeout(300);return page.locator('#scene-container canvas').evaluate(canvas=>canvas.toDataURL());};
  const blockImage=await sceneImage();
  await page.locator('#buildings-detailed').check();
  assert.notEqual(await sceneImage(),blockImage,'3D buildings must change the rendered buildings');
  assert.equal(await page.locator('#feature-count-buildings').innerText(),'1');
  await page.locator('#group-trails').uncheck();
  assert.match(await page.locator('#feature-status').innerText(),/9 mapped features shown/);
  assert.equal(await page.locator('#trail-options').isHidden(),true);
  await page.locator('#group-trails').check();
  await page.locator('#color-roads').evaluate(element=>{element.value='#ff3300';element.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(featurePosts,2,'Checkboxes and recoloring must reuse loaded data');
  assert.equal(buildingPosts,1,'Buildings download once, when first checked');
  assert.match(await page.locator('#feature-status').innerText(),/11 mapped features shown/);
  await slider(page,'detail-roads',0);await slider(page,'detail-water',0);
  assert.equal(await page.locator('#feature-count-roads').innerText(),'1 / 2');
  assert.equal(await page.locator('#feature-count-water').innerText(),'1 / 2');
  assert.match(await page.locator('#feature-status').innerText(),/9 mapped features shown/);
  assert.equal(featurePosts,2,'Detail changes must filter the loaded data without another request');
  await page.locator('#export-button').click();
  const simpleDownloadWaiting=page.waitForEvent('download');await page.locator('[data-export="glb"]').click();
  const simpleDownload=await simpleDownloadWaiting;await simpleDownload.saveAs(path.join(output,'major-features.glb'));
  const simpleDocument=readGLB(await fs.readFile(path.join(output,'major-features.glb'))).document;
  for(const name of ['Roads','Water'])assert.equal(simpleDocument.nodes.find(node=>node.name===name).extras.feature_count,1);
  await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
  await page.locator('#studio-back').click();
  await slider(page,'detail-roads',100);await slider(page,'detail-water',100);
  const canvasImage=async()=>{await page.waitForTimeout(100);return page.locator('#scene-container canvas').evaluate(canvas=>canvas.toDataURL());};
  for(const name of layerNames)await page.locator('#feature-'+name).uncheck();
  const emptyImage=await canvasImage();
  for(const name of layerNames) {
    await page.locator('#feature-'+name).check();
    assert.notEqual(await canvasImage(),emptyImage,`${labels[name]} checkbox must add visible model geometry`);
    await page.locator('#feature-'+name).uncheck();
    assert.equal(await canvasImage(),emptyImage,`${labels[name]} checkbox must completely remove its visible geometry`);
  }
  for(const name of layerNames)await page.locator('#feature-'+name).check();
  await page.locator('#feature-borders').uncheck();
  const bordersOffImage=await canvasImage();
  await page.locator('#feature-borders').check();assert.notEqual(await canvasImage(),bordersOffImage);
  await page.locator('#feature-borders').uncheck();assert.equal(await canvasImage(),bordersOffImage);
  await page.locator('#export-button').click();
  const noBorderWaiting=page.waitForEvent('download');await page.locator('[data-export="glb"]').click();
  const noBorderDownload=await noBorderWaiting;await noBorderDownload.saveAs(path.join(output,'without-borders.glb'));
  const noBorderDocument=readGLB(await fs.readFile(path.join(output,'without-borders.glb'))).document;
  assert.equal(noBorderDocument.nodes.some(node=>node.name==='Borders'),false);
  assert.ok(noBorderDocument.nodes.some(node=>node.name==='Park boundaries'));
  await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
  await page.locator('#studio-back').click();
  await page.locator('#feature-borders').check();
  await page.screenshot({path:path.join(output,'feature-layers.png'),fullPage:true});

  // Palettes are chosen on the design page; its Colors link opens the page at the Colors card.
  await page.locator('#open-colors').click();
  assert.equal(await page.locator('#studio-colors').isVisible(),true);
  await page.locator('[data-palette="desert"]').click();
  assert.equal(await page.locator('[data-palette="desert"]').getAttribute('aria-pressed'),'true');
  await page.locator('#studio-back').click();
  // Elevation profile: both methods reshape the model while readouts keep real elevations.
  assert.equal(await page.locator('#relief-method').inputValue(),'standard');
  assert.equal(await page.locator('#relief-strength-block').isHidden(),true);
  const standardScene=await canvasImage(),standardSize=await page.evaluate(()=>document.getElementById('export-dimensions').textContent),lowStat=await page.locator('#stat-low').innerText();
  for(const method of ['local','lowland']) {
    const surface=page.waitForResponse(response=>response.url().includes('/api/terrain/')&&response.url().includes('relief='+method));
    await page.locator('#relief-method').selectOption(method);
    const body=await (await surface).json();
    assert.equal(body.relief,method);assert.equal(body.true_elevations.length,body.elevations.length);
    assert.equal(await page.locator('#relief-strength-block').isVisible(),true);
    assert.notEqual(await canvasImage(),standardScene,method+' must reshape the rendered model');
    assert.equal(await page.locator('#stat-low').innerText(),lowStat,'Statistics keep real elevations');
  }
  await page.locator('#relief-method').selectOption('local');
  const strongSurface=page.waitForResponse(response=>response.url().includes('relief_strength=100'));
  await slider(page,'relief-strength',100);await page.locator('#relief-strength').dispatchEvent('change');await strongSurface;
  assert.equal(await page.locator('#relief-strength-value').innerText(),'100%');
  await page.waitForFunction(previous=>document.getElementById('export-dimensions').textContent!==previous,standardSize);
  const reliefExport=page.waitForRequest(request=>/\/api\/(studio\/[^/]+\/)?export/.test(request.url())&&request.method()==='POST');
  await page.locator('#export-button').click();await page.locator('[data-export="metadata"]').click();
  assert.equal((await reliefExport).postDataJSON().relief,'local');
  await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
  await page.locator('#studio-back').click();
  const standardSurface=page.waitForResponse(response=>response.url().includes('relief=standard'));
  await page.locator('#relief-method').selectOption('standard');await standardSurface;
  await page.waitForFunction(previous=>document.getElementById('export-dimensions').textContent===previous,standardSize);
  await slider(page,'exaggeration',3.5);
  assert.equal(await page.locator('#exaggeration-value').innerText(),'3.5×');
  assert.equal(await page.locator('#smoothing').count(),0);
  assert.equal(await page.locator('[data-palette="slate"]').count(),0);
  await page.locator('#contours').check();
  assert.equal(await page.locator('#sun').count()+await page.locator('#grid').count(),0);
  await page.locator('[data-view="wireframe"]').click();
  assert.equal(await page.locator('#scene-mode').innerText(),'TERRAIN WIREFRAME');
  await page.locator('[data-view="elevation"]').click();
  assert.equal(await page.locator('#scene-mode').innerText(),'ELEVATION MAP');
  assert.equal(await page.locator('#rotate').isDisabled(),true);
  await page.locator('[data-view="relief"]').click();
  await page.locator('[data-view="map"]').click();
  assert.equal(await page.locator('#scene-mode').innerText(),'TOPOGRAPHIC MAP SURFACE');
  assert.equal(await page.locator('#map-attribution').isVisible(),true);
  assert.equal(await page.locator('[data-view="map"]').getAttribute('aria-pressed'),'true');
  const styleBounds=await selection(page),styleFrame=await page.locator('#selection-frame').boundingBox();
  await page.locator('#map-style').selectOption('streets');
  await page.waitForTimeout(200);
  assert.deepEqual(await selection(page),styleBounds);
  fixedFrame(styleFrame,await page.locator('#selection-frame').boundingBox());
  await page.locator('[data-view="map"]').click();
  assert.equal(await page.locator('#scene-mode').innerText(),'OPENSTREETMAP SURFACE');
  await page.locator('#map-style').selectOption('terrain');
  await page.waitForTimeout(200);
  assert.deepEqual(await selection(page),styleBounds);
  await page.locator('#profile-direction').selectOption('ns');
  const beforeProfileMove=await canvasImage();
  await slider(page,'profile-position',70);
  assert.equal(await canvasImage(),beforeProfileMove,'Moving the section must not draw a slice on the 3D preview');
  assert.equal(await page.locator('#profile-position-value').innerText(),'70%');
  await page.locator('#profile').hover({position:{x:130,y:40}});
  assert.equal(await page.locator('#profile-tooltip').isVisible(),true);

  // The screen rectangle stays fixed while geography moves beneath it.
  await page.evaluate(()=>window.scrollTo(0,0));
  let before=await page.locator('#selection-frame').boundingBox();
  const selectedBefore=await selection(page);
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);await page.mouse.down();
  await page.mouse.move(before.x+before.width/2+60,before.y+before.height/2+20,{steps:8});await page.mouse.up();
  await page.waitForTimeout(700);
  fixedFrame(before,await page.locator('#selection-frame').boundingBox());
  const selectedAfter=await selection(page);
  assert.ok(Math.abs(selectedBefore.west-selectedAfter.west)>.001,'Panning should change selected geography');
  assert.equal(await page.locator('#place').inputValue(),'custom');

  await page.locator('.leaflet-control-zoom-in').click();await page.waitForTimeout(350);
  fixedFrame(before,await page.locator('#selection-frame').boundingBox());
  const zoomed=await selection(page),span=selectedAfter.east-selectedAfter.west;
  const quarterLevelScale=2**(-.25);
  assert.ok(Math.abs((zoomed.east-zoomed.west)/span-quarterLevelScale)<.002,'Each zoom button should change the level by one quarter');
  await page.locator('.leaflet-control-zoom-out').click();await page.waitForTimeout(350);
  fixedFrame(before,await page.locator('#selection-frame').boundingBox());
  const unzoomed=await selection(page);
  assert.ok(Math.abs((unzoomed.east-unzoomed.west)/span-1)<.002,'Zooming out should reverse a quarter-level zoom in');
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);await page.mouse.wheel(0,-60);await page.waitForTimeout(650);
  fixedFrame(before,await page.locator('#selection-frame').boundingBox());
  const wheeled=await selection(page);
  const wheelScale=(wheeled.east-wheeled.west)/(unzoomed.east-unzoomed.west);
  assert.ok(wheelScale>quarterLevelScale&&wheelScale<.995,'A short wheel movement should zoom by less than one quarter level');
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);await page.mouse.wheel(0,-5);await page.waitForTimeout(650);
  fixedFrame(before,await page.locator('#selection-frame').boundingBox());
  const fineWheel=await selection(page);
  const fineScale=(fineWheel.east-fineWheel.west)/(wheeled.east-wheeled.west);
  assert.ok(fineScale>.97&&fineScale<1,'Tiny wheel movements should retain continuous zoom precision');

  await dragHandle(page,'width',-50,15);
  let after=await page.locator('#selection-frame').boundingBox();
  fixedFrame(before,after,['x','y','height']);assert.ok(after.width<before.width-45);
  before=after;
  await dragHandle(page,'height',15,-40);after=await page.locator('#selection-frame').boundingBox();
  fixedFrame(before,after,['x','y','width']);assert.ok(after.height<before.height-35);
  const unrotated=await frameGeometry(page),unrotatedBounds=await selection(page);
  await rotateCorner(page,30);
  const rotated=await frameGeometry(page);
  fixedFrame(unrotated,rotated);
  assert.ok(Math.abs(rotated.angle-30)<.2,'Corner dragging must rotate by the pointer angle');
  const rotatedBounds=await selection(page);
  assert.ok(Math.abs(rotatedBounds.rotation_deg-30)<.2);
  const copiedRotated=JSON.parse(await page.locator('#selection-parameters').inputValue());
  for(const key of ['north','south','east','west','rotation_deg'])assert.ok(Math.abs(copiedRotated.bounds[key]-rotatedBounds[key])<(key==='rotation_deg'?0.0001:0.000001),'Copyable parameters must track rotated selection');
  for(const key of ['north','south','east','west'])assert.ok(Math.abs(rotatedBounds[key]-unrotatedBounds[key])<.0002,'Rotation must preserve the unrotated area');
  const angle=rotated.angle*Math.PI/180;
  const topLeft=frame=>({x:frame.x-frame.width/2*Math.cos(angle)+frame.height/2*Math.sin(angle),y:frame.y-frame.width/2*Math.sin(angle)-frame.height/2*Math.cos(angle)});
  await dragHandle(page,'width',-30*Math.cos(angle),-30*Math.sin(angle));
  const resizedRotated=await frameGeometry(page);
  fixedFrame(topLeft(rotated),topLeft(resizedRotated),['x','y']);
  assert.ok(Math.abs(resizedRotated.width-rotated.width+30)<1,'Resizing follows the rotated edge axis');
  assert.ok(Math.abs(resizedRotated.height-rotated.height)<.1);
  await page.mouse.move(resizedRotated.x,resizedRotated.y);await page.mouse.down();
  await page.mouse.move(resizedRotated.x+24,resizedRotated.y+10,{steps:6});await page.mouse.up();
  await page.waitForTimeout(400);
  fixedFrame(resizedRotated,await frameGeometry(page),['x','y','width','height','angle']);
  await page.locator('.leaflet-control-zoom-in').click();await page.waitForTimeout(350);
  fixedFrame(resizedRotated,await frameGeometry(page),['x','y','width','height','angle']);
  await rotateCorner(page,-20,true);
  fixedFrame(resizedRotated,await frameGeometry(page),['x','y','width','height','angle']);
  await snapRatios(page);
  await page.locator('[data-rotate]').focus();await page.keyboard.press('Shift+ArrowRight');
  assert.ok(Math.abs((await frameGeometry(page)).angle-resizedRotated.angle-15)<.1);
  await page.keyboard.press('Home');
  assert.equal((await frameGeometry(page)).angle,0);
  await page.keyboard.press('ArrowRight');assert.equal((await frameGeometry(page)).angle,1);
  await page.keyboard.press('Home');
  await rotateCorner(page,19,false,true);assert.equal((await frameGeometry(page)).angle,15);
  await page.locator('[data-rotate]').focus();await page.keyboard.press('Home');
  before=await page.locator('#selection-frame').boundingBox();
  await page.locator('[data-resize="width"]').focus();await page.keyboard.press('ArrowLeft');
  after=await page.locator('#selection-frame').boundingBox();fixedFrame(before,after,['x','y','height']);assert.ok(after.width<before.width-1);
  await page.locator('#reset-frame').click();
  after=await page.locator('#selection-frame').boundingBox();assert.ok(after.width>before.width);
  const mapBox=await page.locator('#map').boundingBox();
  assert.ok(Math.abs(after.x-mapBox.x-54)<.1&&Math.abs(after.y-mapBox.y-24)<.1);
  assert.equal((await frameGeometry(page)).angle,0);
  await page.locator('#place').selectOption('roan');
  assert.deepEqual(await selection(page),roan);
  assert.equal(await page.locator('#place').inputValue(),'roan');
  assert.match(await page.locator('#selection-size').innerText(),/ft/);
  await page.locator('#edit-bounds').click();
  for(const [key,value] of Object.entries(example)) await page.locator('#bound-'+key).fill(String(value));
  await page.locator('#bound-rotation').fill('30');
  await page.locator('#bounds-form button[type=submit]').click();
  const selectedArea=await selection(page);
  assert.equal(selectedArea.rotation_deg,30);
  const generatedRequest=page.waitForRequest(request=>request.url().endsWith('/api/terrain')&&request.method()==='POST');
  await page.locator('#generate').click();
  const request=await generatedRequest;
  assert.equal(request.postDataJSON().bounds.rotation_deg,30);
  await page.waitForFunction(()=>document.getElementById('selection-state').textContent==='Terrain generated');
  assert.equal(await page.locator('#landscape-title').innerText(),'Custom landscape');
  assert.match(await page.locator('#scene-detail').innerText(),/30° selection/);
  assert.equal(await page.locator('#profile-direction option[value="ew"]').innerText(),'Left → Right');
  assert.match(await page.locator('.north-arrow').getAttribute('aria-label'),/-30 degrees/);
  await page.locator('#edit-bounds').click();
  await page.locator('#bounds-form button[type=submit]').click();
  assert.equal((await selection(page)).rotation_deg,30);
  await page.waitForTimeout(200);
  await page.locator('[data-view="map"]').click();
  assert.equal(await page.locator('#scene-mode').innerText(),'TOPOGRAPHIC MAP SURFACE');
  await page.screenshot({path:path.join(output,'rotated-area.png'),fullPage:true});
  await page.locator('[data-view="relief"]').click();
  await page.locator('#export-button').click();
  await page.locator('#export-size').fill('150');
  const filenames={stl:'terrain.stl',obj:'terrain.obj',glb:'terrain.glb',png:'heightmap.png',csv:'elevations.csv',npy:'elevations.npy',metadata:'terrain-metadata.json'};
  for(const format of Object.keys(filenames)) {
    const waiting=page.waitForEvent('download');
    await page.locator(`[data-export="${format}"]`).click();
    const download=await waiting;
    assert.equal(download.suggestedFilename(),filenames[format]);
    await download.saveAs(path.join(output,download.suggestedFilename()));
    await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
    const bytes=await fs.readFile(path.join(output,download.suggestedFilename()));
    assert.ok(bytes.length>1000);
    assert.notEqual(bytes.subarray(0,2).toString(),'PK');
    if(format==='stl')assert.equal(bytes.length,84+50*bytes.readUInt32LE(80));
    if(format==='obj')assert.match(bytes.toString().split('\n')[0],/^# Terrain Studio \| millimeters \| X selection right, Y selection top, Z up$/);
    if(format==='glb') {assert.equal(bytes.subarray(0,4).toString(),'glTF');assert.equal(bytes.readUInt32LE(4),2);await verifyFeatureGLB(page,bytes);}
    if(format==='png')assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    if(format==='csv')assert.ok(bytes.toString().split('\n')[0].split(',').length===160);
    if(format==='npy')assert.equal(bytes.subarray(0,6).toString('hex'),'934e554d5059');
    if(format==='metadata') {
      const metadata=JSON.parse(bytes);assert.equal(metadata.model_options.size_mm,150);
      assert.equal(metadata.bounds.rotation_deg,30);assert.equal(metadata.heightmap.north_up,false);
      assert.equal(metadata.footprint.length,4);
      assert.deepEqual(metadata.feature_layers.roads,{enabled:true,color:'#ff3300',detail:100});
    }
  }
  const creditsWaiting=page.waitForEvent('download');
  await page.locator('#export-credits').click();
  const credits=await creditsWaiting;
  assert.equal(credits.suggestedFilename(),'terrain-credits.txt');
  await credits.saveAs(path.join(output,credits.suggestedFilename()));
  await page.screenshot({path:path.join(output,'export-dialog.png'),fullPage:true});
  await page.locator('#studio-back').click();
  const snapshot=page.waitForEvent('download');await page.locator('#screenshot').click();
  const download=await snapshot;await download.saveAs(path.join(output,download.suggestedFilename()));
  await page.locator('#feature-roads').uncheck();
  assert.match(await page.locator('#feature-status').innerText(),/9 mapped features shown/);
  await page.locator('#export-button').click();
  const withoutRoads=page.waitForEvent('download');await page.locator('[data-export="glb"]').click();
  const disabledDownload=await withoutRoads;await disabledDownload.saveAs(path.join(output,'without-roads.glb'));
  const disabledDocument=readGLB(await fs.readFile(path.join(output,'without-roads.glb'))).document;
  assert.equal(disabledDocument.nodes.some(node=>node.name==='Roads'),false);
  assert.ok(disabledDocument.nodes.some(node=>node.name==='Train tracks'));
  await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
  await page.locator('#studio-back').click();
  await page.locator('#feature-roads').check();
  for(const name of layerNames)await page.locator('#color-'+name).evaluate(element=>{element.value='#b99570';element.dispatchEvent(new Event('input',{bubbles:true}));});
  const featureState=await page.locator('[data-feature]').evaluateAll(elements=>elements.map(element=>[element.dataset.feature,element.checked]));
  await page.locator('#export-button').click();
  assert.equal(await page.locator('#print-controls').isHidden(),true,'Print colors stay folded until Print is chosen');
  assert.match(await page.locator('#export-3mf-hint').innerText(),/Print palette under Colors/);
  await page.locator('[data-palette="print"]').click();
  assert.equal(await page.locator('#print-controls').isVisible(),true);
  assert.equal(await page.locator('[data-print-color]').count(),6);
  assert.match(await page.locator('#print-color-count').innerText(),/4 distinct colors/);
  await page.waitForFunction(()=>document.getElementById('cover-retry').hidden===false);
  assert.match(await page.locator('#cover-status').innerText(),/busy/);
  await page.locator('#cover-retry').click();
  await page.waitForFunction(()=>document.getElementById('cover-status').textContent.includes('loaded'));
  assert.equal(await page.locator('#scene-mode').innerText(),'MAPPED PRINT COLORS');
  assert.equal(await page.locator('#contours').isDisabled(),true);
  await page.locator('#print-dark_foliage').evaluate(element=>{element.value='#114477';element.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.match(await page.locator('#print-color-count').innerText(),/5 distinct colors/);
  assert.equal(await page.locator('[data-export="3mf"]').isDisabled(),true);
  await page.locator('#print-water').evaluate(element=>{element.value='#114477';element.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.match(await page.locator('#print-color-count').innerText(),/4 distinct colors/);
  assert.match(await page.locator('#print-feature-color-count').innerText(),/3MF: 4 \/ 4/);
  assert.deepEqual(await page.locator('[data-feature]').evaluateAll(elements=>elements.map(element=>[element.dataset.feature,element.checked])),featureState,'Print palette must preserve map-feature choices');
  assert.equal(await page.locator('#print-legend span').count(),6);
  await page.locator('#color-at').evaluate(element=>{element.value='#ff0000';element.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.locator('[data-export="3mf"]').isDisabled(),true,'Feature colors must count toward the four-filament limit');
  assert.equal(await page.locator('#print-feature-color-count').evaluate(element=>element.classList.contains('error')),true);
  await page.screenshot({path:path.join(output,'print-palette.png'),fullPage:true});
  await page.locator('#studio-back').click();
  await page.locator('#feature-at').uncheck();
  await page.locator('#export-button').click();
  assert.equal(await page.locator('[data-export="3mf"]').isDisabled(),false,'Unchecked feature colors must not consume a filament');
  assert.equal(await page.locator('[data-color-row="at"]').evaluate(element=>element.classList.contains('off')),true,'Colors of layers that are off are dimmed');
  await page.locator('#color-at').evaluate(element=>{element.value='#f0ead6';element.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.locator('#studio-back').click();
  await page.locator('#feature-at').check();
  await page.locator('#export-button').click();
  const printGLBWaiting=page.waitForEvent('download');await page.locator('[data-export="glb"]').click();
  const printGLBDownload=await printGLBWaiting;await printGLBDownload.saveAs(path.join(output,'print-terrain.glb'));
  await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
  const printFile=readGLB(await fs.readFile(path.join(output,'print-terrain.glb')));
  const printRoot=printFile.document.nodes.find(node=>node.name==='Terrain Studio');
  assert.equal(printRoot.extras.print_palette.water,'#114477');
  assert.equal(printRoot.extras.print_palette.dark_foliage,'#114477');
  assert.equal(printRoot.extras.model_options.smoothing,0);
  const printSurface=printFile.document.nodes.find(node=>node.name==='Terrain surface');
  const colorAccessor=printFile.document.accessors[printFile.document.meshes[printSurface.mesh].primitives[0].attributes.COLOR_0];
  const colorView=printFile.document.bufferViews[colorAccessor.bufferView],colorOffset=(colorView.byteOffset||0)+(colorAccessor.byteOffset||0);
  assert.equal(colorAccessor.componentType,5126);
  const colorSize=colorAccessor.type==='VEC3'?3:4,colors=[];
  for(let index=0;index<colorAccessor.count;index++)colors.push(Array.from({length:3},(_,axis)=>printFile.binary.readFloatLE(colorOffset+index*(colorView.byteStride||colorSize*4)+axis*4)).map(value=>value.toFixed(6)).join(','));
  assert.equal(new Set(colors).size,4,'Print surface must use exactly the four selected colors');
  for(let index=0;index<colors.length;index+=3){assert.equal(colors[index],colors[index+1]);assert.equal(colors[index],colors[index+2]);}
  const printRequest=page.waitForRequest(request=>/\/api\/(studio\/[^/]+\/)?export/.test(request.url())&&request.postDataJSON()?.format==='3mf');
  const printWaiting=page.waitForEvent('download');await page.locator('[data-export="3mf"]').click();
  const printDownload=await printWaiting,requestData=(await printRequest).postDataJSON();
  assert.equal(printDownload.suggestedFilename(),'terrain-print.3mf');
  assert.equal(new Set(Object.values(requestData.print_palette)).size,4);
  assert.equal(requestData.feature_layers.roads.enabled,true);
  assert.equal(requestData.feature_layers.at.enabled,true);
  assert.equal(requestData.feature_layers.buildings.enabled,true);
  await printDownload.saveAs(path.join(output,'terrain-print.3mf'));
  await page.waitForFunction(()=>!document.querySelector('[data-export="stl"]').disabled);
  assert.equal((await fs.readFile(path.join(output,'terrain-print.3mf'))).subarray(0,2).toString(),'PK');
  await page.locator('#studio-back').click();
  const printSnapshot=page.waitForEvent('download');await page.locator('#screenshot').click();
  const printImage=await printSnapshot;await printImage.saveAs(path.join(output,'print-preview.png'));
  await page.locator('#export-button').click();await page.locator('[data-palette="alpine"]').click();await page.locator('#studio-back').click();
  assert.equal(await page.locator('#contours').isDisabled(),false);
  await page.locator('#help-button').click();assert.equal(await page.locator('#help-dialog').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('#export-button').click();
  assert.equal(await page.locator('#studio').isVisible(),true,'Exports remain accessible beside the style menu');
  await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(output,'collapsed-style-sidebar.png'),fullPage:true});
  await page.setViewportSize({width:700,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Tablet layout must not overflow');
  await page.screenshot({path:path.join(output,'tablet-style-sidebar.png'),fullPage:true});
  assert.deepEqual(errors,[]);

  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobile.route(mapTiles,route=>route.abort());
  const mobilePage=await mobile.newPage();
  mobilePage.on('pageerror',error=>errors.push(error.message));
  await mobilePage.goto(process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001');
  await mobilePage.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
  assert.equal(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await mobilePage.locator('#style-editor').isVisible(),true);
  assert.equal(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await mobilePage.locator('#map-notice').isVisible(),true);
  await mobilePage.locator('#selection-frame').scrollIntoViewIfNeeded();
  const mobileFrame=await frameGeometry(mobilePage);
  const mobileCorner=await mobilePage.locator('[data-rotate]').boundingBox();
  const mx=mobileCorner.x+mobileCorner.width/2,my=mobileCorner.y+mobileCorner.height/2;
  const mobileAngle=Math.atan2(my-mobileFrame.y,mx-mobileFrame.x)-25*Math.PI/180,mobileRadius=Math.hypot(mx-mobileFrame.x,my-mobileFrame.y);
  const cdp=await mobile.newCDPSession(mobilePage);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:mx,y:my}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:mobileFrame.x+mobileRadius*Math.cos(mobileAngle),y:mobileFrame.y+mobileRadius*Math.sin(mobileAngle)}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const rotatedMobile=await frameGeometry(mobilePage);
  fixedFrame(mobileFrame,rotatedMobile);
  assert.ok(Math.abs(rotatedMobile.angle+25)<.5,'Touch dragging must rotate the frame without resizing');
  await mobilePage.setViewportSize({width:360,height:844});await mobilePage.waitForTimeout(150);
  assert.equal(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await snapRatios(mobilePage);
  await alignTwoPoints(mobilePage,[85,105],[235,170],true);
  const toolbar=await mobilePage.locator('.map-tools').boundingBox(),mobileMap=await mobilePage.locator('#map').boundingBox();
  assert.ok(toolbar.x>=mobileMap.x&&toolbar.x+toolbar.width<=mobileMap.x+mobileMap.width,'Ratio toolbar must fit on mobile');
  await mobilePage.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  await mobilePage.locator('#open-colors').click();
  await mobilePage.locator('[data-palette="print"]').click();
  assert.equal(await mobilePage.locator('#print-controls').isVisible(),true);
  assert.equal(await mobilePage.locator('#studio').evaluate(element=>element.scrollWidth<=element.clientWidth),true,'The Colors card fits a phone');
  await mobilePage.screenshot({path:path.join(output,'mobile-print-menu.png')});
  await mobilePage.locator('#studio-back').click();
  assert.deepEqual(errors,[]);
  // Free the software renderer before starting another page with default layers.
  await context.close();await mobile.close();
  const defaultsContext=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
  await defaultsContext.route(mapTiles,route=>route.fulfill({status:200,contentType:'image/svg+xml',body:testTile,headers:{'access-control-allow-origin':'*'}}));
  const defaultsPage=await defaultsContext.newPage();
  defaultsPage.on('pageerror',error=>errors.push(error.message));
  await defaultsPage.goto(process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001');
  await defaultsPage.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
  await defaultsPage.locator('#copy-selection').click();
  assert.equal(await defaultsPage.locator('details.selection-parameters').getAttribute('open'),null,'Copying works without opening the panel');
  await defaultsPage.waitForFunction(()=>document.getElementById('copy-selection-label').textContent==='Copied ✓');
  assert.equal(await defaultsPage.evaluate(()=>navigator.clipboard.readText()),await defaultsPage.locator('#selection-parameters').inputValue());
  for(const id of ['feature-roads','feature-water','contours'])assert.equal(await defaultsPage.locator('#'+id).isChecked(),true,id+' is selected on a first start');
  assert.equal(await defaultsPage.locator('#feature-buildings').isChecked(),false);
  await defaultsPage.locator('#export-button').click();await defaultsPage.locator('[data-palette="earth"]').click();await defaultsPage.locator('#studio-back').click();
  await defaultsPage.evaluate(()=>{
    for(const [id,value] of [['exaggeration','4.2'],['base','5'],['detail-roads','27'],['color-roads','#123456'],['print-water','#123456']])document.getElementById(id).value=value;
    document.getElementById('contours').checked=false;
    document.getElementById('group-boundaries').checked=true;
    document.getElementById('feature-parks').checked=true;
    document.getElementById('group-trails').checked=false;
    document.getElementById('feature-at').checked=true;
    document.getElementById('feature-buildings').checked=true;
    document.getElementById('buildings-detailed').checked=true;
  });
  await defaultsPage.locator('#save-style-defaults').click();
  assert.match(await defaultsPage.locator('#style-defaults-status').textContent(),/Saved as defaults/);
  await defaultsPage.reload();
  await defaultsPage.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
  assert.equal(await defaultsPage.locator('[data-palette="earth"]').getAttribute('aria-pressed'),'true');
  assert.equal(await defaultsPage.locator('#exaggeration').inputValue(),'4.2');
  assert.equal(await defaultsPage.locator('#exaggeration-value').textContent(),'4.2×');
  assert.equal(await defaultsPage.locator('#base').inputValue(),'5');
  assert.equal(await defaultsPage.locator('#contours').isChecked(),false);
  assert.equal(await defaultsPage.locator('#detail-roads-value').textContent(),'27%');
  assert.equal(await defaultsPage.locator('#color-roads').inputValue(),'#123456');
  assert.equal(await defaultsPage.locator('#print-water').inputValue(),'#123456');
  assert.equal(await defaultsPage.locator('#boundary-options').isVisible(),true);
  assert.equal(await defaultsPage.locator('#feature-parks').isChecked(),true);
  assert.equal(await defaultsPage.locator('#trail-options').isVisible(),false);
  assert.equal(await defaultsPage.locator('#feature-at').isChecked(),true);
  assert.equal(await defaultsPage.locator('#building-options').isVisible(),true);
  assert.equal(await defaultsPage.locator('#buildings-detailed').isChecked(),true);
  assert.equal(await defaultsPage.locator('#trail-options').isHidden(),true);
  await defaultsPage.locator('#export-button').click();await defaultsPage.locator('[data-palette="desert"]').click();await defaultsPage.locator('#studio-back').click();
  await defaultsPage.reload();
  await defaultsPage.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
  assert.equal(await defaultsPage.locator('[data-palette="earth"]').getAttribute('aria-pressed'),'true','Unsaved edits must not replace saved defaults');
  assert.deepEqual(errors,[]);
  // A famous landscape can carry its own map zoom and right-hand rendering settings.
  const presetContext=await browser.newContext({viewport:{width:1440,height:1100}});
  await presetContext.route(mapTiles,route=>route.fulfill({status:200,contentType:'image/svg+xml',body:testTile,headers:{'access-control-allow-origin':'*'}}));
  await presetContext.route('**/api/config',async route=>{
    const response=await route.fetch(),config=await response.json();
    Object.assign(config.presets.rainier,{zoom:9,settings:{palette:'desert',controls:{'feature-roads':false,'feature-water':true,'color-water':'#112233','detail-water':40,
      'feature-buildings':true,'buildings-detailed':true,'group-trails':true,'feature-trails':true,'feature-at':false,'detail-roads':500,'color-roads':'red','unknown-control':true}}});
    await route.fulfill({response,json:config});
  });
  const presetPage=await presetContext.newPage();
  presetPage.on('pageerror',error=>errors.push(error.message));
  await presetPage.goto(process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001');
  await presetPage.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
  const roadColor=await presetPage.locator('#color-roads').inputValue();
  await presetPage.locator('#place').selectOption('fuji');
  assert.equal(await presetPage.locator('#feature-roads').isChecked(),true,'A landscape without settings keeps the current ones');
  const fittedZoom=JSON.parse(await presetPage.locator('#selection-parameters').inputValue()).zoom;
  await presetPage.locator('#place').selectOption('rainier');
  assert.equal(await presetPage.locator('[data-palette="desert"]').getAttribute('aria-pressed'),'true');
  assert.equal(await presetPage.locator('#feature-roads').isChecked(),false);
  assert.equal(await presetPage.locator('#feature-buildings').isChecked(),true);
  assert.equal(await presetPage.locator('#buildings-detailed').isChecked(),true);
  assert.equal(await presetPage.locator('#building-options').isVisible(),true);
  assert.equal(await presetPage.locator('#trail-options').isVisible(),true);
  assert.equal(await presetPage.locator('#feature-trails').isChecked(),true);
  assert.equal(await presetPage.locator('#color-water').inputValue(),'#112233');
  assert.equal(await presetPage.locator('#detail-water-value').textContent(),'40%');
  assert.equal(await presetPage.locator('#detail-roads').inputValue(),'100','Out-of-range settings are ignored');
  assert.equal(await presetPage.locator('#color-roads').inputValue(),roadColor,'Malformed colors are ignored');
  const loaded=JSON.parse(await presetPage.locator('#selection-parameters').inputValue());
  assert.equal(loaded.zoom,9);assert.ok(fittedZoom>9,'The stored zoom shows more surroundings than the closest fit');
  assert.equal(loaded.settings.palette,'desert');
  assert.equal(loaded.settings.controls['buildings-detailed'],true);
  assert.ok(Math.abs(loaded.bounds.north-46.930)<1e-6&&Math.abs(loaded.bounds.west+121.865)<1e-6);
  await presetPage.locator('#feature-water').uncheck();
  assert.equal(JSON.parse(await presetPage.locator('#selection-parameters').inputValue()).settings.controls['feature-water'],false,'Copyable parameters follow later edits');
  assert.deepEqual(errors,[]);
  await presetContext.close();
  await defaultsContext.close();
  await browser.close();
  console.log('Browser checks passed: two-point alignment, ZIP navigation, nine feature layers in Boundaries and Trails submenus, raised and 3D buildings, water islands, ratio orientation toggles, Print palette and shared colors, discrete GLB colors, native four-part 3MF, removal of smoothing, rotated extraction, downloads, and desktop/mobile layout.');
}

main().catch(error=>{console.error(error);process.exit(1);});
