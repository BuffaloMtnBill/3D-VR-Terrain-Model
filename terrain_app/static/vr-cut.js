// VR cut editing: the surroundings of the selection as a terrain you can stand over, with the cut drawn as a glowing
// fence and handles to move, resize, scale, and turn it. The page's own selection stays the one source of truth: the
// fence follows it, and a finished drag sets it (so the map frame, shape, and aspect controls all stay in step).
import * as THREE from 'three';
import {mercatorPixel,rotationAngle} from './selection-geometry.js';

const SURROUNDINGS=3;           // the surroundings span this many times the cut, around its center
const MAX_SIDE_M=240000;        // the elevation service's limit per side, with a margin
const DETAIL=160;               // grid points per side of the surroundings
const HANDLE_ROOM_M=.022;       // handle radius in the room, at any zoom
const REACH_ROOM_M=.05;         // how near a pinch must be to take a handle
const MIN_SIDE_M=60;
const EARTH_M=40075016.686;
const RAMP=['#3f5f36','#6f7a45','#9a8657','#c9bfa6','#f2efe8'].map(hex=>new THREE.Color(hex));

const fromMercator=(x,y)=>({lng:x/256*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/256)))*180/Math.PI});
const metersPerPixel=lat=>EARTH_M*Math.cos(lat*Math.PI/180)/256;

export function createCut(ctx) {
  const group=new THREE.Group();group.name='VR cut surroundings';group.visible=false;
  const terrainMaterial=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.95,metalness:0});
  const fenceMaterial=new THREE.MeshBasicMaterial({color:0xe9c890,transparent:true,opacity:.2,side:THREE.DoubleSide,depthWrite:false});
  const lineMaterial=new THREE.LineBasicMaterial({color:0xffe2a8});
  const fence=new THREE.Mesh(new THREE.BufferGeometry(),fenceMaterial);fence.renderOrder=5;
  const rimTop=new THREE.LineLoop(new THREE.BufferGeometry(),lineMaterial),rimLow=new THREE.LineLoop(new THREE.BufferGeometry(),lineMaterial);
  group.add(fence,rimTop,rimLow);
  const handleDefs={
    move:{color:0xe9c890,hint:'Move the cut'},
    width:{color:0xfff6d6,hint:'Change the width'},
    height:{color:0xfff6d6,hint:'Change the height'},
    scale:{color:0xfff6d6,hint:'Scale the cut'},
    rotate:{color:0x8fae78,hint:'Turn the cut'},
  };
  const handles=Object.fromEntries(Object.entries(handleDefs).map(([name,def])=>{
    const geometry=name==='rotate'?new THREE.TorusGeometry(1,.32,10,28):new THREE.SphereGeometry(1,20,14);
    const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:def.color,depthTest:false,transparent:true,opacity:.95}));
    mesh.renderOrder=1002;mesh.name=`cut handle ${name}`;if(name==='rotate')mesh.rotation.x=Math.PI/2;
    group.add(mesh);return [name,mesh];
  }));

  // The local frame: meters east (x) and south (z) of a fixed origin, through Web Mercator scaled at the origin.
  let origin=null,surroundings=null,terrain=null,loading=null,loadError=null,active=false,frame=null,drag=null,shownKey='',top=1,hovered=null;

  const toLocal=(lng,lat)=>{const p=mercatorPixel(lng,lat);return {x:(p.x-origin.x)*origin.k,z:(p.y-origin.y)*origin.k};};
  // Fixed for the session, so the surroundings never jump while the cut is resized under your hand.
  const scale=()=>origin?.s||1;

  // The page's bounds as a frame in local meters: center, width, height, angle (degrees), and shape.
  function frameOf(bounds) {
    if(!origin)return null;
    const nw=mercatorPixel(bounds.west,bounds.north),se=mercatorPixel(bounds.east,bounds.south);
    return {cx:((nw.x+se.x)/2-origin.x)*origin.k,cz:((nw.y+se.y)/2-origin.y)*origin.k,w:(se.x-nw.x)*origin.k,h:(se.y-nw.y)*origin.k,
      angle:rotationAngle(bounds),shape:bounds.shape||'rectangle'};
  }
  function boundsOf(f) {
    const cx=origin.x+f.cx/origin.k,cy=origin.y+f.cz/origin.k,hw=f.w/2/origin.k,hh=f.h/2/origin.k;
    const nw=fromMercator(cx-hw,cy-hh),se=fromMercator(cx+hw,cy+hh);
    const bounds={north:nw.lat,south:se.lat,west:nw.lng,east:se.lng};
    const angle=Math.round(f.angle*10)/10;
    if(angle)bounds.rotation_deg=angle;
    if(f.shape!=='rectangle')bounds.shape=f.shape;
    return bounds;
  }
  const frameToWorld=(f,fx,fz)=>{const a=f.angle*Math.PI/180;return {x:f.cx+fx*Math.cos(a)-fz*Math.sin(a),z:f.cz+fx*Math.sin(a)+fz*Math.cos(a)};};
  const worldToFrame=(f,x,z)=>{const a=f.angle*Math.PI/180,dx=x-f.cx,dz=z-f.cz;return {x:dx*Math.cos(a)+dz*Math.sin(a),z:-dx*Math.sin(a)+dz*Math.cos(a)};};
  const inside=(f,x,z)=>{const p=worldToFrame(f,x,z);
    return f.shape==='rectangle'?Math.abs(p.x)<=f.w/2&&Math.abs(p.z)<=f.h/2:(p.x/(f.w/2))**2+(p.z/(f.h/2))**2<=1;};

  // ---------- surroundings ----------
  function surroundingBounds(f) {
    const a=f.angle*Math.PI/180,spanX=Math.abs(f.w*Math.cos(a))+Math.abs(f.h*Math.sin(a)),spanZ=Math.abs(f.w*Math.sin(a))+Math.abs(f.h*Math.cos(a));
    const side=Math.min(MAX_SIDE_M,SURROUNDINGS*Math.max(spanX,spanZ));
    const cx=origin.x+f.cx/origin.k,cy=origin.y+f.cz/origin.k,half=side/2/metersPerPixel(fromMercator(cx,cy).lat);
    const nw=fromMercator(cx-half,cy-half),se=fromMercator(cx+half,cy+half);
    return {north:Math.min(nw.lat,85),south:Math.max(se.lat,-85),west:Math.max(nw.lng,-180),east:Math.min(se.lng,180)};
  }
  async function loadSurroundings() {
    const f=frame;if(!f)return;
    const bounds=surroundingBounds(f),started=loading={bounds};loadError=null;
    try {
      const job=await ctx.api('/api/terrain',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({bounds,resolution:DETAIL,source:ctx.source(),preview:true})});
      for(let status={state:'queued'};status.state!=='ready';) {
        const event=await ctx.live?.next(e=>e.type==='job'&&e.id===job.id&&e.state!=='loading',1500);
        status=event||await ctx.api(`/api/jobs/${job.id}`);
        if(status.state==='error')throw new Error(status.message);
        if(started!==loading)return;
      }
      const data=await ctx.fetchSurface(`/api/terrain/${job.id}?format=binary`);
      if(started!==loading)return;
      surroundings={bounds,data};buildTerrain();
    } catch(error){if(started===loading)loadError=error.message;}
    finally{if(started===loading)loading=null;}
  }
  function covers(f) {
    if(!surroundings)return false;
    const b=surroundings.bounds,nw=toLocal(b.west,b.north),se=toLocal(b.east,b.south),margin=.04*(se.x-nw.x);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].every(([sx,sz])=>{const p=frameToWorld(f,sx*f.w/2,sz*f.h/2);
      return p.x>nw.x+margin&&p.x<se.x-margin&&p.z>nw.z+margin&&p.z<se.z-margin;});
  }

  function buildTerrain() {
    if(terrain){group.remove(terrain);terrain.geometry.dispose();terrain=null;}
    const {data,bounds}=surroundings,{rows,columns,elevations}=data,count=rows*columns;
    const positions=new Float32Array(count*3),colors=new Float32Array(count*3),base=new Float32Array(count*3);
    const range=Math.max(data.max_m-data.min_m,1e-6),color=new THREE.Color();
    for(let row=0;row<rows;row++) {
      const lat=bounds.north+(bounds.south-bounds.north)*row/(rows-1);
      for(let column=0;column<columns;column++) {
        const i=row*columns+column,p=toLocal(bounds.west+(bounds.east-bounds.west)*column/(columns-1),lat);
        positions[i*3]=p.x;positions[i*3+2]=p.z;
        const t=(elevations[i]-data.min_m)/range*(RAMP.length-1),k=Math.min(RAMP.length-2,Math.floor(t));
        color.copy(RAMP[k]).lerp(RAMP[k+1],t-k).toArray(base,i*3);
      }
    }
    const indices=new Uint32Array((rows-1)*(columns-1)*6);let cursor=0;
    for(let row=0;row<rows-1;row++)for(let column=0;column<columns-1;column++){const a=row*columns+column;indices.set([a,a+columns,a+1,a+1,a+columns,a+columns+1],cursor);cursor+=6;}
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    geometry.setIndex(new THREE.BufferAttribute(indices,1));
    geometry.userData={base};
    terrain=new THREE.Mesh(geometry,terrainMaterial);terrain.name='Surroundings';group.add(terrain);
    shownKey='';
  }

  // Heights follow the elevation multiplier; the cut is lit, the surroundings dimmed.
  function paint(f) {
    if(!terrain)return;
    const {data}=surroundings,exaggeration=ctx.exaggeration(),geometry=terrain.geometry;
    const position=geometry.getAttribute('position'),color=geometry.getAttribute('color'),base=geometry.userData.base;
    const p=position.array,c=color.array;
    for(let i=0;i<position.count;i++) {
      p[i*3+1]=(data.elevations[i]-data.min_m)*exaggeration;
      const lit=inside(f,p[i*3],p[i*3+2])?1:.42;
      c[i*3]=base[i*3]*lit;c[i*3+1]=base[i*3+1]*lit;c[i*3+2]=base[i*3+2]*lit;
    }
    position.needsUpdate=true;color.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();
    top=Math.max((data.max_m-data.min_m)*exaggeration,1);
  }

  function outline(f) {
    const points=[];
    if(f.shape==='rectangle')for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]])points.push(frameToWorld(f,sx*f.w/2,sz*f.h/2));
    else for(let i=0;i<72;i++){const t=i/72*Math.PI*2;points.push(frameToWorld(f,Math.cos(t)*f.w/2,Math.sin(t)*f.h/2));}
    return points;
  }
  function drawFrame(f) {
    const points=outline(f),high=top*1.12,low=-top*.02,quads=[];
    points.forEach((a,i)=>{const b=points[(i+1)%points.length];quads.push(a.x,low,a.z,b.x,low,b.z,a.x,high,a.z,a.x,high,a.z,b.x,low,b.z,b.x,high,b.z);});
    fence.geometry.dispose();fence.geometry=new THREE.BufferGeometry();fence.geometry.setAttribute('position',new THREE.Float32BufferAttribute(quads,3));
    for(const [line,y] of [[rimTop,high],[rimLow,low]]){line.geometry.dispose();line.geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(p.x,y,p.z)));}
    const at=(fx,fz)=>{const p=frameToWorld(f,fx,fz);return new THREE.Vector3(p.x,high,p.z);};
    handles.move.position.copy(at(0,0));
    handles.width.position.copy(at(f.w/2,0));
    handles.height.position.copy(at(0,f.h/2));
    handles.scale.position.copy(f.shape==='rectangle'?at(f.w/2,f.h/2):at(f.w/2*Math.SQRT1_2,f.h/2*Math.SQRT1_2));
    handles.rotate.position.copy(at(0,-f.h/2-Math.max(f.w,f.h)*.14));
  }

  // ---------- per frame ----------
  function update(view) {
    if(!active)return;
    const selection=ctx.state.selection;
    if(!origin&&selection){const nw=mercatorPixel(selection.west,selection.north),se=mercatorPixel(selection.east,selection.south),x=(nw.x+se.x)/2,y=(nw.y+se.y)/2;
      const k=metersPerPixel(fromMercator(x,y).lat);
      origin={x,y,k,s:ctx.SCALE/Math.max((se.x-nw.x)*k,(se.y-nw.y)*k,1)};}
    if(!drag&&selection)frame=frameOf(selection);
    if(!frame)return;
    if(!loading&&!loadError&&!drag&&!covers(frame))loadSurroundings();
    group.scale.setScalar(scale());
    const key=JSON.stringify([frame,ctx.exaggeration(),terrain?.geometry.uuid]);
    if(key!==shownKey){shownKey=key;paint(frame);drawFrame(frame);}
    // Handles keep one size in the room however far you zoom.
    const radius=HANDLE_ROOM_M*view.scale/group.scale.x;
    for(const [name,mesh] of Object.entries(handles)) {
      mesh.scale.setScalar(radius*(name===hovered||name===drag?.name?1.35:1));
      mesh.visible=Boolean(terrain);
      if(name==='width'||name==='height')mesh.visible&&=frame.shape!=='circle';
    }
  }

  // The handle a pinch at this world point would take (direct), or else the one a pointing ray meets.
  function handleAt(worldPoint,ray,view) {
    if(!active||!terrain)return null;
    const reach=REACH_ROOM_M*view.scale;let best=null,bestDistance=Infinity;
    for(const [name,mesh] of Object.entries(handles)) {
      if(!mesh.visible||!worldPoint)continue;
      const center=mesh.getWorldPosition(new THREE.Vector3());
      const distance=worldPoint?worldPoint.distanceTo(center):Infinity;
      if(distance<reach&&distance<bestDistance){best=name;bestDistance=distance;}
    }
    if(best)return {name:best,direct:true};
    if(!ray)return null;
    const hits=ray.intersectObjects(Object.values(handles).filter(mesh=>mesh.visible),false);
    return hits.length?{name:hits[0].object.name.replace('cut handle ',''),direct:false}:null;
  }
  const hover=name=>{hovered=name;};

  // Drags work on the horizontal plane through the handles: a pinch point, or where a pointing ray meets that plane.
  function localPoint(worldPoint,ray) {
    if(worldPoint)return group.worldToLocal(worldPoint.clone());
    const height=group.localToWorld(new THREE.Vector3(0,top*1.12,0)).y;
    const hit=ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-height),new THREE.Vector3());
    return hit?group.worldToLocal(hit):null;
  }
  function startDrag(name,worldPoint,ray) {
    const point=localPoint(worldPoint,ray);if(!point||!frame)return false;
    drag={name,start:{...frame},point};return true;
  }
  function moveDrag(worldPoint,ray) {
    if(!drag)return;
    const point=localPoint(worldPoint,ray);if(!point)return;
    const s=drag.start,f={...s},p0=drag.point;
    if(drag.name==='move'){f.cx=s.cx+point.x-p0.x;f.cz=s.cz+point.z-p0.z;}
    else if(drag.name==='width'||drag.name==='height') {
      const local=worldToFrame(s,point.x,point.z);
      if(drag.name==='width')f.w=Math.max(MIN_SIDE_M,2*Math.abs(local.x));else f.h=Math.max(MIN_SIDE_M,2*Math.abs(local.z));
    } else if(drag.name==='scale') {
      const ratio=Math.hypot(point.x-s.cx,point.z-s.cz)/Math.max(Math.hypot(p0.x-s.cx,p0.z-s.cz),1e-6);
      const limit=Math.max(MIN_SIDE_M/Math.min(s.w,s.h),Math.min(ratio,MAX_SIDE_M/Math.max(s.w,s.h)));
      f.w=s.w*limit;f.h=s.h*limit;
    } else if(drag.name==='rotate') {
      let angle=s.angle+(Math.atan2(point.z-s.cz,point.x-s.cx)-Math.atan2(p0.z-s.cz,p0.x-s.cx))*180/Math.PI;
      angle=((angle+180)%360+360)%360-180;
      if(Math.abs(angle)<2)angle=0;   // a gentle snap back to north-up
      f.angle=Math.round(angle);
    }
    f.w=Math.min(f.w,MAX_SIDE_M);f.h=Math.min(f.h,MAX_SIDE_M);
    frame=f;
  }
  function endDrag() {
    if(!drag)return;
    const finished=frame;drag=null;
    try{ctx.setSelection(boundsOf(finished));}
    catch(error){ctx.notify(error.message,true);}
  }

  function enter() {
    if(active)return;
    active=true;group.visible=true;shownKey='';
    // A selection far from the last surroundings (a new landscape) starts afresh around it.
    const selection=ctx.state.selection;
    if(origin&&selection&&!covers(frameOf(selection))){
      origin=null;surroundings=null;loading=null;loadError=null;
      if(terrain){group.remove(terrain);terrain.geometry.dispose();terrain=null;}
    }
    if(!group.parent)ctx.scene.add(group);
  }
  function leave() {
    if(!active)return;
    endDrag();active=false;group.visible=false;hovered=null;
  }

  function summary() {
    if(!frame)return '';
    const km=value=>value>=1000?`${(value/1000).toFixed(value>=10000?0:1)} km`:`${Math.round(value)} m`;
    return `${km(frame.w)} × ${km(frame.h)}${frame.angle?` · turned ${frame.angle}°`:''}${frame.shape!=='rectangle'?` · ${frame.shape}`:''}`;
  }
  function status() {
    if(loadError)return {text:`Surroundings could not load: ${loadError}`,error:true};
    if(loading)return {text:'Loading the surroundings…'};
    if(drag)return {text:handleDefs[drag.name].hint};
    return null;
  }

  return {group,enter,leave,update,handleAt,hover,startDrag,moveDrag,endDrag,summary,status,
    retry(){loadError=null;},
    get active(){return active;},get dragging(){return Boolean(drag);},get ready(){return Boolean(terrain);},
    get state(){return {active,ready:Boolean(terrain),frame,loading:Boolean(loading),error:loadError,
      handles:Object.fromEntries(Object.entries(handles).map(([name,mesh])=>[name,mesh.visible?mesh.getWorldPosition(new THREE.Vector3()).toArray():null]))};}};
}
