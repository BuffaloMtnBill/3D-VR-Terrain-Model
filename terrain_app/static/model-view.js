// The computer's model view: when the headset shows its generated model, this page shows the same model large, with
// ◀ Map selection to go back and the two 3D print exports: a standard one-color STL, or a multicolor 3MF in the Print
// palette's filament colors. The 3D preview itself is moved in here while it is open, and back when it closes.
const $=id=>document.getElementById(id);

export function createModelView({studio,state,notify,filamentCount}) {
  const dialog=$('model-view'),scene=$('scene-container'),home=scene.parentNode,next=scene.nextSibling;
  let opener=null,busy=false;   // who opened it: 'headset' (it closes when the headset goes back to the map) or 'page'
  let dismissed=null;   // the model whose view was closed here while the headset still shows it: not reopened for it

  function sizeShown() {
    $('model-view-size').value=$('export-size').value;
    $('model-view-dimensions').textContent=$('export-dimensions').textContent;
  }
  // Multicolor fits four filaments: past that, the button says how many and how to bring it down.
  const MULTICOLOR='3MF · the Print palette\'s mapped colors as up to four filament parts';
  function refresh() {
    const count=filamentCount(),button=dialog.querySelector('[data-model-export="3mf"]');
    if(!busy)button.disabled=count>4;
    $('model-view-3mf-hint').textContent=count>4?`${count} colors with the map layers that are on: turn some off to fit four filaments`:MULTICOLOR;
  }
  function open(by='page') {
    if(!state.data||state.id==='example'&&by==='headset')return false;
    $('model-view-title').textContent=$('landscape-title')?.textContent||state.name||'Your model';
    $('model-view-source').textContent=by==='headset'?'Generated in the headset. Turn it here as you like, and export it to print.':'';
    sizeShown();refresh();
    if(!dialog.open){$('model-view-stage').append(scene);dialog.showModal();}
    if(by==='page'||!opener)opener=by;
    return true;
  }
  // The preview goes back at once (the dialog's close event comes a moment later, and also covers Escape).
  function restore() {if(scene.parentNode!==home)home.insertBefore(scene,next);opener=null;}
  function close() {
    if(!dialog.open)return;
    dialog.close();restore();
  }
  dialog.addEventListener('close',restore);
  // Following the headset: back on the map there, so back to the map selection here (unless opened here by hand).
  function headsetMode(mode) {
    if(mode==='model'){if(dismissed!==state.id)open('headset');}
    else{dismissed=null;if(opener==='headset')close();}
  }

  async function exportFor(kind) {
    if(busy)return;
    const status=$('model-view-status'),bar=$('model-view-progress');
    busy=true;dialog.querySelectorAll('[data-model-export]').forEach(button=>{button.disabled=true;});
    try {
      if(kind==='3mf'&&state.palette!=='print') {
        // Multicolor prints use the Print palette: mapped surface colors as filament parts.
        document.querySelector('[data-palette="print"]')?.click();
        status.textContent='Switched to the Print palette for the filament colors…';
      }
      if(await studio.exportFormat(kind,{status,bar})===false)status.textContent+=' Click it again to try again.';
    } finally {
      busy=false;dialog.querySelectorAll('[data-model-export]').forEach(button=>{button.disabled=false;});refresh();
    }
  }

  $('model-view-back').addEventListener('click',()=>{if(opener==='headset')dismissed=state.id;close();});
  dialog.querySelectorAll('[data-model-export]').forEach(button=>button.addEventListener('click',()=>exportFor(button.dataset.modelExport).catch(error=>notify(error.message,true))));
  $('model-view-size').addEventListener('input',event=>{
    const size=$('export-size');size.value=event.target.value;size.dispatchEvent(new Event('input',{bubbles:true}));
    $('model-view-dimensions').textContent=$('export-dimensions').textContent;
  });

  return {open,close,headsetMode,refresh,get shown(){return dialog.open;},get opener(){return opener;}};
}
