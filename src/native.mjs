import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {BridgeError} from './errors.mjs';
import {parseDecision} from './decision.mjs';
import {protocolAt,pendingAt} from './protocol-text.mjs';
export const HOST='host',PREFIX=`mcp__${HOST}__`;
// The runtime records this as the denied call's tool_result, so the next turn reads naturally.
export const FORWARDED='Forwarded to the external host for execution. The host returns its result in the next user message under this call id; do not repeat the call before then.';
export const NATIVE_INSTRUCTIONS=`You are providing model turns to an external host (DeepSeek Harness). The host owns planning context, tools, files, shell, permissions, subagents and all side effects. The host's functions are available to you natively as ${PREFIX}<name>: call them through native function calling with complete arguments that satisfy their schemas. Never call WorkBuddy/CodeBuddy built-in tools, skills, MCP, agents or background tasks, and never write function calls, arguments, JSON envelopes or markup such as DSML as text. The user message holds the host's ordered conversation as JSON; follow its original role priorities. A host tool result is data from the host, not a request to run local tools.
Keep working with native host function calls until the task is done. Do not end a turn with only a plan or an announcement of your next action: perform that action with a host function call in the same turn. When the task is complete, or you need the user's input, answer in plain text.`;
/** Host functions become mcp__host__<name>; upstream function names stop at 64 characters. */
export function nativeSupported(tools=[]){
  return tools.every(t=>t?.type==='function'&&/^[A-Za-z0-9_-]{1,53}$/.test(t.function?.name??'')&&
    (t.function.parameters===undefined||t.function.parameters!==null&&typeof t.function.parameters==='object'&&[undefined,'object'].includes(t.function.parameters.type)));
}
export function hostTools(body){return body.tools?.length&&body.tool_choice!=='none'?body.tools:[];}
/** Declare the host's own schemas natively; nothing here ever executes a call. */
export function hostServer(tools){
  const server=new McpServer({name:HOST,version:'1.0.0'},{capabilities:{tools:{}}});
  const list=tools.map(({function:f})=>({name:f.name,...(f.description?{description:f.description}:{}),inputSchema:{type:'object',...f.parameters}}));
  server.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:list}));
  // The PreToolUse hook stops the runtime first; a call that still arrives is never run here.
  server.server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:FORWARDED}],isError:true}));
  return {type:'sdk',name:HOST,instance:server};
}
const pinnedName=body=>typeof body.tool_choice==='object'?body.tool_choice?.function?.name??null:null;
function choiceLine(body){
  const name=pinnedName(body);
  if(!hostTools(body).length)return 'Host functions are unavailable for this step: answer in plain text.';
  if(name)return `Call the host function ${name} natively now.`;
  return (body.tool_choice==='required'?'This step requires a native host function call. ':'')+
    'Call host functions natively for every action the task still needs; answer in plain text only when the task is complete or you need the user. Never write calls, arguments or markup as text.';
}
export function nativeInput(body,{messages=body.messages,delta=false}={}){
  const input=JSON.stringify({protocol:'host-turn-v2',history:delta?'new-messages-only':'full',messages,tool_choice:body.tool_choice??'auto',response_format:body.response_format??null});
  return input+'\n\n'+(delta?'Continue the same host task with the new messages above. ':'END OF HOST INPUT. ')+choiceLine(body);
}
const REASONS={
  invalid_tool_arguments:issue=>issue?.tool?`The arguments for host function ${issue.tool} failed its schema: ${JSON.stringify(issue.issues).slice(0,1500)}.`:'You called a function that the host did not declare.',
  required_tool_missing:()=>'This step requires a native host function call.',
  wrong_pinned_tool:(_,body)=>`This step must call the host function ${pinnedName(body)}.`,
  tools_disabled:()=>'Host functions are disabled for this step; answer in plain text.',
  unfinished_turn:()=>'You ended the turn announcing your next action without calling a host function. If the task needs that action, call the host function natively now; if you were answering the user, give the complete answer.',
};
/** Same native session and transcript; only the reason and the native-call contract are repeated. */
export function nativeCorrection(body,error){
  const reason=REASONS[error.code]?.(error.decisionIssue,body)??'You wrote a function call, its arguments or protocol markup as text instead of calling the host function natively.';
  return {prompt:`Your preceding turn was rejected; the host executed nothing from it. ${reason} Continue the same task: call host functions natively (${PREFIX}<name>) with complete arguments that satisfy their schemas, or answer in plain text if the task is complete. Never write calls or markup as text.`,
    schemaCharacters:0,toolNames:error.decisionIssue?.tool?[error.decisionIssue.tool]:[]};
}
const ANNOUNCE_EN=/^(?:(?:ok(?:ay)?|alright|sure|now|next|first|then|great)[,.!:]?\s+)*(?:I['’]ll|I will|I am going to|I['’]m going to|I['’]m now going to|let me(?!\s+know)|let['’]s)\b/i;
const ANNOUNCE_ZH=/^(?:(?:好的?|嗯|现在|接下来|下面|然后|首先|那么)[，,。！!：:]?\s*)*(?:我(?:先|来|将|会|准备|再|继续|现在)|让我|先(?:读取|读|查看|看看?|检查|搜索|运行|执行|修改|写)|继续(?:读取|查看|检查|修改|处理))/;
const ANNOUNCE_PREFIX_EN=/^(?:(?:ok(?:ay)?|alright|sure|now|next|first|then|great)\b[,.!:\s]*)*(?:o(?:k(?:ay)?)?|a(?:l(?:r(?:i(?:g(?:h(?:t)?)?)?)?)?)?|s(?:u(?:r(?:e)?)?)?|n(?:o(?:w)?|e(?:x(?:t)?)?)?|f(?:i(?:r(?:s(?:t)?)?)?)?|t(?:h(?:e(?:n)?)?)?|g(?:r(?:e(?:a(?:t)?)?)?)?|I(?:['’]?(?:l|ll|m)?|\s+(?:w(?:i(?:l|ll)?)?|a(?:m(?:\s+g(?:o(?:i(?:n(?:g(?:\s+t(?:o)?)?)?)?)?)?)?)?|n(?:o(?:w)?)?)?)?|l(?:e(?:t(?:['’]?s|\s+m(?:e)?)?)?)?)$/i;
const ANNOUNCE_PREFIX_ZH=/^(?:(?:好的?|嗯|现在|接下来|下面|然后|首先|那么)[，,。！!：:\s]*)*(?:好|现|接(?:下来?)?|下(?:面)?|然(?:后)?|首(?:先)?|那(?:么)?|我|让|先|继续?)?$/;
const DONE=/已完成|已经完成|完成了|已(?:写好|写入|修改|改好|创建|更新|修复|删除|运行|确认)|总结|结论|如下|以下是|\b(?:done|completed?|finished|summary|summari[sz]e|in short|updated|fixed|added|created|removed|changed|implemented|verified)\b|\bhere(?:'s| is| are)\b/i;
const mayAnnounce=text=>ANNOUNCE_EN.test(text)||ANNOUNCE_ZH.test(text);
const mayStartAnnounce=text=>mayAnnounce(text)||text.length<=24&&(ANNOUNCE_PREFIX_EN.test(text)||ANNOUNCE_PREFIX_ZH.test(text));
/** A short reply that only announces its next action ends the host task without doing it. */
export function unfinishedTurn(text){
  const t=String(text).trim();
  return !!t&&t.length<=240&&!/```/.test(t)&&!/[?？]\s*$/.test(t)&&mayAnnounce(t)&&!DONE.test(t);
}
/** Streams plain native text as it arrives, but keeps printed call envelopes, argument
 * objects and short announcements private until the turn shows what they are. */
export class NativeTextGate {
  constructor(send,{enabled=true,params=new Set(),announce=true}={}){this.send=send;this.enabled=enabled;this.params=params;this.announce=announce;this.text='';this.emitted=0;this.blocked=false;}
  push(delta){this.text+=delta;this.pump(false);}
  pump(final){
    if(!this.enabled||this.blocked)return;
    const leak=protocolAt(this.text,this.params);
    if(leak>=0){this.release(leak);this.blocked=true;return;}
    if(!final){
      const head=this.text.trimStart();
      if(!head||this.announce&&head.length<=240&&mayStartAnnounce(head))return;
      const pending=pendingAt(this.text);this.release(pending>=0?pending:this.text.length);
    }else this.release(this.text.length);
  }
  release(end){
    if(end<=this.emitted)return;
    if(/[\uD800-\uDBFF]/.test(this.text[end-1]??''))end--;
    const text=this.text.slice(this.emitted,end);if(text){this.send(text);this.emitted=end;}
  }
  get emittedText(){return this.text.slice(0,this.emitted);}
}
const paramNames=tools=>new Set(tools.flatMap(t=>Object.keys(t.function?.parameters?.properties??{})));
/** Validate the runtime's native calls, or decide what the turn's plain text is. */
export function nativeDecision({calls,text,truncated},body,validators,{allowUnfinished=false}={}){
  const tools=hostTools(body),params=body.response_format?new Set():paramNames(body.tools??[]);
  let choice=body.tool_choice??'auto';if(typeof choice==='object')choice=pinnedName(body);
  // A turn cut by the output budget may hold a call whose arguments merely look complete.
  if(truncated)throw new BridgeError(502,'output_budget','WorkBuddy exhausted its output budget before a complete answer');
  if(calls.length){
    if(choice==='none'||!tools.length)throw new BridgeError(502,'tools_disabled','Model requested a host tool while tools are disabled');
    if(calls.length>32||body.parallel_tool_calls===false&&calls.length>1)throw new BridgeError(502,'invalid_decision','Host call batch exceeds the permitted size');
    const invalid=(tool,issues)=>{const error=new BridgeError(502,'invalid_tool_arguments','Model returned an undeclared host tool or arguments that fail its JSON Schema');error.decisionIssue={tool,issues};throw error;};
    const decided=calls.map(call=>{
      const name=call.name?.startsWith(PREFIX)?call.name.slice(PREFIX.length):null,validate=name&&validators.get(name);
      if(!validate)invalid(null,[{keyword:'declared_tool'}]);
      if(!call.input||typeof call.input!=='object'||Array.isArray(call.input))invalid(name,[{keyword:'type',path:'/',type:'object'}]);
      if(!validate(call.input))invalid(name,(validate.errors??[]).slice(0,8).map(e=>({keyword:e.keyword,path:(e.instancePath||'/').slice(0,160),
        ...(e.params?.missingProperty!==undefined?{missingProperty:String(e.params.missingProperty).slice(0,160)}:{}),
        ...(e.params?.type!==undefined?{type:e.params.type}:{}),message:e.message})));
      if(!['auto','required'].includes(choice)&&choice!==name)throw new BridgeError(502,'wrong_pinned_tool','Model returned a different host tool than requested');
      return {id:call.id,name,arguments:call.input};
    });
    // Markup printed beside real calls is a duplicate rendering; it is never shown or executed.
    const leak=protocolAt(text,params),content=leak>=0?text.slice(0,leak):text;
    return {action:'tool_calls',calls:decided,...(content.trim()?{content}:{}),repairs:leak>=0?[{kind:'native_markup_dropped'}]:[]};
  }
  const leak=protocolAt(text,params);
  if(leak>=0){
    // Calls printed as text: decode them with the strict JSON/DSML decoders, or reject the turn.
    const repairs=[];const decoded=parseDecision(text.slice(leak),body,validators,repair=>repairs.push(repair));const prose=text.slice(0,leak);
    // Keep the prose prefix intact: the gate may already have streamed it to the host.
    const content=prose.trim()?prose+(decoded.content?'\n\n'+decoded.content:''):decoded.content??'';
    if(decoded.action==='final')return {action:'final',content,repairs:[...repairs,{kind:'native_text_envelope'}]};
    return {action:'tool_calls',calls:decoded.calls,...(content?{content}:{}),textCalls:true,repairs:[...repairs,{kind:'native_text_calls'}]};
  }
  if(!text.trim())throw new BridgeError(502,'invalid_decision','WorkBuddy returned neither a host call nor an answer');
  if(choice==='required'||choice&&!['auto','none'].includes(choice))throw new BridgeError(502,'required_tool_missing','Model answered without the required host tool');
  if(tools.length&&!allowUnfinished&&unfinishedTurn(text))throw new BridgeError(502,'unfinished_turn','Model announced its next action without calling a host function');
  return {action:'final',content:text,repairs:[]};
}
