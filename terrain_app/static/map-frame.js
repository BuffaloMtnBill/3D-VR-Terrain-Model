/* A screen-space selection frame. Leaflet moves underneath this sibling overlay. */
import {normalizeAngle,rotationAngle} from './selection-geometry.js';

export class SelectionFrame {
  constructor(map,onChange) {
    this.map=map;this.onChange=onChange;
    this.element=document.getElementById('selection-frame');
    this.rotateHandle=document.querySelector('[data-rotate]');
    this.size=map.getSize();
    this.frame={left:54,top:24,width:0,height:0,angle:0,shape:'rectangle'};
    this.fitting=false;this.pending=null;this.drag=null;this.alignment=null;
    this.alignButton=document.getElementById('align-selection');
    this.alignStatus=document.getElementById('alignment-status');
    this.reset(false);
    document.getElementById('selection-shape').addEventListener('change',event=>this.setShape(event.target.value));
    map.on('move zoom moveend zoomend',()=>this.scheduleChange());
    const handles=[...this.element.querySelectorAll('[data-resize]'),this.rotateHandle];
    for(const handle of handles) {
      handle.addEventListener('pointerdown',event=>this.startDrag(event,handle));
      handle.addEventListener('pointermove',event=>this.moveDrag(event));
      handle.addEventListener('pointerup',event=>this.endDrag(event));
      handle.addEventListener('pointercancel',()=>this.cancelDrag());
      handle.addEventListener('lostpointercapture',()=>this.cancelDrag());
      handle.addEventListener('keydown',event=>this.editWithKeyboard(event,handle));
    }
    for(const button of document.querySelectorAll('[data-aspect]'))button.addEventListener('click',()=>{
      const [width,height]=button.dataset.aspect.split(':').map(Number);
      const ratio=width/height,current=this.frame.width/this.frame.height;
      this.snapAspectRatio(width!==height&&Math.abs(current-ratio)<1e-6?1/ratio:ratio);
    });
    this.alignButton.addEventListener('click',()=>this.alignment?this.cancelAlignment():this.startAlignment());
    map.on('click',event=>this.pickAlignmentPoint(event.latlng));
    map.on('mousemove',event=>{
      if(this.alignment?.point)this.alignment.line.setLatLngs([this.alignment.point,event.latlng]);
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){this.cancelAlignment();this.cancelDrag();}});
    new ResizeObserver(()=>this.resizeViewport()).observe(map.getContainer());
  }

  limits() {
    const size=this.map.getSize(),{left,top,angle}=this.frame;
    return {width:Math.max(80,size.x-(angle?54:left)-24),height:Math.max(80,size.y-(angle?24:top)-62)};
  }

  render() {
    const {left,top,width,height,angle,shape}=this.frame;
    this.element.dataset.shape=shape;
    this.element.setAttribute('aria-label',`${shape} terrain selection frame`);
    document.getElementById('selection-shape').value=shape;
    Object.assign(this.element.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px',transform:'rotate('+angle+'deg)'});
    this.element.querySelector('[data-resize="width"]').setAttribute('aria-label','Resize area width, '+Math.round(width)+' pixels. Use left and right arrows.');
    this.element.querySelector('[data-resize="height"]').setAttribute('aria-label','Resize area height, '+Math.round(height)+' pixels. Use up and down arrows.');
    const radians=angle*Math.PI/180,cosine=Math.cos(radians),sine=Math.sin(radians),size=this.map.getSize();
    const x=left+width/2+width/2*cosine-height/2*sine,y=top+height/2+width/2*sine+height/2*cosine;
    // Keep the corner control reachable when the rotated rectangle extends off-screen.
    const controlX=Math.max(14,Math.min(size.x-14,x));
    let controlY=Math.max(14,Math.min(size.y-28,y));
    const mapRect=this.map.getContainer().getBoundingClientRect();
    for(const control of document.querySelectorAll('.map-tools,.map-style-control,.leaflet-control-zoom')) {
      const rect=control.getBoundingClientRect(),left=rect.left-mapRect.left,right=rect.right-mapRect.left;
      const top=rect.top-mapRect.top,bottom=rect.bottom-mapRect.top;
      if(controlX+14>left&&controlX-14<right&&controlY+14>top&&controlY-14<bottom)
        controlY=top<size.y/2?bottom+18:top-18;
    }
    Object.assign(this.rotateHandle.style,{left:controlX+'px',top:controlY+'px'});
    this.rotateHandle.setAttribute('aria-label','Rotate selected area, '+angle.toFixed(1)+' degrees. Arrow keys rotate; Home resets rotation.');
    this.rotateHandle.title='Drag to rotate ('+angle.toFixed(1)+'°). Shift snaps to 15°. Home resets rotation.';
    const label=shape==='rectangle'?'SELECTED AREA':shape.toUpperCase();
    this.element.querySelector('.frame-label').textContent=angle?label+' · '+angle.toFixed(1)+'°':label;
    document.getElementById('selection-rotation').textContent=angle?angle.toFixed(1)+'°':'';
    for(const button of document.querySelectorAll('[data-aspect]')) {
      const [w,h]=button.dataset.aspect.split(':').map(Number),flipped=w!==h&&Math.abs(width/height-h/w)<1e-6;
      const active=flipped||Math.abs(width/height-w/h)<1e-6,label=flipped?`${h}:${w}`:`${w}:${h}`;
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
      button.textContent=label;
      button.title=active&&w!==h?`Click again for ${flipped?w+':'+h:h+':'+w}`:`Snap to ${label}`;
      button.setAttribute('aria-label',`Set selection aspect ratio to ${label}${w!==h?'; click again to swap portrait and landscape':''}`);
    }
  }

  bounds() {
    const {left,top,width,height,angle,shape}=this.frame;
    const northwest=this.map.containerPointToLatLng([left,top]),southeast=this.map.containerPointToLatLng([left+width,top+height]);
    const west=((northwest.lng+180)%360+360)%360-180;
    const bounds={north:northwest.lat,south:southeast.lat,west,east:west+southeast.lng-northwest.lng};
    if(angle)bounds.rotation_deg=angle;
    if(shape!=='rectangle')bounds.shape=shape;
    return bounds;
  }

  emitChange() {this.onChange(this.bounds());}

  scheduleChange() {
    if(this.fitting||this.pending!==null)return;
    this.pending=requestAnimationFrame(()=>{this.pending=null;this.emitChange();});
  }

  reset(emit=true) {
    this.cancelAlignment();
    Object.assign(this.frame,{left:54,top:24,angle:0,shape:'rectangle'});
    Object.assign(this.frame,this.limits());
    this.render();if(emit)this.emitChange();
  }

  snapAspectRatio(ratio) {
    if(!Number.isFinite(ratio)||ratio<=0)return;
    this.cancelAlignment();this.cancelDrag();
    if(this.frame.shape==='circle'&&ratio!==1)this.frame.shape='oval';
    const frame=this.frame,size=this.map.getSize(),cx=frame.left+frame.width/2,cy=frame.top+frame.height/2;
    let width=Math.sqrt(frame.width*frame.height*ratio),height=width/ratio;
    const radians=frame.angle*Math.PI/180,cosine=Math.abs(Math.cos(radians)),sine=Math.abs(Math.sin(radians));
    const availableWidth=Math.max(40,2*Math.min(cx-14,size.x-14-cx));
    const availableHeight=Math.max(40,2*Math.min(cy-14,size.y-62-cy));
    const scale=Math.min(1,availableWidth/(width*cosine+height*sine),availableHeight/(width*sine+height*cosine));
    width*=scale;height*=scale;
    this.frame={...frame,left:cx-width/2,top:cy-height/2,width,height};
    this.render();this.emitChange();
  }

  setShape(shape) {
    if(!['rectangle','circle','oval'].includes(shape))return;
    this.cancelAlignment();this.cancelDrag();
    this.frame.shape=shape;
    if(shape==='circle')this.snapAspectRatio(1);
    else {this.render();this.emitChange();}
  }

  centerOn(position,zoom=12) {
    this.cancelAlignment();
    if(this.pending!==null){cancelAnimationFrame(this.pending);this.pending=null;}
    const target=this.map.project(position,zoom),size=this.map.getSize(),frame=this.frame;
    const center=this.map.unproject([target.x-(frame.left+frame.width/2)+size.x/2,
      target.y-(frame.top+frame.height/2)+size.y/2],zoom);
    this.fitting=true;
    try{this.map.setView(center,zoom,{animate:false});}finally{this.fitting=false;}
    this.onChange(this.bounds(),false);
  }

  // An optional map zoom shows the area smaller, with more surroundings, than the closest fit.
  fitBounds(bounds,preferredZoom=null) {
    this.cancelAlignment();
    if(this.pending!==null){cancelAnimationFrame(this.pending);this.pending=null;}
    const northwest=this.map.project([bounds.north,bounds.west],0),southeast=this.map.project([bounds.south,bounds.east],0);
    const span=southeast.subtract(northwest),size=this.map.getSize(),angle=rotationAngle(bounds),radians=angle*Math.PI/180;
    const rotatedWidth=Math.abs(Math.cos(radians))*span.x+Math.abs(Math.sin(radians))*span.y;
    const rotatedHeight=Math.abs(Math.sin(radians))*span.x+Math.abs(Math.cos(radians))*span.y;
    const fitted=Math.max(this.map.getMinZoom(),Math.min(this.map.getMaxZoom(),
      Math.log2(Math.min((size.x-78)/rotatedWidth,(size.y-86)/rotatedHeight))));
    const zoom=Number.isFinite(preferredZoom)?Math.max(this.map.getMinZoom(),Math.min(fitted,preferredZoom)):fitted;
    const scale=2**zoom,width=span.x*scale,height=span.y*scale;
    const frameCenter={x:54+rotatedWidth*scale/2,y:24+rotatedHeight*scale/2};
    this.frame={left:frameCenter.x-width/2,top:frameCenter.y-height/2,width,height,angle,shape:bounds.shape||'rectangle'};
    this.render();
    const regionCenter=northwest.add(southeast).divideBy(2).multiplyBy(scale);
    const center=this.map.unproject([regionCenter.x-frameCenter.x+size.x/2,regionCenter.y-frameCenter.y+size.y/2],zoom);
    this.fitting=true;
    try{this.map.setView(center,zoom,{animate:false});}finally{this.fitting=false;}
    this.onChange({...bounds},false);
  }

  startAlignment() {
    this.cancelDrag();
    this.alignment={point:null};
    this.alignButton.classList.add('active');this.alignButton.setAttribute('aria-pressed','true');
    this.alignStatus.hidden=false;this.alignStatus.textContent='Click the first point · Esc cancels';
    this.map.getContainer().classList.add('aligning');
    for(const handle of [...this.element.querySelectorAll('[data-resize]'),this.rotateHandle])handle.disabled=true;
    // Keep map clicks and taps available when this control was activated by keyboard.
    this.map.getContainer().focus({preventScroll:true});
  }

  cancelAlignment() {
    if(!this.alignment)return;
    if(this.alignment.marker)this.map.removeLayer(this.alignment.marker);
    if(this.alignment.line)this.map.removeLayer(this.alignment.line);
    this.alignment=null;
    this.alignButton.classList.remove('active');this.alignButton.setAttribute('aria-pressed','false');
    this.alignStatus.hidden=true;this.map.getContainer().classList.remove('aligning');
    for(const handle of [...this.element.querySelectorAll('[data-resize]'),this.rotateHandle])handle.disabled=false;
  }

  pickAlignmentPoint(position) {
    if(!this.alignment)return;
    if(!this.alignment.point) {
      this.alignment.point=position;
      this.alignment.marker=L.circleMarker(position,{radius:6,color:'#fff6d6',weight:2,fillColor:'#e9c890',fillOpacity:1,interactive:false}).addTo(this.map);
      this.alignment.line=L.polyline([position,position],{color:'#fee0b0',weight:2,dashArray:'5 5',interactive:false}).addTo(this.map);
      this.alignStatus.textContent='Click the second point · Esc cancels';
      return;
    }
    const first=this.map.latLngToContainerPoint(this.alignment.point),second=this.map.latLngToContainerPoint(position);
    const dx=second.x-first.x,dy=second.y-first.y;
    if(Math.hypot(dx,dy)<4){this.alignStatus.textContent='Choose a second point farther away · Esc cancels';return;}
    const {width,height}=this.frame;
    this.cancelAlignment();
    if(this.pending!==null){cancelAnimationFrame(this.pending);this.pending=null;}
    this.frame={...this.frame,left:(first.x+second.x-width)/2,top:(first.y+second.y-height)/2,
      angle:normalizeAngle(Math.atan2(dy,dx)*180/Math.PI)};
    this.render();this.emitChange();
  }

  startDrag(event,handle) {
    if(event.button!==0||this.drag)return;
    event.preventDefault();event.stopPropagation();
    const rect=this.map.getContainer().getBoundingClientRect(),frame={...this.frame};
    const center={x:rect.left+frame.left+frame.width/2,y:rect.top+frame.top+frame.height/2};
    this.drag={pointer:event.pointerId,handle,action:handle.hasAttribute('data-rotate')?'rotate':handle.dataset.resize,
      x:event.clientX,y:event.clientY,frame,center,startAngle:Math.atan2(event.clientY-center.y,event.clientX-center.x)};
    handle.setPointerCapture(event.pointerId);this.element.classList.add('resizing');
  }

  resizeFrom(frame,width,height,action='both') {
    const angle=frame.angle*Math.PI/180,halfW=(width-frame.width)/2,halfH=(height-frame.height)/2;
    const dx=action==='left'?-halfW:frame.shape==='circle'&&['height','top'].includes(action)?0:halfW;
    const dy=action==='top'?-halfH:frame.shape==='circle'&&['width','left'].includes(action)?0:halfH;
    // Keep the opposite corner fixed while changing a rotated edge's length.
    this.frame={...frame,width,height,left:frame.left+dx*Math.cos(angle)-dy*Math.sin(angle)-halfW,
      top:frame.top+dx*Math.sin(angle)+dy*Math.cos(angle)-halfH};
  }

  moveDrag(event) {
    const drag=this.drag;if(!drag||event.pointerId!==drag.pointer)return;
    event.preventDefault();
    if(drag.action==='rotate') {
      const dx=event.clientX-drag.center.x,dy=event.clientY-drag.center.y;
      if(Math.hypot(dx,dy)<10)return;
      let angle=drag.frame.angle+(Math.atan2(dy,dx)-drag.startAngle)*180/Math.PI;
      if(event.shiftKey)angle=Math.round(angle/15)*15;
      this.frame.angle=normalizeAngle(angle);
    } else {
      const radians=drag.frame.angle*Math.PI/180,dx=event.clientX-drag.x,dy=event.clientY-drag.y,limits=this.limits();
      const localX=dx*Math.cos(radians)+dy*Math.sin(radians),localY=-dx*Math.sin(radians)+dy*Math.cos(radians);
      const horizontal=['width','left'].includes(drag.action),sign=['left','top'].includes(drag.action)?-1:1;
      let width=horizontal?Math.max(80,Math.min(limits.width,drag.frame.width+sign*localX)):drag.frame.width;
      let height=!horizontal?Math.max(80,Math.min(limits.height,drag.frame.height+sign*localY)):drag.frame.height;
      if(drag.frame.shape==='circle')width=height=Math.min(horizontal?width:height,limits.width,limits.height);
      this.resizeFrom(drag.frame,width,height,drag.action);
    }
    this.render();this.emitChange();
  }

  endDrag(event) {
    if(!this.drag||event.pointerId!==this.drag.pointer)return;
    this.moveDrag(event);const {handle,pointer}=this.drag;
    this.drag=null;this.element.classList.remove('resizing');
    if(handle.hasPointerCapture(pointer))handle.releasePointerCapture(pointer);
  }

  cancelDrag() {
    if(!this.drag)return;
    const {frame,handle,pointer}=this.drag;this.drag=null;this.frame=frame;
    this.element.classList.remove('resizing');this.render();this.emitChange();
    if(handle.hasPointerCapture(pointer))handle.releasePointerCapture(pointer);
  }

  editWithKeyboard(event,handle) {
    const directions={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(handle.hasAttribute('data-rotate')) {
      if(event.key!=='Home'&&!directions[event.key])return;
      event.preventDefault();
      const direction=event.key==='Home'?0:(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1);
      this.frame.angle=event.key==='Home'?0:normalizeAngle(this.frame.angle+direction*(event.shiftKey?15:1));
    } else {
      const direction=directions[event.key];if(!direction)return;
      event.preventDefault();const limits=this.limits(),step=event.shiftKey?20:2,frame=this.frame;
      const action=handle.dataset.resize,horizontal=['width','left'].includes(action),sign=['left','top'].includes(action)?-1:1;
      let width=horizontal?Math.max(80,Math.min(limits.width,frame.width+sign*direction[0]*step)):frame.width;
      let height=!horizontal?Math.max(80,Math.min(limits.height,frame.height+sign*direction[1]*step)):frame.height;
      if(frame.shape==='circle')width=height=Math.min(horizontal?width:height,limits.width,limits.height);
      this.resizeFrom(frame,width,height,action);
    }
    this.render();this.emitChange();
  }

  resizeViewport(preserveBounds=null) {
    const container=this.map.getContainer(),width=container.clientWidth,height=container.clientHeight;
    if(!width||!height||(width===this.size.x&&height===this.size.y))return;
    this.size={x:width,y:height};this.fitting=true;
    try{this.map.invalidateSize({pan:false,animate:false});}finally{this.fitting=false;}
    if(preserveBounds){this.fitBounds(preserveBounds);return;}
    const cx=this.frame.left+this.frame.width/2,cy=this.frame.top+this.frame.height/2;
    const limits=this.limits();this.frame.width=Math.min(this.frame.width,limits.width);this.frame.height=Math.min(this.frame.height,limits.height);
    if(this.frame.shape==='circle')this.frame.width=this.frame.height=Math.min(this.frame.width,this.frame.height);
    this.frame.left=cx-this.frame.width/2;this.frame.top=cy-this.frame.height/2;
    this.render();this.emitChange();
  }
}
