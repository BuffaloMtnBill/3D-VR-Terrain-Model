// Tracked hands drawn the way Meta's system draws them: a rigged hand (the WebXR Input Profiles generic hand, kept
// in static/vendor/hands so the headset needs no internet) with a see-through body and a glowing outline that
// brightens while you pinch. Each joint of the model follows the matching tracked joint every frame.
import * as THREE from 'three';
import {GLTFLoader} from './vendor/GLTFLoader.js';

const MODELS='/static/vendor/hands/';
const JOINTS=['wrist',
  'thumb-metacarpal','thumb-phalanx-proximal','thumb-phalanx-distal','thumb-tip',
  ...['index','middle','ring','pinky'].flatMap(finger=>['metacarpal','phalanx-proximal','phalanx-intermediate','phalanx-distal','tip'].map(part=>`${finger}-finger-${part}`))];
const RIM=new THREE.Color(0xffffff),PINCH=new THREE.Color(0xffc861),FILL=new THREE.Color(0x0e1712);

const loader=new GLTFLoader().setPath(MODELS);

function outlineMaterial() {
  const uniforms={rimColor:{value:RIM.clone()},fillColor:{value:FILL.clone()},fillAlpha:{value:.12},rimWidth:{value:.45}};
  const material=new THREE.MeshStandardMaterial({transparent:true,depthWrite:false,roughness:1,metalness:0});
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);
    shader.fragmentShader='uniform vec3 rimColor; uniform vec3 fillColor; uniform float fillAlpha; uniform float rimWidth;\n'+shader.fragmentShader;
    // Edge-on surfaces (the hand's silhouette) glow; surfaces facing you stay a faint, dark see-through fill.
    shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>',`#include <dithering_fragment>
      float facing = abs(dot(normalize(normal), normalize(vViewPosition)));
      float rim = smoothstep(1.0 - rimWidth, 1.0 - rimWidth * 0.35, 1.0 - facing);
      gl_FragColor = vec4(mix(fillColor, rimColor, rim), mix(fillAlpha, 1.0, rim));`);
  };
  material.customProgramCacheKey=()=>'vr-hand-outline-v2';
  material.userData.uniforms=uniforms;
  return material;
}

// Dresses one three.js XR hand (renderer.xr.getHand) with the model for its handedness, once it connects.
export function createHandSkin(xrHand) {
  let model=null,bones=[],handedness=null,failed=false;
  const material=outlineMaterial();
  function load(side) {
    handedness=side;
    loader.load(`${side}.glb`,gltf=>{
      if(handedness!==side)return;
      if(model)xrHand.remove(model);
      model=gltf.scene.children[0];
      const mesh=model.getObjectByProperty('type','SkinnedMesh');
      mesh.material=material;mesh.frustumCulled=false;mesh.renderOrder=900;
      bones=JOINTS.map(name=>model.getObjectByName(name)||null);
      xrHand.add(model);
    },undefined,()=>{failed=true;});
  }
  xrHand.addEventListener('connected',event=>{
    const side=event.data?.handedness;
    if(event.data?.hand&&(side==='left'||side==='right')&&side!==handedness)load(side);
  });
  return {
    // Call every frame after three.js has updated the joints; returns false until the model is showing.
    update(pinching) {
      if(!model)return false;
      const joints=xrHand.joints||{};
      // A hand that has lost tracking is hidden, not left frozen where it was last seen (the joint dots show instead).
      model.visible=JOINTS.every(name=>joints[name]?.visible);
      if(!model.visible)return false;
      bones.forEach((bone,index)=>{
        const joint=joints[JOINTS[index]];
        if(bone&&joint?.visible){bone.position.copy(joint.position);bone.quaternion.copy(joint.quaternion);}
      });
      material.userData.uniforms.rimColor.value.lerp(pinching?PINCH:RIM,.35);
      // A pinch thickens the outline as well as warming it, like the system's pinch feedback.
      material.userData.uniforms.rimWidth.value+=((pinching?.62:.45)-material.userData.uniforms.rimWidth.value)*.35;
      return true;
    },
    get ready(){return Boolean(model&&model.visible);},get failed(){return failed;},
  };
}
