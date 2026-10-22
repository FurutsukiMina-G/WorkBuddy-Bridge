import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {config} from '../src/config.mjs';
import {Provider} from '../src/provider.mjs';
import {createBridge} from '../src/server.mjs';
import {Completion,sseEvents,PUBLIC_MODEL} from '../src/protocol.mjs';
import {summarize} from '../src/metrics.mjs';
import {containChildren} from '../src/contain.mjs';
// Finite, real Flash validation of native host functions and prestarted runtimes on a private
// port and runtime directory. No host tool is ever executed: results below are fixed markers.
const args=process.argv.slice(2),toolsAt=args.indexOf('--tools');
const cfg=config();cfg.runtime=join(cfg.runtime,'native-smoke',randomUUID());cfg.concurrency=2;cfg.toolMode='native';
containChildren(cfg);const rows=[],provider=new Provider(cfg),key=randomUUID();
const bridge=createBridge({cfg,provider,key,instanceId:'native-smoke',log:async row=>rows.push(row)});
await new Promise(r=>bridge.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${bridge.server.address().port}/v1/chat/completions`;
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
// Representative host schemas; --tools <file> replays a captured host tool list instead.
const tools=toolsAt>=0?JSON.parse(await readFile(args[toolsAt+1],'utf8')):[
  {type:'function',function:{name:'read',description:'Read a file from the host workspace.',parameters:object({file_path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},['file_path'])}},
  {type:'function',function:{name:'write',description:'Write a file in the host workspace.',parameters:object({file_path:{type:'string'},content:{type:'string'}},['file_path','content'])}},
  {type:'function',function:{name:'grep',description:'Search file contents in the host workspace.',parameters:object({pattern:{type:'string'},path:{type:'string'}},['pattern'])}},
  {type:'function',function:{name:'pwsh',description:'Run a PowerShell command on the host.',parameters:object({command:{type:'string'},description:{type:'string'}},['command','description'])}},
];
const system={role:'system',content:'You are an AI agent powered by DeepSeek Harness. The host executes every tool call and returns its result.'};
async function request(body){
  const start=performance.now();let firstText=null,finishedAt=null;const completion=new Completion(PUBLIC_MODEL);
  const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
    body:JSON.stringify({model:PUBLIC_MODEL,reasoning_effort:'low',max_tokens:4096,stream:true,stream_options:{include_usage:true},tools,...body}),signal:AbortSignal.timeout(240000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  for await(const event of sseEvents(response.body)){
    if(event.startsWith('{')&&JSON.parse(event).error)throw new Error(`Bridge error: ${event}`);
    const chunk=completion.accept(event,PUBLIC_MODEL);if(chunk?.choices?.some(c=>c.delta?.content))firstText??=performance.now()-start;if(completion.finish)finishedAt??=performance.now()-start;
  }
  completion.validate(tools);return {message:completion.result().choices[0].message,finish:completion.finish,firstTextMs:firstText,finishedAtMs:finishedAt,row:rows.at(-1)};
}
const result=(call,content)=>({role:'tool',tool_call_id:call.id,content});
let report;const steps=[];
try{
  // 1. A sequential agent step: native call, host result, exact answer on a prestarted runtime.
  const marker=`WB_NATIVE_${randomUUID()}`,loop=randomUUID();
  const messages=[system,{role:'user',content:'Use the read tool to read sentinel.txt, then reply with exactly its content and nothing else.'}];
  const first=await request({prompt_cache_key:loop,messages});steps.push({step:'sequential-call',...first.row?.context&&{context:first.row.context},finish:first.finish});
  assert.equal(first.finish,'tool_calls');const call=first.message.tool_calls[0];assert.equal(call.function.name,'read');assert.match(JSON.parse(call.function.arguments).file_path,/sentinel\.txt$/);
  await sleep(2500);// the host would be executing the call now
  const second=await request({prompt_cache_key:loop,messages:[...messages,first.message,result(call,marker)]});steps.push({step:'sequential-answer',finish:second.finish,warmStart:second.row?.context?.warmStart});
  assert.equal(second.message.content.trim(),marker);assert.equal(second.row.context.warmStart,true);
  // 2. Parallel host calls in one native step.
  const parallel=randomUUID(),a=`A_${randomUUID().slice(0,8)}`,b=`B_${randomUUID().slice(0,8)}`;
  const pm=[system,{role:'user',content:'In a single step, call read for a.txt and read for b.txt at the same time. After both results arrive, reply with the two contents joined by one comma and nothing else.'}];
  const batch=await request({prompt_cache_key:parallel,messages:pm});
  assert.equal(batch.finish,'tool_calls');const calls=batch.message.tool_calls;assert.ok(calls.length>=2,'expected parallel calls');
  const contents=calls.map(c=>JSON.parse(c.function.arguments).file_path.endsWith('b.txt')?b:a);
  await sleep(2500);
  const joined=await request({prompt_cache_key:parallel,messages:[...pm,batch.message,...calls.map((c,i)=>result(c,contents[i]))]});
  assert.ok(joined.message.content.includes(a)&&joined.message.content.includes(b));steps.push({step:'parallel',calls:calls.length,warmStart:joined.row?.context?.warmStart});
  // 3. A long final answer streams as plain text before the turn ends.
  const stream=await request({prompt_cache_key:randomUUID(),messages:[system,{role:'user',content:'No tools are needed. Reply with the integers 1 through 120 in order, separated by spaces, and nothing else.'}]});
  assert.ok(stream.message.content.trim().startsWith('1 2 3'));assert.ok(stream.firstTextMs<stream.finishedAtMs);
  report={passed:true,at:new Date().toISOString(),transport:'official-workbuddy-sdk',toolMode:'native',verifiedModel:provider.model.id,hostTools:tools.length,
    steps,streaming:{firstTextMs:stream.firstTextMs,finishedAtMs:stream.finishedAtMs},summary:summarize(rows),requests:rows,warm:provider.transport.warm.stats};
}catch(error){report={passed:false,at:new Date().toISOString(),error:String(error.message),steps,summary:summarize(rows),requests:rows,provider:provider.status()};process.exitCode=1;}
finally{await bridge.close();await rm(cfg.runtime,{recursive:true,force:true}).catch(()=>{});}
await mkdir(cfg.reports,{recursive:true});const path=join(cfg.reports,'native-smoke-latest.json');await writeFile(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,error:report.error,report:path,steps:report.steps,streaming:report.streaming,runtime:report.summary.runtime,
  requests:rows.map(r=>({outcome:r.outcome,wallMs:r.wallMs,firstTextMs:r.firstTextMs,runtimeReadyMs:r.context?.runtimeReadyMs,warm:r.context?.warmStart,attempts:r.context?.attempts?.length,usage:r.usage&&[r.usage.prompt_tokens,r.usage.completion_tokens,r.usage.prompt_tokens_details?.cached_tokens]}))},null,2));
