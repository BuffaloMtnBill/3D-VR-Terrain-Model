// A flat street (or topographic) map under the VR model, so the model sits on a large map at its real place.
// Two layers: a detailed one around the model and a wide one, fading out at its edge, for context. Both are
// built from the same tiles the page's map uses, drawn into one canvas each, north up and in meters; the
// caller places them (the model is turned with its selection, the cut's surroundings are north up).
import * as THREE from 'three';
import {mercatorPixel} from './selection-geometry.js';

const EARTH_M=40075016.686;
const LAYERS=[{span:4,pixels:2048,drop:0},{span:16,pixels:1024,drop:1}];   // times the area's size; canvas size
const MAX_ZOOM=18;

const fromMercator=(x,y)=>({lng:x/256*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/256)))*180/Math.PI});
const metersPerPixel=lat=>EARTH_M*Math.cos(lat*Math.PI/180)/256;

function tileUrl(template,z,x,y) {
  return template.replace('{s}','a').replace('{z}',z).replace('{x}',x).replace('{y}',y).replace('{r}','');
}
function loadImage(url) {
  return new Promise(resolve=>{
    const image=new Image();image.crossOrigin='anonymous';image.decoding='async';
    image.onload=()=>resolve(image);image.onerror=()=>resolve(null);image.src=url;
  });
}
// Transparent at the rim of the wide layer, so the map fades into the sky instead of ending at an edge.
function fadeMap() {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const c=canvas.getContext('2d'),gradient=c.createRadialGradient(128,128,70,128,128,128);
  gradient.addColorStop(0,'#fff');gradient.addColorStop(1,'#000');c.fillStyle=gradient;c.fillRect(0,0,256,256);
  return new THREE.CanvasTexture(canvas);
}

// One square layer: `side` meters across, centered on (lat, lng), as a mesh lying flat (x east, z south).
async function buildLayer({template,maxZoom,lat,lng,side,pixels,fade,anisotropy,isCurrent}) {
  const center=mercatorPixel(lng,lat),half=side/2/metersPerPixel(lat);
  const zoom=Math.max(1,Math.min(maxZoom,Math.floor(Math.log2(pixels/(2*half)))));
  const scale=2**zoom,left=(center.x-half)*scale,top=(center.y-half)*scale,width=2*half*scale;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=Math.max(64,Math.round(width));
  const c=canvas.getContext('2d');c.fillStyle='#d9d4c6';c.fillRect(0,0,canvas.width,canvas.height);
  const x0=Math.floor(left/256),y0=Math.floor(top/256),x1=Math.floor((left+width)/256),y1=Math.floor((top+width)/256),count=2**zoom;
  const jobs=[];
  for(let y=Math.max(0,y0);y<=Math.min(count-1,y1);y++)for(let x=x0;x<=x1;x++) {
    const wrapped=((x%count)+count)%count;
    jobs.push(loadImage(tileUrl(template,zoom,wrapped,y)).then(image=>{if(image)c.drawImage(image,x*256-left,y*256-top,256,256);}));
  }
  await Promise.all(jobs);
  if(!isCurrent())return null;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=anisotropy;
  const material=new THREE.MeshBasicMaterial({map:texture,color:0xd8d8d8,transparent:Boolean(fade),alphaMap:fade?fadeMap():null,depthWrite:!fade});
  const geometry=new THREE.PlaneGeometry(side,side).rotateX(-Math.PI/2);
  const mesh=new THREE.Mesh(geometry,material);mesh.name='VR ground map';
  mesh.userData={zoom,tiles:jobs.length};
  return mesh;
}

export function createGroundMap(ctx) {
  const group=new THREE.Group();group.name='VR ground map';
  let key='',version=0,style='streets',layers=[];

  function clear() {
    for(const mesh of layers){group.remove(mesh);mesh.geometry.dispose();mesh.material.map?.dispose();mesh.material.alphaMap?.dispose();mesh.material.dispose();}
    layers=[];
  }
  // Show the map for an area `side` meters across around (lat, lng); rebuilt only when that or the style changes.
  async function show(lat,lng,side) {
    const wanted=style==='off'?'off':`${style}:${lat.toFixed(5)}:${lng.toFixed(5)}:${Math.round(side)}`;
    if(wanted===key)return;
    key=wanted;const current=++version;
    clear();
    if(style==='off')return;
    const source=ctx.mapStyles()?.[style];if(!source)return;
    const anisotropy=ctx.renderer.capabilities.getMaxAnisotropy();
    await Promise.all(LAYERS.map(async(layer,index)=>{
      const mesh=await buildLayer({template:source.url,maxZoom:Math.min(MAX_ZOOM,source.nativeZoom||MAX_ZOOM),lat,lng,side:side*layer.span,
        pixels:layer.pixels,fade:index>0,anisotropy,isCurrent:()=>current===version});
      if(!mesh||current!==version)return;
      // The wide layer sits a hair below the detailed one, so they never fight for the same pixels.
      mesh.position.y=-layer.drop*side*1e-4;mesh.renderOrder=-10-index;
      layers.push(mesh);group.add(mesh);
    }));
  }
  const styles=['streets','terrain','off'],labels={streets:'Streets',terrain:'Topographic',off:'Off'};
  return {group,show,
    cycle(){style=styles[(styles.indexOf(style)+1)%styles.length];key='';},
    get label(){return labels[style];},
    get attribution(){return style==='off'?'':ctx.mapStyles()?.[style]?.attribution?.replace(/<[^>]+>/g,'')||'';},
    get state(){return {style,layers:layers.map(mesh=>({...mesh.userData,side:mesh.geometry.parameters?.width}))};},
    dispose:clear};
}
