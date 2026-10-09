/* Profile modes beyond the straight slice: a ridgeline between two points, or the skyline seen from a viewpoint.
 * Points are latitude/longitude, picked on the map and dragged to adjust; the server (profiles.py) finds the
 * highest way between the points, or casts rays from the viewpoint across the generated terrain. */
import {locationFraction,sampleLocation} from './selection-geometry.js';

const $=id=>document.getElementById(id);
const COMPASS=['N','NE','E','SE','S','SW','W','NW'];
const compass=degrees=>COMPASS[Math.round((((degrees%360)+360)%360)/45)%8];
const storageKey='terrain-profile-mode';
// Viewpoint ridgeline: each ridge's line, nearest brightest.
const RIDGE_LINES=['#ffe3a3','#f0c27a','#cfa76f','#a99a78','#8d927f','#767f72','#646c62'];
const BAND_COLORS=['#2f4a36','#4f6d4f','#7d9673','#aebd9e','#d8dfc8'];  // nearest (darkest) to farthest (palest)

export function createProfileModes(ctx) {
  // Viewpoint ridgeline shares the viewpoint's controls and request, with ridge detection always on.
  const viewing=()=>mode==='viewpoint'||mode==='viewridge',serverMode=()=>mode==='viewridge'?'viewpoint':mode;
  let mode='slice',picking=null,result=null,error=null,request=0,timer=null,overlay=null;
  const points={start:null,end:null,point:null};
  const markers={};

  function settings() {
    return {mode,start:points.start,end:points.end,point:points.point,bearing:Number($('view-bearing').value),
      fov:Number($('view-fov').value),eye_m:Number($('view-eye').value),bands:Number($('view-bands').value),
      min_radius_m:Number($('view-radius').value),ridges:mode==='viewridge'||$('view-ridges').checked,
      // Detected ridgelines (nearest first) once drawn, for the silhouette page's layers and their thickness.
      found:result?.mode==='viewpoint'?result.ridges:[]};
  }
  function save() {try{localStorage.setItem(storageKey,JSON.stringify(settings()));}catch{/* Optional persistence. */}}
  function restore() {
    let saved=null;try{saved=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{saved=null;}
    if(!saved)return;
    const pair=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)?value:null;
    points.start=pair(saved.start);points.end=pair(saved.end);points.point=pair(saved.point);
    $('view-ridges').checked=saved.ridges===true;
    for(const [id,value] of [['view-bearing',saved.bearing],['view-fov',saved.fov],['view-eye',saved.eye_m],['view-bands',saved.bands],['view-radius',saved.min_radius_m]])
      if(Number.isFinite(value)&&[...($(id).options||[{value:String(value)}])].some(option=>Number(option.value)===value||$(id).type==='range'))$(id).value=value;
    if(['slice','ridgeline','viewpoint','viewridge'].includes(saved.mode))mode=saved.mode;
  }
  function status(text,isError=false) {
    $('profile-mode-status').hidden=!text;$('profile-mode-status').textContent=text||'';$('profile-mode-status').classList.toggle('error',isError);
  }
  function ready() {return mode==='ridgeline'?Boolean(points.start&&points.end):viewing()?Boolean(points.point):false;}

  // ---------- map: markers, the ridgeline path, and the view wedge ----------
  function marker(key,label,className='') {
    const map=ctx.map;if(!map||!points[key]){markers[key]?.remove();delete markers[key];return;}
    if(!markers[key]) {
      markers[key]=L.marker(points[key],{draggable:true,keyboard:true,title:label,
        icon:L.divIcon({className:'',html:`<div class="profile-marker ${className}">${label}</div>`,iconSize:[22,22],iconAnchor:[11,11]})});
      markers[key].on('dragend',()=>{const {lat,lng}=markers[key].getLatLng();points[key]=[lat,lng];save();schedule(0);});
    }
    markers[key].setLatLng(points[key]);
    if(!map.hasLayer(markers[key]))markers[key].addTo(map);
  }
  function drawMap() {
    const map=ctx.map;if(!map)return;
    overlay?.remove();overlay=null;
    const ridge=mode==='ridgeline',view=viewing();
    if(ridge){marker('start','A');marker('end','B');}else{markers.start?.remove();markers.end?.remove();}
    if(view)marker('point','◉','viewpoint');else markers.point?.remove();
    const bounds=ctx.state.data?.bounds;
    if(!bounds||!result||result.mode!==serverMode())return;
    const at=([u,v])=>{const p=sampleLocation(bounds,u,v);return [p.lat,p.lng];};
    overlay=L.layerGroup().addTo(map);
    if(ridge)L.polyline(result.path.map(at),{color:'#ffb354',weight:3,opacity:.95,interactive:false}).addTo(overlay);
    else {
      const origin=at(result.point);
      L.polygon([origin,...result.rays.map(at)],{color:'#ffb354',weight:1.5,dashArray:'4 4',fillColor:'#ffb354',fillOpacity:mode==='viewridge'?.05:.12,interactive:false}).addTo(overlay);
      // Where each ridgeline seen from the viewpoint runs on the ground.
      if(mode==='viewridge')result.ridges.forEach((found,index)=>found.paths.forEach(path=>
        L.polyline(path.map(at),{color:RIDGE_LINES[index%RIDGE_LINES.length],weight:3,opacity:.95,interactive:false}).addTo(overlay)));
    }
  }

  // ---------- picking on the map ----------
  function setPicking(value) {
    picking=value;
    $('profile-pick-ridge').setAttribute('aria-pressed',String(picking==='ridgeline'));
    $('profile-pick-view').setAttribute('aria-pressed',String(picking==='viewpoint'));
    ctx.map?.getContainer().classList.toggle('aligning-profile',Boolean(picking));
    if(picking==='ridgeline')status('Click the first ridgeline point on the map, then the second. Drag the markers to adjust.');
    else if(picking==='viewpoint')status('Click where you stand on the map. Drag the marker to adjust; set the direction with Facing.');
  }
  function mapClick(event) {
    const point=[event.latlng.lat,event.latlng.lng];
    // In the viewpoint modes a click on the map always moves the viewpoint; ridgeline points need Pick two points.
    if(!picking&&viewing()){points.point=point;save();drawMap();schedule(0);return;}
    if(!picking)return;
    if(picking==='viewpoint'){points.point=point;setPicking(null);}
    else if(!points._first){points._first=true;points.start=point;points.end=null;status('Now click the second ridgeline point.');}
    else {delete points._first;points.end=point;setPicking(null);}
    save();drawMap();schedule(0);
  }

  function repick() {
    if(mode==='ridgeline'){points.start=points.end=null;delete points._first;}else points.point=null;
    result=null;error=null;save();drawMap();ctx.redraw();setPicking(viewing()?'viewpoint':mode);
    status(`The ${mode==='ridgeline'?'ridgeline points were':'viewpoint was'} outside this area. Click on the map to place ${mode==='ridgeline'?'two new points':'it again'}.`,true);
  }

  // ---------- fetching ----------
  function schedule(delay=250) {clearTimeout(timer);timer=setTimeout(fetchProfile,delay);}
  async function fetchProfile() {
    drawMap();
    if(mode==='slice')return;
    if(!ready()){result=null;error=null;ctx.redraw();if(!picking)status(mode==='viewridge'?'Pick a viewpoint on the map to see the ridgelines visible from it.':mode==='ridgeline'?'Pick two points on the map to follow the highest ground between them.':'Pick a viewpoint on the map to see its skyline.');return;}
    if(!ctx.state.id){status('Generate the terrain to draw this profile.');return;}
    // Points kept from another area (after moving the frame and generating) can't be used here: pick new ones.
    const bounds=ctx.state.data?.bounds,outside=point=>{const {u,v}=locationFraction(bounds,point[0],point[1]);return !(u>=-1e-6&&u<=1+1e-6&&v>=-1e-6&&v<=1+1e-6);};
    if(bounds&&(mode==='ridgeline'?[points.start,points.end]:[points.point]).some(outside)){repick();return;}
    const token=++request,body=mode==='ridgeline'?{mode,start:points.start,end:points.end}:{mode:'viewpoint',point:points.point,bearing:Number($('view-bearing').value),fov:Number($('view-fov').value),eye_m:Number($('view-eye').value),
      bands:Number($('view-bands').value),min_radius_m:Number($('view-radius').value),ridges:mode==='viewridge'||$('view-ridges').checked};
    // Distance bands go up to 5; detected ridges up to 7.
    if(!body.ridges&&body.bands>5)body.bands=5;
    try {
      const data=await ctx.api(`/api/profile/${ctx.state.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(token!==request)return;
      result=data;error=null;
      const u=ctx.units();
      status(mode==='ridgeline'
        ?`${ctx.number(data.length_m/u.distance,2)} ${u.distanceLabel} along the high ground · highest ${ctx.number(data.highest_m*u.height)} ${u.label} · lowest ${ctx.number(data.lowest_m*u.height)} ${u.label}`
        :data.ridges.length
          ?`${data.ridges.length} ridge${data.ridges.length>1?'s':''} at ${data.ridges.map(ridge=>ctx.number(ridge.distance_m/u.distance,ridge.distance_m<u.distance?2:1)).join(', ')} ${u.distanceLabel}${data.min_radius_m?` beyond ${ctx.number(data.min_radius_m/u.distance,2)} ${u.distanceLabel}`:''}, nearest first. Closer ridges print thicker in the layered designs.`
          :`Seeing ${ctx.number(data.farthest_m/u.distance,1)} ${u.distanceLabel} to the frame's edge from ${ctx.number(data.eye_elevation_m*u.height)} ${u.label}. Generate a larger area to include more distant mountains.`);
    } catch(problem) {
      if(token!==request)return;
      result=null;error=problem.message;
      if(/outside the generated area/.test(problem.message))repick();
      else status(problem.message,true);
    }
    drawMap();ctx.redraw();ctx.changed?.();
  }

  // ---------- chart ----------
  function draw(canvas,pointer) {
    const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
    const g=canvas.getContext('2d');g.scale(dpr,dpr);
    const width=rect.width,height=rect.height,left=49,right=16,top=16,bottom=25,chartWidth=width-left-right,chartHeight=height-top-bottom;
    g.font='9px "Segoe UI", Arial';
    if(!result||result.mode!==serverMode()) {
      g.fillStyle='#b4b39a';g.textAlign='center';
      g.fillText(error||(mode==='viewridge'?'Pick a viewpoint on the map: the chart shows each ridgeline visible from it.':mode==='ridgeline'?'Pick two points on the map: the profile follows the highest ground between them.':'Pick a viewpoint on the map: the profile is the skyline seen from it.'),width/2,height/2);
      $('profile-tooltip').hidden=true;return;
    }
    const u=ctx.units(),ridge=mode==='ridgeline';
    $('profile-units-note').textContent=ridge?`Heights in ${u.name} above sea level`:'Degrees above the horizontal, by compass bearing';
    const xs=ridge?result.distances:result.azimuths,ys=ridge?result.heights:result.angles;
    const lines=mode==='viewridge',layers=ridge?[]:result.bands;
    const all=[...ys,...layers.flat().filter(value=>value>-90)];
    const minimum=Math.min(...all),maximum=Math.max(...all),range=Math.max(maximum-minimum,ridge?10:1);
    const low=minimum-range*.14,high=maximum+range*.16,x0=xs[0],x1=xs[xs.length-1];
    const px=value=>left+(value-x0)/(x1-x0)*chartWidth,py=value=>top+(high-value)/(high-low)*chartHeight;
    for(let index=0;index<=3;index++) {
      const y=top+index/3*chartHeight,value=high-index/3*(high-low);
      g.strokeStyle='#3b4835';g.setLineDash([3,4]);g.beginPath();g.moveTo(left,y);g.lineTo(width-right,y);g.stroke();g.setLineDash([]);
      g.fillStyle='#b4b39a';g.textAlign='right';g.fillText(ridge?ctx.number(value*u.height):`${ctx.number(value,1)}°`,left-10,y+3);
    }
    const area=(values,fill)=>{
      g.beginPath();g.moveTo(px(x0),height-bottom);values.forEach((value,index)=>g.lineTo(px(xs[index]),py(Math.max(value,low))));
      g.lineTo(px(x1),height-bottom);g.closePath();g.fillStyle=fill;g.fill();
    };
    if(lines) {  // each ridgeline as its own line over the faint skyline, labeled with its distance
      const gradient=g.createLinearGradient(0,top,0,height-bottom);gradient.addColorStop(0,'#c3c87d30');gradient.addColorStop(1,'#58704708');area(ys,gradient);
      const placed=[];
      layers.forEach((values,index)=>{
        g.beginPath();let drawing=false;
        values.forEach((value,at)=>{if(value<=-90){drawing=false;return;}const x=px(xs[at]),y=py(value);drawing?g.lineTo(x,y):g.moveTo(x,y);drawing=true;});
        g.strokeStyle=RIDGE_LINES[index%RIDGE_LINES.length];g.lineWidth=index?1.4:2;g.stroke();g.lineWidth=1;
        // Each label sits over its ridge's highest point, which spreads them across the view.
        const peak=values.reduce((best,value,at)=>value>-90&&(best<0||value>values[best])?at:best,-1);
        if(peak>=0) {
          const x=Math.max(left+20,Math.min(px(xs[peak]),width-right-20));let y=py(values[peak])-5;
          while(placed.some(label=>Math.abs(label.x-x)<44&&Math.abs(label.y-y)<10))y-=11;  // stack labels that would overlap
          placed.push({x,y});g.fillStyle=RIDGE_LINES[index%RIDGE_LINES.length];g.textAlign='center';
          g.fillText(`${ctx.number(result.ridges[index].distance_m/u.distance,1)} ${u.distanceLabel}`,x,Math.max(y,top+8));
        }
      });
    }
    else if(layers.length) for(let index=layers.length-1;index>=0;index--)area(layers[index],BAND_COLORS[Math.round(index*(BAND_COLORS.length-1)/Math.max(layers.length-1,1))]);
    else {const gradient=g.createLinearGradient(0,top,0,height-bottom);gradient.addColorStop(0,'#c3c87d70');gradient.addColorStop(1,'#58704715');area(ys,gradient);}
    if(!lines) {
      g.beginPath();ys.forEach((value,index)=>index?g.lineTo(px(xs[index]),py(value)):g.moveTo(px(xs[index]),py(value)));
      g.strokeStyle='#e6d29b';g.lineWidth=1.8;g.stroke();g.lineWidth=1;
    }
    g.fillStyle='#b4b39a';
    if(ridge) {
      g.textAlign='left';g.fillText(`A · 0 ${u.distanceLabel}`,left,height-6);
      g.textAlign='right';g.fillText(`${ctx.number(result.length_m/u.distance,1)} ${u.distanceLabel} · B`,width-right,height-6);
      $('profile-distance').textContent=`${ctx.number(result.length_m/u.distance,2)} ${u.distanceLabel} along the ridgeline`;
    } else {
      g.textAlign='center';
      const step=(x1-x0)>180?45:(x1-x0)>60?15:5;
      for(let bearing=Math.ceil(x0/step)*step;bearing<=x1;bearing+=step)
        g.fillText(bearing%45===0?compass(bearing):`${((bearing%360)+360)%360}°`,px(bearing),height-6);
      $('profile-distance').textContent=`${ctx.number(result.fov,0)}° view facing ${compass(result.bearing)}`;
    }
    if(pointer===null){$('profile-tooltip').hidden=true;return;}
    const fraction=Math.max(0,Math.min(1,(pointer-left)/chartWidth)),index=Math.round(fraction*(xs.length-1)),value=ys[index];
    const x=px(xs[index]),y=py(value);
    g.strokeStyle='#d4b47d';g.setLineDash([3,3]);g.beginPath();g.moveTo(x,top);g.lineTo(x,height-bottom);g.stroke();g.setLineDash([]);
    g.fillStyle='#ffedb9';g.beginPath();g.arc(x,y,3,0,Math.PI*2);g.fill();
    const bearing=((xs[index]%360)+360)%360;
    $('profile-tooltip').textContent=ridge
      ?`${ctx.number(value*u.height,1)} ${u.label} ASL · ${ctx.number(xs[index]/u.distance,2)} ${u.distanceLabel} from A`
      :`${ctx.number(bearing,0)}° ${compass(bearing)} · ${ctx.number(value,1)}° up · ridge ${ctx.number(result.skyline_m[index]/u.distance,1)} ${u.distanceLabel} away`
        +(result.ridges.length?` · ${result.ridges.length} ridges`:'');
    $('profile-tooltip').style.left=`${Math.max(2,Math.min(x-60,width-185))}px`;$('profile-tooltip').hidden=false;
  }

  function setMode(value) {
    mode=value;$('profile-mode').value=mode;
    $('profile-slice-controls').hidden=mode!=='slice';$('profile-ridge-controls').hidden=mode!=='ridgeline';$('profile-view-controls').hidden=!viewing();$('view-ridges-label').hidden=mode==='viewridge';
    if(mode==='slice'){setPicking(null);status('');$('profile-units-note').textContent=`Heights in ${ctx.units().name} above sea level`;}
    else if(!ready())setPicking(viewing()?'viewpoint':mode);
    save();ctx.sliceVisible(mode==='slice');drawMap();schedule(0);ctx.redraw();ctx.changed?.();
  }
  function bearingLabel() {const value=Number($('view-bearing').value);$('view-bearing-value').textContent=`${value}° ${compass(value)}`;}

  restore();
  $('profile-mode').addEventListener('change',event=>setMode(event.target.value));
  $('profile-pick-ridge').addEventListener('click',()=>{delete points._first;setPicking(picking==='ridgeline'?null:'ridgeline');});
  $('profile-pick-view').addEventListener('click',()=>setPicking(picking==='viewpoint'?null:'viewpoint'));
  $('view-bearing').addEventListener('input',()=>{bearingLabel();save();schedule();});
  for(const id of ['view-fov','view-eye','view-bands','view-radius','view-ridges'])$(id).addEventListener('change',()=>{save();schedule(0);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&picking){delete points._first;setPicking(null);status('');}});
  bearingLabel();

  return {
    attach(map){map.on('click',mapClick);setMode(mode);},
    active(){return mode!=='slice';},
    draw,
    terrainChanged(){result=null;schedule(0);},
    unitsChanged(){if(result)fetchProfile();},
    // For the silhouette page: what the geography page's profile currently shows.
    get settings(){return settings();},
    get ready(){return ready()&&Boolean(result)&&result.mode===serverMode();},
  };
}
