import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SdkTransport} from '../src/sdk-transport.mjs';
const model='deepseek-v4.1-flash';const credential={accessToken:'fake-access',refreshToken:'fake-refresh',uid:'fake',domain:'www.workbuddy.cn'};
async function fixture(t,run){const runtime=await mkdtemp(join(tmpdir(),'wb-sdk-'));t.after(()=>rm(runtime,{recursive:true,force:true}));return new SdkTransport({runtime,cliPath:process.execPath},{get:async()=>credential},{run});}
const body={model,messages:[{role:'system',content:'You are an AI agent powered by DeepSeek Harness.'},{role:'user',content:'test'}],max_tokens:100,reasoning_effort:'low'};
test('SDK keeps host system in input data, uses exact model, retains official system and denies local tools',async t=>{let options,prompt;const transport=await fixture(t,async function*(p){({options,prompt}=p);yield {type:'system',subtype:'init',model,mcp_servers:[]};yield {type:'assistant',message:{model,content:[{type:'text',text:'{"action":"final","content":"ok"}'}]}};yield {type:'result',subtype:'success',is_error:false,result:'{"action":"final","content":"ok"}',usage:{input_tokens:50,output_tokens:2},modelUsage:{[model]:{}}};});const r=await transport.chat(body,new AbortController().signal);const text=await r.text();assert.match(text,/'__never__'|"content":"ok"/);assert.match(prompt,/DeepSeek Harness/);assert.equal(typeof options.systemPrompt,'object');assert.deepEqual(options.tools,[]);assert.deepEqual(options.settingSources,[]);assert.equal(options.fallbackModel,undefined);const stop=await options.hooks.PreToolUse[0].hooks[0]({});assert.equal(stop.continue,false);assert.equal((await options.canUseTool('Read',{})).behavior,'deny');});
test('11128 thrown by official SDK is reported once, without switching model or blindly retrying',async t=>{let calls=0;const transport=await fixture(t,async function*(){calls++;throw new Error('HTTP 400 code 11128 Illegal API invocation from an unapproved channel');});const text=await (await transport.chat(body,new AbortController().signal)).text();assert.match(text,/workbuddy_11128/);assert.ok(!text.includes('[DONE]'));assert.equal(calls,1);assert.equal(transport.metrics.lastFailure.code,'workbuddy_11128');});
test('native tool output, plugin contamination and model fallback fail closed',async t=>{for(const bad of [{type:'system',subtype:'init',model:'glm-5.3'},{type:'system',subtype:'init',model,plugins:[{name:'unexpected'}]},{type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',name:'Read'}}}]){const transport=await fixture(t,async function*(){yield bad;});const text=await (await transport.chat(body,new AbortController().signal)).text();assert.match(text,/model_mismatch|isolation_failed|native_tool_blocked/);assert.ok(!text.includes('[DONE]'));}});
const readTools=[{type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}}];
const dsmlCall=path=>`<｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="file_path" string="true">${path}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`;
test('real failure shape crosses the SDK transport as two calls after one inference, without local execution',async t=>{
  const dsml="I'll start by reading the reference files.\n\n"+'<｜｜DSML｜｜ calls>'+dsmlCall('fixture/first.ts')+dsmlCall('fixture/second.ts')+'</｜｜DSML｜｜ calls>';let requests=0;
  const transport=await fixture(t,async function*(){requests++;yield {type:'system',subtype:'init',model};yield {type:'assistant',message:{model,content:[{type:'text',text:dsml}]}};yield {type:'result',subtype:'success',is_error:false,result:dsml,usage:{input_tokens:7892,output_tokens:134}};});
  const wire=await (await transport.chat({...body,tools:readTools},new AbortController().signal)).text();
  const chunks=wire.split('\n\n').filter(s=>s.startsWith('data: {')).map(s=>JSON.parse(s.slice(6)));
  const calls=chunks.flatMap(c=>c.choices??[]).flatMap(c=>c.delta?.tool_calls??[]);
  assert.equal(calls.length,2);assert.equal(new Set(calls.map(c=>c.id)).size,2);assert.equal(JSON.parse(calls[1].function.arguments).file_path,'fixture/second.ts');
  assert.equal(requests,1);assert.equal(transport.metrics.decodedDsml,1);assert.equal(transport.metrics.deniedTools,0);assert.match(wire,/\[DONE\]/);
  assert.ok(chunks.some(c=>c.choices?.[0]?.delta?.content==="I'll start by reading the reference files."));
});
test('invalid second DSML call dispatches nothing; reported usage and private redacted evidence survive failure',async t=>{
  const dsml="I'll start by reading the reference files.\n\n"+'<｜｜DSML｜｜ calls>'+dsmlCall('fixture/first.ts')+'<｜｜DSML｜｜ invoke name="read"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const transport=await fixture(t,async function*(){yield {type:'system',subtype:'init',model};yield {type:'assistant',message:{model,content:[{type:'text',text:dsml}]}};yield {type:'result',subtype:'success',is_error:false,result:dsml,usage:{input_tokens:7892,output_tokens:134}};});
  const wire=await (await transport.chat({...body,tools:readTools},new AbortController().signal,{requestId:'local-regression'})).text();
  assert.match(wire,/invalid_tool_arguments/);assert.match(wire,/"prompt_tokens":7892/);assert.ok(!wire.includes('"tool_calls":['));assert.ok(!wire.includes('[DONE]'));
  assert.ok(!wire.includes("I'll start by reading"));
  const file=transport.metrics.lastFailure.evidenceFile;const evidence=JSON.parse(await readFile(file,'utf8'));assert.equal(evidence.requestId,'local-regression');assert.equal(evidence.result,dsml);assert.ok(!JSON.stringify(evidence).includes(credential.accessToken));
});
