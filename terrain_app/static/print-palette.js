import * as THREE from 'three';

export const coverLabels={dark_foliage:'Dark foliage',light_foliage:'Light foliage',dirt:'Dirt',snow:'Snow',water:'Water',buildings:'Buildings'};

export function paintSurface(geometry,palette,cover) {
  // Separate triangle corners so adjacent categories never interpolate colors.
  const result=geometry.index?geometry.toNonIndexed():geometry;
  if(result!==geometry)geometry.dispose();
  const colors=Object.keys(coverLabels).map(name=>new THREE.Color(palette[name]));
  const count=result.getAttribute('position').count,values=new Float32Array(count*3);
  const classes=cover?.face_classes;
  for(let face=0;face<count/3;face++) {
    const color=colors[classes?.[face]??2];
    for(let corner=0;corner<3;corner++)color.toArray(values,(face*3+corner)*3);
  }
  result.setAttribute('color',new THREE.BufferAttribute(values,3));
  return result;
}
