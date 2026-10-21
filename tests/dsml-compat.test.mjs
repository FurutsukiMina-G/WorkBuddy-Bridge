import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDecision,compileTools} from '../src/decision.mjs';
import {DecisionOutput} from '../src/decision-output.mjs';
const tools=[
  {type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['file_path'],additionalProperties:false}}},
  {type:'function',function:{name:'write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}}},
];
const body={tools};const m='｜｜DSML｜｜';
const p=(name,value,string='true')=>`<${m} parameter name="${name}" string="${string}">${value}</${m} parameter>`;
const invoke=(name,args)=>`<${m} invoke name="${name}">${args}</${m} invoke>`;
const root=inside=>`<${m} calls>${inside}</${m} calls>`;
test('generic closes retain a complete typed batch and record DSML repair metadata',()=>{
  const source=root(invoke('read',p('file_path','first.ts')+p('offset','30','false')).replaceAll(`</${m} parameter>`,`</${m}>`).replace(`</${m} invoke>`,`<${m}>`)+invoke('read',p('file_path','second.ts')));
  const repairs=[];const result=parseDecision(source,body,undefined,r=>repairs.push(r));
  assert.deepEqual(result.calls,[{name:'read',arguments:{file_path:'first.ts',offset:30}},{name:'read',arguments:{file_path:'second.ts'}}]);assert.ok(repairs.some(r=>r.kind==='dsml_generic_close'));
  const output=new DecisionOutput();output.observe({type:'result',result:source});assert.equal(output.decision(body).format,'dsml');
});
test('explicit typed next parameters with a slash retain all values without type inference',()=>{
  const source=root(`<${m} invoke name="read"><${m} parameter name="file_path" string="true">src/fixture.ts</${m} parameter name="offset" string="false">30</${m} parameter name="limit" string="false">80</${m} parameter></${m} invoke>`);
  assert.deepEqual(parseDecision(source,body).calls[0].arguments,{file_path:'src/fixture.ts',offset:30,limit:80});
  assert.throws(()=>parseDecision(source.replace('name="limit" string="false"','name="limit"'),body));
  assert.throws(()=>parseDecision(source.replace('name="limit" string="false">80','name="offset" string="false">80'),body));
});
test('decorated matching close, redundant empty close and terminal slash typo preserve long code',()=>{
  const content='\n// 中文 😀\r\nconst v = "<span title=\\"x\\">";\n'.repeat(300);
  const source=`<${m} calls><${m} invoke name="write"><${m} parameter name="file_path" string="true">fixture.ts</${m} parameter name="file_path" string="true">`+
    p('content',content)+`</${m} parameter></${m} invoke><${m} calls>`;
  const result=parseDecision(source,body);assert.equal(result.calls[0].arguments.content,content);assert.equal(result.calls[0].arguments.file_path,'fixture.ts');
});
test('matching closing type conflicts and unsupported boundary headers remain errors',()=>{
  const bad=root(`<${m} invoke name="read"><${m} parameter name="file_path" string="true">fixture.ts</${m} parameter name="file_path" string="false"></${m} invoke>`);
  assert.throws(()=>parseDecision(bad,body));
  assert.throws(()=>parseDecision(root(invoke('read',p('file_path','x'))).replace(`</${m} parameter>`,`</${m} param>`),body));
});
test('whole-batch validation still enforces every tool/schema/choice after boundary normalization',()=>{
  const good=invoke('read',p('file_path','x')).replace(`</${m} invoke>`,`</${m}>`);
  assert.throws(()=>parseDecision(root(good+invoke('unknown',p('file_path','y'))),body),e=>e.code==='invalid_tool_arguments');
  assert.throws(()=>parseDecision(root(good+invoke('read',p('offset','"30"','false'))),body),e=>e.code==='invalid_tool_arguments');
  assert.throws(()=>parseDecision(root(good),{...body,tool_choice:'none'}),e=>e.code==='tools_disabled');
  assert.throws(()=>parseDecision(root(good),{...body,tool_choice:{type:'function',function:{name:'write'}}}),e=>e.code==='wrong_pinned_tool');
  assert.throws(()=>parseDecision(root(good+good),{...body,parallel_tool_calls:false}),e=>e.code==='invalid_decision');
});
test('normalization cannot drop truncated calls, nested protocol, duplicate values or terminal garbage',()=>{
  const good=invoke('read',p('file_path','x')).replace(`</${m} invoke>`,`</${m}>`);
  for(const source of [root(good+`<${m} invoke name="read">`),root(good).slice(0,-1),root(good)+'tail',root(good)+root(good),
    root(good+invoke('read',p('file_path','a')+p('file_path','a'))),
    root(good+invoke('write',p('file_path','x')+p('content',root(invoke('read',p('file_path','secret'))))))])assert.throws(()=>parseDecision(source,body));
  assert.throws(()=>parseDecision(root(good).replace(`</${m} calls>`,`</${m} tool_calls>`),body));
  assert.throws(()=>parseDecision(root(invoke('read',p('file_path','x')).replace(`</${m} invoke>`,'')),body));
});
test('an execution preamble is retained before a complete JSON tool document',()=>{
  const decision={action:'tool_calls',calls:[{name:'read',arguments:{file_path:'fixture.ts'}}]},text=JSON.stringify(decision);
  for(const prefix of ['我先阅读类型定义和相关文件。',"I'll start by reading the reference files.",'I will read example.ts and protocol.ts.']){
    const repairs=[];const result=parseDecision(prefix+'\n\n'+text,body,undefined,r=>repairs.push(r));
    assert.deepEqual(result.calls,decision.calls);assert.equal(result.content,prefix);assert.equal(repairs[0].kind,'json_execution_preamble');
    const output=new DecisionOutput();output.observe({type:'result',result:prefix+'\n\n'+text});assert.equal(output.decision(body).format,'json');
  }
  assert.equal(parseDecision('正在检查剩余的 schema 部分。\n\n'+root(invoke('read',p('file_path','x'))),body).calls[0].name,'read');
});
test('preamble compatibility never extracts documentation examples or hides a bad second call',()=>{
  const text=JSON.stringify({action:'tool_calls',calls:[{name:'read',arguments:{file_path:'fixture.ts'}}]});
  for(const prefix of ['An example follows:',"I'll read this example:",'我先给出一个示例。','Some arbitrary explanation.','我先读取。\n```json'])assert.throws(()=>parseDecision(prefix+'\n\n'+text,body));
  assert.throws(()=>parseDecision('我先读取。\n\n'+text+'\ntrailing',body));
  assert.throws(()=>parseDecision('我先读取。\n\n{"action":"final","content":"done"}',body));
  const output=new DecisionOutput();output.observe({type:'result',result:text});
  output.observe({type:'assistant',message:{content:[{type:'text',text:'我先读取。\n\n'+JSON.stringify({action:'tool_calls',calls:[{name:'read',arguments:{file_path:'fixture.ts'}},{name:'unknown',arguments:{}}]})}]}});
  assert.throws(()=>output.decision(body,compileTools(tools)),e=>e.code==='invalid_tool_arguments');
});
