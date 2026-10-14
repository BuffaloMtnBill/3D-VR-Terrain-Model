import * as THREE from 'three';

export const coverLabels={dark_foliage:'Dark foliage',light_foliage:'Light foliage',dirt:'Dirt',snow:'Snow',water:'Water',buildings:'Buildings'};

export function paintSurface(geometry,palette,cover,grid=null) {
  // Separate triangle corners so adjacent categories never interpolate colors.
  const result=geometry.index?geometry.toNonIndexed():geometry;
  if(result!==geometry)geometry.dispose();
  const colors=Object.keys(coverLabels).map(name=>new THREE.Color(palette[name]));
  const count=result.getAttribute('position').count,values=new Float32Array(count*3);
  const classes=cover?.face_classes;
  const uv=result.getAttribute('uv');
  for(let face=0;face<count/3;face++) {
    let original=face;
    if(grid&&uv) {
      const corners=[face*3,face*3+1,face*3+2];
      const x=corners.reduce((sum,i)=>sum+uv.getX(i),0)/3*(grid.columns-1),y=(1-corners.reduce((sum,i)=>sum+uv.getY(i),0)/3)*(grid.rows-1);
      const column=Math.min(grid.columns-2,Math.max(0,Math.floor(x))),row=Math.min(grid.rows-2,Math.max(0,Math.floor(y)));
      original=(row*(grid.columns-1)+column)*2+(x-column+y-row>1?1:0);
    }
    const color=colors[classes?.[original]??2];
    for(let corner=0;corner<3;corner++)color.toArray(values,(face*3+corner)*3);
  }
  result.setAttribute('color',new THREE.BufferAttribute(values,3));
  return result;
}
