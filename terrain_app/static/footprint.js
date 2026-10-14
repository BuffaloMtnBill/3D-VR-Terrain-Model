/* Clip preview triangles to the same 128-sided ellipse used by native model exports.
 * Attributes are interpolated at cuts so surface colors, elevation contours and map UVs stay aligned.
 */
import * as THREE from 'three';

export const FOOTPRINT_SEGMENTS=128;

export function clipFootprint(geometry,bounds,width,height) {
  if(!bounds.shape||bounds.shape==='rectangle')return geometry;
  const attributes=Object.entries(geometry.attributes),position=geometry.getAttribute('position'),indices=geometry.index;
  const names=attributes.map(([name])=>name),sizes=attributes.map(([,attr])=>attr.itemSize);
  const offsets=[];let size=0;
  for(const n of sizes){offsets.push(size);size+=n;}
  const pos=offsets[names.indexOf('position')],output=names.map(()=>[]),rx=width/2,ry=height/2;
  const apothem=Math.cos(Math.PI/FOOTPRINT_SEGMENTS),safe=apothem*apothem;
  const planes=Array.from({length:FOOTPRINT_SEGMENTS},(_,i)=>{
    const a=(i+.5)*2*Math.PI/FOOTPRINT_SEGMENTS;return [Math.cos(a)/rx,Math.sin(a)/ry];
  });
  const vertex=index=>{
    const value=[];
    for(const [,attribute] of attributes)for(let i=0;i<attribute.itemSize;i++)value.push(attribute.getComponent(index,i));
    return value;
  };
  const append=value=>{for(let a=0;a<attributes.length;a++)for(let j=0;j<sizes[a];j++)output[a].push(value[offsets[a]+j]);};
  const count=indices?indices.count:position.count;
  for(let i=0;i<count;i+=3) {
    const triangle=[0,1,2].map(j=>vertex(indices?indices.getX(i+j):i+j));
    if(triangle.every(p=>(p[pos]/rx)**2+(p[pos+2]/ry)**2<=safe)) {
      triangle.forEach(append);continue;
    }
    const xs=triangle.map(p=>p[pos]/rx),ys=triangle.map(p=>p[pos+2]/ry);
    const nearX=Math.max(Math.min(...xs),Math.min(0,Math.max(...xs)));
    const nearY=Math.max(Math.min(...ys),Math.min(0,Math.max(...ys)));
    if(nearX*nearX+nearY*nearY>1+1e-10)continue;
    let polygon=triangle;
    for(const [nx,ny] of planes) {
      if(!polygon.length)break;
      const next=[];
      for(let j=0;j<polygon.length;j++) {
        const a=polygon[j],b=polygon[(j+1)%polygon.length],da=nx*a[pos]+ny*a[pos+2]-apothem,db=nx*b[pos]+ny*b[pos+2]-apothem;
        if(da<=1e-10)next.push(a);
        if((da<0)!==(db<0)) {
          const t=da/(da-db);next.push(a.map((value,k)=>value+(b[k]-value)*t));
        }
      }
      polygon=next;
    }
    polygon=polygon.filter((p,j)=>{const previous=polygon[(j+polygon.length-1)%polygon.length];
      return Math.hypot(p[pos]-previous[pos],p[pos+1]-previous[pos+1],p[pos+2]-previous[pos+2])>1e-10;});
    for(let j=1;j<polygon.length-1;j++) {
      const a=polygon[0],b=polygon[j],c=polygon[j+1],ab=[0,1,2].map(k=>b[pos+k]-a[pos+k]),ac=[0,1,2].map(k=>c[pos+k]-a[pos+k]);
      if(Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])>1e-14)[a,b,c].forEach(append);
    }
  }
  const result=new THREE.BufferGeometry();
  attributes.forEach(([name,attribute],i)=>result.setAttribute(name,new THREE.Float32BufferAttribute(output[i],attribute.itemSize)));
  geometry.dispose();return result;
}

export function clipGroup(group,bounds,width,height) {
  if(!group||!bounds.shape||bounds.shape==='rectangle')return;
  group.traverse(object=>{if(object.isMesh)object.geometry=clipFootprint(object.geometry,bounds,width,height);});
}

// Height at a point on the exact grid triangle, matching server-side terrain clipping.
export function footprintRim(data,positions,width,height) {
  if(!data.bounds.shape||data.bounds.shape==='rectangle')return null;
  const {rows,columns}=data;
  const corners=Array.from({length:FOOTPRINT_SEGMENTS},(_,i)=>{
    const angle=-i*2*Math.PI/FOOTPRINT_SEGMENTS,u=.5+.5*Math.cos(angle),v=.5+.5*Math.sin(angle);
    return [u,v];
  });
  const boundary=[];
  for(let i=0;i<corners.length;i++) {
    const a=corners[i],b=corners[(i+1)%corners.length],ts=[0];
    // Include every crossing of a grid edge or diagonal, so walls meet the clipped terrain without gaps.
    for(const [start,end] of [[a[0]*(columns-1),b[0]*(columns-1)],[a[1]*(rows-1),b[1]*(rows-1)],
      [a[0]*(columns-1)+a[1]*(rows-1),b[0]*(columns-1)+b[1]*(rows-1)]]) {
      if(Math.abs(end-start)<1e-12)continue;
      for(let k=Math.ceil(Math.min(start,end));k<=Math.floor(Math.max(start,end));k++) {
        const t=(k-start)/(end-start);if(t>1e-9&&t<1-1e-9)ts.push(t);
      }
    }
    const ordered=[...new Set(ts)].sort((a,b)=>a-b).filter((t,j,list)=>!j||t-list[j-1]>1e-9);
    for(const t of ordered)boundary.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
  }
  return boundary.map(([u,v])=>{
    const x=u*(columns-1),y=v*(rows-1),column=Math.min(columns-2,Math.floor(x)),row=Math.min(rows-2,Math.floor(y));
    const dx=x-column,dy=y-row,index=row*columns+column;
    const [a,b,c,d]=[index,index+1,index+columns,index+columns+1].map(j=>positions[j*3+1]);
    const elevation=dx+dy<=1?a*(1-dx-dy)+b*dx+c*dy:d*(dx+dy-1)+b*(1-dy)+c*(1-dx);
    return [(u-.5)*width,elevation,(v-.5)*height];
  });
}
