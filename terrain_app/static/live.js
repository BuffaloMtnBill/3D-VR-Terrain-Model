// The live link to the server: one WebSocket that reconnects by itself. A headset that sleeps, walks out of
// Wi-Fi range, or sees the server restart picks up again as soon as it can reach the server.
const MIN_DELAY=500,MAX_DELAY=8000;
const SILENCE=40000;   // the server pings every 15 s; this long without a word means the link is dead

export function createLive({onEvent=()=>{},onStatus=()=>{}}={}) {
  let socket=null,delay=MIN_DELAY,retry=null,watchdog=null,boot=null,connected=false,stopped=false;
  const waiters=new Set();

  function setConnected(value) {
    if(connected===value)return;
    connected=value;onStatus(value);
  }
  function schedule() {
    clearTimeout(retry);
    if(stopped)return;
    retry=setTimeout(connect,delay);
    delay=Math.min(delay*2,MAX_DELAY);
  }
  function alive() {
    clearTimeout(watchdog);
    watchdog=setTimeout(()=>socket?.close(),SILENCE);
  }
  function connect() {
    clearTimeout(retry);
    if(stopped||socket&&socket.readyState<=WebSocket.OPEN)return;
    let current;
    try{current=socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/live`);}
    catch{schedule();return;}
    current.addEventListener('open',()=>{delay=MIN_DELAY;alive();});
    current.addEventListener('message',message=>{
      alive();
      let event;try{event=JSON.parse(message.data);}catch{return;}
      if(event.type==='ping')return;
      if(event.type==='hello') {
        const restarted=boot!==null&&event.boot!==boot;boot=event.boot;
        setConnected(true);
        // Events missed while away are not replayed; listeners catch up from the API.
        onEvent({type:'reconnected',restarted});
        return;
      }
      for(const waiter of [...waiters])waiter(event);
      onEvent(event);
    });
    current.addEventListener('close',()=>{
      if(socket!==current)return;
      socket=null;clearTimeout(watchdog);setConnected(false);schedule();
    });
  }
  // Back from sleep or a network change: try at once instead of waiting out the backoff.
  function now() {
    if(stopped)return;
    delay=MIN_DELAY;
    if(!socket)connect();
  }
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')now();});
  window.addEventListener('online',now);
  window.addEventListener('pageshow',now);

  // Resolves with the first event the test accepts, or null after the timeout.
  function next(test,timeout) {
    return new Promise(resolve=>{
      const waiter=event=>{if(test(event)){done();resolve(event);}};
      const timer=setTimeout(()=>{done();resolve(null);},timeout);
      const done=()=>{clearTimeout(timer);waiters.delete(waiter);};
      waiters.add(waiter);
    });
  }

  connect();
  return {next,now,get connected(){return connected;},
    drop(){socket?.close();},   // as if the network went away; it reconnects as usual
    stop(){stopped=true;clearTimeout(retry);clearTimeout(watchdog);socket?.close();}};
}
