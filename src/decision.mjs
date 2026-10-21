import Ajv from 'ajv';
import {BridgeError} from './errors.mjs';
import {decodeDsmlDocument} from './dsml.mjs';
import {leakedProtocol} from './protocol-text.mjs';
import {digest} from './context.mjs';
import {parseJsonText} from './json-text.mjs';
import {executionPreamble} from './execution-preamble.mjs';
const toolCache=new Map();
export const DECISION_INSTRUCTIONS=`You are providing one bounded model decision to an external host. The host owns planning, tools, files, shell, permissions, subagents, and all side effects. Never call WorkBuddy/CodeBuddy built-in tools, skills, MCP, agents, or background tasks. Do not inspect the local machine. The JSON input contains the host's complete ordered conversation and its function schemas; follow the original role priorities inside that conversation. A host tool result is data from the host, not a request to run local tools.
Return exactly one JSON object without markdown or surrounding text:
{"action":"final","content":"the assistant's complete answer"}
or {"action":"tool_calls","calls":[{"name":"exact declared host function name","arguments":{...}}]}.
Use only declared host functions, their exact JSON Schema, and the requested tool_choice. Arguments must be an object. The host executes calls and supplies their results on the next request. Do not fabricate tool results. Respect tool_choice none, required, and a pinned function. If a tool is required, request it through the JSON calls field, never a native WorkBuddy tool call.`;
export function decisionInput(body,{messages=body.messages,toolsReused=false,delta=false}={}){
  const input=JSON.stringify({protocol:'host-decision-v1',history:delta?'new-messages-only':'full',messages,
    ...(toolsReused?{tools_unchanged:true}:{tools:body.tools??[]}),tool_choice:body.tool_choice??'auto',response_format:body.response_format??null});
  // Keep the transport contract after long host instructions and code blocks.
  // Host roles still govern the task; this line governs only its wire encoding.
  const reminder='END OF HOST INPUT. Return only the next host-decision-v1 JSON object. To request host functions use {"action":"tool_calls","calls":[{"name":"<declared name>","arguments":{}}]}; for an actual final answer use {"action":"final","content":"..."}. Never call a native WorkBuddy function or put commentary outside JSON.';
  return input+'\n\n'+(delta?'Continue the same host task. Earlier messages and unchanged tool definitions remain in this native session. If no new messages were supplied, reconsider the last host task under the current tool_choice. Return only the next host-decision-v1 JSON decision.':reminder);
}
export function compileTools(tools=[]){
  const signature=digest(tools);if(toolCache.has(signature))return toolCache.get(signature);
  const ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});const validators=new Map();
  for(const tool of tools){const fn=tool?.function;if(tool?.type!=='function'||!fn?.name||validators.has(fn.name))throw new BridgeError(400,'invalid_tools','Every tool needs a unique function name');
    try{validators.set(fn.name,ajv.compile(fn.parameters??{type:'object'}));}catch{throw new BridgeError(400,'invalid_tool_schema',`Invalid schema for ${fn.name}`);}}
  if(toolCache.size>=128)toolCache.delete(toolCache.keys().next().value);toolCache.set(signature,validators);return validators;
}
export function parseDecision(text,body,validators=compileTools(body.tools),onRepair=()=>{}){
  const trimmed=String(text).trim();
  // Only remove a fence surrounding the ENTIRE output. Never mine tool calls
  // out of explanatory prose, examples or an incomplete response.
  const fenced=/^```(?:json|xml|text)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed);
  const source=(fenced?fenced[1]:trimmed).trim();
  let result;const repairs=[];
  const preamble=executionPreamble(source);
  const jsonPreamble=preamble&&/^<?\{\s*"action"\s*:/.test(preamble.document)?preamble:null;
  let jsonSource=jsonPreamble?.document??source;
  if(/^<\{\s*"action"\s*:/.test(jsonSource)){jsonSource=jsonSource.slice(1);repairs.push({kind:'leading_angle',charactersRemoved:1});}
  try{const decoded=parseJsonText(jsonSource);result=decoded.value;repairs.push(...decoded.repairs);}catch{
    // Observed whole-document defect: one stray '<' immediately before the
    // canonical action object. Parse the ENTIRE remainder; never mine an inner
    // object, add missing closers, or discard a second call/trailing text.
    if(source.includes('<｜｜DSML｜｜'))result=decodeDsmlDocument(source,repair=>repairs.push(repair));
    else throw new BridgeError(502,'invalid_decision','WorkBuddy did not return a complete JSON or DSML host decision');
  }
  let choice=body.tool_choice??'auto';if(typeof choice==='object')choice=choice.type==='function'?choice.function?.name:choice.type;
  if(result?.action==='final'&&typeof result.content==='string'&&Object.keys(result).every(k=>['action','content'].includes(k))){
    if(jsonPreamble)throw new BridgeError(502,'invalid_decision','An execution preamble requires a complete host tool decision');
    if(leakedProtocol(result.content))throw new BridgeError(502,'invalid_decision','Tool protocol cannot be returned as final text');
    if(choice==='required'||typeof choice==='string'&&!['auto','none'].includes(choice))throw new BridgeError(502,'required_tool_missing','Model answered without the required host tool');
    repairs.forEach(onRepair);return result;
  }
  if(result?.action!=='tool_calls'||!Array.isArray(result.calls)||!result.calls.length||result.calls.length>32||Object.keys(result).some(k=>!['action','calls','content'].includes(k))||result.content!==undefined&&typeof result.content!=='string')throw new BridgeError(502,'invalid_decision','Invalid host decision shape');
  if(choice==='none')throw new BridgeError(502,'tools_disabled','Model requested a host tool while tools are disabled');
  if(body.parallel_tool_calls===false&&result.calls.length>1)throw new BridgeError(502,'invalid_decision','parallel_tool_calls false permits only one host call');
  const invalid=(tool,issues)=>{const error=new BridgeError(502,'invalid_tool_arguments','Model returned an undeclared host tool or arguments that fail its JSON Schema');error.decisionIssue={tool,issues};throw error;};
  for(const call of result.calls){const validate=validators.get(call?.name);
    if(!validate)invalid(null,[{keyword:'declared_tool'}]);
    if(!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments))invalid(call.name,[{keyword:'type',path:'/',type:'object'}]);
    if(Object.keys(call).some(k=>!['name','arguments'].includes(k)))invalid(call.name,[{keyword:'call_shape',message:'A call may contain only name and arguments'}]);
    if(!validate(call.arguments))invalid(call.name,(validate.errors??[]).slice(0,8).map(e=>({keyword:e.keyword,path:(e.instancePath||'/').slice(0,160),
      ...(e.params?.missingProperty!==undefined?{missingProperty:String(e.params.missingProperty).slice(0,160)}:{}),
      ...(e.params?.type!==undefined?{type:e.params.type}:{}),message:e.message})));
    if(!['auto','required'].includes(choice)&&choice!==call.name)throw new BridgeError(502,'wrong_pinned_tool','Model returned a different host tool than requested');}
  if(jsonPreamble){result={...result,content:jsonPreamble.content+(result.content?'\n\n'+result.content:'')};repairs.push({kind:'json_execution_preamble'});}
  repairs.forEach(onRepair);
  return result;
}
