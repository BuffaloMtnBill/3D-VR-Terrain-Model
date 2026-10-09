/* Silhouette design page: one elevation-profile slice as a flat ridgeline piece, with a caption and an optional mount.
 * The server lays the piece out (POST /api/silhouette/<id>/outline) and builds its files; this module draws it to scale,
 * keeps the slice in step with the geography selection page's profile controls, and remembers settings per framed area.
 * app.js hands over a small context: state, options(), notify, download, units, printColors.
 */
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';

const $=id=>document.getElementById(id);
const STORE_PREFIX='terrain-silhouette:v1:';
const SVG_NS='http://www.w3.org/2000/svg';
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const number=(value,decimals=1)=>Number(value).toLocaleString(undefined,{maximumFractionDigits:decimals});
const isHex=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
// Numeric settings: input id, limits. Choices: select id, allowed values.
const NUMBERS={width_mm:['silhouette-width',40,400],vertical_scale:['silhouette-vertical',.5,10],base_mm:['silhouette-base',2,40],
  thickness_mm:['silhouette-thickness',1.2,30],smoothing:['silhouette-smoothing',0,100],text_size:['silhouette-text-size',2,30],
  text_depth:['silhouette-text-depth',.2,5],hole_diameter:['silhouette-hole',2,10]};
const CHOICES={source:['silhouette-source',['true','shaped']],text_style:['silhouette-text-style',['engrave','emboss','stencil']],
  text_align:['silhouette-text-align',['left','center','right']],mount:['silhouette-mount',['none','stand','holes','keyholes']]};
const COLORS={text_color:'silhouette-text-color',body_color:'silhouette-body-color'};
const DEFAULTS={width_mm:180,vertical_scale:2,base_mm:8,thickness_mm:4,smoothing:0,text_size:5,text_depth:.8,hole_diameter:4,source:'true',
  text_style:'engrave',text_align:'center',mount:'none',mirror:false,trim:[0,100],text:'',text_color:'#f0ead6',body_color:'#234e40'};
const MOUNT_HINTS={none:'',stand:'Two feet print beside the piece, each with a slot the thickness plus 0.2 mm wide; the piece stands upright in them.',
  holes:'Two holes through the base, for nails or screws.',keyholes:'Slide the piece down onto two screw heads. Keyholes need about 14 mm of height at each end.'};

async function errorMessage(response) {
  try { return (await response.json()).error||`Request failed (${response.status}).`; }
  catch { return `Request failed (${response.status}).`; }
}
const postJSON=(url,body,signal)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
const filenameOf=(response,fallback)=>response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||fallback;
function hash(text) {
  let value=0x811c9dc5;
  for(let index=0;index<text.length;index++){value^=text.charCodeAt(index);value=Math.imul(value,0x01000193);}
  return (value>>>0).toString(16).padStart(8,'0');
}
function svg(tag,attributes={},parent=null) {
  const element=document.createElementNS(SVG_NS,tag);
  for(const [name,value] of Object.entries(attributes))element.setAttribute(name,value);
  parent?.append(element);return element;
}
// Polygons arrive in mm with y up; the SVG draws y down, so every y is negated.
const ringPath=ring=>ring.map(([x,y],index)=>`${index?'L':'M'}${x} ${-y}`).join('')+'Z';
const polygonPath=polygon=>[polygon.outer,...polygon.holes].map(ringPath).join('');

export function createSilhouette(ctx) {
  const dialog=$('silhouette');
  let settings={...DEFAULTS},storeKey=null,result=null,timer=null,request=null,view='front',busy=false,three=null;

  // ---------- settings: per framed area, like the 3D model design page's projects ----------
  function areaKey() {
    const b=ctx.state.data.bounds;
    return STORE_PREFIX+hash(JSON.stringify({bounds:['north','south','east','west'].map(name=>Number(b[name]).toFixed(6)),rotation:Number(b.rotation_deg||0).toFixed(4)}));
  }
  const placeName=()=>ctx.state.loadedName||ctx.state.name||'';
  function sanitize(saved) {
    if(!saved||typeof saved!=='object')return null;
    const clean={...DEFAULTS};
    for(const [name,[,low,high]] of Object.entries(NUMBERS))if(Number.isFinite(saved[name]))clean[name]=clamp(saved[name],low,high);
    for(const [name,[,allowed]] of Object.entries(CHOICES))if(allowed.includes(saved[name]))clean[name]=saved[name];
    for(const name of Object.keys(COLORS))if(isHex(saved[name]))clean[name]=saved[name].toLowerCase();
    if(typeof saved.text==='string')clean.text=saved.text.replace(/\n/g,' ').slice(0,60);
    clean.mirror=saved.mirror===true;
    if(Array.isArray(saved.trim)&&saved.trim.every(Number.isFinite)&&saved.trim[1]-saved.trim[0]>=5)clean.trim=[clamp(saved.trim[0],0,95),clamp(saved.trim[1],5,100)];
    return clean;
  }
  function load() {
    const key=areaKey();
    if(key===storeKey)return;
    storeKey=key;
    let saved=null;
    try{saved=sanitize(JSON.parse(localStorage.getItem(key)||'null'));}catch{saved=null;}
    if(saved)settings=saved;
    else {
      // A fresh piece follows the geography page: its elevation multiplier, its place name, and the Print palette's colors.
      const colors=ctx.printColors();
      settings={...DEFAULTS,vertical_scale:clamp(Number($('exaggeration').value)||2,.5,10),text:placeName().slice(0,60),
        body_color:isHex(colors.dark_foliage)?colors.dark_foliage:DEFAULTS.body_color,text_color:isHex(colors.snow)?colors.snow:DEFAULTS.text_color};
    }
    writeForm();
  }
  function save() {try{localStorage.setItem(storeKey,JSON.stringify(settings));}catch{/* Optional persistence. */}}
  function writeForm() {
    for(const [name,[id]] of Object.entries(NUMBERS))$(id).value=settings[name];
    for(const [name,[id]] of Object.entries(CHOICES))$(id).value=settings[name];
    for(const [name,id] of Object.entries(COLORS))$(id).value=settings[name];
    $('silhouette-text').value=settings.text;$('silhouette-mirror').checked=settings.mirror;
    $('silhouette-trim-start').value=settings.trim[0];$('silhouette-trim-end').value=settings.trim[1];
    labels();
  }
  function readForm(changed=null) {
    for(const [name,[id,low,high]] of Object.entries(NUMBERS)){const value=Number($(id).value);if($(id).value!==''&&Number.isFinite(value))settings[name]=clamp(value,low,high);}
    for(const [name,[id,allowed]] of Object.entries(CHOICES))if(allowed.includes($(id).value))settings[name]=$(id).value;
    for(const [name,id] of Object.entries(COLORS))settings[name]=$(id).value.toLowerCase();
    settings.text=$('silhouette-text').value.slice(0,60);settings.mirror=$('silhouette-mirror').checked;
    // The trim keeps at least 5% of the slice; the handle not being moved gives way.
    let start=Number($('silhouette-trim-start').value),end=Number($('silhouette-trim-end').value);
    if(end-start<5){if(changed==='silhouette-trim-end')start=Math.max(0,end-5);else end=Math.min(100,start+5);start=Math.min(start,end-5);}
    $('silhouette-trim-start').value=start;$('silhouette-trim-end').value=end;settings.trim=[start,end];
    labels();
  }
  function labels() {
    $('silhouette-trim-start-value').textContent=`${settings.trim[0]}%`;$('silhouette-trim-end-value').textContent=`${settings.trim[1]}%`;
    $('silhouette-smoothing-value').textContent=`${settings.smoothing}%`;
    $('silhouette-hole-block').hidden=settings.mount!=='holes';
    $('silhouette-mount-hint').textContent=MOUNT_HINTS[settings.mount];
    const text=Boolean(settings.text.trim());
    ['silhouette-text-style','silhouette-text-size','silhouette-text-align','silhouette-text-color'].forEach(id=>{$(id).disabled=!text;});
    $('silhouette-text-depth').disabled=!text||settings.text_style==='stencil';
    $('silhouette-text-color').disabled=!text||settings.text_style==='stencil';
  }
  function requestBody(extra={}) {
    const opts=ctx.options();
    return {...settings,trim:[...settings.trim],direction:$('profile-direction').value,position:Number($('profile-position').value),
      relief:opts.relief,relief_strength:opts.relief_strength,...extra};
  }

  // ---------- the slice: shared with the geography selection page's elevation profile ----------
  function syncSlice() {
    const direction=$('profile-direction'),own=$('silhouette-direction');
    [...direction.options].forEach((option,index)=>{if(own.options[index])own.options[index].textContent=option.textContent;});
    own.value=direction.value;$('silhouette-position').value=$('profile-position').value;
    $('silhouette-position-value').textContent=`${$('profile-position').value}%`;
  }
  function sliceLabel() {
    const direction=$('profile-direction').selectedOptions[0]?.textContent||'';
    let text=`${direction} · ${$('profile-position').value}% across`;
    if(result){const u=ctx.units();text+=` · ${number(result.slice_length_m/u.distance,2)} ${u.distanceLabel} of ground`;}
    $('silhouette-slice-label').textContent=text;
  }

  // ---------- outline requests ----------
  function schedule() {clearTimeout(timer);timer=setTimeout(refresh,120);}
  async function refresh() {
    if(!dialog.open||!ctx.state.id)return;
    request?.abort();
    const controller=request=new AbortController();
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/outline`,requestBody(),controller.signal);
      if(!response.ok)throw new Error(await errorMessage(response));
      result=await response.json();
      if(controller!==request)return;
      draw();rebuild3d();renderChecks();sliceLabel();
    } catch(error) {
      if(error.name==='AbortError')return;
      renderChecks(error.message);
    }
  }
  function renderChecks(error=null) {
    const list=$('silhouette-check-list'),box=$('silhouette-checks');list.replaceChildren();
    const add=(level,text)=>{const item=document.createElement('li');item.className=level;item.textContent=text;list.append(item);};
    if(error){add('error',error);box.dataset.level='error';return;}
    if(!result)return;
    result.warnings.forEach(warning=>add('warning',warning));
    const size=`${number(result.width_mm)} × ${number(result.height_mm)} × ${number(settings.thickness_mm)} mm`;
    add(result.warnings.length?'note':'ok',`${size} · lowest point ${number(result.min_profile_mm)} mm tall`);
    if(settings.mount==='stand')add('note','The stand feet print beside the piece in the same file.');
    box.dataset.level=result.warnings.length?'warning':'ok';
    $('silhouette-dimensions').textContent=size;
  }

  // ---------- front view: the piece to scale ----------
  function draw() {
    const root=$('silhouette-svg');root.replaceChildren();
    if(!result||!result.outline.outer.length)return;
    const W=result.width_mm,H=result.height_mm,feet=result.mount.filter(item=>item.kind==='foot');
    const pad=Math.max(W,H)*.06,below=(feet.length?6:0)+pad*1.4,rect=root.getBoundingClientRect();
    // Labels stay about 11 px tall whatever the piece's size; the room for the height label depends on the scale, so fit twice.
    let box,font=0;
    for(let pass=0;pass<2;pass++) {
      box=[-pad,-(H+pad),W+pad*2+font*5,H+pad+below+font*1.5];
      font=11/(Math.min((rect.width||800)/box[2],(rect.height||500)/box[3])||1);
    }
    root.setAttribute('viewBox',box.join(' '));root.setAttribute('preserveAspectRatio','xMidYMid meet');
    const grid=svg('g',{class:'sil-grid'},root);
    for(let x=0;x<=W+1e-6;x+=10)svg('line',{x1:x,x2:x,y1:0,y2:-Math.ceil(H/10)*10},grid);
    for(let y=0;y<=H+10;y+=10)svg('line',{x1:0,x2:W,y1:-y,y2:-y},grid);
    svg('path',{class:'sil-body','fill-rule':'evenodd',fill:settings.body_color,d:polygonPath(result.outline)},root);
    if(result.text.length) {
      const style=result.text_style,fill=style==='stencil'?'#101b14':settings.text_color;
      svg('path',{class:'sil-text','fill-rule':'evenodd',fill,stroke:style==='emboss'?'#00000088':'none','stroke-width':style==='emboss'?1:0,
        opacity:style==='engrave'?.85:1,d:result.text.map(polygonPath).join('')},root);
    }
    for(const foot of feet)svg('rect',{class:'sil-foot',x:foot.x0,y:-foot.y1,width:foot.x1-foot.x0,height:foot.y1-foot.y0},root);
    // Dimensions: width below, height at the right.
    const dims=svg('g',{class:'sil-dimension'},root),y=(feet.length?3:0)+pad*.7,x=W+pad*.9;
    svg('line',{x1:0,x2:W,y1:y,y2:y},dims);svg('line',{x1:0,x2:0,y1:y-pad*.2,y2:y+pad*.2},dims);svg('line',{x1:W,x2:W,y1:y-pad*.2,y2:y+pad*.2},dims);
    svg('line',{x1:x,x2:x,y1:0,y2:-H},dims);svg('line',{x1:x-pad*.2,x2:x+pad*.2,y1:0,y2:0},dims);svg('line',{x1:x-pad*.2,x2:x+pad*.2,y1:-H,y2:-H},dims);
    svg('text',{class:'sil-label',x:W/2,y:y+font*1.3,'font-size':font,'text-anchor':'middle'},root).textContent=`${number(W)} mm`;
    svg('text',{class:'sil-label',x:x+font*.5,y:-H/2,'font-size':font,'dominant-baseline':'middle'},root).textContent=`${number(H)} mm`;
  }

  // ---------- 3D view: the same outline extruded, standing as it would on a desk ----------
  function setup3d() {
    if(three!==null)return Boolean(three);
    const container=$('silhouette-3d');
    try{three={renderer:new THREE.WebGLRenderer({antialias:true,alpha:true})};}
    catch{three=false;container.textContent='The 3D view needs WebGL. The front view shows the piece to scale.';return false;}
    const {renderer}=three;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
    container.append(renderer.domElement);renderer.domElement.setAttribute('aria-label','Silhouette 3D view: drag to orbit');
    three.scene=new THREE.Scene();three.camera=new THREE.PerspectiveCamera(35,1,.5,5000);
    three.controls=new OrbitControls(three.camera,renderer.domElement);three.controls.enableDamping=true;
    three.scene.add(new THREE.HemisphereLight(0xf0dfbb,0x566747,2.2));
    const sun=new THREE.DirectionalLight(0xffecc8,2.2);sun.position.set(-.4,1,1.2);three.scene.add(sun);
    three.group=new THREE.Group();three.scene.add(three.group);
    new ResizeObserver(resize3d).observe(container);
    return true;
  }
  function resize3d() {
    if(!three)return;
    const container=$('silhouette-3d'),width=container.clientWidth,height=container.clientHeight;
    if(!width||!height)return;
    three.renderer.setSize(width,height);three.camera.aspect=width/height;three.camera.updateProjectionMatrix();
  }
  function shapeOf(polygon) {
    const shape=new THREE.Shape(polygon.outer.map(([x,y])=>new THREE.Vector2(x,y)));
    shape.holes=polygon.holes.map(ring=>new THREE.Path(ring.map(([x,y])=>new THREE.Vector2(x,y))));
    return shape;
  }
  function rebuild3d(fit=false) {
    if(view!=='3d'||!three||!result)return;
    const group=three.group;
    for(const child of [...group.children]){child.geometry.dispose();child.material.dispose();group.remove(child);}
    const T=settings.thickness_mm,depth=settings.text_depth,material=color=>new THREE.MeshStandardMaterial({color,roughness:.85});
    const extrude=(shapes,amount,z,color)=>{
      const geometry=new THREE.ExtrudeGeometry(shapes,{depth:amount,bevelEnabled:false,curveSegments:4});geometry.translate(0,0,z);
      group.add(new THREE.Mesh(geometry,material(color)));
    };
    extrude([shapeOf(result.outline)],T,0,settings.body_color);
    if(result.text.length) {
      const shapes=result.text.map(shapeOf);
      if(result.text_style==='emboss')extrude(shapes,depth,T,settings.text_color);
      else if(result.text_style==='engrave')extrude(shapes,depth,T-depth+.02,settings.text_color);
      else extrude(shapes,T+.1,-.05,'#101b14');  // cut through: shown as an opening
    }
    const reach=clamp(result.height_mm*.5,30,90);
    for(const foot of result.mount.filter(item=>item.kind==='foot')) {
      const geometry=new THREE.BoxGeometry(foot.x1-foot.x0,foot.y1-foot.y0,reach);
      geometry.translate((foot.x0+foot.x1)/2,(foot.y0+foot.y1)/2,T/2);group.add(new THREE.Mesh(geometry,material('#876749')));
    }
    group.position.set(-result.width_mm/2,0,-T/2);
    if(fit||!three.fitted) {
      // Far enough back that the whole piece fits the view's width and height, seen from a little above and to the right.
      const tangent=Math.tan(THREE.MathUtils.degToRad(three.camera.fov/2));
      const distance=Math.max(result.height_mm/2/tangent,result.width_mm/2/(tangent*three.camera.aspect))*1.3;
      three.controls.target.set(0,result.height_mm/2,0);
      three.camera.position.set(distance*.3,result.height_mm/2+distance*.3,distance*.9);
      three.controls.update();three.fitted=true;
    }
  }
  function setView(next) {
    view=next;
    document.querySelectorAll('[data-silhouette-view]').forEach(button=>{const active=button.dataset.silhouetteView===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    $('silhouette-svg').style.display=view==='front'?'':'none';$('silhouette-3d').hidden=view!=='3d';
    $('silhouette-view-hint').textContent=view==='front'?'Front view to scale · the grid is 10 mm':'Drag to orbit · scroll to zoom';
    if(view==='3d'&&setup3d()){resize3d();rebuild3d(true);three.renderer.setAnimationLoop(()=>{three.controls.update();three.renderer.render(three.scene,three.camera);});}
    else if(three)three.renderer.setAnimationLoop(null);
    if(view==='front')draw();
  }

  // ---------- exports ----------
  async function exportFile(format) {
    if(busy||!ctx.state.id)return;
    const status=$('silhouette-status'),buttons=document.querySelectorAll('[data-silhouette-export]');
    busy=true;buttons.forEach(button=>{button.disabled=true;});dialog.setAttribute('aria-busy','true');
    status.classList.remove('error');status.textContent=`Building the ${format==='json'?'settings file':format.toUpperCase()}…`;
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/export`,requestBody({format}));
      if(!response.ok)throw new Error(await errorMessage(response));
      const slug=placeName().normalize('NFKD').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase();
      const name=filenameOf(response,`silhouette.${format}`);
      ctx.download(await response.blob(),slug?`${slug}-${name}`:name);
      status.textContent='Your file has been downloaded.';
    } catch(error){status.classList.add('error');status.textContent=error.message;ctx.notify(error.message,true);}
    finally{busy=false;buttons.forEach(button=>{button.disabled=false;});dialog.removeAttribute('aria-busy');}
  }

  function wire() {
    $('silhouette-back').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{clearTimeout(timer);request?.abort();if(three)three.renderer.setAnimationLoop(null);});
    // This page's slice controls drive the geography page's own, whose listeners redraw its chart and map line and refresh this page.
    $('silhouette-position').addEventListener('input',event=>{
      const main=$('profile-position');
      if(main.value!==event.target.value){main.value=event.target.value;main.dispatchEvent(new Event('input',{bubbles:true}));}
    });
    $('silhouette-direction').addEventListener('change',event=>{
      const main=$('profile-direction');
      if(main.value!==event.target.value){main.value=event.target.value;main.dispatchEvent(new Event('change',{bubbles:true}));}
    });
    const sliceChanged=()=>{syncSlice();sliceLabel();if(dialog.open)schedule();};
    $('profile-position').addEventListener('input',sliceChanged);
    $('profile-direction').addEventListener('change',sliceChanged);
    const inputs=[...Object.values(NUMBERS).map(([id])=>id),...Object.values(CHOICES).map(([id])=>id),...Object.values(COLORS),
      'silhouette-text','silhouette-mirror','silhouette-trim-start','silhouette-trim-end'];
    for(const id of inputs)$(id).addEventListener(id.endsWith('color')||$(id).tagName==='SELECT'||$(id).type==='checkbox'?'change':'input',()=>{
      readForm(id);save();
      // Colors only repaint; everything else changes the outline.
      if(id.endsWith('color')){draw();rebuild3d();}else schedule();
    });
    for(const id of Object.values(COLORS))$(id).addEventListener('input',()=>{readForm(id);draw();rebuild3d();});
    document.querySelectorAll('[data-silhouette-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.silhouetteView)));
    document.querySelectorAll('[data-silhouette-export]').forEach(button=>button.addEventListener('click',()=>exportFile(button.dataset.silhouetteExport)));
    new ResizeObserver(()=>{if(dialog.open&&view==='front')draw();}).observe($('silhouette-view'));
  }
  wire();

  return {
    open() {
      if(!ctx.state.data)return;
      load();syncSlice();
      $('silhouette-title').textContent=placeName()||'Your landscape';
      if(!dialog.open)dialog.showModal();
      setView(view);sliceLabel();refresh();
    },
    close(){if(dialog.open)dialog.close();},
    // A new area, multiplier, or elevation profile on the geography page: reload this area's settings and redraw.
    modelChanged() {
      if(!dialog.open||!ctx.state.data)return;
      if(areaKey()!==storeKey){load();three&&(three.fitted=false);}
      $('silhouette-title').textContent=placeName()||'Your landscape';
      syncSlice();schedule();
    },
  };
}
