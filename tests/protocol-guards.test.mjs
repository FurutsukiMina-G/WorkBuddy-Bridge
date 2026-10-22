import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolAt} from '../src/protocol-text.mjs';
import {NativeTextGate,unfinishedTurn} from '../src/native.mjs';
const params=new Set(['file_path','content','command']);
test('printed envelopes are found outside code, never inside fences or inline code',()=>{
  assert.equal(protocolAt('说明\n<｜｜DSML｜｜ calls>'),3);assert.equal(protocolAt('call now:<｜｜DSML｜｜ invoke name="x">'),9);
  assert.equal(protocolAt('a\n  <invoke name="read">'),4);assert.equal(protocolAt('{"action":"tool_calls","calls":[]}'),0);
  assert.equal(protocolAt('ok\n{"file_path":"a.ts"}',params),3);assert.equal(protocolAt('ok\n{"theme":"dark"}',params),-1);
  for(const safe of ['```xml\n<｜｜DSML｜｜ invoke name="x">\n```','用 `<｜｜DSML｜｜ invoke>` 表示调用。','The <invoke> element appears mid-sentence.','~~~\n{"action":"final"}\n~~~','Use {"action": ...} only in the old protocol.'])
    assert.equal(protocolAt(safe,params),-1,safe);
});
test('split markers and argument objects are never streamed before they can be ruled out',()=>{
  for(const parts of [['正文。\n<','｜｜DS','ML｜｜ invoke name="read">'],['text ','</｜','｜DSML｜｜ parameter>'],['done\n{"file','_path":"a.ts"}']]){
    let shown='';const gate=new NativeTextGate(t=>{shown+=t;},{params});
    for(const part of parts)gate.push(part);
    assert.ok(!shown.includes('｜｜')&&!shown.includes('file_path'),JSON.stringify(parts));assert.equal(gate.blocked,true);
  }
  let shown='';const gate=new NativeTextGate(t=>{shown+=t;},{params});for(const part of ['<b>粗体</b> 与 ','<parag','raph> 是普通 HTML。'])gate.push(part);gate.pump(true);
  assert.equal(shown,'<b>粗体</b> 与 <paragraph> 是普通 HTML。');
});

test('multiline JSON heads stay private across every possible stream split',()=>{
  for(const text of ['{\n  "file_path": "a.ts",\n  "content": "fixture"\n}',
    '{\r\n  "action"\r\n  :\r\n  "tool_calls", "calls": []}',
    '{\n  "calls"\n  :\n  []}', '{\n  "file\\u005fpath": "a.ts"}']){
    assert.equal(protocolAt(text,params),0,text);
    for(let split=1;split<text.length;split++){
      let shown='';const gate=new NativeTextGate(delta=>{shown+=delta;},{params});
      gate.push(text.slice(0,split));gate.push(text.slice(split));
      assert.equal(shown,'',`${text} at ${split}`);assert.equal(gate.blocked,true);
    }
    let shown='';const gate=new NativeTextGate(delta=>{shown+=delta;},{params});
    for(const char of text)gate.push(char);assert.equal(shown,'');assert.equal(gate.blocked,true);
  }
  for(const text of ['{\n  "theme": "dark"\n}', '```json\n{\n "file_path": "example"\n}\n```',
    '例子：`{"action":"final","content":"example"}`']){
    assert.equal(protocolAt(text,params),-1,text);
    let shown='';const gate=new NativeTextGate(delta=>{shown+=delta;},{params});
    for(const char of text)gate.push(char);gate.pump(true);assert.equal(shown,text);
  }
});
test('short announcements wait for the turn; long answers and finished reports stream',()=>{
  let shown='';const gate=new NativeTextGate(t=>{shown+=t;});gate.push('我先读取配置文件');assert.equal(shown,'');
  gate.push('，然后'+'逐项说明每个字段的含义与默认值。'.repeat(20));assert.ok(shown.length>200);
  shown='';const plain=new NativeTextGate(t=>{shown+=t;});plain.push('已完成：');assert.equal(shown,'已完成：');
  shown='';const json=new NativeTextGate(t=>{shown+=t;},{announce:false});json.push('我先说结论：');assert.equal(shown,'我先说结论：');
  for(const tokens of [['I',"'ll read the config file."],['我','先读取配置文件。'],['Let',' me check the tests.']]){
    let streamed='';const g=new NativeTextGate(t=>{streamed+=t;});
    for(const tok of tokens)g.push(tok);
    assert.equal(streamed,'',JSON.stringify(tokens));
  }
});
test('only short replies that announce an action without delivering it count as unfinished',()=>{
  for(const text of ["I'll read the config file first.",'Let me check the tests.','我先读取 config.ts。','接下来我会运行测试。','好的，让我看看日志。','Now I will update the parser.'])assert.equal(unfinishedTurn(text),true,text);
  for(const text of ['已完成修改，测试全部通过。','Let me know if you need anything else.','需要我继续修改吗？','I will need your API key to continue?','我先说结论：已修改 3 个文件。','Done.',"I'll summarize: all 3 files were updated.",'我先读取。\n```ts\nconst x=1\n```','我来总结一下改动。',
    'I will explain the plan in detail: '+'first we read the configuration and then we update every parser rule accordingly. '.repeat(4)])assert.equal(unfinishedTurn(text),false,text);
});
