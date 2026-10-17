// Map Selection mode: the page's map and selection frame in 3D. A box stays fixed on the table in front of you and
// the map moves beneath it (drag it with a pointing ray, pinch with both hands to zoom and turn), exactly as the
// page's map moves beneath its fixed frame. The map is the topographic style (hill shading and contour lines),
// tiled so that tiles near your eyes are sharper: lean in or zoom in and finer tiles load. Each tile is draped over
// a low-resolution relief (17 × 17 heights from the server's elevation cache), raised by the page's elevation
// multiplier; the relief can be switched off for a flat map.
//
// World frame: meters east (x) and south (z) of an origin, through Web Mercator scaled at the origin; the map lies
// at world y = 0. The room is mapped onto it by the VR rig (world = position + scale · rotateY(yaw) · room).
import * as THREE from 'three';
import {mercatorPixel,rotationAngle} from './selection-geometry.js';

export const BOX_ROOM_M=.6;                 // the box's longer side on the table
const EARTH_M=40075016.686;
const DETAIL=.75;                            // a tile splits while it is wider than this times its distance from the eyes
const MAX_TILES=260,MAX_CACHED=420,LOADS_AT_ONCE=6,RELIEF_AT_ONCE=6,RELIEF_SIZE=17;
const MIN_SIDE_M=200,MAX_SIDE_M=240000;      // the box's longer side on the ground

const fromMercator=(x,y)=>({lng:x/256*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/256)))*180/Math.PI});
export const metersPerPixel=lat=>EARTH_M*Math.cos(lat*Math.PI/180)/256;
const normalizeAngle=angle=>((angle+180)%360+360)%360-180;
const tileUrl=(template,z,x,y)=>template.replace('{s}','a').replace('{z}',z).replace('{x}',x).replace('{y}',y).replace('{r}','');

export function createMapMode(ctx,{table}) {
  const world=new THREE.Group();world.name='VR map';world.visible=false;
  const room=new THREE.Group();room.name='VR selection box';room.visible=false;   // added to the rig: room units
  const center=new THREE.Vector3(0,table.height,-table.distance);
  let origin=null,box={w:BOX_ROOM_M,h:BOX_ROOM_M*.75,shape:'rectangle'},boxKey='',lastSet='',active=false,lastLod=0,lodStats={};
  // Relief: heights are kept in meters above sea level; `ref` (set from the first relief that arrives near the box)
  // is the height that sits at table level, and the lowest height seen sets the flat base layer just under it all.
  let reliefOn=true,ref=null,lowest=Infinity,originCount=0;

  // ---------- tiles ----------
  const cache=new Map();let loading=0,reliefLoading=0;const queue=[],reliefQueue=[];
  const geometry=new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2);
  const style=()=>ctx.mapStyles()?.terrain;
  // Base tiles are a separate, flat layer (their own cache keys), so they never take on relief.
  function tileMesh(z,x,y,base=false) {
    const key=`${base?'base:':''}${z}/${x}/${y}`;let tile=cache.get(key);
    if(tile)return tile;
    // Depth-tested, so near hills hide far valleys; coarser tiles are pushed back in depth so that where a finer
    // tile overlaps its stand-in ancestor (while loading), the finer one wins.
    const size=256/2**z,material=new THREE.MeshBasicMaterial({toneMapped:false,color:0xf2f2f2,polygonOffset:true,
      polygonOffsetFactor:1,polygonOffsetUnits:base?60000:(24-z)*200});
    const mesh=new THREE.Mesh(geometry,material);mesh.visible=false;mesh.renderOrder=-100+z;mesh.matrixAutoUpdate=false;
    mesh.userData.place={x0:x*size,y0:y*size,size};
    tile={key,z,x,y,base,mesh,state:'new',used:0,relief:'new'};cache.set(key,tile);world.add(mesh);
    return tile;
  }
  const lift=()=>reliefOn?ctx.exaggeration():0;
  function placeKey(tile){return `${originCount}:${lift()}:${ref}:${tile.base?lowest:tile.relief}`;}
  function placeTile(tile) {
    const {x0,y0,size}=tile.mesh.userData.place,k=origin.k,raise=lift();
    let y=0,scaleY=1;
    if(tile.base)y=Number.isFinite(lowest)&&ref!==null?(lowest-ref)*raise-size*k*.002:-size*k*.002;
    else if(tile.relief==='ready'){y=-(ref??0)*raise;scaleY=raise;}
    tile.mesh.position.set((x0+size/2-origin.x)*k,y,(y0+size/2-origin.y)*k);tile.mesh.scale.set(size*k,scaleY,size*k);tile.mesh.updateMatrix();
    tile.placed=placeKey(tile);
  }
  // A tile's relief: its 17 × 17 heights (meters) as a grid over the tile, with a skirt hanging from its edge so that
  // tiles of different detail never show a crack between them.
  function reliefGeometry(heights,n,skirt) {
    const positions=[],uvs=[],index=[];
    for(let r=0;r<n;r++)for(let c=0;c<n;c++){positions.push(c/(n-1)-.5,heights[r*n+c],r/(n-1)-.5);uvs.push(c/(n-1),1-r/(n-1));}
    for(let r=0;r<n-1;r++)for(let c=0;c<n-1;c++){const a=r*n+c;index.push(a,a+n,a+1,a+1,a+n,a+n+1);}
    const rim=[];
    for(let c=0;c<n-1;c++)rim.push(c);
    for(let r=0;r<n-1;r++)rim.push(r*n+n-1);
    for(let c=n-1;c>0;c--)rim.push((n-1)*n+c);
    for(let r=n-1;r>0;r--)rim.push(r*n);
    const start=positions.length/3;
    rim.forEach(v=>{positions.push(positions[v*3],positions[v*3+1]-skirt,positions[v*3+2]);uvs.push(uvs[v*2],uvs[v*2+1]);});
    rim.forEach((v,i)=>{const w=rim[(i+1)%rim.length],a=start+i,b=start+(i+1)%rim.length;index.push(v,a,w,w,a,b);});
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    g.setIndex(index);g.computeBoundingSphere();
    return g;
  }
  function requestRelief(tile,priority) {
    if(tile.base||tile.relief!=='new'&&!(tile.relief==='error'&&performance.now()-tile.reliefFailed>30000))return;
    tile.relief='queued';tile.reliefPriority=priority;reliefQueue.push(tile);
  }
  function pumpRelief() {
    reliefQueue.sort((a,b)=>a.reliefPriority-b.reliefPriority);
    while(reliefLoading<RELIEF_AT_ONCE&&reliefQueue.length) {
      const tile=reliefQueue.shift();
      if(!tile.wanted){tile.relief='new';continue;}
      reliefLoading++;tile.relief='loading';
      fetch(`/api/relief/${tile.z}/${tile.x}/${tile.y}?size=${RELIEF_SIZE}`).then(response=>{
        if(!response.ok)throw new Error(String(response.status));
        return response.arrayBuffer();
      }).then(buffer=>{
        const heights=new Float32Array(buffer);
        if(heights.length!==RELIEF_SIZE**2)throw new Error('size');
        if(!cache.has(tile.key))return;
        let low=Infinity,high=-Infinity,sorted=null;
        for(const h of heights){low=Math.min(low,h);high=Math.max(high,h);}
        tile.heights={low,high};
        if(ref===null){sorted=[...heights].sort((a,b)=>a-b);ref=sorted[sorted.length>>1];}
        lowest=Math.min(lowest,low);
        const size=tile.mesh.userData.place.size*origin.k;
        tile.mesh.geometry=reliefGeometry(heights,RELIEF_SIZE,Math.max(size*.03,2));tile.relief='ready';tile.placed=null;
      }).catch(()=>{tile.relief='error';tile.reliefFailed=performance.now();})
        .finally(()=>{reliefLoading--;});
    }
  }
  function request(tile,priority) {
    if(tile.state!=='new'&&!(tile.state==='error'&&performance.now()-tile.failed>30000))return;
    tile.state='queued';tile.priority=priority;queue.push(tile);
  }
  function pump() {
    queue.sort((a,b)=>a.priority-b.priority);
    while(loading<LOADS_AT_ONCE&&queue.length) {
      const tile=queue.shift();
      if(!tile.wanted){tile.state='new';continue;}   // no longer needed by the time its turn came
      const source=style();if(!source){tile.state='new';continue;}
      loading++;tile.state='loading';
      const count=2**tile.z,image=new Image();image.crossOrigin='anonymous';
      image.onload=()=>{
        loading--;
        if(!cache.has(tile.key))return;
        const texture=new THREE.Texture(image);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=ctx.renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate=true;tile.mesh.material.map=texture;tile.mesh.material.needsUpdate=true;tile.state='ready';
      };
      image.onerror=()=>{loading--;tile.state='error';tile.failed=performance.now();};
      image.src=tileUrl(source.url,tile.z,((tile.x%count)+count)%count,tile.y);
    }
  }
  function evict() {
    if(cache.size<=MAX_CACHED)return;
    const idle=[...cache.values()].filter(tile=>!tile.mesh.visible&&tile.state!=='loading'&&tile.state!=='queued').sort((a,b)=>a.used-b.used);
    for(const tile of idle.slice(0,cache.size-MAX_CACHED)) {
      tile.mesh.material.map?.dispose();tile.mesh.material.dispose();if(tile.mesh.geometry!==geometry)tile.mesh.geometry.dispose();
      world.remove(tile.mesh);cache.delete(tile.key);
    }
  }

  // Which tiles to show, from where your eyes are: refine near the eyes, coarse far away; a missing tile shows its
  // nearest loaded ancestor (drawn underneath), so the map never has holes while finer tiles arrive.
  function updateTiles(eye) {
    const source=style();if(!source||!origin)return;
    const maxZoom=Math.min(source.nativeZoom||17,18),k=origin.k,height=Math.max(eye.y,1);
    const reach=Math.max(height*14,4000);   // meters of map around the point under your eyes
    const ex=origin.x+eye.x/k,ey=origin.y+eye.z/k,half=reach/k;
    let z0=Math.max(0,Math.min(maxZoom,Math.floor(Math.log2(256/(2*half)))));
    const leaves=[],now=performance.now();
    const visit=(z,x,y)=>{
      const count=2**z;if(y<0||y>=count)return;
      const size=256/count,cx=(x+.5)*size,cy=(y+.5)*size;
      const dx=(cx-ex)*k,dz=(cy-ey)*k,distance=Math.hypot(dx,eye.y,dz),width=size*k;
      if(Math.max(Math.abs(cx-ex),Math.abs(cy-ey))-size/2>half)return;
      if(z<maxZoom&&width>DETAIL*distance&&leaves.length<MAX_TILES)
        for(const [i,j] of [[0,0],[1,0],[0,1],[1,1]])visit(z+1,2*x+i,2*y+j);
      else leaves.push({z,x,y,distance});
    };
    const span=2**z0,size0=256/span;
    for(let y=Math.floor((ey-half)/size0);y<=Math.floor((ey+half)/size0);y++)
      for(let x=Math.floor((ex-half)/size0);x<=Math.floor((ex+half)/size0);x++)visit(z0,x,y);
    for(const tile of cache.values()){tile.wanted=false;tile.mesh.visible=false;}
    // A coarse base layer, always loaded first and drawn under everything, so the map has no holes even while
    // finer tiles are on their way (or when you pan faster than they load).
    const base=Math.max(0,z0-2),baseSize=256/2**base;
    for(let y=Math.floor((ey-half)/baseSize);y<=Math.floor((ey+half)/baseSize);y++)
      for(let x=Math.floor((ex-half)/baseSize);x<=Math.floor((ex+half)/baseSize);x++) {
        if(y<0||y>=2**base)continue;
        const tile=tileMesh(base,x,y,true);tile.wanted=true;tile.used=now;
        if(tile.state==='ready')tile.mesh.visible=true;else request(tile,-1);
      }
    const zooms={};
    for(const leaf of leaves) {
      const tile=tileMesh(leaf.z,leaf.x,leaf.y);tile.wanted=true;tile.used=now;
      if(reliefOn)requestRelief(tile,leaf.distance/(256/2**leaf.z));
      if(tile.state==='ready'){tile.mesh.visible=true;zooms[leaf.z]=(zooms[leaf.z]||0)+1;continue;}
      request(tile,leaf.distance/(256/2**leaf.z));
      for(let z=leaf.z-1,x=leaf.x>>1,y=leaf.y>>1;z>=0;z--,x>>=1,y>>=1) {
        const parent=cache.get(`${z}/${x}/${y}`);
        if(parent?.state==='ready'){parent.mesh.visible=true;parent.used=now;break;}
      }
    }
    for(const tile of cache.values())if(tile.mesh.visible&&tile.placed!==placeKey(tile))placeTile(tile);
    pump();pumpRelief();evict();
    const shown=[...cache.values()].filter(tile=>tile.mesh.visible);
    // How tall the relief on show stands, in meters as drawn (for the browser test).
    let low=Infinity,high=-Infinity;
    for(const tile of shown)if(tile.relief==='ready'){low=Math.min(low,tile.heights.low);high=Math.max(high,tile.heights.high);}
    lodStats={leaves:leaves.length,shown:shown.length,zooms,height:eye.y,cached:cache.size,lift:lift(),
      reliefSpan:Number.isFinite(high)?(high-low)*lift():0,
      relief:shown.filter(tile=>tile.relief==='ready').length,triangles:shown.reduce((sum,tile)=>sum+(tile.mesh.geometry.index?tile.mesh.geometry.index.count/3:2),0)};
  }

  // ---------- the box ----------
  const ribbon=new THREE.MeshBasicMaterial({color:0xffe2a8,depthTest:false,transparent:true,opacity:.95});
  const shade=new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.32,depthWrite:false,depthTest:false});
  const curtain=new THREE.MeshBasicMaterial({color:0xffe2a8,transparent:true,opacity:.28,side:THREE.DoubleSide,depthWrite:false});
  let outline=null,mask=null,walls=null;
  const labelCanvas=document.createElement('canvas');labelCanvas.width=1024;labelCanvas.height=128;
  const labelTexture=new THREE.CanvasTexture(labelCanvas);labelTexture.colorSpace=THREE.SRGBColorSpace;
  const label=new THREE.Mesh(new THREE.PlaneGeometry(.4,.05),new THREE.MeshBasicMaterial({map:labelTexture,transparent:true,depthTest:false}));
  label.renderOrder=1001;room.add(label);
  function shapePath(w,h,shape,path=new THREE.Path()) {
    if(shape==='rectangle'){path.moveTo(-w/2,-h/2);path.lineTo(w/2,-h/2);path.lineTo(w/2,h/2);path.lineTo(-w/2,h/2);path.lineTo(-w/2,-h/2);}
    else path.absellipse(0,0,w/2,h/2,0,Math.PI*2,false,0);
    return path;
  }
  function buildBox() {
    const key=`${box.w}:${box.h}:${box.shape}`;if(key===boxKey)return;boxKey=key;
    for(const mesh of [outline,mask,walls])if(mesh){room.remove(mesh);mesh.geometry.dispose();}
    // The outline: a flat band 6 mm wide; the mask: the table around the box, dimmed (the page's frame does the same).
    const outer=new THREE.Shape();shapePath(box.w+.012,box.h+.012,box.shape,outer);outer.holes.push(shapePath(box.w,box.h,box.shape));
    outline=new THREE.Mesh(new THREE.ShapeGeometry(outer,64).rotateX(-Math.PI/2),ribbon);outline.renderOrder=1000;
    const table=new THREE.Shape();table.moveTo(-4,-4);table.lineTo(4,-4);table.lineTo(4,4);table.lineTo(-4,4);table.lineTo(-4,-4);
    table.holes.push(shapePath(box.w,box.h,box.shape));
    mask=new THREE.Mesh(new THREE.ShapeGeometry(table,64).rotateX(-Math.PI/2),shade);mask.renderOrder=999;
    // ShapeGeometry's y becomes -z after rotateX: the box's "top" edge faces away from you, like north on the page.
    for(const mesh of [outline,mask]){mesh.position.copy(center).setY(center.y+.002);room.add(mesh);}
    // Low glowing walls along the outline, so the box still reads where the relief rises around it.
    const points=shapePath(box.w,box.h,box.shape).getSpacedPoints(box.shape==='rectangle'?4*24:96),quads=[];
    for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1];
      quads.push(a.x,-.03,-a.y,b.x,-.03,-b.y,a.x,.06,-a.y,a.x,.06,-a.y,b.x,-.03,-b.y,b.x,.06,-b.y);}
    walls=new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(quads,3)),curtain);
    walls.position.copy(center);walls.renderOrder=998;room.add(walls);
    label.position.set(center.x,center.y+.004,center.z-box.h/2-.04);label.rotation.set(-Math.PI/2.6,0,0);
  }
  let labelText='';
  function drawLabel(text) {
    if(text===labelText)return;labelText=text;
    const c=labelCanvas.getContext('2d');c.clearRect(0,0,1024,128);
    c.font='600 64px Inter,"Segoe UI",Arial,sans-serif';const width=Math.min(1000,c.measureText(text).width+60);
    c.fillStyle='rgba(16,27,20,.85)';c.beginPath();c.roundRect(512-width/2,14,width,100,40);c.fill();
    c.fillStyle='#ffe2a8';c.textAlign='center';c.textBaseline='middle';c.fillText(text,512,66);labelTexture.needsUpdate=true;
  }

  // ---------- selection <-> view ----------
  function setOrigin(bounds) {
    const nw=mercatorPixel(bounds.west,bounds.north),se=mercatorPixel(bounds.east,bounds.south),x=(nw.x+se.x)/2,y=(nw.y+se.y)/2;
    origin={x,y,k:metersPerPixel(fromMercator(x,y).lat)};originCount++;ref=null;lowest=Infinity;
  }
  // The selection the box covers now.
  function boundsFrom(view) {
    const c=center.clone().applyAxisAngle(new THREE.Vector3(0,1,0),view.yaw).multiplyScalar(view.scale).add(view.position);
    const cx=origin.x+c.x/origin.k,cy=origin.y+c.z/origin.k,hw=box.w*view.scale/2/origin.k,hh=box.h*view.scale/2/origin.k;
    const nw=fromMercator(cx-hw,cy-hh),se=fromMercator(cx+hw,cy+hh);
    const bounds={north:nw.lat,south:se.lat,west:nw.lng,east:se.lng};
    // The box turns with the map the other way: the map turned by yaw puts the selection at -yaw.
    const angle=Math.round(normalizeAngle(-view.yaw*180/Math.PI)*10)/10;
    if(angle)bounds.rotation_deg=angle;
    if(box.shape!=='rectangle')bounds.shape=box.shape;
    return bounds;
  }
  // Fit the view so the box covers the page's selection, and shape the box like it.
  function fitView(view,bounds) {
    if(!origin)setOrigin(bounds);
    const nw=mercatorPixel(bounds.west,bounds.north),se=mercatorPixel(bounds.east,bounds.south);
    const width=se.x-nw.x,height=se.y-nw.y;
    box={w:width>=height?BOX_ROOM_M:BOX_ROOM_M*width/height,h:height>width?BOX_ROOM_M:BOX_ROOM_M*height/width,shape:bounds.shape||'rectangle'};
    buildBox();
    view.scale=width*origin.k/box.w;view.yaw=-rotationAngle(bounds)*Math.PI/180;
    const c=new THREE.Vector3(((nw.x+se.x)/2-origin.x)*origin.k,0,((nw.y+se.y)/2-origin.y)*origin.k);
    view.position.copy(c).sub(center.clone().applyAxisAngle(new THREE.Vector3(0,1,0),view.yaw).multiplyScalar(view.scale));
    limits(view);
    lastSet=JSON.stringify(bounds);
  }
  function limits(view) {
    view.minScale=MIN_SIDE_M/Math.max(box.w,box.h);view.maxScale=MAX_SIDE_M/Math.max(box.w,box.h);
    view.size=Math.max(box.w,box.h)*view.scale;
    view.position.y=-table.height*view.scale;   // the map stays on the table at every zoom
  }
  const km=meters=>meters>=1000?`${(meters/1000).toFixed(meters>=10000?0:1)} km`:`${Math.round(meters)} m`;

  // ---------- per frame ----------
  let previewAt=0;
  function update(view,eye,{interacting}) {
    if(!active)return;
    const selection=ctx.state.selection;
    // The page's selection changed without us (a search, a shape or aspect change, the computer): follow it.
    if(selection&&!interacting&&JSON.stringify(selection)!==lastSet)fitView(view,selection);
    limits(view);
    if(interacting) {
      const bounds=boundsFrom(view),now=performance.now();
      if(now-previewAt>150){previewAt=now;ctx.previewSelection?.(bounds);}
    }
    const meters=box.w*view.scale*metersPerPixel(fromMercator(origin.x,origin.y).lat)/origin.k;
    drawLabel(`${km(meters)} × ${km(meters*box.h/box.w)}${view.yaw?` · ${Math.round(normalizeAngle(-view.yaw*180/Math.PI))}°`:''}`);
    const now=performance.now();
    if(now-lastLod>120){lastLod=now;updateTiles(eye);}
  }
  // A finished drag, zoom, or turn sets the page's selection (the computer's page follows it).
  function commit(view) {
    if(!active||!origin)return;
    const bounds=boundsFrom(view);
    lastSet=JSON.stringify(bounds);
    try{ctx.setSelection(bounds);lastSet=JSON.stringify(ctx.state.selection);}
    catch(error){ctx.notify(error.message,true);}
  }
  function enter(view) {
    active=true;world.visible=true;room.visible=true;
    if(!world.parent)ctx.scene.add(world);
    const selection=ctx.state.selection;
    if(selection){
      // A selection far from the last origin (another landscape) starts a fresh frame around it.
      if(origin){const nw=mercatorPixel(selection.west,selection.north);if(Math.abs(nw.x-origin.x)*origin.k>300000||Math.abs(nw.y-origin.y)*origin.k>300000){origin=null;for(const tile of cache.values())tile.placedFor=null;}}
      fitView(view,selection);
    }
  }
  function leave() {active=false;world.visible=false;room.visible=false;}

  // Where a pointing ray meets the map, in world coordinates: the relief (tested with the ray in the room, where the
  // meshes are drawn), or the table-level plane where there is none.
  const plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
  function hit(worldRay,roomRay,toWorld) {
    const meshes=[];for(const tile of cache.values())if(tile.mesh.visible&&!tile.base)meshes.push(tile.mesh);
    world.updateMatrixWorld(true);
    const found=roomRay.intersectObjects(meshes,false)[0];
    return found?toWorld(found.point):worldRay.ray.intersectPlane(plane,new THREE.Vector3());
  }
  // A drag keeps to the height it started at, so it glides over hills instead of catching on them.
  const hitAt=(worldRay,height)=>worldRay.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-height),new THREE.Vector3());

  return {world,room,enter,leave,update,commit,hit,hitAt,fitView,boundsFrom,
    get relief(){return reliefOn;},
    set relief(on){reliefOn=Boolean(on);for(const tile of cache.values())tile.placed=null;},
    get active(){return active;},
    get state(){return {active,origin,box,tiles:lodStats,relief:reliefOn,ref};}};
}
