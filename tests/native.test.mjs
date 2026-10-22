import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {SdkTransport} from '../src/sdk-transport.mjs';
import {Completion,sseEvents} from '../src/protocol.mjs';
import {FORWARDED,hostServer,nativeSupported} from '../src/native.mjs';
const model='deepseek-v4.1-flash';
const credential={uid:'fixture',domain:'www.workbuddy.cn',accessToken:'fake-token',refreshToken:'fake-refresh'};
const tools=[
  {type:'function',function:{name:'read',description:'Read a file',parameters:{type:'object',properties:{file_path:{type:'string'},limit:{type:'integer'}},required:['file_path'],additionalProperties:false}}},
  {type:'function',function:{name:'write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}}},
];
const body={model,prompt_cache_key:'native-a',messages:[{role:'system',content:'host rules'},{role:'user',content:'task'}],tools,max_tokens:2048,reasoning_effort:'low'};
const usage={input_tokens:5000,output_tokens:20,cache_read_input_tokens:4000,cache_creation_input_tokens:0};
const zero={input_tokens:0,output_tokens:0};
const promptText=async prompt=>typeof prompt==='string'?prompt:(await prompt[Symbol.asyncIterator]().next()).value?.message?.content;
/** The message sequence the official runtime produced in real native probes. */
async function* turn({text='',calls=[],id='native-session',servers=[{name:'host',status:'connected'}],stop='end_turn',streamed=false}){
  yield {type:'system',subtype:'init',model,session_id:id,mcp_servers:servers,tools:servers.length?tools.map(t=>'mcp__host__'+t.function.name):[]};
  if(streamed){
    // Recorded parallel shape: every call reuses block index 2 and only the first reaches an assistant message.
    yield {type:'stream_event',event:{type:'message_start',message:{model,usage:zero}}};
    yield {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}};
    yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'plan'}}};
    for(const c of calls){
      yield {type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'tool_use',id:c.id,name:'mcp__host__'+c.name,input:{}}}};
      const json=JSON.stringify(c.input);yield {type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:''}}};
      for(let at=0;at<json.length;at+=3)yield {type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:json.slice(at,at+3)}}};
    }
    yield {type:'stream_event',event:{type:'content_block_stop',index:2}};
    yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{input_tokens:3933,output_tokens:96,cache_read_input_tokens:2944,cache_creation_input_tokens:989}}};
    yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:3933,output_tokens:96,cache_read_input_tokens:2944,cache_creation_input_tokens:0}}};
    yield {type:'stream_event',event:{type:'message_stop'}};
    yield {type:'assistant',message:{model,content:[{type:'thinking',thinking:'plan'}],usage:zero}};
    yield {type:'assistant',message:{model,content:[{type:'tool_use',id:calls[0].id,name:'mcp__host__'+calls[0].name,input:calls[0].input}],stop_reason:'tool_use',usage:zero}};
    yield {type:'system',subtype:'init',model,session_id:id,mcp_servers:servers};
    yield {type:'assistant',message:{content:[{type:'text',text:'Max turns (1) exceeded'}],usage:zero}};
    throw Object.assign(new Error('Max turns (1) exceeded'),{subtype:'error_during_execution'});
  }
  for(let at=0;at<text.length;at+=7)yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:text.slice(at,at+7)}}};
  if(stop==='max_tokens')yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'max_tokens'}}};
  if(text)yield {type:'assistant',uuid:'text',message:{model,content:[{type:'text',text}],usage:zero}};
  if(!calls.length){yield {type:'result',subtype:'success',is_error:false,result:text,session_id:id,usage};return;}
  yield {type:'assistant',uuid:'calls',message:{model,content:calls.map(c=>({type:'tool_use',id:c.id,name:c.name.startsWith('mcp__')||c.name==='Read'?c.name:'mcp__host__'+c.name,input:c.input})),stop_reason:stop==='max_tokens'?'max_tokens':'tool_use',usage}};
  yield {type:'system',subtype:'init',model,session_id:id,mcp_servers:servers};
  yield {type:'assistant',uuid:'stop',message:{content:[{type:'text',text:'Max turns (1) exceeded'}],usage:zero}};
  throw Object.assign(new Error('Max turns (1) exceeded'),{subtype:'error_during_execution'});
}
async function fixture(t,steps,cfg={}){
  const runtime=await mkdtemp(join(tmpdir(),'wb-native-'));const seen=[];
  const run=async function*(input){const index=seen.length;seen.push({options:input.options,prompt:await promptText(input.prompt)});yield* turn(typeof steps==='function'?steps(index,seen[index]):steps[index]);};
  const transport=new SdkTransport({runtime,cliPath:process.execPath,toolMode:'native',...cfg},{get:async()=>credential},{run});
  t.after(async()=>{await transport.close();await rm(runtime,{recursive:true,force:true});});return {transport,seen};
}
async function collect(transport,request=body){
  const response=await transport.chat(request,new AbortController().signal);const completion=new Completion(model);let raw='';const contents=[];
  for await(const frame of sseEvents(response.body)){raw+=frame+'\n';if(frame.startsWith('{')&&JSON.parse(frame).error)return {raw,contents,metrics:response.bridgeMetrics};
    const chunk=completion.accept(frame,model);for(const c of chunk?.choices??[])if(c.delta?.content)contents.push(c.delta.content);}
  completion.validate(request.tools);return {result:completion.result(),raw,contents,metrics:response.bridgeMetrics};
}
test('the host server declares the exact host schemas natively and never executes a call',async()=>{
  assert.equal(nativeSupported(tools),true);assert.equal(nativeSupported([{type:'function',function:{name:'x'.repeat(54),parameters:{type:'object'}}}]),false);
  assert.equal(nativeSupported([{type:'function',function:{name:'arr',parameters:{type:'array'}}}]),false);
  const server=hostServer(tools).instance,[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
  const client=new Client({name:'test',version:'1.0.0'});await client.connect(b);
  const listed=(await client.listTools()).tools;assert.deepEqual(listed.map(t=>t.name),['read','write']);assert.deepEqual(listed[0].inputSchema,tools[0].function.parameters);
  const called=await client.callTool({name:'write',arguments:{file_path:'x',content:'y'}});assert.equal(called.isError,true);assert.equal(called.content[0].text,FORWARDED);
  await client.close();
});
test('native host calls keep runtime IDs, validate schemas and deliver the held preamble once',async t=>{
  const {transport,seen}=await fixture(t,[{text:'我先读取两个文件。',calls:[{id:'call_00_A',name:'read',input:{file_path:'a.ts'}},{id:'call_00_B',name:'read',input:{file_path:'b.ts',limit:20}}]}]);
  const {result,contents,metrics}=await collect(transport);const message=result.choices[0].message;
  assert.deepEqual(message.tool_calls.map(c=>[c.id,c.function.name,JSON.parse(c.function.arguments)]),[['call_00_A','read',{file_path:'a.ts'}],['call_00_B','read',{file_path:'b.ts',limit:20}]]);
  assert.equal(message.content,'我先读取两个文件。');assert.deepEqual(contents,['我先读取两个文件。']);assert.equal(result.choices[0].finish_reason,'tool_calls');
  assert.equal(seen.length,1);assert.equal(metrics.toolMode,'native');assert.equal(transport.metrics.hostCalls,2);assert.equal(result.usage.bridge_decision_format,'native');
  const options=seen[0].options;assert.equal(options.mcpServers.host.type,'sdk');assert.match(options.systemPrompt.append,/mcp__host__/);
  assert.equal((await options.hooks.PreToolUse[0].hooks[0]({})).hookSpecificOutput.permissionDecisionReason,FORWARDED);
  assert.ok(!seen[0].prompt.includes('"tools"'));assert.ok(!seen[0].prompt.includes('host-decision-v1'));
});
test('parallel host calls are assembled from the stream when only the first reaches a message',async t=>{
  const {transport}=await fixture(t,[{streamed:true,calls:[{id:'call_00_P',name:'read',input:{file_path:'a.txt'}},{id:'call_01_Q',name:'write',input:{file_path:'b.txt',content:'中文 "q"'}}]}]);
  const {result,metrics}=await collect(transport);const calls=result.choices[0].message.tool_calls;
  assert.deepEqual(calls.map(c=>[c.id,c.function.name,JSON.parse(c.function.arguments)]),[['call_00_P','read',{file_path:'a.txt'}],['call_01_Q','write',{file_path:'b.txt',content:'中文 "q"'}]]);
  assert.equal(result.usage.prompt_tokens,3933);assert.equal(result.usage.completion_tokens,96);assert.equal(result.usage.cache_creation_input_tokens,989);assert.equal(metrics.attempts.length,1);
});
test('a streamed call whose arguments never complete is corrected, not forwarded',async t=>{
  let index=0;const {transport,seen}=await fixture(t,()=>index++===0?{streamed:true,calls:[{id:'call_00_R',name:'read',input:{file_path:'a.txt'}}]}:{calls:[{id:'call_00_S',name:'read',input:{file_path:'a.txt'}}]});
  // Drop the closing brace of the streamed arguments; the assistant message never carries this call.
  const original=transport.run;transport.run=async function*(input){for await(const m of original(input)){
    if(m.event?.delta?.partial_json?.endsWith('}'))continue;if(m.type==='assistant'&&m.message.content.some(b=>b.id==='call_00_R'))continue;yield m;}};
  const {result,metrics}=await collect(transport);
  assert.equal(seen.length,2);assert.equal(metrics.attempts[0].errorCode,'invalid_tool_arguments');assert.equal(result.choices[0].message.tool_calls[0].id,'call_00_S');
});
test('native continuation sends only the host results under the runtime IDs',async t=>{
  const {transport,seen}=await fixture(t,[{calls:[{id:'call_00_A',name:'read',input:{file_path:'a.ts'}}]},{text:'a.ts 共 3 行，已检查完毕。'}]);
  const first=await collect(transport);const call=first.result.choices[0].message;
  const second=await collect(transport,{...body,messages:[...body.messages,call,{role:'tool',tool_call_id:'call_00_A',content:'HOST_RESULT'}]});
  assert.equal(second.result.choices[0].message.content,'a.ts 共 3 行，已检查完毕。');assert.equal(seen[1].options.resume,'native-session');
  assert.match(seen[1].prompt,/"history":"new-messages-only"/);assert.match(seen[1].prompt,/"tool_call_id":"call_00_A"/);assert.match(seen[1].prompt,/HOST_RESULT/);
  assert.ok(!seen[1].prompt.includes('prior_decision_calls'));assert.ok(!seen[1].prompt.includes('host rules'));assert.equal(second.metrics.historyMode,'delta');
});
test('plain final text streams progressively without a JSON envelope',async t=>{
  const text='已完成：修改了 3 个文件。\n\n- `a.ts`：修复换行\n- `b.ts`：补测试\n\n全部测试通过。';
  const {transport}=await fixture(t,[{text}]);const {result,contents}=await collect(transport);
  assert.equal(result.choices[0].message.content,text);assert.ok(contents.length>2);assert.equal(contents.join(''),text);assert.equal(result.choices[0].finish_reason,'stop');
});
test('an announcement that calls nothing is never shown and is corrected once',async t=>{
  const {transport,seen}=await fixture(t,[{text:"I'll read the config file first."},{calls:[{id:'call_00_C',name:'read',input:{file_path:'config.ts'}}]}]);
  const {result,raw,metrics}=await collect(transport);
  assert.equal(seen.length,2);assert.match(seen[1].prompt,/announcing your next action/);assert.equal(seen[1].options.resume,'native-session');
  assert.equal(result.choices[0].message.tool_calls[0].id,'call_00_C');assert.ok(!raw.includes("I'll read the config"));assert.equal(result.choices[0].message.content,null);
  assert.equal(metrics.attempts[0].errorCode,'unfinished_turn');
});
test('a repeated announcement is delivered as the answer instead of failing the task',async t=>{
  const {transport,seen}=await fixture(t,[{text:'我先检查一下。'},{text:'我先检查一下配置。'}]);
  const {result}=await collect(transport);assert.equal(seen.length,2);assert.equal(result.choices[0].message.content,'我先检查一下配置。');
});
test('printed DSML becomes validated host calls, is never streamed, and is acknowledged next turn',async t=>{
  const dsml='<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="file_path" string="true">a.ts</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  const {transport,seen}=await fixture(t,[{text:'先读取 a.ts。\n'+dsml},{text:'读取完毕，内容正常。'}]);
  const first=await collect(transport);const message=first.result.choices[0].message;
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).file_path,'a.ts');assert.ok(!first.raw.includes('｜｜DSML'));assert.equal(message.content.trim(),'先读取 a.ts。');
  assert.equal(first.result.usage.bridge_decision_format,'native-text');
  await collect(transport,{...body,messages:[...body.messages,message,{role:'tool',tool_call_id:message.tool_calls[0].id,content:'R'}]});
  // The model never saw these bridge IDs natively, so the next turn repeats the assistant call with them.
  assert.match(seen[1].prompt,/"role":"assistant"/);assert.equal(seen[1].prompt.split(message.tool_calls[0].id).length-1,2);
});
test('undecodable printed markup is corrected and only the prose before it is shown',async t=>{
  const {transport,seen}=await fixture(t,[{text:'Here is the plan for this change.\n<｜｜DSML｜｜ invoke name="read">'},{text:'Done: nothing else to change.'}]);
  const {result,raw}=await collect(transport);
  assert.equal(seen.length,2);assert.ok(!raw.includes('｜｜DSML'));assert.match(seen[1].prompt,/protocol markup as text/);
  assert.equal(result.choices[0].message.content,'Here is the plan for this change.\n\n\nDone: nothing else to change.');
});
test('fenced and inline markup examples remain part of an answer',async t=>{
  const text='格式示例如下：\n```xml\n<｜｜DSML｜｜ invoke name="read">\n```\n行内写法 `<invoke name="x">` 也只是示例。';
  const {transport,seen}=await fixture(t,[{text}]);const {result}=await collect(transport);
  assert.equal(seen.length,1);assert.equal(result.choices[0].message.content,text);
});
test('printed host arguments are held back and corrected into a native call',async t=>{
  const {transport,seen}=await fixture(t,[{text:'{"file_path":"a.ts","content":"x"}'},{calls:[{id:'call_00_W',name:'write',input:{file_path:'a.ts',content:'x'}}]}]);
  const {result,contents}=await collect(transport);
  assert.equal(seen.length,2);assert.deepEqual(contents,[]);assert.equal(result.choices[0].message.tool_calls[0].function.name,'write');
});

test('pretty-printed host arguments never stream and are corrected into a native call',async t=>{
  const text='{\n  "file_path": "a.ts",\n  "content": "fixture"\n}';
  const {transport,seen}=await fixture(t,[{text},{calls:[{id:'call_pretty',name:'write',input:{file_path:'a.ts',content:'fixture'}}]}]);
  const {result,contents,metrics}=await collect(transport);
  assert.equal(seen.length,2);assert.deepEqual(contents,[]);assert.equal(result.choices[0].message.tool_calls[0].id,'call_pretty');
  assert.equal(metrics.attempts[0].errorCode,'invalid_decision');
});

test('unfenced documentation cannot become an executable legacy call',async t=>{
  for(const document of [JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:{file_path:'example.txt',content:'fixture'}}]}),
    '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="write">\n<｜｜DSML｜｜ parameter name="file_path" string="true">example.txt</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="content" string="true">fixture</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>']){
    const {transport,seen}=await fixture(t,[{text:'下面是调用示例，请勿执行：\n'+document},{text:'该示例仅用于说明格式。'}]);
    const {result,raw,metrics}=await collect(transport);
    assert.equal(seen.length,2);assert.equal(result.choices[0].finish_reason,'stop');assert.equal(result.choices[0].message.tool_calls,undefined);
    assert.equal(metrics.attempts[0].errorCode,'invalid_decision');assert.ok(!raw.includes('example.txt'));assert.equal(transport.metrics.hostCalls,0);
  }
});

test('legacy execution preambles still decode as whole documents',async t=>{
  const text='先读取 a.ts。\n'+JSON.stringify({action:'tool_calls',calls:[{name:'read',arguments:{file_path:'a.ts'}}]});
  const {transport,seen}=await fixture(t,[{text}]);const {result}=await collect(transport);
  assert.equal(seen.length,1);assert.equal(result.choices[0].message.content.trim(),'先读取 a.ts。');
  assert.equal(result.choices[0].message.tool_calls[0].function.name,'read');
});

test('explicit JSON response formats preserve business fields and protocol examples exactly',async t=>{
  const documents=[JSON.stringify({action:'final',content:'business-json'}),
    JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:{file_path:'example.txt',content:'fixture'}}]}),
    '{\n  "file_path": "example.txt",\n  "content": "<｜｜DSML｜｜ calls>"\n}'];
  for(const type of ['json_object','json_schema'])for(const text of documents){
    const {transport,seen}=await fixture(t,[{text}]);
    const {result,contents}=await collect(transport,{...body,response_format:{type,...(type==='json_schema'?{json_schema:{name:'answer',schema:{type:'object'}}}:{})}});
    assert.equal(seen.length,1);assert.equal(result.choices[0].message.content,text);assert.equal(contents.join(''),text);assert.ok(contents.length>1);
    assert.equal(result.choices[0].finish_reason,'stop');assert.equal(result.choices[0].message.tool_calls,undefined);
    assert.deepEqual(JSON.parse(result.choices[0].message.content),JSON.parse(text));assert.match(seen[0].prompt,/JSON document requested by response_format/);
  }
});

test('response_format text keeps the native call guard enabled',async t=>{
  const {transport,seen}=await fixture(t,[{text:'{\n"file_path":"a.ts"\n}'},{calls:[{id:'call_text',name:'read',input:{file_path:'a.ts'}}]}]);
  const {result,contents}=await collect(transport,{...body,response_format:{type:'text'}});
  assert.equal(seen.length,2);assert.deepEqual(contents,[]);assert.equal(result.choices[0].message.tool_calls[0].id,'call_text');
});

test('native call prefixes require a successful terminal result or the exact expected runtime stop',async t=>{
  const failures=[
    {error:new Error('Transport closed before terminal response'),code:'upstream_failure'},
    {error:new Error('HTTP 400 code 11128 unapproved channel'),code:'workbuddy_11128'},
    {code:'sdk_incomplete'},
    {messageStop:true,code:'sdk_incomplete'},
    {result:{type:'result',subtype:'error_during_execution',is_error:true,errors:['unapproved channel 11128']},code:'workbuddy_11128'},
    {result:{type:'result',subtype:'error_during_execution',is_error:true,errors:['Transport closed']},code:'sdk_incomplete'},
    {error:Object.assign(new Error('Max turns (1) exceeded'),{errors:['Max turns (1) exceeded','Transport closed']}),code:'upstream_failure'},
    {error:new Error('Max turns (2) exceeded'),code:'upstream_failure'},
  ];
  for(const failure of failures){
    const {transport}=await fixture(t,[]);
    transport.run=async function*(){
      yield {type:'system',subtype:'init',model,session_id:'incomplete-session',mcp_servers:[{name:'host',status:'connected'}]};
      yield {type:'stream_event',event:{type:'message_start',message:{model,usage}}};
      yield {type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'tool_use',id:'first_of_batch',name:'mcp__host__read',input:{}}}};
      yield {type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"file_path":"a.ts"}'}}};
      yield {type:'stream_event',event:{type:'content_block_stop',index:2}};
      if(failure.messageStop)yield {type:'stream_event',event:{type:'message_stop'}};
      if(failure.result)yield failure.result;
      if(failure.error)throw failure.error;
    };
    const {raw,metrics}=await collect(transport);
    assert.match(raw,new RegExp('"code":"'+failure.code+'"'));assert.ok(!raw.includes('[DONE]'));assert.ok(!raw.includes('"tool_calls":['));
    assert.equal(transport.metrics.started,1);assert.equal(transport.metrics.hostCalls,0);assert.equal(transport.warm.stats.started,0);
    assert.equal(metrics.knownUsage.prompt_tokens,5000);assert.equal(metrics.knownUsage.prompt_tokens_details.cached_tokens,4000);
  }
});

test('a successful native terminal result confirms the complete call batch',async t=>{
  const {transport}=await fixture(t,[{calls:[{id:'call_success',name:'read',input:{file_path:'a.ts'}}]}]);
  const original=transport.run;
  transport.run=async function*(input){
    try{yield* original(input);}catch(error){
      assert.match(error.message,/^Max turns/);yield {type:'result',subtype:'success',is_error:false,usage};
    }
  };
  const {result}=await collect(transport);assert.equal(result.choices[0].message.tool_calls[0].id,'call_success');
});
test('schema-invalid native arguments get a native correction with the validation detail',async t=>{
  const {transport,seen}=await fixture(t,[{calls:[{id:'call_00_X',name:'write',input:{file_path:'a.ts'}}]},{calls:[{id:'call_00_Y',name:'write',input:{file_path:'a.ts',content:'ok'}}]}]);
  const {result,metrics}=await collect(transport);
  assert.equal(seen.length,2);assert.match(seen[1].prompt,/missingProperty/);assert.match(seen[1].prompt,/content/);assert.equal(result.choices[0].message.tool_calls[0].id,'call_00_Y');
  assert.equal(metrics.attempts[0].errorCode,'invalid_tool_arguments');assert.deepEqual(metrics.attempts[0].correction.tools,['write']);
});
test('a host call cut by the output budget is never forwarded',async t=>{
  const {transport}=await fixture(t,[{calls:[{id:'call_00_T',name:'write',input:{file_path:'a.ts',content:'partial'}}],stop:'max_tokens'}]);
  const {raw}=await collect(transport);assert.match(raw,/output_budget/);assert.ok(!raw.includes('"tool_calls":['));
});
test('built-in tools, foreign servers and a disconnected host server fail closed',async t=>{
  for(const [step,code] of [[{calls:[{id:'r',name:'Read',input:{file_path:'x'}}]},'native_tool_blocked'],[{text:'x',servers:[{name:'host',status:'connected'},{name:'other',status:'connected'}]},'isolation_failed'],[{text:'x',servers:[{name:'host',status:'failed'}]},'native_tools_unavailable']]){
    const {transport}=await fixture(t,[step]);const {raw}=await collect(transport);assert.match(raw,new RegExp(code));assert.ok(!raw.includes('[DONE]'));
  }
});
test('tool_choice none declares no host functions and answers in text',async t=>{
  const {transport,seen}=await fixture(t,[{text:'Plain answer.',servers:[]}]);
  const {result}=await collect(transport,{...body,tool_choice:'none'});
  assert.deepEqual(seen[0].options.mcpServers,{});assert.equal(result.choices[0].message.content,'Plain answer.');
});
