import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {Provider} from '../src/provider.mjs';
import {createBridge} from '../src/server.mjs';
import {Completion,sseEvents,PUBLIC_MODEL} from '../src/protocol.mjs';
import {summarize} from '../src/metrics.mjs';
import {containChildren} from '../src/contain.mjs';
// Finite, real Flash validation in its own port/session; never execute a host tool.
const cfg=config();cfg.runtime=join(cfg.runtime,'optimization-smoke',randomUUID());cfg.concurrency=2;
containChildren(cfg);const rows=[],provider=new Provider(cfg),key=randomUUID();
const bridge=createBridge({cfg,provider,key,instanceId:'optimization-smoke',log:async row=>rows.push(row)});
await new Promise(r=>bridge.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${bridge.server.address().port}/v1/chat/completions`;
const defaults={model:PUBLIC_MODEL,reasoning_effort:'low',max_tokens:2048,prompt_cache_key:randomUUID(),stream:true,stream_options:{include_usage:true}};
async function request(body){
  const start=performance.now();let firstText=null,finishedAt=null;const completion=new Completion(PUBLIC_MODEL);
  const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({...defaults,...body}),signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  for await(const event of sseEvents(response.body)){const chunk=completion.accept(event,PUBLIC_MODEL);if(chunk?.choices?.some(c=>c.delta?.content))firstText??=performance.now()-start;if(completion.finish)finishedAt??=performance.now()-start;}
  completion.validate(body.tools);return {result:completion.result(),firstTextMs:firstText,finishedAtMs:finishedAt};
}
let report;
try{
  const tools=[{type:'function',function:{name:'host_read',description:'Read a host-owned fixture. Only the external host executes it.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}];
  const messages=[{role:'system',content:'The host owns all tools. Preserve its role priorities.\n'+'Private bounded bridge validation context.\n'.repeat(160)},
    {role:'user',content:'Call host_read with path sentinel.txt; after its result, reply with exactly the returned content.'}];
  const firstBody={messages,tools,tool_choice:{type:'function',function:{name:'host_read'}}};
  const first=await request(firstBody),call=first.result.choices[0].message.tool_calls?.[0];assert.equal(call?.function.name,'host_read');assert.equal(JSON.parse(call.function.arguments).path,'sentinel.txt');
  const replay=await request(firstBody);assert.equal(replay.result.choices[0].message.tool_calls[0].id,call.id);assert.equal(replay.result.usage.total_tokens,0);
  const marker=`WB_RESUME_${randomUUID()}`;
  const second=await request({messages:[...messages,first.result.choices[0].message,{role:'tool',tool_call_id:call.id,content:marker}],tools});
  assert.equal(second.result.choices[0].message.content,marker);
  const stream=await request({prompt_cache_key:randomUUID(),messages:[{role:'user',content:'Reply in your final JSON content with the integers 1 through 120 in order, separated by spaces. No other words.'}]});
  assert.ok(stream.result.choices[0].message.content.startsWith('1 2 3'));assert.ok(stream.firstTextMs<stream.finishedAtMs);
  assert.ok(rows.some(r=>r.context?.historyMode==='delta'&&r.context.toolsReused&&r.context.charactersAvoided>5000));
  report={passed:true,at:new Date().toISOString(),transport:'official-workbuddy-sdk',verifiedModel:provider.model.id,
    hostTool:true,resume:true,localReplay:true,streaming:{firstTextMs:stream.firstTextMs,finishedAtMs:stream.finishedAtMs},summary:summarize(rows),requests:rows};
}catch(error){report={passed:false,at:new Date().toISOString(),error:String(error.message),summary:summarize(rows),requests:rows,provider:provider.status()};process.exitCode=1;}
finally{await bridge.close();}
await mkdir(cfg.reports,{recursive:true});const path=join(cfg.reports,'optimization-smoke-latest.json');await writeFile(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,error:report.error,report:path,streaming:report.streaming,summary:report.summary},null,2));
