// VR explorer (WebXR, e.g. a Meta Quest on the LAN), with hands or controllers, in two modes. Map Selection (where VR
// starts): the page's map and selection box in 3D, the map moving beneath a box fixed on the table. Model view: the
// generated model on the table, to grab, zoom, and turn (and fly over with the sticks).
import * as THREE from 'three';
import {createHandSkin} from './vr-hands.js';
import {createMapMode,reshapeBounds} from './vr-mapmode.js';
import {createWatch} from './vr-watch.js';
import {COMMANDS,createCommands,matchCommand,matchOption} from './vr-commands.js';

const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
const Y=new THREE.Vector3(0,1,0);

const SPEED=1.6;              // meters per second at full stick, in the room: the same at every zoom level
const DEADZONE=.15;
const PINCH={press:.018,release:.03};   // thumb-to-index distance (m) that starts and ends a pinch
const TABLE={width:1,height:.75,distance:.8};   // where Reset view puts the model: 1 m wide at table height
const UI={paper:'#101b14',surface:'#19281e',raised:'#223329',line:'#414633',ink:'#fff6d6',muted:'#a9ae99',
  accent:'#e9c890',green:'#426746',hover:'#2f4834',error:'#d2a36c',sans:'Inter,"Segoe UI",Arial,sans-serif',serif:'Georgia,"Times New Roman",serif'};

// Backgrounds for the model view: 360° skies around you (made with OpenAI's image generation), or the dark gradient.
export const BACKGROUNDS=[{key:'gradient',label:'Dark gradient'},{key:'forest',label:'Mellow forest'},
  {key:'desert',label:'Sandy desert'},{key:'lake',label:'Moonlit lake'}];
const MAP_SKY=0xa9bfc6;

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

let instance=null;
// The page's VR explorer, for the browser test (modules are shared, so an import gets the same one).
export const currentVR=()=>instance;

export function createVR(ctx) {
  const {renderer,scene}=ctx;
  const rig=new THREE.Group();rig.name='VR rig';
  const camera=new THREE.PerspectiveCamera(70,1,.05,200);rig.add(camera);
  // The rig maps the room onto the world: world = position + scale · rotateY(yaw) · room.
  const view={position:new THREE.Vector3(),yaw:0,scale:1,size:6.4,minScale:.001,maxScale:100};
  let flownSeconds=0,session=null,background=null,lastId=null,mode='map';
  // ---------- backgrounds (model view) ----------
  let backdrop='gradient';
  try{if(BACKGROUNDS.some(b=>b.key===localStorage.getItem('vr-background')))backdrop=localStorage.getItem('vr-background');}catch{/* Storage is optional. */}
  const skies={};
  function sky(key) {
    if(skies[key])return skies[key];
    let texture;
    if(key==='gradient') {
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=512;
      const c=canvas.getContext('2d'),g=c.createLinearGradient(0,0,0,512);
      g.addColorStop(0,'#05080a');g.addColorStop(.42,'#14211b');g.addColorStop(.5,'#24352b');g.addColorStop(.58,'#121c16');g.addColorStop(1,'#040605');
      c.fillStyle=g;c.fillRect(0,0,64,512);
      texture=new THREE.CanvasTexture(canvas);
    } else texture=new THREE.TextureLoader().load(`/static/backgrounds/${key}.jpg`,()=>ctx.requestRender());
    texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.SRGBColorSpace;
    return skies[key]=texture;
  }
  function showBackdrop() {
    if(!session)return;
    scene.background=mode==='model'?sky(backdrop):new THREE.Color(MAP_SKY);
  }
  function setBackdrop(key) {
    if(!BACKGROUNDS.some(b=>b.key===key))return;
    backdrop=key;showBackdrop();
    try{localStorage.setItem('vr-background',key);}catch{/* Storage is optional. */}
  }
  const mapMode=createMapMode(ctx,{table:TABLE});rig.add(mapMode.room);

  // ---------- controllers ----------
  // No lasers: a controller taps with a small fingertip dot just in front of it.
  const TIP=new THREE.Vector3(0,0,-.06);
  const hands=[0,1].map(index=>{
    const controller=renderer.xr.getController(index),grip=renderer.xr.getControllerGrip(index);
    const dot=new THREE.Mesh(new THREE.SphereGeometry(.007,12,8),new THREE.MeshBasicMaterial({color:0xe9c890,depthTest:false}));
    dot.renderOrder=1001;dot.position.copy(TIP);controller.add(dot);
    const body=new THREE.Mesh(new THREE.CylinderGeometry(.017,.022,.11,16),new THREE.MeshStandardMaterial({color:0x223329,roughness:.6}));
    body.rotation.x=Math.PI/2.6;body.position.set(0,-.01,.03);grip.add(body);
    // Tracked hands: three.js keeps one object per joint up to date; the hand model follows them (dots until it loads).
    const xrHand=renderer.xr.getHand(index);
    const hand={controller,grip,xrHand,skin:createHandSkin(xrHand),dot,source:null,trigger:false,mode:null,anchor:null,fist:false,
      point:new THREE.Vector3(),tracked:false};
    controller.addEventListener('connected',event=>{hand.source=event.data;});
    controller.addEventListener('disconnected',()=>{hand.source=null;hand.mode=null;hand.trigger=false;});
    rig.add(controller,grip,xrHand);
    return hand;
  });

  // ---------- the watch (created once the hands exist) ----------
  let watch=null;

  // ---------- hands ----------
  const jointMaterial=new THREE.MeshStandardMaterial({color:0xf3ead2,roughness:.7});
  const tipMaterial=new THREE.MeshStandardMaterial({color:0xe9c890,roughness:.5,emissive:0x3a2a10});
  const jointGeometry=new THREE.SphereGeometry(1,10,8);
  const joint=(hand,name)=>{const j=hand.xrHand.joints?.[name];return j&&j.visible!==false?j:null;};
  function dressJoints(hand,shown) {
    for(const [name,j] of Object.entries(hand.xrHand.joints||{})) {
      if(!j.userData.dot&&shown){
        const dot=new THREE.Mesh(jointGeometry,name.endsWith('-tip')?tipMaterial:jointMaterial);
        dot.scale.setScalar(Math.max(j.jointRadius||.008,.006)*.9);j.add(dot);j.userData.dot=dot;
      }
      if(j.userData.dot)j.userData.dot.visible=shown;
    }
  }
  // A pinch: the system's own (select button) or thumb and index tips touching, with a little hysteresis.
  function pinching(hand) {
    if(hand.source?.gamepad?.buttons[0]?.pressed)return true;
    const thumb=joint(hand,'thumb-tip'),index=joint(hand,'index-finger-tip');
    if(!thumb||!index)return false;
    return thumb.position.distanceTo(index.position)<(hand.trigger?PINCH.release:PINCH.press);
  }
  // A fist: index, middle, and ring fingertips curled in to the wrist (an index finger held out to tap is no fist).
  function fist(hand) {
    const wrist=joint(hand,'wrist');if(!wrist)return false;
    const reach=name=>joint(hand,`${name}-finger-tip`)?.position.distanceTo(wrist.position)??1;
    const limit=hand.fist?.13:.11;
    hand.fist=['index','middle','ring'].every(name=>reach(name)<limit);
    return hand.fist;
  }
  // Gripping the map: a pinch or a fist with hands; the grip (squeeze) button or the trigger with controllers.
  function gripping(hand) {
    if(hand.tracked)return pinching(hand)||fist(hand);
    const buttons=hand.source?.gamepad?.buttons||[];
    return Boolean(buttons[0]?.pressed||buttons[1]?.pressed);
  }
  // Where a hand acts in the room: between thumb and index tips, or the controller itself.
  function handPoint(hand) {
    const thumb=joint(hand,'thumb-tip'),index=joint(hand,'index-finger-tip');
    if(hand.tracked&&thumb&&index)return hand.point.copy(thumb.position).add(index.position).multiplyScalar(.5);
    return hand.point.copy(hand.controller.position);
  }
  // Generate from the right wrist (or by voice): when the new terrain arrives, show it in the model view.
  let generating=null;   // the terrain showing when Generate was pressed
  function generate(){const button=document.getElementById('generate');if(button.disabled||ctx.state.loading)return false;generating={from:ctx.state.id};button.click();return true;}
  // Voice commands, on by default while in VR: "Open menu", "Generate terrain", "Exit program".
  let voiceOn=true;
  // With a menu open, any option on show can be said too ("Multiplier", "plus", "Moonlit lake", "Back", …); Whisper is
  // told which names to expect.
  const commands=createCommands({api:ctx.api,
    vocabulary:()=>[...COMMANDS.map(command=>command.label),...watch.voiceOptions().map(option=>option.label)],
    onHeard:text=>{
      if(!session)return;
      const option=watch.busy?matchOption(text,watch.voiceOptions()):null;
      if(option){option.press();watch.say(`🎤 ${option.label}`);return;}
      const command=matchCommand(text);
      if(command?.name==='open-menu'){watch.openMenu();watch.say('🎤 Open menu');}
      else if(command?.name==='generate'){watch.say(generate()?'🎤 Generate terrain':'🎤 Generate: already busy, or the area needs adjusting');}
      else if(command?.name==='exit'){watch.say('🎤 Exit');session.end();}
    },
    onError:message=>watch?.say(`🎤 ${message}`)});
  watch=createWatch(ctx,{rig,camera,joint,hands,exit:()=>session?.end(),mode:()=>mode,
    generate,
    voiceCommands:{get on(){return voiceOn;},toggle(){voiceOn=!voiceOn;if(voiceOn&&session)commands.start();else commands.stop();}},
    showMap:()=>setMode('map'),relief:{get on(){return mapMode.relief;},toggle(){mapMode.relief=!mapMode.relief;}},
    backgrounds:{list:BACKGROUNDS,get current(){return backdrop;},set:setBackdrop},
    applyShape:shape=>{try{ctx.setSelection(reshapeBounds(ctx.state.selection,shape));}catch(error){ctx.notify(error.message,true);}}});

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

  // The rig (your head and hands) stays at room scale; the world (model, map) gets the inverse transform instead.
  // A rig scaled thousands of times over would put your eyes a kilometer apart, and three.js would cull everything.
  const worldMatrix=new THREE.Matrix4(),turn=new THREE.Quaternion(),grow=new THREE.Vector3();
  const worldObjects=()=>[ctx.model,mapMode.world];
  function applyView() {
    worldMatrix.compose(view.position,turn.setFromAxisAngle(Y,view.yaw),grow.setScalar(view.scale)).invert();
    for(const object of worldObjects()){object.matrixAutoUpdate=false;object.matrix.copy(worldMatrix);object.matrixWorldNeedsUpdate=true;}
    // Keep the whole model inside the depth range at any zoom, with a near plane that never clips the hands.
    const far=2**Math.ceil(Math.log2(Math.max(30,4*view.size/view.scale)));
    if(camera.far!==far){camera.far=far;camera.near=clamp(far/1e5,.02,.1);}
  }
  const toWorld=room=>room.clone().applyAxisAngle(Y,view.yaw).multiplyScalar(view.scale).add(view.position);

  // Reset view: the whole model on a table in front of you.
  function frameModel() {
    // Measured in the model's own frame, without the view transform.
    ctx.model.matrix.identity();ctx.model.updateMatrixWorld(true);
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

  // ---------- modes ----------
  function setMode(next) {
    mode=next;
    hands.forEach(hand=>{hand.mode=null;});
    if(ctx.grid)ctx.grid.visible=false;   // the page's floor grid does not move with the world
    showBackdrop();
    if(mode==='map'){ctx.model.visible=false;mapMode.enter(view,camera);}
    else{mapMode.leave();ctx.model.visible=true;lastId=ctx.state.id;frameModel();}
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
    flownSeconds+=delta;
    // A room-space step, scaled into the world: zoomed out, the same step crosses more ground.
    view.position.add(velocity.multiplyScalar(SPEED*delta).applyAxisAngle(Y,view.yaw).multiplyScalar(view.scale));
  }

  // ---------- per frame ----------
  const busy=hand=>hand.mode==='grab';
  // The point a hand taps with: the index fingertip, or the dot in front of a controller.
  function fingertipOf(hand) {
    if(hand.tracked)return joint(hand,'index-finger-tip')?.position||null;
    hand.controller.updateMatrixWorld();
    return hand.controller.localToWorld(TIP.clone());
  }
  function updateHand(hand) {
    hand.tracked=Boolean(hand.source?.hand);
    hand.grip.visible=!hand.tracked;   // the controller model (and its fingertip dot) only for controllers
    hand.dot.visible=!hand.tracked&&Boolean(hand.source);
    handPoint(hand);
    const other=hands.find(h=>h!==hand);
    if(hand.source) {
      const grip=gripping(hand);
      // Tapping the watch, its menus, and the wrist button: fingertips only. A hand on them never grips the map.
      const ui=watch.pointer(hand,{fingertip:fingertipOf(hand)});
      if(grip&&!hand.trigger&&watch.busy) {
        // While a menu is up the map stays put; a grip can only take one of the shape editor's handles.
        if(watch.dragStart(hand,hand.tracked?hand.point:fingertipOf(hand)))hand.mode='handle';
      } else if(grip&&!hand.trigger&&!ui.onUI) {
        // One hand moves the map; with the other already gripping, the two zoom and turn it.
        hand.mode='grab';if(busy(other))other.mode='grab';
        regrab();
      } else if(grip&&hand.mode==='handle') {
        watch.dragMove(hand,hand.tracked?hand.point:fingertipOf(hand));
      } else if(!grip&&hand.trigger) {
        const was=hand.mode;hand.mode=null;
        if(was==='handle')watch.dragEnd(hand);
        // Still holding with the other hand: it carries on alone, from where it is now.
        if(other.mode==='grab')regrab();
        if(was==='grab'&&mode==='map'&&!busy(other))mapMode.commit(view);
      }
      hand.trigger=grip;
    }
    // The outlined hand model once loaded; joint dots meanwhile (or if the model could not load).
    if(hand.tracked)dressJoints(hand,!hand.skin.update(hand.trigger));
    hand.dot.material.color.set(hand.uiHover?0xffffff:hand.mode==='grab'?0x8fae78:0xe9c890);
  }
  function update(delta) {
    // A new terrain from Generate: show it. If generating failed (the same terrain is still showing), stay on the map.
    if(generating&&!ctx.state.loading){if(ctx.state.id!==generating.from&&mode==='map')setMode('model');generating=null;}
    if(mode==='model') {
      syncTiles();
      if(ctx.state.id!==lastId){lastId=ctx.state.id;frameModel();}
    }
    commands.paused=watch.searching;   // a search being spoken is not a command
    hands.forEach(updateHand);
    // A menu opened while the map was held: let go of it there (the selection is set as on any release).
    if(watch.busy&&hands.some(busy)){hands.forEach(hand=>{if(busy(hand))hand.mode=null;});if(mode==='map')mapMode.commit(view);}
    watch.update();
    if(!updateGrab())fly(delta);
    if(mode==='map')mapMode.update(view,toWorld(camera.position),{interacting:hands.some(busy),camera});
    applyView();
  }

  // ---------- session ----------
  async function enter() {
    if(session)return;
    if(!navigator.xr){ctx.notify(`VR needs a secure page. Start the server without --local and open https://${location.hostname}:${location.port||443} in the headset browser.`,true);return;}
    try {
      session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor','bounded-floor','hand-tracking']});
    } catch(error){session=null;ctx.notify(`Could not start VR: ${error.message}`,true);return;}
    background=scene.background;scene.background=new THREE.Color(MAP_SKY);
    scene.add(rig);renderer.xr.enabled=true;renderer.xr.setReferenceSpaceType('local-floor');
    // Taking the headset off hides the session; on return, reconnect at once rather than after the backoff.
    session.addEventListener('visibilitychange',()=>{if(session?.visibilityState==='visible')ctx.live?.now();else ctx.handoff?.(true);});
    session.addEventListener('end',()=>{
      dropTiles();mapMode.leave();watch.close();commands.stop();ctx.model.visible=true;
      ctx.model.matrixAutoUpdate=true;ctx.model.updateMatrix();   // back to the page's own viewif(ctx.grid)ctx.grid.visible=ctx.state.view!=='elevation';
      ctx.handoff?.(true);   // you are taking the headset off: the computer's page can continue from here
      session=null;renderer.xr.enabled=false;scene.remove(rig);scene.background=background;
      hands.forEach(hand=>{hand.mode=null;hand.trigger=false;});ctx.requestRender();
    });
    await renderer.xr.setSession(session);
    lastId=null;setMode('map');
    if(voiceOn)commands.start();
  }

  async function attachButton(button) {
    const headset=/OculusBrowser|Quest|Pico/i.test(navigator.userAgent);
    let supported=false;
    try{supported=Boolean(await navigator.xr?.isSessionSupported('immersive-vr'));}catch{/* No WebXR. */}
    // On a headset over plain HTTP the button stays, to explain how to get a secure page.
    button.hidden=!(supported||headset);
    button.addEventListener('click',()=>enter());
  }

  instance={update,attachButton,camera,setMode,exit:()=>session?.end(),watchPoint:id=>watch.regionPoint(id),get live(){return ctx.live;},get presenting(){return Boolean(session);},
    get state(){return {scale:view.scale,yaw:view.yaw,position:view.position.toArray(),minScale:view.minScale,maxScale:view.maxScale,
      mode,background:session?backdrop:null,backgroundShown:scene.background?.isTexture?scene.background.image?.src?.split('/').pop()||'gradient':null,watch:watch.state,commands:{...commands.state,on:voiceOn},map:{...mapMode.state,selection:mapMode.active?mapMode.boundsFrom(view):null},pageSelection:ctx.state.selection,flownSeconds,area:ctx.state.data?{bounds:ctx.state.data.bounds,width_m:ctx.state.data.width_m,height_m:ctx.state.data.height_m}:null,
      hands:hands.map(hand=>({tracked:hand.tracked,model:hand.skin.ready,touching:Boolean(hand.poking),over:hand.uiHover||null,pinching:hand.trigger,mode:hand.mode,point:hand.point.toArray(),indexTip:joint(hand,'index-finger-tip')?.position.toArray()||null})),tiles:tiles?tiles.children.length:0,
      tileTriangles:tiles?tiles.children.reduce((sum,part)=>sum+part.geometry.index.count/3,0):0,surfaceHidden:ctx.surface?!ctx.surface.visible:false};}};
  return instance;
}
