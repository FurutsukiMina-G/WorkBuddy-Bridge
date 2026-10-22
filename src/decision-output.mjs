import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {BridgeError} from './errors.mjs';
import {parseDecision} from './decision.mjs';
import {executionPreamble} from './execution-preamble.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const USAGE_KEYS=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
function mergeUsage(current,incoming){
  if(!incoming||typeof incoming!=='object')return current;
  if(current&&(current.input_tokens>0||current.output_tokens>0)&&incoming.input_tokens===0&&incoming.output_tokens===0)return current;
  const next={...current,...incoming};
  // Native tool-use turns emit a second message_delta with cache_creation_input_tokens=0
  // after the tool_use delta already reported the positive cache creation count.
  for(const key of USAGE_KEYS)if(Number.isSafeInteger(current?.[key])&&current[key]>0&&incoming[key]===0)next[key]=current[key];
  return next;
}
export class DecisionOutput {
  constructor(){this.result=null;this.text=[];this.seen=new Set();this.blockText=new Map();this.streamText=[];this.stopReasons=new Set();this.assistantUsage=null;this.assistantUsages=new Map();this.partialUsage=null;this.lastUsage=undefined;this.characters=0;this.usageBasis=null;}
  observe(message){
    if(message.type==='result')this.result=message;
    if(message.type==='assistant'){
      const duplicate=message.uuid&&this.seen.has(message.uuid);
      if(message.uuid)this.seen.add(message.uuid);
      if(!duplicate)for(const block of message.message?.content??[])if(block.type==='text'&&typeof block.text==='string')this.text.push(block.text);
      const u=message.message?.usage;
      if(u&&(!this.assistantUsage||u.input_tokens>0||u.output_tokens>0)){
        this.assistantUsage=u;this.assistantUsages.set(message.message?.id??'latest',u);
      }
      if(message.message?.stop_reason)this.stopReasons.add(message.message.stop_reason);
    }
    if(message.type!=='stream_event')return;
    const event=message.event;
    if(event?.type==='message_start'&&event.message?.usage)this.partialUsage=mergeUsage(this.partialUsage,event.message.usage);
    if(event?.type==='message_start')this.blockText.clear();
    if(event?.type==='content_block_start'&&event.content_block?.type==='text')this.blockText.set(event.index,event.content_block.text??'');
    if(event?.delta?.type==='text_delta'){
      const text=event.delta.text??'';this.characters+=text.length;
      this.blockText.set(event.index,(this.blockText.get(event.index)??'')+text);
    }
    if(event?.type==='content_block_stop'&&this.blockText.has(event.index)){
      this.streamText.push(this.blockText.get(event.index));this.blockText.delete(event.index);
    }
    if(event?.delta?.stop_reason)this.stopReasons.add(event.delta.stop_reason);
    if(event?.usage)this.partialUsage=mergeUsage(this.partialUsage,event.usage);
  }
  usage(previousResultUsage=null,{resumed=false}={}){
    const positive=u=>u&&(u.input_tokens>0||u.output_tokens>0);
    let terminal=this.result?.usage,terminalBasis='fresh-result';
    if(terminal&&previousResultUsage){
      const delta={};let regressed=false;
      for(const key of USAGE_KEYS){
        if(Number.isSafeInteger(terminal[key])&&Number.isSafeInteger(previousResultUsage[key])){
          if(terminal[key]<previousResultUsage[key])regressed=true;delta[key]=terminal[key]-previousResultUsage[key];
        }
      }
      terminal=regressed?null:delta;terminalBasis='cumulative-result-delta';
    }else if(resumed)terminal=null;
    const completeCache=usage=>{
      // Stream cache_creation=0 is a placeholder on this runtime. A terminal
      // snapshot with the same input/output can supply its precise cache split.
      const completed={...usage};
      if(terminal&&terminal.input_tokens===usage.input_tokens&&terminal.output_tokens===usage.output_tokens){
        for(const key of ['cache_read_input_tokens','cache_creation_input_tokens'])if(Number.isSafeInteger(terminal[key])&&terminal[key]>=0)completed[key]=terminal[key];
      }else if(!completed.cache_creation_input_tokens&&completed.input_tokens>(completed.cache_read_input_tokens??0))delete completed.cache_creation_input_tokens;
      return completed;
    };
    const responses=[...this.assistantUsages.values()].filter(positive);
    if(responses.length){
      this.usageBasis='per-response-assistant';
      if(responses.length===1)return this.lastUsage=completeCache(mergeUsage(this.partialUsage,responses[0]));
      const total={};for(const key of USAGE_KEYS)
        if(responses.every(u=>Number.isSafeInteger(u[key])&&u[key]>=0))total[key]=responses.reduce((n,u)=>n+u[key],0);
      return this.lastUsage=total;
    }
    if(positive(this.partialUsage)){this.usageBasis='per-response-stream';return this.lastUsage=completeCache(this.partialUsage);}
    // Result.usage survives native resume and is CUMULATIVE. Never sum it as a turn.
    this.usageBasis=terminalBasis;
    if(terminal?.input_tokens===0&&terminal?.output_tokens===0&&this.candidates().length)return this.lastUsage=undefined;
    return this.lastUsage=terminal??undefined;
  }
  isTruncated(){return ['max_tokens','length','model_context_window_exceeded'].some(reason=>this.stopReasons.has(reason));}
  candidates(){
    const candidates=[];const seen=new Set();
    const add=(source,text)=>{if(typeof text==='string'&&text.trim()&&!seen.has(text)){seen.add(text);candidates.push({source,text});}};
    if(typeof this.result?.structured_output==='object'&&this.result.structured_output!==null){add('structured_output',JSON.stringify(this.result.structured_output));return candidates;}
    add('result',this.result?.result);
    // All text blocks in a channel form one document. Looking for a valid
    // decision in individual blocks could silently drop a malformed later call.
    add('assistant',this.text.join(''));
    // Completed text blocks only; never promote an open partial block.
    add('stream',this.streamText.join(''));
    return candidates;
  }
  decision(body,validators){
    if(this.isTruncated())throw new BridgeError(502,'output_budget','WorkBuddy exhausted its output budget before a complete decision');
    const valid=[];let rejection,protocolRejection;
    for(const candidate of this.candidates()){
      try{const repairs=[];const decision=parseDecision(candidate.text,body,validators,repair=>repairs.push(repair));valid.push({...candidate,decision,repairs});}catch(e){
        // Keep a precise schema/choice failure instead of downgrading it to
        // "not JSON" because a later SDK channel holds a prose summary.
        if(!rejection||rejection.code==='invalid_decision')rejection=e;
        if(/^\s*(?:<｜｜DSML｜｜|<?\{\s*"action"\s*:|```(?:json|xml|text)?[ \t]*\r?\n)/i.test(candidate.text)||executionPreamble(candidate.text.trim()))protocolRejection??=e;
      }
    }
    if(!valid.length)throw rejection??new BridgeError(502,'invalid_decision','WorkBuddy returned no complete JSON host decision');
    if(protocolRejection)throw protocolRejection;
    if(valid.some(candidate=>!isDeepStrictEqual(candidate.decision,valid[0].decision)))throw new BridgeError(502,'ambiguous_decision','WorkBuddy SDK output channels contain conflicting host decisions');
    const wire=valid[0].text.trim().replace(/^```(?:json|xml|text)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i,'$1').trim();
    return {decision:valid[0].decision,source:valid[0].source,format:/^<?\{/.test(wire)||valid[0].repairs.some(r=>r.kind==='json_execution_preamble')?'json':'dsml',repairs:valid[0].repairs};
  }
  evidence(){return {resultSubtype:this.result?.subtype??null,result:this.result?.result??null,structuredOutput:this.result?.structured_output??null,assistantText:this.text,completedStreamText:this.streamText,stopReasons:[...this.stopReasons],usage:(this.lastUsage!==undefined?this.lastUsage:this.usage())??null};}
  summary(){return {resultSubtype:this.result?.subtype??null,stopReasons:[...this.stopReasons],outputs:this.candidates().map(({source,text})=>({source,characters:text.length,sha256:hash(text)}))};}
}
