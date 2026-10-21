import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDecision} from '../src/decision.mjs';
const tools=[
  {type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'},limit:{type:'number'}},required:['file_path'],additionalProperties:false}}},
  {type:'function',function:{name:'write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}}},
  {type:'function',function:{name:'typed',parameters:{type:'object',properties:{enabled:{type:'boolean'},items:{type:'array',items:{type:'number'}},extra:{type:['object','null']}},required:['enabled','items','extra'],additionalProperties:false}}},
];
const body={tools,tool_choice:'auto'};
const parameter=(name,value,string='true')=>`<｜｜DSML｜｜ parameter name="${name}" string="${string}">${value}</｜｜DSML｜｜ parameter>`;
const invoke=(name,args)=>`<｜｜DSML｜｜ invoke name="${name}">${args}</｜｜DSML｜｜ invoke>`;
const envelope=calls=>`<｜｜DSML｜｜ calls>\n${calls}\n</｜｜DSML｜｜ calls>`;
const read=path=>invoke('read',parameter('file_path',path));
test('recorded failure shape: two complete DSML read calls decode as one validated batch',()=>{
  const decision=parseDecision(envelope(read('X:/fixture/src/first.ts')+'\n'+read('X:/fixture/src/second.ts')),body);
  assert.deepEqual(decision,{action:'tool_calls',calls:[{name:'read',arguments:{file_path:'X:/fixture/src/first.ts'}},{name:'read',arguments:{file_path:'X:/fixture/src/second.ts'}}]});
});
test('DSML preserves long Chinese TypeScript, quotes, newlines and markup byte for byte',()=>{
  const content=Array.from({length:80},(_,i)=>`// 第 ${i} 行：虚构数据\nconst value${i} = '<span title="示例">&lt;内容</span>';\n`).join('');
  const source=envelope(invoke('write',parameter('file_path','src/fixture.ts')+parameter('content',content)));
  assert.equal(parseDecision(source,body).calls[0].arguments.content,content);
});
test('typed DSML parameters use JSON values and remain schema validated',()=>{
  const source=envelope(invoke('typed',parameter('enabled','false','false')+parameter('items','[1,2,3]','false')+parameter('extra','null','false')));
  assert.deepEqual(parseDecision(source,body).calls[0].arguments,{enabled:false,items:[1,2,3],extra:null});
  assert.throws(()=>parseDecision(envelope(invoke('read',parameter('file_path','x')+parameter('limit','"10"','false'))),body),e=>e.code==='invalid_tool_arguments');
});
test('DSML cannot bypass declared names, pinned choice or disabled tools',()=>{
  assert.throws(()=>parseDecision(envelope(invoke('unknown',parameter('file_path','x'))),body),e=>e.code==='invalid_tool_arguments');
  assert.throws(()=>parseDecision(envelope(read('x')),{...body,tool_choice:'none'}),e=>e.code==='tools_disabled');
  assert.throws(()=>parseDecision(envelope(read('x')),{...body,tool_choice:{type:'function',function:{name:'write'}}}),e=>e.code==='wrong_pinned_tool');
});
test('a valid first DSML call never hides an invalid or truncated second call',()=>{
  const first=read('first.ts');
  for(const second of [invoke('read',''),invoke('read',parameter('file_path','second.ts')).replace('</｜｜DSML｜｜ invoke>',''),'<｜｜DSML｜｜ invoke name="read">'])assert.throws(()=>parseDecision(envelope(first+second),body));
});
test('duplicate parameters and ambiguous or mismatched envelope boundaries are rejected',()=>{
  const duplicate=envelope(invoke('read',parameter('file_path','x')+parameter('file_path','y')));
  const examples=[duplicate,envelope(read('x')).replace('</｜｜DSML｜｜ calls>','</｜｜DSML｜｜ tool_calls>'),envelope(read('x')).replace(' string="true"',''),envelope(read('x'))+'garbage',envelope(read('x'))+envelope(read('y'))];
  for(const source of examples)assert.throws(()=>parseDecision(source,body),e=>e.code==='invalid_decision');
});
test('empty batches, too many calls and nested DSML markers fail closed',()=>{
  for(const source of [envelope(''),envelope(Array.from({length:33},()=>read('x')).join('')),envelope(invoke('write',parameter('file_path','x')+parameter('content',envelope(''))))])assert.throws(()=>parseDecision(source,body));
});
test('whole output fences are supported; arbitrary prose is never mined for calls',()=>{
  const source=envelope(read('x'));
  assert.equal(parseDecision('```xml\n'+source+'\n```',body).calls[0].name,'read');
  assert.throws(()=>parseDecision('An example follows:\n'+source,body));
});
test('recorded progress sentence is preserved before a complete, validated DSML batch',()=>{
  const content="I'll start by reading the reference files.";
  const decision=parseDecision(content+'\n\n'+envelope(read('first.ts')+read('second.ts')),body);
  assert.equal(decision.content,content);assert.equal(decision.calls.length,2);
  assert.throws(()=>parseDecision(content+'\n\n'+envelope(read('first.ts')+invoke('read','')),body),e=>e.code==='invalid_tool_arguments');
  assert.throws(()=>parseDecision(content+'\n\n```xml\n'+envelope(read('x'))+'\n```',body));
});
test('DSML examples inside a JSON final answer remain plain text',()=>{
  const content='Documentation example: '+envelope(read('x'));
  assert.deepEqual(parseDecision(JSON.stringify({action:'final',content}),body),{action:'final',content});
});
