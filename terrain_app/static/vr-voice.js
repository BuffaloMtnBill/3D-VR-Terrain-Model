// Voice search for the VR keyboard: record from the headset's microphone, send plain 16 kHz samples to the server
// (which transcribes them with Whisper on the computer), and hand back the words. Nothing is saved anywhere.
const RATE=16000,MAX_SECONDS=8;

// Linear resampling, for browsers that will not record at 16 kHz themselves.
function resample(samples,from) {
  if(from===RATE)return samples;
  const out=new Float32Array(Math.floor(samples.length*RATE/from));
  for(let i=0;i<out.length;i++){const x=i*from/RATE,j=Math.floor(x),f=x-j;out[i]=samples[j]*(1-f)+(samples[j+1]??samples[j])*f;}
  return out;
}
function toBase64(samples) {
  const pcm=new Int16Array(samples.length);
  for(let i=0;i<samples.length;i++)pcm[i]=Math.max(-32768,Math.min(32767,Math.round(samples[i]*32767)));
  const bytes=new Uint8Array(pcm.buffer);let text='';
  for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(text);
}

export function createVoice({api,onText,onError}) {
  let state='idle',stream=null,context=null,processor=null,chunks=[],timer=null;
  async function start() {
    if(state!=='idle')return;
    if(!navigator.mediaDevices?.getUserMedia){onError('This browser cannot use the microphone (it needs the secure https page).');return;}
    state='starting';chunks=[];
    try {
      stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      try{context=new AudioContext({sampleRate:RATE});}catch{context=new AudioContext();}
      const source=context.createMediaStreamSource(stream);
      processor=context.createScriptProcessor(4096,1,1);
      processor.onaudioprocess=event=>{if(state==='listening')chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));};
      source.connect(processor);processor.connect(context.destination);   // silent: the output buffer is left empty
      state='listening';
      timer=setTimeout(()=>stop(),MAX_SECONDS*1000);
    } catch(error) {
      release();state='idle';
      onError(error?.name==='NotAllowedError'?'The microphone is not allowed. Allow it for this page, then try again.':`The microphone could not start: ${error.message}`);
    }
  }
  function release() {
    clearTimeout(timer);timer=null;
    processor?.disconnect();stream?.getTracks().forEach(track=>track.stop());
    const rate=context?.sampleRate||RATE;context?.close().catch(()=>{});
    processor=null;stream=null;context=null;
    return rate;
  }
  async function stop() {
    if(state!=='listening')return;
    state='working';
    const rate=release(),length=chunks.reduce((sum,chunk)=>sum+chunk.length,0),all=new Float32Array(length);
    let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
    chunks=[];
    try {
      if(length<rate*.3)throw new Error('That was too short. Tap Speak, say the place, then tap Stop.');
      const result=await api('/api/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({rate:RATE,samples:toBase64(resample(all,rate))})});
      if(!result.text)throw new Error('Nothing was heard. Try again, a little closer to the microphone.');
      onText(result.text);
    } catch(error){onError(error.message);}
    finally{state='idle';}
  }
  return {toggle(){if(state==='idle')start();else if(state==='listening')stop();},
    cancel(){if(state==='listening'){release();state='idle';chunks=[];}},
    get state(){return state;}};
}
