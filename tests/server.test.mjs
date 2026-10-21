import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge} from '../src/server.mjs';
import {Queue} from '../src/queue.mjs';
import {PUBLIC_MODEL} from '../src/protocol.mjs';
const info={id:'deepseek-v4.1-flash',name:'DeepSeek Flash',supportsToolCall:true,contextWindow:1000000,maxTokens:128000,reasoning:{supportedEfforts:['low','high','max']}};
const frame=(delta,finish_reason=null,usage=null)=>`data: ${JSON.stringify({id:'test',created:1,model:info.id,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}],usage})}\n\n`;
async function fixture(t,chat){const records=[];const cfg={concurrency:1,queueLimit:3,timeoutMs:2000,heartbeatMs:50,bodyLimit:100000};const provider={model:info,ready:async()=>info,chat,status:()=>({})};const b=createBridge({cfg,provider,key:'test-key',instanceId:'unit',log:async row=>records.push(row)});await new Promise(r=>b.server.listen(0,'127.0.0.1',r));t.after(()=>b.close());const root=`http://127.0.0.1:${b.server.address().port}`;const request=async(body,extra={})=>fetch(root+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json',...extra.headers},body:JSON.stringify({model:PUBLIC_MODEL,messages:[{role:'user',content:'test'}],...body}),signal:extra.signal});return {b,root,request,records};}
test('real HTTP nonstream aggregation, usage and local authentication',async t=>{const f=await fixture(t,async()=>new Response(frame({role:'assistant',content:'你好'})+frame({},'stop',{prompt_tokens:10,completion_tokens:2,total_tokens:12})+'data: [DONE]\n\n'));assert.equal((await fetch(f.root+'/health')).status,401);assert.equal((await f.request({}, {headers:{origin:'https://evil.example'}})).status,403);const r=await f.request({});assert.equal(r.status,200);const body=await r.json();assert.equal(body.model,PUBLIC_MODEL);assert.equal(body.choices[0].message.content,'你好');assert.equal(body.usage.total_tokens,12);});
test('a truncated stream does not leak a terminal tool execution frame or DONE',async t=>{const f=await fixture(t,async()=>new Response(frame({tool_calls:[{index:0,id:'call_1',function:{name:'read',arguments:'{"path":"x"}'}}]})+frame({},'tool_calls')));const r=await f.request({stream:true,tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}]});const text=await r.text();assert.match(text,/truncated_stream/);assert.ok(!text.includes('"finish_reason":"tool_calls"'));assert.ok(!text.includes('[DONE]'));});
test('request timeout aborts upstream and releases concurrency slot',async t=>{let aborted=false;const f=await fixture(t,async(body,signal)=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame({role:'assistant'})));signal.addEventListener('abort',()=>{aborted=true;c.close();},{once:true});}})));const r=await f.request({stream:true});const text=await r.text();assert.match(text,/timeout/);assert.equal(aborted,true);assert.equal(f.b.queue.active,0);});
test('cancelling a queued request leaves the active request untouched',async()=>{const q=new Queue(1,2),a=new AbortController(),b=new AbortController();const release=await q.acquire(a.signal);const waiting=q.acquire(b.signal);b.abort(new DOMException('cancel','AbortError'));await assert.rejects(waiting);assert.equal(q.active,1);assert.equal(q.waiters.length,0);assert.equal(a.signal.aborted,false);release();assert.equal(q.active,0);});
test('unsupported media, invalid schemas and invalid choices fail before inference',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;throw new Error('must not infer');});
  for(const invalid of [{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}]},
    {tools:[{type:'function',function:{name:'bad',parameters:{type:'not-a-type'}}}]},{tool_choice:'required'},{tool_choice:{type:'function',function:{name:'unknown'}}},
    {prompt_cache_key:5},{parallel_tool_calls:'no'}])assert.equal((await f.request(invalid)).status,400);
  assert.equal(calls,0);
});
test('authenticated metrics exclude role-only frames from first model event time',async t=>{
  const f=await fixture(t,async()=>new Response(frame({role:'assistant'})+frame({content:'ok'})+frame({},'stop',{prompt_tokens:10,completion_tokens:2,total_tokens:12})+'data: [DONE]\n\n'));
  await (await f.request({})).json();assert.equal((await fetch(f.root+'/metrics')).status,401);
  const metrics=await (await fetch(f.root+'/metrics',{headers:{authorization:'Bearer test-key'}})).json();
  assert.equal(metrics.requests,1);assert.equal(metrics.tokens.total,12);assert.equal(metrics.tokens.cacheRead,null);
  assert.equal(f.records[0].firstEventMs,f.records[0].firstTextMs);
});
test('deadline failure retains known correction usage exactly once without a success frame',async t=>{
  const usage={prompt_tokens:123284,completion_tokens:43667,total_tokens:166951,bridge_usage_complete:false};
  const f=await fixture(t,async(body,signal)=>{
    const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame({role:'assistant'})));signal.addEventListener('abort',()=>c.close(),{once:true});}}));
    response.bridgeMetrics={knownUsage:usage,attempts:[{usage:{prompt_tokens:61477,completion_tokens:15033}},{usage:{prompt_tokens:61807,completion_tokens:28634}}]};return response;
  });
  const text=await(await f.request({stream:true})).text();assert.match(text,/timeout/);assert.ok(!text.includes('[DONE]'));
  const events=text.split('\n\n').filter(s=>s.startsWith('data: {')).map(s=>JSON.parse(s.slice(6)));
  assert.equal(events.filter(e=>e.usage).length,1);assert.deepEqual(events.find(e=>e.usage).usage,usage);assert.deepEqual(f.records[0].usage,usage);
});
test('upstream error usage already delivered is not duplicated by the server error handler',async t=>{
  const usage={prompt_tokens:42,completion_tokens:7,total_tokens:49};
  const f=await fixture(t,async()=>new Response(frame({},null,usage)+'data: {"error":{"code":"invalid_decision","message":"bad"}}\n\n'));
  const raw=await(await f.request({stream:true})).text();assert.equal((raw.match(/"prompt_tokens":42/g)??[]).length,1);assert.match(raw,/invalid_decision/);
});
