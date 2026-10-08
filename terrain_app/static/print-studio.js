/* Print Studio: a full-page export workspace with parametric add-ons placed on the model.
 * app.js hands over a context object (see studioContext there); everything else lives here.
 * Coordinates follow the shared contract: u left→right, v top→bottom in [0,1]; sizes in model millimeters.
 */
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';

const $=id=>document.getElementById(id);
const STORE_PREFIX='terrain-studio-projects:v1:';
const BED_KEY='terrain-studio-bed';
const CUT_COLOR=0xe2643f, RING_COLOR=0xf3d592, DEFAULT_BALL='#c0392b';
const TOP_CLEARANCE=3;  // ghost cutters rise this far (mm) above the surface so their mouth is visible
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const number=(value,decimals=1)=>Number(value).toLocaleString(undefined,{maximumFractionDigits:decimals});
const rad=degrees=>degrees*Math.PI/180;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const isHex=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const formatsWithProject=['stl','obj','3mf','glb','metadata'];

async function errorMessage(response) {
  try { return (await response.json()).error||`Request failed (${response.status}).`; }
  catch { return `Request failed (${response.status}).`; }
}
// A route the server does not have answers with Flask's HTML 404; the real endpoints answer with JSON errors.
const missingRoute=response=>(response.status===404||response.status===405)&&!(response.headers.get('Content-Type')||'').includes('json');
const postJSON=(url,body,signal)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
const filenameOf=(response,fallback)=>response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||fallback;

function hash(text) {
  let value=0x811c9dc5;
  for(let index=0;index<text.length;index++){value^=text.charCodeAt(index);value=Math.imul(value,0x01000193);}
  return (value>>>0).toString(16).padStart(8,'0');
}

function outlineShape(kind,width,length,radius=0) {
  const shape=new THREE.Shape(),w=width/2,l=length/2;
  if(kind==='oval'){shape.absellipse(0,0,w,l,0,Math.PI*2,false,0);return shape;}
  const r=kind==='rounded'?clamp(radius,0,Math.min(w,l)):0;
  shape.moveTo(-w+r,-l);shape.lineTo(w-r,-l);if(r)shape.quadraticCurveTo(w,-l,w,-l+r);
  shape.lineTo(w,l-r);if(r)shape.quadraticCurveTo(w,l,w-r,l);
  shape.lineTo(-w+r,l);if(r)shape.quadraticCurveTo(-w,l,-w,l-r);
  shape.lineTo(-w,-l+r);if(r)shape.quadraticCurveTo(-w,-l,-w+r,-l);
  return shape;
}

// Shapes are drawn in the add-on's local x/y plane (mm); extruded upward from bottom to top in model millimeters.
function prism(shapes,bottom,top) {
  const geometry=new THREE.ExtrudeGeometry(shapes,{depth:Math.max(top-bottom,.05),bevelEnabled:false,curveSegments:16});
  geometry.rotateX(-Math.PI/2);geometry.translate(0,bottom,0);return geometry;
}
function column(radius,bottom,top,tilt=0,x=0,pivot=0) {
  const height=Math.max(top-bottom,.05),geometry=new THREE.CylinderGeometry(radius,radius,height,32);
  geometry.translate(0,bottom-pivot+height/2,0);
  if(tilt)geometry.rotateX(-rad(tilt));
  geometry.translate(x,pivot,0);return geometry;
}
function slab(width,depth,bottom,top,tilt=0,pivot=0) {
  const height=Math.max(top-bottom,.05),geometry=new THREE.BoxGeometry(width,height,depth);
  geometry.translate(0,bottom-pivot+height/2,0);
  if(tilt)geometry.rotateX(-rad(tilt));
  geometry.translate(0,pivot,0);return geometry;
}

export function createStudio(ctx) {
  const dialog=$('studio');
  let catalog=null,catalogError=null,catalogRequest=null;
  let storeKey=null,store=null,project=null,studioRoutes=true;
  let selectedId=null,placing=null,dragging=null,pendingBefore=null,previewing=null;
  const hidden=new Set(),undoStack=[],redoStack=[],outlines=new Map();
  let renderer=null,scene,perspective,orthographic,camera,controls,terrainGroup,ghostGroup,previewGroup,ring=null,terrainMesh=null;
  let frame=null,dirtyModel=true,renderUntil=0,cameraMode='perspective',xray=false,section=false;
  let profileOn=false,profileCut=false,profileMode='model',profileLine=null,profileData=null;
  const clipping=()=>section||profileCut;
  let checkTimer=null,checkRequest=null,checkResults={checks:[],addons:[]},lastFitKey=null,busy=false,saveFailed=false;
  const clipPlane=new THREE.Plane(new THREE.Vector3(0,0,-1),0);

  // ---------- model frame: sizes, heights, conversions ----------
  function computeFrame() {
    const data=ctx.state.data;if(!data)return null;
    const opts=ctx.options(),size=Number.isFinite(opts.size_mm)&&opts.size_mm>=10?opts.size_mm:180;
    const unit=ctx.SCALE/Math.max(data.width_m,data.height_m),mmUnit=ctx.SCALE/size;
    const base=ctx.SCALE*opts.base_percent/100;
    return {data,unit,mmUnit,size,width:data.width_m*unit,height:data.height_m*unit,W:data.width_m*unit/mmUnit,H:data.height_m*unit/mmUnit,
      rows:data.rows,columns:data.columns,exaggeration:opts.exaggeration,base,baseMm:base/mmUnit,
      peak:(data.surface_max_m-data.surface_min_m)*opts.exaggeration*unit+base};
  }
  // Model height (mm above the bottom) at u,v, bilinear on the same grid the preview draws.
  function heightMm(u,v) {
    const f=frame,d=f.data,elevations=d.elevations;
    const x=clamp(u,0,1)*(f.columns-1),y=clamp(v,0,1)*(f.rows-1);
    const c=Math.min(f.columns-2,Math.floor(x)),r=Math.min(f.rows-2,Math.floor(y)),fx=x-c,fy=y-r,i=r*f.columns+c;
    const value=elevations[i]*(1-fx)*(1-fy)+elevations[i+1]*fx*(1-fy)+elevations[i+f.columns]*(1-fx)*fy+elevations[i+f.columns+1]*fx*fy;
    return ((value-d.surface_min_m)*f.exaggeration*f.unit+f.base)/f.mmUnit;
  }
  const toMm=(u,v)=>({x:(u-.5)*frame.W,y:(.5-v)*frame.H});
  const toUV=(x,y)=>({u:x/frame.W+.5,v:.5-y/frame.H});
  function localToUV(addon,lx,ly) {
    const angle=rad(addon.rotation_deg||0),center=toMm(addon.u,addon.v);
    return toUV(center.x+lx*Math.cos(angle)-ly*Math.sin(angle),center.y+lx*Math.sin(angle)+ly*Math.cos(angle));
  }
  function footprintStats(addon,hx,hy) {
    let min=Infinity,max=-Infinity,sum=0,count=0;
    for(let i=0;i<=6;i++)for(let j=0;j<=6;j++) {
      const {u,v}=localToUV(addon,(i/6-.5)*2*hx,(j/6-.5)*2*hy),h=heightMm(u,v);
      min=Math.min(min,h);max=Math.max(max,h);sum+=h;count++;
    }
    return {min,max,mean:sum/count};
  }
  function highestPoint(near=null,radiusMm=12) {
    const f=frame,e=f.data.elevations;let best=-Infinity,index=0;
    for(let r=0;r<f.rows;r++)for(let c=0;c<f.columns;c++) {
      if(near){const p=toMm(c/(f.columns-1),r/(f.rows-1));if(Math.hypot(p.x-near.x,p.y-near.y)>radiusMm)continue;}
      const k=r*f.columns+c;if(e[k]>best){best=e[k];index=k;}
    }
    return {u:(index%f.columns)/(f.columns-1),v:Math.floor(index/f.columns)/(f.rows-1)};
  }

  // ---------- catalog ----------
  async function loadCatalog() {
    if(catalog||!studioRoutes)return catalog;
    if(catalogRequest)return catalogRequest;
    catalogRequest=(async()=>{
      try {
        const response=await fetch('/api/studio/catalog');
        if(missingRoute(response)){studioRoutes=false;throw new Error('Add-ons need the updated Terrain Studio server (no /api/studio/catalog). “Print as is” exports still work.');}
        if(!response.ok)throw new Error(await errorMessage(response));
        catalog=await response.json();catalogError=null;
        if(isHex(catalog.marker_ball?.color))$('studio-marker-color').value=catalog.marker_ball.color;
      } catch(error){catalogError=error.message;}
      finally{catalogRequest=null;}
      renderPalette();renderTemplates();renderMarker();renderSettings();
      return catalog;
    })();
    return catalogRequest;
  }
  const typeInfo=type=>catalog?.types?.[type]||null;
  const typeLabel=type=>typeInfo(type)?.label||type.replace(/_/g,' ');
  function defaults(type) {
    const params=typeInfo(type)?.params||{};
    const result=Object.fromEntries(Object.entries(params).map(([name,spec])=>[name,spec.default]));
    if(type==='nail_marker') {  // the nail's exposed length under the chosen marker, so it sits on the surface
      const exposed=markerInfo()?.exposed_nail_length;
      if(exposed&&(result.depth==null||project?.marker_balls.style==='platform'))result.depth=exposed;
    }
    return result;
  }
  // Values the server accepts: numbers within the catalog range (whole numbers for integer parameters).
  function fitParam(spec,value) {
    if(!spec||typeof value!=='number')return value;
    let result=clamp(value,spec.min??-Infinity,spec.max??Infinity);
    if(spec.type==='integer'||(!spec.type&&Number.isInteger(spec.default)&&spec.step===1))result=Math.round(result);
    return result;
  }
  function fitParams(addon) {
    for(const [name,spec] of Object.entries(typeInfo(addon.type)?.params||{}))addon.params[name]=fitParam(spec,addon.params[name]??spec.default);
    return addon;
  }
  // Add-ons that add material carry a filament color (null = the Print palette's dirt color).
  function addsMaterial(addon) {
    const p=addon.params||{};
    if(addon.type==='plaque')return p.mode==='level'||p.mode==='raise'||(Boolean(String(p.text||'').trim())&&p.text_style==='emboss');
    if(addon.type==='text')return p.text_style!=='deboss';
    return false;
  }
  const canColor=addon=>['plaque','text'].includes(addon.type)||['fill','mixed'].includes(typeInfo(addon.type)?.kind);

  // ---------- projects ----------
  const markerDefaults=color=>({include:false,color,style:'ball',top:'none',top_color:null,top_area_mm:30,top_exaggeration:null});
  const emptyProject=name=>({id:`p${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`,version:1,name,addons:[],marker_balls:markerDefaults($('studio-marker-color').value||DEFAULT_BALL)});
  const platformStyle=()=>project?.marker_balls.style==='platform';
  const markerInfo=()=>platformStyle()&&catalog?.marker_platform?catalog.marker_platform:catalog?.marker_ball;
  function areaKey() {
    const b=ctx.state.data.bounds;
    const key=JSON.stringify({bounds:['north','south','east','west'].map(name=>Number(b[name]).toFixed(6)),rotation:Number(b.rotation_deg||0).toFixed(4)});
    return STORE_PREFIX+hash(key);
  }
  function sanitize(input,keepId=false) {
    if(!input||typeof input!=='object'||!Array.isArray(input.addons))throw new Error('This file is not a Print Studio project.');
    const result=emptyProject(typeof input.name==='string'&&input.name.trim()?input.name.trim().slice(0,80):'Imported project');
    if(keepId&&typeof input.id==='string')result.id=input.id;
    result.addons=input.addons.filter(addon=>addon&&typeof addon.type==='string'&&(!catalog||typeInfo(addon.type))).slice(0,200).map((addon,index)=>{
      const params={...defaults(addon.type)},specs=typeInfo(addon.type)?.params;
      for(const [name,value] of Object.entries(addon.params||{})) {
        if(specs&&!specs[name])continue;
        const spec=specs?.[name];
        if(typeof value==='number'&&Number.isFinite(value))params[name]=fitParam(spec,value);
        else if(typeof value==='string')params[name]=spec?.choices&&!spec.choices.includes(value)?params[name]:value.slice(0,spec?.max_length||60);
        else if(typeof value==='boolean')params[name]=value;
      }
      return {id:typeof addon.id==='string'&&addon.id?addon.id.slice(0,24):`a${index+1}`,type:addon.type,
        u:clamp(Number(addon.u)||.5,0,1),v:clamp(Number(addon.v)||.5,0,1),rotation_deg:Number.isFinite(Number(addon.rotation_deg))?Number(addon.rotation_deg)%360:0,
        params,color:isHex(addon.color)?addon.color.toLowerCase():null};
    });
    const ids=new Set();result.addons.forEach(addon=>{if(ids.has(addon.id))addon.id=nextId(result.addons);ids.add(addon.id);});
    const balls=input.marker_balls||{};
    const area=Number(balls.top_area_mm),exaggeration=Number(balls.top_exaggeration);
    result.marker_balls={...markerDefaults(isHex(balls.color)?balls.color.toLowerCase():DEFAULT_BALL),include:balls.include===true,
      style:balls.style==='platform'?'platform':'ball',top:['terrain','building'].includes(balls.top)?balls.top:'none',
      top_color:isHex(balls.top_color)?balls.top_color.toLowerCase():null,top_area_mm:Number.isFinite(area)?clamp(area,10,80):30,
      top_exaggeration:balls.top_exaggeration!=null&&Number.isFinite(exaggeration)?clamp(exaggeration,.5,20):null};
    return result;
  }
  function loadStore() {
    const key=areaKey();
    if(key===storeKey&&store)return;
    storeKey=key;store=null;
    try {
      const saved=JSON.parse(localStorage.getItem(key)||'null');
      if(saved&&Array.isArray(saved.projects)&&saved.projects.length) {
        const projects=saved.projects.map(item=>{try{return sanitize(item,true);}catch{return null;}}).filter(Boolean);
        if(projects.length)store={active:projects.some(item=>item.id===saved.active)?saved.active:projects[0].id,projects};
      }
    } catch { /* Storage is optional; fall back to a fresh project. */ }
    if(!store){const first=emptyProject('Print as is');store={active:first.id,projects:[first]};}
    activate(store.active);
  }
  function save() {
    try{localStorage.setItem(storeKey,JSON.stringify(store));saveFailed=false;}
    catch{saveFailed=true;}
  }
  function activate(id) {
    project=store.projects.find(item=>item.id===id)||store.projects[0];store.active=project.id;
    selectedId=null;placing=null;undoStack.length=0;redoStack.length=0;hidden.clear();exitPreview();
    syncMarker();
  }
  const payload=()=>project?{version:1,name:project.name,addons:project.addons.map(addon=>({...clone(addon)})),marker_balls:{...project.marker_balls}}:null;
  const hasContent=()=>Boolean(project&&(project.addons.length||project.marker_balls.include));
  function nextId(addons=project.addons) {
    const used=addons.map(addon=>Number(String(addon.id).replace(/^a/,''))).filter(Number.isFinite);
    return `a${(used.length?Math.max(...used):0)+1}`;
  }

  // ---------- history ----------
  const snapshot=()=>JSON.stringify({addons:project.addons,marker_balls:project.marker_balls,name:project.name});
  function restore(text) {
    const value=JSON.parse(text);project.addons=value.addons;project.marker_balls=value.marker_balls;project.name=value.name;
    if(selectedId&&!project.addons.some(addon=>addon.id===selectedId))selectedId=null;
    syncMarker();
  }
  function commit(before,options) {
    if(before!=null&&before!==snapshot()){undoStack.push(before);if(undoStack.length>100)undoStack.shift();redoStack.length=0;}
    save();changed(options);
  }
  function mutate(change) {const before=snapshot();change();commit(before);}
  function undo() {if(!undoStack.length)return;redoStack.push(snapshot());restore(undoStack.pop());save();changed();}
  function redo() {if(!redoStack.length)return;undoStack.push(snapshot());restore(redoStack.pop());save();changed();}

  // Called after every change to the project: redraw ghosts, lists and forms; recheck; update the 3MF color count.
  function changed({form=true}={}) {
    exitPreview();
    rebuildGhosts();renderList();renderProjects();if(form)renderSettings();
    $('studio-undo').disabled=!undoStack.length;$('studio-redo').disabled=!redoStack.length;
    ctx.updatePrintPalette();scheduleCheck();requestRender();
  }

  // ---------- 3D view ----------
  function setupView() {
    if(renderer!==null)return Boolean(renderer);
    const container=$('studio-view');
    try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}
    catch{
      renderer=false;
      $('studio-view-empty').hidden=false;
      $('studio-view-empty').textContent='The 3D studio view needs WebGL. Add-ons can still be added at the model center and edited in the settings panel; exports work as usual.';
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.setClearColor(0x142219,0);
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
    renderer.localClippingEnabled=true;
    container.prepend(renderer.domElement);
    renderer.domElement.setAttribute('aria-label','Print Studio model view: drag to orbit, click to place or select add-ons');
    scene=new THREE.Scene();
    perspective=new THREE.PerspectiveCamera(38,1,.02,150);
    orthographic=new THREE.OrthographicCamera(-5,5,5,-5,.02,150);
    camera=perspective;
    controls=new OrbitControls(camera,renderer.domElement);
    controls.enableDamping=true;controls.dampingFactor=.08;controls.minDistance=1;controls.maxDistance=40;
    controls.addEventListener('change',requestRender);
    scene.add(new THREE.HemisphereLight(0xf0dfbb,0x566747,2.1));
    const sun=new THREE.DirectionalLight(0xffecc8,2.4);sun.position.set(4.2,7,-4.2);scene.add(sun);
    const fill=new THREE.DirectionalLight(0xdfe7e4,.6);fill.position.set(-5,3,2);scene.add(fill);
    const grid=new THREE.GridHelper(16,32,0x7c7954,0x506046);grid.position.y=-.03;grid.material.transparent=true;grid.material.opacity=.2;scene.add(grid);
    terrainGroup=new THREE.Group();ghostGroup=new THREE.Group();previewGroup=new THREE.Group();
    scene.add(terrainGroup,ghostGroup,previewGroup);
    new ResizeObserver(resize).observe(container);
    container.addEventListener('pointerdown',pointerDown,true);
    container.addEventListener('pointermove',pointerMove);
    container.addEventListener('pointerup',pointerUp);
    container.addEventListener('pointercancel',()=>{if(dragging)endDrag(false);});
    return true;
  }
  function resize() {
    if(!renderer)return;
    const container=$('studio-view'),width=container.clientWidth,height=container.clientHeight;
    if(!width||!height)return;
    const refit=Math.abs(perspective.aspect-width/height)>.05;
    renderer.setSize(width,height);perspective.aspect=width/height;perspective.updateProjectionMatrix();
    fitOrthographic();if(refit&&frame)setCamera(cameraMode);requestRender();
  }
  function fitOrthographic() {
    if(!renderer||!frame)return;
    const container=$('studio-view'),aspect=(container.clientWidth||1)/(container.clientHeight||1);
    const half=Math.max(frame.width*.6/aspect,cameraMode==='side'?frame.peak*.9:frame.height*.6);
    orthographic.left=-half*aspect;orthographic.right=half*aspect;orthographic.top=half;orthographic.bottom=-half;orthographic.updateProjectionMatrix();
  }
  function requestRender() {renderUntil=performance.now()+500;}
  function loop() {
    const moved=controls.update();
    if(moved||performance.now()<renderUntil)renderer.render(scene,camera);
  }

  function disposeGroup(group) {
    for(const child of [...group.children]) {
      child.traverse(object=>{if(object.isMesh||object.isLine){if(!object.userData.sharedGeometry)object.geometry?.dispose();(Array.isArray(object.material)?object.material:[object.material]).forEach(material=>material?.dispose());}});
      group.remove(child);
    }
  }
  // The studio owns copies of the main model's meshes so X-ray and Section never change the main preview.
  function syncModel() {
    frame=computeFrame();if(!frame)return;
    dirtyModel=false;
    $('studio-title').textContent=ctx.state.loadedName||ctx.state.name||'Your landscape';
    ctx.updateExportDimensions();
    $('studio-dimensions').textContent=$('export-dimensions').textContent;
    $('studio-exaggeration').textContent=`Elevation multiplier ${number(frame.exaggeration)}× · change it on the map page.`;
    $('studio-base').value=ctx.options().base_percent;
    if(!renderer)return;
    disposeGroup(terrainGroup);terrainMesh=null;
    const {topMesh,baseMesh,featureGroup,routeGroup}=ctx.meshes;
    const terrainMaterial=()=>new THREE.MeshStandardMaterial({vertexColors:true,roughness:.93,metalness:0,side:THREE.DoubleSide,map:topMesh?.material.map||null});
    if(topMesh) {
      const geometry=topMesh.geometry.clone();
      terrainMesh=new THREE.Mesh(geometry,terrainMaterial());terrainMesh.name='Studio terrain';terrainGroup.add(terrainMesh);
    }
    if(baseMesh)terrainGroup.add(new THREE.Mesh(baseMesh.geometry.clone(),new THREE.MeshStandardMaterial({color:baseMesh.material.color,roughness:1,side:THREE.DoubleSide})));
    for(const group of [featureGroup,routeGroup]) {
      if(!group)continue;
      const copy=group.clone(true);
      // Feature geometry stays shared with the main scene (never disposed here); materials are the studio's own.
      copy.traverse(object=>{if(object.isMesh){object.material=object.material.clone();object.userData.sharedGeometry=true;}});
      terrainGroup.add(copy);
    }
    applyMaterials();rebuildGhosts();
    if(profileOn)syncProfileControls();
    const fitKey=`${ctx.state.id}:${frame.width.toFixed(3)}:${frame.height.toFixed(3)}`;
    if(fitKey!==lastFitKey){lastFitKey=fitKey;setCamera(cameraMode);}
    requestRender();
  }
  function applyMaterials() {
    if(!renderer)return;
    terrainGroup.traverse(object=>{
      if(!object.isMesh)return;
      const material=object.material;
      material.userData.original??={transparent:material.transparent,opacity:material.opacity,depthWrite:material.depthWrite};
      const original=material.userData.original;
      material.transparent=xray||original.transparent;material.opacity=xray?Math.min(original.opacity,.28):original.opacity;material.depthWrite=xray?false:original.depthWrite;
      material.clippingPlanes=clipping()?[clipPlane]:null;material.needsUpdate=true;
    });
    updateSectionPlane();requestRender();
  }
  function updateSectionPlane() {
    if(!frame)return;
    if(profileCut) {  // keep the far half and look at the cut face, like the map page's slice
      const {horizontal,fraction}=profileSlice();
      clipPlane.setFromNormalAndCoplanarPoint(horizontal?new THREE.Vector3(0,0,-1):new THREE.Vector3(-1,0,0),
        horizontal?new THREE.Vector3(0,0,(fraction-.5)*frame.height):new THREE.Vector3((fraction-.5)*frame.width,0,0));
      return;
    }
    const addon=selected(),angle=rad(addon?.rotation_deg||0);
    const normal=new THREE.Vector3(-Math.sin(angle),0,-Math.cos(angle));
    const center=addon?new THREE.Vector3((addon.u-.5)*frame.width,0,(addon.v-.5)*frame.height):new THREE.Vector3();
    clipPlane.setFromNormalAndCoplanarPoint(normal,center);
  }
  function setCamera(mode) {
    if(!renderer||!frame)return;
    cameraMode=mode;
    const peak=frame.peak,center=peak*.4;
    if(mode==='top') {
      camera=orthographic;orthographic.position.set(0,25,0);orthographic.up.set(0,0,-1);orthographic.zoom=1;
      controls.target.set(0,0,0);controls.enableRotate=false;
    } else if(mode==='side') {
      camera=orthographic;orthographic.position.set(0,center,25);orthographic.up.set(0,1,0);orthographic.zoom=1;
      controls.target.set(0,center,0);controls.enableRotate=false;
    } else {
      camera=perspective;perspective.up.set(0,1,0);controls.enableRotate=true;
      // Narrow (portrait) views need more distance for the model's width to fit.
      const halfWidth=Math.atan(Math.tan(rad(perspective.fov/2))*perspective.aspect),radius=Math.hypot(frame.width,frame.height)/2;
      const distance=Math.max(Math.max(frame.width,frame.height,peak)*1.45,radius/Math.tan(halfWidth)*.95);
      if(clipping()) {
        const normal=clipPlane.normal,point=clipPlane.coplanarPoint(new THREE.Vector3());
        perspective.position.set(point.x-normal.x*distance,center+distance*.35,point.z-normal.z*distance);
        controls.target.set(point.x,center,point.z);
      } else {
        perspective.position.set(distance*.62,center+distance*.72,distance*.78);controls.target.set(0,center,0);
      }
    }
    controls.object=camera;camera.lookAt(controls.target);fitOrthographic();controls.update();
    document.querySelectorAll('[data-studio-view]').forEach(button=>{
      const view=button.dataset.studioView,active=view==='xray'?xray:view==='section'?section:view==='profile'?profileOn:view===cameraMode;
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    });
    requestRender();
  }

  // ---------- ghosts ----------
  function textOutline(text,size) {
    const key=`${text}\u0000${size}`;
    if(outlines.has(key))return outlines.get(key);
    const entry={state:'loading',polygons:[],width:0,height:0};outlines.set(key,entry);
    if(outlines.size>60)outlines.delete(outlines.keys().next().value);
    (async()=>{
      try {
        const response=await postJSON(`/api/studio/${ctx.state.id}/text-outline`,{text,text_size:size});
        if(!response.ok)throw new Error(await errorMessage(response));
        Object.assign(entry,await response.json(),{state:'ready'});
      } catch{entry.state='error';}
      rebuildGhosts();requestRender();
    })();
    return entry;
  }
  function textShapes(text,size) {
    const outline=textOutline(text,size);
    if(outline.state==='ready'&&outline.polygons.length) {
      const shapes=outline.polygons.map(polygon=>{
        const shape=new THREE.Shape(polygon.outer.map(([x,y])=>new THREE.Vector2(x,y)));
        shape.holes=(polygon.holes||[]).map(hole=>new THREE.Path(hole.map(([x,y])=>new THREE.Vector2(x,y))));
        return shape;
      });
      return {shapes,width:outline.width,height:outline.height};
    }
    // Until the outline arrives (or without the server endpoint), a block shows the text's approximate extent.
    const lines=String(text).split('\n'),width=Math.max(...lines.map(line=>line.length),1)*size*.9,height=size*(lines.length*1.45-.45);
    return {shapes:[outlineShape('rect',width,height)],width,height,placeholder:true};
  }
  function footprint(addon) {
    const p=addon.params||{};
    switch(addon.type) {
      case 'hole':case 'coaster':case 'magnet':return {hx:(p.diameter||5)/2,hy:(p.diameter||5)/2};
      case 'nail_marker':{const size=platformStyle()?(catalog?.marker_platform?.deck_size||30)/2:5;return {hx:size,hy:size};}
      case 'pencil_holder':return {hx:((p.count||1)-1)*(p.spacing||14)/2+(p.diameter||10)/2,hy:(p.diameter||10)/2+Math.tan(rad(p.tilt_deg||0))*(p.depth||0)};
      case 'photo_slot':return {hx:(p.width||60)/2,hy:Math.max(p.gap||1.2,2)/2+Math.tan(rad(p.lean_deg||0))*(p.depth||0)};
      case 'pocket':case 'plaque':return {hx:(p.width||40)/2,hy:(p.length||25)/2};
      case 'groove':return {hx:(p.length||80)/2,hy:(p.width||12)/2+Math.tan(rad(p.angle_deg||0))*(p.depth||0)};
      case 'hanging':return {hx:(p.head_diameter||8)/2,hy:(p.head_diameter||8)/2+(p.style==='hole'?0:(p.slot_length||10))};
      case 'text':{const t=textShapes(String(p.text||'Text'),p.text_size||6);return {hx:t.width/2,hy:t.height/2};}
      default:return {hx:5,hy:5};
    }
  }
  // Each part: {geometry, role:'cut'|'fill'|'ball'}; all in the add-on's local frame (mm), y up from the model bottom.
  function ghostParts(addon) {
    const p=addon.params||{},zref=heightMm(addon.u,addon.v),parts=[];
    const cut=geometry=>parts.push({geometry,role:'cut'}),fill=geometry=>parts.push({geometry,role:'fill'});
    const top=zref+TOP_CLEARANCE;
    switch(addon.type) {
      case 'hole':cut(column((p.diameter||5)/2,zref-(p.depth||8),top));break;
      case 'nail_marker': {
        const info=markerInfo(),exposed=info?.exposed_nail_length??24.4,depth=p.depth??exposed;
        cut(column(Math.max((p.hole_diameter||1.8)/2,.5),zref-depth,top));
        const base=zref+Math.max(exposed-depth,0);
        if(platformStyle()) {  // the platform: a post up to a thin disc at deck height, faint unless included in the 3MF
          const deck=info?.deck_top_z??9,thickness=info?.deck_thickness??2.4,size=(info?.deck_size||30)/2;
          parts.push({geometry:column((info?.hub_top_diameter||8)/2,base,base+deck-thickness),role:'ball'});
          const disc=info?.deck_shape==='square'?new THREE.BoxGeometry(size*2,thickness,size*2):new THREE.CylinderGeometry(size,size,thickness,48);
          disc.translate(0,base+deck-thickness/2,0);parts.push({geometry:disc,role:'ball'});
        } else {  // the bundled ball, faint unless marker balls are included in the 3MF
          const ball=new THREE.SphereGeometry((catalog?.marker_ball?.ball_diameter||10)/2,24,16);
          ball.translate(0,base+(catalog?.marker_ball?.height||12)/2,0);parts.push({geometry:ball,role:'ball'});
        }
        break;
      }
      case 'pencil_holder': {
        const count=Math.max(1,Math.round(p.count||1)),spacing=p.spacing||14;
        for(let index=0;index<count;index++)cut(column((p.diameter||10)/2,zref-(p.depth||40),top,p.tilt_deg||0,(index-(count-1)/2)*spacing,zref));
        break;
      }
      case 'photo_slot':cut(slab(p.width||60,p.gap||1.2,zref-(p.depth||12),top,p.lean_deg||0,zref));break;
      case 'groove':cut(slab(p.length||80,p.width||12,zref-(p.depth||8),top,p.angle_deg||0,zref));break;
      case 'pocket': {
        const stats=footprintStats(addon,(p.width||40)/2,(p.length||25)/2);
        cut(prism(outlineShape(p.shape||'rounded',p.width||40,p.length||25,p.corner_radius||4),stats.min-(p.depth||6),stats.max+TOP_CLEARANCE));break;
      }
      case 'coaster': {
        const r=(p.diameter||95)/2,stats=footprintStats(addon,r,r);
        cut(column(r,stats.min-(p.depth||3),stats.max+TOP_CLEARANCE));break;
      }
      case 'magnet':cut(column((p.diameter||6.2)/2,-1,p.depth||3.2));break;
      case 'hanging': {
        const head=(p.head_diameter||8)/2,shank=(p.shank_diameter||4)/2,depth=p.depth||5;
        cut(column(head,-1,depth));
        if(p.style!=='hole') {
          const length=p.slot_length||10,box=new THREE.BoxGeometry(shank*2,depth+1,length);box.translate(0,(depth-1)/2,-length/2);cut(box);
          const end=column(shank,-1,depth);end.translate(0,0,-length);cut(end);
        }
        break;
      }
      case 'plaque': {
        const width=p.width||60,length=p.length||25,stats=footprintStats(addon,width/2,length/2),mode=p.mode||'flatten';
        const level=mode==='flatten'?stats.min:mode==='level'?stats.mean:stats.max+(p.raise??2);
        const shape=()=>outlineShape(p.shape||'rounded',width,length,p.corner_radius||4);
        if(mode!=='raise'&&stats.max>level+.05)cut(prism(shape(),level,stats.max+.3));
        if(mode!=='flatten')fill(prism(shape(),Math.max(0,stats.min-1),level));
        else parts.push({geometry:prism(shape(),level-.05,level+.05),role:'plate'});
        const text=String(p.text||'').trim();
        if(text) {
          const shapes=textShapes(text,p.text_size||6).shapes,depth=p.text_depth||.8;
          if(p.text_style==='emboss')fill(prism(shapes,level,level+depth));else cut(prism(shapes,level-depth,level+.15));
        }
        break;
      }
      case 'text': {
        const shapes=textShapes(String(p.text||'Text'),p.text_size||6),stats=footprintStats(addon,shapes.width/2,shapes.height/2),depth=p.text_depth||1;
        if(p.text_style==='deboss')cut(prism(shapes.shapes,stats.min-depth,stats.max+.3));
        else fill(prism(shapes.shapes,p.base==='flat'?stats.max:stats.min-.5,stats.max+depth));
        break;
      }
      default:cut(column(3,zref-3,top));
    }
    return parts;
  }
  function ghostMaterial(role,addon,active,through=false) {
    const fillColor=addon.color||ctx.printColors().dirt||'#b99570';
    const color=role==='cut'?CUT_COLOR:role==='ball'?new THREE.Color(project.marker_balls.color):role==='plate'?0xf3d592:new THREE.Color(fillColor);
    const opacity=through?(active?.22:.12):role==='ball'?(project.marker_balls.include?.85:.3):role==='fill'?.78:active?.7:.5;
    return new THREE.MeshStandardMaterial({color,transparent:true,opacity,depthWrite:false,depthTest:!through,roughness:.6,
      emissive:active?new THREE.Color(0x553311):new THREE.Color(0),side:THREE.DoubleSide,
      clippingPlanes:profileCut?[clipPlane]:null});  // a profile cut hides the ghosts in front of the slice too
  }
  function rebuildGhosts() {
    if(!renderer||!frame||!project)return;
    disposeGroup(ghostGroup);ring=null;
    for(const addon of project.addons) {
      if(hidden.has(addon.id))continue;
      const group=new THREE.Group(),active=addon.id===selectedId;
      for(const part of ghostParts(addon)) {
        const mesh=new THREE.Mesh(part.geometry,ghostMaterial(part.role,addon,active));mesh.userData.addonId=addon.id;mesh.userData.role=part.role;mesh.renderOrder=2;group.add(mesh);
        if(part.role==='cut'){const through=new THREE.Mesh(part.geometry,ghostMaterial('cut',addon,active,true));through.userData.addonId=addon.id;through.renderOrder=3;group.add(through);}
      }
      if(active) {
        const {hx,hy}=footprint(addon),radius=Math.hypot(hx,hy)+4,zref=heightMm(addon.u,addon.v);
        const torus=new THREE.TorusGeometry(radius,Math.max(.7,radius*.035),8,64);torus.rotateX(Math.PI/2);torus.translate(0,zref+1.2,0);
        ring=new THREE.Mesh(torus,new THREE.MeshBasicMaterial({color:RING_COLOR,transparent:true,opacity:.85,depthTest:false}));
        ring.renderOrder=4;ring.userData.ring=true;group.add(ring);
        const knob=new THREE.SphereGeometry(Math.max(1.4,radius*.07),12,8);knob.translate(radius,zref+1.2,0);
        const handle=new THREE.Mesh(knob,new THREE.MeshBasicMaterial({color:0xfff6c7,depthTest:false}));handle.renderOrder=5;handle.userData.ring=true;group.add(handle);
      }
      group.position.set((addon.u-.5)*frame.width,0,(addon.v-.5)*frame.height);
      group.rotation.y=rad(addon.rotation_deg||0);group.scale.setScalar(frame.mmUnit);
      // The geometry is in millimeters relative to the center; heights were already absolute.
      ghostGroup.add(group);
    }
    if(clipping())updateSectionPlane();
    drawStudioProfile();
    requestRender();
  }

  // ---------- cross section (shares its slice with the map page's elevation profile) ----------
  function profileSlice() {
    return {horizontal:$('profile-direction').value==='ew',fraction:clamp(Number($('profile-position').value)/100,0,1)};
  }
  const metricUnits=()=>document.querySelector('[data-units="m"]')?.classList.contains('active');
  // Heights along the slice, mm above the model bottom (printed) or true elevation in meters.
  function profileHeights(count) {
    const {horizontal,fraction}=profileSlice(),d=frame.data,truth=d.true_elevations||d.elevations,values=[];
    for(let index=0;index<count;index++) {
      const t=index/(count-1),u=horizontal?t:fraction,v=horizontal?fraction:t;
      if(profileMode==='model'){values.push(heightMm(u,v));continue;}
      const x=u*(frame.columns-1),y=v*(frame.rows-1),c=Math.min(frame.columns-2,Math.floor(x)),r=Math.min(frame.rows-2,Math.floor(y)),fx=x-c,fy=y-r,i=r*frame.columns+c;
      values.push(truth[i]*(1-fx)*(1-fy)+truth[i+1]*fx*(1-fy)+truth[i+frame.columns]*(1-fx)*fy+truth[i+frame.columns+1]*fx*fy);
    }
    return values;
  }
  // Where the slice passes through add-on ghosts: vertical spans (mm) per sample, found by casting rays down through them.
  function profileAddons(count) {
    const meshes=[];ghostGroup?.updateMatrixWorld(true);
    ghostGroup?.traverse(object=>{if(object.isMesh&&object.userData.role&&!object.userData.ring)meshes.push(object);});
    if(!meshes.length)return [];
    const {horizontal,fraction}=profileSlice(),caster=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0),spans=[];
    const top=frame.peak+60*frame.mmUnit;
    for(let index=0;index<count;index++) {
      const t=index/(count-1),x=((horizontal?t:fraction)-.5)*frame.width,z=((horizontal?fraction:t)-.5)*frame.height;
      caster.set(new THREE.Vector3(x,top,z),down);
      const byMesh=new Map();
      for(const hit of caster.intersectObjects(meshes,false)) {
        const list=byMesh.get(hit.object)||[];list.push(hit.point.y/frame.mmUnit);byMesh.set(hit.object,list);
      }
      for(const [mesh,heights] of byMesh) {
        heights.sort((a,b)=>b-a);
        // A closed ghost is entered and left in pairs; a grazing ray may report a single hit, which is skipped.
        for(let k=0;k+1<heights.length;k+=2)spans.push({index,role:mesh.userData.role,high:heights[k],low:heights[k+1],color:mesh.material.color.getStyle()});
      }
    }
    // Cutters reach above the terrain so they show in 3D; on the chart a cut ends at the surface it removes.
    const surface=profileHeights(count);
    return spans.map(span=>span.role==='cut'?{...span,high:Math.min(span.high,surface[span.index])}:span).filter(span=>span.high>span.low);
  }
  function drawStudioProfile(pointer=null) {
    if(!profileOn||!frame)return;
    const canvas=$('studio-profile-chart'),rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
    const g=canvas.getContext('2d');g.scale(dpr,dpr);
    const {horizontal}=profileSlice(),model=profileMode==='model',width=rect.width,height=rect.height;
    const left=46,right=14,top=12,bottom=22,chartW=width-left-right,chartH=height-top-bottom;
    const count=Math.max(32,Math.min(480,Math.round(chartW/2))),values=profileHeights(count);
    const lengthMm=horizontal?frame.W:frame.H,metric=metricUnits(),feet=1/0.3048;
    const spans=model?profileAddons(count):[];
    let low,high,scaleX=chartW,offset=left;
    if(model) {
      high=Math.max(...values,...spans.map(span=>span.high))*1.08;low=Math.min(0,...spans.map(span=>span.low));
      if($('studio-profile-true').checked) {  // equal millimeters across and up: the print's real silhouette
        const scale=Math.min(chartW/lengthMm,chartH/(high-low));scaleX=lengthMm*scale;high=low+chartH/scale;
      }
    } else {
      const minimum=Math.min(...values),maximum=Math.max(...values),range=Math.max(maximum-minimum,10);
      low=minimum-range*.14;high=maximum+range*.16;
    }
    const px=index=>offset+index/(count-1)*scaleX,py=value=>top+(high-value)/(high-low)*chartH;
    g.font='9px "Segoe UI", Arial';g.lineWidth=1;
    for(let k=0;k<=3;k++) {
      const y=top+k/3*chartH,value=high-k/3*(high-low);
      g.strokeStyle='#3b4835';g.setLineDash([3,4]);g.beginPath();g.moveTo(left,y);g.lineTo(width-right,y);g.stroke();g.setLineDash([]);
      g.fillStyle='#b4b39a';g.textAlign='right';
      g.fillText(model?`${number(value,0)} mm`:`${number(value*(metric?1:feet),0)} ${metric?'m':'ft'}`,left-6,y+3);
    }
    // The silhouette: the base band and terrain above it (printed), or the elevation area.
    g.beginPath();g.moveTo(px(0),py(model?0:low));values.forEach((value,index)=>g.lineTo(px(index),py(value)));g.lineTo(px(count-1),py(model?0:low));g.closePath();
    const fill=g.createLinearGradient(0,top,0,height-bottom);fill.addColorStop(0,'#c3c87dcc');fill.addColorStop(1,'#58704760');g.fillStyle=fill;g.fill();
    if(model){g.fillStyle='#8a6d4a';g.fillRect(px(0),py(frame.baseMm),scaleX,py(0)-py(frame.baseMm));}
    g.beginPath();values.forEach((value,index)=>index?g.lineTo(px(index),py(value)):g.moveTo(px(index),py(value)));g.strokeStyle='#e6d29b';g.lineWidth=1.6;g.stroke();
    // Add-ons crossing the slice: cuts in warm red, added material in its color, nail markers faint.
    const step=Math.max(scaleX/(count-1),1);
    for(const span of spans) {
      g.globalAlpha=span.role==='cut'?.85:span.role==='ball'?.45:.8;g.fillStyle=span.role==='cut'?'#e2643f':span.color;
      g.fillRect(px(span.index)-step/2,py(span.high),step+.5,Math.max(py(span.low)-py(span.high),1));
    }
    g.globalAlpha=1;
    const distance=horizontal?frame.data.width_m:frame.data.height_m,distanceUnit=metric?1000:1609.344,distanceLabel=metric?'km':'mi';
    g.fillStyle='#b4b39a';g.textAlign='left';
    const startLabel=$('profile-direction').selectedOptions[0]?.textContent.split('→')[0].trim()||'';
    const endLabel=$('profile-direction').selectedOptions[0]?.textContent.split('→')[1]?.trim()||'';
    g.fillText(`${startLabel} · 0`,px(0),height-6);g.textAlign='right';
    g.fillText(model?`${number(lengthMm,0)} mm · ${endLabel}`:`${number(distance/distanceUnit,2)} ${distanceLabel} · ${endLabel}`,px(count-1),height-6);
    profileData={values,count,px,py,model,lengthMm,distance,distanceUnit,distanceLabel,metric,feet,spans};
    if(pointer!==null) {
      const fraction=clamp((pointer-offset)/scaleX,0,1),index=Math.round(fraction*(count-1)),value=values[index];
      g.strokeStyle='#d4b47d';g.setLineDash([3,3]);g.beginPath();g.moveTo(px(index),top);g.lineTo(px(index),height-bottom);g.stroke();g.setLineDash([]);
      g.fillStyle='#ffedb9';g.beginPath();g.arc(px(index),py(value),3,0,Math.PI*2);g.fill();
      const cuts=spans.filter(span=>span.index===index&&span.role==='cut'),floor=cuts.length?Math.min(...cuts.map(span=>span.low)):null;
      $('studio-profile-readout').textContent=model
        ?`${number(fraction*lengthMm,1)} mm along · surface ${number(value,1)} mm${floor!==null?` · cut down to ${number(Math.max(floor,0),1)} mm`:''} · base ${number(frame.baseMm,1)} mm`
        :`${number(fraction*distance/distanceUnit,2)} ${distanceLabel} along · ${number(value*(metric?1:feet),0)} ${metric?'m':'ft'} above sea level`;
    }
    updateProfileLine();
  }
  // The slice drawn on the 3D model as a line over the surface, like the dashed line on the map page.
  function updateProfileLine() {
    if(profileLine){profileLine.removeFromParent();profileLine.geometry.dispose();profileLine.material.dispose();profileLine=null;}
    if(!renderer||!profileOn||!frame)return;
    const {horizontal,fraction}=profileSlice(),points=[];
    for(let index=0;index<=160;index++) {
      const t=index/160,u=horizontal?t:fraction,v=horizontal?fraction:t;
      points.push(new THREE.Vector3((u-.5)*frame.width,(heightMm(u,v)+.6)*frame.mmUnit,(v-.5)*frame.height));
    }
    profileLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:0xffb354,depthTest:!profileCut}));
    profileLine.renderOrder=6;scene.add(profileLine);requestRender();
  }
  // The studio's slider and direction drive the map page's own controls, so both views always show one slice.
  function syncProfileControls() {
    const direction=$('profile-direction'),studioDirection=$('studio-profile-direction');
    [...direction.options].forEach((option,index)=>{if(studioDirection.options[index])studioDirection.options[index].textContent=option.textContent;});
    studioDirection.value=direction.value;$('studio-profile-position').value=$('profile-position').value;
    $('studio-profile-position-value').textContent=`${$('profile-position').value}%`;
  }
  function setProfile(on) {
    profileOn=on;$('studio-profile').hidden=!on;
    if(!on&&profileCut){profileCut=false;$('studio-profile-cut').checked=false;applyMaterials();rebuildGhosts();}
    if(on)syncProfileControls();
    // The 3D view shrinks to make room for the chart once the layout settles.
    requestAnimationFrame(()=>{resize();updateProfileLine();setCamera(cameraMode);if(on)drawStudioProfile();});
  }
  function profileChanged() {
    if(profileCut){updateSectionPlane();setCamera(cameraMode);}
    drawStudioProfile();requestRender();
  }
  function wireProfile() {
    $('studio-profile-position').addEventListener('input',event=>{
      const main=$('profile-position');main.value=event.target.value;main.dispatchEvent(new Event('input',{bubbles:true}));
      $('studio-profile-position-value').textContent=`${event.target.value}%`;profileChanged();
    });
    $('studio-profile-direction').addEventListener('change',event=>{
      const main=$('profile-direction');main.value=event.target.value;main.dispatchEvent(new Event('change',{bubbles:true}));profileChanged();
    });
    document.querySelectorAll('[data-profile-mode]').forEach(button=>button.addEventListener('click',()=>{
      profileMode=button.dataset.profileMode;
      document.querySelectorAll('[data-profile-mode]').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});
      $('studio-profile-true').disabled=profileMode!=='model';drawStudioProfile();
    }));
    $('studio-profile-true').addEventListener('change',()=>drawStudioProfile());
    $('studio-profile-cut').addEventListener('change',event=>{profileCut=event.target.checked;applyMaterials();rebuildGhosts();updateProfileLine();setCamera(cameraMode);});
    const chart=$('studio-profile-chart');
    chart.addEventListener('pointermove',event=>drawStudioProfile(event.clientX-chart.getBoundingClientRect().left));
    chart.addEventListener('pointerleave',()=>{drawStudioProfile();$('studio-profile-readout').textContent="Shares its slice with the map page's elevation profile. Point at the chart for heights.";});
    new ResizeObserver(()=>drawStudioProfile()).observe(chart);
  }

  // ---------- picking and dragging ----------
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
  function ray(event) {
    const rect=renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    raycaster.setFromCamera(pointer,camera);
  }
  function terrainHit(event) {
    if(!terrainMesh)return null;
    ray(event);
    const hit=raycaster.intersectObject(terrainMesh,false)[0];
    if(hit)return {u:clamp(hit.point.x/frame.width+.5,0,1),v:clamp(hit.point.z/frame.height+.5,0,1)};
    // Off the surface (e.g. looking from the side): fall back to the model's footprint plane.
    const point=new THREE.Vector3();
    if(!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),point))return null;
    const u=point.x/frame.width+.5,v=point.z/frame.height+.5;
    return u>=0&&u<=1&&v>=0&&v<=1?{u,v}:null;
  }
  function pick(event) {
    ray(event);
    const hits=raycaster.intersectObjects(ghostGroup.children,true);
    const ringHit=hits.find(hit=>hit.object.userData.ring);if(ringHit)return {ring:true};
    const ghost=hits.find(hit=>hit.object.userData.addonId);return ghost?{id:ghost.object.userData.addonId}:null;
  }
  function snapped(u,v) {
    const mode=$('studio-snap').value;let {x,y}=toMm(u,v);
    if(mode==='grid'){x=Math.round(x/5)*5;y=Math.round(y/5)*5;}
    else if(mode==='center'){if(Math.abs(x)<8)x=0;if(Math.abs(y)<8)y=0;}
    else if(mode==='high')return highestPoint({x,y});
    const result=toUV(x,y);return {u:clamp(result.u,0,1),v:clamp(result.v,0,1)};
  }
  let down=null;
  function pointerDown(event) {
    if(event.button!==0||!frame||previewing)return;
    down={x:event.clientX,y:event.clientY};
    if(placing)return;
    const hit=pick(event);
    if(hit?.ring&&selected()){dragging={mode:'rotate',before:snapshot(),moved:false};}
    else if(hit?.id){
      if(selectedId!==hit.id){selectedId=hit.id;renderList();renderSettings();rebuildGhosts();if(section)applyMaterials();}
      dragging={mode:'move',before:snapshot(),moved:false};
    }
    if(dragging){controls.enabled=false;renderer.domElement.setPointerCapture?.(event.pointerId);event.stopPropagation();}
  }
  function pointerMove(event) {
    if(!frame)return;
    renderer.domElement.style.cursor=placing?'crosshair':dragging?'grabbing':'';
    if(!dragging)return;
    const addon=selected();if(!addon)return;
    if(dragging.mode==='move') {
      const hit=terrainHit(event);if(!hit)return;
      const position=snapped(hit.u,hit.v);addon.u=position.u;addon.v=position.v;
    } else {
      ray(event);
      const point=new THREE.Vector3(),zref=heightMm(addon.u,addon.v)*frame.mmUnit;
      if(!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-zref),point))return;
      const dx=point.x-(addon.u-.5)*frame.width,dz=point.z-(addon.v-.5)*frame.height;
      let angle=Math.atan2(-dz,dx)*180/Math.PI;if(event.shiftKey||$('studio-snap').value!=='none')angle=Math.round(angle/15)*15;
      addon.rotation_deg=Math.round(((angle%360)+360)%360*10)/10;
    }
    dragging.moved=true;rebuildGhosts();renderPositionFields();
  }
  function endDrag(apply=true) {
    const state=dragging;dragging=null;controls.enabled=true;
    if(!state)return;
    if(!apply){restore(state.before);changed();return;}
    if(state.moved)commit(state.before);
  }
  function pointerUp(event) {
    const click=down&&Math.hypot(event.clientX-down.x,event.clientY-down.y)<5;down=null;
    if(dragging){endDrag(true);return;}
    if(!click||!frame||previewing)return;
    if(placing){const hit=terrainHit(event);if(hit)place(placing,snapped(hit.u,hit.v));return;}
    const hit=pick(event);
    if(!hit&&selectedId){selectedId=null;rebuildGhosts();renderList();renderSettings();if(section)applyMaterials();}
  }

  // ---------- add-on operations ----------
  const selected=()=>project?.addons.find(addon=>addon.id===selectedId)||null;
  function startPlacing(type) {
    placing=placing===type?null:type;
    document.querySelectorAll('[data-addon-type]').forEach(button=>{const active=button.dataset.addonType===placing;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    const hint=$('studio-place-hint');hint.replaceChildren();
    if(placing) {
      hint.append(`Click the model to place the ${typeLabel(placing).toLowerCase()}. Esc cancels. `);
      const center=document.createElement('button');center.type='button';center.className='text-button';center.textContent='Place at the center';
      center.addEventListener('click',()=>place(placing,{u:.5,v:.5}));hint.append(center);
    }
  }
  function place(type,{u,v}) {
    if(!typeInfo(type))return;
    if(catalog.max_addons&&project.addons.length>=catalog.max_addons)return ctx.notify(`A project holds at most ${catalog.max_addons} add-ons.`,true);
    const addon={id:nextId(),type,u,v,rotation_deg:0,params:defaults(type),color:null};
    mutate(()=>{project.addons.push(addon);selectedId=addon.id;});
    startPlacing(null);
  }
  function removeAddon(id) {mutate(()=>{project.addons=project.addons.filter(addon=>addon.id!==id);if(selectedId===id)selectedId=null;});}
  function duplicateAddon(id) {
    const source=project.addons.find(addon=>addon.id===id);if(!source)return;
    const copy={...clone(source),id:nextId()};const {x,y}=toMm(source.u,source.v),moved=toUV(x+8,y-8);
    copy.u=clamp(moved.u,0,1);copy.v=clamp(moved.v,0,1);
    mutate(()=>{project.addons.push(copy);selectedId=copy.id;});
  }
  function nudge(dx,dy) {
    const addon=selected();if(!addon)return;
    mutate(()=>{const {x,y}=toMm(addon.u,addon.v),moved=toUV(x+dx,y+dy);addon.u=clamp(moved.u,0,1);addon.v=clamp(moved.v,0,1);});
  }
  function rotate(step) {const addon=selected();if(addon)mutate(()=>{addon.rotation_deg=((Math.round((addon.rotation_deg||0)/15)*15+step)%360+360)%360;});}

  // ---------- templates ----------
  // Keeps a template's add-on (with its footprint) inside the model, with a margin.
  function inside(addon,x,y,margin=4) {
    const {hx,hy}=footprint(addon),limitX=Math.max(frame.W/2-hx-margin,0),limitY=Math.max(frame.H/2-hy-margin,0);
    const result=toUV(clamp(x,-limitX,limitX),clamp(y,-limitY,limitY));addon.u=result.u;addon.v=result.v;return addon;
  }
  const make=(type,params={})=>({id:'',type,u:.5,v:.5,rotation_deg:0,params:{...defaults(type),...params},color:null});
  // Cut depth that leaves at least `floor` mm below it at this spot.
  const safeDepth=(addon,wanted,floor=2,minimum=1)=>Math.max(minimum,Math.min(wanted,Math.floor((footprintStats(addon,...Object.values(footprint(addon))).min-floor)*10)/10));
  const templates={
    'Print as is':()=>({addons:[],balls:false}),
    'Desk set':()=>{
      const holder=make('pencil_holder',{count:3});holder.params.spacing=Math.max(holder.params.spacing||14,(holder.params.diameter||10)+4);
      inside(holder,frame.W/2-footprint(holder).hx-8,frame.H/2-footprint(holder).hy-8);holder.params.depth=safeDepth(holder,holder.params.depth||40);
      const pocket=make('pocket');inside(pocket,0,-frame.H/2+footprint(pocket).hy+8);pocket.params.depth=safeDepth(pocket,pocket.params.depth||6);
      return {addons:[holder,pocket],balls:false};
    },
    'Photo stand':()=>{
      const slot=make('photo_slot');slot.params.width=Math.min(slot.params.width||60,Math.round(frame.W*.7));
      inside(slot,0,frame.H/2-14);slot.params.depth=safeDepth(slot,slot.params.depth||12);return {addons:[slot],balls:false};
    },
    'Plaque':()=>{
      const plaque=make('plaque');plaque.params.width=Math.min(plaque.params.width||60,Math.round(frame.W*.45));plaque.params.length=Math.min(plaque.params.length||25,Math.round(frame.H*.3));
      // The place name, on two lines when long; sized so it fits the pad (bold capitals run about 0.9 × their height wide).
      let name=String(ctx.state.loadedName||ctx.state.name||'').split(',')[0].trim().slice(0,40);
      const space=name.indexOf(' ',Math.floor(name.length/2)-4);
      if(name.length>12&&space>0)name=`${name.slice(0,space)}\n${name.slice(space+1)}`;
      const lines=name.split('\n'),chars=Math.max(...lines.map(line=>line.length),1);
      plaque.params.text=name;
      plaque.params.text_size=clamp(Math.floor(Math.min(plaque.params.width*.85/(chars*.9),plaque.params.length*.8/(lines.length*1.5))*2)/2,2,plaque.params.text_size||6);
      // The lowest, flattest corner wins: small spread, low ground.
      let best=null;
      for(const [sx,sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
        const candidate=inside({...clone(plaque)},sx*frame.W/2,sy*frame.H/2,6),stats=footprintStats(candidate,plaque.params.width/2,plaque.params.length/2);
        const score=(stats.max-stats.min)*2+stats.mean;if(!best||score<best.score)best={score,candidate};
      }
      return {addons:[best.candidate],balls:false};
    },
    'Trail marker':()=>{
      const marker=make('nail_marker'),peak=toMm(...Object.values(highestPoint()));inside(marker,peak.x,peak.y,2);
      return {addons:[marker],balls:true};
    },
  };
  function applyTemplate(name) {
    if(!frame)return;
    if(name!=='Print as is'&&!catalog)return ctx.notify(catalogError||'Add-ons are still loading.',true);
    const result=templates[name]();
    mutate(()=>{
      project.addons=[];result.addons.forEach(addon=>{addon.id=nextId();project.addons.push(fitParams(addon));});
      project.marker_balls.include=result.balls;
      if(!undoStack.length||/^(Print as is|Untitled|Project \d+)$/.test(project.name)||Object.keys(templates).includes(project.name))project.name=name;
      selectedId=null;
    });
    syncMarker();
    $('studio-place-hint').textContent=name==='Print as is'?'No add-ons: the model exports exactly as on the map page.':`${name} applied. Drag add-ons to adjust them; Undo restores the previous layout.`;
  }

  // ---------- panels ----------
  function renderTemplates() {
    const box=$('studio-templates');
    box.replaceChildren(...Object.keys(templates).map(name=>{
      const button=document.createElement('button');button.type='button';button.className='studio-template';button.dataset.template=name;button.textContent=name;
      button.addEventListener('click',()=>applyTemplate(name));return button;
    }));
  }
  function renderPalette() {
    const box=$('studio-palette');
    if(!catalog){box.replaceChildren(Object.assign(document.createElement('span'),{className:'small-hint studio-warning',textContent:catalogError||'Loading add-ons…'}));return;}
    const kinds={cut:'cut',fill:'adds',mixed:'cut/add',underside:'underside'};
    const order=Array.isArray(catalog.order)?catalog.order.filter(type=>catalog.types[type]):Object.keys(catalog.types);
    box.replaceChildren(...order.map(type=>[type,catalog.types[type]]).map(([type,info])=>{
      const button=document.createElement('button');button.type='button';button.dataset.addonType=type;button.setAttribute('aria-pressed','false');
      button.append(Object.assign(document.createElement('span'),{textContent:`+ ${info.label||type}`}));
      const tag=document.createElement('small');tag.textContent=kinds[info.kind]||info.kind||'';button.append(tag);
      button.addEventListener('click',()=>startPlacing(type));return button;
    }));
  }
  function levelOf(id) {
    const levels=checkResults.checks.filter(check=>check.addon_id===id).map(check=>check.level);
    return levels.includes('error')?'error':levels.includes('warning')?'warning':null;
  }
  function renderList() {
    const list=$('studio-addons');if(!project)return;
    $('studio-addon-count').textContent=project.addons.length?`· ${project.addons.length}`:'';
    if(!project.addons.length){list.replaceChildren(Object.assign(document.createElement('li'),{className:'studio-empty',textContent:'Nothing placed: the model prints as is.'}));return;}
    list.replaceChildren(...project.addons.map(addon=>{
      const item=document.createElement('li');item.classList.toggle('selected',addon.id===selectedId);item.dataset.addonId=addon.id;
      const select=document.createElement('button');select.type='button';select.className='studio-addon-name';
      const level=levelOf(addon.id),{x,y}=frame?toMm(addon.u,addon.v):{x:0,y:0};
      select.textContent=`${level==='error'?'⛔ ':level==='warning'?'⚠ ':''}${typeLabel(addon.type)}`;
      const detail=document.createElement('small');detail.textContent=`${number(x,0)}, ${number(y,0)} mm`;select.append(detail);
      select.setAttribute('aria-pressed',String(addon.id===selectedId));
      select.addEventListener('click',()=>{selectedId=addon.id===selectedId?null:addon.id;rebuildGhosts();renderList();renderSettings();if(section)applyMaterials();});
      const eye=document.createElement('button');eye.type='button';eye.className='icon-button studio-eye';eye.textContent=hidden.has(addon.id)?'◌':'◉';
      eye.title=hidden.has(addon.id)?'Show in the view':'Hide in the view (still exported)';eye.setAttribute('aria-label',eye.title);
      eye.addEventListener('click',()=>{hidden.has(addon.id)?hidden.delete(addon.id):hidden.add(addon.id);rebuildGhosts();renderList();});
      const remove=document.createElement('button');remove.type='button';remove.className='icon-button studio-remove';remove.textContent='×';remove.title='Delete add-on';remove.setAttribute('aria-label',`Delete ${typeLabel(addon.type)}`);
      remove.addEventListener('click',()=>removeAddon(addon.id));
      item.append(select,eye,remove);return item;
    }));
  }
  function renderProjects() {
    if(!store)return;
    const select=$('studio-project');
    select.replaceChildren(...store.projects.map(item=>Object.assign(document.createElement('option'),{value:item.id,textContent:item.name})));
    select.value=project.id;
    document.querySelector('[data-project-action="delete"]').disabled=store.projects.length<2;
  }
  function field(labelText,input,unit) {
    const label=document.createElement('label');label.className='studio-field';
    const text=document.createElement('span');text.textContent=labelText;label.append(text);
    if(unit){const wrap=document.createElement('span');wrap.className='studio-unit';wrap.append(input,Object.assign(document.createElement('i'),{textContent:unit}));label.append(wrap);}
    else label.append(input);
    return label;
  }
  // Live edits update the view; one undo step is recorded when the field commits (change).
  function bindInput(input,apply,{form=false}={}) {
    input.addEventListener('input',()=>{pendingBefore??=snapshot();apply(false);changed({form:false});});
    // The form is not rebuilt here, so Tab moves on to the next field; choices that change the form rebuild it themselves.
    input.addEventListener('change',()=>{const before=pendingBefore??snapshot();pendingBefore=null;apply(true);commit(before,{form});if(!form)renderPositionFields();});
  }
  function renderPositionFields() {
    const addon=selected();if(!addon||!frame)return;
    const {x,y}=toMm(addon.u,addon.v);
    for(const [id,value] of [['studio-pos-x',x],['studio-pos-y',y],['studio-rotation',addon.rotation_deg||0]]) {
      const input=$(id);if(input&&document.activeElement!==input)input.value=Math.round(value*10)/10;
    }
    renderList();
  }
  function renderSettings() {
    const box=$('studio-settings'),addon=selected();
    $('studio-model-settings').hidden=Boolean(addon);$('studio-marker').hidden=Boolean(addon);
    box.hidden=!addon;
    if(!addon){box.replaceChildren();return;}
    const info=typeInfo(addon.type),heading=document.createElement('h3');heading.textContent=typeLabel(addon.type);
    const close=document.createElement('button');close.type='button';close.className='text-button studio-deselect';close.textContent='Done';
    close.addEventListener('click',()=>{selectedId=null;rebuildGhosts();renderList();renderSettings();});heading.append(close);
    const nodes=[heading];
    if(!frame){box.replaceChildren(...nodes);return;}
    const {x,y}=toMm(addon.u,addon.v);
    const position=document.createElement('div');position.className='studio-row';
    const numberInput=(id,value,step='any',min,max)=>{const input=document.createElement('input');input.type='number';input.id=id;input.step=step;input.value=Math.round(value*10)/10;if(min!=null)input.min=min;if(max!=null)input.max=max;return input;};
    const px=numberInput('studio-pos-x',x,'any',-frame.W/2,frame.W/2),py=numberInput('studio-pos-y',y,'any',-frame.H/2,frame.H/2),rotation=numberInput('studio-rotation',addon.rotation_deg||0,'1',-360,360);
    const applyPosition=()=>{const nx=Number(px.value),ny=Number(py.value);if(!Number.isFinite(nx)||!Number.isFinite(ny))return;const uv=toUV(clamp(nx,-frame.W/2,frame.W/2),clamp(ny,-frame.H/2,frame.H/2));addon.u=uv.u;addon.v=uv.v;};
    bindInput(px,applyPosition);bindInput(py,applyPosition);
    bindInput(rotation,()=>{const value=Number(rotation.value);if(Number.isFinite(value))addon.rotation_deg=((value%360)+360)%360;});
    position.append(field('X from center',px,'mm'),field('Y from center',py,'mm'),field('Rotation',rotation,'°'));
    nodes.push(position,Object.assign(document.createElement('span'),{className:'small-hint',textContent:'+Y points to the top edge of the map frame. Arrows nudge 1 mm (Shift: 10 mm); R / Shift+R rotate 15°.'}));
    for(const [name,spec] of Object.entries(info?.params||{})) {
      const value=addon.params[name]??spec.default;let input;
      if(spec.choices) {
        input=document.createElement('select');
        input.append(...spec.choices.map(choice=>Object.assign(document.createElement('option'),{value:choice,textContent:String(choice).replace(/_/g,' ')})));
        input.value=value;bindInput(input,()=>{addon.params[name]=input.value;},{form:true});
      } else if(typeof spec.default==='number') {
        input=document.createElement('input');input.type='number';input.step=spec.type==='integer'?'1':spec.step||'any';
        if(spec.min!=null)input.min=spec.min;if(spec.max!=null)input.max=spec.max;input.value=value;
        bindInput(input,final=>{
          let number=Number(input.value);if(!Number.isFinite(number)||input.value==='')return;
          if(final){number=fitParam(spec,number);input.value=number;}
          else if((spec.min!=null&&number<spec.min)||(spec.max!=null&&number>spec.max)||(spec.type==='integer'&&!Number.isInteger(number)))return;
          addon.params[name]=number;
        });
      } else if(typeof spec.default==='boolean') {
        input=document.createElement('input');input.type='checkbox';input.checked=Boolean(value);bindInput(input,()=>{addon.params[name]=input.checked;});
      } else {
        const lines=spec.max_lines||1,limit=spec.max_length||60;
        input=document.createElement('textarea');input.rows=Math.min(lines,3);input.maxLength=limit;input.value=value??'';
        if(spec.required)input.required=true;
        // Extra lines beyond the catalog's limit are dropped as you type.
        bindInput(input,()=>{const text=input.value.split('\n').slice(0,lines).join('\n').slice(0,limit);if(text!==input.value)input.value=text;addon.params[name]=text;});
      }
      input.id=`studio-param-${name}`;input.dataset.param=name;
      nodes.push(field(spec.label||name,input,spec.unit));
    }
    if(canColor(addon)) {
      const color=document.createElement('input');color.type='color';color.id='studio-addon-color';color.value=addon.color||ctx.printColors().dirt||'#b99570';
      const auto=document.createElement('input');auto.type='checkbox';auto.checked=!addon.color;auto.id='studio-addon-color-auto';
      bindInput(color,()=>{addon.color=color.value.toLowerCase();auto.checked=false;});
      bindInput(auto,()=>{addon.color=auto.checked?null:color.value.toLowerCase();});
      const row=document.createElement('div');row.className='studio-row studio-color-row';
      const autoLabel=document.createElement('label');autoLabel.className='studio-check';autoLabel.append(auto,' Same as Dirt / base');
      row.append(field('Added material color',color),autoLabel);nodes.push(row);
      if(addsMaterial(addon))nodes.push(Object.assign(document.createElement('span'),{className:'small-hint',textContent:'A new color uses one of the four 3MF filaments.'}));
    }
    const result=checkResults.addons?.find(item=>item.id===addon.id);
    if(result&&Number.isFinite(result.floor_z))nodes.push(Object.assign(document.createElement('span'),{className:'small-hint studio-floor',textContent:`Surface ${number(result.z_ref)} mm · floor ${number(result.floor_z)} mm above the bottom.`}));
    const actions=document.createElement('div');actions.className='studio-row studio-actions';
    const duplicate=Object.assign(document.createElement('button'),{type:'button',className:'button secondary',textContent:'Duplicate'});duplicate.addEventListener('click',()=>duplicateAddon(addon.id));
    const remove=Object.assign(document.createElement('button'),{type:'button',className:'button secondary studio-danger',textContent:'Delete'});remove.addEventListener('click',()=>removeAddon(addon.id));
    actions.append(duplicate,remove);nodes.push(actions);
    box.replaceChildren(...nodes);
  }
  // Copy the project's marker settings into the Nail markers card.
  function syncMarker() {
    if(!project)return;
    const balls=project.marker_balls;
    $('studio-marker-include').checked=balls.include;$('studio-marker-color').value=balls.color;
    $('studio-marker-style').value=balls.style;$('studio-platform-top').value=balls.top;
    $('studio-platform-top-color').value=balls.top_color||balls.color;
    $('studio-platform-area').value=balls.top_area_mm;$('studio-platform-exaggeration').value=balls.top_exaggeration??'';
    $('studio-platform-options').hidden=balls.style!=='platform';$('studio-platform-terrain').hidden=balls.top!=='terrain';
    renderMarker();
  }
  function renderMarker() {
    const ball=catalog?.marker_ball,platform=catalog?.marker_platform;
    if(platformStyle())$('studio-marker-info').textContent=platform?`${platform.name||'Marker platform'}: ${number(platform.deck_size)} mm ${platform.deck_shape||'round'} deck ${number(platform.deck_top_z)} mm above the hub; ${number(platform.exposed_nail_length)} mm of nail stands below it. ${platform.print||''}`:'The bundled platform fits a nail marker hole.';
    else $('studio-marker-info').textContent=ball?`${ball.name||'Marker ball'}: ${number(ball.ball_diameter)} mm ball for a brass nail (${number(ball.nail?.shank_diameter,2)} mm shank); ${number(ball.exposed_nail_length)} mm of nail stands below the collar. ${ball.print||''}`:'The bundled marker ball fits a nail marker hole.';
  }

  // ---------- checks ----------
  function scheduleCheck() {
    clearTimeout(checkTimer);
    if(!ctx.state.id||!project)return;
    checkTimer=setTimeout(runCheck,300);
  }
  function requestBody(format) {
    const palette=ctx.state.palette==='print';
    return {...ctx.options(),format,feature_layers:ctx.featureStyles(),route:ctx.routeOptions?.(),print_palette:palette?ctx.printColors():undefined,project:payload()};
  }
  async function runCheck() {
    checkRequest?.abort();const controller=new AbortController();checkRequest=controller;
    const body={...requestBody(ctx.state.palette==='print'?'3mf':'stl'),bed_mm:Number($('studio-bed').value)||256};
    let result;
    try {
      if(!studioRoutes){checkRequest=null;checkResults=localChecks();renderChecks('Basic checks in the browser; the server checks need the updated Terrain Studio server.');renderList();return;}
      const response=await postJSON(`/api/studio/${ctx.state.id}/check`,body,controller.signal);
      if(missingRoute(response))result={...localChecks(),note:'Basic checks in the browser; the server checks need the updated Terrain Studio server.'};
      else if(!response.ok)result={checks:[{addon_id:null,level:'error',message:await errorMessage(response)}],addons:[]};
      else result=await response.json();
    } catch(error) {
      if(error.name==='AbortError')return;
      result={...localChecks(),note:'Could not reach the server checks; showing basic checks.'};
    }
    if(checkRequest!==controller)return;
    checkRequest=null;checkResults={checks:result.checks||[],addons:result.addons||[]};renderChecks(result.note);renderList();
    if(selected())renderSettingsHintOnly();
  }
  function renderSettingsHintOnly() {
    const result=checkResults.addons?.find(item=>item.id===selectedId),box=$('studio-settings');
    let hint=box.querySelector('.studio-floor');
    if(result&&Number.isFinite(result.floor_z)) {
      if(!hint){hint=Object.assign(document.createElement('span'),{className:'small-hint studio-floor'});box.querySelector('.studio-actions')?.before(hint);}
      hint.textContent=`Surface ${number(result.z_ref)} mm · floor ${number(result.floor_z)} mm above the bottom.`;
    }
  }
  // Without the server endpoint, catch the most common problems from the preview heights.
  function localChecks() {
    const checks=[];if(!frame)return {checks,addons:[]};
    for(const addon of project.addons) {
      const p=addon.params||{},{hx,hy}=footprint(addon),stats=footprintStats(addon,hx,hy),label=typeLabel(addon.type);
      const depth=addon.type==='nail_marker'?(p.depth??24.4):p.depth;
      if(['hole','nail_marker','pencil_holder','photo_slot','groove','pocket','coaster'].includes(addon.type)&&Number.isFinite(depth)) {
        const floor=(['pocket','coaster'].includes(addon.type)?stats.min:heightMm(addon.u,addon.v))-depth;
        if(floor<.8)checks.push({addon_id:addon.id,level:'error',message:`${label} would break through the bottom (floor ${number(floor)} mm).`});
        else if(floor<1.6)checks.push({addon_id:addon.id,level:'warning',message:`${label} leaves a thin floor (${number(floor)} mm).`});
      }
      if(['magnet','hanging'].includes(addon.type)&&stats.min-(p.depth||0)<.8)checks.push({addon_id:addon.id,level:'error',message:`${label} is deeper than the model above it.`});
      const corners=[[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]].map(([x,y])=>localToUV(addon,x,y));
      if(corners.some(({u,v})=>u<0||u>1||v<0||v>1))checks.push({addon_id:addon.id,level:'warning',message:`${label} extends past the model edge.`});
    }
    const bed=Number($('studio-bed').value)||256;
    if(Math.max(frame.W,frame.H)>bed)checks.push({addon_id:null,level:'warning',message:`The model (${number(frame.W,0)} × ${number(frame.H,0)} mm) is larger than the ${number(bed,0)} mm printer bed.`});
    return {checks,addons:[]};
  }
  function renderChecks(note) {
    const list=$('studio-check-list'),icons={error:'⛔',warning:'⚠',info:'•'};
    const items=checkResults.checks.map(check=>{
      const item=document.createElement('li');item.className=check.level;
      item.textContent=`${icons[check.level]||''} ${check.message}`;
      if(check.addon_id){item.tabIndex=0;item.role='button';item.addEventListener('click',()=>{selectedId=check.addon_id;rebuildGhosts();renderList();renderSettings();});}
      return item;
    });
    if(!items.length)items.push(Object.assign(document.createElement('li'),{className:'ok',textContent:'✓ No problems found.'}));
    if(note)items.push(Object.assign(document.createElement('li'),{className:'note',textContent:note}));
    list.replaceChildren(...items);
    const worst=checkResults.checks.some(check=>check.level==='error')?'error':checkResults.checks.some(check=>check.level==='warning')?'warning':'ok';
    $('studio-checks').dataset.level=worst;
  }

  // ---------- exports and jobs ----------
  async function runJob(body,progress) {
    if(!studioRoutes)return null;
    const start=await postJSON(`/api/studio/${ctx.state.id}/export`,body);
    if(missingRoute(start)){studioRoutes=false;return null;}
    if(!start.ok)throw new Error(await errorMessage(start));
    const {job}=await start.json();
    for(;;) {
      await sleep(350);
      const status=await fetch(`/api/studio/jobs/${job}`);
      if(!status.ok)throw new Error(await errorMessage(status));
      const value=await status.json();progress(value);
      if(value.state==='error')throw new Error(value.message||'Export failed.');
      if(value.state==='ready')break;
    }
    const file=await fetch(`/api/studio/jobs/${job}/file`);
    if(!file.ok)throw new Error(await errorMessage(file));
    return file;
  }
  function setBusy(value) {
    busy=value;
    document.querySelectorAll('[data-export]').forEach(button=>{button.disabled=value;});
    $('studio-preview').disabled=value;
    if(value)dialog.setAttribute('aria-busy','true');else dialog.removeAttribute('aria-busy');
  }
  async function exportFormat(format) {
    const status=$('export-status'),bar=$('studio-progress'),state=ctx.state;
    if(!state.id)return ctx.notify('Generate terrain before exporting.',true);
    const opts=ctx.options();
    if(!Number.isFinite(opts.size_mm)||opts.size_mm<10||opts.size_mm>2000)return ctx.notify('Choose a model size between 10 and 2000 millimeters.',true);
    if(busy)return;
    setBusy(true);status.textContent='Preparing your export…';bar.hidden=false;bar.value=0;
    try {
      await ctx.prepareExport(format,message=>{status.textContent=message;});
      if(format==='glb'&&!hasContent()) {
        status.textContent='Building the GLB in the browser…';await ctx.exportGLB();
      } else {
        const body=requestBody(format);
        if(!formatsWithProject.includes(format))delete body.project;
        status.textContent=format==='3mf'?'Building the color parts…':hasContent()?'Applying add-ons…':'Building your file…';
        let response=await runJob(body,value=>{bar.value=value.progress||0;if(value.message)status.textContent=value.message;});
        if(!response) {
          // Older server without the job API: the original endpoint (it ignores add-ons it does not know).
          if(format==='glb')throw new Error('GLB with add-ons needs the updated Terrain Studio server.');
          response=await postJSON(`/api/export/${state.id}`,body);
          if(!response.ok)throw new Error(await errorMessage(response));
          if(hasContent())ctx.notify('This server does not support add-ons yet; the file was exported without them.',true);
        }
        bar.value=1;
        ctx.download(await response.blob(),filenameOf(response,`terrain.${format}`));
      }
      status.textContent='Your file has been downloaded.';
    } catch(error){status.textContent=error.message;ctx.notify(error.message,true);}
    finally{setBusy(false);setTimeout(()=>{if(!busy)bar.hidden=true;},1200);ctx.updatePrintPalette();}
  }
  function exitPreview() {
    if(!previewing)return;
    previewing=null;if(renderer){disposeGroup(previewGroup);terrainGroup.visible=true;ghostGroup.visible=true;}
    $('studio-preview').setAttribute('aria-pressed','false');$('studio-preview').textContent='Preview cuts';requestRender();
  }
  async function previewCuts() {
    if(previewing){exitPreview();return;}
    if(!renderer||!frame||busy)return;
    if(!hasContent())return void($('export-status').textContent='Place an add-on first; without add-ons the model is unchanged.');
    const status=$('export-status'),bar=$('studio-progress'),format=ctx.state.palette==='print'?'3mf':'stl';
    setBusy(true);bar.hidden=false;bar.value=0;status.textContent='Computing the cuts on a coarse model…';
    const token=snapshot();
    try {
      await ctx.prepareExport(format,message=>{status.textContent=message;});
      const response=await runJob({...requestBody(format),format:'glb',preview:true},value=>{bar.value=value.progress||0;});
      if(!response)throw new Error('Preview cuts need the updated Terrain Studio server.');
      const result=await response.json();
      if(token!==snapshot())throw new Error('The project changed during the preview; try again.');
      disposeGroup(previewGroup);
      for(const part of result.parts||[]) {
        const positions=new Float32Array(part.positions.length);
        for(let index=0;index<part.positions.length;index+=3) {
          positions[index]=part.positions[index]*frame.mmUnit;positions[index+1]=part.positions[index+2]*frame.mmUnit;positions[index+2]=-part.positions[index+1]*frame.mmUnit;
        }
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
        if(part.indices)geometry.setIndex(part.indices);geometry.computeVertexNormals();
        previewGroup.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:part.color||'#b99570',roughness:.9,side:THREE.DoubleSide,flatShading:true})));
      }
      previewing=token;terrainGroup.visible=false;ghostGroup.visible=false;
      $('studio-preview').setAttribute('aria-pressed','true');$('studio-preview').textContent='Exit preview';
      status.textContent='Showing the computed cuts (coarse). Any edit returns to the editable view.';
    } catch(error){status.textContent=error.message;}
    finally{setBusy(false);bar.hidden=true;ctx.updatePrintPalette();requestRender();}
  }
  async function downloadBall(link) {
    const kind=link.dataset.markerKind==='platform'?'platform':'ball',format=link.dataset.markerFormat;
    const url=`/api/studio/marker-${kind}?format=${format}${format==='3mf'?`&color=${encodeURIComponent(project?.marker_balls.color||DEFAULT_BALL)}`:''}`;
    try {
      const response=await fetch(url);
      if(missingRoute(response))throw new Error('Marker-ball downloads need the updated Terrain Studio server.');
      if(!response.ok)throw new Error(await errorMessage(response));
      ctx.download(await response.blob(),filenameOf(response,`marker-${kind}.${format}`));
    } catch(error){$('export-status').textContent=error.message;ctx.notify(error.message,true);}
  }

  // ---------- wiring ----------
  function editingField(target) {return target instanceof HTMLElement&&(target.matches('input,select,textarea')||target.isContentEditable);}
  function keydown(event) {
    if(!dialog.open||editingField(event.target))return;
    const key=event.key,mod=event.ctrlKey||event.metaKey;
    if(mod&&key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
    if(mod&&key.toLowerCase()==='y'){event.preventDefault();redo();return;}
    if(mod)return;
    if(!selected())return;
    const step=event.shiftKey?10:1;
    const moves={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,step],ArrowDown:[0,-step]};
    if(moves[key]){event.preventDefault();nudge(...moves[key]);}
    else if(key==='r'||key==='R'){event.preventDefault();rotate(event.shiftKey?-15:15);}
    else if(key==='Delete'||key==='Backspace'){event.preventDefault();removeAddon(selectedId);}
  }
  function projectAction(action) {
    if(!store)return;
    if(action==='new') {
      const name=prompt('Name the new project',`Project ${store.projects.length+1}`);if(name===null)return;
      const created=emptyProject(name.trim().slice(0,80)||`Project ${store.projects.length+1}`);store.projects.push(created);activate(created.id);
    } else if(action==='rename') {
      const name=prompt('Rename this project',project.name);if(name===null||!name.trim())return;
      mutate(()=>{project.name=name.trim().slice(0,80);});
    } else if(action==='duplicate') {
      const copy={...clone(project),id:emptyProject('').id,name:`${project.name} copy`.slice(0,80)};store.projects.push(copy);activate(copy.id);
    } else if(action==='delete') {
      if(store.projects.length<2||!confirm(`Delete the project “${project.name}”?`))return;
      store.projects=store.projects.filter(item=>item.id!==project.id);activate(store.projects[0].id);
    }
    save();changed();
  }
  function wire() {
    $('studio-back').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('cancel',event=>{
      if(placing||dragging){event.preventDefault();if(dragging)endDrag(false);startPlacing(null);}
    });
    dialog.addEventListener('close',()=>{renderer?.setAnimationLoop(null);startPlacing(null);clearTimeout(checkTimer);ctx.updatePrintPalette();});
    document.addEventListener('keydown',keydown);
    document.querySelectorAll('[data-export]').forEach(button=>button.addEventListener('click',()=>exportFormat(button.dataset.export)));
    document.querySelectorAll('[data-studio-view]').forEach(button=>button.addEventListener('click',()=>{
      const view=button.dataset.studioView;
      if(view==='xray'){xray=!xray;applyMaterials();setCamera(cameraMode);}
      else if(view==='section'){section=!section;applyMaterials();setCamera(section?'perspective':cameraMode);}
      else if(view==='profile')setProfile(!profileOn);
      else setCamera(view);
    }));
    $('studio-preview').addEventListener('click',previewCuts);
    wireProfile();
    $('studio-undo').addEventListener('click',undo);$('studio-redo').addEventListener('click',redo);
    $('studio-project').addEventListener('change',event=>{activate(event.target.value);save();changed();});
    document.querySelectorAll('[data-project-action]').forEach(button=>button.addEventListener('click',()=>projectAction(button.dataset.projectAction)));
    $('studio-export-json').addEventListener('click',()=>{
      if(!project)return;
      const name=project.name.replace(/[^a-z0-9-_ ]/gi,'').trim().replace(/\s+/g,'-').toLowerCase()||'project';
      ctx.download(new Blob([JSON.stringify(payload(),null,2)],{type:'application/json'}),`${name}.studio.json`);
    });
    $('studio-import').addEventListener('click',()=>$('studio-import-file').click());
    $('studio-import-file').addEventListener('change',async event=>{
      const file=event.target.files[0];event.target.value='';if(!file||!store)return;
      try {
        const imported=sanitize(JSON.parse(await file.text()));store.projects.push(imported);activate(imported.id);save();changed();
        $('studio-place-hint').textContent=`Imported “${imported.name}”.`;
      } catch(error){ctx.notify(error instanceof SyntaxError?'This file is not valid JSON.':error.message,true);}
    });
    $('export-size').addEventListener('input',()=>{const next=computeFrame();if(next&&dialog.open){frame=next;rebuildGhosts();renderSettings();$('studio-dimensions').textContent=$('export-dimensions').textContent;scheduleCheck();}});
    $('studio-base').addEventListener('change',()=>{
      const input=$('base'),value=clamp(Math.round(Number($('studio-base').value)*2)/2||Number(input.value),Number(input.min),Number(input.max));
      $('studio-base').value=value;input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));scheduleCheck();
    });
    try{const bed=Number(localStorage.getItem(BED_KEY));if(bed>=50&&bed<=2000)$('studio-bed').value=bed;}catch{/* Optional. */}
    $('studio-bed').addEventListener('change',()=>{try{localStorage.setItem(BED_KEY,$('studio-bed').value);}catch{/* Optional. */}scheduleCheck();});
    $('studio-marker-include').addEventListener('change',()=>{if(project)mutate(()=>{project.marker_balls.include=$('studio-marker-include').checked;});});
    $('studio-marker-color').addEventListener('input',()=>{if(project){project.marker_balls.color=$('studio-marker-color').value.toLowerCase();save();rebuildGhosts();ctx.updatePrintPalette();}});
    $('studio-marker-color').addEventListener('change',()=>{if(project){save();scheduleCheck();}});
    $('studio-marker-style').addEventListener('change',()=>{
      if(!project)return;
      mutate(()=>{
        const before=markerInfo()?.exposed_nail_length;
        project.marker_balls.style=$('studio-marker-style').value==='platform'?'platform':'ball';
        const after=markerInfo()?.exposed_nail_length;
        // Nail holes still at the old marker's seating depth follow the new marker, so it sits on the surface.
        if(before&&after)project.addons.forEach(addon=>{if(addon.type==='nail_marker'&&addon.params&&Math.abs((addon.params.depth??before)-before)<1e-6)addon.params.depth=after;});
      });
      syncMarker();
    });
    $('studio-platform-top').addEventListener('change',()=>{if(project)mutate(()=>{project.marker_balls.top=$('studio-platform-top').value;});syncMarker();ctx.updatePrintPalette();});
    $('studio-platform-top-color').addEventListener('input',()=>{if(project){project.marker_balls.top_color=$('studio-platform-top-color').value.toLowerCase();save();ctx.updatePrintPalette();}});
    $('studio-platform-top-color').addEventListener('change',()=>{if(project){save();scheduleCheck();}});
    $('studio-platform-area').addEventListener('change',()=>{
      if(!project)return;const value=Number($('studio-platform-area').value);
      mutate(()=>{project.marker_balls.top_area_mm=Number.isFinite(value)&&value>0?clamp(value,10,80):30;});syncMarker();
    });
    $('studio-platform-exaggeration').addEventListener('change',()=>{
      if(!project)return;const text=$('studio-platform-exaggeration').value.trim(),value=Number(text);
      mutate(()=>{project.marker_balls.top_exaggeration=text&&Number.isFinite(value)?clamp(value,.5,20):null;});syncMarker();
    });
    document.querySelectorAll('[data-marker-format]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();downloadBall(link);}));
    renderTemplates();renderPalette();
  }
  wire();

  return {
    open() {
      if(!ctx.state.data)return;
      loadStore();
      if(!dialog.open)dialog.showModal();
      const hasView=setupView();
      if(hasView)resize();
      syncModel();
      if(hasView){resize();renderer.setAnimationLoop(loop);}
      renderProjects();renderList();renderSettings();renderMarker();
      $('studio-undo').disabled=!undoStack.length;$('studio-redo').disabled=!redoStack.length;
      if(saveFailed)$('studio-place-hint').textContent='Projects cannot be saved in this browser; export the project JSON to keep it.';
      loadCatalog().then(()=>{if(dialog.open){rebuildGhosts();renderList();renderSettings();}});
      ctx.updatePrintPalette();scheduleCheck();
    },
    close(){if(dialog.open)dialog.close();},
    // The main scene rebuilt (new area, base, palette, features): copy it again while the studio is visible.
    modelChanged() {
      dirtyModel=true;
      if(!dialog.open)return;
      if(storeKey&&ctx.state.data&&areaKey()!==storeKey){loadStore();renderProjects();renderList();renderSettings();}
      queueMicrotask(()=>{if(dirtyModel){syncModel();scheduleCheck();}});
    },
    // Filament colors the project adds on top of surfaces and features (for the 3MF four-color limit).
    extraColors() {
      if(!project)return [];
      const colors=project.addons.filter(addon=>addsMaterial(addon)&&addon.color).map(addon=>addon.color.toLowerCase());
      // Like the server: the ball color counts only when there is a nail marker to print a ball for.
      if(project.marker_balls.include&&project.addons.some(addon=>addon.type==='nail_marker')) {
        const balls=project.marker_balls;colors.push(balls.color.toLowerCase());
        if(balls.style==='platform'&&balls.top!=='none')colors.push((balls.top_color||balls.color).toLowerCase());
      }
      return colors;
    },
    get project(){return payload();},
  };
}
