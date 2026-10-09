/* A small rotating 3D preview (a turntable) for the design pages' Start from cards: one WebGL renderer per preview, drawn only
 * while active (its dialog open) and on screen. Callers fill its group with show(); the camera is fitted to each new model.
 * About one turn per 20 s; dragging orbits it and rotation resumes after a few idle seconds; no rotation with reduced motion.
 */
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';

const IDLE_MS=3000;
const reducedMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Meshes marked userData.sharedGeometry borrow another view's geometry: only their materials are this preview's to dispose.
export function disposeChildren(group) {
  for(const child of [...group.children]) {
    child.traverse(object=>{
      if(!object.userData.sharedGeometry)object.geometry?.dispose();
      (Array.isArray(object.material)?object.material:[object.material]).forEach(material=>material?.dispose());
    });
    group.remove(child);
  }
}

// elevation: the camera's angle above the horizon (degrees): low for upright pieces, higher for a terrain model.
export function createTurntable(container,{label='Preview: drag to orbit',elevation=24,configure=null}={}) {
  let renderer=null,active=false,visible=false,idle=null,dirty=true;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(30,1,.1,1000),group=new THREE.Group(),clock=new THREE.Clock();
  scene.add(group);
  let controls=null;
  function setup() {
    if(renderer!==null)return Boolean(renderer);
    try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}
    catch{renderer=false;container.dataset.empty='The preview needs WebGL.';return false;}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label',label);container.prepend(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xf0dfbb,0x566747,2.2));
    const sun=new THREE.DirectionalLight(0xffecc8,2.2);sun.position.set(-.4,1,1.2);scene.add(sun);
    configure?.(renderer,scene);
    controls=new OrbitControls(camera,renderer.domElement);
    controls.enableDamping=true;controls.enableZoom=false;controls.enablePan=false;controls.autoRotateSpeed=3;  // 60 s / 3 = one turn per 20 s
    controls.autoRotate=!reducedMotion();
    renderer.domElement.style.touchAction='pan-y';  // OrbitControls sets none; a vertical swipe should still scroll the page
    controls.addEventListener('start',()=>{clearTimeout(idle);controls.autoRotate=false;});
    controls.addEventListener('end',()=>{clearTimeout(idle);idle=setTimeout(()=>{controls.autoRotate=!reducedMotion();},IDLE_MS);});
    controls.addEventListener('change',()=>{dirty=true;});
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change',()=>{controls.autoRotate=!reducedMotion();dirty=true;});
    new ResizeObserver(resize).observe(container);
    new IntersectionObserver(entries=>{visible=entries.some(entry=>entry.isIntersecting);loop();}).observe(container);
    resize();
    return true;
  }
  function resize() {
    const width=container.clientWidth,height=container.clientHeight;
    if(!renderer||!width||!height)return;
    renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();dirty=true;
  }
  function frame() {
    const moved=controls.update(Math.min(clock.getDelta(),.1));
    if(moved||dirty){renderer.render(scene,camera);dirty=false;}
  }
  // Renders only while the dialog is open and the preview is on screen.
  function loop() {
    if(!renderer)return;
    const run=active&&visible;
    if(run)clock.getDelta();
    renderer.setAnimationLoop(run?frame:null);
  }
  // A raised three-quarter view far enough back that the model fits however it turns about its vertical axis. Its footprint
  // sweeps a circle (radius r) and it stands h tall: across it spans r (nearer points larger); up, its near edge (closer, so larger) reaches
  // b = h/2·cos e + r·sin e below the middle and its far edge as far above. The aim drops so both edges get equal room.
  function fit() {
    const box=new THREE.Box3().setFromObject(group);
    if(box.isEmpty())return;
    const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),r=Math.hypot(size.x,size.z)/2;
    const e=THREE.MathUtils.degToRad(elevation),vertical=THREE.MathUtils.degToRad(camera.fov/2),across=Math.atan(Math.tan(vertical)*camera.aspect);
    const b=size.y/2*Math.cos(e)+r*Math.sin(e),c=r*Math.cos(e),below=d=>Math.atan(b/(d-c)),above=d=>Math.atan(b/(d+c));
    let low=c+1e-6,high=c+b/Math.tan(vertical)*4+1;
    for(let step=0;step<40;step++){const middle=(low+high)/2;if(below(middle)+above(middle)>vertical*2)low=middle;else high=middle;}
    // Across: a footprint point at angle θ needs d ≥ r·(sin θ/tan(across) + cos θ·cos e); the largest over θ is the root below.
    const distance=Math.max(high,r*Math.hypot(1/Math.tan(across),Math.cos(e)))*1.05;
    center.y-=distance*Math.tan((below(distance)-above(distance))/2)/Math.cos(e);
    camera.near=distance/100;camera.far=distance*10;camera.updateProjectionMatrix();
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(Math.cos(e)*Math.SQRT1_2,Math.sin(e),Math.cos(e)*Math.SQRT1_2).multiplyScalar(distance));
    controls.update();dirty=true;
  }
  return {
    // Replaces the model: disposes the old one, lets build() fill the group, and fits the camera to it.
    show(build) {
      if(!setup())return false;
      resize();disposeChildren(group);group.position.set(0,0,0);group.rotation.set(0,0,0);group.scale.setScalar(1);
      build(group);fit();return true;
    },
    clear(){disposeChildren(group);dirty=true;},
    setActive(on) {
      active=on;
      if(!on){clearTimeout(idle);disposeChildren(group);}
      if(on&&setup())resize();
      loop();
    },
    get canvas(){return renderer?renderer.domElement:null;},
  };
}
