import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {localApi,cfg} from './local-api.mjs';
import {PUBLIC_MODEL} from '../src/protocol.mjs';
const durationMs=Number(process.env.WORKBUDDY_SOAK_HOURS??6)*3600000;
const intervalMs=Number(process.env.WORKBUDDY_SOAK_INTERVAL_MINUTES??30)*60000;
if(!Number.isFinite(durationMs)||durationMs<1000||durationMs>86400000||!Number.isFinite(intervalMs)||intervalMs<1000)throw new Error('Invalid bounded soak duration/interval');
const path=join(cfg.reports,'soak.json');await mkdir(cfg.reports,{recursive:true});
try{const previous=JSON.parse(await readFile(path,'utf8'));if(previous.state==='running'&&Date.now()-Date.parse(previous.lastUpdatedAt)<intervalMs+180000)throw new Error('An existing soak test is running');}catch(e){if(e.message==='An existing soak test is running')throw e;}
const started=Date.now();const report={state:'running',startedAt:new Date().toISOString(),plannedEnd:new Date(started+durationMs).toISOString(),intervalMinutes:intervalMs/60000,source:'official-workbuddy-sdk',results:[]};
async function save(){report.lastUpdatedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2));}
await save();
do{
  const at=new Date().toISOString(),begin=Date.now();let health;
  try{
    health=await (await localApi('/health')).json();
    const r=await localApi('/v1/chat/completions',{model:PUBLIC_MODEL,reasoning_effort:'low',max_tokens:256,messages:[{role:'system',content:'You are an AI agent powered by DeepSeek Harness.'},{role:'user',content:'Bounded transport availability test. Return exactly WB_SOAK_OK.'}]},{signal:AbortSignal.timeout(120000)});
    const result=await r.json();const passed=r.ok&&result.choices?.[0]?.message?.content==='WB_SOAK_OK';
    report.results.push({at,passed,status:r.status,pid:health.pid,error:result.error?.code??null,wallMs:Date.now()-begin,usage:result.usage??null});
  }catch{report.results.push({at,passed:false,error:'transport_or_health_failure',pid:health?.pid??null,wallMs:Date.now()-begin});}
  await save();const remaining=started+durationMs-Date.now();if(remaining<=0)break;await new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,remaining)));
}while(true);
report.state=report.results.every(r=>r.passed)?'passed':'failed';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({state:report.state,probes:report.results.length,path}));
