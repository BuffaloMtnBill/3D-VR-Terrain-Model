/* Silhouette design page: elevation-profile slices (or the uploaded route's profile) as flat pieces, with a caption and a
 * mount, or as a design from a preset: glow-lamp panels with a tab for the lamp base's slot, shadow-box layers in spacer
 * combs, and race profiles with ticks and medal pegs. The server lays the design out (POST /api/silhouette/<id>/outline)
 * and builds its files; this module draws it to scale, keeps the slice in step with the geography selection page's
 * profile controls, and remembers settings per framed area.
 * app.js hands over a small context: state, route, options(), notify, download, units, printColors.
 */
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';

const $=id=>document.getElementById(id);
const STORE_PREFIX='terrain-silhouette:v1:';
const SVG_NS='http://www.w3.org/2000/svg';
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const number=(value,decimals=1)=>Number(value).toLocaleString(undefined,{maximumFractionDigits:decimals});
const isHex=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const round=(value,decimals=2)=>Math.round(value*10**decimals)/10**decimals;
// Presets come from terrain_app/data/silhouette-presets.json, rendered into the page so the server's tests read the same file.
const PRESETS=(()=>{try{return JSON.parse($('silhouette-presets').textContent);}catch{return {groups:[],presets:{custom:{name:'Custom',fields:[],settings:{}}}};}})();
const COMB_FLOOR=3,STAND_DROP=2;
// Numeric settings: input id, limits. Choices: select id, allowed values. Checks: checkbox ids.
const NUMBERS={width_mm:['silhouette-width',40,400],vertical_scale:['silhouette-vertical',.5,100],base_mm:['silhouette-base',2,40],
  thickness_mm:['silhouette-thickness',1.2,30],smoothing:['silhouette-smoothing',0,100],text_size:['silhouette-text-size',2,30],
  text_depth:['silhouette-text-depth',.2,5],hole_diameter:['silhouette-hole',2,10],
  slot_width:['silhouette-slot-width',1,20],slot_length:['silhouette-slot-length',20,400],slot_depth:['silhouette-slot-depth',2,30],
  slot_clearance:['silhouette-slot-clearance',0,1],box_width:['silhouette-box-width',41,500],box_height:['silhouette-box-height',20,400],
  box_depth:['silhouette-box-depth',8,200],layer_count:['silhouette-layer-count',1,7],layer_step:['silhouette-layer-step',0,20],
  layer_spacing:['silhouette-layer-spacing',2,30],building_corridor_m:['silhouette-corridor',5,200],tick_every:['silhouette-tick-every',.1,100],
  peg_count:['silhouette-peg-count',0,8],peg_diameter:['silhouette-peg-diameter',3,12],peg_length:['silhouette-peg-length',5,40],
  pin_diameter:['silhouette-pin-diameter',1,4],pin_depth:['silhouette-pin-depth',3,30],photo_gap:['silhouette-photo-gap',.3,5],
  led_width:['silhouette-led-width',2,20],led_depth:['silhouette-led-depth',.5,5]};
const INTEGERS=new Set(['layer_count','peg_count']);
const CHOICES={source:['silhouette-source',['true','shaped','route','ridgeline','viewpoint']],text_style:['silhouette-text-style',['engrave','emboss','stencil']],
  text_align:['silhouette-text-align',['left','center','right']],mount:['silhouette-mount',['none','stand','holes','keyholes']]};
const CHECKS={mirror:'silhouette-mirror',include_buildings:'silhouette-buildings',ticks:'silhouette-ticks',start_finish:'silhouette-start-finish',
  summit_pin:'silhouette-pin',photo_slot:'silhouette-photo',led_channel:'silhouette-led'};
const COLORS={text_color:'silhouette-text-color',body_color:'silhouette-body-color'};
const DEFAULTS={width_mm:180,vertical_scale:2,base_mm:8,thickness_mm:4,smoothing:0,text_size:5,text_depth:.8,hole_diameter:4,source:'true',
  text_style:'engrave',text_align:'center',mount:'none',mirror:false,trim:[0,100],text:'',text_color:'#f0ead6',body_color:'#234e40',
  preset:'custom',fit:'none',slot_width:4,slot_length:160,slot_depth:8,slot_clearance:.2,box_width:200,box_height:150,box_depth:40,
  layer_count:1,layer_positions:[],layer_step:6,layer_spacing:6,include_buildings:false,building_corridor_m:30,ticks:false,tick_every:1,
  start_finish:false,peg_count:0,peg_diameter:6,peg_length:20,summit_pin:false,pin_diameter:1.8,pin_depth:10,photo_slot:false,photo_gap:1,
  led_channel:false,led_width:5,led_depth:2,race_kind:'running',finish_time:''};
// What a preset decides: choosing another preset (or Custom) resets these before applying its own. Slice, caption, colors, and the
// lamp and box measurements are kept.
const PRESET_OWNED=['fit','layer_count','layer_positions','layer_step','layer_spacing','include_buildings','ticks','tick_every','start_finish',
  'peg_count','summit_pin','photo_slot','led_channel','mount','text_style','text_depth','text_size','thickness_mm','base_mm'];
const CLIENT_ONLY=['layer_count','layer_positions','layer_step','race_kind','finish_time'];
const MOUNT_HINTS={none:'',stand:'Two feet print beside the piece, each with a slot the thickness plus 0.2 mm wide; the piece stands upright in them.',
  holes:'Two holes through the base, for nails or screws.',keyholes:'Slide the piece down onto two screw heads. Keyholes need about 14 mm of height at each end.'};

async function errorMessage(response) {
  try { return (await response.json()).error||`Request failed (${response.status}).`; }
  catch { return `Request failed (${response.status}).`; }
}
const postJSON=(url,body,signal)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
const filenameOf=(response,fallback)=>response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||fallback;
function hash(text) {
  let value=0x811c9dc5;
  for(let index=0;index<text.length;index++){value^=text.charCodeAt(index);value=Math.imul(value,0x01000193);}
  return (value>>>0).toString(16).padStart(8,'0');
}
function svg(tag,attributes={},parent=null) {
  const element=document.createElementNS(SVG_NS,tag);
  for(const [name,value] of Object.entries(attributes))element.setAttribute(name,value);
  parent?.append(element);return element;
}
// Polygons arrive in mm with y up; the SVG draws y down, so every y is negated.
const ringPath=ring=>ring.map(([x,y],index)=>`${index?'L':'M'}${x} ${-y}`).join('')+'Z';
const polygonPath=polygon=>[polygon.outer,...polygon.holes].map(ringPath).join('');
function mix(a,b,t) {
  const channel=(hex,index)=>parseInt(hex.slice(1+index*2,3+index*2),16);
  return '#'+[0,1,2].map(index=>Math.round(channel(a,index)*(1-t)+channel(b,index)*t).toString(16).padStart(2,'0')).join('');
}
const longDate=date=>new Date(`${date}T12:00:00`).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});

export function createSilhouette(ctx) {
  const dialog=$('silhouette');
  let settings=structuredClone(DEFAULTS),storeKey=null,result=null,timer=null,request=null,view='front',busy=false,three=null;
  const preset=()=>PRESETS.presets[settings.preset]||PRESETS.presets.custom;
  const layered=()=>settings.fit!=='none'&&settings.layer_count>1;

  // ---------- settings: per framed area, like the 3D model design page's projects ----------
  function areaKey() {
    const b=ctx.state.data.bounds;
    return STORE_PREFIX+hash(JSON.stringify({bounds:['north','south','east','west'].map(name=>Number(b[name]).toFixed(6)),rotation:Number(b.rotation_deg||0).toFixed(4)}));
  }
  const placeName=()=>ctx.state.loadedName||ctx.state.name||'';
  const cleanText=text=>String(text).replace(/\r\n?/g,'\n').split('\n').slice(0,3).map(line=>line.slice(0,60)).join('\n');
  function sanitize(saved) {
    if(!saved||typeof saved!=='object')return null;
    const clean=structuredClone(DEFAULTS);
    for(const [name,[,low,high]] of Object.entries(NUMBERS))if(Number.isFinite(saved[name]))clean[name]=clamp(saved[name],low,high);
    for(const [name,[,allowed]] of Object.entries(CHOICES))if(allowed.includes(saved[name]))clean[name]=saved[name];
    for(const name of Object.keys(CHECKS))clean[name]=saved[name]===true;
    for(const name of Object.keys(COLORS))if(isHex(saved[name]))clean[name]=saved[name].toLowerCase();
    if(typeof saved.text==='string')clean.text=cleanText(saved.text);
    if(Array.isArray(saved.trim)&&saved.trim.every(Number.isFinite)&&saved.trim[1]-saved.trim[0]>=5)clean.trim=[clamp(saved.trim[0],0,95),clamp(saved.trim[1],5,100)];
    if(PRESETS.presets[saved.preset])clean.preset=saved.preset;
    if(['none','lamp','box'].includes(saved.fit))clean.fit=saved.fit;
    if(Array.isArray(saved.layer_positions))clean.layer_positions=saved.layer_positions.filter(Number.isFinite).slice(0,7).map(value=>clamp(value,0,100));
    if(['running','cycling'].includes(saved.race_kind))clean.race_kind=saved.race_kind;
    if(typeof saved.finish_time==='string')clean.finish_time=saved.finish_time.slice(0,20);
    for(const name of INTEGERS)clean[name]=Math.round(clean[name]);
    if(clean.layer_count>1&&clean.layer_positions.length!==clean.layer_count)clean.layer_count=Math.max(1,clean.layer_positions.length);
    return clean;
  }
  function load() {
    const key=areaKey();
    if(key===storeKey)return;
    storeKey=key;
    let saved=null;
    try{saved=sanitize(JSON.parse(localStorage.getItem(key)||'null'));}catch{saved=null;}
    if(saved)settings=saved;
    else {
      // A fresh piece follows the geography page: its elevation multiplier, its place name, and the Print palette's colors.
      const colors=ctx.printColors();
      settings={...structuredClone(DEFAULTS),vertical_scale:clamp(Number($('exaggeration').value)||2,.5,100),text:placeName().slice(0,60),
        body_color:isHex(colors.dark_foliage)?colors.dark_foliage:DEFAULTS.body_color,text_color:isHex(colors.snow)?colors.snow:DEFAULTS.text_color};
    }
    writeForm();
  }
  function save() {try{localStorage.setItem(storeKey,JSON.stringify(settings));}catch{/* Optional persistence. */}}
  function writeForm() {
    for(const [name,[id]] of Object.entries(NUMBERS))$(id).value=settings[name];
    for(const [name,[id]] of Object.entries(CHOICES))$(id).value=settings[name];
    for(const [name,id] of Object.entries(CHECKS))$(id).checked=settings[name];
    for(const [name,id] of Object.entries(COLORS))$(id).value=settings[name];
    $('silhouette-text').value=settings.text;
    $('silhouette-trim-start').value=settings.trim[0];$('silhouette-trim-end').value=settings.trim[1];
    $('silhouette-layer-positions').value=settings.layer_positions.join(', ');
    $('silhouette-finish-time').value=settings.finish_time;
    labels();
  }
  function readForm(changed=null) {
    for(const [name,[id,low,high]] of Object.entries(NUMBERS)) {
      const value=Number($(id).value);
      if($(id).value!==''&&Number.isFinite(value))settings[name]=INTEGERS.has(name)?Math.round(clamp(value,low,high)):clamp(value,low,high);
    }
    for(const [name,[id,allowed]] of Object.entries(CHOICES))if(allowed.includes($(id).value))settings[name]=$(id).value;
    for(const [name,id] of Object.entries(CHECKS))settings[name]=$(id).checked;
    for(const [name,id] of Object.entries(COLORS))settings[name]=$(id).value.toLowerCase();
    settings.text=cleanText($('silhouette-text').value);settings.finish_time=$('silhouette-finish-time').value.slice(0,20);
    // The trim keeps at least 5% of the slice; the handle not being moved gives way.
    let start=Number($('silhouette-trim-start').value),end=Number($('silhouette-trim-end').value);
    if(end-start<5){if(changed==='silhouette-trim-end')start=Math.max(0,end-5);else end=Math.min(100,start+5);start=Math.min(start,end-5);}
    $('silhouette-trim-start').value=start;$('silhouette-trim-end').value=end;settings.trim=[start,end];
    // Layers: the count spreads fresh positions; edited positions set the count.
    if(changed==='silhouette-layer-count'){settings.layer_positions=spread(settings.layer_count);$('silhouette-layer-positions').value=settings.layer_positions.join(', ');}
    else if(changed==='silhouette-layer-positions') {
      const values=$('silhouette-layer-positions').value.split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite).slice(0,7).map(value=>clamp(value,0,100));
      if(values.length>=2){settings.layer_positions=values;settings.layer_count=values.length;$('silhouette-layer-count').value=values.length;}
    }
    // A lamp panel that is the tab follows the slot; a box's pieces fill its width.
    if(preset().rules?.tab_thickness&&['silhouette-slot-width','silhouette-slot-clearance'].includes(changed)) {
      settings.thickness_mm=round(clamp(settings.slot_width-settings.slot_clearance,1.2,30));$('silhouette-thickness').value=settings.thickness_mm;
    }
    if(settings.fit==='box'){settings.width_mm=clamp(settings.box_width-1,40,400);$('silhouette-width').value=settings.width_mm;}
    if(changed==='silhouette-finish-time'&&preset().rules?.caption==='race'){settings.text=caption('race');$('silhouette-text').value=settings.text;}
    labels();
  }
  function labels() {
    $('silhouette-trim-start-value').textContent=`${settings.trim[0]}%`;$('silhouette-trim-end-value').textContent=`${settings.trim[1]}%`;
    $('silhouette-smoothing-value').textContent=`${settings.smoothing}%`;
    $('silhouette-hole-block').hidden=settings.mount!=='holes';
    $('silhouette-mount-hint').textContent=settings.fit!=='none'?'The lamp base or the shadow box holds the design, so it has no mount.':MOUNT_HINTS[settings.mount];
    $('silhouette-mount').disabled=settings.fit!=='none';
    const text=Boolean(settings.text.trim());
    ['silhouette-text-style','silhouette-text-size','silhouette-text-align','silhouette-text-color'].forEach(id=>{$(id).disabled=!text;});
    $('silhouette-text-depth').disabled=!text||settings.text_style==='stencil';
    $('silhouette-text-color').disabled=!text||settings.text_style==='stencil';
    $('silhouette-width').disabled=settings.fit==='box';
    $('silhouette-source').querySelector('[value=route]').disabled=!ctx.route&&settings.source!=='route';
    // Ridgeline and viewpoint profiles are drawn on the geography page; offer them once one is.
    for(const mode of ['ridgeline','viewpoint'])$('silhouette-source').querySelector(`[value=${mode}]`).disabled=!drawn(mode)&&settings.source!==mode;
    // The preset picker and the settings its preset shows.
    const current=preset(),fields=new Set(current.fields||[]);
    document.querySelectorAll('[data-silhouette-preset]').forEach(button=>{
      const active=button.dataset.silhouettePreset===settings.preset;button.classList.toggle('active',active);button.setAttribute('aria-checked',String(active));
    });
    $('silhouette-preset-summary').textContent=current.summary||'';
    $('silhouette-preset-hint').textContent=current.hint||'';
    $('silhouette-fit-card').hidden=!fields.size;
    $('silhouette-fit-title').textContent=current.name;
    document.querySelectorAll('[data-fit-block]').forEach(block=>{block.hidden=!fields.has(block.dataset.fitBlock);});
    $('silhouette-spacing-block').hidden=settings.fit!=='lamp';
    $('silhouette-layer-count').min=current.rules?.layers?.min||2;$('silhouette-layer-count').max=current.rules?.layers?.max||7;
    $('silhouette-position').disabled=layered()||['route','ridgeline','viewpoint'].includes(settings.source);
    // Sizes of an option that is off stay visible but greyed out.
    const dependents={led_channel:['silhouette-led-width','silhouette-led-depth'],photo_slot:['silhouette-photo-gap'],summit_pin:['silhouette-pin-diameter','silhouette-pin-depth'],
      ticks:['silhouette-tick-every'],include_buildings:['silhouette-corridor']};
    for(const [name,ids] of Object.entries(dependents))ids.forEach(id=>{$(id).disabled=!settings[name];});
    const colors=layerColors(settings.layer_count),swatches=$('silhouette-layer-swatches');swatches.replaceChildren();
    if(fields.has('layers'))colors.forEach((color,index)=>{const swatch=document.createElement('span');swatch.style.background=color;swatch.title=`Layer ${index+1}`;swatches.append(swatch);});
    const u=ctx.units();$('silhouette-tick-unit').textContent=u.distanceLabel;
    const route=ctx.route;
    $('silhouette-route-status').textContent=route
      ?`Route: ${route.name} · ${number(route.distance_m/u.distance,1)} ${u.distanceLabel}${route.has_elevation===false?' · no GPX elevations, so the terrain is sampled (the whole route must be framed)':''}`
      :'Upload a GPX route on the geography selection page to use its elevation profile. Until then the slice is used.';
    document.querySelectorAll('[data-race-kind]').forEach(button=>{const active=button.dataset.raceKind===settings.race_kind;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    const parts=(layered()?settings.layer_count:1)+(settings.fit==='lamp'&&layered()?1:settings.fit==='box'?2:0);
    $('silhouette-stl-note').textContent=parts>1?`A ZIP of ${parts} STL parts`:'One solid, lying flat';
  }
  // Layer positions spread across the frame, front (the near side) first: looking north at a west → east slice the near side
  // is the south (high %), looking east at a north → south slice it is the west (low %); mirroring turns the view around.
  function spread(count) {
    const rule=preset().rules?.layers||{low:25,high:75};
    const values=Array.from({length:count},(_,index)=>count===1?(rule.low+rule.high)/2:rule.low+(rule.high-rule.low)*index/(count-1));
    const nearHigh=($('profile-direction').value==='ew')!==settings.mirror;
    return (nearHigh?values.reverse():values).map(value=>round(value,1));
  }
  // Front darkest, back palest (the body color fading toward paper).
  const layerColors=count=>Array.from({length:count},(_,index)=>count>1?mix(settings.body_color,'#f3eedf',index/(count-1)*.72):settings.body_color);
  function caption(kind) {
    const route=ctx.route,u=ctx.units(),date=route?.date?longDate(route.date):'';
    const name=(route?.name||placeName()||'').slice(0,60);
    if(kind==='route')return cleanText([name,date].filter(Boolean).join('\n'));
    if(kind==='stats')return cleanText((route?[name,`${number(route.distance_m/u.distance,1)} ${u.distanceLabel} · ${number(route.gain_m*u.height,0)} ${u.label} climbed`,date]:[name]).filter(Boolean).join('\n'));
    if(kind==='names')return `YOUR NAMES\n${longDate(new Date().toISOString().slice(0,10)).toUpperCase()}`;
    if(kind==='race')return cleanText([route?.name||'RACE NAME',date,settings.finish_time].filter(Boolean).join('\n'));
    return settings.text;
  }
  // A route profile's vertical scale: its climb about 50 mm tall (less in a short box) at the piece's width.
  function routeScale() {
    const route=ctx.route;
    if(!route?.elevation_range_m||!route.distance_m)return null;
    const width=settings.fit==='box'?settings.box_width-1:settings.width_mm;
    const target=settings.fit==='box'?Math.min(50,settings.box_height-COMB_FLOOR-settings.base_mm-10):Math.min(50,width*.25);
    return clamp(round(target/(route.elevation_range_m*width/route.distance_m),1),.5,100);
  }
  function applyPreset(id) {
    const chosen=PRESETS.presets[id]||PRESETS.presets.custom,rules=chosen.rules||{};
    for(const name of PRESET_OWNED)settings[name]=structuredClone(DEFAULTS[name]);
    if(settings.source==='route'||(settings.source==='shaped'&&settings.preset==='glow-skyline'))settings.source='true';
    Object.assign(settings,structuredClone(chosen.settings||{}),{preset:id});
    if(rules.tab_thickness)settings.thickness_mm=round(clamp(settings.slot_width-settings.slot_clearance,1.2,30));
    if(rules.layers){settings.layer_count=rules.layers.count;settings.layer_step=rules.layers.step;settings.layer_positions=spread(rules.layers.count);}
    if(settings.fit==='box')settings.width_mm=clamp(settings.box_width-1,40,400);
    if(id==='race')settings.tick_every=settings.race_kind==='cycling'?10:1;
    if(settings.source==='route'){const scale=routeScale();if(scale)settings.vertical_scale=scale;}
    if(rules.caption)settings.text=caption(rules.caption);
    writeForm();save();if(three)three.fitted=false;schedule();
  }
  function buildPresetList() {
    const list=$('silhouette-preset-list');list.replaceChildren();
    const button=(id,parent)=>{
      const item=document.createElement('button');item.type='button';item.className='silhouette-preset';item.dataset.silhouettePreset=id;
      item.setAttribute('role','radio');item.textContent=PRESETS.presets[id].name;item.title=PRESETS.presets[id].summary||'';
      item.addEventListener('click',()=>{if(settings.preset!==id)applyPreset(id);});parent.append(item);
    };
    const custom=document.createElement('div');custom.className='silhouette-preset-group';list.append(custom);button('custom',custom);
    for(const group of PRESETS.groups) {
      const heading=document.createElement('span');heading.className='silhouette-preset-heading';heading.textContent=group.name;list.append(heading);
      const grid=document.createElement('div');grid.className='silhouette-preset-group';list.append(grid);
      group.presets.forEach(id=>PRESETS.presets[id]&&button(id,grid));
    }
  }
  // Whether the geography page's profile panel currently shows this kind of profile.
  function drawn(mode) {return ['ridgeline','viewpoint'].includes(mode)&&ctx.profile?.settings.mode===mode&&ctx.profile.ready;}
  function requestBody(extra={}) {
    const opts=ctx.options(),body={...structuredClone(settings),trim:[...settings.trim],direction:$('profile-direction').value,
      position:Number($('profile-position').value),relief:opts.relief,relief_strength:opts.relief_strength,units:ctx.state.units==='m'?'m':'ft'};
    for(const name of CLIENT_ONLY)delete body[name];
    if(layered()) {
      const colors=layerColors(settings.layer_count);
      body.layers=settings.layer_positions.slice(0,settings.layer_count).map((position,index)=>({position,base_mm:Math.min(120,settings.base_mm+index*settings.layer_step),color:colors[index]}));
    }
    if(settings.source==='route'){if(ctx.route)body.route_id=ctx.route.id;else body.source='true';}
    if(['ridgeline','viewpoint'].includes(settings.source)) {
      const profile=ctx.profile?.settings;
      if(!drawn(settings.source))body.source='true';
      else if(settings.source==='ridgeline')Object.assign(body,{ridge_start:profile.start,ridge_end:profile.end});
      else {
        Object.assign(body,{view_point:profile.point,view_bearing:profile.bearing,view_fov:profile.fov,view_eye_m:profile.eye_m});
        // A viewpoint's layers are distance bands, nearer bands narrower (as profiles.band_edges), nearest at the front.
        if(body.layers)body.layers.forEach((layer,index,all)=>{layer.position=Math.round(((index+1)/all.length)**2*1000)/10;});
      }
    }
    return {...body,...extra};
  }

  // ---------- the slice: shared with the geography selection page's elevation profile ----------
  function syncSlice() {
    const direction=$('profile-direction'),own=$('silhouette-direction');
    [...direction.options].forEach((option,index)=>{if(own.options[index])own.options[index].textContent=option.textContent;});
    own.value=direction.value;$('silhouette-position').value=$('profile-position').value;
    $('silhouette-position-value').textContent=`${$('profile-position').value}%`;
  }
  function sliceLabel() {
    const u=ctx.units();
    let text;
    const profile=ctx.profile?.settings;
    if(result?.profile==='route')text=`${ctx.route?.name||'Route'} · ${number(result.slice_length_m/u.distance,2)} ${u.distanceLabel} along the route`;
    else if(settings.source==='ridgeline'&&drawn('ridgeline'))text=`Ridgeline from the geography page${result?` · ${number(result.slice_length_m/u.distance,2)} ${u.distanceLabel} along the high ground`:''}`;
    else if(settings.source==='viewpoint'&&drawn('viewpoint'))text=`Skyline from the viewpoint · ${number(profile.fov,0)}° view facing ${number(profile.bearing,0)}°${layered()?` · ${settings.layer_count} distance bands`:''}`;
    else {
      const direction=$('profile-direction').selectedOptions[0]?.textContent||'';
      text=layered()?`${direction} · ${settings.layer_count} slices`:`${direction} · ${$('profile-position').value}% across`;
      if(result)text+=` · ${number(result.slice_length_m/u.distance,2)} ${u.distanceLabel} of ground`;
    }
    $('silhouette-slice-label').textContent=text;
  }

  // ---------- outline requests ----------
  function schedule() {clearTimeout(timer);timer=setTimeout(refresh,120);}
  async function refresh() {
    if(!dialog.open||!ctx.state.id)return;
    request?.abort();
    const controller=request=new AbortController();
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/outline`,requestBody(),controller.signal);
      if(!response.ok)throw new Error(await errorMessage(response));
      result=await response.json();
      if(controller!==request)return;
      draw();rebuild3d();renderChecks();sliceLabel();
    } catch(error) {
      if(error.name==='AbortError')return;
      renderChecks(error.message);
    }
  }
  function partsSummary() {
    const parts=result.parts,layers=parts.filter(part=>/^(Layer|Silhouette)/.test(part.name)).length;
    const words=[layers===1?'1 piece':`${layers} layers`];
    for(const part of parts.filter(part=>!/^(Layer|Silhouette)/.test(part.name)))words.push(part.count>1?`${part.count} ${part.name.toLowerCase()}s`:part.name.toLowerCase());
    return `Parts: ${words.join(', ')}`;
  }
  function renderChecks(error=null) {
    const list=$('silhouette-check-list'),box=$('silhouette-checks');list.replaceChildren();
    const add=(level,text)=>{const item=document.createElement('li');item.className=level;item.textContent=text;list.append(item);};
    if(error){add('error',error);box.dataset.level='error';return;}
    if(!result)return;
    result.warnings.forEach(warning=>add('warning',warning));
    (result.notes||[]).forEach(note=>add('note',note));
    if(settings.source==='route'&&!ctx.route)add('note','Upload a GPX route on the geography selection page to use its elevation profile; the slice is shown until then.');
    if(['ridgeline','viewpoint'].includes(settings.source)&&!drawn(settings.source))add('note',`Draw a ${settings.source==='ridgeline'?'ridgeline':'viewpoint skyline'} in the geography page's profile panel to use it; the slice is shown until then.`);
    if(settings.source==='viewpoint'&&layered())add('note','Each layer is a distance band of the view, nearest ridges at the front; layer positions are set from the bands.');
    const size=`${number(result.width_mm)} × ${number(result.height_mm)} × ${number(settings.thickness_mm)} mm`;
    add(result.warnings.length?'note':'ok',`${size} · lowest point ${number(result.min_profile_mm)} mm tall`);
    if(settings.mount==='stand')add('note','The stand feet print beside the piece in the same file.');
    box.dataset.level=result.warnings.length?'warning':'ok';
    $('silhouette-dimensions').textContent=size;
    // The parts list, with each part's size as printed.
    const parts=$('silhouette-parts');parts.replaceChildren();
    const heading=document.createElement('strong');heading.textContent=partsSummary();parts.append(heading);
    const items=document.createElement('ul');
    for(const part of result.parts) {
      const item=document.createElement('li');
      item.textContent=`${part.count>1?`${part.count} × `:''}${part.name} · ${part.size.map(value=>number(value)).join(' × ')} mm`;items.append(item);
    }
    parts.append(items);
  }

  // ---------- front view: the design to scale, layers overlapped front to back as assembled ----------
  function draw() {
    const root=$('silhouette-svg');root.replaceChildren();
    if(!result||!result.outline.outer.length)return;
    const fit=result.fit,layers=result.layers,W=result.width_mm,feet=result.mount.filter(item=>item.kind==='foot');
    let left=0,right=W,low=feet.length?-STAND_DROP-4:0,H=Math.max(...layers.map(layer=>layer.y+layer.height_mm));
    if(fit.tab)low=Math.min(low,fit.tab.y0);
    if(fit.box){left=-.5;right=W+.5;H=Math.max(H,fit.box.height);}
    const pad=Math.max(right-left,H)*.06,below=-low+pad*1.4,rect=root.getBoundingClientRect();
    // Labels stay about 11 px tall whatever the design's size; the room for the height label depends on the scale, so fit twice.
    let view,font=0;
    for(let pass=0;pass<2;pass++) {
      view=[left-pad,-(H+pad),right-left+pad*2+font*5,H+pad+below+font*1.5];
      font=11/(Math.min((rect.width||800)/view[2],(rect.height||500)/view[3])||1);
    }
    root.setAttribute('viewBox',view.join(' '));root.setAttribute('preserveAspectRatio','xMidYMid meet');
    const grid=svg('g',{class:'sil-grid'},root);
    for(let x=0;x<=W+1e-6;x+=10)svg('line',{x1:x,x2:x,y1:0,y2:-Math.ceil(H/10)*10},grid);
    for(let y=0;y<=H+10;y+=10)svg('line',{x1:0,x2:W,y1:-y,y2:-y},grid);
    if(fit.box)svg('rect',{class:'sil-box',x:-.5,y:-fit.box.height,width:W+1,height:fit.box.height},root);
    // Back layers first, each lifted to where it stands; the front layer last with its text and markings.
    for(let index=layers.length-1;index>0;index--) {
      const layer=layers[index];
      svg('path',{class:'sil-body sil-layer','fill-rule':'evenodd',fill:layer.color,transform:`translate(0 ${-layer.y})`,d:polygonPath(layer.outline)},root);
    }
    const front=svg('g',{transform:`translate(0 ${-layers[0].y})`},root);
    svg('path',{class:'sil-body','fill-rule':'evenodd',fill:layers.length>1?layers[0].color:settings.body_color,d:polygonPath(result.outline)},front);
    if(result.text.length) {
      const style=result.text_style,fill=style==='stencil'?'#101b14':settings.text_color;
      svg('path',{class:'sil-text','fill-rule':'evenodd',fill,stroke:style==='emboss'?'#00000088':'none','stroke-width':style==='emboss'?1:0,
        opacity:style==='engrave'?.85:1,d:result.text.map(polygonPath).join('')},front);
    }
    if(result.markings?.length)svg('path',{class:'sil-text','fill-rule':'evenodd',fill:settings.text_color,opacity:.8,d:result.markings.map(polygonPath).join('')},front);
    for(const peg of result.mount.filter(item=>item.kind==='peg'))svg('circle',{class:'sil-peg',cx:peg.x,cy:-peg.y,r:peg.d/2},front);
    for(const pin of result.mount.filter(item=>item.kind==='pin'))svg('rect',{class:'sil-pin',x:pin.x-pin.d/2,y:-pin.y1,width:pin.d,height:pin.y1-pin.y0},front);
    if(fit.tab)svg('rect',{class:'sil-fit',x:fit.tab.x0,y:0,width:fit.tab.x1-fit.tab.x0,height:-fit.tab.y0},root);
    if(fit.comb_base)svg('rect',{class:'sil-fit',x:0,y:-fit.comb_base.height,width:fit.comb_base.width,height:fit.comb_base.height},root);
    if(fit.combs)for(const x of [-.5,W+.5-fit.combs.width])svg('rect',{class:'sil-fit',x,y:-fit.combs.height,width:fit.combs.width,height:fit.combs.height},root);
    for(const foot of feet)svg('rect',{class:'sil-foot',x:foot.x0,y:-foot.y1,width:foot.x1-foot.x0,height:foot.y1-foot.y0},root);
    // Dimensions: width below, height at the right.
    const dims=svg('g',{class:'sil-dimension'},root),y=-low+pad*.7,x=right+pad*.9;
    svg('line',{x1:0,x2:W,y1:y,y2:y},dims);svg('line',{x1:0,x2:0,y1:y-pad*.2,y2:y+pad*.2},dims);svg('line',{x1:W,x2:W,y1:y-pad*.2,y2:y+pad*.2},dims);
    svg('line',{x1:x,x2:x,y1:0,y2:-H},dims);svg('line',{x1:x-pad*.2,x2:x+pad*.2,y1:0,y2:0},dims);svg('line',{x1:x-pad*.2,x2:x+pad*.2,y1:-H,y2:-H},dims);
    svg('text',{class:'sil-label',x:W/2,y:y+font*1.3,'font-size':font,'text-anchor':'middle'},root).textContent=`${number(W)} mm`;
    svg('text',{class:'sil-label',x:x+font*.5,y:-H/2,'font-size':font,'dominant-baseline':'middle'},root).textContent=`${number(H)} mm`;
  }

  // ---------- 3D view: the assembled design, standing as it would on a desk, a lamp base, or in its box ----------
  function setup3d() {
    if(three!==null)return Boolean(three);
    const container=$('silhouette-3d');
    try{three={renderer:new THREE.WebGLRenderer({antialias:true,alpha:true})};}
    catch{three=false;container.textContent='The 3D view needs WebGL. The front view shows the piece to scale.';return false;}
    const {renderer}=three;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
    container.append(renderer.domElement);renderer.domElement.setAttribute('aria-label','Silhouette 3D view: drag to orbit');
    three.scene=new THREE.Scene();three.camera=new THREE.PerspectiveCamera(35,1,.5,5000);
    three.controls=new OrbitControls(three.camera,renderer.domElement);three.controls.enableDamping=true;
    three.scene.add(new THREE.HemisphereLight(0xf0dfbb,0x566747,2.2));
    const sun=new THREE.DirectionalLight(0xffecc8,2.2);sun.position.set(-.4,1,1.2);three.scene.add(sun);
    three.group=new THREE.Group();three.scene.add(three.group);
    new ResizeObserver(resize3d).observe(container);
    return true;
  }
  function resize3d() {
    if(!three)return;
    const container=$('silhouette-3d'),width=container.clientWidth,height=container.clientHeight;
    if(!width||!height)return;
    three.renderer.setSize(width,height);three.camera.aspect=width/height;three.camera.updateProjectionMatrix();
  }
  function shapeOf(polygon) {
    const shape=new THREE.Shape(polygon.outer.map(([x,y])=>new THREE.Vector2(x,y)));
    shape.holes=polygon.holes.map(ring=>new THREE.Path(ring.map(([x,y])=>new THREE.Vector2(x,y))));
    return shape;
  }
  function rebuild3d(fit=false) {
    if(view!=='3d'||!three||!result)return;
    const group=three.group;
    group.traverse(child=>{child.geometry?.dispose();child.material?.dispose();});
    group.clear();
    const T=settings.thickness_mm,depth=settings.text_depth,material=color=>new THREE.MeshStandardMaterial({color,roughness:.85});
    const extrude=(parent,shapes,amount,z,color)=>{
      const geometry=new THREE.ExtrudeGeometry(shapes,{depth:amount,bevelEnabled:false,curveSegments:4});geometry.translate(0,0,z);
      parent.add(new THREE.Mesh(geometry,material(color)));
    };
    const block=(x0,y0,z0,x1,y1,z1,color,opacity=1)=>{
      const geometry=new THREE.BoxGeometry(x1-x0,y1-y0,z1-z0);geometry.translate((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
      const mesh=new THREE.Mesh(geometry,material(color));if(opacity<1){mesh.material.transparent=true;mesh.material.opacity=opacity;}
      group.add(mesh);
    };
    const wire=(x0,y0,z0,x1,y1,z1,color)=>{
      const geometry=new THREE.EdgesGeometry(new THREE.BoxGeometry(x1-x0,y1-y0,z1-z0));geometry.translate((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
      group.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.45})));
    };
    const box=result.fit,layers=result.layers,W=result.width_mm;
    // Placements: each layer's bottom (y) and back face (z); a design without a fit stands with its middle at z = 0.
    const shift=box.kind==='none'?-T/2:0;
    layers.forEach((layer,index)=>{
      const piece=new THREE.Group();piece.position.set(0,layer.y,layer.z+shift);group.add(piece);
      extrude(piece,[shapeOf(index?layer.outline:result.outline)],T,0,layers.length>1?layer.color:settings.body_color);
      if(index)return;
      if(result.text.length) {
        const shapes=result.text.map(shapeOf);
        if(result.text_style==='emboss')extrude(piece,shapes,depth,T,settings.text_color);
        else if(result.text_style==='engrave')extrude(piece,shapes,depth,T-depth+.02,settings.text_color);
        else extrude(piece,shapes,T+.1,-.05,'#101b14');  // cut through: shown as an opening
      }
      if(result.markings?.length)extrude(piece,result.markings.map(shapeOf),.6,T-.58,settings.text_color);
      for(const peg of result.mount.filter(item=>item.kind==='peg')) {
        const geometry=new THREE.CylinderGeometry(peg.d/2,peg.d/2,peg.length,24);geometry.rotateX(Math.PI/2);geometry.translate(peg.x,peg.y,T+peg.length/2);
        piece.add(new THREE.Mesh(geometry,material(settings.body_color)));
      }
    });
    const fitColor='#c8b48a';
    if(box.tab&&layers.length===1)block(box.tab.x0,box.tab.y0,-box.tab.thickness/2,box.tab.x1,0,box.tab.thickness/2,layers[0].color||settings.body_color);
    if(box.comb_base) {
      const comb=box.comb_base,t=box.tab.thickness;
      block(0,0,-comb.depth/2,comb.width,comb.height,comb.depth/2,fitColor,.75);
      block(box.tab.x0,box.tab.y0,-t/2,box.tab.x1,0,t/2,fitColor,.75);
    }
    if(box.tab)wire(W/2-settings.slot_length/2-25,-30,-35,W/2+settings.slot_length/2+25,0,35,'#d9c9a0');  // the lamp base, as a faint outline
    if(box.combs) {
      const comb=box.combs,front=box.box.depth/2;
      for(const x of [-.5,W+.5-comb.width])block(x,0,front-comb.length,x+comb.width,comb.height,front,fitColor,.85);
      wire(-.5,0,-front,W+.5,box.box.height,front,'#d9c9a0');  // the box's inside, as a faint outline
    }
    const reach=clamp(result.height_mm*.5,30,90);
    for(const foot of result.mount.filter(item=>item.kind==='foot'))block(foot.x0,foot.y0,-reach/2,foot.x1,foot.y1,reach/2,'#876749');
    group.position.set(-W/2,0,0);
    if(fit||!three.fitted) {
      // Far enough back that the whole design (and its box) fits the view's width and height, seen from a little above and to the right.
      const height=Math.max(result.height_mm,box.box?.height||0),width=Math.max(W,box.box?.width||0);
      const tangent=Math.tan(THREE.MathUtils.degToRad(three.camera.fov/2));
      const distance=Math.max(height/2/tangent,width/2/(tangent*three.camera.aspect))*1.3;
      three.controls.target.set(0,height/2,0);
      three.camera.position.set(distance*.3,height/2+distance*.3,distance*.9);
      three.controls.update();three.fitted=true;
    }
  }
  function setView(next) {
    view=next;
    document.querySelectorAll('[data-silhouette-view]').forEach(button=>{const active=button.dataset.silhouetteView===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    $('silhouette-svg').style.display=view==='front'?'':'none';$('silhouette-3d').hidden=view!=='3d';
    $('silhouette-view-hint').textContent=view==='front'?'Front view to scale · the grid is 10 mm':'Drag to orbit · scroll to zoom';
    if(view==='3d'&&setup3d()){resize3d();rebuild3d(true);three.renderer.setAnimationLoop(()=>{three.controls.update();three.renderer.render(three.scene,three.camera);});}
    else if(three)three.renderer.setAnimationLoop(null);
    if(view==='front')draw();
  }

  // ---------- exports ----------
  async function exportFile(format) {
    if(busy||!ctx.state.id)return;
    const status=$('silhouette-status'),buttons=document.querySelectorAll('[data-silhouette-export]');
    busy=true;buttons.forEach(button=>{button.disabled=true;});dialog.setAttribute('aria-busy','true');
    status.classList.remove('error');status.textContent=`Building the ${format==='json'?'settings file':format.toUpperCase()}…`;
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/export`,requestBody({format}));
      if(!response.ok)throw new Error(await errorMessage(response));
      const slug=placeName().normalize('NFKD').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase();
      const name=filenameOf(response,`silhouette.${format}`);
      ctx.download(await response.blob(),slug?`${slug}-${name}`:name);
      status.textContent='Your file has been downloaded.';
    } catch(error){status.classList.add('error');status.textContent=error.message;ctx.notify(error.message,true);}
    finally{busy=false;buttons.forEach(button=>{button.disabled=false;});dialog.removeAttribute('aria-busy');}
  }

  function wire() {
    buildPresetList();
    $('silhouette-back').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{clearTimeout(timer);request?.abort();if(three)three.renderer.setAnimationLoop(null);});
    // This page's slice controls drive the geography page's own, whose listeners redraw its chart and map line and refresh this page.
    $('silhouette-position').addEventListener('input',event=>{
      const main=$('profile-position');
      if(main.value!==event.target.value){main.value=event.target.value;main.dispatchEvent(new Event('input',{bubbles:true}));}
    });
    $('silhouette-direction').addEventListener('change',event=>{
      const main=$('profile-direction');
      if(main.value!==event.target.value){main.value=event.target.value;main.dispatchEvent(new Event('change',{bubbles:true}));}
    });
    const sliceChanged=()=>{syncSlice();sliceLabel();if(dialog.open)schedule();};
    $('profile-position').addEventListener('input',sliceChanged);
    $('profile-direction').addEventListener('change',sliceChanged);
    const inputs=[...Object.values(NUMBERS).map(([id])=>id),...Object.values(CHOICES).map(([id])=>id),...Object.values(COLORS),...Object.values(CHECKS),
      'silhouette-text','silhouette-trim-start','silhouette-trim-end','silhouette-layer-positions','silhouette-finish-time'];
    for(const id of inputs) {
      const element=$(id),settled=id.endsWith('color')||element.tagName==='SELECT'||element.type==='checkbox'||id==='silhouette-layer-positions';
      element.addEventListener(settled?'change':'input',()=>{
        readForm(id);save();
        // Colors only repaint; everything else changes the outline.
        if(id.endsWith('color')&&!layered()){draw();rebuild3d();}else schedule();
      });
    }
    for(const id of Object.values(COLORS))$(id).addEventListener('input',()=>{readForm(id);if(!layered()){draw();rebuild3d();}});
    document.querySelectorAll('[data-race-kind]').forEach(button=>button.addEventListener('click',()=>{
      settings.race_kind=button.dataset.raceKind;settings.tick_every=settings.race_kind==='cycling'?10:1;
      writeForm();save();schedule();
    }));
    document.querySelectorAll('[data-silhouette-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.silhouetteView)));
    document.querySelectorAll('[data-silhouette-export]').forEach(button=>button.addEventListener('click',()=>exportFile(button.dataset.silhouetteExport)));
    new ResizeObserver(()=>{if(dialog.open&&view==='front')draw();}).observe($('silhouette-view'));
  }
  wire();

  return {
    open() {
      if(!ctx.state.data)return;
      load();syncSlice();
      // A ridgeline or skyline drawn on the geography page becomes the profile, unless a route or another source was chosen.
      const mode=ctx.profile?.settings.mode;
      if(drawn(mode)&&['true','shaped'].includes(settings.source)&&!(layered()&&mode==='ridgeline')){settings.source=mode;writeForm();save();}
      $('silhouette-title').textContent=placeName()||'Your landscape';
      if(!dialog.open)dialog.showModal();
      setView(view);sliceLabel();refresh();
    },
    close(){if(dialog.open)dialog.close();},
    // A new area, multiplier, elevation profile, route, units, or map layers on the geography page: reload this area's settings and redraw.
    modelChanged() {
      if(!dialog.open||!ctx.state.data)return;
      if(areaKey()!==storeKey){load();three&&(three.fitted=false);}
      $('silhouette-title').textContent=placeName()||'Your landscape';
      syncSlice();labels();schedule();
    },
  };
}
