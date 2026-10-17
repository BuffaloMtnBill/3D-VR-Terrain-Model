// The left-wrist watch: tap its dial with a fingertip and a large radial menu opens in front of you, within reach,
// with the map generator's options; tap the options the same way (there are no lasers). Every choice drives the page's own control, so the page (and the computer following
// it) stays in step. Search opens a keyboard that types into the page's address / ZIP search.
// The right-wrist button: Generate in Map Selection (then the model view), Map in the model view.
import * as THREE from 'three';
import {mercatorPixel,rotationAngle} from './selection-geometry.js';
import {createVoice} from './vr-voice.js';

const $=id=>document.getElementById(id);
const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
const UI={ink:'#fff6d6',muted:'#a9ae99',accent:'#e9c890',fill:'#101b14eb',raised:'#223329',hover:'#35503a',active:'#4b6d46',line:'#5c6448',
  sans:'Inter,"Segoe UI",Arial,sans-serif'};
const POKE={touch:.012,release:.025,hover:.07};   // fingertip distance (m) from a surface that presses it, lets it go, lights it
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
  for(const s of [face,radial,keyboard,wrist,editor,caption])rig.add(s.mesh);
  face.mesh.renderOrder=1050;
  let menu=null,text='',hovered=new Set(),lastStatus='',voiceNote='';
  // Voice search: the words heard replace the text in the box, to check (or fix) before tapping Search.
  const voice=createVoice({api:ctx.api,onText:heard=>{text=heard;voiceNote='';keyboard.signature='';},onError:message=>{voiceNote=message;keyboard.signature='';}});
  const surfaces=[face,radial,keyboard,wrist,editor];

  // ---------- menu contents, read live from the page ----------
  const selectItems=el=>[...el.options].filter(option=>!option.disabled&&!option.hidden&&option.value!=='custom').map(option=>({
    label:short(option.textContent),active:option.value===el.value,press:()=>{el.value=option.value;fire(el,'input');fire(el,'change');}}));
  const rangeItems=el=>{
    const step=Number(el.step||1),set=value=>{
      const min=Number(el.min||0),max=Number(el.max||100),snapped=Math.min(max,Math.max(min,Math.round((value-min)/step)*step+min));
      el.value=String(Number(snapped.toFixed(6)));fire(el,'input');fire(el,'change');};
    // Spoken as words: "plus", "minus ten", …
    const said={'−−':['minus ten','down ten','much less'],'−':['minus','down','less'],'+':['plus','up','more'],'++':['plus ten','up ten','much more']};
    return [['−−',-10],['−',-1],['+',1],['++',10]].map(([label,steps])=>({label,aliases:said[label],press:()=>set(Number(el.value)+steps*step)}));
  };
  const SPOKEN={'feature-at':['appalachian trail']};   // labels too short to listen for as they are
  const features=()=>[...document.querySelectorAll('#style-editor input[type=checkbox][id^="feature-"]')].filter(shown).map(el=>({
    key:el.id.replace('feature-',''),label:short(labelOf(el)),aliases:SPOKEN[el.id],active:el.checked,press:()=>el.click()}));
  const MENUS={
    root:{title:'Map options',items:()=>[
      {key:'search',label:'Search',press:()=>openKeyboard()},
      {key:'source',label:'Source',press:()=>open('source')},{key:'detail',label:'Detail',press:()=>open('detail')},{key:'profile',label:'Profile',press:()=>open('profile')},
      {key:'multiplier',label:'Multiplier',press:()=>open('multiplier')},{key:'base',label:'Base',press:()=>open('base')},
      {key:'shape',label:'Shape',press:()=>openEditor()},{key:'features',label:'Features',press:()=>open('features')},
      {key:'exit',label:'Exit VR',press:()=>exit()},
      {key:'relief',label:relief.on?'Flat map':'3D relief',press:()=>relief.toggle()},
      {key:'voice',label:voiceCommands.on?'Voice: on':'Voice: off',aliases:['voice'],active:voiceCommands.on,press:()=>voiceCommands.toggle()}]},
    // The model view's own menu: the sky around the model, and what is drawn on the model.
    model:{title:'Model view',items:()=>[
      ...backgrounds.list.map(b=>({key:b.key,label:b.label,active:backgrounds.current===b.key,press:()=>backgrounds.set(b.key)})),
      {key:'display',label:'On the model',aliases:['on the model','display','features'],press:()=>open('display')}]},
    display:{title:'On the model',items:()=>[...features(),
      {key:'contours',label:'Contour lines',aliases:['contours'],active:$('contours').checked,press:()=>$('contours').click()}]},
    source:{title:'Elevation source',items:()=>selectItems($('elevation-source'))},
    detail:{title:'Terrain detail',items:()=>selectItems($('resolution'))},
    profile:{title:'Elevation profile',items:()=>selectItems($('relief-method'))},
    multiplier:{title:'Elevation multiplier',value:()=>$('exaggeration-value')?.textContent||$('exaggeration').value,items:()=>rangeItems($('exaggeration'))},
    base:{title:'Base thickness',value:()=>$('base-value')?.textContent||$('base').value,items:()=>rangeItems($('base'))},
    features:{title:'Map features',items:features},
  };
  function open(key){menu=key;radial.signature='';}
  function openMenu() {
    keyboard.mesh.visible=false;editor.mesh.visible=false;
    // Fixed in the room in front of you (not on the moving wrist), a little below eye level.
    place(radial.mesh,.38,-.16);radial.mesh.visible=true;open(mode()==='model'?'model':'root');   // a comfortable reach in front of you
  }
  function closeMenu(){radial.mesh.visible=false;menu=null;}
  function openKeyboard() {
    closeMenu();editor.mesh.visible=false;text=$('place-search')?.value||'';
    place(keyboard.mesh,.4,-.24);keyboard.mesh.visible=true;keyboard.signature='';
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
    place(editor.mesh,.4,-.1);editor.mesh.visible=true;editor.signature='';
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
  // Grips on the editor's handles (the map is never gripped while a menu is up).
  function canvasAt(point) {
    const local=editor.mesh.worldToLocal(point.clone());
    return {depth:Math.abs(local.z),...editor.toCanvas(local)};
  }
  function dragStart(hand,point) {
    if(!editor.mesh.visible||!point)return false;
    const p=canvasAt(point);if(p.depth>.06)return false;
    const region=editor.regions.find(r=>r.handle&&r.contains(p.x,p.y));if(!region)return false;
    dragging={hand,name:region.handle,start:{...draft,...halves(draft)}};editor.signature='';
    return true;
  }
  function dragMove(hand,point) {
    if(dragging?.hand!==hand||!point)return;
    const p=canvasAt(point),s=dragging.start,a=s.angle*Math.PI/180;
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

  function search() {
    keyboard.mesh.visible=false;
    const input=$('place-search'),form=$('place-form');
    if(!input||!form)return;
    input.value=text;form.requestSubmit();
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
    const spec=MENUS[menu],items=spec.items(),value=spec.value?.()||'',state=status();
    const signature=JSON.stringify([menu,items.map(item=>[item.label,item.active]),value,state,[...hovered]]);
    if(signature===radial.signature)return;radial.signature=signature;
    const c=radial.context,S=radial.canvas.width,C=S/2,outer=500,inner=175,n=Math.max(items.length,1),slice=Math.PI*2/n;
    c.clearRect(0,0,S,S);radial.regions=[];
    items.forEach((item,i)=>{
      const start=-Math.PI/2+i*slice-slice/2,end=start+slice,id=`radial:${menu}:${item.key??i}`;
      c.beginPath();c.arc(C,C,outer,start,end);c.arc(C,C,inner,end,start,true);c.closePath();
      c.fillStyle=item.active?UI.active:hovered.has(id)?UI.hover:UI.fill;c.fill();c.lineWidth=4;c.strokeStyle=UI.line;c.stroke();
      const mid=(start+end)/2,r=(outer+inner)/2;
      c.fillStyle=item.active?'#fffbe8':UI.ink;c.font=`600 ${n>8?40:46}px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';
      const lines=wrapText(c,item.label,Math.min(250,2*r*Math.sin(slice/2)*.9),2);
      lines.forEach((line,k)=>c.fillText(line,C+Math.cos(mid)*r,C+Math.sin(mid)*r+(k-(lines.length-1)/2)*48));
      radial.regions.push({id,press:item.press,contains:(x,y)=>{
        const dx=x-C,dy=y-C,distance=Math.hypot(dx,dy);if(distance<inner||distance>outer)return false;
        const angle=((Math.atan2(dy,dx)+Math.PI/2+slice/2)%(Math.PI*2)+Math.PI*2)%(Math.PI*2);
        return Math.floor(angle/slice)===i;}});
    });
    // The middle: the menu's name and value, and Back (or Close at the top level).
    const top=menu==='root'||menu==='model',back=top?'Close':'‹ Back',hot=hovered.has('radial:center');
    c.beginPath();c.arc(C,C,inner-12,0,Math.PI*2);c.fillStyle=hot?UI.hover:'#0b140ef2';c.fill();c.lineWidth=4;c.strokeStyle=UI.accent;c.stroke();
    c.fillStyle=UI.accent;c.font=`650 30px ${UI.sans}`;c.textAlign='center';
    wrapText(c,spec.title.toUpperCase(),280,2).forEach((line,k)=>c.fillText(line,C,C-70+k*34));
    if(value){c.fillStyle=UI.ink;c.font=`600 ${value.length>8?32:52}px ${UI.sans}`;c.fillText(value,C,C+5);}
    c.fillStyle=UI.muted;c.font=`600 34px ${UI.sans}`;c.fillText(back,C,C+72);
    radial.regions.push({id:'radial:center',press:()=>top?closeMenu():open(mode()==='model'?'model':'root'),contains:(x,y)=>Math.hypot(x-C,y-C)<inner-12});
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
    ROWS.forEach((keys,r)=>[...keys].forEach((k,i)=>button(`key:${k}`,pad+i*key+(r===2?key*.25:r===3?key*.5:0),top+r*row,key,row,k.toUpperCase(),()=>{text+=k;})));
    const y=top+4*row;
    button('key:cancel',pad,y,key*2,row,'Cancel',()=>{voice.cancel();keyboard.mesh.visible=false;});
    button('key:voice',pad+key*2,y,key*2,row,voice.state==='listening'?'■ Stop':voice.state==='working'?'…':'🎤 Speak',()=>{voiceNote='';voice.toggle();},voice.state==='listening');
    button('key:space',pad+key*4,y,key*2,row,'Space',()=>{text+=' ';});
    button('key:back',pad+key*6,y,key*2,row,'⌫',()=>{text=text.slice(0,-1);});
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

  // ---------- the watch on your left wrist, the button on your right ----------
  const handOf=side=>hands.find(hand=>hand.source?.handedness===side);
  const left=()=>handOf('left');
  function wear(s,hand,side) {
    s.mesh.visible=Boolean(hand);
    if(!hand)return;
    const wristJoint=hand.tracked&&joint(hand,'wrist'),index=hand.tracked&&joint(hand,'index-finger-metacarpal'),little=hand.tracked&&joint(hand,'pinky-finger-metacarpal');
    if(wristJoint&&index&&little) {
      // On the back of the wrist, facing out of it (the palm of the left hand faces b × a, of the right a × b).
      const a=index.position.clone().sub(wristJoint.position),b=little.position.clone().sub(wristJoint.position);
      const back=(side==='left'?a.clone().cross(b):b.clone().cross(a)).normalize();
      s.mesh.position.copy(wristJoint.position).addScaledVector(back,.022);
      s.mesh.lookAt(s.mesh.position.clone().add(back));
    } else {
      // On top of the controller.
      hand.grip.updateMatrixWorld();
      s.mesh.position.copy(hand.grip.localToWorld(new THREE.Vector3(0,.035,.04)));
      s.mesh.lookAt(camera.position);
    }
  }

  // ---------- tapping with a fingertip ----------
  const visible=()=>surfaces.filter(s=>s.mesh.visible);
  function pokeBy(point,hand) {
    for(const s of visible()) {
      if(s===face&&hand===left()||s===wrist&&hand===handOf('right'))continue;   // not pressed by their own wrist
      const local=s.mesh.worldToLocal(point.clone());
      if(Math.abs(local.x)>s.width/2||Math.abs(local.y)>s.height/2)continue;
      return {surface:s,depth:Math.abs(local.z),...s.toCanvas(local)};
    }
    return null;
  }
  // Called for each hand every frame with its fingertip: a region lights as the fingertip comes near and is pressed
  // when it touches; it presses again only after the fingertip lifts off. True while the hand is at the menus.
  function pointer(hand,{fingertip}) {
    const touch=fingertip?pokeBy(fingertip,hand):null,near=touch&&touch.depth<POKE.hover;
    const region=near?touch.surface.regionAt(touch.x,touch.y):null;
    hand.uiHover=region?.id||null;
    if(touch&&touch.depth<POKE.touch){if(!hand.poking){hand.poking=true;region?.press?.();}}
    else if(!touch||touch.depth>POKE.release)hand.poking=false;
    return {onUI:Boolean(near)};
  }

  function update() {
    wear(face,left(),'left');wear(wrist,handOf('right'),'right');
    hovered=new Set(hands.map(hand=>hand.uiHover).filter(Boolean));
    // Between drags the editor shows the page's selection as it is (after a change is applied, or from the computer).
    if(editor.mesh.visible&&!dragging)draft=draftFromPage();
    drawFace();drawRadial();drawKeyboard();drawWrist();drawEditor();
    if(caption.mesh.visible&&performance.now()>captionUntil)caption.mesh.visible=false;
    const now=status();if(now!==lastStatus){lastStatus=now;radial.signature='';}
  }
  function close(){closeMenu();voice.cancel();keyboard.mesh.visible=false;editor.mesh.visible=false;dragging=null;}
  // A short caption in front of you: what a voice command was heard as.
  let captionUntil=0;
  function say(text) {
    const c=caption.context,W=caption.canvas.width,H=caption.canvas.height;
    c.clearRect(0,0,W,H);c.fillStyle=UI.fill;c.beginPath();c.roundRect(0,0,W,H,H/2);c.fill();
    c.fillStyle=UI.accent;c.font=`600 ${Math.round(H*.5)}px ${UI.sans}`;c.textAlign='center';c.textBaseline='middle';c.fillText(text,W/2,H/2+2);
    caption.texture.needsUpdate=true;place(caption.mesh,.6,-.22);caption.mesh.visible=true;captionUntil=performance.now()+2500;
  }

  // What can be said while a menu is open: each option on show, by its label (and any spoken names), and Back or
  // Close. Pressing it does exactly what tapping it would.
  function voiceOptions() {
    const options=[];
    if(radial.mesh.visible&&menu) {
      for(const item of MENUS[menu].items())options.push({label:item.label,aliases:item.aliases||[],press:()=>{item.press();radial.signature='';}});
      const top=menu==='root'||menu==='model';
      options.push(top?{label:'Close',aliases:['close menu','close the menu'],press:closeMenu}:{label:'Back',aliases:['go back'],press:()=>open(mode()==='model'?'model':'root')});
    }
    if(editor.mesh.visible) {
      for(const [key,label] of SHAPES)options.push({label,aliases:[],press:()=>{draft.shape=key;if(key==='circle')draft.ratio=1;applyDraft();}});
      for(const [label,ratio] of RATIOS)options.push({label,aliases:[label.replace(':',' by ')],press:()=>{draft.ratio=ratio;if(draft.shape==='circle'&&ratio!==1)draft.shape='oval';applyDraft();}});
      options.push({label:'OK',aliases:['okay','done'],press:()=>{editor.mesh.visible=false;openMenu();}});
    }
    if(keyboard.mesh.visible)options.push({label:'Search',aliases:[],press:search},{label:'Cancel',aliases:[],press:()=>{voice.cancel();keyboard.mesh.visible=false;}});
    return options;
  }

  return {update,pointer,close,dragStart,dragMove,dragEnd,say,voiceOptions,
    openMenu:()=>{if(!radial.mesh.visible)openMenu();},
    get searching(){return voice.state!=='idle';},   // the keyboard's microphone is in use
    // Any menu up: the map is not gripped meanwhile.
    get busy(){return radial.mesh.visible||keyboard.mesh.visible||editor.mesh.visible;},
    get state(){
      const regions=s=>s.mesh.visible?s.regions.map(({id})=>id):[];
      return {caption:caption.mesh.visible,voice:voice.state,voiceNote,editor:editor.mesh.visible?{...draft,dragging:dragging?.name||null}:null,face:face.mesh.visible?face.mesh.position.toArray():null,button:wrist.mesh.visible?wrist.mesh.position.toArray():null,buttonLabel:wrist.signature?JSON.parse(wrist.signature)[0]:null,menu:radial.mesh.visible?menu:null,keyboard:keyboard.mesh.visible,text,
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
