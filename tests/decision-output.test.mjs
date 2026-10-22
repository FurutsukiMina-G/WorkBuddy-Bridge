import test from 'node:test';
import assert from 'node:assert/strict';
import {DecisionOutput} from '../src/decision-output.mjs';
import {compileTools} from '../src/decision.mjs';
const body={tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}}]};
const validators=compileTools(body.tools);
const json=JSON.stringify({action:'tool_calls',calls:[{name:'read',arguments:{file_path:'fixture.ts'}}]});
const observe=(output,content,id)=>output.observe({type:'assistant',uuid:id,message:{content,usage:{input_tokens:10,output_tokens:2}}});
test('SDK prose or [object Object] aggregate does not overwrite a complete assistant decision',()=>{
  const o=new DecisionOutput();observe(o,[{type:'text',text:json}],'text');observe(o,[{type:'thinking',thinking:'later thought-only message'}],'thought');o.observe({type:'result',subtype:'success',result:'[object Object]'});
  assert.equal(o.decision(body,validators).decision.calls[0].name,'read');
});
test('SDK result and complete streamed DSML agree and preserve both calls',()=>{
  const dsml='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="file_path" string="true">fixture.ts</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const o=new DecisionOutput();observe(o,[{type:'text',text:dsml}],'text');o.observe({type:'result',subtype:'success',result:dsml,usage:{input_tokens:50,output_tokens:20}});
  assert.equal(o.decision(body,validators).format,'dsml');assert.equal(o.usage().input_tokens,10);
});
test('conflicting complete output channels are rejected rather than picking a host action',()=>{
  const o=new DecisionOutput();observe(o,[{type:'text',text:json}]);o.observe({type:'result',result:JSON.stringify({action:'final',content:'done'})});
  assert.throws(()=>o.decision(body,validators),e=>e.code==='ambiguous_decision');
});
test('a complete SDK aggregate cannot hide a malformed later assistant call',()=>{
  const o=new DecisionOutput();observe(o,[{type:'text',text:json}],'first');observe(o,[{type:'text',text:'<｜｜DSML｜｜ invoke name="read">'}],'later');o.observe({type:'result',subtype:'success',result:json});
  assert.throws(()=>o.decision(body,validators),e=>e.code==='invalid_decision');
});
test('text fragments are joined while duplicate SDK UUID snapshots are deduplicated',()=>{
  const o=new DecisionOutput(),cut=45;observe(o,[{type:'text',text:json.slice(0,cut)}],'a');observe(o,[{type:'text',text:json.slice(cut)}],'b');observe(o,[{type:'text',text:json.slice(cut)}],'b');o.observe({type:'result',subtype:'success',result:''});
  assert.equal(o.decision(body,validators).decision.calls[0].arguments.file_path,'fixture.ts');
});
test('open stream blocks and output-budget stops cannot become executable decisions',()=>{
  const o=new DecisionOutput();o.observe({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:json}}});
  assert.throws(()=>o.decision(body,validators),e=>e.code==='invalid_decision');
  observe(o,[{type:'text',text:json}]);o.observe({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'max_tokens'}}});
  assert.throws(()=>o.decision(body,validators),e=>e.code==='output_budget');
});
test('failure summary carries hashes and sizes without exposing generated content',()=>{
  const o=new DecisionOutput();observe(o,[{type:'text',text:'private generated example'}]);const summary=JSON.stringify(o.summary());
  assert.ok(!summary.includes('private generated example'));assert.match(summary,/sha256/);assert.match(JSON.stringify(o.evidence()),/private generated example/);
});
test('resumed Result usage is cumulative; assistant and stream usage belong to this response',()=>{
  const o=new DecisionOutput();o.observe({type:'assistant',message:{id:'new',content:[{type:'text',text:'{"action":"final","content":"OK"}'}],usage:{input_tokens:3978,output_tokens:15,cache_read_input_tokens:3840,cache_creation_input_tokens:138}}});
  o.observe({type:'result',usage:{input_tokens:7835,output_tokens:25,cache_read_input_tokens:6784,cache_creation_input_tokens:1051}});
  assert.equal(o.usage().input_tokens,3978);assert.equal(o.usage().output_tokens,15);assert.equal(o.usage().cache_read_input_tokens,3840);
  const fallback=new DecisionOutput();fallback.observe({type:'result',usage:{input_tokens:7835,output_tokens:25,cache_read_input_tokens:6784,cache_creation_input_tokens:1051}});
  assert.equal(fallback.usage(null,{resumed:true}),undefined);
  assert.deepEqual(fallback.usage({input_tokens:3857,output_tokens:10,cache_read_input_tokens:2944,cache_creation_input_tokens:913},{resumed:true}),{input_tokens:3978,output_tokens:15,cache_read_input_tokens:3840,cache_creation_input_tokens:138});
  fallback.observe({type:'stream_event',event:{type:'message_delta',usage:{input_tokens:3978,output_tokens:15,cache_read_input_tokens:3840,cache_creation_input_tokens:0}}});
  assert.equal(fallback.usage({input_tokens:3857,output_tokens:10,cache_read_input_tokens:2944,cache_creation_input_tokens:913},{resumed:true}).cache_creation_input_tokens,138);
  assert.equal(fallback.evidence().usage.cache_creation_input_tokens,138);
  // A second message_delta with cache_creation=0 or a zero-token synthetic message_start must not clobber positive stream cache creation.
  const nativeStream=new DecisionOutput();
  nativeStream.observe({type:'stream_event',event:{type:'message_delta',usage:{input_tokens:3933,output_tokens:96,cache_read_input_tokens:2944,cache_creation_input_tokens:989}}});
  nativeStream.observe({type:'stream_event',event:{type:'message_delta',usage:{input_tokens:3933,output_tokens:96,cache_read_input_tokens:2944,cache_creation_input_tokens:0}}});
  nativeStream.observe({type:'stream_event',event:{type:'message_start',message:{usage:{input_tokens:0,output_tokens:0}}}});
  assert.equal(nativeStream.usage().cache_creation_input_tokens,989);
});
