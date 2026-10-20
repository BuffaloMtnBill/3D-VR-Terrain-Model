// The left-wrist watch: tap its dial with a fingertip and a large radial menu opens about five feet in front of you,
// with the map generator's options; point at an option with either hand's laser and pinch (or pull the trigger) to
// choose it. Every choice drives the page's own control, so the page (and the computer following it) stays in step. Search opens a keyboard that types into the page's address / ZIP search.
// The right-wrist button: Generate in Map Selection (then the model view), Map in the model view.
import * as THREE from 'three';
import {mercatorPixel,rotationAngle} from './selection-geometry.js';
import {createVoice} from './vr-voice.js';
import {buzz,click,tick} from './sounds.js';
import {COMMANDS} from './vr-commands.js';

const $=id=>document.getElementById(id);
const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
const UI={ink:'#fff6d6',muted:'#a9ae99',accent:'#e9c890',fill:'#101b14eb',raised:'#223329',hover:'#35503a',active:'#4b6d46',line:'#5c6448',
  sans:'Inter,"Segoe UI",Arial,sans-serif'};
const STALK=.06;   // how far (m) the watch and the wrist button stand out from the back of the wrist
// The voice cheat sheet on the back of the left forearm: how far up the arm from the wrist and out from it (m), and how
// squarely the back of the arm must face the eyes (cosine) for it to show, as when you turn your arm to read a watch.
const SHEET={along:.13,out:.03,facing:.5};
const POKE={touch:.012,release:.025,hover:.07};   // fingertip distance (m) from a surface that presses it, lets it go, lights it
// The menus, the keyboard, and the shape editor: large, about five feet (1.5 m) away, chosen with the lasers.
const FAR={distance:1.52,scale:3,laser:4};   // m; how much larger than their drawn size; laser length (m) with nothing hit
const SEARCH_ZOOM=11;   // a place searched from VR opens at city scale: the map's zoom for the page's frame
const title=word=>word[0].toUpperCase()+word.slice(1);
const short=text=>text.replace(/\s*·.*$/,'').replace(/\s*\(.*\)\s*$/,'').trim();
const shown=el=>Boolean(el)&&!el.closest('[hidden]');
function labelOf(el) {
  const label=(el.id&&document.querySelector(`label[for="${el.id}"]`))||el.closest('label');
  return (label?.textContent||el.getAttribute('aria-label')||el.id).replace(/\s+/g,' ').trim();
}

// A flat canvas in the room you can point at or poke: regions are hit-tested in canvas pixels.
function surface(name,width,height,pixels) {
  const canvas=document.createElement('canvas');canvas.width=pixels;canvas.height=Math.round(pixels*height/width);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false,toneMapped:false}));
  mesh.name=name;mesh.renderOrder=1100;mesh.visible=false;
  return {name,mesh,canvas,texture,width,height,regions:[],signature:'',
    context:canvas.getContext('2d'),
    toCanvas(local){return {x:(local.x/width+.5)*canvas.width,y:(.5-local.y/height)*canvas.height};},
    regionAt(x,y){return this.regions.find(region=>!region.disabled&&region.contains(x,y))||null;}};
}

export function createWatch(ctx,{rig,camera,joint,hands,exit,mode,generate,showMap,relief,applyShape,voiceCommands,backgrounds}) {
  const face=surface('watch',.045,.045,256),radial=surface('radial menu',.42,.42,1024),keyboard=surface('keyboard',.62,.27,1600);
  const wrist=surface('wrist button',.075,.04,512),editor=surface('shape editor',.42,.5,1024);
  const caption=surface('caption',.3,.05,768);   // what a voice command was heard as, for a moment
  const sheet=surface('voice cheat sheet',.16,.115,1024);   // the voice commands, on the back of the left forearm
  for(const s of [face,radial,keyboard,wrist,editor,caption,sheet])rig.add(s.mesh);
  face.mesh.renderOrder=1050;
  let menu=null,text='',hovered=new Set(),lastStatus='',voiceNote='';
  // Voice search: the words heard replace the text in the box, to check (or fix) before tapping Search.
  const voice=createVoice({api:ctx.api,onText:heard=>{text=heard;voiceNote='';keyboard.signature='';},onError:message=>{voiceNote=message;keyboard.signature='';}});
  const surfaces=[face,radial,keyboard,wrist,editor];
  const far=[radial,keyboard,editor];   // pointed at with the lasers; the watch and wrist button are touched
  for(const s of far)s.mesh.scale.setScalar(FAR.scale);
  // A laser from each hand (its pointing ray), shown while one of the far panels is up, with a dot where it lands.
  const lasers=hands.map(hand=>{
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-1)]),
      new THREE.LineBasicMaterial({color:0xe9c890,transparent:true,opacity:.75,depthTest:false}));
    const dot=new THREE.Mesh(new THREE.SphereGeometry(.012,12,8),new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false}));
    line.renderOrder=dot.renderOrder=1200;line.visible=dot.visible=false;line.name='VR laser';rig.add(line,dot);
    return {hand,line,dot};
  });
  const raycaster=new THREE.Raycaster(),rayOrigin=new THREE.Vector3(),rayDirection=new THREE.Vector3();

  // ---------- menu contents, read live from the page ----------
  const selectItems=el=>[...el.options].filter(option=>!option.disabled&&!option.hidden&&option.value!=='custom').map(option=>({
    label:short(option.textContent),active:option.value===el.value,press:()=>{el.value=option.value;fire(el,'input');fire(el,'change');}}));
  const rangeItems=el=>{
    const step=Number(el.step||1),set=value=>{
      const min=Number(el.min||0),max=Number(el.max||100),snapped=Math.min(max,Math.max(min,Math.round((value-min)/step)*step+min));
      el.value=String(Number(snapped.toFixed(6)));fire(el,'input');fire(el,'change');};
    // Spoken as words: "plus", "minus ten", …
    const said={'−−':['minus ten','down ten','much less'],'−':['minus','down','less'],'+':['plus','up','more'],'++':['plus ten','up ten','much more']};
    return [['−−',-10],['−',-1],['+',1],['++',10]].map(([label,steps])=>({label,aliases:said[label],local:true,press:()=>set(Number(el.value)+steps*step)}));
  };
  const SPOKEN={'feature-at':['appalachian trail']};   // labels too short to listen for as they are
  const features=()=>[...document.querySelectorAll('#style-editor input[type=checkbox][id^="feature-"]')].filter(shown).map(el=>({
    key:el.id.replace('feature-',''),label:short(labelOf(el)),aliases:SPOKEN[el.id],active:el.checked,press:()=>el.click()}));
  const chosen=el=>el?short([...el.options].find(option=>option.value===el.value)?.textContent||''):'';
  const onCount=items=>`${items.filter(item=>item.active).length} on`;
  // Layers come in groups of switches; any not in a group (Buildings, and any added later) sit beside the groups.
  const GROUPS=[['transport','Roads & rail',['roads','railways'],['roads and rail','transport']],['boundaries','Boundaries',['borders','cities','parks'],[]],
    ['outdoors','Outdoors',['water','at','trails'],['outdoor']]];
  const grouped=GROUPS.flatMap(([, ,keys])=>keys),inGroup=keys=>features().filter(f=>keys.includes(f.key));
  // The menus, a few options to a ring. An item with `open` opens that menu; `local` items (steps, Exit's confirm)
  // can be said only while on show. `detail` is the current value, shown under the label.
  const MENUS={
    root:{title:'Map options',items:()=>[
      {key:'search',label:'Search',press:()=>openKeyboard()},
      {key:'shape',label:'Area',aliases:['shape'],detail:title(ctx.state.selection?.shape||'rectangle'),press:()=>openEditor()},
      {key:'terrain',label:'Terrain',open:'terrain',detail:chosen($('resolution'))},
      {key:'layers',label:'Layers',aliases:['features','map features'],open:'layers',detail:onCount(features())},
      {key:'settings',label:'Settings',open:'settings',detail:relief.on?'3D relief':'Flat map'}]},
    terrain:{title:'Terrain',items:()=>[
      {key:'source',label:'Source',aliases:['elevation source'],open:'source',detail:chosen($('elevation-source'))},
      {key:'detail',label:'Detail',aliases:['terrain detail'],open:'detail',detail:chosen($('resolution'))},
      {key:'profile',label:'Profile',aliases:['elevation profile'],open:'profile',detail:chosen($('relief-method'))},
      {key:'multiplier',label:'Multiplier',open:'multiplier',detail:$('exaggeration-value')?.textContent||$('exaggeration').value},
      {key:'base',label:'Base',aliases:['base thickness'],open:'base',detail:$('base-value')?.textContent||$('base').value}]},
    source:{title:'Elevation source',items:()=>selectItems($('elevation-source'))},
    detail:{title:'Terrain detail',items:()=>selectItems($('resolution'))},
    profile:{title:'Elevation profile',items:()=>selectItems($('relief-method'))},
    multiplier:{title:'Elevation multiplier',value:()=>$('exaggeration-value')?.textContent||$('exaggeration').value,items:()=>rangeItems($('exaggeration'))},
    base:{title:'Base thickness',value:()=>$('base-value')?.textContent||$('base').value,items:()=>rangeItems($('base'))},
    // Shared by both modes; the model view adds its contour lines.
    layers:{title:'Layers',items:()=>[
      ...GROUPS.filter(([, ,keys])=>inGroup(keys).length).map(([key,label,keys,aliases])=>({key,label,aliases,open:key,detail:onCount(inGroup(keys))})),
      ...features().filter(f=>!grouped.includes(f.key)),
      ...(mode()==='model'?[{key:'contours',label:'Contour lines',aliases:['contours'],active:$('contours').checked,press:()=>$('contours').click()}]:[])]},
    ...Object.fromEntries(GROUPS.map(([key,label,keys])=>[key,{title:label,items:()=>inGroup(keys)}])),
    settings:{title:'Settings',items:()=>[
      ...(mode()==='map'?[{key:'relief',label:relief.on?'Flat map':'3D relief',aliases:['flat map','3d relief','relief'],press:()=>relief.toggle()}]:[]),
      {key:'voice',label:voiceCommands.on?'Voice: on':'Voice: off',aliases:['voice'],active:voiceCommands.on,press:()=>voiceCommands.toggle()},
      {key:'exit',label:'Exit VR',aliases:['exit'],open:'exit'}]},
    // Leaving VR takes a second, deliberate choice.
    exit:{title:'Leave VR?',items:()=>[{key:'confirm',label:'Yes, exit',aliases:['yes','exit','exit vr'],local:true,press:()=>exit()},
      {key:'stay',label:'Stay',aliases:['no','cancel'],local:true,press:()=>back()}]},
    // The model view's own menu: the sky around the model, what is drawn on it, and the settings.
    model:{title:'Model view',items:()=>[
      {key:'background',label:'Background',aliases:['backgrounds','sky'],open:'background',detail:backgrounds.list.find(b=>b.key===backgrounds.current)?.label},
      {key:'layers',label:'Layers',aliases:['on the model','display','features'],open:'layers',detail:onCount([...features(),{active:$('contours').checked}])},
      {key:'settings',label:'Settings',open:'settings',detail:voiceCommands.on?'Voice on':'Voice off'}]},
    background:{title:'Background',items:()=>backgrounds.list.map(b=>({key:b.key,label:b.label,aliases:b.aliases,active:backgrounds.current===b.key,press:()=>backgrounds.set(b.key)}))},
  };
  // A menu's items, with each `open` item opening its menu.
  const itemsOf=key=>MENUS[key].items().map(item=>item.open?{...item,press:()=>open(item.open)}:item);
  // The open menus, first to last: Back returns to the one before.
  let stack=[];
  const top=()=>mode()==='model'?'model':'root';
  function open(key){stack.push(key);menu=key;radial.signature='';}
  function back(){stack.pop();menu=stack.at(-1)||null;radial.signature='';if(!menu)closeMenu();}
  function openMenu(path=[]) {
    keyboard.mesh.visible=false;editor.mesh.visible=false;
    // Fixed in the room in front of you (not on the moving wrist), a little below eye level.
    place(radial.mesh,FAR.distance,-.15);radial.mesh.visible=true;
    stack=[top(),...path];menu=stack.at(-1);radial.signature='';
  }
  function closeMenu(){radial.mesh.visible=false;menu=null;stack=[];}
  // "Open terrain", "show layers", …: a menu by name, from wherever the watch is.
  function openNamed(name) {
    const key={backgrounds:'background',area:'shape'}[name]||name,item=itemsOf(top()).find(i=>i.key===key);
    if(!item)return false;
    if(item.open)openMenu([item.open]);else{closeMenu();item.press();}
    return true;
  }
  // Search starts empty every time: nothing from an earlier search is kept.
  function openKeyboard(keep='') {
    closeMenu();editor.mesh.visible=false;text=keep;
    place(keyboard.mesh,FAR.distance,-.35);keyboard.mesh.visible=true;keyboard.signature='';
  }
  function place(mesh,distance,drop) {
    const forward=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);forward.y=0;
    if(forward.lengthSq()<1e-6)forward.set(0,0,-1);
    forward.normalize();
    mesh.position.copy(camera.position).addScaledVector(forward,distance).add(new THREE.Vector3(0,drop,0));
    mesh.lookAt(camera.position);
  }
  // ---------- the shape editor: one window for the shape, its proportions, and its turn ----------
  // A vertical window in front of you: shape and aspect buttons, the shape itself with handles to grip and drag (the
  // side handle sets the width, the top one the height, the ring above turns it), and OK back to the menu. A change
  // is applied to the page's selection when you let go (the map under the box follows).
  const SHAPES=[['rectangle','Rectangle'],['circle','Circle'],['oval','Oval']],RATIOS=[['1:1',1],['4:3',4/3],['3:4',3/4],['16:9',16/9],['9:16',9/16]];
  const PREVIEW={x:512,y:690,half:280,ring:90};
  let draft=null,dragging=null;
  function draftFromPage() {
    const b=ctx.state.selection;if(!b)return {shape:'rectangle',ratio:1,angle:0};
    const nw=mercatorPixel(b.west,b.north),se=mercatorPixel(b.east,b.south);
    return {shape:b.shape||'rectangle',ratio:(se.x-nw.x)/Math.max(se.y-nw.y,1e-12),angle:rotationAngle(b)};
  }
  function openEditor() {
    closeMenu();keyboard.mesh.visible=false;draft=draftFromPage();
    place(editor.mesh,FAR.distance,0);editor.mesh.visible=true;editor.signature='';
  }
  function applyDraft() {applyShape({...draft});}
  const halves=d=>d.ratio>=1?{w:PREVIEW.half,h:PREVIEW.half/d.ratio}:{w:PREVIEW.half*d.ratio,h:PREVIEW.half};
  const turn=(x,y,a)=>({x:x*Math.cos(a)-y*Math.sin(a),y:x*Math.sin(a)+y*Math.cos(a)});   // canvas y runs down: clockwise
  function handles(d) {
    const {w,h}=halves(d),a=d.angle*Math.PI/180,at=(x,y)=>{const p=turn(x,y,a);return {x:PREVIEW.x+p.x,y:PREVIEW.y+p.y};};
    const list={rotate:at(0,-h-PREVIEW.ring)};
    if(d.shape!=='circle'){list.width=at(w,0);list.height=at(0,-h);}
    return list;
  }
  function drawEditor() {
    if(!editor.mesh.visible)return;
    const signature=JSON.stringify([draft,[...hovered],dragging?.name]);if(signature===editor.signature)return;editor.signature=signature;
    const c=editor.context,W=editor.canvas.width,H=editor.canvas.height;
    c.clearRect(0,0,W,H);c.fillStyle=UI.fill;c.beginPath();c.roundRect(0,0,W,H,40);c.fill();
    editor.regions=[];
    const button=(id,x,y,w,h,label,active,press,primary=false)=>{
      c.fillStyle=primary?UI.active:active?UI.active:hovered.has(id)?UI.hover:UI.raised;c.beginPath();c.roundRect(x+6,y+6,w-12,h-12,18);c.fill();
      if(active){c.lineWidth=5;c.strokeStyle=UI.accent;c.stroke();}
      c.fillStyle=UI.ink;c.font=`600 ${label.length>6?38:44}px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';c.fillText(label,x+w/2,y+h/2);
      editor.regions.push({id,press,contains:(px,py)=>px>=x&&px<=x+w&&py>=y&&py<=y+h});
    };
    c.fillStyle=UI.accent;c.font=`650 34px ${UI.sans}`;c.textAlign='left';c.textBaseline='middle';c.fillText('SHAPE',40,60);
    SHAPES.forEach(([key,label],i)=>button(`editor:shape:${key}`,30+i*321,100,321,110,label,draft.shape===key,()=>{
      draft.shape=key;if(key==='circle')draft.ratio=1;applyDraft();}));
    RATIOS.forEach(([label,ratio],i)=>button(`editor:aspect:${label}`,30+i*193,220,193,100,label,Math.abs(draft.ratio-ratio)<.01,()=>{
      draft.ratio=ratio;if(draft.shape==='circle'&&ratio!==1)draft.shape='oval';applyDraft();}));
    // The shape, turned, with its handles.
    const {w,h}=halves(draft),a=draft.angle*Math.PI/180;
    c.save();c.translate(PREVIEW.x,PREVIEW.y);c.rotate(a);
    c.beginPath();if(draft.shape==='rectangle')c.rect(-w,-h,2*w,2*h);else c.ellipse(0,0,w,h,0,0,Math.PI*2);
    c.fillStyle='#e9c89033';c.fill();c.lineWidth=8;c.strokeStyle='#ffe2a8';c.stroke();
    c.beginPath();c.moveTo(0,-h);c.lineTo(0,-h-PREVIEW.ring+26);c.lineWidth=4;c.strokeStyle=UI.muted;c.stroke();
    c.fillStyle=UI.muted;c.font=`600 30px ${UI.sans}`;c.textAlign='center';c.fillText('N',0,-h+40);
    c.restore();
    for(const [name,p] of Object.entries(handles(draft))) {
      const hot=dragging?.name===name||hovered.has(`editor:handle:${name}`);
      c.beginPath();c.arc(p.x,p.y,name==='rotate'?30:26,0,Math.PI*2);c.fillStyle=hot?'#ffffff':name==='rotate'?'#8fae78':UI.accent;c.fill();
      if(name==='rotate'){c.beginPath();c.arc(p.x,p.y,14,0,Math.PI*2);c.fillStyle=UI.fill;c.fill();}
      editor.regions.push({id:`editor:handle:${name}`,handle:name,contains:(px,py)=>Math.hypot(px-p.x,py-p.y)<70});
    }
    const ratioText=draft.ratio>=1?`${draft.ratio.toFixed(2)} : 1`:`1 : ${(1/draft.ratio).toFixed(2)}`;
    c.fillStyle=UI.ink;c.font=`500 36px ${UI.sans}`;c.textAlign='center';
    c.fillText(`${draft.shape==='circle'?'Circle':`Width : height ${ratioText}`} · turned ${Math.round(draft.angle)}°`,W/2,H-170);
    button('editor:ok',W/2-180,H-130,360,110,'OK',false,()=>{editor.mesh.visible=false;openMenu();},true);
    editor.texture.needsUpdate=true;
  }
  // Pinching a handle with the laser on it takes it; the handle then follows where the laser crosses the editor's plane
  // (the map is never gripped while a menu is up).
  const plane=new THREE.Plane(),crossing=new THREE.Vector3();
  function canvasAt(hand) {
    if(!aimRay(hand))return null;
    editor.mesh.updateMatrixWorld();
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0,0,1).transformDirection(editor.mesh.matrixWorld),editor.mesh.getWorldPosition(new THREE.Vector3()));
    if(!raycaster.ray.intersectPlane(plane,crossing))return null;
    return editor.toCanvas(editor.mesh.worldToLocal(crossing));
  }
  function dragStart(hand) {
    if(!editor.mesh.visible)return false;
    const p=canvasAt(hand);if(!p)return false;
    const region=editor.regions.find(r=>r.handle&&r.contains(p.x,p.y));if(!region)return false;
    dragging={hand,name:region.handle,start:{...draft,...halves(draft)}};editor.signature='';
    return true;
  }
  function dragMove(hand) {
    if(dragging?.hand!==hand)return;
    const p=canvasAt(hand);if(!p)return;
    const s=dragging.start,a=s.angle*Math.PI/180;
    const v=turn(p.x-PREVIEW.x,p.y-PREVIEW.y,-a);   // in the shape's own frame
    if(dragging.name==='width')draft.ratio=Math.min(5,Math.max(.2,Math.abs(v.x)/s.h));
    else if(dragging.name==='height')draft.ratio=Math.min(5,Math.max(.2,s.w/Math.max(Math.abs(v.y),1)));
    else {
      let angle=Math.atan2(p.x-PREVIEW.x,PREVIEW.y-p.y)*180/Math.PI;
      if(Math.abs(angle)<3)angle=0;   // a gentle snap back to north-up
      draft.angle=Math.round(angle);
    }
  }
  function dragEnd(hand) {
    if(dragging?.hand!==hand)return;
    dragging=null;editor.signature='';applyDraft();
  }

  // The page does the search; the headset is told how it went: the place found as a caption, or, when nothing is
  // found (or the search fails), the keyboard back with your text and the reason, to fix and try again.
  let searching=null;
  function search() {
    keyboard.mesh.visible=false;
    const input=$('place-search'),form=$('place-form');
    if(!input||!form)return;
    if(text.trim().length<2){voiceNote='Type (or say) at least two letters.';keyboard.mesh.visible=true;keyboard.signature='';return;}
    input.value=text;searching={text,since:performance.now(),selection:JSON.stringify(ctx.state.selection)};
    form.dataset.zoom=String(SEARCH_ZOOM);   // read by the page's search
    form.requestSubmit();
  }
  function followSearch() {
    if(!searching)return;
    const status=$('place-status'),button=$('place-form')?.querySelector('button'),waited=performance.now()-searching.since;
    if(button?.disabled&&waited<20000)return;   // still asking
    if(waited<60)return;                         // give the page a moment to start
    const moved=JSON.stringify(ctx.state.selection)!==searching.selection,failed=status?.classList.contains('error');
    const found=()=>status&&!status.hidden&&status.textContent?status.textContent.split(',').slice(0,2).join(','):searching.text;
    const again=()=>openKeyboard(searching.text);   // to fix and try again
    if(failed){voiceNote=status.textContent;again();}
    else if(moved)say(`📍 ${found()}`);
    else if(!button?.disabled&&waited>400&&status&&!status.hidden&&status.textContent)say(`📍 ${found()}`);   // the same place again
    else if(waited>=20000){voiceNote='No answer from the search. Try again.';again();}
    else return;   // not there yet
    if(!keyboard.mesh.visible){text='';const input=$('place-search');if(input)input.value='';}   // found: not kept
    delete $('place-form')?.dataset.zoom;
    searching=null;
  }

  function status() {
    const toast=$('toast'),place=$('place-status');
    if(toast&&!toast.hidden)return toast.textContent;
    if(place&&!place.hidden&&place.textContent)return place.textContent;
    return '';
  }

  // ---------- drawing ----------
  function wrapText(c,value,width,maxLines) {
    const words=String(value).split(/\s+/).filter(Boolean),lines=[];let line='';
    for(const word of words){const next=line?`${line} ${word}`:word;if(c.measureText(next).width>width&&line){lines.push(line);line=word;}else line=next;}
    if(line)lines.push(line);
    return lines.slice(0,maxLines);
  }
  function drawFace() {
    const c=face.context,s=face.canvas.width,open=radial.mesh.visible||keyboard.mesh.visible||editor.mesh.visible,hot=hovered.has('watch:face');
    const signature=`${open}:${hot}`;if(signature===face.signature)return;face.signature=signature;
    c.clearRect(0,0,s,s);
    c.beginPath();c.arc(s/2,s/2,s/2-8,0,Math.PI*2);c.fillStyle=hot?UI.hover:'#101b14';c.fill();c.lineWidth=10;c.strokeStyle=open?UI.ink:UI.accent;c.stroke();
    // A small radial menu as the dial.
    for(let i=0;i<8;i++){const a=i/8*Math.PI*2;c.beginPath();c.arc(s/2+Math.cos(a)*62,s/2+Math.sin(a)*62,13,0,Math.PI*2);c.fillStyle=UI.accent;c.fill();}
    c.beginPath();c.arc(s/2,s/2,26,0,Math.PI*2);c.fillStyle=UI.ink;c.fill();
    face.regions=[{id:'watch:face',contains:()=>true,press:()=>(radial.mesh.visible||keyboard.mesh.visible||editor.mesh.visible)?close():openMenu()}];
    face.texture.needsUpdate=true;
  }
  function drawRadial() {
    if(!radial.mesh.visible)return;
    const spec=MENUS[menu],items=itemsOf(menu),value=spec.value?.()||'',state=status();
    const signature=JSON.stringify([stack,items.map(item=>[item.label,item.active,item.detail]),value,state,[...hovered]]);
    if(signature===radial.signature)return;radial.signature=signature;
    const c=radial.context,S=radial.canvas.width,C=S/2,outer=500,inner=175,n=Math.max(items.length,1),slice=Math.PI*2/n;
    c.clearRect(0,0,S,S);radial.regions=[];
    items.forEach((item,i)=>{
      const start=-Math.PI/2+i*slice-slice/2,end=start+slice,id=`radial:${menu}:${item.key??i}`;
      c.beginPath();c.arc(C,C,outer,start,end);c.arc(C,C,inner,end,start,true);c.closePath();
      c.fillStyle=item.active?UI.active:hovered.has(id)?UI.hover:UI.fill;c.fill();c.lineWidth=4;c.strokeStyle=UI.line;c.stroke();
      const mid=(start+end)/2,r=(outer+inner)/2;
      c.fillStyle=item.active?'#fffbe8':UI.ink;c.font=`600 ${n>8?40:46}px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';
      const width=Math.min(250,2*r*Math.sin(slice/2)*.9),lines=wrapText(c,item.open?`${item.label} ▸`:item.label,width,2),x=C+Math.cos(mid)*r,y=C+Math.sin(mid)*r-(item.detail?20:0);
      lines.forEach((line,k)=>c.fillText(line,x,y+(k-(lines.length-1)/2)*48));
      if(item.detail){c.font=`500 30px ${UI.sans}`;c.fillStyle=item.active?'#fffbe8':UI.muted;c.fillText(wrapText(c,item.detail,width,1)[0]||'',x,y+lines.length*24+22);}
      radial.regions.push({id,press:item.press,contains:(x,y)=>{
        const dx=x-C,dy=y-C,distance=Math.hypot(dx,dy);if(distance<inner||distance>outer)return false;
        const angle=((Math.atan2(dy,dx)+Math.PI/2+slice/2)%(Math.PI*2)+Math.PI*2)%(Math.PI*2);
        return Math.floor(angle/slice)===i;}});
    });
    // The middle: the menu's name and value, and Back (or Close at the top level).
    const first=stack.length<2,backLabel=first?'Close':'‹ Back',hot=hovered.has('radial:center');
    c.beginPath();c.arc(C,C,inner-12,0,Math.PI*2);c.fillStyle=hot?UI.hover:'#0b140ef2';c.fill();c.lineWidth=4;c.strokeStyle=UI.accent;c.stroke();
    c.fillStyle=UI.accent;c.font=`650 30px ${UI.sans}`;c.textAlign='center';
    wrapText(c,spec.title.toUpperCase(),280,2).forEach((line,k)=>c.fillText(line,C,C-70+k*34));
    // Where this menu sits: the menus it was opened from.
    if(stack.length>2){c.fillStyle=UI.muted;c.font=`500 22px ${UI.sans}`;c.fillText(stack.slice(1,-1).map(key=>MENUS[key].title).join(' › ').slice(0,30),C,C-112);}
    if(value){c.fillStyle=UI.ink;c.font=`600 ${value.length>8?32:52}px ${UI.sans}`;c.fillText(value,C,C+5);}
    c.fillStyle=UI.muted;c.font=`600 34px ${UI.sans}`;c.fillText(backLabel,C,C+72);
    radial.regions.push({id:'radial:center',press:back,contains:(x,y)=>Math.hypot(x-C,y-C)<inner-12});
    if(state){c.font=`28px ${UI.sans}`;c.fillStyle=UI.ink;c.fillText(state.slice(0,70),C,S-6);}
    radial.texture.needsUpdate=true;
  }
  const ROWS=['1234567890','qwertyuiop','asdfghjkl,','zxcvbnm-.'];
  function drawKeyboard() {
    if(!keyboard.mesh.visible)return;
    const signature=JSON.stringify([text,[...hovered],voice.state,voiceNote]);if(signature===keyboard.signature)return;keyboard.signature=signature;
    const c=keyboard.context,W=keyboard.canvas.width,H=keyboard.canvas.height,pad=24,key=(W-2*pad)/10;
    c.clearRect(0,0,W,H);c.fillStyle=UI.fill;c.beginPath();c.roundRect(0,0,W,H,36);c.fill();
    keyboard.regions=[];
    const button=(id,x,y,w,h,label,press,primary=false)=>{
      c.fillStyle=primary?UI.active:hovered.has(id)?UI.hover:UI.raised;c.beginPath();c.roundRect(x+5,y+5,w-10,h-10,14);c.fill();
      c.fillStyle=UI.ink;c.font=`600 ${label.length>1?40:52}px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';c.fillText(label,x+w/2,y+h/2);
      keyboard.regions.push({id,press,contains:(px,py)=>px>=x&&px<=x+w&&py>=y&&py<=y+h});
    };
    // The text being typed, with a caret.
    c.fillStyle='#0b140e';c.beginPath();c.roundRect(pad,pad,W-2*pad,96,18);c.fill();
    const listening=voice.state==='listening'||voice.state==='starting',working=voice.state==='working';
    const shownText=listening?'Listening… say the place, then tap Stop':working?'Working out what you said…':voiceNote||(text?`${text}|`:'Address, place, or US ZIP code');
    c.fillStyle=text&&!listening&&!working&&!voiceNote?UI.ink:listening?UI.accent:UI.muted;c.font=`500 ${shownText.length>40?40:52}px ${UI.sans}`;
    c.textAlign='left';c.textBaseline='middle';c.fillText(shownText,pad+24,pad+50);
    const top=pad+110,row=(H-top-pad)/5;
    ROWS.forEach((keys,r)=>[...keys].forEach((k,i)=>button(`key:${k}`,pad+i*key+(r===2?key*.25:r===3?key*.5:0),top+r*row,key,row,k.toUpperCase(),()=>{text+=k;voiceNote='';})));
    const y=top+4*row;
    button('key:cancel',pad,y,key*2,row,'Cancel',()=>{voice.cancel();keyboard.mesh.visible=false;});
    button('key:voice',pad+key*2,y,key*2,row,voice.state==='listening'?'■ Stop':voice.state==='working'?'…':'🎤 Speak',()=>{voiceNote='';voice.toggle();},voice.state==='listening');
    button('key:space',pad+key*4,y,key*2,row,'Space',()=>{text+=' ';voiceNote='';});
    button('key:back',pad+key*6,y,key*2,row,'⌫',()=>{text=text.slice(0,-1);voiceNote='';});
    button('key:search',pad+key*8,y,key*2,row,'Search',search,true);
    keyboard.texture.needsUpdate=true;
  }

  // The Generate / Map button on the right wrist; it shows progress while the terrain is generated.
  function drawWrist() {
    const loading=ctx.state.loading,progress=Number($('progress')?.value)||0,inMap=mode()==='map',disabled=inMap&&!loading&&$('generate')?.disabled;
    const label=loading?`${Math.round(progress*100)}%`:inMap?'Generate':'◀ Map',hot=hovered.has('wrist:button');
    const signature=JSON.stringify([label,disabled,hot,loading]);if(signature===wrist.signature)return;wrist.signature=signature;
    const c=wrist.context,W=wrist.canvas.width,H=wrist.canvas.height;
    c.clearRect(0,0,W,H);c.beginPath();c.roundRect(8,8,W-16,H-16,60);c.fillStyle=disabled?'#3a3f36':hot?'#5b7e52':UI.active;c.fill();
    c.lineWidth=10;c.strokeStyle=UI.accent;c.stroke();
    if(loading){c.fillStyle='#e9c89055';c.beginPath();c.roundRect(8,8,(W-16)*progress,H-16,60);c.fill();}
    c.fillStyle=disabled?UI.muted:'#fffbe8';c.font=`700 ${label.length>6?92:110}px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';c.fillText(label,W/2,H/2+4);
    wrist.regions=[{id:'wrist:button',contains:()=>true,disabled:disabled||loading,press:()=>(mode()==='map'?generate():showMap())}];
    wrist.texture.needsUpdate=true;
  }

  // The voice commands for this mode: the spoken names of its menus come from the menu itself.
  function sheetLines() {
    const SAID={shape:'area'},menus=itemsOf(top()).filter(item=>item.open||item.key==='search'||item.key==='shape').map(item=>SAID[item.key]||item.key);
    return COMMANDS.filter(command=>!command.when||command.when===mode()).map(command=>command.name==='open-named'
      ?{say:'Open …',note:menus.join(', ')}:{say:command.label,note:''});
  }
  function drawSheet() {
    if(!sheet.mesh.visible)return;
    const lines=sheetLines(),on=voiceCommands.on,signature=JSON.stringify([lines,on]);
    if(signature===sheet.signature)return;sheet.signature=signature;
    const c=sheet.context,W=sheet.canvas.width,H=sheet.canvas.height;
    c.clearRect(0,0,W,H);c.fillStyle=UI.fill;c.beginPath();c.roundRect(0,0,W,H,42);c.fill();c.lineWidth=6;c.strokeStyle=UI.line;c.stroke();
    c.textBaseline='middle';c.textAlign='left';
    c.font=`700 52px ${UI.sans}`;c.fillStyle=UI.accent;c.fillText('🎤 Say…',44,62);
    c.textAlign='right';c.font=`600 38px ${UI.sans}`;c.fillStyle=on?'#9fd88f':UI.muted;c.fillText(on?'Voice on':'Voice off',W-44,62);
    c.textAlign='left';const row=Math.min(96,(H-250)/lines.length);
    lines.forEach((line,i)=>{
      const y=150+i*row;c.globalAlpha=on?1:.45;
      c.font=`600 46px ${UI.sans}`;c.fillStyle=UI.ink;c.fillText(`“${line.say}”`,44,y);
      if(line.note){const x=44+c.measureText(`“${line.say}” `).width;c.font=`400 34px ${UI.sans}`;c.fillStyle=UI.muted;c.fillText(line.note,x,y+2);}
    });
    c.globalAlpha=1;c.font=`400 32px ${UI.sans}`;c.fillStyle=UI.muted;
    c.fillText(on?'With a menu open: any option, “Back”, or “Close”':'Turn it on: Settings ▸ Voice',44,H-48);
    sheet.texture.needsUpdate=true;
  }

  // ---------- the watch on your left wrist, the button on your right ----------
  const handOf=side=>hands.find(hand=>hand.source?.handedness===side);
  const left=()=>handOf('left');
  function stalk() {
    const line=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xe9c890,transparent:true,opacity:.7,depthTest:false}));
    line.renderOrder=1150;line.name='VR wrist stalk';rig.add(line);return line;
  }
  function wear(s,hand,side) {
    s.mesh.visible=Boolean(hand);
    if(!hand){if(s.stem)s.stem.visible=false;return;}
    const wristJoint=hand.tracked&&joint(hand,'wrist'),index=hand.tracked&&joint(hand,'index-finger-metacarpal'),little=hand.tracked&&joint(hand,'pinky-finger-metacarpal');
    if(wristJoint&&index&&little) {
      // Standing out from the back of the wrist on a short stalk (the palm of the left hand faces b × a, of the right
      // a × b), well clear of the wrist itself, so a fingertip reaches it even when the tracked wrist angle is a little
      // off. It faces halfway between straight out of the wrist and your eyes, so it is easy to see and to tap.
      const a=index.position.clone().sub(wristJoint.position),b=little.position.clone().sub(wristJoint.position);
      const back=(side==='left'?a.clone().cross(b):b.clone().cross(a)).normalize();
      s.mesh.position.copy(wristJoint.position).addScaledVector(back,STALK);
      const eyes=camera.getWorldPosition(new THREE.Vector3());rig.worldToLocal(eyes);
      const facing=back.clone().add(eyes.sub(s.mesh.position).normalize()).normalize();
      s.mesh.lookAt(rig.localToWorld(s.mesh.position.clone().add(facing)));
      s.stem??=stalk();s.stem.visible=true;
      s.stem.geometry.setFromPoints([wristJoint.position.clone().addScaledVector(back,.012),s.mesh.position.clone()]);s.stem.geometry.computeBoundingSphere();
    } else {
      if(s.stem)s.stem.visible=false;
      // On top of the controller.
      hand.grip.updateMatrixWorld();
      s.mesh.position.copy(hand.grip.localToWorld(new THREE.Vector3(0,.035,.04)));
      s.mesh.lookAt(camera.position);
    }
  }

  // The cheat sheet lies along the back of the left forearm, a hand's width up from the watch, and shows while the back
  // of the arm is turned toward your eyes; its text stays level with your view. Holding a controller, it sits behind the
  // controller, toward the forearm.
  const eyesInRig=()=>rig.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
  function wearSheet(hand) {
    let wristAt,back,arm;
    const wristJoint=hand?.tracked&&joint(hand,'wrist'),index=hand?.tracked&&joint(hand,'index-finger-metacarpal'),little=hand?.tracked&&joint(hand,'pinky-finger-metacarpal');
    if(wristJoint&&index&&little) {
      const a=index.position.clone().sub(wristJoint.position),b=little.position.clone().sub(wristJoint.position);
      wristAt=wristJoint.position.clone();back=a.clone().cross(b).normalize();
      arm=a.add(b).multiplyScalar(-1);   // from the wrist toward the elbow
    } else if(hand?.grip) {
      hand.grip.updateMatrixWorld();
      wristAt=hand.grip.localToWorld(new THREE.Vector3(0,0,.05));
      back=new THREE.Vector3(-1,0,0).transformDirection(hand.grip.matrixWorld);   // the back of the left hand holding it
      arm=new THREE.Vector3(0,0,1).transformDirection(hand.grip.matrixWorld);
    } else {sheet.mesh.visible=false;return;}
    arm.addScaledVector(back,-arm.dot(back)).normalize();
    const at=wristAt.addScaledVector(arm,SHEET.along).addScaledVector(back,SHEET.out),toEyes=eyesInRig().sub(at).normalize();
    sheet.facing=back.dot(toEyes);
    sheet.mesh.visible=sheet.facing>SHEET.facing;
    if(!sheet.mesh.visible)return;
    // Facing halfway between the back of the arm and your eyes, with its lines running level across your view.
    const normal=back.clone().add(toEyes).normalize(),right=new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
    right.addScaledVector(normal,-right.dot(normal)).normalize();
    sheet.mesh.position.copy(at);
    sheet.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,normal.clone().cross(right),normal));
    sheet.at={wrist:wristAt.clone().addScaledVector(arm,-SHEET.along).addScaledVector(back,-SHEET.out),arm,back};
  }

  // ---------- tapping with a fingertip (the watch and the wrist button) ----------
  function pokeBy(point,hand) {
    for(const s of [face,wrist].filter(s=>s.mesh.visible)) {
      if(s===face&&hand===left()||s===wrist&&hand===handOf('right'))continue;   // not pressed by their own wrist
      const local=s.mesh.worldToLocal(point.clone());
      if(Math.abs(local.x)>s.width/2||Math.abs(local.y)>s.height/2)continue;
      return {surface:s,depth:Math.abs(local.z),...s.toCanvas(local)};
    }
    return null;
  }
  // ---------- pointing with the lasers (the menus, keyboard, and shape editor) ----------
  // A hand's pointing ray: the system's own for hands (steadied by the headset), or the controller's.
  function aimRay(hand) {
    if(!hand.source)return false;
    hand.controller.updateMatrixWorld();
    rayOrigin.setFromMatrixPosition(hand.controller.matrixWorld);
    rayDirection.set(0,0,-1).transformDirection(hand.controller.matrixWorld);
    raycaster.set(rayOrigin,rayDirection);
    return true;
  }
  function aimAt(hand) {
    const shown=far.filter(s=>s.mesh.visible);
    if(!shown.length||!aimRay(hand))return null;
    const hit=raycaster.intersectObjects(shown.map(s=>s.mesh),false)[0];if(!hit)return {point:null};
    const s=shown.find(x=>x.mesh===hit.object),x=hit.uv.x*s.canvas.width,y=(1-hit.uv.y)*s.canvas.height;
    return {point:hit.point,surface:s,region:s.regionAt(x,y)};
  }
  function drawLaser(hand,aim) {
    const laser=lasers.find(l=>l.hand===hand);if(!laser)return;
    laser.line.visible=Boolean(aim);laser.dot.visible=Boolean(aim?.point);
    if(!aim)return;
    const end=aim.point||rayOrigin.clone().addScaledVector(rayDirection,FAR.laser);
    laser.line.geometry.setFromPoints([rayOrigin,end]);laser.line.geometry.computeBoundingSphere();
    laser.dot.position.copy(end);laser.dot.material.color.set(aim.region?0xffffff:0xe9c890);
    laser.line.material.color.set(aim.region?0xffffff:0xe9c890);
  }
  // Called for each hand every frame with its fingertip, and `select` on the frame a pinch (or the trigger) begins.
  // The watch and wrist button: a region lights as the fingertip comes near and is pressed when it touches; it presses
  // again only after the fingertip lifts off. The far panels: the region under the laser lights, and a pinch presses
  // it. onUI is true while the hand is at the watch or pointing at a panel, so it never grips the map meanwhile.
  // A soft tick and the lightest buzz as the hand comes onto an option; a click and a firmer buzz as it is chosen.
  function light(hand,region) {
    const id=region?.id||null;
    if(id&&id!==hand.uiHover&&region.press&&!region.disabled){tick();buzz(hand,.15,12);}
    hand.uiHover=id;
  }
  function choose(hand,region) {
    if(!region?.press)return;
    if(!region.disabled){click();buzz(hand,.6,35);}
    region.press();
  }
  function pointer(hand,{fingertip,select=false}) {
    const touch=fingertip?pokeBy(fingertip,hand):null,near=touch&&touch.depth<POKE.hover;
    if(near) {
      drawLaser(hand,null);
      const region=touch.surface.regionAt(touch.x,touch.y);
      light(hand,region);
      if(touch.depth<POKE.touch){if(!hand.poking){hand.poking=true;choose(hand,region);}}
      else if(touch.depth>POKE.release)hand.poking=false;
      return {onUI:true};
    }
    hand.poking=false;
    const aim=aimAt(hand);drawLaser(hand,aim);
    light(hand,aim?.region);
    if(select)choose(hand,aim?.region);
    return {onUI:Boolean(aim?.point)};
  }

  function update() {
    wear(face,left(),'left');wear(wrist,handOf('right'),'right');wearSheet(left());
    for(const laser of lasers)if(!laser.hand.source)laser.line.visible=laser.dot.visible=false;
    hovered=new Set(hands.map(hand=>hand.uiHover).filter(Boolean));
    // Between drags the editor shows the page's selection as it is (after a change is applied, or from the computer).
    if(editor.mesh.visible&&!dragging)draft=draftFromPage();
    drawFace();drawRadial();drawKeyboard();drawWrist();drawEditor();drawSheet();
    followSearch();
    if(caption.mesh.visible&&performance.now()>captionUntil)caption.mesh.visible=false;
    const now=status();if(now!==lastStatus){lastStatus=now;radial.signature='';}
  }
  function close(){closeMenu();voice.cancel();keyboard.mesh.visible=false;editor.mesh.visible=false;dragging=null;lasers.forEach(l=>{l.line.visible=l.dot.visible=false;});}
  // A short caption in front of you: what a voice command was heard as.
  let captionUntil=0;
  let captionText='';
  function say(text) {
    captionText=text;
    const c=caption.context,W=caption.canvas.width,H=caption.canvas.height;
    c.clearRect(0,0,W,H);c.fillStyle=UI.fill;c.beginPath();c.roundRect(0,0,W,H,H/2);c.fill();
    let size=Math.round(H*.5);c.font=`600 ${size}px ${UI.sans}`;
    while(size>14&&c.measureText(text).width>W-H){size-=2;c.font=`600 ${size}px ${UI.sans}`;}   // long place names shrink to fit
    c.fillStyle=UI.accent;c.textAlign='center';c.textBaseline='middle';c.fillText(text,W/2,H/2+2);
    caption.texture.needsUpdate=true;place(caption.mesh,.6,-.22);caption.mesh.visible=true;captionUntil=performance.now()+2500;
  }

  // What can be said while a menu is open: each option on show, by its label (and any spoken names), and Back or
  // Close. Pressing it does exactly what tapping it would. With `everywhere`, any option in this mode's menus too
  // ("Fine", "Water", "Multiplier", …): the menu moves to where that option lives, then presses it.
  function voiceOptions(everywhere=false) {
    const options=[],press=fn=>()=>{fn();radial.signature='';};
    if(everywhere) {
      if(!radial.mesh.visible)return options;
      const seen=new Set();
      const walk=(key,path)=>{if(seen.has(key))return;seen.add(key);
        for(const item of itemsOf(key)) {
          if(item.local)continue;
          options.push({label:item.label,aliases:item.aliases||[],press:press(()=>{stack=[...path];menu=stack.at(-1);item.press();})});
          if(item.open)walk(item.open,[...path,item.open]);
        }};
      walk(top(),[top()]);
      return options;
    }
    if(radial.mesh.visible&&menu) {
      for(const item of itemsOf(menu))options.push({label:item.label,aliases:item.aliases||[],press:press(item.press)});
      options.push(stack.length<2?{label:'Close',aliases:['close menu','close the menu'],press:closeMenu}:{label:'Back',aliases:['go back'],press:press(back)});
    }
    if(editor.mesh.visible) {
      for(const [key,label] of SHAPES)options.push({label,aliases:[],press:()=>{draft.shape=key;if(key==='circle')draft.ratio=1;applyDraft();}});
      for(const [label,ratio] of RATIOS)options.push({label,aliases:[label.replace(':',' by ')],press:()=>{draft.ratio=ratio;if(draft.shape==='circle'&&ratio!==1)draft.shape='oval';applyDraft();}});
      options.push({label:'OK',aliases:['okay','done'],press:()=>{editor.mesh.visible=false;openMenu();}});
    }
    if(keyboard.mesh.visible)options.push({label:'Search',aliases:[],press:search},{label:'Cancel',aliases:[],press:()=>{voice.cancel();keyboard.mesh.visible=false;}});
    return options;
  }

  return {update,pointer,close,dragStart,dragMove,dragEnd,say,voiceOptions,openNamed,
    openMenu:()=>{if(!radial.mesh.visible)openMenu();},
    get searching(){return voice.state!=='idle';},   // the keyboard's microphone is in use
    // Any menu up: the map is not gripped meanwhile.
    get busy(){return radial.mesh.visible||keyboard.mesh.visible||editor.mesh.visible;},
    get state(){
      const regions=s=>s.mesh.visible?s.regions.map(({id})=>id):[];
      const stalk=s=>{if(!s.stem?.visible)return null;const p=s.stem.geometry.attributes.position;return Math.hypot(p.getX(1)-p.getX(0),p.getY(1)-p.getY(0),p.getZ(1)-p.getZ(0));};
      const along=sheet.mesh.visible&&sheet.at?sheet.mesh.position.clone().sub(sheet.at.wrist):null;
      return {sheet:{shown:sheet.mesh.visible,facing:sheet.facing??null,lines:sheet.mesh.visible?sheetLines().map(line=>line.say+(line.note?` ${line.note}`:'')):[],
          along:along?along.dot(sheet.at.arm):null,out:along?along.dot(sheet.at.back):null},
        stalks:{face:stalk(face),button:stalk(wrist)},caption:caption.mesh.visible?captionText:null,lasers:lasers.map(l=>l.line.visible),voice:voice.state,voiceNote,editor:editor.mesh.visible?{...draft,dragging:dragging?.name||null}:null,face:face.mesh.visible?face.mesh.position.toArray():null,button:wrist.mesh.visible?wrist.mesh.position.toArray():null,buttonLabel:wrist.signature?JSON.parse(wrist.signature)[0]:null,menu:radial.mesh.visible?menu:null,path:radial.mesh.visible?[...stack]:[],keyboard:keyboard.mesh.visible,text,
        regions:{watch:regions(face),radial:regions(radial),keyboard:regions(keyboard),wrist:regions(wrist),editor:regions(editor)},
        surfaces:Object.fromEntries(surfaces.map(s=>[s.name,{visible:s.mesh.visible,matrix:s.mesh.matrixWorld.toArray(),width:s.width,height:s.height,canvas:[s.canvas.width,s.canvas.height]}]))};
    },
    // Where a region's middle is in the room, for the browser test to point or poke at it.
    regionPoint(id){
      for(const s of surfaces) {
        if(!s.mesh.visible)continue;
        const region=s.regions.find(r=>r.id===id);if(!region)continue;
        const W=s.canvas.width,H=s.canvas.height;let best=null;
        for(let y=0;y<H&&!best;y+=6)for(let x=0;x<W;x+=6)if(region.contains(x,y)){
          // The first hit row's middle stretch: scan along it.
          let x2=x;while(x2+6<W&&region.contains(x2+6,y))x2+=6;
          let y2=y;while(y2+6<H&&region.contains((x+x2)/2,y2+6))y2+=6;
          best={x:(x+x2)/2,y:(y+y2)/2};break;
        }
        if(!best)return null;
        s.mesh.updateMatrixWorld();
        return s.mesh.localToWorld(new THREE.Vector3((best.x/W-.5)*s.width,(.5-best.y/H)*s.height,0)).toArray();
      }
      return null;
    }};
}
