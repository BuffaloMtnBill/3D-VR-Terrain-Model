// The left-wrist watch: tap it (fingertip, or point and pinch) and a radial menu opens in front of you with the
// map generator's options. Every choice drives the page's own control, so the page (and the computer following
// it) stays in step. Search opens a keyboard that types into the page's address / ZIP search.
// The right-wrist button: Generate in Map Selection (then the model view), Map in the model view.
import * as THREE from 'three';

const $=id=>document.getElementById(id);
const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
const UI={ink:'#fff6d6',muted:'#a9ae99',accent:'#e9c890',fill:'#101b14eb',raised:'#223329',hover:'#35503a',active:'#4b6d46',line:'#5c6448',
  sans:'Inter,"Segoe UI",Arial,sans-serif'};
const POKE={touch:.012,release:.025};   // fingertip distance (m) from a surface that presses it, and that lets it go
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

export function createWatch(ctx,{rig,camera,joint,hands,exit,mode,generate,showMap,relief}) {
  const raycaster=new THREE.Raycaster();
  const face=surface('watch',.045,.045,256),radial=surface('radial menu',.3,.3,1024),keyboard=surface('keyboard',.56,.24,1600);
  const wrist=surface('wrist button',.075,.04,512);
  for(const s of [face,radial,keyboard,wrist])rig.add(s.mesh);
  face.mesh.renderOrder=1050;
  let menu=null,text='',hovered=new Set(),lastStatus='';
  const surfaces=[face,radial,keyboard,wrist];

  // ---------- menu contents, read live from the page ----------
  const selectItems=el=>[...el.options].filter(option=>!option.disabled&&!option.hidden&&option.value!=='custom').map(option=>({
    label:short(option.textContent),active:option.value===el.value,press:()=>{el.value=option.value;fire(el,'input');fire(el,'change');}}));
  const rangeItems=el=>{
    const step=Number(el.step||1),set=value=>{
      const min=Number(el.min||0),max=Number(el.max||100),snapped=Math.min(max,Math.max(min,Math.round((value-min)/step)*step+min));
      el.value=String(Number(snapped.toFixed(6)));fire(el,'input');fire(el,'change');};
    return [['−−',-10],['−',-1],['+',1],['++',10]].map(([label,steps])=>({label,press:()=>set(Number(el.value)+steps*step)}));
  };
  const features=()=>[...document.querySelectorAll('#style-editor input[type=checkbox][id^="feature-"]')].filter(shown).map(el=>({
    label:short(labelOf(el)),active:el.checked,press:()=>el.click()}));
  const MENUS={
    root:{title:'Map options',items:()=>[
      {label:'Search',press:()=>openKeyboard()},
      {label:'Source',press:()=>open('source')},{label:'Detail',press:()=>open('detail')},{label:'Profile',press:()=>open('profile')},
      {label:'Multiplier',press:()=>open('multiplier')},{label:'Base',press:()=>open('base')},
      {label:'Shape',press:()=>open('shape')},{label:'Aspect',press:()=>open('aspect')},{label:'Features',press:()=>open('features')},
      {label:'Exit VR',press:()=>exit()},
      {label:relief.on?'Flat map':'3D relief',press:()=>relief.toggle()}]},
    source:{title:'Elevation source',items:()=>selectItems($('elevation-source'))},
    detail:{title:'Terrain detail',items:()=>selectItems($('resolution'))},
    profile:{title:'Elevation profile',items:()=>selectItems($('relief-method'))},
    multiplier:{title:'Elevation multiplier',value:()=>$('exaggeration-value')?.textContent||$('exaggeration').value,items:()=>rangeItems($('exaggeration'))},
    base:{title:'Base thickness',value:()=>$('base-value')?.textContent||$('base').value,items:()=>rangeItems($('base'))},
    shape:{title:'Shape',items:()=>selectItems($('selection-shape'))},
    aspect:{title:'Aspect ratio',value:()=>'Again to turn it',items:()=>[...document.querySelectorAll('[data-aspect]')].map(button=>({
      label:button.textContent.trim(),active:button.getAttribute('aria-pressed')==='true',press:()=>button.click()}))},
    features:{title:'Map features',items:features},
  };
  function open(key){menu=key;radial.signature='';}
  function openMenu() {
    keyboard.mesh.visible=false;
    // Fixed in the room in front of you (not on the moving wrist), a little below eye level.
    place(radial.mesh,.42,-.12);radial.mesh.visible=true;open('root');
  }
  function closeMenu(){radial.mesh.visible=false;menu=null;}
  function openKeyboard() {
    closeMenu();text=$('place-search')?.value||'';
    place(keyboard.mesh,.5,-.22);keyboard.mesh.visible=true;keyboard.signature='';
  }
  function place(mesh,distance,drop) {
    const forward=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);forward.y=0;
    if(forward.lengthSq()<1e-6)forward.set(0,0,-1);
    forward.normalize();
    mesh.position.copy(camera.position).addScaledVector(forward,distance).add(new THREE.Vector3(0,drop,0));
    mesh.lookAt(camera.position);
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
    const c=face.context,s=face.canvas.width,open=radial.mesh.visible||keyboard.mesh.visible,hot=hovered.has('watch:face');
    const signature=`${open}:${hot}`;if(signature===face.signature)return;face.signature=signature;
    c.clearRect(0,0,s,s);
    c.beginPath();c.arc(s/2,s/2,s/2-8,0,Math.PI*2);c.fillStyle=hot?UI.hover:'#101b14';c.fill();c.lineWidth=10;c.strokeStyle=open?UI.ink:UI.accent;c.stroke();
    // A small radial menu as the dial.
    for(let i=0;i<8;i++){const a=i/8*Math.PI*2;c.beginPath();c.arc(s/2+Math.cos(a)*62,s/2+Math.sin(a)*62,13,0,Math.PI*2);c.fillStyle=UI.accent;c.fill();}
    c.beginPath();c.arc(s/2,s/2,26,0,Math.PI*2);c.fillStyle=UI.ink;c.fill();
    face.regions=[{id:'watch:face',contains:()=>true,press:()=>(radial.mesh.visible||keyboard.mesh.visible)?(closeMenu(),keyboard.mesh.visible=false):openMenu()}];
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
      const start=-Math.PI/2+i*slice-slice/2,end=start+slice,id=`radial:${menu}:${i}`;
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
    const back=menu==='root'?'Close':'‹ Back',hot=hovered.has('radial:center');
    c.beginPath();c.arc(C,C,inner-12,0,Math.PI*2);c.fillStyle=hot?UI.hover:'#0b140ef2';c.fill();c.lineWidth=4;c.strokeStyle=UI.accent;c.stroke();
    c.fillStyle=UI.accent;c.font=`650 30px ${UI.sans}`;c.textAlign='center';
    wrapText(c,spec.title.toUpperCase(),280,2).forEach((line,k)=>c.fillText(line,C,C-70+k*34));
    if(value){c.fillStyle=UI.ink;c.font=`600 ${value.length>8?32:52}px ${UI.sans}`;c.fillText(value,C,C+5);}
    c.fillStyle=UI.muted;c.font=`600 34px ${UI.sans}`;c.fillText(back,C,C+72);
    radial.regions.push({id:'radial:center',press:()=>menu==='root'?closeMenu():open('root'),contains:(x,y)=>Math.hypot(x-C,y-C)<inner-12});
    if(state){c.font=`28px ${UI.sans}`;c.fillStyle=UI.ink;c.fillText(state.slice(0,70),C,S-6);}
    radial.texture.needsUpdate=true;
  }
  const ROWS=['1234567890','qwertyuiop','asdfghjkl,','zxcvbnm-.'];
  function drawKeyboard() {
    if(!keyboard.mesh.visible)return;
    const signature=JSON.stringify([text,[...hovered]]);if(signature===keyboard.signature)return;keyboard.signature=signature;
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
    c.fillStyle=text?UI.ink:UI.muted;c.font=`500 52px ${UI.sans}`;c.textAlign='left';c.textBaseline='middle';
    c.fillText(text?`${text}|`:'Address, place, or US ZIP code',pad+24,pad+50);
    const top=pad+110,row=(H-top-pad)/5;
    ROWS.forEach((keys,r)=>[...keys].forEach((k,i)=>button(`key:${k}`,pad+i*key+(r===2?key*.25:r===3?key*.5:0),top+r*row,key,row,k.toUpperCase(),()=>{text+=k;})));
    const y=top+4*row;
    button('key:cancel',pad,y,key*2,row,'Cancel',()=>{keyboard.mesh.visible=false;});
    button('key:space',pad+key*2,y,key*4,row,'Space',()=>{text+=' ';});
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

  // ---------- pointing and poking ----------
  const visible=()=>surfaces.filter(s=>s.mesh.visible);
  function hitBy(ray) {
    let best=null;
    for(const s of visible()) {
      const hit=ray.intersectObject(s.mesh,false)[0];
      if(hit&&(!best||hit.distance<best.distance)){const p=s.toCanvas(s.mesh.worldToLocal(hit.point.clone()));best={surface:s,distance:hit.distance,...p};}
    }
    return best;
  }
  function pokeBy(point,hand) {
    for(const s of visible()) {
      if(s===face&&hand===left()||s===wrist&&hand===handOf('right'))continue;   // not pressed by their own wrist
      const local=s.mesh.worldToLocal(point.clone());
      if(Math.abs(local.x)>s.width/2||Math.abs(local.y)>s.height/2)continue;
      return {surface:s,depth:Math.abs(local.z),...s.toCanvas(local)};
    }
    return null;
  }
  // Called for each hand every frame: presses on pinch (pointing) or touch (fingertip); true while the hand is on the UI.
  function pointer(hand,{origin,direction,pinching,fingertip}) {
    raycaster.set(origin,direction);
    const hit=hitBy(raycaster),touch=fingertip?pokeBy(fingertip,hand):null;
    hand.uiHover=null;
    let region=null;
    if(touch&&touch.depth<POKE.release)region=touch.surface.regionAt(touch.x,touch.y);
    else if(hit)region=hit.surface.regionAt(hit.x,hit.y);
    hand.uiHover=region?.id||null;
    // Fingertip: press on contact, again only after lifting off.
    if(touch&&touch.depth<POKE.touch){if(!hand.poking){hand.poking=true;region?.press();}}
    else if(!touch||touch.depth>POKE.release)hand.poking=false;
    // Pinch while pointing: press once per pinch.
    if(pinching&&!hand.uiPinch&&hit&&!touch){hand.uiPinch=true;hand.uiCaptured=true;region?.press();}
    if(!pinching){hand.uiPinch=false;hand.uiCaptured=false;}
    return {onUI:Boolean(hit||touch&&touch.depth<POKE.release)||hand.uiCaptured,distance:hit?.distance??null};
  }

  function update() {
    wear(face,left(),'left');wear(wrist,handOf('right'),'right');
    hovered=new Set(hands.map(hand=>hand.uiHover).filter(Boolean));
    drawFace();drawRadial();drawKeyboard();drawWrist();
    const now=status();if(now!==lastStatus){lastStatus=now;radial.signature='';}
  }
  function close(){closeMenu();keyboard.mesh.visible=false;}

  return {update,pointer,close,
    get state(){
      const regions=s=>s.mesh.visible?s.regions.map(({id})=>id):[];
      return {face:face.mesh.visible?face.mesh.position.toArray():null,button:wrist.mesh.visible?wrist.mesh.position.toArray():null,buttonLabel:wrist.signature?JSON.parse(wrist.signature)[0]:null,menu:radial.mesh.visible?menu:null,keyboard:keyboard.mesh.visible,text,
        regions:{watch:regions(face),radial:regions(radial),keyboard:regions(keyboard),wrist:regions(wrist)},
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
