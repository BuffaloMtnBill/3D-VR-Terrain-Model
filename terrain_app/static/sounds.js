// Small interface sounds, made on the spot with Web Audio (no sound files): a soft tick as a menu option lights, a
// click as one is chosen, and a horn blast when Generate is pressed. `played` lists what was played, for the tests.
let context=null;
export const played=[];

function audio() {
  try {
    context??=new (window.AudioContext||window.webkitAudioContext)();
    if(context.state==='suspended')context.resume().catch(()=>{});
    return context;
  } catch{return null;}
}
// One short note: `type` wave from `from` to `to` Hz over `length` seconds, at `level`, through a low-pass filter.
function note(a,{type='sine',from,to=from,length,level,attack=.003,cutoff=8000,start=0}) {
  const t=a.currentTime+start,osc=a.createOscillator(),gain=a.createGain(),filter=a.createBiquadFilter();
  osc.type=type;osc.frequency.setValueAtTime(from,t);osc.frequency.exponentialRampToValueAtTime(to,t+length);
  filter.type='lowpass';filter.frequency.value=cutoff;
  gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(level,t+attack);gain.gain.exponentialRampToValueAtTime(.0001,t+length);
  osc.connect(filter).connect(gain).connect(a.destination);osc.start(t);osc.stop(t+length+.02);
}

export function tick(){played.push('tick');const a=audio();if(a)note(a,{type:'triangle',from:2400,to:1800,length:.03,level:.05});}
export function click() {
  played.push('click');const a=audio();if(!a)return;
  note(a,{type:'square',from:1600,to:500,length:.045,level:.07,cutoff:4000});
  note(a,{type:'sine',from:180,to:90,length:.06,level:.12});
}
// A train-style horn: a chord of buzzy, slightly detuned notes that swells, holds about a second, and fades.
export function horn() {
  played.push('horn');const a=audio();if(!a)return;
  const t=a.currentTime,length=1.3,out=a.createGain(),filter=a.createBiquadFilter();
  filter.type='lowpass';filter.frequency.setValueAtTime(900,t);filter.frequency.linearRampToValueAtTime(2200,t+.15);filter.Q.value=2;
  out.gain.setValueAtTime(0,t);out.gain.linearRampToValueAtTime(.16,t+.08);out.gain.setValueAtTime(.16,t+length-.35);out.gain.linearRampToValueAtTime(0,t+length);
  filter.connect(out).connect(a.destination);
  for(const hz of [185,233,277,311])for(const detune of [-6,6]) {
    const osc=a.createOscillator();osc.type='sawtooth';osc.detune.value=detune;
    osc.frequency.setValueAtTime(hz*.94,t);osc.frequency.exponentialRampToValueAtTime(hz,t+.12);   // a slight scoop up, like air arriving
    osc.connect(filter);osc.start(t);osc.stop(t+length+.05);
  }
}
// A short buzz in a controller (hands have nothing to buzz). `strength` 0–1, `ms` long.
export function buzz(hand,strength,ms) {
  const actuator=hand?.source?.gamepad?.hapticActuators?.[0];if(!actuator?.pulse)return;
  try{actuator.pulse(strength,ms);played.push(`buzz ${strength}`);}catch{/* not every controller can */}
}
