/* Colored OSM geometry draped on the same triangular surface as the terrain. */
import * as THREE from 'three';

export const featureLabels={roads:'Roads',railways:'Train tracks',borders:'Borders',water:'Water',cities:'City boundaries',parks:'Park boundaries',buildings:'Buildings',at:'AT (Appalachian Trail)'};
const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
const MAX_VERTICES=900000;

export function filterFeatures(data,styles,terrain) {
  const roadDetail=styles.roads?.detail??100,waterDetail=styles.water?.detail??100;
  const importance={motorway:0,motorway_link:0,trunk:0,trunk_link:0,primary:0,primary_link:0,
    secondary:25,secondary_link:25,tertiary:50,tertiary_link:50,unclassified:75,residential:75};
  const ringArea=ring=>Math.abs(ring.reduce((sum,point,index)=>{
    const next=ring[(index+1)%ring.length];return sum+point[0]*next[1]-next[0]*point[1];
  },0))/2;
  const layers={...data.layers};
  layers.roads=layers.roads.filter(feature=>roadDetail>=(importance[feature.kind]??100));
  layers.water=layers.water.filter(feature=>{
    if(waterDetail===100)return true;
    if(feature.kind==='river'||feature.kind==='riverbank')return true;
    if(feature.kind==='canal')return waterDetail>=25;
    if(feature.kind==='stream')return waterDetail>=80;
    if(feature.kind==='ditch'||feature.kind==='drain')return waterDetail>=100;
    const area=feature.area_m2??feature.polygons.reduce((sum,polygon)=>sum+ringArea(polygon.outer)-polygon.holes.reduce((total,ring)=>total+ringArea(ring),0),0)*terrain.width_m*terrain.height_m;
    return area>=20000*(1-waterDetail/100)**2;
  });
  return {...data,layers,counts:Object.fromEntries(Object.entries(layers).map(([name,features])=>[name,features.length]))};
}

export function disposeFeatures(group) {
  if(!group)return;
  group.traverse(object=>{
    if(!object.isMesh)return;
    object.geometry.dispose();object.material.map?.dispose();object.material.dispose();
  });
  group.removeFromParent();
}

function terrainSampler(data,options,scale) {
  const {rows,columns,elevations}=data,unit=scale/Math.max(data.width_m,data.height_m);
  const width=data.width_m*unit,height=data.height_m*unit,base=options.solid?scale*options.base_percent/100:0;
  function point(u,v,lift=.01) {
    u=clamp(u);v=clamp(v);
    const x=u*(columns-1),y=v*(rows-1),column=Math.min(columns-2,Math.floor(x)),row=Math.min(rows-2,Math.floor(y));
    const rx=x-column,ry=y-row,index=row*columns+column;
    const a=elevations[index],b=elevations[index+1],c=elevations[index+columns],d=elevations[index+columns+1];
    const elevation=rx+ry<=1?a*(1-rx-ry)+b*rx+c*ry:d*(rx+ry-1)+b*(1-ry)+c*(1-rx);
    return [(u-.5)*width,(elevation-data.surface_min_m)*options.exaggeration*unit+base+lift,(v-.5)*height];
  }
  return {point,width,height,rows,columns,unit};
}

function ribbonGeometry(features,category,sampler) {
  const positions=[],{point,width,height,rows,columns}=sampler;
  const lineWidth=category==='roads'?.014:category==='water'?.012:.010;
  let segmentNumber=0;
  function ribbon(start,end,normal,offset,thickness) {
    const [u0,v0]=start,[u1,v1]=end;
    const left=offset-thickness/2,right=offset+thickness/2;
    const a=point(u0+normal[0]*left/width,v0+normal[1]*left/height);
    const b=point(u0+normal[0]*right/width,v0+normal[1]*right/height);
    const c=point(u1+normal[0]*left/width,v1+normal[1]*left/height);
    const d=point(u1+normal[0]*right/width,v1+normal[1]*right/height);
    positions.push(...a,...b,...c,...b,...d,...c);
    if(positions.length/3>MAX_VERTICES)throw new Error('These map features are too dense to render. Select a smaller area.');
  }
  for(const feature of features)for(const path of feature.lines)for(let i=1;i<path.length;i++) {
    const first=path[i-1],last=path[i],du=last[0]-first[0],dv=last[1]-first[1],dx=du*width,dz=dv*height;
    const length=Math.hypot(dx,dz);if(length<1e-10)continue;
    const normal=[-dz/length,dx/length];
    const steps=Math.max(1,Math.ceil(Math.hypot(du*(columns-1),dv*(rows-1))*2));
    for(let step=0;step<steps;step++,segmentNumber++) {
      const a=step/steps,b=(step+1)/steps,start=[first[0]+du*a,first[1]+dv*a],end=[first[0]+du*b,first[1]+dv*b];
      if(['borders','cities','parks'].includes(category)&&segmentNumber%6>=4)continue;
      if(category==='railways') {
        ribbon(start,end,normal,-.006,.004);ribbon(start,end,normal,.006,.004);
        if(segmentNumber%6===0) {
          const acrossStart=[start[0]-normal[0]*.010/width,start[1]-normal[1]*.010/height];
          const acrossEnd=[start[0]+normal[0]*.010/width,start[1]+normal[1]*.010/height];
          ribbon(acrossStart,acrossEnd,[dx/length,dz/length],0,.003);
        }
      } else ribbon(start,end,normal,0,lineWidth);
    }
  }
  if(!positions.length)return null;
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.computeVertexNormals();return geometry;
}

function waterSurface(features,terrainGeometry,color) {
  const polygons=features.flatMap(feature=>feature.polygons);if(!polygons.length)return null;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
  const context=canvas.getContext('2d');context.fillStyle='#ffffff';
  for(const polygon of polygons) {
    context.beginPath();
    for(const ring of [polygon.outer,...polygon.holes]) {
      ring.forEach(([u,v],index)=>index?context.lineTo(u*1024,v*1024):context.moveTo(u*1024,v*1024));
      context.closePath();
    }
    context.fill('evenodd');
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const geometry=terrainGeometry.clone();geometry.deleteAttribute('color');geometry.deleteAttribute('elevation');
  const positions=geometry.getAttribute('position');
  for(let i=0;i<positions.count;i++)positions.setY(i,positions.getY(i)+.006);
  positions.needsUpdate=true;
  const material=new THREE.MeshBasicMaterial({color,map:texture,transparent:true,opacity:.88,alphaTest:.02,depthWrite:false,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometry,material);mesh.name='Water areas';mesh.userData={category:'water'};mesh.renderOrder=1;
  return mesh;
}

function buildingGeometry(features,sampler) {
  const positions=[];
  for(const feature of features)for(const polygon of feature.polygons) {
    const makePath=(ring,Path)=>new Path(ring.map(([u,v])=>new THREE.Vector2((u-.5)*sampler.width,-(v-.5)*sampler.height)));
    const shape=makePath(polygon.outer,THREE.Shape);
    shape.holes=polygon.holes.map(ring=>makePath(ring,THREE.Path));
    const ground=polygon.outer.map(([u,v])=>sampler.point(u,v)[1]);
    const low=ground.reduce((value,point)=>Math.min(value,point),Infinity),high=ground.reduce((value,point)=>Math.max(value,point),-Infinity);
    const geometry=new THREE.ExtrudeGeometry(shape,{depth:high-low+(feature.height_m||6)*sampler.unit,bevelEnabled:false,steps:1,curveSegments:1});
    geometry.rotateX(-Math.PI/2);geometry.translate(0,low,0);
    const attribute=geometry.getAttribute('position');
    if(positions.length/3+attribute.count>MAX_VERTICES){geometry.dispose();throw new Error('Too many building surfaces. Select a smaller area.');}
    // Avoid argument-count limits for large building footprints.
    for(const value of attribute.array)positions.push(value);
    geometry.dispose();
  }
  if(!positions.length)return null;
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();
  return geometry;
}

export function buildFeatures(data,terrain,options,styles,terrainGeometry,scale=6.4) {
  data=filterFeatures(data,styles,terrain);
  const group=new THREE.Group();group.name='OpenStreetMap feature layers';
  group.userData={source:data.source,source_url:data.source_url,fetched_at:data.fetched_at,layers:styles,counts:data.counts};
  const sampler=terrainSampler(terrain,options,scale);
  try {
    for(const category of ['water','roads','railways','borders','cities','parks','buildings','at']) {
      const style=styles[category],features=data.layers[category]||[];
      if(!style?.enabled||!features.length)continue;
      if(category==='water') {
        const surface=waterSurface(features,terrainGeometry,style.color);if(surface)group.add(surface);
      }
      const geometry=category==='buildings'?buildingGeometry(features,sampler):ribbonGeometry(features,category,sampler);if(!geometry)continue;
      const material=category==='buildings'?new THREE.MeshStandardMaterial({color:style.color,roughness:.9,side:THREE.DoubleSide}):new THREE.MeshBasicMaterial({color:style.color,side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geometry,material);
      mesh.name=featureLabels[category];mesh.renderOrder=2;mesh.userData={category,color:style.color,feature_count:features.length};group.add(mesh);
    }
    return group;
  } catch(error) {disposeFeatures(group);throw error;}
}
