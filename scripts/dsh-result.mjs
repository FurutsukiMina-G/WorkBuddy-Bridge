import {readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {rpc} from './dsh-rpc.mjs';
import {cfg} from './local-api.mjs';
const tool=process.argv[2]??'read';if(!['read','pwsh'].includes(tool))throw new Error('Use read or pwsh');
const path=join(cfg.reports,`dsh-smoke-${tool}.json`);const report=JSON.parse(await readFile(path,'utf8'));
const list=await rpc('session/list',{_request:{}});const session=list.items?.find(s=>s.sessionId===report.sessionId);if(!session)throw new Error('Validation session missing');
const page=await rpc('session/page',{request:{address:{kind:'session',sessionId:report.sessionId},throughSeq:session.projections?.asOfSeq,maxMessages:120}});
// Store only this bridge's newly-created sentinel session, not any user session.
await writeFile(join(cfg.reports,`dsh-events-${tool}.json`),JSON.stringify(page,null,2));
const events=page.records.map(r=>r.event??r);const summaries=events.map(e=>({type:e.type,keys:Object.keys(e),data:JSON.stringify(e.data??e.payload??{}).slice(0,300)}));
const calls=events.filter(e=>e.type==='tool/call').map(e=>e.data?.name);
const last=events.filter(e=>e.type==='assistant/message').at(-1);
const finalText=last?.data?.message?.content?.filter(c=>c.type==='text').map(c=>c.text).join('')??'';
const successfulTool=events.some(e=>e.type==='tool/result'&&!e.data?.message?.isError&&JSON.stringify(e.data).includes(report.marker));
const completed=events.some(e=>e.type==='turn/end'&&e.data?.reason?.kind==='completed');
const usage=events.filter(e=>e.type==='assistant/message').map(e=>e.data?.usage).filter(Boolean);
const usageMapped=usage.length>=2&&usage.every(u=>Number.isSafeInteger(u.inputTokens)&&Number.isSafeInteger(u.outputTokens)&&Number.isSafeInteger(u.cacheReadTokens)&&
  u.inputTokens>=0&&u.outputTokens>0&&u.cacheReadTokens>=0&&u.inputTokens+u.outputTokens+u.cacheReadTokens===u.totalTokens);
const passed=calls.includes(tool)&&successfulTool&&completed&&finalText.trim()===report.marker&&usageMapped;
const result={sessionId:report.sessionId,tool,passed,running:session.running,throughSeq:session.projections?.asOfSeq,calls,successfulTool,completed,finalMarkerMatches:finalText.trim()===report.marker,usageMapped,usage};
if((completed||!session.running)&&process.argv.includes('--cleanup')){
  if(report.cwd){const parent=resolve(cfg.runtime,'dsh-smoke'),inside=relative(parent,resolve(report.cwd));if(inside&&!inside.startsWith('..')&&!isAbsolute(inside))await rm(report.cwd,{recursive:true,force:true}).catch(()=>{});}
  result.cleaned=true;
}
await writeFile(join(cfg.reports,`dsh-validation-${tool}.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,...process.argv.includes('--verbose')?{events:summaries}:{}},null,2));
if((completed||!session.running)&&!passed)process.exitCode=1;
