/* Silhouette design page: elevation-profile slices (or the uploaded route's profile) as flat pieces, with a caption and a
 * mount, or as a design from a preset: glow-lamp panels with a tab for the lamp base's slot, shadow-box layers in spacer
 * combs, and race profiles with ticks and medal pegs. The server lays the design out (POST /api/silhouette/<id>/outline)
 * and builds its files; this module draws it to scale, keeps the slice in step with the geography selection page's
 * profile controls, and remembers settings per framed area. Layered designs from a viewpoint use the ridges the geography
 * page detected (one layer each, nearest at the front) and can print closer layers thicker. Colors can follow distance (up to
 * four filament colors, nearest first), and a viewpoint's ridges can instead be color zones of one flat piece.
 * app.js hands over a small context: state, route, options(), notify, download, units, printColors.
 */
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {createTurntable} from './turntable.js';

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
  thickness_mm:['silhouette-thickness',1.2,30],thickness_near_mm:['silhouette-thickness-near',1.2,30],thickness_far_mm:['silhouette-thickness-far',1.2,30],smoothing:['silhouette-smoothing',0,100],text_size:['silhouette-text-size',2,30],
  text_depth:['silhouette-text-depth',.2,5],hole_diameter:['silhouette-hole',2,10],
  slot_width:['silhouette-slot-width',1,20],slot_length:['silhouette-slot-length',20,400],slot_depth:['silhouette-slot-depth',2,30],
  slot_clearance:['silhouette-slot-clearance',0,1],box_width:['silhouette-box-width',41,500],box_height:['silhouette-box-height',20,400],
  box_depth:['silhouette-box-depth',8,200],layer_count:['silhouette-layer-count',1,7],layer_step:['silhouette-layer-step',0,20],
  layer_spacing:['silhouette-layer-spacing',2,30],building_corridor_m:['silhouette-corridor',5,200],tick_every:['silhouette-tick-every',.1,100],
  peg_count:['silhouette-peg-count',0,8],peg_diameter:['silhouette-peg-diameter',3,12],peg_length:['silhouette-peg-length',5,40],
  pin_diameter:['silhouette-pin-diameter',1,4],pin_depth:['silhouette-pin-depth',3,30],photo_gap:['silhouette-photo-gap',.3,5],
  led_width:['silhouette-led-width',2,20],led_depth:['silhouette-led-depth',.5,5],min_feature_mm:['silhouette-min-feature',0,3],
  comb_clearance:['silhouette-comb-clearance',0,1]};
const INTEGERS=new Set(['layer_count','peg_count']);
const CHOICES={source:['silhouette-source',['true','shaped','route','ridgeline','viewpoint']],text_style:['silhouette-text-style',['engrave','emboss','stencil']],
  text_align:['silhouette-text-align',['left','center','right']],mount:['silhouette-mount',['none','stand','holes','keyholes']]};
const CHECKS={mirror:'silhouette-mirror',include_buildings:'silhouette-buildings',ticks:'silhouette-ticks',start_finish:'silhouette-start-finish',
  summit_pin:'silhouette-pin',photo_slot:'silhouette-photo',led_channel:'silhouette-led',thickness_by_distance:'silhouette-thickness-distance',
  color_by_distance:'silhouette-color-distance',clouds:'silhouette-clouds'};
const DISTANCE_IDS=[1,2,3,4].map(index=>`silhouette-distance-color-${index}`);
const COLORS={text_color:'silhouette-text-color',body_color:'silhouette-body-color',cloud_color:'silhouette-cloud-color'};
const DEFAULTS={width_mm:180,vertical_scale:2,base_mm:8,thickness_mm:4,smoothing:0,text_size:5,text_depth:.8,hole_diameter:4,source:'true',
  text_style:'engrave',text_align:'center',mount:'none',mirror:false,trim:[0,100],text:'',text_color:'#f0ead6',body_color:'#234e40',
  preset:'custom',fit:'none',slot_width:4,slot_length:160,slot_depth:8,slot_clearance:.2,box_width:200,box_height:150,box_depth:40,
  layer_count:1,layer_positions:[],layer_step:6,layer_spacing:6,include_buildings:false,building_corridor_m:30,ticks:false,tick_every:1,
  start_finish:false,peg_count:0,peg_diameter:6,peg_length:20,summit_pin:false,pin_diameter:1.8,pin_depth:10,photo_slot:false,photo_gap:1,
  led_channel:false,led_width:5,led_depth:2,min_feature_mm:1,comb_clearance:.3,text_x:null,text_y:null,text_lines:[],line_spacing:1.6,race_kind:'running',finish_time:'',thickness_by_distance:false,thickness_near_mm:3,thickness_far_mm:1.5,
  color_by_distance:false,distance_colors:['#234e40','#678272','#acb6a4','#f0ead6'],color_zones:false,clouds:false,cloud_color:'#f0ead6',ridge_edits:[],ridge_basis:null};
// What a preset decides: choosing another preset (or Custom) resets these before applying its own. Slice, caption, colors, and the
// lamp and box measurements are kept.
const PRESET_OWNED=['fit','layer_count','layer_positions','layer_step','layer_spacing','include_buildings','ticks','tick_every','start_finish',
  'peg_count','summit_pin','photo_slot','led_channel','mount','text_style','text_depth','text_size','thickness_mm','base_mm','thickness_by_distance',
  'thickness_near_mm','thickness_far_mm','color_zones','clouds','text_x','text_y','text_lines'];
// The text editor's lines: text, size (cap height, mm), style, and letter spacing (% of the cap height).
const TEXT_STYLES={regular:'Regular',bold:'Bold',italic:'Italic','bold-italic':'Bold italic'},MAX_TEXT_LINES=6;
const cleanLine=line=>line&&typeof line==='object'&&typeof line.text==='string'?{text:line.text.replace(/\s+/g,' ').slice(0,60),
  size:Number.isFinite(line.size)?clamp(line.size,1,40):5,style:TEXT_STYLES[line.style]?line.style:'bold',tracking:Number.isFinite(line.tracking)?clamp(line.tracking,-20,100):0}:null;
const CLIENT_ONLY=['layer_count','layer_positions','layer_step','race_kind','finish_time','ridge_basis'];
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
  let settings=structuredClone(DEFAULTS),storeKey=null,result=null,resultKey=null,timer=null,request=null,view='front',busy=false,three=null;
  let ridgeEditing=false,ridgeSelection=new Set(),ridgeUndo=[],ridgeRedo=[],ridgeDragging=false;
  // These read the current settings, or a candidate's (s) when the Start from preview shows a preset before it is applied.
  const preset=(s=settings)=>PRESETS.presets[s.preset]||PRESETS.presets.custom;
  // One piece in color zones: a viewpoint's ridges (or bands) on one base strip, each zone its own color; not in a shadow box.
  const zonesAllowed=(s=settings)=>s.source==='viewpoint'&&drawn('viewpoint')&&s.layer_count>1&&s.fit!=='box';
  const zoned=(s=settings)=>s.color_zones&&zonesAllowed(s);
  const layered=(s=settings)=>s.layer_count>1&&(s.fit!=='none'||zoned(s));
  const distanceColored=(s=settings)=>s.color_by_distance||zoned(s);
  // Thicker when closer applies to a viewpoint's layers only.
  const byDistance=()=>layered()&&settings.thickness_by_distance&&settings.source==='viewpoint';
  const cloudsAllowed=(s=settings)=>layered(s)&&!zoned(s)&&['lamp','box'].includes(s.fit);

  // ---------- settings: per framed area, like the 3D model design page's projects ----------
  function areaKey() {
    const b=ctx.state.data.bounds;
    return STORE_PREFIX+hash(JSON.stringify({bounds:['north','south','east','west'].map(name=>Number(b[name]).toFixed(6)),rotation:Number(b.rotation_deg||0).toFixed(4),
      ...(b.shape&&b.shape!=='rectangle'?{shape:b.shape}:{})}));
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
    if(Number.isFinite(saved.text_x)&&Number.isFinite(saved.text_y)){clean.text_x=saved.text_x;clean.text_y=saved.text_y;}
    if(Array.isArray(saved.text_lines))clean.text_lines=saved.text_lines.slice(0,MAX_TEXT_LINES).map(cleanLine).filter(Boolean);
    if(clean.text_lines.length)clean.text=clean.text_lines.map(line=>line.text).join('\n');
    if(Number.isFinite(saved.line_spacing))clean.line_spacing=clamp(saved.line_spacing,1,3);
    if(Array.isArray(saved.trim)&&saved.trim.every(Number.isFinite)&&saved.trim[1]-saved.trim[0]>=5)clean.trim=[clamp(saved.trim[0],0,95),clamp(saved.trim[1],5,100)];
    if(PRESETS.presets[saved.preset])clean.preset=saved.preset;
    if(['none','lamp','box'].includes(saved.fit))clean.fit=saved.fit;
    if(Array.isArray(saved.layer_positions))clean.layer_positions=saved.layer_positions.filter(Number.isFinite).slice(0,7).map(value=>clamp(value,0,100));
    if(['running','cycling'].includes(saved.race_kind))clean.race_kind=saved.race_kind;
    if(typeof saved.finish_time==='string')clean.finish_time=saved.finish_time.slice(0,20);
    if(Array.isArray(saved.distance_colors)&&saved.distance_colors.length===4&&saved.distance_colors.every(isHex))clean.distance_colors=saved.distance_colors.map(color=>color.toLowerCase());
    clean.color_zones=saved.color_zones===true;
    if(Array.isArray(saved.ridge_edits)&&saved.ridge_edits.length<=7) {
      const seen=new Set();
      clean.ridge_edits=saved.ridge_edits.filter(edit=>{
        if(!edit||!Number.isInteger(edit.layer)||edit.layer<0||edit.layer>6||seen.has(edit.layer)||typeof edit.deleted!=='boolean'||!Array.isArray(edit.curve))return false;
        const curve=edit.curve;
        if(curve.length&&(curve.length<2||curve.length>1025||curve[0]?.[0]!==0||curve.at(-1)?.[0]!==1))return false;
        if(!curve.every((p,i)=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=0&&p[0]<=1&&p[1]>=0&&p[1]<=5&&(!i||p[0]>curve[i-1][0])))return false;
        seen.add(edit.layer);return true;
      }).map(edit=>({layer:edit.layer,deleted:edit.deleted,curve:edit.curve}));
    }
    if(typeof saved.ridge_basis==='string')clean.ridge_basis=saved.ridge_basis;
    for(const name of INTEGERS)clean[name]=Math.round(clean[name]);
    if(clean.layer_count>1&&clean.layer_positions.length!==clean.layer_count)clean.layer_count=Math.max(1,clean.layer_positions.length);
    return clean;
  }
  function load() {
    const key=areaKey();
    if(key===storeKey)return;
    storeKey=key;
    ridgeSelection.clear();ridgeUndo=[];ridgeRedo=[];
    let saved=null;
    try{saved=sanitize(JSON.parse(localStorage.getItem(key)||'null'));}catch{saved=null;}
    if(saved)settings=saved;
    else {
      // A fresh piece follows the geography page: its elevation multiplier, its place name, and the Print palette's colors.
      const colors=ctx.printColors();
      settings={...structuredClone(DEFAULTS),vertical_scale:clamp(Number($('exaggeration').value)||2,.5,100),text:placeName().slice(0,60),
        body_color:isHex(colors.dark_foliage)?colors.dark_foliage:DEFAULTS.body_color,text_color:isHex(colors.snow)?colors.snow:DEFAULTS.text_color};
      // Distance colors fade from the body color to the text color, so an engraved caption shares the farthest filament.
      settings.distance_colors=[0,1/3,2/3,1].map(t=>mix(settings.body_color,settings.text_color,t));
      // A newly generated area starts on the multi-layer Layered glow, built from the viewpoint's ridges when one is drawn.
      settings=presetSettings('glow-layers',settings);
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
    DISTANCE_IDS.forEach((id,index)=>{$(id).value=settings.distance_colors[index];});
    $('silhouette-pieces').value=settings.color_zones?'zones':'layers';
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
    if(!settings.text_lines.length)settings.text=cleanText($('silhouette-text').value);  // formatted text is edited in the text editor
    settings.finish_time=$('silhouette-finish-time').value.slice(0,20);
    settings.distance_colors=DISTANCE_IDS.map(id=>$(id).value.toLowerCase());settings.color_zones=$('silhouette-pieces').value==='zones';
    // The trim keeps at least 5% of the slice; the handle not being moved gives way.
    let start=Number($('silhouette-trim-start').value),end=Number($('silhouette-trim-end').value);
    if(end-start<5){if(changed==='silhouette-trim-end')start=Math.max(0,end-5);else end=Math.min(100,start+5);start=Math.min(start,end-5);}
    $('silhouette-trim-start').value=start;$('silhouette-trim-end').value=end;settings.trim=[start,end];
    // Layers: the count spreads fresh positions; edited positions set the count.
    if(changed==='silhouette-layer-count'){
      settings.layer_positions=spread(settings.layer_count);$('silhouette-layer-positions').value=settings.layer_positions.join(', ');
      if(viewPlan())setGeographyLayers(settings.layer_count);  // the geography page's Layers follows, so both show the same layers
    }
    else if(changed==='silhouette-layer-positions') {
      const values=$('silhouette-layer-positions').value.split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite).slice(0,7).map(value=>clamp(value,0,100));
      if(values.length>=2){settings.layer_positions=values;settings.layer_count=values.length;$('silhouette-layer-count').value=values.length;}
    }
    // A lamp panel that is the tab follows the slot; a box's pieces fill its width.
    if(preset().rules?.tab_thickness&&['silhouette-slot-width','silhouette-slot-clearance'].includes(changed)) {
      settings.thickness_mm=round(clamp(settings.slot_width-settings.slot_clearance,1.2,30));$('silhouette-thickness').value=settings.thickness_mm;
    }
    if(settings.fit==='box'){settings.width_mm=clamp(settings.box_width-1,40,400);$('silhouette-width').value=settings.width_mm;}
    if(changed==='silhouette-text-align'){settings.text_x=settings.text_y=null;}  // an alignment puts the caption back on the base strip
    if(changed==='silhouette-finish-time'&&preset().rules?.caption==='race'){setCaption('race');$('silhouette-text').value=settings.text;}
    if(changed==='silhouette-source'&&preset().rules?.distance_thickness){settings.thickness_by_distance=settings.source==='viewpoint';$(CHECKS.thickness_by_distance).checked=settings.thickness_by_distance;}
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
    // Formatted text (several sizes or styles) is edited in the text editor; the plain caption here.
    const rich=settings.text_lines.length>0;
    $('silhouette-text').readOnly=rich;$('silhouette-text-size').disabled=!text||rich;
    $('silhouette-text-plain').hidden=!rich;
    $('silhouette-text-format').textContent=rich?`Formatted text · ${settings.text_lines.filter(line=>line.text).length} line${settings.text_lines.length>1?'s':''} · change it in the text editor`:'';
    $('silhouette-text-reset').disabled=!text||settings.text_x===null;
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
    $('silhouette-spacing-block').hidden=settings.fit!=='lamp'||zoned();
    $('silhouette-comb-clearance').disabled=!layered()||zoned();  // only separate layers stand in comb slots
    $('silhouette-step-block').hidden=zoned();  // zones share one base strip
    $('silhouette-layer-count-label').textContent=zoned()?'Zones (ridges)':'Layers';
    // Colors: distance colors in use (fewer with fewer layers), and the one-piece choice where it applies.
    const used=distanceColored()?Math.min(4,layered()?settings.layer_count:1):0;
    DISTANCE_IDS.forEach((id,index)=>{$(id).disabled=index>=used;});
    $(CHECKS.color_by_distance).disabled=zoned();
    $('silhouette-pieces-block').hidden=!zonesAllowed();
    $('silhouette-colors-hint').textContent=zoned()?'Color zones always use the distance colors: each ridge is the color of its distance group, nearest first.'
      :distanceColored()?`Layers take these colors nearest first, in ${used} even groups; ${settings.fit==='none'?'stand feet':'the combs'} take the farthest one used.`
      :'Each part prints in its own color.';
    $('silhouette-layer-count').min=current.rules?.layers?.min||2;$('silhouette-layer-count').max=current.rules?.layers?.max||7;
    $('silhouette-position').disabled=layered()||['route','ridgeline','viewpoint'].includes(settings.source);
    // Sizes of an option that is off stay visible but greyed out.
    const dependents={led_channel:['silhouette-led-width','silhouette-led-depth'],photo_slot:['silhouette-photo-gap'],summit_pin:['silhouette-pin-diameter','silhouette-pin-depth'],
      ticks:['silhouette-tick-every'],include_buildings:['silhouette-corridor']};
    for(const [name,ids] of Object.entries(dependents))ids.forEach(id=>{$(id).disabled=!settings[name];});
    // Thickness: one for every layer, or each layer's by its distance from the viewpoint.
    const viewpoint=settings.source==='viewpoint';
    $(CHECKS.thickness_by_distance).disabled=!viewpoint;
    ['silhouette-thickness-near','silhouette-thickness-far'].forEach(id=>{$(id).disabled=!byDistance();});
    $('silhouette-thickness').disabled=byDistance();
    // A viewpoint's layers are set by distance (bands or detected ridges), not by slice positions.
    $('silhouette-layer-positions').disabled=viewpoint;
    $('silhouette-clouds').disabled=!cloudsAllowed();
    $('silhouette-cloud-color').disabled=!cloudsAllowed()||!settings.clouds;
    $('silhouette-cloud-hint').textContent=cloudsAllowed()?'Adds a separate cartoon-cloud panel and a rear slot in the base.':'Clouds need separate layers in a lamp base or shadow box.';
    $('silhouette-layer-hint').textContent=zoned()?'One piece: each zone is what of a ridge (or band) shows above the nearer ones, all on one base strip; the nearest zone holds the caption.'
      :`Each layer's base is a step higher than the one in front, so every ridge shows. The front layer is ${viewpoint?'the nearest to the viewpoint':'the frame\'s near side'}.`;
    $('silhouette-thickness-hint').textContent=!viewpoint?'Thicker when closer needs the viewpoint skyline as the heights; until then every layer is the Shape thickness.'
      :byDistance()?'Each layer\'s thickness follows its distance from the viewpoint, Nearest to Farthest.':'Every layer is the Shape thickness.';
    const colors=layerColors(settings.layer_count),swatches=$('silhouette-layer-swatches');swatches.replaceChildren();
    if(fields.has('layers'))colors.forEach((color,index)=>{const swatch=document.createElement('span');swatch.style.background=color;swatch.title=`Layer ${index+1}`;swatches.append(swatch);});
    const u=ctx.units();$('silhouette-tick-unit').textContent=u.distanceLabel;
    const route=ctx.route;
    $('silhouette-route-status').textContent=route
      ?`Route: ${route.name} · ${number(route.distance_m/u.distance,1)} ${u.distanceLabel}${route.has_elevation===false?' · no GPX elevations, so the terrain is sampled (the whole route must be framed)':''}`
      :'Upload a GPX route on the geography selection page to use its elevation profile. Until then the slice is used.';
    document.querySelectorAll('[data-race-kind]').forEach(button=>{const active=button.dataset.raceKind===settings.race_kind;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    const parts=(layered()&&!zoned()?settings.layer_count:1)+(cloudsAllowed()&&settings.clouds?1:0)+(settings.fit==='lamp'&&layered()&&!zoned()?1:settings.fit==='box'?2:0);
    $('silhouette-stl-note').textContent=parts>1?`A ZIP of ${parts} STL parts`:'One solid, lying flat';
    renderLayerLine();
  }
  // Layer positions spread across the frame, front (the near side) first: looking north at a west → east slice the near side
  // is the south (high %), looking east at a north → south slice it is the west (low %); mirroring turns the view around.
  function spread(count,s=settings) {
    const rule=preset(s).rules?.layers||{low:25,high:75};
    const values=Array.from({length:count},(_,index)=>count===1?(rule.low+rule.high)/2:rule.low+(rule.high-rule.low)*index/(count-1));
    const nearHigh=($('profile-direction').value==='ew')!==s.mirror;
    return (nearHigh?values.reverse():values).map(value=>round(value,1));
  }
  // Front darkest, back palest (the body color fading toward paper); by distance, contiguous groups take the distance colors, as the server does.
  const layerColors=(count,s=settings)=>Array.from({length:count},(_,index)=>distanceColored(s)?s.distance_colors[Math.floor(index*Math.min(count,4)/count)]
    :count>1?mix(s.body_color,'#f3eedf',index/(count-1)*.72):s.body_color);
  // A preset's caption as a text block: a bold first line at the text size, smaller lines under it. none: the lamp designs start without one.
  function captionLines(kind,s=settings) {
    const route=ctx.route,u=ctx.units(),date=route?.date?longDate(route.date):'';
    const name=(route?.name||placeName()||'').slice(0,60);
    const line=(text,scale=1,style='bold',tracking=0)=>text?{text:String(text).slice(0,60),size:Math.max(2,Math.round(s.text_size*scale*2)/2),style,tracking}:null;
    const lines={route:[line(name),line(date,.7,'italic')],
      stats:route?[line(name),line(`${number(route.distance_m/u.distance,1)} ${u.distanceLabel} · ${number(route.gain_m*u.height,0)} ${u.label} climbed`,.7,'regular'),line(date,.7,'italic')]:[line(name)],
      names:[line('YOUR NAMES',1,'bold',8),line(longDate(new Date().toISOString().slice(0,10)).toUpperCase(),.6,'regular',25)],
      race:[line(route?.name||'RACE NAME'),line(date,.65,'italic'),line(s.finish_time,.8,'bold')]}[kind]||[];
    return lines.filter(Boolean);
  }
  function setCaption(kind,s=settings) {s.text_lines=captionLines(kind,s);s.text=s.text_lines.map(line=>line.text).join('\n');}
  // A route profile's vertical scale: its climb about 50 mm tall (less in a short box) at the piece's width.
  function routeScale(s=settings) {
    const route=ctx.route;
    if(!route?.elevation_range_m||!route.distance_m)return null;
    const width=s.fit==='box'?s.box_width-1:s.width_mm;
    const target=s.fit==='box'?Math.min(50,s.box_height-COMB_FLOOR-s.base_mm-10):Math.min(50,width*.25);
    return clamp(round(target/(route.elevation_range_m*width/route.distance_m),1),.5,100);
  }
  // The settings a preset gives, from these (base) settings: a new object, so the Start from preview can show a preset unapplied.
  function presetSettings(id,base=settings) {
    const chosen=PRESETS.presets[id]||PRESETS.presets.custom,rules=chosen.rules||{},s=structuredClone(base);
    s.ridge_edits=[];s.ridge_basis=null;
    for(const name of PRESET_OWNED)s[name]=structuredClone(DEFAULTS[name]);
    if(s.source==='route'||(s.source==='shaped'&&s.preset==='glow-skyline'))s.source='true';
    Object.assign(s,structuredClone(chosen.settings||{}),{preset:id});
    if(rules.tab_thickness)s.thickness_mm=round(clamp(s.slot_width-s.slot_clearance,1.2,30));
    if(rules.layers){s.layer_count=rules.layers.count;s.layer_step=rules.layers.step;s.layer_positions=spread(rules.layers.count,s);}
    if(rules.distance_thickness)s.thickness_by_distance=s.source==='viewpoint';
    // A layered viewpoint design takes the geography page's layers: its detected ridges or its distance bands.
    const plan=viewPlan(s);
    if(plan&&s.layer_count!==plan.count){s.layer_count=plan.count;s.layer_positions=spread(plan.count,s);}
    if(s.fit==='box')s.width_mm=clamp(s.box_width-1,40,400);
    if(id==='race')s.tick_every=s.race_kind==='cycling'?10:1;
    if(s.source==='route'){const scale=routeScale(s);if(scale)s.vertical_scale=scale;}
    if(rules.caption)setCaption(rules.caption,s);
    return s;
  }
  function applyPreset(id) {
    settings=presetSettings(id);followRidges(false);
    settings.ridge_edits=[];settings.ridge_basis=null;ridgeSelection.clear();ridgeUndo=[];ridgeRedo=[];
    writeForm();save();if(three)three.fitted=false;schedule();
  }
  function buildPresetList() {
    const list=$('silhouette-preset-list');list.replaceChildren();
    const button=(id,parent)=>{
      const item=document.createElement('button');item.type='button';item.className='silhouette-preset';item.dataset.silhouettePreset=id;
      item.setAttribute('role','radio');item.textContent=PRESETS.presets[id].name;item.title=PRESETS.presets[id].summary||'';
      item.addEventListener('click',()=>{if(settings.preset!==id)applyPreset(id);updatePreview();});wirePreview(item,id);parent.append(item);
    };
    const custom=document.createElement('div');custom.className='silhouette-preset-group';list.append(custom);button('custom',custom);
    for(const group of PRESETS.groups) {
      const heading=document.createElement('span');heading.className='silhouette-preset-heading';heading.textContent=group.name;list.append(heading);
      const grid=document.createElement('div');grid.className='silhouette-preset-group';list.append(grid);
      group.presets.forEach(id=>PRESETS.presets[id]&&button(id,grid));
    }
  }
  // Whether the geography page's profile panel currently shows this kind of profile.
  // A Viewpoint ridgeline drawn there counts as the viewpoint source (with its ridges detected).
  function drawn(mode) {const shown=ctx.profile?.settings.mode==='viewridge'?'viewpoint':ctx.profile?.settings.mode;return ['ridgeline','viewpoint'].includes(mode)&&shown===mode&&ctx.profile.ready;}
  // A layered viewpoint design with ridges detected on the geography page: one layer per ridge, as many as the preset allows.
  // Fewer ridges than the preset's minimum: distance bands instead (ridges is false).
  function ridgePlan(s=settings) {
    const profile=ctx.profile?.settings,rule=preset(s).rules?.layers;
    if(!rule||!layered(s)||s.source!=='viewpoint'||!drawn('viewpoint')||!profile.ridges||!profile.found?.length)return null;
    const found=profile.found.length,count=clamp(found,rule.min||2,rule.max||7);
    return {found,count,ridges:found>=count,min:rule.min||2,max:rule.max||7};
  }
  // A layered design from the viewpoint shows exactly the geography page's layers: one per ridge it detected, or its
  // distance bands (at most 5 there). The two layer counts are linked both ways; a preset needing more layers than the
  // geography page shows raises its count, which redraws the chart and map to match.
  function viewPlan(s=settings) {
    const profile=ctx.profile?.settings,rule=preset(s).rules?.layers;
    if(!rule||!layered(s)||s.source!=='viewpoint'||!drawn('viewpoint'))return null;
    const ridges=Boolean(profile.ridges&&profile.found?.length>=(rule.min||2));
    const geo=ridges?profile.found.length:profile.bands,max=ridges?(rule.max||7):Math.min(rule.max||7,5);
    const min=rule.min||2;  // a single geography layer gives the preset's own count instead
    return {count:clamp(geo>=min?geo:(rule.count||min),min,max),geo,ridges};
  }
  function setGeographyLayers(count) {
    const select=$('view-bands');
    if(Number(select.value)===count)return;
    select.value=String(count);select.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function followRidges(store=true) {
    const plan=viewPlan();
    if(!plan)return;
    if(settings.layer_count!==plan.count){settings.layer_count=plan.count;settings.layer_positions=spread(plan.count);if(store){writeForm();save();}}
    // Fewer layers than the geography page shows would regroup its ridges differently: bring that page to the same count.
    if(plan.geo!==plan.count&&!(plan.ridges&&plan.geo<plan.count)) {
      if(plan.geo>plan.count)ctx.notify(`${preset().name} holds at most ${plan.count} layers, so the geography page now shows ${plan.count} ${plan.ridges?'ridges':'bands'} too.`);
      setGeographyLayers(plan.count);
    }
  }
  function requestBody(extra={},s=settings) {
    const opts=ctx.options(),body={...structuredClone(s),trim:[...s.trim],direction:$('profile-direction').value,
      position:Number($('profile-position').value),relief:opts.relief,relief_strength:opts.relief_strength,units:ctx.state.units==='m'?'m':'ft'};
    for(const name of CLIENT_ONLY)delete body[name];
    body.color_zones=zoned(s);
    body.clouds=s.clouds&&cloudsAllowed(s);
    if(layered(s)) {
      const colors=layerColors(s.layer_count,s);
      body.layers=s.layer_positions.slice(0,s.layer_count).map((position,index)=>({position,base_mm:Math.min(120,s.base_mm+index*s.layer_step),color:colors[index]}));
    }
    if(s.source==='route'){if(ctx.route)body.route_id=ctx.route.id;else body.source='true';}
    if(['ridgeline','viewpoint'].includes(s.source)) {
      const profile=ctx.profile?.settings;
      if(!drawn(s.source))body.source='true';
      else if(s.source==='ridgeline')Object.assign(body,{ridge_start:profile.start,ridge_end:profile.end});
      else {
        Object.assign(body,{view_point:profile.point,view_bearing:profile.bearing,view_fov:profile.fov,view_eye_m:profile.eye_m,view_min_radius_m:profile.min_radius_m||0,
          view_max_radius_m:profile.max_radius_m||0});
        // A viewpoint's layers are its detected ridges (the server ignores their positions), or distance bands, nearer bands
        // narrower (as profiles.band_edges), nearest at the front.
        if(viewPlan(s)?.ridges)body.view_ridges=true;
        if(body.layers)body.layers.forEach((layer,index,all)=>{layer.position=Math.round(((index+1)/all.length)**2*1000)/10;});
      }
    }
    return {...body,...extra};
  }

  // Curve edits are normalized to width and base, so size, base-step, thickness and color changes preserve them.
  // A different slice, viewpoint, detection count or source starts from its own terrain curves.
  function ridgeBasis() {
    const body=requestBody();
    return JSON.stringify(['source','direction','position','trim','mirror','smoothing','vertical_scale','relief','relief_strength','route_id',
      'ridge_start','ridge_end','view_point','view_bearing','view_fov','view_eye_m','view_min_radius_m','view_max_radius_m','view_ridges']
      .map(key=>body[key]??null).concat([body.layers?.map(layer=>layer.position)||[]]));
  }
  function syncRidgeBasis() {
    const basis=ridgeBasis();
    if(settings.ridge_basis&&settings.ridge_basis!==basis) {
      settings.ridge_edits=[];ridgeSelection.clear();ridgeUndo=[];ridgeRedo=[];
    }
    settings.ridge_basis=basis;save();
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
    else if(settings.source==='viewpoint'&&drawn('viewpoint'))text=`Skyline from the viewpoint · ${number(profile.fov,0)}° view facing ${number(profile.bearing,0)}°${layered()?` · ${settings.layer_count} ${ridgePlan()?.ridges?'ridges':'distance bands'}`:''}`;
    else {
      const direction=$('profile-direction').selectedOptions[0]?.textContent||'';
      text=layered()?`${direction} · ${settings.layer_count} slices`:`${direction} · ${$('profile-position').value}% across`;
      if(result)text+=` · ${number(result.slice_length_m/u.distance,2)} ${u.distanceLabel} of ground`;
    }
    $('silhouette-slice-label').textContent=text;
  }

  // ---------- outline requests ----------
  function schedule() {renderLayerLine();clearTimeout(timer);timer=setTimeout(refresh,120);}
  async function refresh() {
    if(!dialog.open||!ctx.state.id)return;
    if(ridgeDragging){schedule();return;}
    syncRidgeBasis();
    request?.abort();
    const controller=request=new AbortController(),body=requestBody();
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/outline`,body,controller.signal);
      if(!response.ok)throw new Error(await errorMessage(response));
      const data=await response.json();
      if(controller!==request)return;
      result=data;
      resultKey=JSON.stringify(body);
      remember(body,result);
      // A caption dragged off the piece comes back where the server could fit it: keep that spot.
      if(result.text_box?.moved){settings.text_x=result.text_box.x;settings.text_y=result.text_box.y;save();labels();}
      draw();rebuild3d();renderChecks();sliceLabel();previewCurrent();
    } catch(error) {
      if(error.name==='AbortError')return;
      renderChecks(error.message);previewCurrent(error.message);
    }
  }
  // Size and parts in a few words: 170 × 82 × 1.5–3 mm, and 3 layers (or zones).
  function designSize(data) {
    const thicknesses=(data.zones?.length?data.zones:data.layers).map(layer=>layer.thickness_mm),thinnest=Math.min(...thicknesses),thickest=Math.max(...thicknesses);
    return `${number(data.width_mm)} × ${number(data.height_mm)} × ${thinnest===thickest?number(thickest):`${number(thinnest)}–${number(thickest)}`} mm`;
  }
  // The cloud background is a decorative panel, not a terrain layer.
  function pieceWords(data) {
    const terrain=data.layers.filter(layer=>layer.kind!=='cloud').length,clouds=terrain<data.layers.length?' + clouds':'';
    return data.zones?.length?`1 piece · ${data.zones.length} color zones`:`${terrain>1?`${terrain} layers`:'1 piece'}${clouds}`;
  }
  function partsSummary() {
    const parts=result.parts,layers=parts.filter(part=>/^(Layer|Silhouette)/.test(part.name)).length,zones=result.zones?.length||0;
    const clouds=result.layers.some(layer=>layer.kind==='cloud');
    const words=[zones?`1 piece in ${zones} color zone${zones>1?'s':''}`:clouds?`${layers-1} terrain layers, cloud background`:layers===1?'1 piece':`${layers} layers`];
    for(const part of parts.filter(part=>!/^(Layer|Silhouette)/.test(part.name)))words.push(part.count>1?`${part.count} ${part.name.toLowerCase()}s`:part.name.toLowerCase());
    return `Parts: ${words.join(', ')}`;
  }
  function renderChecks(error=null) {
    const list=$('silhouette-check-list'),box=$('silhouette-checks');list.replaceChildren();
    const add=(level,text)=>{const item=document.createElement('li');item.className=level;item.textContent=text;list.append(item);};
    if(error){add('error',error);box.dataset.level='error';resultKey=null;renderLayerLine();return;}
    if(!result)return;
    result.warnings.forEach(warning=>add('warning',warning));
    (result.notes||[]).forEach(note=>add('note',note));
    if(settings.source==='route'&&!ctx.route)add('note','Upload a GPX route on the geography selection page to use its elevation profile; the slice is shown until then.');
    if(settings.source!=='ridgeline'&&layered()&&drawn('ridgeline'))add('note','The geography page shows a two-point ridgeline, which prints as one piece; choose a single-layer design (Custom, Edge-lit ridgeline, or Stencil lamp) to print it. The slice is shown until then.');
    if(['ridgeline','viewpoint'].includes(settings.source)&&!drawn(settings.source))add('note',`Draw a ${settings.source==='ridgeline'?'ridgeline':'viewpoint skyline'} in the geography page's profile panel to use it; the slice is shown until then.`);
    const plan=ridgePlan(),u=ctx.units();
    if(plan?.ridges&&result.zones?.length)add('note','Each color zone is a ridgeline detected from the viewpoint: what of it shows above the nearer ridges.');
    else if(plan?.ridges) {
      add('note','Each layer is a ridgeline detected from the viewpoint, nearest at the front; slice positions are not used.');
      if(plan.found>plan.count)add('note',`The geography page found ${plan.found} ridges; this design holds at most ${plan.max} layers, so they are grouped into ${plan.count}.`);
    } else if(plan)add('note',`Only ${plan.found} ridge${plan.found>1?'s were':' was'} detected; this design needs at least ${plan.min} layers, so it uses distance bands. Lower Beyond or face toward more mountains.`);
    else if(settings.source==='viewpoint'&&layered())add('note','Each layer is a distance band of the view, nearest ridges at the front; layer positions are set from the bands.');
    const size=designSize(result);
    add(result.warnings.length?'note':'ok',`${size} · lowest point ${number(result.min_profile_mm)} mm tall`);
    if(settings.mount==='stand')add('note','The stand feet print beside the piece in the same file.');
    box.dataset.level=result.warnings.length?'warning':'ok';
    $('silhouette-dimensions').textContent=size;
    // The parts list, with each part's size as printed.
    const parts=$('silhouette-parts');parts.replaceChildren();
    const heading=document.createElement('strong');heading.textContent=partsSummary();parts.append(heading);
    const items=document.createElement('ul');
    const away=distance=>{const value=distance/u.distance;return `${result.ridges.length?'ridge':'band'} ${number(value,value<.1?2:1)} ${u.distanceLabel}`;};
    const zoneText=zone=>`${zone.name}${zone.distance_m===undefined?'':` · ${away(zone.distance_m)}`} · ${zone.thickness_mm.toFixed(1)} mm`;
    for(const part of result.parts) {
      const item=document.createElement('li');
      item.textContent=`${part.count>1?`${part.count} × `:''}${part.name} · ${part.size.map(value=>number(value)).join(' × ')} mm`;items.append(item);
      // A color-zone piece lists its zones under it, each with its filament color.
      if(/^Silhouette/.test(part.name))for(const zone of result.zones||[]) {
        const row=document.createElement('li'),swatch=document.createElement('i');swatch.style.background=zone.color;
        row.className='silhouette-zone-list';row.append(swatch,`${zoneText(zone)} · color ${zone.color}`);items.append(row);
      }
    }
    parts.append(items);
    const filaments=$('silhouette-filaments'),count=result.colors?.length||0;
    filaments.textContent=distanceColored()?`${count} of 4 filament colors`:'';filaments.classList.toggle('error',distanceColored()&&count>4);
    // Each layer front to back: its ridge's (or band's) distance from the viewpoint and its thickness.
    const rows=$('silhouette-layer-list');rows.replaceChildren();
    for(const zone of result.zones||[]) {
      const item=document.createElement('li'),swatch=document.createElement('i');swatch.style.background=zone.color;item.append(swatch,zoneText(zone));rows.append(item);
    }
    if(result.layers.length>1)for(const layer of result.layers) {
      const item=document.createElement('li'),swatch=document.createElement('i');swatch.style.background=layer.color;
      const away=layer.distance_m/u.distance,where=layer.distance_m===undefined?'':` · ${result.ridges.length?'ridge':'band'} ${number(away,away<.1?2:1)} ${u.distanceLabel}`;
      item.append(swatch,`${layer.name}${where} · ${layer.thickness_mm.toFixed(1)} mm`);rows.append(item);
    }
    renderLayerLine();
  }

  function renderLayerLine() {
    const root=$('silhouette-layer-axis'),hint=$('silhouette-layer-axis-hint'),cloudKey=$('silhouette-cloud-key');
    root.replaceChildren();cloudKey.replaceChildren();cloudKey.hidden=true;
    if(!preset().fields?.includes('layers'))return;
    if(!result||resultKey!==JSON.stringify(requestBody())){hint.textContent='Updating the layer regions…';return;}
    const layers=result.layers.filter(layer=>layer.kind!=='cloud'),u=ctx.units();
    const distance=result.profile==='viewpoint'&&Number.isFinite(result.view_farthest_m)&&result.view_farthest_m>0;
    const maximum=distance?result.view_farthest_m:100;
    const x=value=>16+208*clamp(value/maximum,0,1);
    const label=value=>distance?`${number(value/u.distance,value/u.distance<.1?2:1)} ${u.distanceLabel}`:`${number(value)}%`;
    root.setAttribute('viewBox',`0 0 240 ${52+layers.length*27}`);
    root.setAttribute('aria-label',distance?'Shaded terrain distance ranges, nearest layer first':'Slice positions across the frame, front layer first');
    svg('title',{},root).textContent=distance?'Terrain distance from the viewpoint':'Slice position across the frame';
    svg('line',{x1:16,x2:224,y1:23,y2:23,class:'layer-axis-tick'},root);
    for(let index=0;index<=4;index++){
      const value=maximum*index/4;
      svg('line',{x1:x(value),x2:x(value),y1:19,y2:27,class:'layer-axis-tick'},root);
      svg('text',{x:x(value),y:12,'text-anchor':index===0?'start':index===4?'end':'middle'},root).textContent=label(value);
    }
    layers.forEach((layer,index)=>{
      const y=45+index*27;
      svg('rect',{x:16,y,width:208,height:11,rx:2,class:'layer-axis-track'},root);
      const value=distance?layer.distance_m:layer.position,range=distance?layer.distance_range_m:null;
      const start=range?.[0]??value,end=range?.[1]??value;
      const region=svg('rect',{x:range?x(start):x(value)-2,y,width:range?Math.max(0,x(end)-x(start)):4,height:11,rx:1,
        fill:layer.color,'fill-opacity':.85,'data-layer':index+1,'data-start':start,'data-end':end},root);
      const empty=range&&end<=start;
      if(!empty)svg('circle',{cx:x(value),cy:y+5.5,r:3,fill:layer.color,stroke:'#fff0c3','stroke-width':1},root);
      svg('title',{},region).textContent=`Layer ${index+1}${index===0?' (front)':''}: ${range?`${label(start)}–${label(end)}`:label(value)} · ${layer.thickness_mm.toFixed(1)} mm`;
      svg('text',{x:16,y:y+22},root).textContent=`L${index+1}${index===0?' · front':''} · ${empty?'outside distance limit':label(value)} · ${layer.thickness_mm.toFixed(1)} mm`;
    });
    hint.textContent=distance?(result.ridges.length?'Shading shows approximate ridge distance groups; dots mark ridge distances.':'Shading shows distance bands; dots mark their representative distances.'):'Markers show slice positions across the frame; rows run front to back.';
    const cloud=result.layers.find(layer=>layer.kind==='cloud');
    if(cloud){cloudKey.hidden=false;const swatch=document.createElement('i');swatch.style.background=cloud.color;cloudKey.append(swatch,'Clouds · decorative rear panel');}
  }

  // ---------- front view: the design to scale, layers overlapped front to back as assembled ----------
  function draw() {
    if(ridgeDragging)return;
    const root=$('silhouette-svg'),refocus=document.activeElement?.classList?.contains('sil-caption-select');root.replaceChildren();
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
      svg('path',{class:'sil-body sil-layer','fill-rule':'evenodd',fill:layer.color,transform:`translate(0 ${-layer.y})`,d:polygonPath(layer.outline),
        ...(layer.kind==='cloud'?{}:{'data-ridge-body':result.ridge_curves?.[index]?.layer})},root);
    }
    const front=svg('g',{transform:`translate(0 ${-layers[0].y})`},root);
    // A color-zone piece draws each zone in its color.
    if(result.zones?.length)for(const zone of result.zones)svg('path',{class:'sil-body sil-zone','fill-rule':'evenodd',fill:zone.color,d:zone.polygons.map(polygonPath).join('')},front);
    else svg('path',{class:'sil-body','fill-rule':'evenodd',fill:layers.length>1||distanceColored()?layers[0].color:settings.body_color,d:polygonPath(result.outline),
      'data-ridge-body':result.ridge_curves?.[0]?.layer},front);
    let words=null;
    if(result.text.length) {
      const style=result.text_style,fill=style==='stencil'?'#101b14':settings.text_color;
      words=svg('path',{class:'sil-text','fill-rule':'evenodd',fill,stroke:style==='emboss'?'#00000088':'none','stroke-width':style==='emboss'?1:0,
        opacity:style==='engrave'?.85:1,d:result.text.map(polygonPath).join('')},front);
    }
    if(result.markings?.length)svg('path',{class:'sil-text','fill-rule':'evenodd',fill:settings.text_color,opacity:.8,d:result.markings.map(polygonPath).join('')},front);
    for(const peg of result.mount.filter(item=>item.kind==='peg'))svg('circle',{class:'sil-peg',cx:peg.x,cy:-peg.y,r:peg.d/2},front);
    for(const pin of result.mount.filter(item=>item.kind==='pin'))svg('rect',{class:'sil-pin',x:pin.x-pin.d/2,y:-pin.y1,width:pin.d,height:pin.y1-pin.y0},front);
    if(fit.tab)svg('rect',{class:'sil-fit',x:fit.tab.x0,y:0,width:fit.tab.x1-fit.tab.x0,height:-fit.tab.y0},root);
    if(fit.comb_base)svg('rect',{class:'sil-fit',x:0,y:-fit.comb_base.height,width:fit.comb_base.width,height:fit.comb_base.height},root);
    if(fit.combs)for(const x of [-.5,W+.5-fit.combs.width])svg('rect',{class:'sil-fit',x,y:-fit.combs.height,width:fit.combs.width,height:fit.combs.height},root);
    for(const foot of feet)svg('rect',{class:'sil-foot',x:foot.x0,y:-foot.y1,width:foot.x1-foot.x0,height:foot.y1-foot.y0},root);
    if(words&&result.text_box)captionHandle(root,front,words,result.text_box,layers[0].y,W,H,font,refocus);
    // Dimensions: width below, height at the right.
    const dims=svg('g',{class:'sil-dimension'},root),y=-low+pad*.7,x=right+pad*.9;
    svg('line',{x1:0,x2:W,y1:y,y2:y},dims);svg('line',{x1:0,x2:0,y1:y-pad*.2,y2:y+pad*.2},dims);svg('line',{x1:W,x2:W,y1:y-pad*.2,y2:y+pad*.2},dims);
    svg('line',{x1:x,x2:x,y1:0,y2:-H},dims);svg('line',{x1:x-pad*.2,x2:x+pad*.2,y1:0,y2:0},dims);svg('line',{x1:x-pad*.2,x2:x+pad*.2,y1:-H,y2:-H},dims);
    svg('text',{class:'sil-label',x:W/2,y:y+font*1.3,'font-size':font,'text-anchor':'middle'},root).textContent=`${number(W)} mm`;
    svg('text',{class:'sil-label',x:x+font*.5,y:-H/2,'font-size':font,'dominant-baseline':'middle'},root).textContent=`${number(H)} mm`;
    ridgeControls();
    if(ridgeEditing)drawRidgeHandles(root,font);
  }

  // ---------- direct ridge editing: select/delete panels and pull a smooth neighborhood of their crests ----------
  function ridgeControls() {
    const curves=result?.ridge_curves||[],ids=new Set(curves.map(curve=>curve.layer));
    const updating=Boolean(result)&&resultKey!==JSON.stringify(requestBody());
    ridgeSelection=new Set([...ridgeSelection].filter(id=>ids.has(id)));
    $('silhouette-ridge-edit').disabled=view!=='front'||!curves.length;
    $('silhouette-ridge-edit').setAttribute('aria-pressed',String(ridgeEditing));
    $('silhouette-ridge-actions').hidden=!ridgeEditing;
    const list=$('silhouette-ridge-list');list.hidden=!ridgeEditing;list.replaceChildren();
    if(ridgeEditing)for(const curve of curves) {
      const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=ridgeSelection.has(curve.layer);
      input.dataset.ridge=curve.layer;input.addEventListener('change',()=>{
        if(input.checked)ridgeSelection.add(curve.layer);else ridgeSelection.delete(curve.layer);
        updateRidgeSelection();
      });
      label.append(input,curve.name);list.append(label);
    }
    $('silhouette-ridge-delete').disabled=!ridgeSelection.size||ridgeSelection.size>=curves.length||ridgeDragging||updating;
    $('silhouette-ridge-undo').disabled=!ridgeUndo.length||ridgeDragging;
    $('silhouette-ridge-redo').disabled=!ridgeRedo.length||ridgeDragging;
    $('silhouette-ridge-reset').disabled=!settings.ridge_edits.length||ridgeDragging;
    $('silhouette-ridge-hint').textContent=!ridgeEditing?'Edit ridgelines in the front view. Changes also apply to exported models.'
      :ridgeSelection.size===curves.length?'Keep at least one ridgeline. Drag a curve to reshape it; Undo restores edits.'
      :`${ridgeSelection.size} selected · click a curve or its checkbox; Ctrl/Shift-click adds more. Drag the curve to reshape it. Delete removes selected ridges; keep at least one.`;
  }
  function updateRidgeSelection() {
    for(const line of $('silhouette-svg').querySelectorAll('.sil-ridge-line'))line.classList.toggle('selected',ridgeSelection.has(Number(line.dataset.ridge)));
    ridgeControls();
  }
  function commitRidgeEdits(edits) {
    ridgeUndo.push(structuredClone(settings.ridge_edits));if(ridgeUndo.length>40)ridgeUndo.shift();ridgeRedo=[];
    settings.ridge_edits=edits;save();ridgeControls();schedule();
  }
  function deleteRidges() {
    const curves=result?.ridge_curves||[];
    if(!ridgeSelection.size||ridgeSelection.size>=curves.length||ridgeDragging||resultKey!==JSON.stringify(requestBody()))return;
    const edits=structuredClone(settings.ridge_edits);
    for(const layer of ridgeSelection) {
      let edit=edits.find(item=>item.layer===layer);
      if(!edit){edit={layer,deleted:false,curve:[]};edits.push(edit);}
      edit.deleted=true;
    }
    commitRidgeEdits(edits);ridgeSelection.clear();
  }
  function ridgeHistory(undo) {
    if(ridgeDragging)return;
    const from=undo?ridgeUndo:ridgeRedo,to=undo?ridgeRedo:ridgeUndo;
    if(!from.length)return;
    to.push(structuredClone(settings.ridge_edits));settings.ridge_edits=from.pop();ridgeSelection.clear();save();ridgeControls();schedule();
  }
  function drawRidgeHandles(root,font) {
    const W=result.width_mm,curves=result.ridge_curves||[],zonedPiece=Boolean(result.zones?.length);
    for(const [order,ridge] of curves.entries()) {
      const lift=zonedPiece?result.layers[0].y:result.layers[order].y;
      const group=svg('g',{transform:`translate(0 ${-lift})`},root);
      const path=points=>points.map(([x,y],i)=>`${i?'L':'M'}${x} ${-y}`).join('');
      const line=svg('path',{class:`sil-ridge-line${ridgeSelection.has(ridge.layer)?' selected':''}`,stroke:ridge.color,d:path(ridge.curve),'data-ridge':ridge.layer},group);
      const hit=svg('path',{class:'sil-ridge-hit',d:path(ridge.curve),tabindex:0,role:'button','data-ridge':ridge.layer,
        'aria-label':`${ridge.name}: drag to reshape; Ctrl or Shift click to select multiple; Delete removes selected ridges`},group);
      svg('title',{},hit).textContent=`${ridge.name} · drag the curve to reshape it`;
      const grip=svg('circle',{class:'sil-ridge-grip',r:font*.4,visibility:'hidden'},group);
      const toMm=event=>{const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(root.getScreenCTM().inverse());return {x:p.x,y:-p.y-lift};};
      let drag=null;
      const preview=curve=>{
        const points=curve.map(([x,y])=>[x*W,ridge.base_mm+y*W]);
        line.setAttribute('d',path(points));hit.setAttribute('d',path(points));
        if(!zonedPiece) {
          const body=root.querySelector(`[data-ridge-body="${ridge.layer}"]`);
          if(body)body.setAttribute('d',polygonPath({outer:[[0,0],...points,[W,0]],holes:result.layers[order].outline.holes}));
        }
      };
      hit.addEventListener('pointerdown',event=>{
        if(event.button!==0||ridgeDragging||resultKey!==JSON.stringify(requestBody()))return;
        event.preventDefault();event.stopPropagation();hit.focus({preventScroll:true});
        if(event.ctrlKey||event.metaKey||event.shiftKey) {
          if(ridgeSelection.has(ridge.layer))ridgeSelection.delete(ridge.layer);else ridgeSelection.add(ridge.layer);
          updateRidgeSelection();return;
        }
        if(!ridgeSelection.has(ridge.layer))ridgeSelection=new Set([ridge.layer]);
        updateRidgeSelection();
        const raw=ridge.curve.map(([x,y])=>[x/W,Math.max(0,(y-ridge.base_mm)/W)]);
        const interpolate=x=>{let i=1;while(i<raw.length-1&&raw[i][0]<x)i++;const a=raw[i-1],b=raw[i];return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]||1);};
        let xs=[...new Set([...raw.map(p=>p[0]),...Array.from({length:257},(_,i)=>i/256)])].filter(x=>x>=0&&x<=1).sort((a,b)=>a-b);
        if(xs.length>1025)xs=Array.from({length:1025},(_,i)=>i/1024);
        const from=toMm(event);
        drag={pointer:event.pointerId,from,x:clamp(from.x/W,0,1),radius:Number($('silhouette-ridge-radius').value)/100,
          original:xs.map(x=>[x,interpolate(x)]),curve:null};
        ridgeDragging=true;clearTimeout(timer);request?.abort();hit.setPointerCapture(event.pointerId);
        grip.setAttribute('cx',from.x);grip.setAttribute('cy',-from.y);grip.setAttribute('visibility','visible');
        ridgeControls();
      });
      hit.addEventListener('pointermove',event=>{
        if(!drag||event.pointerId!==drag.pointer)return;
        const at=toMm(event),delta=(at.y-drag.from.y)/W,side=clamp((at.x-drag.from.x)/W,-drag.radius*.3,drag.radius*.3);
        // Compact smooth falloff: both displacement and slope reach zero at the edge of the pull region.
        drag.curve=drag.original.map(([x,y])=>{
          const t=Math.min(1,Math.abs(x-drag.x)/drag.radius),weight=(1-t*t)**2;
          // Taper sideways pulls at the ends and bound their size to keep x strictly increasing.
          const edge=Math.min(1,x/(drag.radius+.001),(1-x)/(drag.radius+.001));
          return [x+side*weight*edge,clamp(y+delta*weight,0,5)];
        });
        preview(drag.curve);grip.setAttribute('cx',at.x);grip.setAttribute('cy',-at.y);
      });
      const finish=cancel=>{
        if(!drag)return;
        const current=drag;drag=null;ridgeDragging=false;grip.setAttribute('visibility','hidden');
        if(hit.hasPointerCapture(current.pointer))hit.releasePointerCapture(current.pointer);
        if(!cancel&&current.curve&&current.curve.some((p,i)=>Math.hypot(p[0]-current.original[i][0],p[1]-current.original[i][1])*W>.02)) {
          const edits=structuredClone(settings.ridge_edits),edit={layer:ridge.layer,deleted:false,curve:current.curve.map(([x,y])=>[round(x,10),round(y,10)])};
          const i=edits.findIndex(item=>item.layer===ridge.layer);if(i<0)edits.push(edit);else edits[i]=edit;
          commitRidgeEdits(edits);
        } else {draw();ridgeControls();}
      };
      hit.addEventListener('pointerup',()=>finish(false));
      hit.addEventListener('pointercancel',()=>finish(true));
      hit.addEventListener('lostpointercapture',()=>finish(true));
      hit.addEventListener('keydown',event=>{
        if(event.key===' '||event.key==='Enter') {event.preventDefault();if(ridgeSelection.has(ridge.layer))ridgeSelection.delete(ridge.layer);else ridgeSelection.add(ridge.layer);updateRidgeSelection();}
        if(event.key==='Escape'&&drag){event.preventDefault();event.stopPropagation();finish(true);}
      });
    }
  }

  // The caption's selection graphic: a dashed box with a move grip, dragged anywhere on the front piece (or nudged with the
  // arrow keys, Shift for 5 mm). It snaps to the piece's center line and to the base strip's middle within 2 mm, showing a
  // guide; the server keeps it on material and the next outline shows where it landed.
  function captionHandle(root,front,words,box,lift,W,H,font,refocus) {
    const pad=1.2,guides={v:svg('line',{class:'sil-guide',x1:W/2,x2:W/2,y1:0,y2:-H},front),h:svg('line',{class:'sil-guide',x1:0,x2:W,y1:-box.default[1],y2:-box.default[1]},front)};
    guides.v.style.display=guides.h.style.display='none';
    const handle=svg('g',{class:'sil-caption-select',tabindex:0,role:'button','aria-label':'Caption position: drag to move it, or use the arrow keys (Shift: 5 mm steps)'},front);
    svg('title',{},handle).textContent='Drag to move the text · arrow keys nudge it';
    svg('rect',{class:'sil-caption-box',x:box.x0-pad,y:-box.y1-pad,width:box.x1-box.x0+2*pad,height:box.y1-box.y0+2*pad},handle);
    const grip=svg('g',{class:'sil-caption-grip',transform:`translate(${box.x0-pad} ${-box.y1-pad})`},handle),r=font*.6;
    svg('circle',{r},grip);svg('path',{d:`M${-r*.55} 0H${r*.55}M0 ${-r*.55}V${r*.55}`},grip);
    const toMm=event=>{const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(root.getScreenCTM().inverse());return {x:point.x,y:-point.y-lift};};
    const snap=(x,y)=>{
      const middle=Math.abs(x-W/2)<2,strip=Math.abs(y-box.default[1])<2;
      guides.v.style.display=middle?'':'none';guides.h.style.display=strip?'':'none';
      return {x:middle?W/2:x,y:strip?box.default[1]:y};
    };
    const show=at=>{const shift=`translate(${at.x-box.x} ${box.y-at.y})`;words.setAttribute('transform',shift);handle.setAttribute('transform',shift);};
    let drag=null;
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      event.preventDefault();handle.focus({preventScroll:true});handle.setPointerCapture?.(event.pointerId);handle.classList.add('dragging');
      drag={from:toMm(event),at:null};
    });
    handle.addEventListener('pointermove',event=>{
      if(!drag)return;
      const point=toMm(event);drag.at=snap(box.x+point.x-drag.from.x,box.y+point.y-drag.from.y);show(drag.at);
    });
    const drop=()=>{
      if(!drag)return;
      const at=drag.at;drag=null;handle.classList.remove('dragging');guides.v.style.display=guides.h.style.display='none';
      if(at)moveCaption(at.x,at.y);
    };
    handle.addEventListener('pointerup',drop);handle.addEventListener('pointercancel',drop);
    handle.addEventListener('keydown',event=>{
      const step=event.shiftKey?5:1,move={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,step],ArrowDown:[0,-step]}[event.key];
      if(!move)return;
      event.preventDefault();
      const at={x:(settings.text_x??box.x)+move[0],y:(settings.text_y??box.y)+move[1]};show(at);moveCaption(at.x,at.y);
    });
    if(refocus)handle.focus({preventScroll:true});
  }
  function moveCaption(x,y) {settings.text_x=round(x,1);settings.text_y=round(y,1);save();labels();schedule();}

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
  // The assembled design from an outline result, built into a group: the 3D view's and the Start from preview's (s: their settings).
  function fillDesign(group,result,s=settings) {
    const depth=s.text_depth,material=color=>new THREE.MeshStandardMaterial({color,roughness:.85});
    const extrude=(parent,shapes,amount,z,color)=>{
      const geometry=new THREE.ExtrudeGeometry(shapes,{depth:amount,bevelEnabled:false,curveSegments:4});geometry.translate(0,0,z);
      parent.add(new THREE.Mesh(geometry,material(color)));
    };
    const block=(x0,y0,z0,x1,y1,z1,color,opacity=1)=>{
      const geometry=new THREE.BoxGeometry(x1-x0,y1-y0,z1-z0);geometry.translate((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
      const mesh=new THREE.Mesh(geometry,material(color));if(opacity<1){mesh.material.transparent=true;mesh.material.opacity=opacity;}
      group.add(mesh);
    };
    const outlineBox=(x0,y0,z0,x1,y1,z1,color)=>{
      const geometry=new THREE.EdgesGeometry(new THREE.BoxGeometry(x1-x0,y1-y0,z1-z0));geometry.translate((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
      group.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.45})));
    };
    const box=result.fit,layers=result.layers,W=result.width_mm;
    // Placements: each layer's bottom (y) and back face (z), each at its own thickness; a design without a fit stands with its middle at z = 0.
    const thickness=layer=>layer.thickness_mm??s.thickness_mm,shift=box.kind==='none'?-thickness(layers[0])/2:0;
    layers.forEach((layer,index)=>{
      const T=thickness(layer),piece=new THREE.Group();piece.position.set(0,layer.y,layer.z+shift);group.add(piece);
      // Color zones stand from the shared flat back, each at its own thickness, so thicker-when-closer shows as steps.
      if(!index&&result.zones?.length)result.zones.forEach(zone=>extrude(piece,zone.polygons.map(shapeOf),zone.thickness_mm,0,zone.color));
      else extrude(piece,[shapeOf(index?layer.outline:result.outline)],T,0,layers.length>1||distanceColored(s)?layer.color:s.body_color);
      if(index)return;
      if(result.text.length) {
        const shapes=result.text.map(shapeOf);
        if(result.text_style==='emboss')extrude(piece,shapes,depth,T,s.text_color);
        else if(result.text_style==='engrave')extrude(piece,shapes,depth,T-depth+.02,s.text_color);
        else extrude(piece,shapes,T+.1,-.05,'#101b14');  // cut through: shown as an opening
      }
      if(result.markings?.length)extrude(piece,result.markings.map(shapeOf),.6,T-.58,s.text_color);
      for(const peg of result.mount.filter(item=>item.kind==='peg')) {
        const geometry=new THREE.CylinderGeometry(peg.d/2,peg.d/2,peg.length,24);geometry.rotateX(Math.PI/2);geometry.translate(peg.x,peg.y,T+peg.length/2);
        piece.add(new THREE.Mesh(geometry,material(s.body_color)));
      }
    });
    const fitColor='#c8b48a';
    if(box.tab&&layers.length===1)block(box.tab.x0,box.tab.y0,-box.tab.thickness/2,box.tab.x1,0,box.tab.thickness/2,layers[0].color||s.body_color);
    if(box.comb_base) {
      const comb=box.comb_base,t=box.tab.thickness;
      block(0,0,-comb.depth/2,comb.width,comb.height,comb.depth/2,fitColor,.75);
      block(box.tab.x0,box.tab.y0,-t/2,box.tab.x1,0,t/2,fitColor,.75);
    }
    // The lamp base: a round LED base (a faint cylinder with its rims) a little wider than its slot, the slot dark on top.
    if(box.tab) {
      const radius=s.slot_length/2+20,height=30,base=new THREE.CylinderGeometry(radius,radius,height,64,1,true);base.translate(W/2,-height/2,0);
      const shell=new THREE.Mesh(base,new THREE.MeshStandardMaterial({color:'#d9c9a0',roughness:.6,transparent:true,opacity:.14,side:THREE.DoubleSide,depthWrite:false}));
      const rims=new THREE.EdgesGeometry(new THREE.CylinderGeometry(radius,radius,height,64),30);rims.translate(W/2,-height/2,0);
      const top=new THREE.CircleGeometry(radius,64);top.rotateX(-Math.PI/2);top.translate(W/2,-.05,0);
      group.add(shell,new THREE.LineSegments(rims,new THREE.LineBasicMaterial({color:'#d9c9a0',transparent:true,opacity:.55})),
        new THREE.Mesh(top,new THREE.MeshStandardMaterial({color:'#d9c9a0',roughness:.7,transparent:true,opacity:.22,depthWrite:false})));
      block(W/2-s.slot_length/2,-.4,-s.slot_width/2,W/2+s.slot_length/2,-.02,s.slot_width/2,'#141c16');
    }
    if(box.combs) {
      const comb=box.combs,front=box.box.depth/2;
      for(const x of [-.5,W+.5-comb.width])block(x,0,front-comb.length,x+comb.width,comb.height,front,fitColor,.85);
      outlineBox(-.5,0,-front,W+.5,box.box.height,front,'#d9c9a0');  // the box's inside, as a faint outline
    }
    const reach=clamp(result.height_mm*.5,30,90);
    for(const foot of result.mount.filter(item=>item.kind==='foot'))block(foot.x0,foot.y0,-reach/2,foot.x1,foot.y1,reach/2,'#876749');
    group.position.set(-W/2,0,0);
  }
  function rebuild3d(fit=false) {
    if(view!=='3d'||!three||!result)return;
    const group=three.group;
    group.traverse(child=>{child.geometry?.dispose();child.material?.dispose();});
    group.clear();
    fillDesign(group,result);
    if(fit||!three.fitted) {
      // Far enough back that the whole design (and its box, or the round lamp base below it) fits the view's width and height,
      // seen from a little above and to the right.
      const box=result.fit,W=result.width_mm,below=box.tab?30:0,height=Math.max(result.height_mm,box.box?.height||0)+below;
      const width=Math.max(W,box.box?.width||0,box.tab?settings.slot_length+40:0),middle=height/2-below;
      const tangent=Math.tan(THREE.MathUtils.degToRad(three.camera.fov/2));
      const distance=Math.max(height/2/tangent,width/2/(tangent*three.camera.aspect))*1.3;
      three.controls.target.set(0,middle,0);
      three.camera.position.set(distance*.3,middle+distance*.3,distance*.9);
      three.controls.update();three.fitted=true;
    }
  }
  function setView(next) {
    if(ridgeDragging)return;
    view=next;
    if(view!=='front')ridgeEditing=false;
    ridgeControls();
    document.querySelectorAll('[data-silhouette-view]').forEach(button=>{const active=button.dataset.silhouetteView===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    $('silhouette-svg').style.display=view==='front'?'':'none';$('silhouette-3d').hidden=view!=='3d';
    $('silhouette-view-hint').textContent=view==='front'?'Front view to scale · the grid is 10 mm':'Drag to orbit · scroll to zoom';
    if(view==='3d'&&setup3d()){resize3d();rebuild3d(true);three.renderer.setAnimationLoop(()=>{three.controls.update();three.renderer.render(three.scene,three.camera);});}
    else if(three)three.renderer.setAnimationLoop(null);
    if(view==='front')draw();
  }

  // ---------- Start from preview: the hovered (or keyboard-focused) preset on a turntable, or the current design ----------
  // A preset is previewed from an outline request with its settings applied to a copy of the current ones (nothing is saved).
  // Results are cached by request body, so going back to a preset (or applying it) needs no new request.
  const turntable=createTurntable($('silhouette-turntable-view'),{label:'Design preview: drag to orbit',elevation:16});
  const previews=new Map();
  let hoverPreset=null,focusPreset=null,previewTimer=null,previewRequest=null;
  const previewKey=body=>`${ctx.state.id}:${JSON.stringify(body)}`;
  function remember(body,data) {previews.set(previewKey(body),data);if(previews.size>16)previews.delete(previews.keys().next().value);}
  function previewCaption(id,text,state='') {
    $('silhouette-turntable-title').textContent=`Preview · ${(PRESETS.presets[id]||PRESETS.presets.custom).name}`;
    const line=$('silhouette-turntable-size');line.textContent=text;line.classList.toggle('error',state==='error');
    $('silhouette-turntable').dataset.state=state;
  }
  function showPreview(id,data,s) {
    if(!data.layers?.length||!data.outline?.outer.length){turntable.clear();previewCaption(id,'Nothing to show for this slice.','error');return;}
    turntable.show(group=>fillDesign(group,data,s));previewCaption(id,`${designSize(data)} · ${pieceWords(data)}`);
  }
  // The current design, once its outline is in (or the error that stopped it), unless a preset is being previewed.
  function previewCurrent(error=null) {
    const id=hoverPreset??focusPreset;
    if(!dialog.open||(id!==null&&id!==settings.preset))return;
    previewRequest?.abort();previewRequest=null;
    const data=previews.get(previewKey(requestBody()));
    if(data)showPreview(settings.preset,data,settings);
    else if(error){turntable.clear();previewCaption(settings.preset,error,'error');}
    else previewCaption(settings.preset,'Building preview…','loading');
  }
  function updatePreview() {
    clearTimeout(previewTimer);
    const id=hoverPreset??focusPreset;
    if(id===null||id===settings.preset)previewCurrent();
    else previewTimer=setTimeout(()=>previewPreset(id),150);
  }
  async function previewPreset(id) {
    if(!dialog.open||!ctx.state.id)return;
    const s=presetSettings(id),body=requestBody({},s),cached=previews.get(previewKey(body));
    previewRequest?.abort();previewRequest=null;
    if(cached)return showPreview(id,cached,s);
    const controller=previewRequest=new AbortController();
    previewCaption(id,'Building preview…','loading');
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/outline`,body,controller.signal);
      if(!response.ok)throw new Error(await errorMessage(response));
      const data=await response.json();remember(body,data);
      if(controller===previewRequest)showPreview(id,data,s);
    } catch(error) {
      if(error.name==='AbortError'||controller!==previewRequest)return;
      turntable.clear();previewCaption(id,error.message,'error');
    }
  }
  // Mouse or pen hover and keyboard focus preview a preset; a tap (no hover) just applies it.
  function wirePreview(button,id) {
    button.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch'){hoverPreset=id;updatePreview();}});
    button.addEventListener('pointerleave',()=>{if(hoverPreset===id){hoverPreset=null;updatePreview();}});
    button.addEventListener('focus',()=>{if(button.matches(':focus-visible')){focusPreset=id;updatePreview();}});
    button.addEventListener('blur',()=>{if(focusPreset===id){focusPreset=null;updatePreview();}});
  }

  // ---------- text editor: the caption as a block of lines, each with its own size, style, and letter spacing ----------
  // Edits go to a draft, previewed to scale with the server's outlines (POST /api/silhouette/text); OK applies it.
  let draft=null,draftTimer=null,draftRequest=null;
  function openEditor() {
    const base=settings.text_lines.length?settings.text_lines:(settings.text?settings.text.split('\n'):['']).map(text=>({text,size:settings.text_size,style:'bold',tracking:0}));
    draft={lines:structuredClone(base),align:settings.text_align,spacing:settings.line_spacing,style:settings.text_style,depth:settings.text_depth,color:settings.text_color};
    renderDraft();$('text-editor').showModal();
    $('text-editor-lines').querySelector('input')?.focus();
    previewDraft(0);
  }
  function renderDraft() {
    const list=$('text-editor-lines');list.replaceChildren();
    draft.lines.forEach((line,index)=>{
      const item=document.createElement('li'),field=(tag,attributes)=>Object.assign(document.createElement(tag),attributes);
      const text=field('input',{className:'text-editor-text',value:line.text,maxLength:60,placeholder:index?'Another line':'Your text'});
      text.setAttribute('aria-label',`Line ${index+1} text`);
      const size=field('input',{type:'number',min:1,max:40,step:.5,value:line.size});size.setAttribute('aria-label',`Line ${index+1} size (mm, capitals)`);
      const style=field('select',{});style.append(...Object.entries(TEXT_STYLES).map(([value,label])=>field('option',{value,textContent:label})));style.value=line.style;
      style.setAttribute('aria-label',`Line ${index+1} style`);
      const tracking=field('input',{type:'number',min:-20,max:100,step:5,value:line.tracking});tracking.setAttribute('aria-label',`Line ${index+1} letter spacing (%)`);
      const update=()=>{
        line.text=text.value.replace(/\s+/g,' ').slice(0,60);
        if(size.value!==''&&Number.isFinite(Number(size.value)))line.size=clamp(Number(size.value),1,40);
        line.style=style.value;
        if(tracking.value!==''&&Number.isFinite(Number(tracking.value)))line.tracking=clamp(Number(tracking.value),-20,100);
        previewDraft();
      };
      [text,size,tracking].forEach(input=>input.addEventListener('input',update));style.addEventListener('change',update);
      const actions=field('div',{className:'text-editor-row-actions'});
      const button=(label,title,disabled,act)=>{const b=field('button',{type:'button',className:'icon-button',textContent:label,title,disabled});b.setAttribute('aria-label',`${title} (line ${index+1})`);b.addEventListener('click',act);actions.append(b);};
      const swap=to=>{[draft.lines[index],draft.lines[to]]=[draft.lines[to],draft.lines[index]];renderDraft();previewDraft();};
      button('↑','Move up',!index,()=>swap(index-1));button('↓','Move down',index===draft.lines.length-1,()=>swap(index+1));
      button('×','Remove',draft.lines.length<2,()=>{draft.lines.splice(index,1);renderDraft();previewDraft();});
      item.append(text,size,style,tracking,actions);list.append(item);
    });
    $('text-editor-add').disabled=draft.lines.length>=MAX_TEXT_LINES;
    document.querySelectorAll('[data-text-align]').forEach(button=>{const active=button.dataset.textAlign===draft.align;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    $('text-editor-spacing').value=draft.spacing;$('text-editor-style').value=draft.style;$('text-editor-depth').value=draft.depth;$('text-editor-color').value=draft.color;
    $('text-editor-depth').disabled=draft.style==='stencil';
  }
  const draftBody=()=>({text_lines:draft.lines,text_align:draft.align,line_spacing:draft.spacing,text_style:draft.style});
  function previewDraft(delay=150) {
    clearTimeout(draftTimer);
    draftTimer=setTimeout(async()=>{
      draftRequest?.abort();const controller=draftRequest=new AbortController(),status=$('text-editor-status');
      try {
        const response=await postJSON('/api/silhouette/text',draftBody(),controller.signal);
        if(!response.ok)throw new Error(await errorMessage(response));
        const data=await response.json();if(controller!==draftRequest)return;
        drawDraft(data);status.classList.remove('error');
        status.textContent=data.missing.length?`The fonts cannot draw ${data.missing.join('')}; those characters are left as spaces.`:'';
      } catch(error) {
        if(error.name==='AbortError')return;
        status.classList.add('error');status.textContent=error.message;
      }
    },delay);
  }
  // The block to scale: its outlines centered in the preview, with the alignment edge as a guide.
  function drawDraft(data) {
    const root=$('text-editor-svg');root.replaceChildren();
    $('text-editor-size').textContent=data.text.length?`${number(data.width_mm)} × ${number(data.height_mm)} mm`:'No text';
    if(!data.text.length)return;
    const w=Math.max(data.width_mm,20),h=Math.max(data.height_mm,8),pad=Math.max(w,h)*.08;
    root.setAttribute('viewBox',[-w/2-pad,-h/2-pad,w+pad*2,h+pad*2].join(' '));root.setAttribute('preserveAspectRatio','xMidYMid meet');
    const edge={left:-data.width_mm/2,center:0,right:data.width_mm/2}[draft.align];
    svg('line',{x1:edge,x2:edge,y1:-h/2-pad,y2:h/2+pad},root);
    svg('path',{'fill-rule':'evenodd',d:data.text.map(polygonPath).join('')},root);
  }
  // OK: the block becomes the caption (blank lines at the ends dropped); one plain bold line of the usual size stays plain text.
  function applyDraft() {
    const lines=draft.lines.map(line=>({...line,text:line.text.trim()}));
    while(lines.length&&!lines.at(-1).text)lines.pop();
    while(lines.length&&!lines[0].text)lines.shift();
    settings.text_lines=lines;settings.text=lines.map(line=>line.text).join('\n');
    if(lines.length)settings.text_size=clamp(Math.max(...lines.map(line=>line.size)),2,30);
    Object.assign(settings,{text_align:draft.align,line_spacing:draft.spacing,text_style:draft.style,text_depth:draft.depth,text_color:draft.color.toLowerCase()});
    writeForm();save();schedule();$('text-editor').close();
  }
  function wireEditor() {
    $('silhouette-text-edit').addEventListener('click',openEditor);
    $('text-editor-add').addEventListener('click',()=>{
      const last=draft.lines.at(-1)||{size:settings.text_size,style:'bold',tracking:0};
      draft.lines.push({text:'',size:Math.max(1,Math.round(last.size*.6*2)/2),style:last.style==='bold'?'regular':last.style,tracking:0});
      renderDraft();$('text-editor-lines').querySelector('li:last-child input')?.focus();previewDraft();
    });
    document.querySelectorAll('[data-text-align]').forEach(button=>button.addEventListener('click',()=>{draft.align=button.dataset.textAlign;renderDraft();previewDraft(0);}));
    $('text-editor-spacing').addEventListener('input',event=>{const value=Number(event.target.value);if(event.target.value!==''&&Number.isFinite(value)){draft.spacing=clamp(value,1,3);previewDraft();}});
    $('text-editor-style').addEventListener('change',event=>{draft.style=event.target.value;renderDraft();previewDraft(0);});
    $('text-editor-depth').addEventListener('input',event=>{const value=Number(event.target.value);if(Number.isFinite(value))draft.depth=clamp(value,.2,5);});
    $('text-editor-color').addEventListener('input',event=>{draft.color=event.target.value;});
    $('text-editor-ok').addEventListener('click',applyDraft);
    $('text-editor-cancel').addEventListener('click',()=>$('text-editor').close());
    $('text-editor').addEventListener('close',()=>{clearTimeout(draftTimer);draftRequest?.abort();});
    // Back to a plain caption: the first three lines at the largest size, bold.
    $('silhouette-text-plain').addEventListener('click',()=>{
      settings.text=cleanText(settings.text);settings.text_lines=[];writeForm();save();schedule();
    });
    $('silhouette-text-reset').addEventListener('click',()=>{settings.text_x=settings.text_y=null;save();labels();schedule();});
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

  // CylinderLamp: the layers' ridge curves go to the lamp app (started if needed), which opens in a new tab.
  async function cylinderLamp() {
    if(busy||!ctx.state.id)return;
    const status=$('silhouette-status'),button=$('silhouette-cylinder-lamp');
    const tab=window.open('','_blank');      // opened now, while the click still allows a new tab
    busy=true;button.disabled=true;status.classList.remove('error');status.textContent='Handing the layers to CylinderLamp…';
    try {
      const response=await postJSON(`/api/silhouette/${ctx.state.id}/cylinder-lamp`,{...requestBody(),name:placeName()});
      if(!response.ok)throw new Error(await errorMessage(response));
      const result=await response.json();
      if(!result.running)throw new Error('CylinderLamp is not running and could not be started. Start it (./run.sh in its folder), then try again.');
      if(tab)tab.location=result.url;else window.open(result.url,'_blank');
      status.textContent=`${result.layers} layer${result.layers===1?'':'s'} opened in CylinderLamp.`;
    } catch(error){tab?.close();status.classList.add('error');status.textContent=error.message;ctx.notify(error.message,true);}
    finally{busy=false;button.disabled=false;}
  }

  // Colors only repaint (the outline is unchanged); the preview's cached outline is shown in the new colors.
  function repaint() {draw();rebuild3d();if(result)remember(requestBody(),result);previewCurrent();}
  function wire() {
    buildPresetList();wireEditor();
    $('silhouette-ridge-edit').addEventListener('click',()=>{ridgeEditing=!ridgeEditing;ridgeControls();draw();});
    $('silhouette-ridge-delete').addEventListener('click',deleteRidges);
    $('silhouette-ridge-undo').addEventListener('click',()=>ridgeHistory(true));
    $('silhouette-ridge-redo').addEventListener('click',()=>ridgeHistory(false));
    $('silhouette-ridge-reset').addEventListener('click',()=>{if(settings.ridge_edits.length)commitRidgeEdits([]);});
    $('silhouette-ridge-radius').addEventListener('input',()=>{$('silhouette-ridge-radius-value').textContent=`${$('silhouette-ridge-radius').value}%`;});
    dialog.addEventListener('keydown',event=>{
      if(!ridgeEditing||event.target.closest('textarea,select,[contenteditable="true"],.sil-caption-select')||
        (event.target.closest('input')&&!event.target.matches('#silhouette-ridge-list input')))return;
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteRidges();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();ridgeHistory(!event.shiftKey);}
      if(event.key==='Escape'&&!ridgeDragging){event.preventDefault();ridgeSelection.clear();updateRidgeSelection();}
    });
    $('silhouette-back').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{
      clearTimeout(timer);clearTimeout(previewTimer);request?.abort();previewRequest?.abort();if(three)three.renderer.setAnimationLoop(null);
      hoverPreset=focusPreset=null;turntable.setActive(false);if($('text-editor').open)$('text-editor').close();
    });
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
      'silhouette-text','silhouette-trim-start','silhouette-trim-end','silhouette-layer-positions','silhouette-finish-time',...DISTANCE_IDS,'silhouette-pieces'];
    for(const id of inputs) {
      const element=$(id),settled=id.endsWith('color')||element.type==='color'||element.tagName==='SELECT'||element.type==='checkbox'||id==='silhouette-layer-positions';
      element.addEventListener(settled?'change':'input',()=>{
        readForm(id);save();
        // Colors only repaint; everything else changes the outline.
        if(id.endsWith('color')&&!layered())repaint();else schedule();
      });
    }
    for(const id of Object.values(COLORS))$(id).addEventListener('input',()=>{readForm(id);if(!layered())repaint();});
    document.querySelectorAll('[data-race-kind]').forEach(button=>button.addEventListener('click',()=>{
      settings.race_kind=button.dataset.raceKind;settings.tick_every=settings.race_kind==='cycling'?10:1;
      writeForm();save();schedule();
    }));
    document.querySelectorAll('[data-silhouette-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.silhouetteView)));
    document.querySelectorAll('[data-silhouette-export]').forEach(button=>button.addEventListener('click',()=>exportFile(button.dataset.silhouetteExport)));
    $('silhouette-cylinder-lamp').addEventListener('click',cylinderLamp);
    new ResizeObserver(()=>{if(dialog.open&&view==='front')draw();}).observe($('silhouette-view'));
  }
  wire();

  return {
    open() {
      if(!ctx.state.data)return;
      load();syncSlice();
      // The page opens on the profile the geography page's chart shows: its straight slice, two-point ridgeline, or
      // viewpoint. Route designs keep their GPX route; a ridgeline prints as one piece, so layered designs keep the slice.
      const chart=ctx.profile?.settings.mode==='viewridge'?'viewpoint':(ctx.profile?.settings.mode||'slice');
      if(PRESETS.presets[settings.preset]?.settings?.source!=='route') {
        let source=drawn(chart)?chart:(['true','shaped'].includes(settings.source)?settings.source:'true');
        if(source==='ridgeline'&&layered())source=['true','shaped'].includes(settings.source)?settings.source:'true';
        if(source!==settings.source) {
          settings.source=source;
          if(source==='viewpoint'&&preset().rules?.distance_thickness)settings.thickness_by_distance=true;
          writeForm();save();
        }
      }
      followRidges();
      $('silhouette-title').textContent=placeName()||'Your landscape';
      if(!dialog.open)dialog.showModal();
      turntable.setActive(true);previewCaption(settings.preset,'Building preview…','loading');
      setView(view);sliceLabel();refresh();
    },
    close(){if(dialog.open)dialog.close();},
    // A new area, multiplier, elevation profile, route, units, or map layers on the geography page: reload this area's settings and redraw.
    modelChanged() {
      if(!dialog.open||!ctx.state.data)return;
      if(areaKey()!==storeKey){load();three&&(three.fitted=false);}
      $('silhouette-title').textContent=placeName()||'Your landscape';
      followRidges();syncSlice();labels();schedule();
    },
  };
}
