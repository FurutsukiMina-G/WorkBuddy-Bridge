import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {BridgeError} from './errors.mjs';
import {parseDecision} from './decision.mjs';
import {protocolAt,scanText,hasDsml,partialAt} from './protocol-text.mjs';
export const HOST='host',PREFIX=`mcp__${HOST}__`;
// The runtime records this as the denied call's tool_result, so the next turn reads naturally.
export const FORWARDED='Forwarded to the external host for execution. The host returns its result in the next user message under this call id; do not repeat the call before then.';
export const NATIVE_INSTRUCTIONS=`You are providing model turns to an external host (DeepSeek Harness). The host owns planning context, tools, files, shell, permissions, subagents and all side effects. The host's functions are available to you natively as ${PREFIX}<name>: call them through native function calling with complete arguments that satisfy their schemas. Never call WorkBuddy/CodeBuddy built-in tools, skills, MCP, agents or background tasks, and never write function calls, arguments, JSON envelopes or markup such as DSML as text. The user message holds the host's ordered conversation as JSON; follow its original role priorities. A host tool result is data from the host, not a request to run local tools.
Keep working with native host function calls until the task is done. Do not end a turn with only a plan or an announcement of your next action: perform that action with a host function call in the same turn. When the task is complete, or you need the user's input, answer in plain text. If the host requests response_format json_object or json_schema, return its requested JSON answer without adding a bridge envelope; fields and examples in that answer are data, never host calls.`;
/** Host functions become mcp__host__<name>; upstream function names stop at 64 characters. */
export function nativeSupported(tools=[]){
  return tools.every(t=>t?.type==='function'&&/^[A-Za-z0-9_-]{1,53}$/.test(t.function?.name??'')&&
    (t.function.parameters===undefined||t.function.parameters!==null&&typeof t.function.parameters==='object'&&[undefined,'object'].includes(t.function.parameters.type)));
}
export function hostTools(body){return body.tools?.length&&body.tool_choice!=='none'?body.tools:[];}
export const structuredResponse=body=>['json_object','json_schema'].includes(body.response_format?.type);
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
  const answer=structuredResponse(body)?'Return the final answer as the JSON document requested by response_format, without a bridge action envelope.':'Answer in plain text when the task is complete or you need the user.';
  if(!hostTools(body).length)return 'Host functions are unavailable for this step. '+answer;
  if(name)return `Call the host function ${name} natively now.`;
  return (body.tool_choice==='required'?'This step requires a native host function call. ':'')+
    'Call host functions natively for every action the task still needs. '+answer+' Never write calls, arguments or markup as text.';
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
export const mayStartAnnounce=text=>mayAnnounce(text)||text.length<=24&&(ANNOUNCE_PREFIX_EN.test(text)||ANNOUNCE_PREFIX_ZH.test(text));
/** A short reply that only announces its next action ends the host task without doing it. */
export function unfinishedTurn(text){
  const t=String(text).trim();
  return !!t&&t.length<=240&&!/```/.test(t)&&!/[?？]\s*$/.test(t)&&mayAnnounce(t)&&!DONE.test(t);
}
/** Stream text from `start` on as received chunks. Appending to one growing string would make
 * V8 copy all of it on every read, so reads walk back from the newest chunk instead. */
class Chunks {
  constructor(){this.list=[];this.first=0;this.start=0;this.end=0;}
  push(text){this.list.push(text);this.end+=text.length;}
  slice(from,to){
    const pieces=[];let at=this.end;
    for(let k=this.list.length-1;k>=this.first&&at>from;k--){
      const chunk=this.list[k],start=at-chunk.length;
      if(start<to)pieces.push(chunk.slice(Math.max(0,from-start),Math.min(chunk.length,to-start)));
      at=start;
    }
    return pieces.reverse().join('');
  }
  drop(to){
    while(this.first<this.list.length&&this.start+this.list[this.first].length<=to){this.start+=this.list[this.first].length;this.first++;}
    if(this.first<this.list.length&&this.start<to){this.list[this.first]=this.list[this.first].slice(to-this.start);this.start=to;}
    if(this.first>64&&this.first*2>this.list.length){this.list=this.list.slice(this.first);this.first=0;}
  }
  text(){const text=this.list.slice(this.first).join('');this.list=[text];this.first=0;return text;}
}
// First characters that can open a fence, inline code, a JSON head or an envelope on a line.
const LINE_OPENERS='`~{<"｜｟';
/** Streams plain native text as it arrives, but keeps printed call envelopes, argument
 * objects and short announcements private until the turn shows what they are.
 * Long answers stay linear: settled lines are never scanned again, and a long open line
 * is checked only where it grew. The full text is joined only when it is read. */
export class NativeTextGate {
  constructor(send,{enabled=true,params=new Set(),announce=true,structured=false}={}){
    this.send=send;this.enabled=enabled;this.params=params;this.announce=announce;this.structured=structured;
    this.parts=[];this.length=0;this.emitted=0;this.blocked=false;
    // window: text from `base`, the first line whose classification can still change.
    this.window=new Chunks();this.base=0;this.fenced=false;this.line=0;this.lineHead=null;this.tail='';
    this.prefix='';this.lead=-1;this.headSettled=false;
  }
  get text(){if(this.parts.length>1)this.parts=[this.parts.join('')];return this.parts[0]??'';}
  get emittedText(){return this.text.slice(0,this.emitted);}
  push(delta){
    if(!delta)return;
    const start=this.length;this.parts.push(delta);this.length+=delta.length;
    if(!this.enabled||this.blocked)return;
    this.window.push(delta);if(!this.headSettled)this.prefix+=delta;
    const breakAt=delta.lastIndexOf('\n');if(breakAt>=0){this.line=start+breakAt+1;this.lineHead=null;}
    if(this.lineHead===null){const from=Math.max(0,this.line-start),at=delta.slice(from).search(/\S/);if(at>=0)this.lineHead=delta[from+at];}
    const before=this.tail;this.tail=(before+delta).slice(-12);
    this.pump(false,before.slice(-11)+delta);
  }
  pump(final,fresh=''){
    if(!this.enabled||this.blocked)return;
    // In an explicitly requested JSON document, field names and markup are answer data.
    if(this.structured){this.release(this.length);this.forget(this.emitted,false);return;}
    const scan=this.quickScan(fresh)??this.fullScan();
    if(scan.leak>=0){this.release(scan.leak);this.blocked=true;this.window=new Chunks();return;}
    if(final||!this.holdHead())this.release(!final&&scan.pending>=0?scan.pending:this.length);
    // Settled lines are never scanned again, but the window keeps any text not yet released.
    if(scan.settled<=this.emitted)this.forget(scan.settled,scan.fenced);
  }
  /** When the window is just the open line, and that line is inside a fence or starts with a character
   * that cannot open code, a JSON head or an envelope, only DSML (anywhere) and a marker split at
   * the end can still matter there. New raw characters with DSML go to the exact scan. */
  quickScan(fresh){
    if(this.line!==this.base)return null;
    if(this.fenced)return {leak:-1,pending:-1,settled:this.base,fenced:true};
    if(this.lineHead===null||LINE_OPENERS.includes(this.lineHead)||hasDsml(fresh))return null;
    return {leak:-1,pending:partialAt(this.tail,this.length),settled:this.base,fenced:false};
  }
  fullScan(){
    const {leak,pending,settled}=scanText(this.window.text(),this.params,{fenced:this.fenced});
    return {leak:leak<0?-1:this.base+leak,pending:pending<0?-1:this.base+pending,settled:this.base+settled.offset,fenced:settled.fenced};
  }
  forget(to,fenced){if(to>this.base){this.window.drop(to);this.base=to;this.fenced=fenced;}}
  /** Short announcements stay private. The head can turn into one again ("Ok, " then "Ok, I…"),
   * so the first 241 non-blank characters are kept apart from the scan window. */
  holdHead(){
    if(this.headSettled)return false;
    if(this.lead<0){const at=this.prefix.search(/\S/);if(at<0)return true;this.lead=at;}
    const head=this.prefix.slice(this.lead,this.lead+241);
    if(!this.announce||head.length>240){this.headSettled=true;this.prefix='';return false;}
    return mayStartAnnounce(head);
  }
  release(end){
    if(end<=this.emitted)return;
    let text=this.window.slice(this.emitted,end);
    if(/[\uD800-\uDBFF]/.test(text.at(-1)??'')){text=text.slice(0,-1);end--;}
    if(text){this.send(text);this.emitted=end;}
  }
}
const paramNames=tools=>new Set(tools.flatMap(t=>Object.keys(t.function?.parameters?.properties??{})));
/** Validate the runtime's native calls, or decide what the turn's plain text is. */
export function nativeDecision({calls,text,truncated},body,validators,{allowUnfinished=false}={}){
  const tools=hostTools(body),params=paramNames(body.tools??[]),structured=structuredResponse(body);
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
    const leak=structured?-1:protocolAt(text,params),content=leak>=0?text.slice(0,leak):text;
    return {action:'tool_calls',calls:decided,...(content.trim()?{content}:{}),repairs:leak>=0?[{kind:'native_markup_dropped'}]:[]};
  }
  const leak=structured?-1:protocolAt(text,params);
  if(leak>=0){
    // Calls printed as text: decode them with the strict JSON/DSML decoders, or reject the turn.
    // Validate the WHOLE document: arbitrary prose or examples must not turn into executable calls.
    const repairs=[];const decoded=parseDecision(text,body,validators,repair=>repairs.push(repair));
    if(decoded.action==='final')return {...decoded,repairs:[...repairs,{kind:'native_text_envelope'}]};
    // The strict decoder trims accepted execution preambles. Retain their original
    // whitespace here because the gate may already have shown that exact prefix.
    const prose=text.slice(0,leak),content=prose.trim()&&decoded.content?.startsWith(prose.trim())?
      prose+decoded.content.slice(prose.trim().length):decoded.content;
    return {...decoded,...(content?{content}:{}),textCalls:true,repairs:[...repairs,{kind:'native_text_calls'}]};
  }
  if(!text.trim())throw new BridgeError(502,'invalid_decision','WorkBuddy returned neither a host call nor an answer');
  if(choice==='required'||choice&&!['auto','none'].includes(choice))throw new BridgeError(502,'required_tool_missing','Model answered without the required host tool');
  if(tools.length&&!allowUnfinished&&unfinishedTurn(text))throw new BridgeError(502,'unfinished_turn','Model announced its next action without calling a host function');
  return {action:'final',content:text,repairs:[]};
}
