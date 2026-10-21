import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDecision} from '../src/decision.mjs';
import {escapeStringControls} from '../src/json-text.mjs';
import {FinalTextProjector} from '../src/streaming.mjs';
const body={tools:[{type:'function',function:{name:'write',parameters:{type:'object',properties:{content:{type:'string'}},required:['content'],additionalProperties:false}}}]};
test('physical newlines, tabs and all JSON-string controls are decoded without changing content',()=>{
  const text='完成。\n\n**文件**\r\n中文 😀\t"quoted"\\literal\\n\0\b\f';
  const raw=JSON.stringify({action:'final',content:text}).replace('\\n\\n','\n\n').replace('\\r\\n','\r\n').replace('\\t','\t');
  const repairs=[];
  assert.deepEqual(parseDecision(raw,body,undefined,r=>repairs.push(r)),{action:'final',content:text});
  assert.equal(repairs[0].kind,'json_string_controls');assert.ok(repairs[0].charactersEscaped>0);
  const all=Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('');
  assert.equal(parseDecision('{"action":"final","content":"'+all+'"}',body).content,all);
});
test('control encoding preserves complete tool values and cannot repair invalid escapes or incomplete batches',()=>{
  const content='line 1\nline 2\t中文',raw='{"action":"tool_calls","calls":[{"name":"write","arguments":{"content":"'+content+'"}}]}';
  assert.equal(parseDecision(raw,body).calls[0].arguments.content,content);
  for(const invalid of [raw.slice(0,-1),raw+raw,'{"action":"final","content":"bad\\\ncontinuation"}','{"action":"final","content":"bad\\q"}'])
    assert.throws(()=>parseDecision(invalid,body));
  assert.throws(()=>parseDecision(raw,{...body,tool_choice:'none'}),e=>e.code==='tools_disabled');
  assert.throws(()=>parseDecision('{"action":"tool_calls","calls":[{"name":"write","arguments":{"wrong":"raw\ntext"}}]}',body),e=>e.code==='invalid_tool_arguments');
});
test('streamed final answer continues across literal newlines and agrees with the complete terminal decision',()=>{
  const expected='完成。\n\n第二行\t中文 😀',raw='{"action":"final","content":"'+expected+'"}';let text='';
  const p=new FinalTextProjector(delta=>{text+=delta;});for(const char of raw)p.push(char);
  assert.equal(text,expected);p.finish(parseDecision(raw,body));assert.equal(text,expected);
});
