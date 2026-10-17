/* Runs the browser tests: starts the fixture server (scripts/browser_fixture_server.py, port 8001) with the
 * project's Python, runs each tests/browser*.cjs in turn against it, prints a summary, and stops the server.
 *
 *   npm test                      every browser test
 *   npm test -- vr headset-page   only tests/browser-vr.cjs and tests/browser-headset-page.cjs
 *
 * Set up once with `npm install` and `npm run setup` (Playwright's Chromium). TERRAIN_CHROMIUM_PATH uses another
 * Chromium instead; TERRAIN_TEST_PORT another port.
 */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');

const root=path.join(__dirname,'..');
const port=Number(process.env.TERRAIN_TEST_PORT||8001);
const url=`http://127.0.0.1:${port}`;

function python() {
  const venv=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return fs.existsSync(venv)?venv:process.platform==='win32'?'python':'python3';
}
const answers=()=>new Promise(resolve=>{
  const request=http.get(url,response=>{response.resume();resolve(true);});
  request.on('error',()=>resolve(false));request.setTimeout(2000,()=>{request.destroy();resolve(false);});
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function chosenTests() {
  const all=fs.readdirSync(path.join(root,'tests')).filter(name=>/^browser.*\.cjs$/.test(name)).sort();
  const wanted=process.argv.slice(2);
  if(!wanted.length)return all;
  const picked=all.filter(name=>wanted.some(want=>name===`browser-${want}.cjs`||name===want||name===`${want}.cjs`||(want==='main'&&name==='browser.cjs')));
  if(!picked.length){console.error(`No browser test matches ${wanted.join(', ')}. Tests: ${all.join(', ')}`);process.exit(2);}
  return picked;
}

function run(file) {
  return new Promise(resolve=>{
    const started=Date.now(),output=[];
    const child=spawn(process.execPath,[path.join(root,'tests',file)],{cwd:root,env:{...process.env,TERRAIN_TEST_URL:url}});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output.push(chunk));
    child.on('close',code=>resolve({file,code,seconds:(Date.now()-started)/1000,output:Buffer.concat(output).toString()}));
  });
}

(async()=>{
  try{require.resolve('playwright-core');}catch{console.error('Run `npm install` and `npm run setup` first.');process.exit(2);}
  const tests=chosenTests();
  if(await answers()){console.error(`Something is already answering on ${url}. Stop it, or set TERRAIN_TEST_PORT.`);process.exit(2);}
  console.log(`Starting the fixture server on ${url} …`);
  const server=spawn(python(),[path.join(root,'scripts','browser_fixture_server.py'),String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
  const serverLog=[];for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>serverLog.push(chunk));
  const stop=()=>{if(server.exitCode===null)server.kill();};
  process.on('SIGINT',()=>{stop();process.exit(130);});
  try {
    for(let i=0;i<60&&!(await answers());i++){
      if(server.exitCode!==null)throw new Error(`The fixture server stopped:\n${Buffer.concat(serverLog)}`);
      await pause(500);
    }
    if(!(await answers()))throw new Error('The fixture server did not start within 30 seconds.');
    const results=[];
    for(const file of tests) {
      process.stdout.write(`${file.padEnd(32)} `);
      const result=await run(file);results.push(result);
      const last=result.output.trim().split('\n').filter(line=>!/^\s+at /.test(line)).pop()||'';
      console.log(`${result.code===0?'passed':'FAILED'}  (${result.seconds.toFixed(0)} s)${result.code===0?'':`\n${result.output.trim().split('\n').filter(line=>!/^\s+at /.test(line)).slice(0,12).join('\n')}\n`}`);
      if(result.code===0&&!/passed/i.test(last))console.log(`  (finished without its usual "passed" line: ${last.slice(0,120)})`);
    }
    const failed=results.filter(result=>result.code!==0);
    console.log(`\n${results.length-failed.length} of ${results.length} browser tests passed.`);
    process.exitCode=failed.length?1:0;
  } catch(error){console.error(error.message);process.exitCode=1;}
  finally{stop();}
})();
