import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {cfg,localApi} from './local-api.mjs';
const instance=(await readFile(join(cfg.runtime,'instance-id'),'utf8')).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const health=async()=>{const response=await localApi('/health',undefined,{signal:AbortSignal.timeout(2000)});const h=await response.json();
  if(!response.ok||h.service!=='workbuddy-bridge'||h.instanceId!==instance)throw new Error('Bridge identity mismatch');return h;};
function owned(pid,script){
  if(process.platform!=='win32')throw new Error('This process-ownership verifier is Windows-only');
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(cfg.root,'scripts/verify-supervisor.ps1'),'-CandidatePid',String(pid),'-ExpectedScript',join(cfg.root,script),'-ExpectedExe',process.execPath],{encoding:'utf8',windowsHide:true,timeout:10000}).trim()==='owned';
}
const supervisor=Number((await readFile(join(cfg.runtime,'supervisor.lock'),'utf8')).trim());
if(!Number.isSafeInteger(supervisor)||supervisor<=0||!owned(supervisor,'scripts/supervisor.mjs'))throw new Error('No verified supervisor; nothing restarted');
let before,after;const start=Date.now();
const initial=await health();let verifiedPid=initial.pid,idleSince=null;
if(!owned(verifiedPid,'src/main.mjs'))throw new Error('Worker ownership not verified');
console.log(JSON.stringify({event:'waiting_for_idle',targetVersion:cfg.version,maxWaitMs:120000,minimumIdleMs:2000}));
while(Date.now()-start<120000){
  const h=await health();if(h.version===cfg.version&&h.ready){after=h;break;}
  if(h.pid!==verifiedPid){if(!owned(h.pid,'src/main.mjs'))throw new Error('Replacement worker ownership not verified');verifiedPid=h.pid;idleSince=null;}
  if(h.active===0&&h.queued===0){
    idleSince??=Date.now();
  }else idleSince=null;
  if(idleSince!==null&&Date.now()-idleSince>=2000){
    // Require a quiet interval and recheck immediately before stopping this
    // installation's verified worker; active/queued turns are never terminated.
    const check=await health();if(check.pid===h.pid&&check.active===0&&check.queued===0){before=check;process.kill(check.pid);break;}
  }
  await sleep(100);
}
if(!before&&!after)throw new Error('No idle window; running requests were left alone');
const restarted=Date.now();
while(!after&&Date.now()-restarted<30000){try{const h=await health();if(h.ready&&h.version===cfg.version&&h.pid!==before.pid)after=h;}catch{}if(!after)await sleep(250);}
if(!after)throw new Error('Supervisor restart not yet verified');
const report={at:new Date().toISOString(),passed:true,version:after.version,previousPid:before?.pid??null,pid:after.pid,idleVerified:before?before.active===0&&before.queued===0:null,
  ready:after.ready,active:after.active,queued:after.queued,minimumIdleMs:2000,waitMs:Date.now()-start};
await writeFile(join(cfg.reports,'idle-reload-latest.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
