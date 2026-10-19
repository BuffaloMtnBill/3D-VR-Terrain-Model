/* Pointing a hand's (or controller's) laser at a menu region in the IWER emulator, for the VR browser tests: the device
 * is posed so that its pointing ray, whatever its offset from the device, runs from 60 cm in front of the region (toward
 * your eyes) straight at it; then the test waits until VR reports the laser on that region.
 */
const poseAt=(page,kind,hand,id)=>page.evaluate(async([kind,hand,id])=>{
  const THREE=await import('three'),vr=(await import('/static/vr.js')).currentVR();
  const point=vr.watchPoint(id);if(!point)return false;
  const device=kind==='hand'?window.xrDevice.hands[hand]:window.xrDevice.controllers[hand];
  const p=device.position.vec3,q=device.quaternion.quat,one=new THREE.Vector3(1,1,1);
  const pose=new THREE.Matrix4().compose(new THREE.Vector3(p[0],p[1],p[2]),new THREE.Quaternion(q[0],q[1],q[2],q[3]),one);
  const ray=new THREE.Matrix4().fromArray(vr.state.hands[hand==='left'?0:1].ray);
  const offset=pose.invert().multiply(ray);   // the ray in the device's own frame
  const target=new THREE.Vector3(...point),head=new THREE.Vector3(...window.xrDevice.position.vec3);
  const origin=target.clone().add(head.sub(target).normalize().multiplyScalar(.6));
  const turn=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),target.clone().sub(origin).normalize());
  const wanted=new THREE.Matrix4().compose(origin,turn,one).multiply(offset.invert());
  const position=new THREE.Vector3(),rotation=new THREE.Quaternion();wanted.decompose(position,rotation,new THREE.Vector3());
  device.position.set(position.x,position.y,position.z);device.quaternion.set(rotation.x,rotation.y,rotation.z,rotation.w);
  return true;
},[kind,hand,id]);

async function aim(page,kind,hand,id) {
  if(!await poseAt(page,kind,hand,id))throw new Error(`${id} is not on show`);
  const index=hand==='left'?0:1;
  for(let attempt=1;attempt<=40;attempt++) {
    await page.waitForTimeout(60);
    if(await page.evaluate(async i=>(await import('/static/vr.js')).currentVR().state.hands[i].over,index)===id)return;
    if(attempt%10===0)await poseAt(page,kind,hand,id);   // the ray is read a frame late: aim again from the new pose
  }
  throw new Error(`The ${hand} laser never reached ${id}`);
}
module.exports={aim};
