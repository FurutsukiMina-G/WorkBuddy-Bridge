import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SdkTransport} from '../src/sdk-transport.mjs';
import {Completion,sseEvents} from '../src/protocol.mjs';
import {FinalTextProjector} from '../src/streaming.mjs';
import {normalizedUsage,sumUsage} from '../src/usage.mjs';
import {summarize} from '../src/metrics.mjs';
const model='deepseek-v4.1-flash';
const credential={uid:'fixture',domain:'www.workbuddy.cn',accessToken:'fake-token',refreshToken:'fake-refresh'};
const body={model,prompt_cache_key:'session-a',messages:[{role:'system',content:'priority '.repeat(1000)},{role:'user',content:'test'}],max_tokens:2048,reasoning_effort:'low'};
const tools=[{type:'function',function:{name:'write',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}}];
function* events(text,id='fixture-session',usage={input_tokens:5000,output_tokens:20,cache_read_input_tokens:4000,cache_creation_input_tokens:0}){
  yield {type:'system',subtype:'init',model,session_id:id};
  yield {type:'assistant',uuid:'a',message:{model,content:[{type:'text',text}],usage}};
  yield {type:'result',subtype:'success',is_error:false,result:text,session_id:id,usage};
}
async function fixture(t,run,cfg={}){
  const runtime=await mkdtemp(join(tmpdir(),'wb-efficiency-'));const transport=new SdkTransport({runtime,cliPath:process.execPath,...cfg},{get:async()=>credential},{run});
  t.after(async()=>{await transport.close();await rm(runtime,{recursive:true,force:true});});return transport;
}
async function collect(transport,request=body,signal=new AbortController().signal){
  const response=await transport.chat(request,signal);const completion=new Completion(model);let raw='';
  for await(const frame of sseEvents(response.body)){raw+=frame;if(frame.startsWith('{')&&JSON.parse(frame).error)return {raw,metrics:response.bridgeMetrics};completion.accept(frame,model);}
  completion.validate(request.tools);return {result:completion.result(),raw,metrics:response.bridgeMetrics};
}
test('native resume injects only new messages, reuses exact schemas and avoids a large tool echo',async t=>{
  const received=[];let turn=0;const text='file-data '.repeat(2000);
  const transport=await fixture(t,async function*(input){received.push(input);yield* events(JSON.stringify(++turn===1?{action:'tool_calls',calls:[{name:'write',arguments:{text}}]}:{action:'final',content:'done'}));});
  const first=await collect(transport,{...body,tools});const message=first.result.choices[0].message;
  message.tool_calls[0].function.arguments=JSON.stringify(JSON.parse(message.tool_calls[0].function.arguments),null,2);
  const second=await collect(transport,{...body,tools,messages:[...body.messages,{...message,reasoning_content:'ignored metadata'},{role:'tool',tool_call_id:message.tool_calls[0].id,content:'HOST_RESULT'}]});
  assert.equal(received[0].options.resume,undefined);assert.equal(received[1].options.resume,'fixture-session');
  assert.equal(received[1].options.persistSession,true);assert.ok(!received[1].prompt.includes(body.messages[0].content));assert.ok(!received[1].prompt.includes(text));
  assert.match(received[1].prompt,/HOST_RESULT/);assert.match(received[1].prompt,/tools_unchanged/);assert.match(received[1].prompt,new RegExp(message.tool_calls[0].id));
  assert.equal(second.metrics.historyMode,'delta');assert.ok(second.metrics.echoCharactersAvoided>10000);assert.ok(second.metrics.charactersAvoided>20000);
});
test('identical retries retain tool IDs, do not call the model, and report local zero usage',async t=>{
  let calls=0;const transport=await fixture(t,async function*(){calls++;yield* events(JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:{text:'x'}}]}));});
  const request={...body,tools};const first=await collect(transport,request),retry=await collect(transport,request);
  assert.equal(calls,1);assert.deepEqual(retry.result.choices,first.result.choices);assert.equal(retry.result.id,first.result.id);
  assert.equal(retry.result.usage.total_tokens,0);assert.equal(retry.result.usage.bridge_usage_source,'local-response-replay');
});
test('rewritten history, isolated client keys, effort, public window and account identity cannot share context',async t=>{
  const received=[];const transport=await fixture(t,async function*(input){received.push(input);yield* events('{"action":"final","content":"ok"}');});
  await collect(transport);const next=[...body.messages,{role:'assistant',content:'ok'},{role:'user',content:'next'}];
  await collect(transport,{...body,messages:[{role:'system',content:'changed'},...next.slice(1)]});
  await collect(transport,{...body,prompt_cache_key:'session-b',messages:next});
  await collect(transport,{...body,reasoning_effort:'high',messages:next});
  await collect(transport,{...body,bridge_public_model:'window-200k',messages:next});
  transport.auth={get:async()=>({...credential,uid:'another-account'})};await collect(transport,{...body,messages:next});
  assert.ok(received.every(r=>r.options.resume===undefined));
});
test('schema changes are resent intact; tool-result IDs can route a continuation without a client key',async t=>{
  const received=[];let calls=0;const transport=await fixture(t,async function*(input){received.push(input);yield* events(JSON.stringify(++calls===1?{action:'tool_calls',calls:[{name:'write',arguments:{text:'x'}}]}:{action:'final',content:'ok'}));});
  const request={...body,prompt_cache_key:undefined,tools};const first=await collect(transport,request),message=first.result.choices[0].message;
  const changed=structuredClone(tools);changed[0].function.parameters.properties.text.maxLength=99;
  const second=await collect(transport,{...request,tools:changed,messages:[...body.messages,message,{role:'tool',tool_call_id:message.tool_calls[0].id,content:'result'}]});
  assert.equal(received[1].options.resume,'fixture-session');assert.match(received[1].prompt,/maxLength/);assert.equal(second.metrics.toolsReused,false);
});
test('concurrent duplicate requests single-flight; cancelling the waiter preserves the owner',async t=>{
  let go,started;const gate=new Promise(r=>{go=r;}),began=new Promise(r=>{started=r;});let calls=0;
  const transport=await fixture(t,async function*(){calls++;started();await gate;yield* events('{"action":"final","content":"ok"}');});
  const first=collect(transport);await began;const controller=new AbortController();const second=collect(transport,body,controller.signal);controller.abort(new DOMException('cancelled','AbortError'));
  await assert.rejects(second);go();assert.equal((await first).result.choices[0].message.content,'ok');assert.equal(calls,1);
  assert.equal((await collect(transport)).result.usage.total_tokens,0);
});
test('bounded format correction resumes the same model and sums every attempt once',async t=>{
  let calls=0;const transport=await fixture(t,async function*(input){calls++;if(calls===2)assert.equal(input.options.resume,'fixture-session');yield* events(calls===1?'bad decision':'{"action":"final","content":"recovered"}');});
  const result=await collect(transport);assert.equal(calls,2);assert.equal(result.result.choices[0].message.content,'recovered');assert.equal(result.result.usage.prompt_tokens,10000);
  assert.equal(result.metrics.attempts.length,2);assert.equal(transport.metrics.recoveredRequests,1);
});
test('repeated invalid output stops correction early without publishing an executable call',async t=>{
  let calls=0;const transport=await fixture(t,async function*(){calls++;yield* events('{"action":"tool_calls","calls":[{"name":"write","arguments":{}}]}');});
  const result=await collect(transport,{...body,tools});assert.equal(calls,2);assert.match(result.raw,/invalid_tool_arguments/);assert.ok(!result.raw.includes('"tool_calls":['));assert.ok(!result.raw.includes('[DONE]'));
  const replay=await collect(transport,{...body,tools});assert.equal(calls,2);assert.equal(replay.metrics.localReplay,true);assert.match(replay.raw,/local-rejection-replay/);
});
test('a wrapped tool envelope cannot leak as streaming final text or bypass correction',async t=>{
  let calls=0;const transport=await fixture(t,async function*(){
    calls++;const text=JSON.stringify({action:'final',content:'<system_call><name=write>bad</system_call>'});
    yield {type:'system',subtype:'init',model,session_id:'fixture-session'};
    for(const char of text)yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:char}}};
    yield* [...events(text)].slice(1);
  });
  const result=await collect(transport);assert.match(result.raw,/invalid_decision/);assert.ok(!result.raw.includes('<system_call>'));assert.equal(calls,2);
});
test('canonical final text arrives before the SDK terminal event; partial failures never report success',async t=>{
  let go;const gate=new Promise(r=>{go=r;});const transport=await fixture(t,async function*(){
    yield {type:'system',subtype:'init',model,session_id:'fixture-session'};
    yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'{"action":"final","content":"first'}}};
    await gate;yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:' second"}'}}};
    yield* [...events('{"action":"final","content":"first second"}')].slice(1);
  });
  const response=await transport.chat(body,new AbortController().signal),reader=response.body.getReader();let raw='';
  while(!raw.includes('"content":"first"')){const part=await reader.read();assert.equal(part.done,false);raw+=new TextDecoder().decode(part.value);}
  assert.ok(!raw.includes('"finish_reason":"stop"'));go();while(true){const part=await reader.read();if(part.done)break;raw+=new TextDecoder().decode(part.value);}
  assert.match(raw,/\[DONE\]/);assert.equal((raw.match(/"prompt_tokens":5000/g)??[]).length,1);
});
test('JSON string projection preserves split escapes, raw surrogate pairs and quotes',()=>{
  const chunks=[];const p=new FinalTextProjector(s=>chunks.push(s));const expected='中文 😀\n"quote"';
  const raw='{"action":"final","content":"中文 \\uD83D\\uDE00\\n\\"quote\\""}';for(const c of raw)p.push(c);p.finish({action:'final',content:expected});
  assert.equal(chunks.join(''),expected);assert.ok(chunks.every(c=>!/[\uD800-\uDBFF]$/.test(c)));
});
test('missing cache data stays unknown; invalid counts never become claimed cache hits',()=>{
  assert.equal(normalizedUsage({usage:{input_tokens:10,output_tokens:2}}).prompt_tokens_details,undefined);
  assert.equal(normalizedUsage({usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:11}}).prompt_tokens_details,undefined);
  assert.equal(normalizedUsage({usage:{input_tokens:-1,output_tokens:2}}),null);
  const sum=sumUsage([normalizedUsage({usage:{input_tokens:10,output_tokens:2}}),null]);assert.equal(sum.bridge_usage_complete,false);
  const summary=summarize([{outcome:'failed',usage:sum},{outcome:'completed',usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0,bridge_usage_source:'local-response-replay'}}]);
  assert.equal(summary.tokens.prompt,10);assert.equal(summary.localReplays,1);assert.equal(summary.tokens.cacheRead,null);assert.equal(summary.credits,null);
});
test('validated large tool arguments are fragmented below SSE event limits and preserve Unicode exactly',async t=>{
  const text='中文 😀 '.repeat(400000);const transport=await fixture(t,async function*(){yield* events(JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:{text}}]}));});
  const result=await collect(transport,{...body,tools});assert.equal(JSON.parse(result.result.choices[0].message.tool_calls[0].function.arguments).text,text);
});
test('a complete tool decision with one leading angle reaches the host after one inference',async t=>{
  let calls=0;const text='private fixture 中文 😀'.repeat(1000);
  const transport=await fixture(t,async function*(){calls++;yield* events('<'+JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:{text}}]}));});
  const result=await collect(transport,{...body,tools});assert.equal(calls,1);assert.equal(JSON.parse(result.result.choices[0].message.tool_calls[0].function.arguments).text,text);
  assert.equal(result.result.usage.bridge_decision_format,'json');assert.equal(transport.metrics.localDecisionRepairs,1);assert.equal(result.metrics.attempts.length,1);
});
test('a paid schema correction retains the deadline/model and carries the precise validation error',async t=>{
  const other={type:'function',function:{name:'other',description:'unrelated-schema '.repeat(500),parameters:{type:'object'}}};let calls=0;
  const transport=await fixture(t,async function*(input){
    calls++;if(calls===2){assert.equal(input.options.resume,'fixture-session');assert.equal(input.options.model,model);assert.match(input.prompt,/missingProperty/);assert.match(input.prompt,/"text"/);assert.ok(!input.prompt.includes('unrelated-schema'));}
    yield* events(JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:calls===1?{}:{text:'fixed'}}]}));
  });
  const result=await collect(transport,{...body,tools:[...tools,other]});assert.equal(calls,2);assert.equal(result.result.usage.prompt_tokens,10000);
  assert.equal(result.metrics.attempts[0].rejection.validationKeywords[0],'required');assert.deepEqual(result.metrics.attempts[0].correction.tools,['write']);
  const evidence=JSON.parse(await readFile(result.metrics.attempts[0].rejection.evidenceFile,'utf8'));assert.equal(evidence.errorCode,'invalid_tool_arguments');assert.equal(evidence.attempt,1);
});
test('raw-newline final reply completes after streaming its prefix, without a paid retry',async t=>{
  const expected='完成。\n\n所有更改保留。';let calls=0;
  const transport=await fixture(t,async function*(){
    calls++;yield {type:'system',subtype:'init',model,session_id:'fixture-session'};
    const raw='{"action":"final","content":"'+expected+'"}';
    for(const char of raw)yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:char}}};
    yield* [...events(raw)].slice(1);
  });
  const result=await collect(transport);assert.equal(result.result.choices[0].message.content,expected);assert.equal(calls,1);
  assert.equal(result.metrics.localDecisionRepairs[0].kind,'json_string_controls');assert.equal(result.metrics.attempts.length,1);
});
test('official usage remains inspectable while a correction is pending and the signal aborts',async t=>{
  let calls=0;const controller=new AbortController();let second;const entered=new Promise(r=>{second=r;});
  const transport=await fixture(t,async function*(input){
    if(++calls===1){yield* events('bad JSON');return;}
    yield {type:'system',subtype:'init',model,session_id:'fixture-session'};second();
    await new Promise(r=>input.options.abortController.signal.addEventListener('abort',r,{once:true}));
  });
  const response=await transport.chat(body,controller.signal);const draining=response.text();await entered;
  assert.equal(response.bridgeMetrics.knownUsage.prompt_tokens,5000);assert.equal(response.bridgeMetrics.knownUsage.bridge_usage_complete,false);
  controller.abort(new DOMException('deadline','TimeoutError'));await draining;
  assert.equal(response.bridgeMetrics.knownUsage.prompt_tokens,5000);assert.equal(response.bridgeMetrics.knownUsage.bridge_usage_complete,false);
});
test('deterministic DSML boundary variants are validated and delivered without a model correction',async t=>{
  let calls=0;const source='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="write"><｜｜DSML｜｜ parameter name="text" string="true">完整内容\n中文 😀</｜｜DSML｜｜></｜｜DSML｜｜><｜｜DSML｜｜ calls>';
  const transport=await fixture(t,async function*(){calls++;yield* events(source);});
  const result=await collect(transport,{...body,tools});assert.equal(calls,1);assert.equal(result.result.usage.bridge_decision_format,'dsml');
  assert.equal(JSON.parse(result.result.choices[0].message.tool_calls[0].function.arguments).text,'完整内容\n中文 😀');assert.equal(result.metrics.attempts.length,1);
  assert.equal(transport.metrics.decodedDsml,1);assert.ok(transport.metrics.localDecisionRepairs>0);
});
