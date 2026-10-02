import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFExporter } from './vendor/GLTFExporter.js';
import { SelectionFrame } from './map-frame.js';
import {rotationAngle,selectionCorners,sampleLocation,geographicExtent,mercatorPixel} from './selection-geometry.js';
import {buildFeatures,disposeFeatures,featureLabels,filterFeatures} from './feature-layers.js';
import {paintSurface,coverLabels} from './print-palette.js';

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
let toastTimer, sceneReady = false, lastMapError = 0;
let featureData=null,featureRequest=null,featureError=null,zipRequest=null;
const featureCache=new Map();
let coverData=null,coverRequest=null,coverError=null;
const coverCache=new Map();
const tileImages = new Map();
const SCALE = 6.4;
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

function updateSelection(bounds, fit=false, custom=true) {
  if(fit) {
    validateBounds(bounds);
    selectionFrame.fitBounds(bounds);
    if(custom){$('place').value='custom';state.name='Custom landscape';}
    return;
  }
  let error=null;
  try{validateBounds(bounds);}catch(problem){error=problem.message;}
  state.selection = {...bounds};
  state.selectionError=error;
  const {width,height} = dimensions(bounds);
  $('selection-size').textContent = `${number(width/1000,2)} × ${number(height/1000,2)} km`;
  $('selection-state').textContent = 'Area selected';
  if (custom) { $('place').value='custom'; state.name='Custom landscape'; }
  $('generate').disabled = state.loading||Boolean(error);
  $('selection-validation').textContent=error||'';
  $('selection-validation').hidden=!error;
  $('selection-frame').classList.toggle('invalid',Boolean(error));
  if (state.data && !sameBounds(bounds,state.data.bounds)) $('selection-state').textContent='Generate to update';
  if(error)$('selection-state').textContent='Adjust the area';
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
  updateSelection(state.selection,true,false);
  $('reset-frame').addEventListener('click',()=>selectionFrame.reset());
  $('place').addEventListener('change',event=>{
    const preset=presets[event.target.value];
    if(preset) { state.name=preset.name; updateSelection(preset.bounds,true,false); }
  });
  $('coordinate-form').addEventListener('submit',event=>{
    event.preventDefault();
    const parts=$('coordinates').value.trim().split(/[,\s]+/).filter(Boolean).map(Number);
    if(parts.length!==2||!parts.every(Number.isFinite)||Math.abs(parts[0])>85||Math.abs(parts[1])>180) return notify('Enter latitude, longitude, for example: 35.36, 138.73.',true);
    selectionFrame.cancelAlignment();map.setView(parts,12);
  });
  $('zip-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const zipcode=$('zip-code').value.trim();
    if(!/^[0-9]{5}(-[0-9]{4})?$/.test(zipcode))return notify('Enter a five-digit US ZIP code or ZIP+4.',true);
    zipRequest?.abort();const controller=new AbortController();zipRequest=controller;
    const button=$('zip-form').querySelector('button');button.disabled=true;
    $('zip-status').hidden=false;$('zip-status').classList.remove('error');$('zip-status').textContent='Finding ZIP code…';
    try {
      const location=await api(`/api/location/zip/${encodeURIComponent(zipcode)}`,{signal:controller.signal});
      if(zipRequest!==controller)return;
      state.name=`${location.city}, ${location.state} · ZIP ${location.zip}`;$('place').value='custom';
      selectionFrame.centerOn([location.latitude,location.longitude],12);
      $('zip-status').textContent=`${location.city}, ${location.state} · ZIP ${location.zip}`;
    } catch(error) {
      if(error.name==='AbortError'||zipRequest!==controller)return;
      $('zip-status').textContent=error.message;$('zip-status').classList.add('error');
    } finally {if(zipRequest===controller){zipRequest=null;button.disabled=false;}}
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
  let previous=performance.now();
  renderer.setAnimationLoop(now=>{
    const delta=Math.min((now-previous)/1000,.05); previous=now;
    controls.update(delta); renderer.render(scene,camera);
  });
}

function resizeScene() {
  if(!renderer) return;
  const width=$('scene-container').clientWidth,height=$('scene-container').clientHeight;
  if(!width||!height) return;
  renderer.setSize(width,height);
  perspective.aspect=width/height; perspective.updateProjectionMatrix();
  const half=4.35;
  orthographic.left=-half*width/height; orthographic.right=half*width/height;
  orthographic.top=half; orthographic.bottom=-half; orthographic.updateProjectionMatrix();
}

function updateSun() {
  const angle=Number($('sun').value)*Math.PI/180;
  $('sun-value').textContent=`${$('sun').value}°`;
  if(sun) sun.position.set(Math.sin(angle)*6,7,-Math.cos(angle)*6);
}

function resetCamera() {
  if(!sceneReady||!state.data) return;
  const unit=SCALE/Math.max(state.data.width_m,state.data.height_m);
  const peak=(state.data.surface_max_m-state.data.surface_min_m)*Number($('exaggeration').value)*unit;
  const base=$('solid').checked?SCALE*Number($('base').value)/100:0;
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
  return {exaggeration:Number($('exaggeration').value),smoothing:0,base_percent:Number($('base').value),solid:$('solid').checked,size_mm:Number($('export-size').value)};
}

function disposeMesh(mesh) {
  if(!mesh) return;
  model.remove(mesh); mesh.geometry.dispose();
  if(mesh.material) mesh.material.dispose();
}

function buildScene(reset=false) {
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
  const tempColor=new THREE.Color(), range=Math.max(data.surface_max_m-data.surface_min_m,1e-9);
  const palette=state.view==='elevation'?'elevation':state.palette;
  for(let row=0;row<rows;row++) for(let column=0;column<columns;column++) {
    const index=row*columns+column, value=elevations[index];
    positions[index*3]=(column/(columns-1)-.5)*width;
    positions[index*3+1]=(value-data.surface_min_m)*opts.exaggeration*unit+base;
    positions[index*3+2]=(row/(rows-1)-.5)*height;
    uvs[index*2]=column/(columns-1); uvs[index*2+1]=1-row/(rows-1);
    if(palette==='print')tempColor.set(surfaceColors.dirt).toArray(colors,index*3);
    else colorAt((value-data.surface_min_m)/range,palette,tempColor).toArray(colors,index*3);
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
  geometry.setAttribute('elevation',new THREE.Float32BufferAttribute(elevations,1));
  geometry.setIndex(new THREE.BufferAttribute(indices,1)); geometry.computeVertexNormals();
  if(palette==='print')geometry=paintSurface(geometry,surfaceColors,coverData);
  const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.93,metalness:0,flatShading:$('faceted').checked,wireframe:state.view==='wireframe'});
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
      float contourLine = 1.0 - smoothstep(contourWidth * 0.6, contourWidth * 1.4, contourDistance);
      diffuseColor.rgb *= 1.0 - contourLine * showContours * 0.42;`);
    material.userData.shader=shader;
  };
  material.customProgramCacheKey=()=> 'terrain-contours-v1';
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
  grid.visible=$('grid').checked&&state.view!=='elevation';
  updateProfileMapLine();
  if(reset) resetCamera();
  $('scene-detail').textContent=`${columns} × ${rows} points · ${number((rows-1)*(columns-1)*2)} surface faces${rotationAngle(data.bounds)?` · ${number(rotationAngle(data.bounds),1)}° selection`:''}`;
}

function contourInterval(range) {
  const target=Math.max(range/18,1),power=10**Math.floor(Math.log10(target));
  return [1,2,5,10].find(value=>value*power>=target)*power;
}

function updateLegend() {
  const data=state.data;
  const palette=state.view==='elevation'?'elevation':state.palette;
  $('legend-low').textContent=`${number(data.surface_min_m)} m`;
  $('legend-high').textContent=`${number(data.surface_max_m)} m`;
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
  for(const [id,value] of [['stat-low',data.min_m],['stat-high',data.max_m],['stat-range',data.max_m-data.min_m],['stat-spacing',data.grid_spacing_m]]) $(id).innerHTML=`${number(value)}<small> m</small>`;
  $('landscape-title').textContent=state.loadedName||state.name;
}

async function loadSurface(id, reset=false, loadedName=null) {
  const version=++state.surfaceVersion;
  const data=await api(`/api/terrain/${id}`);
  if(version!==state.surfaceVersion) return;
  const changedArea=state.id!==id;
  state.id=id; state.data=data;
  if(changedArea){featureData=featureCache.get(id)||null;featureError=null;}
  if(changedArea){coverData=coverCache.get(id)||null;coverError=null;}
  if(loadedName) state.loadedName=loadedName;
  if(changedArea&&mapTexture) {mapTexture.dispose();mapTexture=null;}
  if(changedArea&&state.view==='map') await changeView('relief');
  buildScene(reset); updateExportDimensions();
  if(featuresEnabled())ensureFeatures().catch(()=>{});
  if(state.palette==='print')ensureCover().catch(()=>{});
}

function updateStyleSummary() {
  const labels={alpine:'Alpine',earth:'Earth',desert:'Desert',print:'Print'};
  $('style-status-palette').textContent=labels[state.palette]||state.palette;
  $('style-status-elevation').textContent=`${Number($('exaggeration').value).toFixed(1)}×`;
  $('style-status-base').textContent=$('solid').checked?`Solid · ${$('base').value}%`:'Open surface';
  const styles=featureStyles(),selected=Object.entries(styles).filter(([,style])=>style.enabled);
  $('style-status-features').textContent=selected.length?selected.map(([name])=>featureLabels[name]).join(', '):'None selected';
  $('style-status-colors-row').hidden=state.palette!=='print';
  const count=new Set([...Object.values(printColors()),...selected.map(([,style])=>style.color)]).size;
  $('style-status-colors').textContent=`${count} / 4 colors${count>4?' · share colors to print':''}`;
  $('style-status-colors').classList.toggle('error',count>4);
}

function printColors() {return Object.fromEntries(Object.keys(coverLabels).map(name=>[name,$(`print-${name}`).value]));}

function updatePrintPalette() {
  updateStyleSummary();
  const surfaceCount=new Set(Object.values(printColors())).size;
  const count=new Set([...Object.values(printColors()),...Object.values(featureStyles()).filter(style=>style.enabled).map(style=>style.color)]).size;
  $('print-color-count').textContent=count<=4?`${count} distinct colors including enabled features · ready for a four-color printer.`:`${count} distinct colors including enabled features · share palette and feature colors to fit four filaments.`;
  $('print-color-count').classList.toggle('error',count>4);
  $('print-summary').textContent=`${surfaceCount} surface colors · ${count} total with enabled features.`;
  $('print-controls').hidden=state.palette!=='print';
  $('print-feature-color-count').hidden=state.palette!=='print';
  $('print-feature-color-count').textContent=`3MF: ${count} / 4 filament colors across surfaces and enabled features.`;
  $('print-feature-color-count').classList.toggle('error',count>4);
  $('contours').disabled=state.palette==='print';
  document.querySelector('[data-export="3mf"]').disabled=state.palette!=='print'||!$('solid').checked||count>4;
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

function featureStyles() {
  return Object.fromEntries(Object.keys(featureLabels).map(name=>[name,{enabled:$(`feature-${name}`).checked,color:$(`color-${name}`).value,
    ...(['roads','water'].includes(name)?{detail:Number($(`detail-${name}`).value)}:{})}]));
}

function featuresEnabled() {return Object.values(featureStyles()).some(style=>style.enabled);}

function featureStatus() {
  updateStyleSummary();
  const styles=featureStyles();
  const filtered=featureData?filterFeatures(featureData,styles,state.data):null;
  for(const name of Object.keys(featureLabels)) {
    const count=$(`feature-count-${name}`);
    count.textContent=filtered?(filtered.counts[name]===featureData.counts[name]?number(filtered.counts[name]):`${number(filtered.counts[name])} / ${number(featureData.counts[name])}`):'';
  }
  $('feature-status').classList.toggle('error',Boolean(featureError));
  $('feature-retry').hidden=!featureError||!featuresEnabled();
  if(!featuresEnabled())$('feature-status').textContent='Choose layers to show on the current terrain.';
  else if(featureError)$('feature-status').textContent=featureError;
  else if(featureData) {
    const count=Object.entries(styles).reduce((total,[name,style])=>total+(style.enabled?filtered.counts[name]:0),0);
    $('feature-status').textContent=count?`${number(count)} mapped features shown.`:'No selected features are mapped in this area.';
  } else $('feature-status').textContent=state.id?'Loading map features…':'Generate terrain to add map features.';
}

function rebuildFeatures() {
  disposeFeatures(featureGroup);featureGroup=null;
  if(sceneReady&&topMesh&&featureData&&featuresEnabled()) {
    try {featureGroup=buildFeatures(featureData,state.data,options(),featureStyles(),topMesh.geometry,SCALE);model.add(featureGroup);syncFeatureVisibility();}
    catch(error) {featureError=error.message;}
  }
  featureStatus();
}

function syncFeatureVisibility() {
  if(!featureGroup)return;
  const styles=featureStyles();
  featureGroup.traverse(object=>{
    const category=object.userData.category;
    if(object.isMesh&&category)object.visible=styles[category]?.enabled===true;
  });
}

async function ensureFeatures(force=false) {
  if(!state.id||!featuresEnabled())return null;
  const id=state.id;
  if(!force&&featureData)return featureData;
  if(featureRequest?.id===id)return featureRequest.promise;
  featureError=null;featureStatus();
  const request={id,promise:null};
  request.promise=(async()=>{
    try {
      await api(`/api/features/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      while(true) {
        const result=await api(`/api/features/${id}`);
        if(result.state==='error')throw new Error(result.message);
        if(result.state==='ready') {
          featureCache.set(id,result);if(featureCache.size>4)featureCache.delete(featureCache.keys().next().value);
          if(state.id===id){featureData=result;featureError=null;rebuildFeatures();}
          return result;
        }
        if(state.id!==id)return null;
        await new Promise(resolve=>setTimeout(resolve,650));
      }
    } catch(error) {
      if(state.id===id){featureError=error.message;featureStatus();}
      throw error;
    } finally {if(featureRequest===request)featureRequest=null;}
  })();
  featureRequest=request;return request.promise;
}

async function generateTerrain() {
  if(state.loading) return;
  if(state.selectionError)return notify(state.selectionError,true);
  state.loading=true; $('generate').disabled=true; $('job-progress').hidden=false;
  $('progress').value=0; $('job-message').textContent='Preparing terrain…';
  const selectedName=state.name;
  try {
    const result=await api('/api/terrain',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds:state.selection,resolution:Number($('resolution').value)})});
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
  if(!topMesh) return;
  topMesh.material.map=mapTexture;
  const colors=topMesh.geometry.getAttribute('color'); colors.array.fill(1); colors.needsUpdate=true;
  topMesh.material.needsUpdate=true;
}

async function changeView(view) {
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
  const {rows,columns,elevations}=data,horizontal=$('profile-direction').value==='ew';
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
    ctx.setLineDash([]);ctx.fillStyle='#b4b39a';ctx.textAlign='right';ctx.fillText(number(value),left-10,py+3);
  }
  const gradient=ctx.createLinearGradient(0,top,0,height-bottom);gradient.addColorStop(0,'#c3c87d70');gradient.addColorStop(1,'#58704715');
  ctx.beginPath();ctx.moveTo(left,height-bottom);
  values.forEach((value,index)=>ctx.lineTo(left+index/(values.length-1)*chartWidth,y(value)));
  ctx.lineTo(width-right,height-bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
  ctx.beginPath();values.forEach((value,index)=>{const px=left+index/(values.length-1)*chartWidth;index?ctx.lineTo(px,y(value)):ctx.moveTo(px,y(value));});
  ctx.strokeStyle='#e6d29b';ctx.lineWidth=1.8;ctx.stroke();
  const rotated=Boolean(rotationAngle(state.data.bounds)),start=horizontal?(rotated?'Left':'W'):(rotated?'Top':'N'),end=horizontal?(rotated?'Right':'E'):(rotated?'Bottom':'S');
  ctx.fillStyle='#b4b39a';ctx.textAlign='left';ctx.fillText(`${start} · 0 km`,left,height-6);
  ctx.textAlign='center';ctx.fillText(`${number(distance/2000,1)} km`,left+chartWidth/2,height-6);
  ctx.textAlign='right';ctx.fillText(`${number(distance/1000,1)} km · ${end}`,width-right,height-6);
  $('profile-distance').textContent=`${number(distance/1000,2)} km across`;
  if(pointer!==null) {
    const fraction=clamp((pointer-left)/chartWidth,0,1),index=fraction*(values.length-1),a=Math.floor(index),b=Math.min(a+1,values.length-1);
    const value=values[a]*(1-(index-a))+values[b]*(index-a),px=left+fraction*chartWidth,py=y(value);
    ctx.strokeStyle='#d4b47d';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,height-bottom);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#ffedb9';ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();
    $('profile-tooltip').textContent=`${number(value,1)} m · ${number(fraction*distance/1000,2)} km`;
    $('profile-tooltip').style.left=`${clamp(px-60,2,width-145)}px`;$('profile-tooltip').hidden=false;
  }
}

function updateExportDimensions() {
  if(!state.data) return;
  const size=Number($('export-size').value),data=state.data,ratio=size/Math.max(data.width_m,data.height_m);
  const height=(data.surface_max_m-data.surface_min_m)*Number($('exaggeration').value)*ratio+($('solid').checked?size*Number($('base').value)/100:0);
  $('export-dimensions').textContent=`${number(data.width_m*ratio,1)} × ${number(data.height_m*ratio,1)} × ${number(height,1)} mm · ${$('solid').checked?'closed solid':'open surface'}`;
}

function download(blob,name) {
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}

async function exportGLB() {
  if(!sceneReady||!topMesh) throw new Error('GLB export requires the WebGL preview. STL and OBJ are available without it.');
  const group=new THREE.Group(),data=state.data,opts=options();
  group.name='Terrain Studio';
  group.userData={...data,elevations:undefined,model_options:opts,print_palette:state.palette==='print'?printColors():undefined,surface_source:state.palette==='print'?coverData.source:undefined,feature_layers:featureStyles(),mesh_units:'meters',axes:'X selection right, Y up, Z selection bottom',map_texture:'omitted; interactive viewing only',attribution:await fetch('/api/attribution').then(response=>response.text())};
  let geometry=topMesh.geometry.clone();geometry.deleteAttribute('elevation');
  if(state.palette==='print')geometry=paintSurface(geometry,printColors(),coverData);
  else {
    const colors=geometry.getAttribute('color'),color=new THREE.Color();
    for(let index=0;index<data.elevations.length;index++) colorAt((data.elevations[index]-data.surface_min_m)/Math.max(data.surface_max_m-data.surface_min_m,1e-9),state.palette,color).toArray(colors.array,index*3);
    colors.needsUpdate=true;
  }
  const ownedMeshes=[new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.93,flatShading:$('faceted').checked}))];
  ownedMeshes[0].name='Terrain surface';
  if(baseMesh&&opts.solid) {
    const base=new THREE.Mesh(baseMesh.geometry.clone(),new THREE.MeshStandardMaterial({color:baseMesh.material.color,roughness:1}));
    base.name='Terrain base';ownedMeshes.push(base);
  }
  group.add(...ownedMeshes);
  if(featureGroup)group.add(featureGroup.clone(true));
  group.scale.setScalar(opts.size_mm/SCALE/1000);
  try {
    const result=await new GLTFExporter().parseAsync(group,{binary:true,onlyVisible:true});
    download(new Blob([result],{type:'model/gltf-binary'}),'terrain.glb');
  } finally {ownedMeshes.forEach(mesh=>{mesh.geometry.dispose();mesh.material.dispose();});}
}

async function exportModel(format) {
  if(!state.id) return notify('Generate terrain before exporting.',true);
  const opts=options();
  if(!Number.isFinite(opts.size_mm)||opts.size_mm<10||opts.size_mm>2000) return notify('Choose a model size between 10 and 2000 millimeters.',true);
  const buttons=[...document.querySelectorAll('[data-export]')];buttons.forEach(button=>button.disabled=true);
  $('export-status').textContent='Preparing your export…';
  try {
    await loadSurface(state.id);
    if(state.palette==='print'&&['glb','3mf'].includes(format)) {
      $('export-status').textContent='Loading mapped surface colors…';
      await ensureCover();if(coverError)throw new Error(coverError);
    }
    if(['glb','3mf'].includes(format)&&featuresEnabled()) {
      $('export-status').textContent='Loading selected map features…';
      await ensureFeatures();if(featureError)throw new Error(featureError);
    }
    if(format==='glb') {
      await exportGLB();
    }
    else {
      const response=await fetch(`/api/export/${state.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...opts,format,feature_layers:featureStyles(),print_palette:state.palette==='print'?printColors():undefined})});
      if(!response.ok) {const result=await response.json();throw new Error(result.error||'Export failed.');}
      const filename=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||`terrain.${format}`;
      download(await response.blob(),filename);
    }
    $('export-status').textContent='Your file has been downloaded.';
  } catch(error) { $('export-status').textContent=error.message;notify(error.message,true); }
  finally { buttons.forEach(button=>button.disabled=false);updatePrintPalette(); }
}

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
  context.fillText('Elevation: Mapzen / Tilezen Terrain Tiles · registry.opendata.aws/terrain-tiles',15*ratio,source.height+42*ratio);
  const mapCredits=state.mapStyle==='terrain'?'© OpenStreetMap · SRTM · OpenTopoMap (CC-BY-SA)':'© OpenStreetMap contributors · openstreetmap.org/copyright';
  context.fillText(state.view==='map'?mapCredits:'Source credits: github.com/tilezen/joerd/blob/master/docs/attribution.md',15*ratio,source.height+56*ratio);
  if(mapped)context.fillText('Map surfaces & features: © OpenStreetMap contributors · openstreetmap.org/copyright',15*ratio,source.height+70*ratio);
  canvas.toBlob(blob=>download(blob,'terrain-preview.png'),'image/png');
}

function wireControls() {
  $('edit-style').addEventListener('click',()=>{
    const bounds=state.selection?{...state.selection}:null;
    const expanded=$('edit-style').getAttribute('aria-expanded')!=='true';
    $('edit-style').setAttribute('aria-expanded',String(expanded));
    $('edit-style').textContent=expanded?'Done ✓':'Edit ↗';
    $('style-editor').hidden=!expanded;$('style-summary').hidden=expanded;
    $('style-sidebar').classList.toggle('editing',expanded);updateStyleSummary();
    if(selectionFrame&&bounds)selectionFrame.resizeViewport(bounds);
  });
  $('style-editor').addEventListener('input',updateStyleSummary);
  $('style-editor').addEventListener('change',updateStyleSummary);
  document.querySelectorAll('[data-feature-detail]').forEach(input=>input.addEventListener('input',()=>{
    $(`detail-${input.dataset.featureDetail}-value`).textContent=`${input.value}%`;
    featureError=null;rebuildFeatures();
  }));
  try {
    const saved=JSON.parse(localStorage.getItem('terrain-print-palette')||'null');
    for(const name of Object.keys(coverLabels))if(/^#[0-9a-f]{6}$/i.test(saved?.[name]))$(`print-${name}`).value=saved[name];
  } catch { /* Saved colors are optional. */ }
  updatePrintPalette();
  $('edit-print-palette').addEventListener('click',()=>$('print-palette-dialog').showModal());
  $('apply-print-palette').addEventListener('click',()=>$('print-palette-dialog').close());
  $('cover-retry').addEventListener('click',()=>ensureCover(true).catch(()=>{}));
  document.querySelectorAll('[data-print-color]').forEach(input=>input.addEventListener('input',()=>{
    try{localStorage.setItem('terrain-print-palette',JSON.stringify(printColors()));}catch{/* Optional persistence. */}
    updatePrintPalette();if(state.palette==='print')buildScene();
  }));
  document.querySelectorAll('[data-feature]').forEach(input=>input.addEventListener('change',()=>{
    syncFeatureVisibility();featureError=null;rebuildFeatures();updatePrintPalette();
    if(featuresEnabled())ensureFeatures().catch(()=>{});
  }));
  document.querySelectorAll('[data-feature-color]').forEach(input=>input.addEventListener('input',()=>{rebuildFeatures();updatePrintPalette();}));
  $('feature-retry').addEventListener('click',()=>ensureFeatures(true).catch(()=>{}));
  featureStatus();
  $('generate').addEventListener('click',generateTerrain);
  $('help-button').addEventListener('click',()=>$('help-dialog').showModal());
  $('export-button').addEventListener('click',()=>{if(!state.data)return notify('Generate terrain before exporting.',true);updateExportDimensions();updatePrintPalette();$('export-dialog').showModal();});
  document.querySelectorAll('[data-export]').forEach(button=>button.addEventListener('click',()=>exportModel(button.dataset.export)));
  $('export-size').addEventListener('input',updateExportDimensions);
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
  for(const id of ['solid','faceted','grid']) $(id).addEventListener('change',()=>{buildScene();updateExportDimensions();});
  $('solid').addEventListener('change',()=>{$('base').disabled=!$('solid').checked;updatePrintPalette();});
  $('contours').addEventListener('change',()=>{if(topMesh?.material.userData.shader)topMesh.material.userData.shader.uniforms.showContours.value=$('contours').checked?1:0;});
  $('sun').addEventListener('input',updateSun);
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
    setupMap(config); setupScene(); wireControls();
    if(config.example_available) {
      state.loadedName=initialPlace.name;
      await loadSurface('example',true);
      $('selection-state').textContent='Bundled real terrain';
    } else { $('scene-empty').hidden=false; $('scene-detail').textContent='Select an area to begin'; }
  } catch(error) { notify(`Could not initialize Terrain Studio: ${error.message}`,true);console.error(error); }
}

init();
