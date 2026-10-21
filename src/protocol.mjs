import {BridgeError} from './errors.mjs';
import {semanticMessages} from './context.mjs';
import {compileTools} from './decision.mjs';
export const PUBLIC_MODEL='workbuddy-deepseek-flash';
export function modelsFor(info){return [1000000,400000,200000].filter(n=>n<=info.contextWindow).map((n,i)=>({id:i===0&&n===1000000?PUBLIC_MODEL:`${PUBLIC_MODEL}-${n/1000}k`,name:`WorkBuddy DeepSeek Flash (${n===1000000?'1M':n/1000+'K'})`,contextWindow:n,maxTokens:Math.min(info.maxTokens,32000),reasoningEfforts:Object.fromEntries((info.reasoning?.supportedEfforts??[]).filter(x=>['low','high','max'].includes(x)).map(x=>[x,x]))}));}
export function prepareRequest(body,info){
  const bad=message=>{throw new BridgeError(400,'invalid_request',message);};
  if(!body||typeof body!=='object'||Array.isArray(body))bad('JSON object required');
  const selected=modelsFor(info).find(m=>m.id===body.model);if(!selected)throw new BridgeError(404,'model_not_found','Only the advertised WorkBuddy DeepSeek Flash model IDs are allowed');
  if(!Array.isArray(body.messages)||!body.messages.length)bad('Nonempty messages required');
  for(const m of body.messages)if(!m||!['system','developer','user','assistant','tool'].includes(m.role)||!(typeof m.content==='string'||Array.isArray(m.content)||m.role==='assistant'&&m.content==null))bad('Invalid message role or content');
  const messages=semanticMessages(body.messages);
  for(const m of messages){
    if(m.role==='tool'&&(typeof m.tool_call_id!=='string'||!m.tool_call_id))bad('Tool results require tool_call_id');
    if(m.tool_calls!==undefined&&(!Array.isArray(m.tool_calls)||m.role!=='assistant'||m.tool_calls.some(c=>c?.type!=='function'||typeof c.id!=='string'||!c.id||typeof c.function?.name!=='string'||typeof c.function?.arguments!=='string')))bad('Invalid assistant tool_calls');
  }
  if(body.tools!==undefined&&!Array.isArray(body.tools))bad('tools must be an array');
  compileTools(body.tools);
  if(body.prompt_cache_key!==undefined&&(typeof body.prompt_cache_key!=='string'||!body.prompt_cache_key||body.prompt_cache_key.length>1024))bad('prompt_cache_key must be a nonempty string of at most 1024 characters');
  const choice=body.tool_choice;
  if(choice!==undefined&&!['auto','none','required'].includes(choice)&&!(choice?.type==='function'&&typeof choice.function?.name==='string'&&body.tools?.some(t=>t.function.name===choice.function.name)))bad('Invalid tool_choice');
  if(choice==='required'&&!body.tools?.length)bad('tool_choice required needs tools');
  if(body.parallel_tool_calls!==undefined&&typeof body.parallel_tool_calls!=='boolean')bad('parallel_tool_calls must be boolean');
  if(body.stream_options!==undefined&&(!body.stream_options||typeof body.stream_options!=='object'||Array.isArray(body.stream_options)||body.stream_options.include_usage!==undefined&&typeof body.stream_options.include_usage!=='boolean'))bad('Invalid stream_options');
  if(body.stream!==undefined&&typeof body.stream!=='boolean')bad('stream must be boolean');
  if(body.n!==undefined&&body.n!==1)bad('Only n=1 is supported');
  if(body.reasoning_effort!==undefined&&!Object.hasOwn(selected.reasoningEfforts,body.reasoning_effort))bad('Unsupported reasoning_effort; use an advertised level');
  const limit=body.max_tokens??body.max_completion_tokens??selected.maxTokens;
  if(!Number.isSafeInteger(limit)||limit<1||limit>selected.maxTokens)bad(`max_tokens must be 1..${selected.maxTokens}`);
  const allowed=['temperature','top_p','stop','seed','presence_penalty','frequency_penalty','response_format','parallel_tool_calls','tools','tool_choice','prompt_cache_key'];
  const upstream={model:info.id,bridge_public_model:selected.id,messages,stream:true,stream_options:{include_usage:true},max_tokens:limit,reasoning_effort:body.reasoning_effort??'high'};
  for(const key of allowed)if(body[key]!==undefined)upstream[key]=body[key];
  return {upstream,selected,stream:body.stream===true};
}
export async function* sseEvents(stream,{maxEventBytes=2*1024*1024,signal}={}){
  const reader=stream.getReader();const decoder=new TextDecoder();let buffer='';
  const abort=()=>{reader.cancel(signal.reason).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  const parse=event=>event.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).replace(/^ /,'')).join('\n');
  try{
    while(true){signal?.throwIfAborted();const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      let match;while((match=/\r?\n\r?\n/.exec(buffer))){const event=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);if(Buffer.byteLength(event)>maxEventBytes)throw new BridgeError(502,'event_too_large','Upstream SSE event exceeds limit');const data=parse(event);if(data)yield data;}
      if(Buffer.byteLength(buffer)>maxEventBytes)throw new BridgeError(502,'event_too_large','Upstream SSE event exceeds limit');
      if(done){if(buffer.trim()){const data=parse(buffer);if(data)yield data;}break;}
    }
  }finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export class Completion {
  constructor(model){this.model=model;this.content='';this.reasoning='';this.tools=new Map();this.finish=null;this.usage=null;this.id=null;this.created=null;this.done=false;this.bytes=0;}
  accept(data,upstreamId){
    if(data==='[DONE]'){this.done=true;return null;}
    let chunk;try{chunk=JSON.parse(data);}catch{throw new BridgeError(502,'invalid_sse','Malformed WorkBuddy SSE JSON');}
    if(chunk.error)throw new BridgeError(chunk.error.code==='workbuddy_11128'?400:502,chunk.error.code??'upstream_stream_error',chunk.error.message??'WorkBuddy returned an error inside the stream');
    if(chunk.model&&chunk.model!==upstreamId)throw new BridgeError(502,'model_mismatch','Upstream returned a different model; stream stopped');
    this.bytes+=Buffer.byteLength(data);if(this.bytes>32*1024*1024)throw new BridgeError(502,'response_too_large','Response exceeds bridge limit');
    this.id??=chunk.id;this.created??=chunk.created;if(chunk.usage)this.usage=chunk.usage;
    for(const choice of chunk.choices??[]){
      if(choice.index!==0)throw new BridgeError(502,'invalid_choice','Unexpected completion choice');
      const d=choice.delta??{};this.content+=d.content??'';this.reasoning+=d.reasoning_content??'';
      for(const t of d.tool_calls??[]){if(!Number.isSafeInteger(t.index)||t.index<0)throw new BridgeError(502,'invalid_tool_index','Invalid tool index');
        const current=this.tools.get(t.index)??{id:'',type:'function',function:{name:'',arguments:''}};
        current.id+=t.id??'';current.function.name+=t.function?.name??'';current.function.arguments+=t.function?.arguments??'';this.tools.set(t.index,current);
      }
      if(choice.finish_reason)this.finish=choice.finish_reason;
      // WorkBuddy uses empty-string interim finish reasons; OpenAI clients expect null.
      if(choice.finish_reason==='')choice.finish_reason=null;
      if(d.function_call&&!d.function_call.name&&!d.function_call.arguments)delete d.function_call;
    }
    return {...chunk,model:this.model};
  }
  validate(tools){
    if(!this.done||!this.finish)throw new BridgeError(502,'truncated_stream','WorkBuddy stream ended without a completed terminal event');
    const declared=new Set((tools??[]).map(t=>t.function?.name));
    for(const t of this.tools.values()){let args;try{args=JSON.parse(t.function.arguments);}catch{throw new BridgeError(502,'invalid_tool_arguments','WorkBuddy returned malformed tool arguments');}
      if(!t.id||!declared.has(t.function.name)||!args||typeof args!=='object'||Array.isArray(args))throw new BridgeError(502,'invalid_tool_call','WorkBuddy returned an undeclared or invalid tool call');}
    if(this.tools.size&&this.finish!=='tool_calls')throw new BridgeError(502,'invalid_tool_finish','Tool output did not finish with tool_calls');
  }
  result(){const message={role:'assistant',content:this.content||null};if(this.reasoning)message.reasoning_content=this.reasoning;if(this.tools.size)message.tool_calls=[...this.tools.entries()].sort((a,b)=>a[0]-b[0]).map(([,t])=>t);return {id:this.id,object:'chat.completion',created:this.created,model:this.model,choices:[{index:0,message,finish_reason:this.finish}],usage:this.usage};}
}
