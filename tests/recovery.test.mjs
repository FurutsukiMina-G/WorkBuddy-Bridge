import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDecision,compileTools} from '../src/decision.mjs';
import {DecisionOutput} from '../src/decision-output.mjs';
import {correctionInput} from '../src/recovery.mjs';
import {summarize} from '../src/metrics.mjs';
const write={type:'function',function:{name:'write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}}};
const pwsh={type:'function',function:{name:'pwsh',parameters:{type:'object',properties:{command:{type:'string'},description:{type:'string'}},required:['command','description'],additionalProperties:false}}};
const body={tools:[write,pwsh],tool_choice:'auto'};
const call=content=>({action:'tool_calls',calls:[{name:'write',arguments:{file_path:'fixture.ts',content}}]});
test('observed single leading angle is decoded losslessly only as a complete action document',()=>{
  const content='// 中文 😀\nconst x = "<tag>";\n'.repeat(400),decision=call(content),repairs=[];
  assert.deepEqual(parseDecision('<'+JSON.stringify(decision),body,undefined,r=>repairs.push(r)),decision);
  assert.deepEqual(repairs,[{kind:'leading_angle',charactersRemoved:1}]);
  assert.deepEqual(parseDecision('<{"action":"final","content":"ok"}',body),{action:'final',content:'ok'});
});
test('leading marker compatibility cannot mine prose, drop trailing calls or guess incomplete data',()=>{
  const valid=JSON.stringify(call('unchanged'));
  for(const raw of ['Example: <'+valid,'<<'+valid,'<'+valid+'>','<'+valid+valid,'<'+valid.slice(0,-1),'<'+valid+'\ntrailing','< {"action":"final","content":"ok"}'])
    assert.throws(()=>parseDecision(raw,body),e=>e.code==='invalid_decision');
  for(const [request,code]of [[{...body,tool_choice:'none'},'tools_disabled'],[{...body,tool_choice:{type:'function',function:{name:'pwsh'}}},'wrong_pinned_tool']])
    assert.throws(()=>parseDecision('<'+valid,request),e=>e.code===code);
  assert.throws(()=>parseDecision('<'+JSON.stringify({action:'tool_calls',calls:[{name:'write',arguments:{file_path:'x'}}]}),body),e=>e.code==='invalid_tool_arguments');
});
test('output channels retain ambiguity checks and report locally repaired JSON accurately',()=>{
  const value=call('fixture'),wire=JSON.stringify(value),out=new DecisionOutput();
  out.observe({type:'assistant',message:{content:[{type:'text',text:wire}]}});out.observe({type:'result',result:'<'+wire});
  const result=out.decision(body,compileTools(body.tools));assert.equal(result.format,'json');assert.equal(result.repairs[0].kind,'leading_angle');assert.deepEqual(result.decision,value);
  out.observe({type:'result',result:'<'+JSON.stringify(call('changed'))});assert.throws(()=>out.decision(body),e=>e.code==='ambiguous_decision');
  out.observe({type:'result',result:'<'+JSON.stringify({action:'tool_calls',calls:[{name:'unknown',arguments:{}}]})});assert.throws(()=>out.decision(body),e=>e.code==='invalid_tool_arguments');
});
test('schema correction names the missing field and repeats only its complete affected schema',()=>{
  const request={...body,tools:[write,{...pwsh,function:{...pwsh.function,description:'Affected full tool description'}},{type:'function',function:{name:'unrelated',description:'DO_NOT_REPEAT_ME '.repeat(1000),parameters:{type:'object'}}}]};
  let rejection;try{parseDecision(JSON.stringify({action:'tool_calls',calls:[{name:'pwsh',arguments:{command:'echo fixture'}}]}),request);}catch(error){rejection=error;}
  assert.equal(rejection.code,'invalid_tool_arguments');assert.equal(rejection.decisionIssue.issues[0].missingProperty,'description');
  const correction=correctionInput(request,rejection);assert.deepEqual(correction.toolNames,['pwsh']);
  assert.match(correction.prompt,/missingProperty/);assert.match(correction.prompt,/Affected full tool description/);assert.ok(!correction.prompt.includes('DO_NOT_REPEAT_ME'));
  assert.ok(!correction.prompt.includes('"name":"write"'));assert.ok(correction.schemaCharacters>0);
});
test('syntax correction reuses schemas; unknown tools get declared names without invented parameters',()=>{
  const request={...body,tools:[{...write,function:{...write.function,description:'UNCHANGED_SCHEMA_MARKER'}}]};
  const syntax=correctionInput(request,{code:'invalid_decision'});assert.equal(syntax.schemaCharacters,0);assert.ok(!syntax.prompt.includes('UNCHANGED_SCHEMA_MARKER'));
  let rejection;try{parseDecision(JSON.stringify({action:'tool_calls',calls:[{name:'unknown',arguments:{}}]}),request);}catch(error){rejection=error;}
  const correction=correctionInput(request,rejection);assert.match(correction.prompt,/declared_tool_names/);assert.match(correction.prompt,/write/);assert.equal(correction.schemaCharacters,0);
});
test('correction usage is distinct from first attempts and local envelope repairs',()=>{
  const result=summarize([{outcome:'completed',context:{localDecisionRepairs:[{kind:'leading_angle'}],attempts:[{usage:{prompt_tokens:100,completion_tokens:5}}]}},
    {outcome:'completed',context:{attempts:[{usage:{prompt_tokens:200,completion_tokens:7}},{usage:{prompt_tokens:300,completion_tokens:9}}]}}]);
  assert.equal(result.correctionCalls,1);assert.deepEqual(result.correctionTokens,{prompt:300,completion:9,reportedAttempts:1,unknownAttempts:0,requestsWithoutAttemptDetails:0});assert.equal(result.localDecisionRepairs,1);assert.equal(result.localReplays,0);
  assert.equal(summarize([{outcome:'failed'}]).correctionTokens.requestsWithoutAttemptDetails,1);
});
test('historical timed-out attempts contribute only their known subtotal and never overwrite the original log',()=>{
  const a={prompt_tokens:61477,completion_tokens:15033,total_tokens:76510},b={prompt_tokens:61807,completion_tokens:28634,total_tokens:90441};
  const row={outcome:'failed',errorCode:'timeout',usage:null,context:{attempts:[{usage:a},{usage:b},{usage:null}]}};
  const result=summarize([row]);assert.equal(result.tokens.prompt,123284);assert.equal(result.tokens.completion,43667);
  assert.equal(result.tokens.incompleteRequests,1);assert.equal(result.tokens.recoveredUsageRequests,1);assert.equal(row.usage,null);
  const already={...row,usage:{prompt_tokens:123284,completion_tokens:43667,total_tokens:166951,bridge_usage_complete:false}};
  assert.equal(summarize([already]).tokens.prompt,123284);assert.equal(summarize([already]).tokens.recoveredUsageRequests,0);
});
