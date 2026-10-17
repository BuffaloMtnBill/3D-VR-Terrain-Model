// VR explorer (WebXR, e.g. a Meta Quest on the LAN): fly over the terrain, grab it with the triggers, and use the
// page's own controls from a floating menu. The menu drives the real page inputs, so everything stays in step.
import * as THREE from 'three';
import {createCut} from './vr-cut.js';

const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
const Y=new THREE.Vector3(0,1,0);

const SPEED=1.6;              // meters per second at full stick, in the room: the same at every zoom level
const DEADZONE=.15;
const PINCH={press:.018,release:.03};   // thumb-to-index distance (m) that starts and ends a pinch
const PALM_FACING=.6;                   // how squarely a palm must face your eyes to show the menu button
const TOUCH=.025;                       // fingertip distance (m) that presses the palm button
const TABLE={width:1,height:.75,distance:.8};   // where Reset view puts the model: 1 m wide at table height
const PANEL={width:.62,height:.93,canvasWidth:1024,canvasHeight:1536};
const UI={paper:'#101b14',surface:'#19281e',raised:'#223329',line:'#414633',ink:'#fff6d6',muted:'#a9ae99',
  accent:'#e9c890',green:'#426746',hover:'#2f4834',error:'#d2a36c',sans:'Inter,"Segoe UI",Arial,sans-serif',serif:'Georgia,"Times New Roman",serif'};

const TILE_CELLS=48;          // grid cells per side of a VR surface tile; tiles out of view are not drawn

// The surface split into tiles that share the page's vertex buffers and material, each with its own bounds,
// so at life size only the ground around you is drawn. Works for clipped (round) surfaces too: triangles are
// sorted into tiles by their centers.
function tileSurface(mesh,columns,rows) {
  const geometry=mesh.geometry,position=geometry.getAttribute('position');
  const index=geometry.index?geometry.index.array:Uint32Array.from({length:position.count},(_,i)=>i);
  geometry.computeBoundingBox();
  const box=geometry.boundingBox,across=Math.max(1,Math.ceil(columns/TILE_CELLS)),down=Math.max(1,Math.ceil(rows/TILE_CELLS));
  const spanX=Math.max(box.max.x-box.min.x,1e-9),spanZ=Math.max(box.max.z-box.min.z,1e-9);
  const bins=Array.from({length:across*down},()=>[]),p=position.array;
  for(let t=0;t<index.length;t+=3) {
    const a=index[t]*3,b=index[t+1]*3,c=index[t+2]*3;
    const x=(p[a]+p[b]+p[c])/3,z=(p[a+2]+p[b+2]+p[c+2])/3;
    const i=Math.min(across-1,Math.floor((x-box.min.x)/spanX*across)),j=Math.min(down-1,Math.floor((z-box.min.z)/spanZ*down));
    bins[j*across+i].push(index[t],index[t+1],index[t+2]);
  }
  const group=new THREE.Group();group.name='VR surface tiles';
  const point=new THREE.Vector3();
  for(const triangles of bins) {
    if(!triangles.length)continue;
    const tile=new THREE.BufferGeometry();
    for(const [name,attribute] of Object.entries(geometry.attributes))tile.setAttribute(name,attribute);
    tile.setIndex(new THREE.BufferAttribute(position.count>65535?Uint32Array.from(triangles):Uint16Array.from(triangles),1));
    const bounds=new THREE.Box3();
    for(const vertex of triangles)bounds.expandByPoint(point.fromBufferAttribute(position,vertex));
    tile.boundingBox=bounds;tile.boundingSphere=bounds.getBoundingSphere(new THREE.Sphere());
    const part=new THREE.Mesh(tile,mesh.material);part.name='VR surface tile';
    part.position.copy(mesh.position);part.quaternion.copy(mesh.quaternion);part.scale.copy(mesh.scale);
    group.add(part);
  }
  return group;
}

function canvasPlane(width,height,canvasWidth,canvasHeight) {
  const canvas=document.createElement('canvas');canvas.width=canvasWidth;canvas.height=canvasHeight;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
  const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,toneMapped:false,depthTest:false,depthWrite:false});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,height),material);mesh.renderOrder=1000;
  return {mesh,canvas,texture,context:canvas.getContext('2d')};
}

function labelOf(el) {
  const label=(el.id&&document.querySelector(`label[for="${el.id}"]`))||el.closest('label');
  return (label?.textContent||el.getAttribute('aria-label')||el.id).replace(/\s+/g,' ').trim();
}
const shown=el=>Boolean(el)&&!el.closest('[hidden]');
let instance=null;
// The page's VR explorer, for the browser test (modules are shared, so an import gets the same one).
export const currentVR=()=>instance;

export function createVR(ctx) {
  const {renderer,scene}=ctx;
  const rig=new THREE.Group();rig.name='VR rig';
  const camera=new THREE.PerspectiveCamera(70,1,.05,200);rig.add(camera);
  // The rig maps the room onto the world: world = position + scale · rotateY(yaw) · room.
  const view={position:new THREE.Vector3(),yaw:0,scale:1,size:6.4,minScale:.001,maxScale:100};
  let session=null,background=null,lastId=null,menuTab='terrain',cutGenerating=false,regions=[],menuSignature='',lastPoll=0,cutFramed=false,palmPressed=0;
  const cut=createCut(ctx);
  const raycaster=new THREE.Raycaster();

  // ---------- controllers ----------
  const laserMaterial=new THREE.LineBasicMaterial({color:0xfff6d6,transparent:true,opacity:.65});
  const hands=[0,1].map(index=>{
    const controller=renderer.xr.getController(index),grip=renderer.xr.getControllerGrip(index);
    const laser=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-1)]),laserMaterial.clone());
    const dot=new THREE.Mesh(new THREE.SphereGeometry(.006,12,8),new THREE.MeshBasicMaterial({color:0xe9c890,depthTest:false}));
    dot.renderOrder=1001;dot.visible=false;controller.add(laser,dot);
    const body=new THREE.Mesh(new THREE.CylinderGeometry(.017,.022,.11,16),new THREE.MeshStandardMaterial({color:0x223329,roughness:.6}));
    body.rotation.x=Math.PI/2.6;body.position.set(0,-.01,.03);grip.add(body);
    const tip=canvasPlane(.075,.022,300,88);
    tip.context.fillStyle='#101b14d0';tip.context.fillRect(0,0,300,88);tip.context.fillStyle=UI.accent;
    tip.context.font=`600 44px ${UI.sans}`;tip.context.textAlign='center';tip.context.textBaseline='middle';tip.context.fillText('A / X: menu',150,46);
    tip.texture.needsUpdate=true;tip.mesh.position.set(0,.045,.02);tip.mesh.rotation.x=-.9;grip.add(tip.mesh);
    // Tracked hands: three.js keeps one object per joint up to date; each gets a small dot so you can see your hands.
    const xrHand=renderer.xr.getHand(index);
    const hand={controller,grip,xrHand,laser,dot,tip:tip.mesh,source:null,trigger:false,menuButton:false,mode:null,region:null,hover:null,anchor:null,lastInput:0,pending:false,sliderU:0,
      point:new THREE.Vector3(),tracked:false,handle:null};
    controller.addEventListener('connected',event=>{hand.source=event.data;});
    controller.addEventListener('disconnected',()=>{hand.source=null;hand.mode=null;hand.trigger=false;});
    rig.add(controller,grip,xrHand);
    return hand;
  });

  // ---------- hands ----------
  const jointMaterial=new THREE.MeshStandardMaterial({color:0xf3ead2,roughness:.7});
  const tipMaterial=new THREE.MeshStandardMaterial({color:0xe9c890,roughness:.5,emissive:0x3a2a10});
  const jointGeometry=new THREE.SphereGeometry(1,10,8);
  const joint=(hand,name)=>{const j=hand.xrHand.joints?.[name];return j&&j.visible!==false?j:null;};
  function dressJoints(hand) {
    for(const [name,j] of Object.entries(hand.xrHand.joints||{})) {
      if(j.userData.dot)continue;
      const dot=new THREE.Mesh(jointGeometry,name.endsWith('-tip')?tipMaterial:jointMaterial);
      dot.scale.setScalar(Math.max(j.jointRadius||.008,.006)*.9);j.add(dot);j.userData.dot=dot;
    }
  }
  // A pinch: the system's own (select button) or thumb and index tips touching, with a little hysteresis.
  function pinching(hand) {
    if(hand.source?.gamepad?.buttons[0]?.pressed)return true;
    const thumb=joint(hand,'thumb-tip'),index=joint(hand,'index-finger-tip');
    if(!thumb||!index)return false;
    return thumb.position.distanceTo(index.position)<(hand.trigger?PINCH.release:PINCH.press);
  }
  // Where a hand acts in the room: between thumb and index tips, or the controller itself.
  function handPoint(hand) {
    const thumb=joint(hand,'thumb-tip'),index=joint(hand,'index-finger-tip');
    if(hand.tracked&&thumb&&index)return hand.point.copy(thumb.position).add(index.position).multiplyScalar(.5);
    return hand.point.copy(hand.controller.position);
  }
  // The palm's outward normal from the wrist and the index and little finger knuckles (mirrored for the right hand).
  function palmFacingYou(hand) {
    const wrist=joint(hand,'wrist'),index=joint(hand,'index-finger-metacarpal'),little=joint(hand,'pinky-finger-metacarpal');
    if(!wrist||!index||!little)return null;
    const a=index.position.clone().sub(wrist.position),b=little.position.clone().sub(wrist.position);
    const normal=(hand.source?.handedness==='right'?a.cross(b):b.cross(a)).normalize();
    const center=wrist.position.clone().add(index.position).add(little.position).divideScalar(3);
    const toEyes=camera.position.clone().sub(center).normalize();
    return normal.dot(toEyes)>PALM_FACING?{center,normal}:null;
  }
  // With hands there are no A/X buttons: turn a palm toward you and tap the button above it with the other index finger.
  const palmButton=canvasPlane(.06,.06,160,160);
  {
    const c=palmButton.context;c.beginPath();c.arc(80,80,74,0,Math.PI*2);c.fillStyle='#101b14e8';c.fill();c.lineWidth=6;c.strokeStyle=UI.accent;c.stroke();
    c.fillStyle=UI.accent;c.font=`650 34px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';c.fillText('Menu',80,82);palmButton.texture.needsUpdate=true;
  }
  palmButton.mesh.visible=false;rig.add(palmButton.mesh);
  function updatePalm() {
    let shown=null;
    for(const hand of hands) {
      if(!hand.tracked||hand.mode)continue;
      const palm=palmFacingYou(hand);
      if(palm){shown={hand,position:palm.center.clone().addScaledVector(palm.normal,.07)};break;}
    }
    palmButton.mesh.visible=Boolean(shown);
    if(!shown)return;
    palmButton.mesh.position.copy(shown.position);palmButton.mesh.lookAt(camera.position);
    const other=hands.find(hand=>hand!==shown.hand),fingertip=other&&joint(other,'index-finger-tip');
    const now=performance.now();
    if(fingertip&&fingertip.position.distanceTo(shown.position)<TOUCH&&now-palmPressed>900){palmPressed=now;toggleMenu();}
  }

  // ---------- tiled surface (VR only; the page keeps its single mesh) ----------
  let tiles=null,tiledFrom=null;
  function syncTiles() {
    const surface=ctx.surface,data=ctx.state.data;
    const key=surface&&`${surface.geometry.uuid}:${surface.material.uuid}`;
    if(key===tiledFrom)return;
    dropTiles();
    if(!surface||!data)return;
    tiles=tileSurface(surface,data.columns,data.rows);tiledFrom=key;
    surface.parent.add(tiles);surface.visible=false;
  }
  function dropTiles() {
    // Free only the tiles' own index buffers: the shared attributes still belong to the page's surface.
    if(tiles){tiles.removeFromParent();tiles.children.forEach(part=>{for(const name of Object.keys(part.geometry.attributes))part.geometry.deleteAttribute(name);part.geometry.dispose();});}
    tiles=null;tiledFrom=null;
    if(ctx.surface)ctx.surface.visible=true;
  }

  // ---------- menu panel ----------
  const panel=canvasPlane(PANEL.width,PANEL.height,PANEL.canvasWidth,PANEL.canvasHeight);
  panel.mesh.visible=false;panel.mesh.rotation.order='YXZ';rig.add(panel.mesh);

  function applyView() {
    rig.position.copy(view.position);rig.rotation.set(0,view.yaw,0);rig.scale.setScalar(view.scale);rig.updateMatrixWorld(true);
    // Keep the whole model inside the depth range at any zoom, with a near plane that never clips the hands.
    const far=2**Math.ceil(Math.log2(Math.max(30,4*view.size/view.scale)));
    if(camera.far!==far){camera.far=far;camera.near=clamp(far/1e5,.02,.1);}
  }
  const toWorld=room=>room.clone().applyAxisAngle(Y,view.yaw).multiplyScalar(view.scale).add(view.position);

  // Reset view: the whole model on a table in front of you.
  function frameModel() {
    if(cut.active&&cut.ready)return frameSurroundings();
    const data=ctx.state.data,box=new THREE.Box3().setFromObject(ctx.model);
    if(box.isEmpty()||!data)return;
    view.size=Math.max(box.max.x-box.min.x,box.max.z-box.min.z,1e-6);
    // Zoom from life size (1 m in the room is 1 m of ground) to a model 8 cm across.
    view.minScale=ctx.SCALE/Math.max(data.width_m,data.height_m);
    view.maxScale=view.size/.08;
    view.scale=clamp(view.size/TABLE.width,view.minScale,view.maxScale);view.yaw=0;
    const center=new THREE.Vector3((box.min.x+box.max.x)/2,box.min.y,(box.min.z+box.max.z)/2);
    view.position.copy(center).sub(new THREE.Vector3(0,TABLE.height,-TABLE.distance).multiplyScalar(view.scale));
    hands.forEach(hand=>{if(hand.mode==='grab')hand.mode=null;});
    applyView();
  }

  // The cut's surroundings on the table, a little wider than the model, centered on the cut.
  function frameSurroundings() {
    const box=new THREE.Box3().setFromObject(cut.group);if(box.isEmpty())return;
    const handle=cut.state.handles.move,s=cut.group.scale.x;
    view.size=Math.max(box.max.x-box.min.x,box.max.z-box.min.z,1e-6);
    view.minScale=s;view.maxScale=view.size/.08;
    view.scale=clamp(view.size/1.4,view.minScale,view.maxScale);view.yaw=0;
    const center=handle?new THREE.Vector3(handle[0],box.min.y,handle[2]):box.getCenter(new THREE.Vector3()).setY(box.min.y);
    view.position.copy(center).sub(new THREE.Vector3(0,TABLE.height,-TABLE.distance).multiplyScalar(view.scale));
    hands.forEach(hand=>{if(hand.mode==='grab')hand.mode=null;});
    applyView();
  }

  // ---------- grabbing: one hand drags, two hands also zoom and turn ----------
  function regrab() {
    for(const hand of hands)if(hand.mode==='grab')hand.anchor=toWorld(handPoint(hand));
  }
  function updateGrab() {
    const grabbing=hands.filter(hand=>hand.mode==='grab');
    if(grabbing.length===1) {
      const [hand]=grabbing;
      view.position.copy(hand.anchor).sub(hand.point.clone().applyAxisAngle(Y,view.yaw).multiplyScalar(view.scale));
    } else if(grabbing.length===2) {
      const [a,b]=grabbing,roomA=a.point,roomB=b.point;
      const room=roomB.clone().sub(roomA),world=b.anchor.clone().sub(a.anchor);
      // Hands apart zoom in, together zoom out; the grabbed points stay in your hands.
      view.scale=clamp(world.length()/Math.max(room.length(),1e-3),view.minScale,view.maxScale);
      // Turning only about the vertical, so the ground stays level; skipped while the hands are stacked vertically.
      if(Math.hypot(room.x,room.z)>.04&&Math.hypot(world.x,world.z)>1e-9)view.yaw=Math.atan2(world.x,world.z)-Math.atan2(room.x,room.z);
      const roomMid=roomA.clone().add(roomB).multiplyScalar(.5),worldMid=a.anchor.clone().add(b.anchor).multiplyScalar(.5);
      view.position.copy(worldMid).sub(roomMid.applyAxisAngle(Y,view.yaw).multiplyScalar(view.scale));
    }
    return grabbing.length>0;
  }

  // ---------- flying: the sticks move where each hand points, at one room speed ----------
  function fly(delta) {
    const velocity=new THREE.Vector3();
    for(const hand of hands) {
      const axes=hand.source?.gamepad?.axes;if(!axes)continue;
      const x=axes.length>=4?axes[2]:axes[0]||0,y=axes.length>=4?axes[3]:axes[1]||0;
      if(Math.hypot(x,y)<DEADZONE)continue;
      const q=hand.controller.quaternion;
      velocity.add(new THREE.Vector3(0,0,-1).applyQuaternion(q).multiplyScalar(-y)).add(new THREE.Vector3(1,0,0).applyQuaternion(q).multiplyScalar(x));
    }
    if(!velocity.lengthSq())return;
    // A room-space step, scaled into the world: zoomed out, the same step crosses more ground.
    view.position.add(velocity.multiplyScalar(SPEED*delta).applyAxisAngle(Y,view.yaw).multiplyScalar(view.scale));
  }

  // ---------- pointing at the menu ----------
  function pointer(hand) {
    const origin=hand.controller.position,direction=new THREE.Vector3(0,0,-1).applyQuaternion(hand.controller.quaternion);
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(panel.mesh.quaternion),facing=direction.dot(normal);
    if(!panel.mesh.visible||facing>=-1e-4)return null;
    const distance=panel.mesh.position.clone().sub(origin).dot(normal)/facing;
    if(distance<0)return null;
    const local=origin.clone().addScaledVector(direction,distance).sub(panel.mesh.position).applyQuaternion(panel.mesh.quaternion.clone().invert());
    const inside=Math.abs(local.x)<=PANEL.width/2&&Math.abs(local.y)<=PANEL.height/2;
    return {distance,inside,x:(local.x/PANEL.width+.5)*PANEL.canvasWidth,y:(.5-local.y/PANEL.height)*PANEL.canvasHeight};
  }
  const regionAt=hit=>hit?.inside?regions.find(r=>hit.x>=r.x&&hit.x<=r.x+r.w&&hit.y>=r.y&&hit.y<=r.y+r.h)||null:null;

  function toggleMenu(open=!panel.mesh.visible) {
    panel.mesh.visible=open;
    hands.forEach(hand=>{hand.tip.visible=!open;});
    if(!open)return;
    // Open it just below eye level in front of you, facing you, fixed in the room.
    const forward=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);forward.y=0;
    if(forward.lengthSq()<1e-6)forward.set(0,0,-1);
    forward.normalize();
    panel.mesh.position.copy(camera.position).addScaledVector(forward,.72).add(new THREE.Vector3(0,-.12,0));
    panel.mesh.rotation.set(-.12,Math.atan2(-forward.x,-forward.z),0);
    menuSignature='';
  }

  // ---------- menu rows, read live from the page ----------
  function controlRow(el,indent=0) {
    if(!shown(el))return null;
    if(el.tagName==='SELECT')return {type:'select',el,label:labelOf(el),indent};
    if(el.type==='checkbox')return {type:'check',el,label:labelOf(el),indent};
    if(el.type==='range')return {type:'range',el,label:labelOf(el),indent,value:$(`${el.id}-value`)?.textContent||el.value};
    if(el.type==='number')return {type:'stepper',el,label:labelOf(el).replace(/\s*\(.*$/,''),indent};
    return null;
  }
  const segment=(label,selector)=>({type:'segment',label,buttons:[...document.querySelectorAll(selector)].filter(shown)});
  function statusLine() {
    const toast=$('toast');
    if(toast&&!toast.hidden)return {text:toast.textContent,error:toast.classList.contains('error')};
    if(ctx.live&&!ctx.live.connected)return {text:'Reconnecting to the server…',error:true};
    const cutStatus=cut.active&&cut.status();
    if(cutStatus)return cutStatus;
    if(ctx.state.loading)return {text:$('job-message')?.textContent||'Generating terrain…'};
    if(hands.some(hand=>hand.tracked))return {text:'Pinch: grab · Pinch with both hands: pull apart to zoom in, twist to turn · Palm toward you, tap Menu'};
    return {text:'Stick: fly where that hand points · Trigger: grab · Both triggers: pull apart to zoom in, twist to turn'};
  }
  // The Cut tab shows the surroundings with the cut's fence instead of the model.
  function setTab(key) {
    if(key===menuTab)return;
    const wasCut=menuTab==='cut';menuTab=key;menuSignature='';
    if(key==='cut'){cut.enter();cutFramed=false;ctx.model.visible=false;}
    else if(wasCut){cut.leave();ctx.model.visible=true;frameModel();}
  }
  function rows() {
    if(menuTab==='cut') {
      const generate=$('generate'),problem=cut.status()?.error;
      return [
        {type:'heading',text:'Your cut'},
        {type:'text',text:cut.summary()||'Loading…',accent:true},
        {type:'text',text:'Pinch a handle above the fence: the middle one moves the cut, the side ones stretch it, the corner one scales it, and the ring turns it. Pinch anywhere else to move the view.'},
        problem?{type:'button',label:'Retry the surroundings',action:()=>cut.retry()}:null,
        controlRow($('selection-shape')),segment('Aspect','[data-aspect]'),
        {type:'heading',text:'Scale'},
        controlRow($('exaggeration')),controlRow($('export-size')),
        {type:'text',text:$('export-dimensions')?.textContent||''},
        controlRow($('resolution')),
        {type:'button',label:ctx.state.loading?($('job-message')?.textContent||'Generating…'):'Generate this cut ↗',primary:true,disabled:generate.disabled,
          action:()=>{cutGenerating=true;generate.click();}},
        ctx.state.loading?{type:'progress',value:Number($('progress').value)||0}:null,
        {type:'text',text:'When it looks right, take off the headset: the page on the computer offers Continue here, ready to export.'},
      ].filter(Boolean);
    }
    if(menuTab==='terrain') {
      const generate=$('generate');
      return [
        {type:'heading',text:'Your landscape'},
        controlRow($('place')),controlRow($('elevation-source')),controlRow($('resolution')),
        {type:'button',label:ctx.state.loading?($('job-message')?.textContent||'Generating…'):'Generate terrain ↗',primary:true,disabled:generate.disabled,action:()=>generate.click()},
        ctx.state.loading?{type:'progress',value:Number($('progress').value)||0}:null,
        {type:'heading',text:'Surface'},
        segment('View','[data-view]'),segment('Colors','[data-palette]'),
        ...[...document.querySelectorAll('#terrain-controls select, #terrain-controls input')].map(el=>controlRow(el)),
      ].filter(Boolean);
    }
    if(menuTab==='layers') {
      const editor=$('style-editor');
      return [
        {type:'heading',text:'Map features'},
        ...[...editor.querySelectorAll('input[type=checkbox], input[type=range], select')].map(el=>controlRow(el,el.closest('.feature-detail')?1:0)),
        {type:'text',text:$('feature-status')?.textContent||''},
        {type:'button',label:'Save as default',action:()=>$('save-style-defaults').click()},
      ].filter(Boolean);
    }
    return [];
  }

  function stepSelect(el,direction) {
    const count=el.options.length;let index=el.selectedIndex;
    for(let tries=0;tries<count;tries++) {
      index=(index+direction+count)%count;
      const option=el.options[index];
      if(!option.disabled&&!option.hidden&&option.value!=='custom')break;
    }
    if(index===el.selectedIndex)return;
    el.selectedIndex=index;fire(el,'input');fire(el,'change');
  }
  function setRange(el,value) {
    const min=Number(el.min||0),max=Number(el.max||100),step=Number(el.step||1);
    const snapped=Number((Math.round((clamp(value,min,max)-min)/step)*step+min).toFixed(6));
    if(Number(el.value)===snapped)return false;
    el.value=String(snapped);return true;
  }
  function stepRange(el,direction) {
    if(setRange(el,Number(el.value)+direction*Number(el.step||1))){fire(el,'input');fire(el,'change');}
  }
  // Slider drags rebuild the model, so they update a few times a second and settle on release.
  function dragRange(hand,el,u,final=false) {
    const changed=setRange(el,Number(el.min||0)+clamp(u,0,1)*(Number(el.max||100)-Number(el.min||0)));
    hand.pending||=changed;
    const now=performance.now();
    if(hand.pending&&(final||now-hand.lastInput>150)){fire(el,'input');hand.pending=false;hand.lastInput=now;}
    if(final)fire(el,'change');
  }

  // ---------- drawing ----------
  function rounded(c,x,y,w,h,r,fill,stroke) {
    c.beginPath();c.roundRect(x,y,w,h,r);
    if(fill){c.fillStyle=fill;c.fill();}
    if(stroke){c.strokeStyle=stroke;c.lineWidth=2;c.stroke();}
  }
  function fit(c,text,width) {
    if(c.measureText(text).width<=width)return text;
    while(text.length>1&&c.measureText(`${text}…`).width>width)text=text.slice(0,-1);
    return `${text}…`;
  }
  function wrap(c,text,width,maxLines) {
    const words=String(text).split(/\s+/).filter(Boolean),lines=[];let line='';
    for(const word of words){const next=line?`${line} ${word}`:word;if(c.measureText(next).width>width&&line){lines.push(line);line=word;}else line=next;}
    if(line)lines.push(line);
    if(lines.length>maxLines){lines.length=maxLines;lines[maxLines-1]=fit(c,`${lines[maxLines-1]}…`,width);}
    return lines;
  }
  const hovered=()=>new Set(hands.map(hand=>hand.mode==='drag'?hand.region?.id:hand.hover?.id).filter(Boolean));

  function drawMenu() {
    const c=panel.context,W=PANEL.canvasWidth,H=PANEL.canvasHeight,pad=44,hot=hovered();
    regions=[];
    const region=(id,x,y,w,h,options)=>{const r={id,x,y,w,h,...options};regions.push(r);return hot.has(id)&&!options.disabled;};
    const button=(id,x,y,w,h,label,{disabled=false,active=false,primary=false,font=30,action,sub}={})=>{
      const hover=region(id,x,y,w,h,{disabled,press:action});
      rounded(c,x,y,w,h,12,active?UI.green:primary?(hover?'#5b7e52':'#4b6d46'):hover?UI.hover:UI.raised,active?'#8fae78':UI.line);
      c.globalAlpha=disabled?.45:1;c.fillStyle=active||primary?'#fffbe8':UI.ink;c.textAlign='center';c.textBaseline='middle';
      c.font=`600 ${font}px ${UI.sans}`;c.fillText(fit(c,label,w-20),x+w/2,y+h/2-(sub?12:0));
      if(sub){c.font=`22px ${UI.sans}`;c.fillStyle=UI.muted;c.fillText(fit(c,sub,w-20),x+w/2,y+h/2+20);}
      c.globalAlpha=1;
    };
    c.clearRect(0,0,W,H);rounded(c,4,4,W-8,H-8,34,'#101b14f2','#5c6448');
    c.textAlign='left';c.textBaseline='alphabetic';c.fillStyle=UI.muted;c.font=`650 22px ${UI.sans}`;c.fillText('3D-VR-TERRAIN',pad,64);
    c.fillStyle=UI.ink;c.font=`46px ${UI.serif}`;c.fillText(fit(c,ctx.state.loadedName||ctx.state.name||'Terrain',W-2*pad),pad,118);
    const status=statusLine();c.font=`25px ${UI.sans}`;c.fillStyle=status.error?UI.error:UI.muted;
    wrap(c,status.text,W-2*pad,2).forEach((line,index)=>c.fillText(line,pad,160+index*32));
    const tabs=[['cut','Cut'],['terrain','Terrain'],['layers','Map layers']],tabWidth=(W-2*pad-20)/3;
    tabs.forEach(([key,label],index)=>button(`tab:${key}`,pad+index*(tabWidth+10),214,tabWidth,62,label,{active:menuTab===key,action:()=>setTab(key)}));
    let y=304;const left=pad,width=W-2*pad;
    for(const [index,row] of rows().entries()) {
      const x=left+(row.indent?44:0),w=width-(row.indent?44:0),key=`${menuTab}:${row.el?.id||row.type+index}`;
      c.textAlign='left';c.textBaseline='middle';
      if(row.type==='heading'){c.fillStyle=UI.accent;c.font=`650 22px ${UI.sans}`;c.fillText(row.text.toUpperCase(),x,y+26);y+=50;continue;}
      if(row.type==='text'){if(!row.text)continue;c.font=`23px ${UI.sans}`;c.fillStyle=row.accent?UI.accent:UI.muted;
        const lines=wrap(c,row.text,w,3);lines.forEach((line,i)=>c.fillText(line,x,y+18+i*30));y+=lines.length*30+16;continue;}
      if(row.type==='progress'){rounded(c,x,y+4,w,14,7,UI.raised);rounded(c,x,y+4,Math.max(14,w*row.value),14,7,UI.accent);y+=34;continue;}
      if(row.type==='button'){button(key,x,y,w,68,row.label,{disabled:row.disabled,primary:row.primary,action:row.action});y+=84;continue;}
      if(row.type==='grid'){const cell=(w-14)/2;row.buttons.forEach((b,i)=>button(`${key}:${i}`,x+(i%2)*(cell+14),y+Math.floor(i/2)*102,cell,88,b.label,{disabled:b.disabled,action:b.action,sub:b.hint}));y+=Math.ceil(row.buttons.length/2)*102+8;continue;}
      c.fillStyle=UI.ink;c.font=`28px ${UI.sans}`;
      if(row.type==='check') {
        const hover=region(key,x,y,w,62,{disabled:row.el.disabled,press:()=>row.el.click()});
        if(hover)rounded(c,x-12,y,w+12,62,10,UI.hover);
        c.globalAlpha=row.el.disabled?.45:1;c.fillStyle=UI.ink;c.fillText(fit(c,row.label,w-120),x,y+31);
        rounded(c,x+w-82,y+13,72,36,18,row.el.checked?'#5f8654':UI.raised,UI.line);
        rounded(c,x+w-(row.el.checked?50:78),y+17,28,28,14,row.el.checked?'#fffbe8':UI.muted);
        c.globalAlpha=1;y+=66;continue;
      }
      if(row.type==='select'||row.type==='stepper') {
        const labelWidth=w*.38,cx=x+labelWidth,cw=w-labelWidth,el=row.el;
        c.fillStyle=UI.muted;c.font=`25px ${UI.sans}`;c.fillText(fit(c,row.label,labelWidth-16),x,y+34);
        const step=row.type==='select'?direction=>stepSelect(el,direction):direction=>{const s=10*Number(el.step||1);el.value=String(clamp(Number(el.value)+direction*s,Number(el.min||-Infinity),Number(el.max||Infinity)));fire(el,'input');fire(el,'change');};
        button(`${key}:prev`,cx,y+4,60,60,row.type==='select'?'‹':'−',{font:38,disabled:el.disabled,action:()=>step(-1)});
        button(`${key}:next`,cx+cw-60,y+4,60,60,row.type==='select'?'›':'+',{font:38,disabled:el.disabled,action:()=>step(1)});
        const text=row.type==='select'?el.selectedOptions[0]?.textContent.replace(/\s*·.*$/,'')||'':`${el.value} mm`;
        const hover=region(`${key}:value`,cx+68,y+4,cw-136,60,{disabled:el.disabled,press:()=>step(1)});
        rounded(c,cx+68,y+4,cw-136,60,10,hover?UI.hover:UI.surface,UI.line);
        c.fillStyle=UI.ink;c.textAlign='center';c.font=`27px ${UI.sans}`;c.fillText(fit(c,text,cw-156),cx+cw/2,y+35);
        y+=76;continue;
      }
      if(row.type==='range') {
        const el=row.el,min=Number(el.min||0),max=Number(el.max||100),u=(Number(el.value)-min)/(max-min||1);
        c.fillStyle=UI.muted;c.font=`25px ${UI.sans}`;c.fillText(fit(c,row.label,w-160),x,y+20);
        c.textAlign='right';c.fillStyle=UI.ink;c.fillText(row.value,x+w,y+20);
        button(`${key}:minus`,x,y+40,56,52,'−',{font:34,disabled:el.disabled,action:()=>stepRange(el,-1)});
        button(`${key}:plus`,x+w-56,y+40,56,52,'+',{font:34,disabled:el.disabled,action:()=>stepRange(el,1)});
        const tx=x+76,tw=w-152;
        const hover=region(key,tx-14,y+38,tw+28,56,{disabled:el.disabled,slider:{el,x:tx,w:tw}});
        rounded(c,tx,y+60,tw,12,6,UI.raised);rounded(c,tx,y+60,Math.max(12,tw*u),12,6,'#8fae78');
        c.beginPath();c.arc(tx+tw*u,y+66,hover?20:16,0,Math.PI*2);c.fillStyle=UI.accent;c.fill();
        y+=108;continue;
      }
      if(row.type==='segment') {
        const labelWidth=w*.2,count=row.buttons.length,bw=(w-labelWidth-(count-1)*8)/count;
        c.fillStyle=UI.muted;c.font=`25px ${UI.sans}`;c.fillText(row.label,x,y+33);
        row.buttons.forEach((b,i)=>button(`${key}:${i}`,x+labelWidth+i*(bw+8),y,bw,64,b.textContent.trim(),{font:25,active:b.classList.contains('active')||b.getAttribute('aria-pressed')==='true',disabled:b.disabled,action:()=>b.click()}));
        y+=78;continue;
      }
    }
    const footer=H-pad-72,half=(W-2*pad-14)/2;
    button('reset-view',pad,footer,half,72,'Reset view ⌖',{action:frameModel});
    button('exit-vr',pad+half+14,footer,half,72,'Exit VR',{action:()=>session?.end()});
    panel.texture.needsUpdate=true;
  }
  function refreshMenu(force=false) {
    if(!panel.mesh.visible)return;
    const now=performance.now();
    if(!force&&now-lastPoll<200)return;
    lastPoll=now;
    // Redraw only when what the menu shows has changed: the page's controls, the status, or what is pointed at.
    const signature=JSON.stringify([menuTab,[...hovered()],statusLine(),ctx.state.loadedName,rows().map(row=>[row.type,row.text,row.label,row.value,row.disabled,
      row.el&&(row.el.type==='checkbox'?row.el.checked:row.el.value),row.el?.disabled,row.buttons?.map(b=>[b.disabled,b.label,b.className,b.getAttribute?.('aria-pressed')])])]);
    if(signature!==menuSignature){menuSignature=signature;drawMenu();}
  }

  // ---------- per frame ----------
  function rayFor(hand) {
    const origin=hand.controller.getWorldPosition(new THREE.Vector3());
    const direction=new THREE.Vector3(0,0,-1).transformDirection(hand.controller.matrixWorld);
    raycaster.set(origin,direction);
    return raycaster;
  }
  function updateHand(hand) {
    hand.tracked=Boolean(hand.source?.hand);
    hand.grip.visible=!hand.tracked;   // the controller model and its hint only for controllers
    if(hand.tracked)dressJoints(hand);
    handPoint(hand);
    const gamepad=hand.source?.gamepad;
    const hit=pointer(hand);hand.hover=hand.mode?hand.hover:regionAt(hit);
    if(hand.source) {
      if(gamepad&&!hand.tracked) {
        const menuButton=Boolean(gamepad.buttons[4]?.pressed||gamepad.buttons[5]?.pressed);
        if(menuButton&&!hand.menuButton)toggleMenu();
        hand.menuButton=menuButton;
      }
      // A pinch with tracked hands, the trigger with controllers.
      const trigger=hand.tracked?pinching(hand):Boolean(gamepad?.buttons[0]?.pressed);
      const sliderU=slider=>hit?(hit.x-slider.x)/slider.w:hand.sliderU;
      const world=()=>toWorld(hand.point);
      if(trigger&&!hand.trigger) {
        // A pinch right on a cut handle takes it, whatever the ray happens to cross.
        const touched=cut.handleAt(world(),null,view),target=touched?null:regionAt(hit);
        if(touched&&cut.startDrag(touched.name,world(),null)){hand.mode='handle';hand.handle=touched;}
        else if(target){
          hand.region=target;
          if(target.slider){hand.mode='drag';hand.sliderU=sliderU(target.slider);dragRange(hand,target.slider.el,hand.sliderU);}
          else{hand.mode='menu';if(!target.disabled)target.press?.();}
          menuSignature='';
        } else if(hit?.inside)hand.mode='menu';
        else {
          // A handle pointed at can be dragged from afar; anywhere else a pinch grabs the world.
          const taken=cut.handleAt(null,rayFor(hand),view);
          if(taken&&cut.startDrag(taken.name,taken.direct?world():null,taken.direct?null:rayFor(hand))){hand.mode='handle';hand.handle=taken;}
          else{hand.mode='grab';regrab();}
        }
      } else if(trigger&&hand.mode==='drag') {
        hand.sliderU=sliderU(hand.region.slider);dragRange(hand,hand.region.slider.el,hand.sliderU);
      } else if(trigger&&hand.mode==='handle') {
        cut.moveDrag(hand.handle.direct?world():null,hand.handle.direct?null:rayFor(hand));
      } else if(!trigger&&hand.trigger) {
        if(hand.mode==='drag')dragRange(hand,hand.region.slider.el,sliderU(hand.region.slider),true);
        if(hand.mode==='handle'){cut.endDrag();hand.handle=null;}
        const wasGrab=hand.mode==='grab';hand.mode=null;hand.region=null;
        if(wasGrab)regrab();
        menuSignature='';
      }
      hand.trigger=trigger;
    }
    const onMenu=hit?.inside&&hand.mode!=='grab'&&hand.mode!=='handle';
    // Hands show their ray only on the menu; controllers always show a short one.
    hand.laser.visible=!hand.tracked||Boolean(onMenu);
    hand.laser.scale.z=onMenu?hit.distance:hand.mode==='grab'?.12:1.2;
    hand.laser.material.color.set(onMenu&&(hand.hover||hand.mode==='drag')?0xe9c890:0xfff6d6);
    hand.dot.visible=Boolean(onMenu);if(onMenu)hand.dot.position.set(0,0,-hit.distance);
  }
  function hoverHandles() {
    let name=null;
    for(const hand of hands) {
      if(hand.mode==='handle'){name=hand.handle.name;break;}
      if(!hand.source||hand.mode)continue;
      name=cut.handleAt(toWorld(hand.point),hand.tracked?null:rayFor(hand),view)?.name||null;
      if(name)break;
    }
    cut.hover(name);
  }
  function update(delta) {
    syncTiles();
    if(ctx.state.id!==lastId) {
      lastId=ctx.state.id;
      // A cut generated from the Cut tab: show the new model.
      if(cutGenerating){cutGenerating=false;setTab('terrain');}
      frameModel();
    }
    cut.update(view);
    if(cut.active&&cut.ready&&!cutFramed){cutFramed=true;frameSurroundings();}
    hands.forEach(updateHand);
    updatePalm();
    if(cut.active)hoverHandles();
    if(!updateGrab())fly(delta);
    applyView();
    refreshMenu();
  }

  // ---------- session ----------
  async function enter() {
    if(session)return;
    if(!navigator.xr){ctx.notify(`VR needs a secure page. Start the server with “python app.py --lan” and open https://${location.hostname}:${location.port||443} in the headset browser.`,true);return;}
    try {
      session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor','bounded-floor','hand-tracking']});
    } catch(error){session=null;ctx.notify(`Could not start VR: ${error.message}`,true);return;}
    background=scene.background;scene.background=new THREE.Color(0xa9bfc6);
    scene.add(rig);renderer.xr.enabled=true;renderer.xr.setReferenceSpaceType('local-floor');
    // Taking the headset off hides the session; on return, reconnect at once rather than after the backoff.
    session.addEventListener('visibilitychange',()=>{if(session?.visibilityState==='visible')ctx.live?.now();else ctx.handoff?.(true);});
    session.addEventListener('end',()=>{
      dropTiles();
      if(menuTab==='cut'){cut.leave();ctx.model.visible=true;menuTab='terrain';}
      palmButton.mesh.visible=false;
      ctx.handoff?.(true);   // you are taking the headset off: the computer's page can continue from here
      session=null;renderer.xr.enabled=false;scene.remove(rig);scene.background=background;
      hands.forEach(hand=>{hand.mode=null;hand.trigger=false;});toggleMenu(false);ctx.requestRender();
    });
    await renderer.xr.setSession(session);
    lastId=null;toggleMenu(false);
  }

  async function attachButton(button) {
    const headset=/OculusBrowser|Quest|Pico/i.test(navigator.userAgent);
    let supported=false;
    try{supported=Boolean(await navigator.xr?.isSessionSupported('immersive-vr'));}catch{/* No WebXR. */}
    // On a headset over plain HTTP the button stays, to explain how to get a secure page.
    button.hidden=!(supported||headset);
    button.addEventListener('click',()=>{if(!ctx.state.data)return ctx.notify('Generate terrain before entering VR.',true);enter();});
  }

  instance={update,attachButton,camera,get live(){return ctx.live;},get presenting(){return Boolean(session);},
    get state(){return {scale:view.scale,yaw:view.yaw,position:view.position.toArray(),minScale:view.minScale,maxScale:view.maxScale,
      menuOpen:panel.mesh.visible,menuTab,cut:cut.state,palmButton:palmButton.mesh.visible?palmButton.mesh.position.toArray():null,
      hands:hands.map(hand=>({tracked:hand.tracked,pinching:hand.trigger,mode:hand.mode,point:hand.point.toArray(),indexTip:joint(hand,'index-finger-tip')?.position.toArray()||null})),tiles:tiles?tiles.children.length:0,
      tileTriangles:tiles?tiles.children.reduce((sum,part)=>sum+part.geometry.index.count/3,0):0,surfaceHidden:ctx.surface?!ctx.surface.visible:false,regions:regions.map(({id,x,y,w,h,disabled})=>({id,x,y,w,h,disabled})),panel:panel.mesh.matrix.toArray()};}};
  return instance;
}
