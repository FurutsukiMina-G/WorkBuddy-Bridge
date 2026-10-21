import {spawn,execFileSync} from 'node:child_process';
import {open,readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {containChildren} from '../src/contain.mjs';
const cfg=config();containChildren(cfg);await mkdir(cfg.runtime,{recursive:true});await mkdir(cfg.reports,{recursive:true});
const lock=join(cfg.runtime,'supervisor.lock');
try{const f=await open(lock,'wx');await f.writeFile(String(process.pid));await f.close();}catch(e){
  if(e.code!=='EEXIST')throw e;const previous=Number(await readFile(lock,'utf8'));let alive=false;
  if(Number.isSafeInteger(previous)&&previous>0){
    if(process.platform==='win32')alive=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(cfg.root,'scripts/verify-supervisor.ps1'),'-CandidatePid',String(previous),'-ExpectedScript',join(cfg.root,'scripts/supervisor.mjs'),'-ExpectedExe',process.execPath],{windowsHide:true,encoding:'utf8',timeout:10000}).trim()==='owned';
    else try{process.kill(previous,0);alive=true;}catch{}
  }
  if(alive){console.log('Supervisor already running');process.exit(0);}await rm(lock);const f=await open(lock,'wx');await f.writeFile(String(process.pid));await f.close();
}
const stdout=await open(join(cfg.reports,'worker.out.log'),'a');const stderr=await open(join(cfg.reports,'worker.err.log'),'a');
let child,stopping=false,restarts=0,delay=1000,watchdog,misses=0;
function start(){
  const started=Date.now();misses=0;
  child=spawn(process.execPath,[join(cfg.root,'src/main.mjs')],{cwd:cfg.root,env:process.env,windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});
  child.on('error',()=>{});
  child.on('close',async(code)=>{
    if(stopping)return;if(code===78){console.error('Port occupied; supervisor stopped without touching the other listener');await finish();return;}
    restarts++;delay=Date.now()-started>120000?1000:Math.min(delay*2,30000);
    await writeFile(join(cfg.runtime,'supervisor-status.json'),JSON.stringify({pid:process.pid,restarts,lastExit:code,nextRestartMs:delay}));
    setTimeout(()=>{if(!stopping)start();},delay);
  });
}
async function finish(){stopping=true;clearInterval(watchdog);child?.kill();await rm(lock,{force:true});await stdout.close();await stderr.close();process.exit(0);}
process.on('SIGTERM',finish);process.on('SIGINT',finish);
start();let checking=false;
watchdog=setInterval(async()=>{
  if(checking||!child||child.exitCode!==null)return;checking=true;
  try{const key=(await readFile(join(cfg.runtime,'bridge-key'),'utf8')).trim();const id=(await readFile(join(cfg.runtime,'instance-id'),'utf8')).trim();const r=await fetch(`http://127.0.0.1:${cfg.port}/health`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000),redirect:'error'});const h=await r.json();if(!r.ok||h.instanceId!==id||h.pid!==child.pid)throw new Error('identity');misses=0;}catch{if(++misses>=3)child?.kill();}finally{checking=false;}
},20000);
