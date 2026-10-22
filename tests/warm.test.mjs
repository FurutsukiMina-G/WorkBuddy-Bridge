import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {SdkTransport} from '../src/sdk-transport.mjs';
import {Completion,sseEvents} from '../src/protocol.mjs';
const model='deepseek-v4.1-flash';
const credential={uid:'fixture',domain:'www.workbuddy.cn',accessToken:'fake-token',refreshToken:'fake-refresh'};
const tools=[{type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}}];
const body={model,prompt_cache_key:'warm-a',messages:[{role:'user',content:'task'}],tools,max_tokens:2048,reasoning_effort:'low'};
const usage={input_tokens:5000,output_tokens:20};
async function* turn({text='',calls=[],dies=false}){
  if(dies)throw new Error('runtime exited before init');
  yield {type:'system',subtype:'init',model,session_id:'warm-session',mcp_servers:[{name:'host',status:'connected'}]};
  if(!calls.length){
    yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}};
    yield {type:'result',subtype:'success',is_error:false,result:text,session_id:'warm-session',usage};return;
  }
  yield {type:'assistant',message:{model,content:calls.map(c=>({type:'tool_use',id:c.id,name:'mcp__host__read',input:c.input})),stop_reason:'tool_use',usage}};
  throw Object.assign(new Error('Max turns (1) exceeded'),{subtype:'error_during_execution'});
}
/** A query double with the SDK's connect()/cleanup() surface; records what each runtime did. */
async function fixture(t,steps,cfg={}){
  const runtime=await mkdtemp(join(tmpdir(),'wb-warm-'));const runs=[];
  const run=({prompt,options})=>{
    const entry={options,prestarted:typeof prompt!=='string',connected:0,cleaned:0,started:false};const step=steps[runs.length];runs.push(entry);
    const query=(async function*(){
      entry.prompt=typeof prompt==='string'?prompt:(await prompt[Symbol.asyncIterator]().next()).value?.message?.content;entry.started=true;yield* turn(step);
    })();
    return Object.assign(query,{connect:async()=>{entry.connected++;},cleanup:()=>{entry.cleaned++;}});
  };
  const transport=new SdkTransport({runtime,cliPath:process.execPath,toolMode:'native',prewarmMs:5000,maxWarm:2,...cfg},{get:async()=>credential},{run});
  t.after(async()=>{await transport.close();await rm(runtime,{recursive:true,force:true});});return {transport,runs};
}
async function collect(transport,request){
  const response=await transport.chat(request,new AbortController().signal);const completion=new Completion(model);
  for await(const frame of sseEvents(response.body)){if(frame.startsWith('{')&&JSON.parse(frame).error)throw new Error(frame);completion.accept(frame,model);}
  completion.validate(request.tools);return {result:completion.result(),metrics:response.bridgeMetrics};
}
const next=(first,extra={})=>({...body,...extra,messages:[...body.messages,first.result.choices[0].message,{role:'tool',tool_call_id:'call_00_W',content:'HOST_RESULT'}]});
const call={calls:[{id:'call_00_W',input:{file_path:'a.ts'}}]};
test('the next turn runs on a runtime that booted while the host executed the calls',async t=>{
  const {transport,runs}=await fixture(t,[call,{text:'a.ts 已检查完毕。'}]);
  const first=await collect(transport,body);await sleep(450);
  assert.equal(runs.length,2);assert.equal(runs[1].prestarted,true);assert.equal(runs[1].connected,1);assert.equal(runs[1].started,false);
  assert.equal(runs[1].options.resume,'warm-session');assert.equal(runs[1].options.mcpServers.host.type,'sdk');
  const second=await collect(transport,next(first));
  assert.equal(runs.length,2);assert.equal(second.metrics.warmStart,true);assert.equal(second.result.choices[0].message.content,'a.ts 已检查完毕。');
  assert.match(runs[1].prompt,/HOST_RESULT/);assert.equal(runs[1].cleaned,0);assert.equal(transport.warm.stats.used,1);assert.equal(second.metrics.attempts[0].warm,true);
});
test('a turn whose options changed discards the prestarted runtime and starts its own',async t=>{
  const {transport,runs}=await fixture(t,[call,{text:'unused'},{text:'fresh runtime answer'}]);
  const first=await collect(transport,body);await sleep(450);
  const changed=[...tools,{type:'function',function:{name:'write',parameters:{type:'object'}}}];
  const second=await collect(transport,next(first,{tools:changed}));
  assert.equal(runs.length,3);assert.equal(runs[1].started,false);assert.ok(runs[1].cleaned>=1);assert.equal(runs[2].prestarted,false);
  assert.equal(second.metrics.warmStart,false);assert.equal(second.result.choices[0].message.content,'fresh runtime answer');assert.equal(transport.warm.stats.discarded,1);
});
test('a prestarted runtime that dies before initializing is replaced by a cold one',async t=>{
  const {transport,runs}=await fixture(t,[call,{dies:true},{text:'cold answer'}]);
  const first=await collect(transport,body);await sleep(450);
  const second=await collect(transport,next(first));
  assert.equal(runs.length,3);assert.ok(runs[1].cleaned>=1);assert.equal(second.metrics.warmFailed,true);assert.equal(second.metrics.warmStart,false);assert.equal(second.result.choices[0].message.content,'cold answer');
  assert.equal(transport.warm.stats.used,0);assert.equal(transport.warm.stats.discarded,1);
});
test('unused prestarted runtimes expire, and closing the transport ends them',async t=>{
  const expiring=await fixture(t,[call,{text:'never'}],{prewarmMs:150});
  await collect(expiring.transport,body);await sleep(650);
  assert.ok(expiring.runs[1].cleaned>=1);assert.equal(expiring.transport.warm.stats.expired,1);assert.equal(expiring.transport.warm.stats.discarded,0);assert.equal(expiring.transport.warm.size,0);
  const closing=await fixture(t,[call,{text:'never'}]);
  await collect(closing.transport,body);await sleep(450);await closing.transport.close();
  assert.ok(closing.runs[1].cleaned>=1);assert.equal(closing.transport.warm.stats.discarded,1);assert.equal(closing.transport.warm.size,0);
});
test('final answers start no runtime, and prestarting can be disabled',async t=>{
  const final=await fixture(t,[{text:'All done.'}]);await collect(final.transport,body);await sleep(450);assert.equal(final.runs.length,1);
  const disabled=await fixture(t,[call],{prewarmMs:0});await collect(disabled.transport,body);await sleep(450);assert.equal(disabled.runs.length,1);
});
