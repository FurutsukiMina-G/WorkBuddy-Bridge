import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT} from '../src/config.mjs';
const parent=resolve(ROOT,'.runtime/lifecycle');const runtime=join(parent,randomUUID());await mkdir(runtime,{recursive:true});
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const env={...process.env,WORKBUDDY_PORT:String(port),WORKBUDDY_RUNTIME_DIR:runtime,WORKBUDDY_REPORTS_DIR:join(runtime,'reports'),WORKBUDDY_AUTH_FILE:join(runtime,'deliberately-missing-auth.info')};
const supervisor=spawn(process.execPath,[join(ROOT,'scripts/supervisor.mjs')],{cwd:ROOT,env,windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let current;
async function health(){const key=(await readFile(join(runtime,'bridge-key'),'utf8')).trim();const r=await fetch(`http://127.0.0.1:${port}/health`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(1000)});const h=await r.json();const id=(await readFile(join(runtime,'instance-id'),'utf8')).trim();if(h.instanceId!==id||h.service!=='workbuddy-bridge')throw new Error('Identity mismatch');return h;}
async function until(fn){const start=Date.now();while(Date.now()-start<20000){try{const h=await health();if(fn(h)){current=h;return h;}}catch{}await sleep(200);}throw new Error('Lifecycle deadline');}
try{
  const initial=await until(()=>true);const started=Date.now();process.kill(initial.pid);const recovered=await until(h=>h.pid!==initial.pid);
  if(recovered.instanceId!==initial.instanceId)throw new Error('Installation identity changed');
  const recoveryMs=Date.now()-started;supervisor.kill();
  const reapStart=Date.now();let alive=true;while(Date.now()-reapStart<5000){try{process.kill(recovered.pid,0);}catch{alive=false;break;}await sleep(100);}
  if(alive)throw new Error('Worker survived supervisor death');
  const report={passed:true,crashedWorker:initial.pid,recoveredWorker:recovered.pid,recoveryMs,identityPreserved:true,supervisorDeathReapsWorker:true,authOutageDoesNotCrashService:recovered.ready===false};
  await mkdir(join(ROOT,'reports'),{recursive:true});await writeFile(join(ROOT,'reports/lifecycle-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  supervisor.kill();if(current?.pid)try{process.kill(current.pid);}catch{}
  await sleep(500);const inside=relative(parent,resolve(runtime));if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe cleanup target');await rm(runtime,{recursive:true,force:true});
}
