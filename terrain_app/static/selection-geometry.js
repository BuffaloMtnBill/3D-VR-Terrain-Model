/* The same Mercator rotation used by the map frame and Python elevation sampler. */
export const rotationAngle = bounds => bounds.rotation_deg || 0;
export const normalizeAngle = angle => ((angle+180)%360+360)%360-180;

export function mercatorPixel(lng,lat,zoom=0) {
  const size=256*2**zoom,radians=lat*Math.PI/180;
  return {x:(lng+180)/360*size,y:(1-Math.asinh(Math.tan(radians))/Math.PI)/2*size};
}

export function sampleLocation(bounds,u,v) {
  const angle=rotationAngle(bounds)*Math.PI/180;
  if(!angle)return {lat:bounds.north+(bounds.south-bounds.north)*v,lng:bounds.west+(bounds.east-bounds.west)*u};
  const nw=mercatorPixel(bounds.west,bounds.north),se=mercatorPixel(bounds.east,bounds.south);
  const dx=(u-.5)*(se.x-nw.x),dy=(v-.5)*(se.y-nw.y);
  const x=(nw.x+se.x)/2+dx*Math.cos(angle)-dy*Math.sin(angle);
  const y=(nw.y+se.y)/2+dx*Math.sin(angle)+dy*Math.cos(angle);
  return {lng:x/256*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/256)))*180/Math.PI};
}

export const selectionCorners = bounds => [[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>sampleLocation(bounds,u,v));

export function geographicExtent(bounds) {
  const corners=selectionCorners(bounds);
  return {north:Math.max(...corners.map(p=>p.lat)),south:Math.min(...corners.map(p=>p.lat)),
    west:Math.min(...corners.map(p=>p.lng)),east:Math.max(...corners.map(p=>p.lng))};
}
