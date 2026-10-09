import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFExporter } from './vendor/GLTFExporter.js';
import { SelectionFrame } from './map-frame.js';
import {rotationAngle,selectionCorners,sampleLocation,geographicExtent,mercatorPixel} from './selection-geometry.js';
import {buildFeatures,buildRoute,disposeFeatures,featureLabels,filterFeatures} from './feature-layers.js';
import {paintSurface,coverLabels} from './print-palette.js';
import {createStudio} from './print-studio.js';
import {createSilhouette} from './silhouette.js';

const $ = id => document.getElementById(id);
const presets = {};
const paletteStops = {
  alpine: ['#294633','#536e49','#89966b','#d4d6a3','#fff3cf'],
  earth: ['#2f5140','#687b52','#bab076','#d2b689','#ffefcd'],
  desert: ['#895039','#b47752','#f8bf88','#ffe7b1','#ffffed'],
  elevation: ['#2d4e85','#4393a4','#83ba88','#fbfc81','#ffffe7'],
};
const ramps = Object.fromEntries(Object.entries(paletteStops).map(([key, stops]) => [key, stops.map(hex => new THREE.Color(hex))]));
const state = {selection:null, selectionError:null, palette:'alpine', view:'relief', mapStyle:'terrain', data:null, id:null, loading:false, name:'', surfaceVersion:0};
let map, mapLayer, selectionFrame, profileMapLine, renderer, scene, camera, perspective, orthographic, controls, sun, grid, model, topMesh, baseMesh, mapTexture, featureGroup;
let toastTimer, sceneReady = false, lastMapError = 0, studio = null, silhouette = null;
let featureData=null,featureRequest=null,featureError=null,placeRequest=null;
let waterSourceChosen=false;
const featureCache=new Map();
let coverData=null,coverRequest=null,coverError=null;
let route=null,routeLines=null,routeLinesKey=null,routeMesh=null,routeLayer=null;
const coverCache=new Map();
const tileImages = new Map();
const SCALE = 6.4;
const FEET_PER_METER = 1 / 0.3048;
const METERS_PER_MILE = 1609.344;
const units=()=>state.units==='m'?{height:1,label:'m',name:'meters',distance:1000,distanceLabel:'km'}:{height:FEET_PER_METER,label:'ft',name:'feet',distance:METERS_PER_MILE,distanceLabel:'mi'};
const number = (value, decimals=0) => Number(value).toLocaleString(undefined,{maximumFractionDigits:decimals});
const boundsArray = bounds => [[bounds.south,bounds.west],[bounds.north,bounds.east]];
const sameBounds = (first,second) => ['north','south','east','west'].every(key=>Math.abs(first[key]-second[key])<1e-9)&&Math.abs(rotationAngle(first)-rotationAngle(second))<1e-9;
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));

function notify(message, error=false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8500 : 4500);
}

async function api(path, options={}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch { /* HTTP errors may not be JSON. */ }
    throw new Error(message);
  }
  return response.json();
}

function dimensions(bounds) {
  const radians = Math.PI / 180;
  return {width:6371008.8*Math.cos((bounds.north+bounds.south)/2*radians)*(bounds.east-bounds.west)*radians,
          height:6371008.8*(bounds.north-bounds.south)*radians};
}

function validateBounds(bounds) {
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error('Enter four numeric coordinates.');
  if (!(bounds.south>=-85.05112878 && bounds.north<=85.05112878 && bounds.south<bounds.north)) throw new Error('North must be above south, within ±85° latitude.');
  if (!(bounds.west>=-180 && bounds.east<=180 && bounds.west<bounds.east)) throw new Error('East must be right of west, within ±180° longitude. Date-line crossings are not supported.');
  if(Math.abs(rotationAngle(bounds))>180)throw new Error('Rotation must be between −180° and 180°.');
  if(selectionCorners(bounds).some(p=>Math.abs(p.lat)>85.05112878||Math.abs(p.lng)>180))throw new Error('The rotated area must stay within ±85° latitude and cannot cross the date line.');
  const {width,height} = dimensions(bounds);
  if (Math.min(width,height)<50) throw new Error('Select an area at least 50 meters wide and tall.');
  if (Math.max(width,height)>250000) throw new Error('Each side must be under 250 kilometers. Zoom in or resize the frame.');
}

function updateSelectionSize() {
  const {width,height} = dimensions(state.selection);
  $('selection-size').textContent = `${number(width*units().height)} × ${number(height*units().height)} ${units().label}`;
}

function updateSelection(bounds, fit=false, custom=true, zoom=null) {
  if(fit) {
    validateBounds(bounds);
    selectionFrame.fitBounds(bounds,zoom);
    if(custom){$('place').value='custom';state.name='Custom landscape';}
    updateSelectionParameters();
    return;
  }
  let error=null;
  try{validateBounds(bounds);}catch(problem){error=problem.message;}
  state.selection = {...bounds};
  state.selectionError=error;
  updateSelectionSize();
  $('selection-state').textContent = 'Area selected';
  if (custom) { $('place').value='custom'; state.name='Custom landscape'; }
  $('generate').disabled = state.loading||Boolean(error);
  $('selection-validation').textContent=error||'';
  $('selection-validation').hidden=!error;
  $('selection-frame').classList.toggle('invalid',Boolean(error));
  if (state.data && !sameBounds(bounds,state.data.bounds)) $('selection-state').textContent='Generate to update';
  if(error)$('selection-state').textContent='Adjust the area';
  updateSelectionParameters();
}

function setupMap(config) {
  map = L.map('map',{
    zoomControl:true,boxZoom:false,worldCopyJump:true,maxZoom:18,minZoom:2,
    zoomSnap:0,zoomDelta:0.25,wheelPxPerZoomLevel:240,
  }).setView([(state.selection.south+state.selection.north)/2,(state.selection.west+state.selection.east)/2],11);
  const styles={
    terrain:{url:config.map_tile_url,attribution:config.map_attribution,nativeZoom:config.map_max_native_zoom},
    streets:{url:config.street_tile_url,attribution:config.street_attribution,nativeZoom:19},
  };
  function selectMapStyle(key) {
    const style=styles[key];if(!style)return;
    if(mapLayer)map.removeLayer(mapLayer);
    tileImages.clear();lastMapError=0;$('map-notice').hidden=true;
    if(mapTexture){mapTexture.dispose();mapTexture=null;}
    if(state.view==='map')changeView('relief');
    state.mapStyle=key;
    $('map-attribution').innerHTML=style.attribution;
    const layer=L.tileLayer(style.url,{attribution:style.attribution,maxZoom:19,maxNativeZoom:style.nativeZoom,crossOrigin:'anonymous',keepBuffer:1});
    mapLayer=layer;
    layer.on('tileload',event=>{
      if(layer!==mapLayer||!map.hasLayer(layer))return;
      const {x,y,z}=event.coords, wrappedX=((x%2**z)+2**z)%2**z;
      tileImages.set(`${z}/${wrappedX}/${y}`,event.tile);
      if(tileImages.size>100)tileImages.delete(tileImages.keys().next().value);
    });
    layer.on('tileerror',()=>{
      if(layer!==mapLayer||Date.now()-lastMapError<5000)return;
      lastMapError=Date.now();
      $('map-notice').textContent='Map tiles could not load. Try the other map style or check your connection. Bundled terrain and coordinate selection still work.';
      $('map-notice').hidden=false;
    });
    layer.on('load',()=>{
      if(layer!==mapLayer)return;
      const visibleTiles=[...map.getContainer().querySelectorAll('img.leaflet-tile')];
      if(visibleTiles.length&&visibleTiles.every(tile=>tile.complete&&tile.naturalWidth>0))$('map-notice').hidden=true;
    });
    layer.addTo(map);
  }
  selectMapStyle('terrain');
  $('map-style').addEventListener('change',event=>selectMapStyle(event.target.value));
  selectionFrame=new SelectionFrame(map,(bounds,custom=true)=>updateSelection(bounds,false,custom));
  updateSelection(state.selection,true,false,presets[$('place').value]?.zoom);
  $('reset-frame').addEventListener('click',()=>selectionFrame.reset());
  $('place').addEventListener('change',event=>{
    const preset=presets[event.target.value];
    if(preset) { state.name=preset.name; updateSelection(preset.bounds,true,false,preset.zoom); applyRenderingSettings(preset.settings); }
  });
  // One search box: a US ZIP code (or ZIP+4), a "latitude, longitude" pair, or an address or place name.
  $('place-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const query=$('place-search').value.trim(),status=$('place-status');
    if(query.length<2)return notify('Enter an address, city, place name, or US ZIP code.',true);
    const parts=query.split(/[,\s]+/).filter(Boolean).map(Number),zip=/^[0-9]{5}(-[0-9]{4})?$/.test(query);
    if(!zip&&parts.length===2&&parts.every(Number.isFinite)) {
      if(Math.abs(parts[0])>85||Math.abs(parts[1])>180)return notify('Latitude must be within ±85° and longitude within ±180°.',true);
      placeRequest?.abort();placeRequest=null;status.hidden=true;
      selectionFrame.cancelAlignment();map.setView(parts,12);return;
    }
    placeRequest?.abort();const controller=new AbortController();placeRequest=controller;
    const button=$('place-form').querySelector('button');button.disabled=true;
    status.hidden=false;status.classList.remove('error');status.textContent=zip?'Finding ZIP code…':'Searching…';
    try {
      if(zip) {
        const location=await api(`/api/location/zip/${encodeURIComponent(query)}`,{signal:controller.signal});
        if(placeRequest!==controller)return;
        state.name=`${location.city}, ${location.state} · ZIP ${location.zip}`;$('place').value='custom';
        selectionFrame.centerOn([location.latitude,location.longitude],12);
        status.textContent=`${location.city}, ${location.state} · ZIP ${location.zip}`;
        return;
      }
      const place=await api(`/api/location/search?q=${encodeURIComponent(query)}`,{signal:controller.signal});
      if(placeRequest!==controller)return;
      const {south,west,north,east}=place.bounds;
      const zoom=Math.min(15,Math.max(8,map.getBoundsZoom([[south,west],[north,east]])));
      state.name=place.name.split(',').slice(0,2).join(',');$('place').value='custom';
      selectionFrame.centerOn([place.latitude,place.longitude],zoom);
      status.textContent=place.name;
    } catch(error) {
      if(error.name==='AbortError'||placeRequest!==controller)return;
      status.textContent=error.message;status.classList.add('error');
    } finally {if(placeRequest===controller){placeRequest=null;button.disabled=false;}}
  });
  $('edit-bounds').addEventListener('click',()=>{
    for(const key of ['north','south','east','west']) $(`bound-${key}`).value=state.selection[key].toFixed(6);
    $('bound-rotation').value=rotationAngle(state.selection).toFixed(4);
    $('bounds-dialog').showModal();
  });
  $('close-bounds').addEventListener('click',()=>$('bounds-dialog').close());
  $('bounds-form').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      const bounds=Object.fromEntries(['north','south','east','west'].map(key=>[key,Number($(`bound-${key}`).value)]));
      const rotation=Number($('bound-rotation').value);if(rotation)bounds.rotation_deg=rotation;
      updateSelection(bounds,true); $('bounds-dialog').close();
    } catch(error) { notify(error.message,true); }
  });
}

function setupScene() {
  const container=$('scene-container');
  try { renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true}); }
  catch {
    $('scene-empty').hidden=false;
    $('scene-empty').textContent='3D preview needs WebGL. Enable hardware acceleration in your browser. Terrain processing, profiles, and STL/OBJ exports still work.';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.setClearColor(0x142219,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.1;
  container.prepend(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','Interactive 3D terrain: drag to orbit, scroll to zoom');
  scene=new THREE.Scene();
  perspective=new THREE.PerspectiveCamera(38,1,.05,150);
  orthographic=new THREE.OrthographicCamera(-5,5,5,-5,.05,150);
  orthographic.position.set(0,25,0); orthographic.up.set(0,0,-1); orthographic.lookAt(0,0,0);
  camera=perspective;
  controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true; controls.dampingFactor=.07;
  controls.minDistance=3; controls.maxDistance=35;
  controls.maxPolarAngle=Math.PI/2.05; controls.autoRotateSpeed=.6;
  scene.add(new THREE.HemisphereLight(0xf0dfbb,0x566747,2.1));
  sun=new THREE.DirectionalLight(0xffecc8,2.5); scene.add(sun);
  const fill=new THREE.DirectionalLight(0xdfe7e4,.6); fill.position.set(-5,3,2); scene.add(fill);
  grid=new THREE.GridHelper(16,32,0x7c7954,0x506046); grid.position.y=-.03;
  grid.material.transparent=true; grid.material.opacity=.24; scene.add(grid);
  model=new THREE.Group(); scene.add(model);
  new ResizeObserver(resizeScene).observe(container);
  updateSun(); sceneReady=true;
  // Draw only while something is changing; an idle model costs no GPU time.
  controls.addEventListener('change',requestRender);
  for(const type of ['input','change','click','keydown','pointerup'])document.addEventListener(type,requestRender,true);
  let previous=performance.now();
  renderer.setAnimationLoop(now=>{
    const delta=Math.min((now-previous)/1000,.05); previous=now;
    const moved=controls.update(delta);
    if(moved||controls.autoRotate||now<renderUntil)renderer.render(scene,camera);
  });
}

let renderUntil=0;
function requestRender() {renderUntil=performance.now()+400;}

function resizeScene() {
  if(!renderer) return;
  requestRender();
  const width=$('scene-container').clientWidth,height=$('scene-container').clientHeight;
  if(!width||!height) return;
  renderer.setSize(width,height);
  perspective.aspect=width/height; perspective.updateProjectionMatrix();
  const half=4.35;
  orthographic.left=-half*width/height; orthographic.right=half*width/height;
  orthographic.top=half; orthographic.bottom=-half; orthographic.updateProjectionMatrix();
}

function updateSun() {
  requestRender();
  const angle=315*Math.PI/180;
  if(sun) sun.position.set(Math.sin(angle)*6,7,-Math.cos(angle)*6);
}

function resetCamera() {
  requestRender();
  if(!sceneReady||!state.data) return;
  const unit=SCALE/Math.max(state.data.width_m,state.data.height_m);
  const peak=(state.data.surface_max_m-state.data.surface_min_m)*Number($('exaggeration').value)*unit;
  const base=SCALE*Number($('base').value)/100;
  const center=base+peak*.38;
  if(state.view==='elevation') {
    orthographic.zoom=1; orthographic.position.set(0,25,0); orthographic.lookAt(0,0,0);
    controls.target.set(0,0,0); orthographic.updateProjectionMatrix();
  } else {
    const extent=Math.max(SCALE,peak+base), distance=extent*1.55;
    perspective.position.set(distance*.7,center+distance*.60,distance*.75);
    controls.target.set(0,center,0);
  }
  controls.update();
}

function colorAt(value, palette, target=new THREE.Color()) {
  const ramp=ramps[palette];
  const scaled=clamp(value,0,1)*(ramp.length-1), index=Math.min(ramp.length-2,Math.floor(scaled));
  return target.copy(ramp[index]).lerp(ramp[index+1],scaled-index);
}

function options() {
  return {exaggeration:Number($('exaggeration').value),smoothing:0,base_percent:Number($('base').value),solid:true,size_mm:Number($('export-size').value),
    relief:$('relief-method').value,relief_strength:Number($('relief-strength').value)};
}

function disposeMesh(mesh) {
  if(!mesh) return;
  model.remove(mesh); mesh.geometry.dispose();
  if(mesh.material) mesh.material.dispose();
}

function buildScene(reset=false) {
  requestRender();
  if(!state.data) return;
  updateLegend(); drawProfile(); updateStats();
  if(!sceneReady) return;
  disposeMesh(topMesh); disposeMesh(baseMesh);
  topMesh=null; baseMesh=null;
  const data=state.data, {rows,columns,elevations}=data, opts=options();
  const surfaceColors=state.palette==='print'?printColors():null;
  const unit=SCALE/Math.max(data.width_m,data.height_m), width=data.width_m*unit, height=data.height_m*unit;
  const base=opts.solid?SCALE*opts.base_percent/100:0;
  const positions=new Float32Array(rows*columns*3),uvs=new Float32Array(rows*columns*2),colors=new Float32Array(rows*columns*3);
  // Colors and contours follow real elevations even when the model's heights are reshaped.
  const truth=data.true_elevations||elevations;
  const tempColor=new THREE.Color(), range=Math.max(data.max_m-data.min_m,1e-9);
  const palette=state.view==='elevation'?'elevation':state.palette;
  for(let row=0;row<rows;row++) for(let column=0;column<columns;column++) {
    const index=row*columns+column, value=elevations[index];
    positions[index*3]=(column/(columns-1)-.5)*width;
    positions[index*3+1]=(value-data.surface_min_m)*opts.exaggeration*unit+base;
    positions[index*3+2]=(row/(rows-1)-.5)*height;
    uvs[index*2]=column/(columns-1); uvs[index*2+1]=1-row/(rows-1);
    if(palette==='print')tempColor.set(surfaceColors.dirt).toArray(colors,index*3);
    else colorAt((truth[index]-data.min_m)/range,palette,tempColor).toArray(colors,index*3);
  }
  const indices=new Uint32Array((rows-1)*(columns-1)*6);
  let cursor=0;
  for(let row=0;row<rows-1;row++) for(let column=0;column<columns-1;column++) {
    const a=row*columns+column;
    indices.set([a,a+columns,a+1,a+1,a+columns,a+columns+1],cursor); cursor+=6;
  }
  let geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  geometry.setAttribute('elevation',new THREE.Float32BufferAttribute(truth,1));
  geometry.setIndex(new THREE.BufferAttribute(indices,1)); geometry.computeVertexNormals();
  if(palette==='print')geometry=paintSurface(geometry,surfaceColors,coverData);
  const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.93,metalness:0,wireframe:state.view==='wireframe'});
  material.onBeforeCompile=shader=>{
    shader.uniforms.showContours={value:$('contours').checked&&palette!=='print'?1:0};
    shader.uniforms.contourInterval={value:contourInterval(range)};
    shader.vertexShader='attribute float elevation; varying float vTerrainElevation;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvTerrainElevation = elevation;');
    shader.fragmentShader='varying float vTerrainElevation; uniform float showContours; uniform float contourInterval;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      float contourValue = vTerrainElevation / contourInterval;
      float contourDistance = abs(fract(contourValue + 0.5) - 0.5);
      float contourWidth = max(fwidth(contourValue), 0.005);
      float contourLine = 1.0 - smoothstep(contourWidth * 0.35, contourWidth * 0.95, contourDistance);
      diffuseColor.rgb *= 1.0 - contourLine * showContours * 0.2;`);
    material.userData.shader=shader;
  };
  material.customProgramCacheKey=()=> 'terrain-contours-v2';
  topMesh=new THREE.Mesh(geometry,material); topMesh.name='Terrain surface'; model.add(topMesh);
  if(opts.solid) {
    const rim=[];
    for(let row=0;row<rows;row++) rim.push(row*columns);
    for(let column=1;column<columns;column++) rim.push((rows-1)*columns+column);
    for(let row=rows-2;row>=0;row--) rim.push(row*columns+columns-1);
    for(let column=columns-2;column>0;column--) rim.push(column);
    const wallPositions=[],bottomPositions=[];
    for(let index=0;index<rim.length;index++) {
      const a=rim[index]*3,b=rim[(index+1)%rim.length]*3;
      const upperA=Array.from(positions.slice(a,a+3)),upperB=Array.from(positions.slice(b,b+3));
      const lowerA=[upperA[0],0,upperA[2]],lowerB=[upperB[0],0,upperB[2]];
      wallPositions.push(...upperA,...lowerA,...upperB,...upperB,...lowerA,...lowerB);
      bottomPositions.push(0,0,0,...lowerB,...lowerA);
    }
    const baseGeometry=new THREE.BufferGeometry();
    baseGeometry.setAttribute('position',new THREE.Float32BufferAttribute([...wallPositions,...bottomPositions],3)); baseGeometry.computeVertexNormals();
    const baseMaterial=new THREE.MeshStandardMaterial({color:state.palette==='print'?printColors().dirt:0x827254,roughness:1,wireframe:state.view==='wireframe'});
    baseMesh=new THREE.Mesh(baseGeometry,baseMaterial); baseMesh.name='Closed base'; model.add(baseMesh);
  }
  if(state.view==='map'&&mapTexture) applyMapMaterial();
  if(baseMesh) baseMesh.visible=state.view!=='elevation';
  rebuildFeatures();
  rebuildRoute();
  grid.visible=state.view!=='elevation';
  updateProfileMapLine();
  if(reset) resetCamera();
  $('scene-detail').textContent=`${columns} × ${rows} points · ${number((rows-1)*(columns-1)*2)} surface faces${rotationAngle(data.bounds)?` · ${number(rotationAngle(data.bounds),1)}° selection`:''}`;
  studio?.modelChanged();silhouette?.modelChanged();
}

function contourInterval(range) {
  const target=Math.max(range/18,1),power=10**Math.floor(Math.log10(target));
  return [1,2,5,10].find(value=>value*power>=target)*power;
}

function updateLegend() {
  const data=state.data;
  const palette=state.view==='elevation'?'elevation':state.palette;
  $('legend-low').textContent=`${number(data.min_m*units().height)} ${units().label} ASL`;
  $('legend-high').textContent=`${number(data.max_m*units().height)} ${units().label} ASL`;
  const mapped=palette==='print';
  document.querySelector('.elevation-legend').hidden=mapped;
  $('print-legend').hidden=!mapped;
  if(mapped) {
    $('print-legend').replaceChildren(...Object.entries(coverLabels).map(([key,label])=>{
      const item=document.createElement('span'),swatch=document.createElement('i');swatch.style.background=printColors()[key];item.append(swatch,label);return item;
    }));
  } else $('legend-gradient').style.background=`linear-gradient(90deg,${paletteStops[palette].join(',')})`;
  const descriptions={relief:state.palette==='print'?'MAPPED PRINT COLORS':`${state.palette.toUpperCase()} RELIEF`,map:state.mapStyle==='terrain'?'TOPOGRAPHIC MAP SURFACE':'OPENSTREETMAP SURFACE',wireframe:'TERRAIN WIREFRAME',elevation:'ELEVATION MAP'};
  $('scene-mode').textContent=descriptions[state.view];
  const angle=rotationAngle(data.bounds);
  $('scene-instructions').textContent=state.view==='elevation'?(angle?'Selection orientation · scroll to zoom':'North at top · scroll to zoom'):'Drag to orbit · scroll to zoom';
  document.querySelector('.north-arrow span:last-child').style.transform=`rotate(${-angle}deg)`;
  document.querySelector('.north-arrow').setAttribute('aria-label',`North is ${number(-angle,1)} degrees clockwise from the selection top`);
  $('profile-direction').options[0].textContent=angle?'Left → Right':'West → East';
  $('profile-direction').options[1].textContent=angle?'Top → Bottom':'North → South';
  $('map-attribution').hidden=state.view!=='map'||!mapTexture;
  $('map-feature-image-note').hidden=state.view!=='map';
}

function updateStats() {
  const data=state.data;
  // Source statistics remain comparable while the rendered geometry changes.
  for(const [id,value] of [['stat-low',data.min_m],['stat-high',data.max_m],['stat-range',data.max_m-data.min_m],['stat-spacing',data.grid_spacing_m]]) $(id).innerHTML=`${number(value*units().height)}<small> ${units().label}${['stat-low','stat-high'].includes(id)?' ASL':''}</small>`;
  $('landscape-title').textContent=state.loadedName||state.name;
}

const sourceHints={mapzen:'Global coverage; about 10 m detail in the US, 30 m elsewhere.',usgs3dep:'United States only. Lidar-derived, down to 1 m where surveyed; best for small areas.'};
const plainUrl=url=>String(url||'').replace(/^https?:\/\/(www\.)?/,'');

function updateElevationSource() {
  $('elevation-source-hint').textContent=sourceHints[$('elevation-source').value]||'';
}

function updateElevationCredit() {
  const link=$('elevation-credit');
  link.textContent=`${state.data.source} ↗`; link.href=state.data.source_url;
}

async function loadSurface(id, reset=false, loadedName=null) {
  const version=++state.surfaceVersion;
  const data=await api(`/api/terrain/${id}?relief=${$('relief-method').value}&relief_strength=${$('relief-strength').value}`);
  if(version!==state.surfaceVersion) return;
  const changedArea=state.id!==id;
  state.id=id; state.data=data;
  if(changedArea){
    if(!waterSourceChosen) {
      const b=data.bounds,lat=(b.north+b.south)/2,lon=(b.west+b.east)/2;
      // Initial regional default; users can select either source at any location.
      const us=(lon>=-125&&lon<=-66&&lat>=24&&lat<=49)||(lon>=-180&&lon<=-130&&lat>=51&&lat<=72)||(lon>=-161&&lon<=-154&&lat>=18&&lat<=23)||(lon>=-68&&lon<=-64&&lat>=17&&lat<=19);
      $('water-source').value=us?'usgs':'osm';
    }
    featureData=featureCache.get(`${id}:${$('water-source').value}`)||null;featureError=null;updateWaterSource();
  }
  if(changedArea){coverData=coverCache.get(id)||null;coverError=null;}
  if(loadedName) state.loadedName=loadedName;
  if(changedArea&&mapTexture) {mapTexture.dispose();mapTexture=null;}
  if(changedArea&&state.view==='map') await changeView('relief');
  buildScene(reset); updateExportDimensions(); updateElevationCredit();
  if(featuresEnabled())ensureFeatures().catch(()=>{});
  if(state.palette==='print')ensureCover().catch(()=>{});
  ensureRouteLines().catch(error=>routeMessage(error.message,true));
}

function printColors() {return Object.fromEntries(Object.keys(coverLabels).map(name=>[name,$(`print-${name}`).value]));}

function updatePrintPalette() {
  
  const surfaceCount=new Set(Object.values(printColors())).size;
  const count=new Set([...Object.values(printColors()),...Object.values(featureStyles()).filter(style=>style.enabled).map(style=>style.color),...routeColors()]).size;
  $('print-color-count').textContent=count<=4?`${count} distinct colors including enabled features · ready for a four-color printer.`:`${count} distinct colors including enabled features · share palette and feature colors to fit four filaments.`;
  $('print-color-count').classList.toggle('error',count>4);
  $('print-summary').textContent=`${surfaceCount} surface colors · ${count} total with enabled features.`;
  $('print-controls').hidden=state.palette!=='print';
  $('print-feature-color-count').hidden=state.palette!=='print';
  $('print-feature-color-count').textContent=`3MF: ${count} / 4 filament colors across surfaces and enabled features.`;
  $('print-feature-color-count').classList.toggle('error',count>4);
  $('contours').disabled=state.palette==='print';
  // A disabled button cannot explain itself on click, so the button says why 3MF is unavailable.
  // Add-on fill colors and marker balls from the design page project also need filaments.
  const printCount=new Set([...Object.values(printColors()),...Object.values(featureStyles()).filter(style=>style.enabled).map(style=>style.color),...routeColors(),...(studio?.extraColors()||[])]).size;
  const unavailable=state.palette!=='print'?'Select the Print palette to enable':printCount>4?`${printCount} colors · share colors to fit four filaments`:'';
  document.querySelector('[data-export="3mf"]').disabled=Boolean(unavailable);
  $('export-3mf-hint').textContent=unavailable||'Print palette · separate solid color parts';
  $('cover-status').classList.toggle('error',Boolean(coverError));
  $('cover-retry').hidden=!coverError;
  $('cover-status').textContent=coverError||(coverData?(Object.values(coverData.counts).some(count=>count>0)?'Mapped surface colors loaded.':'No mapped surface areas; using Dirt.'):(state.id?'Loading surface map…':'Generate terrain to load mapped surface colors.'));
}

async function ensureCover(force=false) {
  if(!state.id||state.palette!=='print')return null;
  const id=state.id;
  if(!force&&coverData)return coverData;
  if(coverRequest?.id===id)return coverRequest.promise;
  coverError=null;updatePrintPalette();
  const request={id};
  request.promise=(async()=>{
    try {
      await api(`/api/landcover/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      while(state.id===id) {
        const data=await api(`/api/landcover/${id}`);
        if(data.state==='error')throw new Error(data.message);
        if(data.state==='ready') {
          if(data.face_classes.length!==2*(state.data.rows-1)*(state.data.columns-1))throw new Error('Surface map does not match this terrain. Generate the area again.');
          coverCache.set(id,data);if(coverCache.size>4)coverCache.delete(coverCache.keys().next().value);
          if(state.id===id){coverData=data;coverError=null;if(state.palette==='print')buildScene();updatePrintPalette();}
          return data;
        }
        await new Promise(resolve=>setTimeout(resolve,650));
      }
      return null;
    } catch(error) {
      if(state.id===id){coverError=error.message;updatePrintPalette();}
      throw error;
    } finally {if(coverRequest===request)coverRequest=null;}
  })();
  coverRequest=request;return request.promise;
}

const featureGroups={boundaries:['borders','cities','parks'],trails:['at','trails']};

function featureStyles() {
  const closed=Object.entries(featureGroups).flatMap(([group,names])=>$(`group-${group}`).checked?[]:names);
  return Object.fromEntries(Object.keys(featureLabels).map(name=>[name,{enabled:$(`feature-${name}`).checked&&!closed.includes(name),color:$(`color-${name}`).value,
    ...(['roads','water'].includes(name)?{detail:Number($(`detail-${name}`).value)}:{}),
    ...(name==='water'?{source:$('water-source').value}:{}),
    ...(name==='buildings'?{detailed:$('buildings-detailed').checked}:{})}]));
}

function featuresEnabled() {return Object.values(featureStyles()).some(style=>style.enabled);}

function updateWaterSource() {
  const usgs=$('water-source').value==='usgs';
  $('water-source-hint').textContent=usgs?'US coverage: detailed creeks, rivers and lakes from USGS 3DHP, including legacy NHD.':'Global coverage from OpenStreetMap; creek coverage varies by location.';
  $('water-credit').hidden=!usgs;
}

function featureStatus() {
  
  const styles=featureStyles();
  const filtered=featureData?filterFeatures(featureData,styles,state.data):null;
  for(const name of Object.keys(featureLabels)) {
    const count=$(`feature-count-${name}`);
    count.textContent=filtered?(filtered.counts[name]===featureData.counts[name]||!['roads','water'].includes(name)?number(filtered.counts[name]):`${number(filtered.counts[name])} / ${number(featureData.counts[name])}`):'';
  }
  $('feature-status').classList.toggle('error',Boolean(featureError));
  $('feature-retry').hidden=!featureError||!featuresEnabled();
  if(!featuresEnabled())$('feature-status').textContent='Choose layers to show on the current terrain.';
  else if(featureError)$('feature-status').textContent=featureError;
  else if(featureRequest?.water&&!featureData?.waterLoaded)$('feature-status').textContent='Loading USGS waterways…';
  else if(featureData&&featureRequest?.buildings&&!featureData.buildingsLoaded)$('feature-status').textContent='Loading buildings…';
  else if(featureData) {
    const count=Object.entries(styles).reduce((total,[name,style])=>total+(style.enabled?filtered.counts[name]:0),0);
    $('feature-status').textContent=count?`${number(count)} mapped features shown.`:'No selected features are mapped in this area.';
  } else $('feature-status').textContent=state.id?'Loading map features…':'Generate terrain to add map features.';
}

function rebuildFeatures() {
  requestRender();
  disposeFeatures(featureGroup);featureGroup=null;
  if(sceneReady&&topMesh&&featureData&&featuresEnabled()) {
    try {featureGroup=buildFeatures(featureData,state.data,options(),featureStyles(),topMesh.geometry,SCALE);model.add(featureGroup);syncFeatureVisibility();}
    catch(error) {featureError=error.message;}
  }
  featureStatus();
  studio?.modelChanged();silhouette?.modelChanged();
}

function syncFeatureVisibility() {
  requestRender();
  if(!featureGroup)return;
  const styles=featureStyles();
  featureGroup.traverse(object=>{
    const category=object.userData.category;
    if(object.isMesh&&category)object.visible=styles[category]?.enabled===true;
  });
}

async function loadFeatureLayers(id,query='') {
  await api(`/api/features/${id}${query}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  while(true) {
    const result=await api(`/api/features/${id}${query}`);
    if(result.state==='error')throw new Error(result.message);
    if(result.state==='ready')return result;
    if(state.id!==id)return null;
    await new Promise(resolve=>setTimeout(resolve,650));
  }
}

// Buildings are the largest layer by far, so they download only once Buildings is checked.
async function ensureFeatures(force=false) {
  if(!state.id||!featuresEnabled())return null;
  const id=state.id,buildings=$('feature-buildings').checked,source=$('water-source').value;
  const water=$('feature-water').checked&&source==='usgs',key=`${id}:${source}`;
  if(!force&&featureData&&(!water||featureData.waterLoaded)&&(featureData.buildingsLoaded||!buildings))return featureData;
  if(featureRequest?.id===id&&featureRequest.source===source&&(featureRequest.water||!water)&&(featureRequest.buildings||!buildings))return featureRequest.promise;
  featureError=null;
  const request={id,buildings,source,water,promise:null};
  const show=result=>{
    if(featureRequest!==request)return;
    featureCache.set(key,result);if(featureCache.size>4)featureCache.delete(featureCache.keys().next().value);
    if(state.id===id&&$('water-source').value===source&&!(featureData?.buildingsLoaded&&!result.buildingsLoaded)&&!(featureData?.waterLoaded&&!result.waterLoaded)){featureData=result;featureError=null;rebuildFeatures();}
  };
  request.promise=(async()=>{
    try {
      let result=!force&&state.id===id&&featureData?featureData:await loadFeatureLayers(id);
      if(!result)return null;
      if(water&&!result.waterLoaded) {
        const sea=result.layers.water.filter(feature=>feature.kind==='sea');
        show({...result,layers:{...result.layers,water:sea},counts:{...result.counts,water:sea.length}});
        const part=await loadFeatureLayers(id,'?layer=water&source=usgs');
        if(!part)return null;
        const features=[...result.layers.water.filter(feature=>feature.kind==='sea'),...part.water];
        result={...result,layers:{...result.layers,water:features},counts:{...result.counts,water:features.length},waterLoaded:true,water_source:source,water_source_url:part.source_url};
      }
      if(buildings&&!result.buildingsLoaded) {
        show(result);
        const part=await loadFeatureLayers(id,'?layer=buildings');
        if(!part)return null;
        result={...result,layers:{...result.layers,buildings:part.layers.buildings},counts:{...result.counts,buildings:part.counts.buildings},buildingsLoaded:true};
      }
      show(result);
      return result;
    } catch(error) {
      if(featureRequest===request&&state.id===id&&$('water-source').value===source){featureError=error.message;featureStatus();}
      throw error;
    } finally {if(featureRequest===request){featureRequest=null;featureStatus();}}
  })();
  featureRequest=request;featureStatus();return request.promise;
}

async function generateTerrain() {
  if(state.loading) return;
  if(state.selectionError)return notify(state.selectionError,true);
  state.loading=true; $('generate').disabled=true; $('job-progress').hidden=false;
  $('progress').value=0; $('job-message').textContent='Preparing terrain…';
  const selectedName=state.name;
  try {
    const result=await api('/api/terrain',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds:state.selection,resolution:Number($('resolution').value),source:$('elevation-source').value})});
    let status;
    do {
      await new Promise(resolve=>setTimeout(resolve,450));
      status=await api(`/api/jobs/${result.id}`);
      $('progress').value=status.progress; $('job-message').textContent=status.message;
      if(status.state==='error') throw new Error(status.message);
    } while(status.state!=='ready');
    await loadSurface(result.id,true,selectedName);
    $('selection-state').textContent=sameBounds(state.selection,state.data.bounds)?'Terrain generated':'Generate to update';
    notify('Your terrain is ready. Explore the view or export your model.');
  } catch(error) { notify(error.message,true); $('job-message').textContent=error.message; }
  finally { state.loading=false; $('generate').disabled=Boolean(state.selectionError); if(state.data) setTimeout(()=>{$('job-progress').hidden=true;},1500); }
}

function captureMapTexture() {
  const bounds=state.data.bounds,zoom=Math.min(Math.round(map.getZoom()),mapLayer.options.maxNativeZoom);
  const extent=geographicExtent(bounds);
  if(!map.getBounds().contains(L.latLngBounds(boundsArray(extent)))) throw new Error('The model area must be visible on the map. Fit its area or return to its preset, then choose Map again.');
  const northwest=mercatorPixel(extent.west,extent.north,zoom),southeast=mercatorPixel(extent.east,extent.south,zoom);
  const x0=Math.floor(northwest.x/256),y0=Math.floor(northwest.y/256),x1=Math.floor((southeast.x-1e-8)/256),y1=Math.floor((southeast.y-1e-8)/256);
  const mosaic=document.createElement('canvas'); mosaic.width=(x1-x0+1)*256; mosaic.height=(y1-y0+1)*256;
  if(mosaic.width*mosaic.height>16_000_000) throw new Error('Zoom out slightly before applying the map surface.');
  const context=mosaic.getContext('2d');
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) {
    const tile=tileImages.get(`${zoom}/${((x%2**zoom)+2**zoom)%2**zoom}/${y}`);
    if(!tile||!tile.complete||!tile.naturalWidth) throw new Error('Wait for visible map tiles to finish loading, then choose Map again.');
    context.drawImage(tile,(x-x0)*256,(y-y0)*256,256,256);
  }
  const textureCanvas=document.createElement('canvas'),aspect=state.data.width_m/state.data.height_m;
  textureCanvas.width=aspect>=1?1024:Math.max(16,Math.round(1024*aspect));
  textureCanvas.height=aspect>=1?Math.max(16,Math.round(1024/aspect)):1024;
  const textureContext=textureCanvas.getContext('2d');
  if(rotationAngle(bounds)) {
    const corners=selectionCorners(bounds).map(p=>mercatorPixel(p.lng,p.lat,zoom)),origin=corners[0];
    const u={x:corners[1].x-origin.x,y:corners[1].y-origin.y},v={x:corners[3].x-origin.x,y:corners[3].y-origin.y};
    const determinant=u.x*v.y-u.y*v.x,w=textureCanvas.width,h=textureCanvas.height;
    const a=w*v.y/determinant,b=-h*u.y/determinant,c=-w*v.x/determinant,d=h*u.x/determinant;
    const sx=origin.x-x0*256,sy=origin.y-y0*256;
    textureContext.setTransform(a,b,c,d,-a*sx-c*sy,-b*sx-d*sy);
    textureContext.drawImage(mosaic,0,0);
  } else {
    for(let row=0;row<textureCanvas.height;row++) {
      const latitude=bounds.north+(bounds.south-bounds.north)*(row+.5)/textureCanvas.height;
      const sy=mercatorPixel(bounds.west,latitude,zoom).y-y0*256;
      textureContext.drawImage(mosaic,northwest.x-x0*256,clamp(sy,0,mosaic.height-1),southeast.x-northwest.x,1,0,row,textureCanvas.width,1);
    }
  }
  // Force a CORS check now, rather than failing asynchronously during WebGL upload.
  try { textureContext.getImageData(0,0,1,1); }
  catch { throw new Error('This map provider does not allow canvas textures. Choose another provider or a terrain palette.'); }
  const texture=new THREE.CanvasTexture(textureCanvas); texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),8);
  return texture;
}

function applyMapMaterial() {
  requestRender();
  if(!topMesh) return;
  topMesh.material.map=mapTexture;
  const colors=topMesh.geometry.getAttribute('color'); colors.array.fill(1); colors.needsUpdate=true;
  topMesh.material.needsUpdate=true;
}

async function changeView(view) {
  requestRender();
  if(view==='map') {
    if(!state.data||!sceneReady) return notify('Generate terrain and enable WebGL before using the map surface.',true);
    try { const texture=captureMapTexture(); if(mapTexture) mapTexture.dispose(); mapTexture=texture; }
    catch(error) { return notify(error.message,true); }
  }
  const wasElevation=state.view==='elevation';
  state.view=view;
  document.querySelectorAll('[data-view]').forEach(button=>{
    const active=button.dataset.view===view; button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active));
  });
  if(sceneReady) {
    camera=view==='elevation'?orthographic:perspective; controls.object=camera;
    controls.enableRotate=view!=='elevation'; controls.enablePan=view!=='elevation';
    $('rotate').disabled=view==='elevation';
    if(view==='elevation') { controls.autoRotate=false; $('rotate').setAttribute('aria-pressed','false'); }
  }
  buildScene(wasElevation!==(view==='elevation'));
}

function profileSamples() {
  const data=state.data;if(!data) return null;
  const {rows,columns}=data,elevations=data.true_elevations||data.elevations,horizontal=$('profile-direction').value==='ew';
  const fraction=Number($('profile-position').value)/100;
  const cross=fraction*(horizontal?rows-1:columns-1),a=Math.floor(cross),b=Math.min(a+1,horizontal?rows-1:columns-1),mix=cross-a;
  const count=horizontal?columns:rows;
  const values=Array.from({length:count},(_,index)=>{
    const first=horizontal?elevations[a*columns+index]:elevations[index*columns+a];
    const second=horizontal?elevations[b*columns+index]:elevations[index*columns+b];
    return first*(1-mix)+second*mix;
  });
  return {values,horizontal,fraction,distance:horizontal?data.width_m:data.height_m};
}

function updateProfileMapLine() {
  const profile=profileSamples(); if(!profile) return;
  const {horizontal,fraction}=profile,data=state.data;
  const bounds=data.bounds;
  const lineBounds=(horizontal?[[0,fraction],[1,fraction]]:[[fraction,0],[fraction,1]])
    .map(([u,v])=>sampleLocation(bounds,u,v)).map(p=>[p.lat,p.lng]);
  if(profileMapLine) map.removeLayer(profileMapLine);
  profileMapLine=L.polyline(lineBounds,{color:'#ffb354',weight:2,dashArray:'5 5',interactive:false}).addTo(map);

}

function drawProfile(pointer=null) {
  const canvas=$('profile'),rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const profile=profileSamples();if(!profile) return;
  const {values,distance,horizontal}=profile,width=rect.width,height=rect.height,left=49,right=16,top=16,bottom=25;
  const chartWidth=width-left-right,chartHeight=height-top-bottom;
  const minimum=Math.min(...values),maximum=Math.max(...values),range=Math.max(maximum-minimum,10);
  const low=minimum-range*.14,high=maximum+range*.16;
  const y=value=>top+(high-value)/(high-low)*chartHeight;
  ctx.font='9px "Segoe UI", Arial';ctx.lineWidth=1;
  for(let index=0;index<=3;index++) {
    const py=top+index/3*chartHeight,value=high-index/3*(high-low);
    ctx.strokeStyle='#3b4835';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(width-right,py);ctx.stroke();
    ctx.setLineDash([]);ctx.fillStyle='#b4b39a';ctx.textAlign='right';ctx.fillText(number(value*units().height),left-10,py+3);
  }
  const gradient=ctx.createLinearGradient(0,top,0,height-bottom);gradient.addColorStop(0,'#c3c87d70');gradient.addColorStop(1,'#58704715');
  ctx.beginPath();ctx.moveTo(left,height-bottom);
  values.forEach((value,index)=>ctx.lineTo(left+index/(values.length-1)*chartWidth,y(value)));
  ctx.lineTo(width-right,height-bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
  ctx.beginPath();values.forEach((value,index)=>{const px=left+index/(values.length-1)*chartWidth;index?ctx.lineTo(px,y(value)):ctx.moveTo(px,y(value));});
  ctx.strokeStyle='#e6d29b';ctx.lineWidth=1.8;ctx.stroke();
  const rotated=Boolean(rotationAngle(state.data.bounds)),start=horizontal?(rotated?'Left':'W'):(rotated?'Top':'N'),end=horizontal?(rotated?'Right':'E'):(rotated?'Bottom':'S');
  ctx.fillStyle='#b4b39a';ctx.textAlign='left';ctx.fillText(`${start} · 0 ${units().distanceLabel}`,left,height-6);
  ctx.textAlign='center';ctx.fillText(`${number(distance/(2*units().distance),1)} ${units().distanceLabel}`,left+chartWidth/2,height-6);
  ctx.textAlign='right';ctx.fillText(`${number(distance/units().distance,1)} ${units().distanceLabel} · ${end}`,width-right,height-6);
  $('profile-distance').textContent=`${number(distance/units().distance,2)} ${units().distanceLabel} across`;
  if(pointer!==null) {
    const fraction=clamp((pointer-left)/chartWidth,0,1),index=fraction*(values.length-1),a=Math.floor(index),b=Math.min(a+1,values.length-1);
    const value=values[a]*(1-(index-a))+values[b]*(index-a),px=left+fraction*chartWidth,py=y(value);
    ctx.strokeStyle='#d4b47d';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,height-bottom);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#ffedb9';ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();
    $('profile-tooltip').textContent=`${number(value*units().height,1)} ${units().label} ASL · ${number(fraction*distance/units().distance,2)} ${units().distanceLabel}`;
    $('profile-tooltip').style.left=`${clamp(px-60,2,width-145)}px`;$('profile-tooltip').hidden=false;
  }
}

function updateExportDimensions() {
  if(!state.data) return;
  const size=Number($('export-size').value),data=state.data,ratio=size/Math.max(data.width_m,data.height_m);
  const height=(data.surface_max_m-data.surface_min_m)*Number($('exaggeration').value)*ratio+size*Number($('base').value)/100;
  $('export-dimensions').textContent=`${number(data.width_m*ratio,1)} × ${number(data.height_m*ratio,1)} × ${number(height,1)} mm · closed solid`;
}

function download(blob,name) {
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}

async function exportGLB() {
  if(!sceneReady||!topMesh) throw new Error('GLB export requires the WebGL preview. STL and OBJ are available without it.');
  const group=new THREE.Group(),data=state.data,opts=options();
  group.name='Terrain Studio';
  group.userData={...data,elevations:undefined,true_elevations:undefined,model_options:opts,print_palette:state.palette==='print'?printColors():undefined,surface_source:state.palette==='print'?coverData.source:undefined,feature_layers:featureStyles(),water_source:$('water-source').value,mesh_units:'meters',axes:'X selection right, Y up, Z selection bottom',map_texture:'omitted; interactive viewing only',attribution:await fetch('/api/attribution').then(response=>response.text())};
  let geometry=topMesh.geometry.clone();geometry.deleteAttribute('elevation');
  if(state.palette==='print')geometry=paintSurface(geometry,printColors(),coverData);
  else {
    const colors=geometry.getAttribute('color'),color=new THREE.Color();
    for(let index=0;index<data.elevations.length;index++) colorAt(((data.true_elevations||data.elevations)[index]-data.min_m)/Math.max(data.max_m-data.min_m,1e-9),state.palette,color).toArray(colors.array,index*3);
    colors.needsUpdate=true;
  }
  const ownedMeshes=[new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.93}))];
  ownedMeshes[0].name='Terrain surface';
  if(baseMesh&&opts.solid) {
    const base=new THREE.Mesh(baseMesh.geometry.clone(),new THREE.MeshStandardMaterial({color:baseMesh.material.color,roughness:1}));
    base.name='Terrain base';ownedMeshes.push(base);
  }
  group.add(...ownedMeshes);
  if(featureGroup)group.add(featureGroup.clone(true));
  if(routeMesh)group.add(routeMesh.clone(true));
  group.scale.setScalar(opts.size_mm/SCALE/1000);
  try {
    const result=await new GLTFExporter().parseAsync(group,{binary:true,onlyVisible:true});
    download(new Blob([result],{type:'model/gltf-binary'}),'terrain.glb');
  } finally {ownedMeshes.forEach(mesh=>{mesh.geometry.dispose();mesh.material.dispose();});}
}

// Loads what a model export needs; the design page (print-studio.js) runs the export itself.
async function prepareExport(format,status=()=>{}) {
  await loadSurface(state.id);
  if(state.palette==='print'&&['glb','3mf'].includes(format)) {
    status('Loading mapped surface colors…');
    await ensureCover();if(coverError)throw new Error(coverError);
  }
  if(['glb','3mf'].includes(format)&&featuresEnabled()) {
    status('Loading selected map features…');
    await ensureFeatures();if(featureError)throw new Error(featureError);
  }
}

// ---------- Uploaded GPS route (GPX) ----------
// The route lives in geographic coordinates, so it stays on the ground as the frame moves or resizes.
const routeKey='terrain-route';
const routeShown=()=>Boolean(route)&&$('route-show').checked;
const routeColors=()=>routeShown()?[$('route-color').value.toLowerCase()]:[];
function routeOptions() {
  return routeShown()?{id:route.id,enabled:true,color:$('route-color').value.toLowerCase(),width_mm:Number($('route-width').value)}:undefined;
}
function routeMessage(text,error=false) {$('route-status').textContent=text;$('route-status').classList.toggle('error',error);}
function saveRoute() {
  try{localStorage.setItem(routeKey,JSON.stringify(route?{id:route.id,show:$('route-show').checked,color:$('route-color').value,width:Number($('route-width').value)}:null));}
  catch{/* Optional persistence. */}
}
function drawRouteOnMap() {
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  if(!map||!routeShown())return;
  routeLayer=L.polyline(route.display,{color:$('route-color').value,weight:2+Number($('route-width').value)*1.2,opacity:.92,interactive:false,lineCap:'round'}).addTo(map);
}
function rebuildRoute() {
  requestRender();
  if(routeMesh){disposeFeatures(routeMesh);routeMesh=null;}
  if(sceneReady&&topMesh&&state.data&&routeShown()&&routeLines?.length&&routeLinesKey===`${route.id}:${state.id}`) {
    routeMesh=buildRoute(routeLines,state.data,options(),$('route-color').value,Number($('route-width').value),SCALE);
    if(routeMesh)model.add(routeMesh);
  }
  studio?.modelChanged();silhouette?.modelChanged();
}
async function ensureRouteLines() {
  if(!route||!state.id)return;
  const key=`${route.id}:${state.id}`;
  if(key===routeLinesKey)return;
  const result=await api(`/api/routes/${route.id}/lines/${state.id}`);
  if(!route||key!==`${route.id}:${state.id}`)return;
  routeLines=result.lines;routeLinesKey=key;rebuildRoute();
  routeMessage(routeLines.length?'The route is draped on the model and included in exports.':'The route is outside the generated area. Use Frame the route, then Generate.');
}
function showRoute(data) {
  route=data;routeLines=null;routeLinesKey=null;
  $('route-controls').hidden=false;
  $('route-name').textContent=data.name;
  routeStats();
  $('route-width-value').textContent=`${Number($('route-width').value).toFixed(1)} mm`;
  drawRouteOnMap();saveRoute();updatePrintPalette();rebuildRoute();
  routeMessage(state.id?'Placing the route on the model…':'Generate terrain to drape the route on the model.');
  ensureRouteLines().catch(error=>routeMessage(error.message,true));
}
function routeStats() {
  if(!route)return;
  const u=units();
  $('route-stats').textContent=`${number(route.distance_m/u.distance,1)} ${u.distanceLabel} · ${number(route.gain_m*u.height)} ${u.label} climbing · ${number(route.points)} points`;
}
function routeStyleChanged() {
  $('route-width-value').textContent=`${Number($('route-width').value).toFixed(1)} mm`;
  drawRouteOnMap();saveRoute();updatePrintPalette();rebuildRoute();
  if(routeShown())ensureRouteLines().catch(error=>routeMessage(error.message,true));
}
function frameRoute() {
  if(!route)return;
  const {south,west,north,east}=route.bounds,pad=.08,minimum=.003;
  const latPad=Math.max((north-south)*pad,minimum),lonPad=Math.max((east-west)*pad,minimum/Math.cos((north+south)/2*Math.PI/180));
  try{updateSelection({south:south-latPad,west:west-lonPad,north:north+latPad,east:east+lonPad},true);routeMessage('The frame now surrounds the route. Generate to build it.');}
  catch(error){notify(error.message,true);}
}
async function uploadRoute(file) {
  if(!file)return;
  if(file.size>15e6)return routeMessage('GPX files must be under 15 MB.',true);
  $('route-upload').disabled=true;routeMessage(`Reading ${file.name}…`);
  try {
    const data=await api('/api/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gpx:await file.text(),filename:file.name})});
    $('route-show').checked=true;showRoute(data);
    // A route far from the current frame is framed automatically; nearby ones keep the user's frame.
    const b=route.bounds,frame=state.selection;
    if(!frame||b.east<Math.min(frame.west,frame.east)||b.west>Math.max(frame.west,frame.east)||b.north<frame.south||b.south>frame.north)frameRoute();
  } catch(error){routeMessage(error.message,true);}
  finally{$('route-upload').disabled=false;$('route-file').value='';}
}
function removeRoute() {
  route=null;routeLines=null;routeLinesKey=null;
  $('route-controls').hidden=true;drawRouteOnMap();rebuildRoute();saveRoute();updatePrintPalette();
  routeMessage('Overlay an activity exported as GPX from Strava, Garmin Connect, or COROS.');
}
async function restoreRoute() {
  let saved=null;
  try{saved=JSON.parse(localStorage.getItem(routeKey)||'null');}catch{saved=null;}
  if(!saved?.id||!/^[0-9a-f]{24}$/.test(saved.id))return;
  if(/^#[0-9a-f]{6}$/i.test(saved.color))$('route-color').value=saved.color;
  if(Number.isFinite(saved.width)&&saved.width>=.4&&saved.width<=6)$('route-width').value=saved.width;
  $('route-show').checked=saved.show!==false;
  try{showRoute(await api(`/api/routes/${saved.id}`));}
  catch{removeRoute();}
}
function wireRoute() {
  $('route-upload').addEventListener('click',()=>$('route-file').click());
  $('route-file').addEventListener('change',()=>uploadRoute($('route-file').files[0]));
  $('route-show').addEventListener('change',routeStyleChanged);
  $('route-color').addEventListener('input',routeStyleChanged);
  $('route-width').addEventListener('input',routeStyleChanged);
  $('route-frame').addEventListener('click',frameRoute);
  $('route-remove').addEventListener('click',removeRoute);
  restoreRoute();
}

// Everything the design page reads from the geography selection page; it never changes app state except through these inputs.
const studioContext={
  SCALE,
  get state(){return state;},
  get coverData(){return coverData;},
  get meshes(){return {topMesh,baseMesh,featureGroup,routeGroup:routeMesh};},
  options,printColors,featureStyles,featuresEnabled,routeOptions,notify,download,exportGLB,prepareExport,updatePrintPalette,updateExportDimensions,
};

// The silhouette design page reads even less: the slice controls it shares, the relief settings, units, colors, and the uploaded route.
const silhouetteContext={get state(){return state;},get route(){return route;},options,notify,download,units,printColors};

async function screenshot() {
  if(!sceneReady||!state.data) return notify('Generate a terrain preview first.',true);
  try {
    if(featuresEnabled()){await ensureFeatures();if(featureError)throw new Error(featureError);}
    if(state.palette==='print'){await ensureCover();if(coverError)throw new Error(coverError);}
  } catch(error){return notify(error.message,true);}
  renderer.render(scene,camera);
  const source=renderer.domElement,canvas=document.createElement('canvas'),ratio=source.width/$('scene-container').clientWidth;
  const mapped=featuresEnabled()||state.palette==='print';
  canvas.width=source.width;canvas.height=source.height+(mapped?86:72)*ratio;
  const context=canvas.getContext('2d');context.fillStyle='#142219';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(source,0,0);
  context.fillStyle='#ffeec3';context.font=`${13*ratio}px Georgia`;context.fillText(`${state.loadedName||state.name} · ${Number($('exaggeration').value).toFixed(1)}× elevation`,15*ratio,source.height+23*ratio);
  context.fillStyle='#b0ac95';context.font=`${8*ratio}px Arial`;
  context.fillText(`Elevation: ${state.data.source} · ${plainUrl(state.data.source_url)}`,15*ratio,source.height+42*ratio);
  const mapCredits=state.mapStyle==='terrain'?'© OpenStreetMap · SRTM · OpenTopoMap (CC-BY-SA)':'© OpenStreetMap contributors · openstreetmap.org/copyright';
  context.fillText(state.view==='map'?mapCredits:`Source credits: ${plainUrl(state.data.license_url)}`,15*ratio,source.height+56*ratio);
  if(mapped)context.fillText(`Map surfaces & features: © OpenStreetMap contributors${$('feature-water').checked&&$('water-source').value==='usgs'?' · Water: USGS 3DHP':''}`,15*ratio,source.height+70*ratio);
  canvas.toBlob(blob=>download(blob,'terrain-preview.png'),'image/png');
}

function updateSelectionParameters() {
  if(!state.selection)return;
  const bounds={...state.selection,rotation_deg:rotationAngle(state.selection)};
  // A complete Famous landscapes entry apart from its name: area, map zoom, and right-hand rendering settings.
  $('selection-parameters').value=JSON.stringify({bounds,zoom:map?Number(map.getZoom().toFixed(2)):undefined,settings:renderingSettings()},null,2);
  $('copy-selection-status').textContent='';
}

const styleDefaultsKey='terrain-style-defaults';
function styleInputs() {
  return [...document.querySelectorAll('#terrain-controls input[id], #terrain-controls select[id], #style-editor input[id], [data-print-color]')];
}
const controlValues=inputs=>Object.fromEntries(inputs.map(input=>[input.id,input.type==='checkbox'?input.checked:input.type==='range'?Number(input.value):input.value]));
// Only well-formed values for existing controls are applied; anything else keeps its current setting.
function applyControls(inputs,saved) {
  if(['alpine','earth','desert','print'].includes(saved?.palette))state.palette=saved.palette;
  for(const input of inputs) {
    const value=saved?.controls?.[input.id];
    if(input.tagName==='SELECT'){if([...input.options].some(option=>option.value===value))input.value=value;}
    else if(input.type==='checkbox'&&typeof value==='boolean')input.checked=value;
    else if(input.type==='color'&&/^#[0-9a-f]{6}$/i.test(value))input.value=value;
    else if(input.type==='range'&&typeof value==='number'&&Number.isFinite(value)&&value>=Number(input.min)&&value<=Number(input.max))input.value=value;
  }
  document.querySelectorAll('[data-palette]').forEach(button=>{
    const active=button.dataset.palette===state.palette;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  for(const name of ['roads','water'])$(`detail-${name}-value`).textContent=`${$(`detail-${name}`).value}%`;
}

// The right-hand column: palette, map features, their colors and detail, and the print palette.
function renderingInputs() {
  return [...document.querySelectorAll('#style-editor input[id], [data-print-color]')];
}
function renderingSettings() {
  return {palette:state.palette,controls:controlValues(renderingInputs())};
}
function applyRenderingSettings(settings) {
  if(!settings||typeof settings!=='object')return;
  applyControls(renderingInputs(),settings);
  // The feature checkboxes' own handler opens submenus, rebuilds layers, and fetches what is newly needed.
  $('feature-roads').dispatchEvent(new Event('change',{bubbles:true}));
  if(state.palette==='print'){if(state.view==='map')changeView('relief');ensureCover().catch(()=>{});}
  updatePrintPalette();buildScene();updateSelectionParameters();
}

function restoreStyleDefaults() {
  try {
    const saved=JSON.parse(localStorage.getItem(styleDefaultsKey)||'null');
    if(saved?.version===1) {
      applyControls(styleInputs(),saved);
      $('style-defaults-status').textContent='Your saved defaults are loaded.';
    }
  } catch { /* Invalid or unavailable local storage falls back to built-in defaults. */ }
  $('exaggeration-value').textContent=`${Number($('exaggeration').value).toFixed(1)}×`;
  $('base-value').textContent=`${$('base').value}%`;
  updateReliefControls();
  updateSelectionParameters();
}

function setUnits(value) {
  state.units=value==='m'?'m':'ft';
  document.querySelectorAll('[data-units]').forEach(button=>{
    const active=button.dataset.units===state.units;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  $('profile-units-note').textContent=`Heights in ${units().name} above sea level`;
  $('profile').setAttribute('aria-label',`Elevation cross section in ${units().name} above sea level`);
  if(state.selection)updateSelectionSize();
  if(state.data){updateLegend();updateStats();drawProfile();}
  routeStats();silhouette?.modelChanged();
}

const reliefHints={standard:'Every height is multiplied equally.',local:'Fine relief is amplified; broad landforms keep their height.',lowland:'Low ground gets a larger share of the model height.'};
function updateReliefControls() {
  const method=$('relief-method').value;
  $('relief-hint').textContent=reliefHints[method]||'';
  $('relief-strength-block').hidden=method==='standard';
  $('relief-strength-value').textContent=`${$('relief-strength').value}%`;
}
function reloadSurface() {
  updateReliefControls();
  if(state.id)loadSurface(state.id).catch(error=>notify(error.message,true));
}

function wireControls() {
  // Keep the copyable parameters in step with the rendering settings.
  for(const type of ['input','change','click'])for(const id of ['style-sidebar','print-palette-dialog'])$(id).addEventListener(type,updateSelectionParameters);
  $('relief-method').addEventListener('change',reloadSurface);
  $('relief-strength').addEventListener('input',updateReliefControls);
  $('relief-strength').addEventListener('change',reloadSurface);
  document.querySelectorAll('[data-units]').forEach(button=>button.addEventListener('click',()=>{
    try{localStorage.setItem('terrain-units',button.dataset.units);}catch{/* Optional persistence. */}
    setUnits(button.dataset.units);
  }));
  try{setUnits(localStorage.getItem('terrain-units'));}catch{setUnits('ft');}
  $('copy-selection').addEventListener('click',async event=>{
    event.preventDefault();  // the button sits in the summary; copying must not open or close the panel
    const field=$('selection-parameters');
    let copied=false;
    try { await navigator.clipboard.writeText(field.value); copied=true; }
    catch {
      // Clipboard access is unavailable on plain-HTTP LAN addresses; copy through a temporary field instead.
      const helper=document.createElement('textarea');
      helper.value=field.value;helper.setAttribute('readonly','');helper.style.cssText='position:fixed;top:0;left:0;opacity:0';
      document.body.append(helper);helper.select();
      try{copied=document.execCommand('copy');}catch{copied=false;}
      helper.remove();
    }
    if(copied) {
      $('copy-selection-label').textContent='Copied ✓';
      setTimeout(()=>{$('copy-selection-label').textContent='Copy';},1800);
      $('copy-selection-status').textContent='Parameters copied to the clipboard.';
    } else {
      $('copy-selection').closest('details').open=true;field.focus();field.select();
      $('copy-selection-status').textContent='Copying was blocked. The parameters are selected; press Ctrl+C.';
    }
  });
  $('save-style-defaults').addEventListener('click',()=>{
    const controls=controlValues(styleInputs());
    try {
      localStorage.setItem(styleDefaultsKey,JSON.stringify({version:1,palette:state.palette,controls}));
      $('style-defaults-status').textContent='Saved as defaults for this browser.';
    } catch {
      $('style-defaults-status').textContent='Unable to save defaults. Allow browser storage and try again.';
    }
  });
  document.querySelectorAll('[data-feature-detail]').forEach(input=>input.addEventListener('input',()=>{
    $(`detail-${input.dataset.featureDetail}-value`).textContent=`${input.value}%`;
    featureError=null;rebuildFeatures();
  }));
  try {
    const savedSource=localStorage.getItem('terrain-elevation-source');
    if(sourceHints[savedSource])$('elevation-source').value=savedSource;
  } catch { /* Saved source is optional. */ }
  updateElevationSource();
  try {
    const saved=localStorage.getItem('terrain-water-source');
    if(['osm','usgs'].includes(saved)){$('water-source').value=saved;waterSourceChosen=true;}
  } catch { /* Saved source is optional. */ }
  updateWaterSource();
  $('water-source').addEventListener('change',()=>{
    waterSourceChosen=true;
    try{localStorage.setItem('terrain-water-source',$('water-source').value);}catch{/* Optional persistence. */}
    featureData=featureCache.get(`${state.id}:${$('water-source').value}`)||null;featureError=null;
    updateWaterSource();rebuildFeatures();
    if(featuresEnabled())ensureFeatures().catch(()=>{});
  });
  $('elevation-source').addEventListener('change',()=>{
    try{localStorage.setItem('terrain-elevation-source',$('elevation-source').value);}catch{/* Optional persistence. */}
    updateElevationSource();
    if(state.data)$('selection-state').textContent=$('elevation-source').value===state.data.source_id&&sameBounds(state.selection,state.data.bounds)?'Terrain generated':'Generate to update';
  });
  try {
    const saved=JSON.parse(localStorage.getItem('terrain-print-palette')||'null');
    for(const name of Object.keys(coverLabels))if(/^#[0-9a-f]{6}$/i.test(saved?.[name]))$(`print-${name}`).value=saved[name];
  } catch { /* Saved colors are optional. */ }
  restoreStyleDefaults();
  updatePrintPalette();
  $('edit-print-palette').addEventListener('click',()=>$('print-palette-dialog').showModal());
  $('apply-print-palette').addEventListener('click',()=>$('print-palette-dialog').close());
  $('cover-retry').addEventListener('click',()=>ensureCover(true).catch(()=>{}));
  document.querySelectorAll('[data-print-color]').forEach(input=>input.addEventListener('input',()=>{
    try{localStorage.setItem('terrain-print-palette',JSON.stringify(printColors()));}catch{/* Optional persistence. */}
    updatePrintPalette();if(state.palette==='print')buildScene();
  }));
  const featuresChanged=()=>{
    $('building-options').hidden=!$('feature-buildings').checked;
    for(const [group,panel] of [['boundaries','boundary-options'],['trails','trail-options']]) {
      $(panel).hidden=!$(`group-${group}`).checked;$(`group-${group}`).setAttribute('aria-expanded',String($(`group-${group}`).checked));
    }
    syncFeatureVisibility();featureError=null;rebuildFeatures();updatePrintPalette();
    if(featuresEnabled())ensureFeatures().catch(()=>{});
  };
  document.querySelectorAll('[data-feature]').forEach(input=>input.addEventListener('change',featuresChanged));
  for(const [group,names] of Object.entries(featureGroups))$(`group-${group}`).addEventListener('change',event=>{
    // Opening a submenu with nothing chosen would show no change on the model.
    if(event.target.checked&&!names.some(name=>$(`feature-${name}`).checked))names.forEach(name=>{$(`feature-${name}`).checked=true;});
    featuresChanged();
  });
  $('buildings-detailed').addEventListener('change',featuresChanged);
  document.querySelectorAll('[data-feature-color]').forEach(input=>input.addEventListener('input',()=>{rebuildFeatures();updatePrintPalette();}));
  $('feature-retry').addEventListener('click',()=>ensureFeatures(true).catch(()=>{}));
  featuresChanged();
  featureStatus();
  $('generate').addEventListener('click',generateTerrain);
  $('help-button').addEventListener('click',()=>$('help-dialog').showModal());
  studio=createStudio(studioContext);
  $('export-button').addEventListener('click',()=>{if(!state.data)return notify('Generate terrain before exporting.',true);updateExportDimensions();updatePrintPalette();studio.open();});
  silhouette=createSilhouette(silhouetteContext);
  $('silhouette-button').addEventListener('click',()=>{if(!state.data)return notify('Generate terrain before designing a silhouette.',true);silhouette.open();});
  $('export-size').addEventListener('input',()=>{updateExportDimensions();rebuildRoute();});
  document.querySelectorAll('[data-palette]').forEach(button=>button.addEventListener('click',()=>{
    state.palette=button.dataset.palette;
    document.querySelectorAll('[data-palette]').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});
    if(state.palette==='print') {
      if(state.view==='map')changeView('relief');
      $('print-palette-dialog').showModal();ensureCover().catch(()=>{});
    }
    updatePrintPalette();buildScene();
  }));
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>changeView(button.dataset.view)));
  $('exaggeration').addEventListener('input',()=>{$('exaggeration-value').textContent=`${Number($('exaggeration').value).toFixed(1)}×`;buildScene();updateExportDimensions();});
  $('base').addEventListener('input',()=>{$('base-value').textContent=`${$('base').value}%`;buildScene();updateExportDimensions();});
  $('contours').addEventListener('change',()=>{if(topMesh?.material.userData.shader)topMesh.material.userData.shader.uniforms.showContours.value=$('contours').checked?1:0;});
  $('reset-camera').addEventListener('click',resetCamera);
  $('rotate').addEventListener('click',()=>{if(!sceneReady)return;controls.autoRotate=!controls.autoRotate;$('rotate').setAttribute('aria-pressed',String(controls.autoRotate));});
  $('screenshot').addEventListener('click',screenshot);
  $('profile-direction').addEventListener('change',()=>{drawProfile();updateProfileMapLine();});
  $('profile-position').addEventListener('input',()=>{$('profile-position-value').textContent=`${$('profile-position').value}%`;drawProfile();updateProfileMapLine();});
  $('profile').addEventListener('pointermove',event=>drawProfile(event.clientX-$('profile').getBoundingClientRect().left));
  $('profile').addEventListener('pointerleave',()=>{$('profile-tooltip').hidden=true;drawProfile();});
  new ResizeObserver(()=>drawProfile()).observe($('profile'));
  document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
}

async function init() {
  try {
    const config=await api('/api/config');
    Object.assign(presets,config.presets);
    const initialPlace=presets[config.default_place];
    state.selection={...initialPlace.bounds};state.name=initialPlace.name;
    $('place').value=config.default_place;
    setupMap(config); setupScene(); wireControls(); wireRoute();
    if(config.example_available) {
      state.loadedName=initialPlace.name;
      await loadSurface('example',true);
      $('selection-state').textContent='Bundled real terrain';
    } else { $('scene-empty').hidden=false; $('scene-detail').textContent='Select an area to begin'; }
    // The opening landscape brings its own rendering settings unless this browser has saved defaults.
    let savedDefaults=false;
    try{savedDefaults=localStorage.getItem(styleDefaultsKey)!==null;}catch{/* Storage is optional. */}
    if(!savedDefaults)applyRenderingSettings(initialPlace.settings);
  } catch(error) { notify(`Could not initialize Terrain Studio: ${error.message}`,true);console.error(error); }
}

init();
