import {query} from '@tencent-ai/agent-sdk';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {DECISION_INSTRUCTIONS,decisionInput,compileTools} from './decision.mjs';
import {DecisionOutput} from './decision-output.mjs';
import {BridgeError,publicError} from './errors.mjs';
import {runtimePath} from './contain.mjs';
import {ContextPool,digest,abortable} from './context.mjs';
import {FinalTextProjector} from './streaming.mjs';
import {normalizedUsage,sumUsage,replayUsage,addSdkUsage} from './usage.mjs';
import {correctionInput} from './recovery.mjs';
import {rejectedEvidence,decisionErrorEvidence,redactSecrets} from './rejection-evidence.mjs';
import {HOST,PREFIX,FORWARDED,NATIVE_INSTRUCTIONS,nativeSupported,hostTools,hostServer,nativeInput,nativeCorrection,nativeDecision,NativeTextGate} from './native.mjs';
import {WarmRuntimes,promptQueue,userMessage} from './warm.mjs';
export {normalizedUsage} from './usage.mjs';
// Explicit denies complement tools:[] on WorkBuddy builds that still enumerate
// their entire tool registry in the init event. The hook covers newly added tools.
const DENIED_TOOLS=['Agent','Read','Write','Edit','Bash','Glob','Grep','PowerShell','EnterPlanMode','ExitPlanMode','TaskCreate','TaskGet','TaskUpdate','TaskList','WebFetch','WebSearch','TaskStop','TaskOutput','Skill','AskUserQuestion','StructuredOutput','ToolSearch','DeferExecuteTool','SendMessage','TeamCreate','TeamDelete','ImageGen','LibraryUpload','VideoGen','AudioTranscribe','A2AGetAgentCard','A2ASendMessage','A2AGetTask','A2ACancelTask','ListMcpResources','ReadMcpResource','MessageColleague','SpeakInChannel','ChannelTasks','CreateColleague','CreateChannel','ListColleagues'];
const RETRYABLE=['invalid_decision','invalid_tool_arguments','required_tool_missing','tools_disabled','wrong_pinned_tool','ambiguous_decision','unfinished_turn'];
const WARM_DELAY_MS=25,WARM_READY_MS=20000;
// The runtime's own message once a denied host call has used the single permitted turn.
const RUNTIME_STOP=/^Max turns \(\d+\) exceeded\.?$/i;
export function sdkOptions(cfg,credential,body,dir,controller,onDenied,onStderr=()=>{},{native=false}={}){
  const cli=runtimePath(cfg);
  if(!existsSync(cli))throw new BridgeError(503,'runtime_missing','WorkBuddy runtime missing; set WORKBUDDY_CLI to its official codebuddy-lite-wb.mjs');
  const env={...process.env,CODEBUDDY_AUTH_TOKEN:credential.accessToken,CODEBUDDY_BASE_URL:'https://copilot.tencent.com/v2',ACC_USER_ID:credential.uid,
    CODEBUDDY_CUSTOM_HEADERS:`X-Domain: ${credential.domain}`,CODEBUDDY_CONFIG_DIR:join(dir,'home'),WORKBUDDY_CONFIG_DIR:join(dir,'home'),
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS:'1',CODEBUDDY_DISABLE_AUTO_MEMORY:'1',CODEBUDDY_DISABLE_CRON:'1',DISABLE_TELEMETRY:'1',
    CODEBUDDY_CODE_MAX_OUTPUT_TOKENS:String(body.max_tokens),CODEBUDDY_API_KEY:undefined,CODEBUDDY_API_KEY_HELPER_DISABLED:'1',
    ACC_PRODUCT_CONFIG:undefined,ACC_PRODUCT_CONFIG_V2:undefined,ACC_PRODUCT_CONFIG_V3:undefined,ACC_PRODUCT_CONFIG_PATH:undefined,WORKBUDDY_BRIDGE_ACTUAL_CLI:cli};
  // Native turns stop at the first host call; the denial text becomes that call's interim result.
  const tools=native?hostTools(body):[],denial=native?FORWARDED:'Host-owned tools';
  return {model:body.model,cwd:dir,tools:[],disallowedTools:DENIED_TOOLS,settingSources:[],strictMcpConfig:true,mcpServers:tools.length?{[HOST]:hostServer(tools)}:{},agents:{},
    canUseTool:async()=>{onDenied();return {behavior:'deny',message:native?FORWARDED:'Only the external host can execute tools'};},
    hooks:{PreToolUse:[{hooks:[async()=>{onDenied();return {continue:false,stopReason:native?'Forwarded to the external host':'Only the external host executes tools',hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:denial}};}]}]},
    systemPrompt:{append:native?NATIVE_INSTRUCTIONS:DECISION_INSTRUCTIONS},maxTurns:1,includePartialMessages:true,persistSession:false,effort:body.reasoning_effort,
    abortController:controller,pathToCodebuddyCode:join(cfg.root??resolve(import.meta.dirname,'..'),'scripts/runtime-launcher.mjs'),executable:process.execPath,env,stderr:onStderr};
}
export class SdkTransport {
  constructor(cfg,auth,{run=query}={}){
    this.cfg=cfg;this.auth=auth;this.run=run;this.pool=new ContextPool(cfg);this.failures=new Map();
    this.warm=new WarmRuntimes({ttlMs:cfg.prewarmMs??0,max:cfg.maxWarm??4});this.pool.onRemove=record=>this.warm.discard(record.id);
    this.metrics={started:0,completed:0,deniedTools:0,hostCalls:0,decodedDsml:0,replays:0,correctionCalls:0,recoveredRequests:0,localDecisionRepairs:0,lastFailure:null,warm:this.warm.stats};
  }
  async close(){this.warm.close();await this.pool.close();}
  warmKey(record,body,credential,native){
    return digest({native,model:body.model,effort:body.reasoning_effort,max:body.max_tokens,tools:native?hostTools(body):null,
      session:record.sessionId,dir:record.dir,token:credential.accessToken,uid:credential.uid,domain:credential.domain});
  }
  /** Boot the runtime for this session's next turn while the host executes the tool calls. */
  prewarm(record,body,credential,native){
    if(!this.warm.ttlMs||!this.warm.max||!record.sessionId)return;
    const sessionId=record.sessionId;
    // Start after the finished runtime released the session, and never beside an active turn.
    setTimeout(()=>{
      if(record.busy||record.sessionId!==sessionId||this.pool.closed||this.pool.records.get(record.id)!==record)return;
      this.warm.start(record.id,this.warmKey(record,body,credential,native),()=>{
        const controller=new AbortController(),input=promptQueue();let sink=()=>{};
        const options=sdkOptions(this.cfg,credential,body,record.dir,controller,native?()=>{}:()=>{this.metrics.deniedTools++;},s=>sink(s),{native});
        options.persistSession=true;options.resume=sessionId;
        const q=this.run({prompt:input.iterable,options});
        const handle={query:q,controller,failed:false,push:text=>input.push(userMessage(text)),setStderr:f=>{sink=f;},
          ready:Promise.resolve().then(()=>q.connect?.())};
        handle.ready.catch(()=>{handle.failed=true;});
        // An unused query has no running iterator to end it. The SDK's cleanup() stops its runtime
        // and releases the session lock, so repeat it once a late initialize has settled.
        handle.close=()=>{input.end();controller.abort();q.cleanup?.();handle.ready.then(()=>q.cleanup?.(),()=>q.cleanup?.());};
        return handle;
      });
    },WARM_DELAY_MS).unref?.();
  }
  async takeWarm(record,body,credential,native,signal){
    const handle=this.warm.take(record.id,this.warmKey(record,body,credential,native));if(!handle)return null;
    let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Prestarted runtime did not become ready')),WARM_READY_MS);});
    try{await abortable(Promise.race([handle.ready,timeout]),signal);}
    catch(error){this.warm.fail(handle);if(signal.aborted)throw error;return null;}
    finally{clearTimeout(timer);}
    if(handle.failed){this.warm.fail(handle);return null;}
    return handle;
  }
  async chat(body,signal,context={}){
    // Compile BEFORE spawning a runtime or making a billable request.
    const validators=compileTools(body.tools);const credential=await this.auth.get();signal.throwIfAborted();
    const native=this.cfg.toolMode==='native'&&nativeSupported(body.tools),mode=native?'native':'json';
    const lease=await this.pool.acquire(body,credential,signal,{mode});const {record,metrics}=lease;
    const failureKey=digest({body,uid:credential.uid,domain:credential.domain,mode});
    for(const [key,f]of this.failures)if(Date.now()-f.at>120000)this.failures.delete(key);
    Object.assign(metrics,{toolMode:mode,attempts:[],firstTextMs:null,firstThinkingMs:null,firstModelEventMs:null,warmStart:false,runtimeReadyMs:null});
    let prompt=native?nativeInput(body,{messages:lease.messages,delta:lease.reused}):decisionInput(body,{messages:lease.messages,toolsReused:lease.toolsReused,delta:lease.reused});
    metrics.promptCharacters=prompt.length;metrics.fullPromptCharacters=(native?nativeInput(body):decisionInput(body)).length;
    metrics.charactersAvoided=Math.max(0,metrics.fullPromptCharacters-prompt.length);
    if(lease.replay)Object.assign(metrics,{historyMode:'replay',sentMessageCount:0,promptCharacters:0,charactersAvoided:0});
    const controller=new AbortController();const abort=()=>controller.abort(signal.reason);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    let runtimeStderr='',q;const start=performance.now();
    const id=lease.replay?.id??`chatcmpl-${randomUUID()}`,created=lease.replay?.created??Math.floor(Date.now()/1000),encoder=new TextEncoder();let closed=false;
    const stream=new ReadableStream({
      start:sink=>{
        const send=data=>{if(!closed)sink.enqueue(encoder.encode(`data: ${typeof data==='string'?data:JSON.stringify(data)}\n\n`));};
        const chunk=(delta,finish=null,usage=null)=>({id,created,model:body.model,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}],usage});
        void (async()=>{
          let output=new DecisionOutput(),usageRecorded=false,attemptPriorUsage=record.lastSdkUsage,attemptResumed=!!record.sessionId;const usages=[];let success=false,prewarmNext=false;
          const snapshotUsage=()=>{
            const current=usageRecorded?[]:[normalizedUsage({usage:output.usage(attemptPriorUsage,{resumed:attemptResumed})})];
            const usage=sumUsage([...usages,...current]);
            metrics.knownUsage=usage&&!usageRecorded?{...usage,bridge_usage_complete:false}:usage;
            return metrics.knownUsage;
          };
          try{
            send(chunk({role:'assistant',content:''}));
            const failure=this.failures.get(failureKey);
            if(failure){metrics.localReplay=true;send(chunk({},null,{...replayUsage(),bridge_usage_source:'local-rejection-replay'}));send(failure.body);return;}
            if(lease.replay){
              signal.throwIfAborted();this.metrics.replays++;
              for(const delta of lease.replay.deltas)send(chunk(delta));
              send(chunk({},lease.replay.finish,replayUsage()));send('[DONE]');success=true;return;
            }
            let decision,source,format,projector,gate,repairs;const rejected=new Set();
            const retryLimit=this.cfg.decisionRetries??2;
            const params=new Set(body.response_format?[]:(body.tools??[]).flatMap(t=>Object.keys(t.function?.parameters?.properties??{})));
            // Native text already shown by a rejected attempt; later attempts append to it.
            let carried='',unfinishedCorrected=false,warmFailed=false;
            for(let attempt=0;;attempt++){
              signal.throwIfAborted();usageRecorded=false;output=new DecisionOutput();
              attemptPriorUsage=record.lastSdkUsage;attemptResumed=!!record.sessionId;
              snapshotUsage();
              let initialized=false,chars=0;const attemptStart=performance.now();
              const needsTool=body.tool_choice==='required'||typeof body.tool_choice==='object';
              if(native)gate=new NativeTextGate(text=>send(chunk({content:text})),{enabled:!needsTool&&!carried,params});
              else projector=new FinalTextProjector(text=>send(chunk({content:text})),{enabled:!needsTool});
              const stderr=s=>{runtimeStderr=(runtimeStderr+s).slice(-3000);};
              const warm=attempt===0&&native&&!warmFailed?await this.takeWarm(record,body,credential,native,signal):null;
              this.metrics.started++;if(attempt)this.metrics.correctionCalls++;
              let relay=null;
              if(warm){
                q=warm.query;warm.setStderr(stderr);metrics.warmStart=true;
                relay=()=>warm.controller.abort(controller.signal.reason);controller.signal.addEventListener('abort',relay,{once:true});if(controller.signal.aborted)relay();
                warm.push(prompt);
              }else{
                const options=sdkOptions(this.cfg,credential,body,record.dir,controller,native?()=>{}:()=>{this.metrics.deniedTools++;},stderr,{native});
                options.persistSession=true;if(record.sessionId)options.resume=record.sessionId;
                q=this.run({prompt,options});
              }
              const calls=[],callIds=new Set(),texts=[];let stoppedAtCall=false,open=null;
              // The runtime emits an assistant message only for the first host call it stops at, so
              // every call is assembled from the stream. Parallel calls may share one block index.
              const closeCall=()=>{if(!open)return;let input;try{input=open.json.trim()?JSON.parse(open.json):{};}catch{input=undefined;}
                if(!callIds.has(open.id)){callIds.add(open.id);calls.push({id:open.id,name:open.name,input});}open=null;};
              try{
                for await(const m of q){
                  signal.throwIfAborted();if(m.isReplay)continue;
                  // After a denied host call the runtime reports only its own turn limit.
                  if(native&&calls.length&&m.type==='assistant'&&(m.message?.content??[]).every(b=>b.type==='text')&&RUNTIME_STOP.test((m.message?.content??[]).map(b=>b.text).join('').trim()))continue;
                  output.observe(m);
                  if(m.type==='assistant'||m.type==='result'||m.event?.usage||m.event?.message?.usage)snapshotUsage();
                  if(m.type==='system'&&m.subtype==='init'){
                    if(m.model!==body.model)throw new BridgeError(502,'model_mismatch','Official WorkBuddy runtime selected a different model');
                    const servers=m.mcp_servers??[],hosted=native&&hostTools(body).length>0;
                    if(m.plugins?.length||m.skills?.length||servers.some(s=>!hosted||s.name!==HOST))throw new BridgeError(502,'isolation_failed','Official runtime loaded external tools, plugins or skills');
                    if(hosted&&servers.find(s=>s.name===HOST)?.status!=='connected')throw new BridgeError(502,'native_tools_unavailable','Official runtime did not connect the host function server; set WORKBUDDY_TOOL_MODE=json to use the text protocol');
                    if(!initialized)metrics.runtimeReadyMs??=Math.round(performance.now()-attemptStart);
                    initialized=true;if(typeof m.session_id==='string')record.sessionId=m.session_id;
                  }
                  if(m.type==='assistant'){
                    if(m.message?.model!==body.model)throw new BridgeError(502,'model_mismatch','Official WorkBuddy response used a different model');
                    for(const b of m.message.content??[]){
                      if(b.type==='text'&&typeof b.text==='string')texts.push(b.text);
                      if(b.type!=='tool_use')continue;
                      if(!native||!String(b.name).startsWith(PREFIX))throw new BridgeError(502,'native_tool_blocked','Runtime attempted a native tool; no host action was returned');
                      // The runtime's parsed input is authoritative for a call it also streamed.
                      const known=calls.find(c=>c.id===b.id);if(known)known.input=b.input;else{callIds.add(b.id);calls.push({id:b.id,name:b.name,input:b.input});}
                    }
                  }
                  if(m.type==='result'&&typeof m.session_id==='string')record.sessionId=m.session_id;
                  if(m.type==='stream_event'){
                    const event=m.event;
                    if(event?.type==='content_block_start'&&event.content_block?.type==='tool_use'){
                      if(!(native&&String(event.content_block.name).startsWith(PREFIX)))throw new BridgeError(502,'native_tool_blocked','Runtime attempted a native tool');
                      closeCall();open={id:event.content_block.id,name:event.content_block.name,json:''};
                    }else if(open&&event?.delta?.type==='input_json_delta')open.json+=event.delta.partial_json??'';
                    else if(open&&['content_block_stop','message_delta','message_stop'].includes(event?.type))closeCall();
                    if(!initialized)throw new BridgeError(502,'sdk_incomplete','SDK streamed output before verifying runtime initialization');
                    if(event?.message?.model&&event.message.model!==body.model)throw new BridgeError(502,'model_mismatch','SDK streamed a different model');
                    const delta=event?.delta;
                    const visible=delta?.type==='text_delta'?delta.text:event?.type==='content_block_start'&&event.content_block?.type==='text'?event.content_block.text:null;
                    if(delta?.type==='thinking_delta'){
                      const now=performance.now()-start;metrics.firstModelEventMs??=now;metrics.firstThinkingMs??=now;
                      chars+=delta.thinking.length;send(chunk({reasoning_content:delta.thinking}));
                    }
                    if(visible){const now=performance.now()-start;metrics.firstModelEventMs??=now;metrics.firstTextMs??=now;chars+=visible.length;if(native)gate.push(visible);else projector.push(visible);}
                    if(chars>16*1024*1024)throw new BridgeError(502,'response_too_large','Official SDK response exceeds limit');
                  }
                }
              }catch(error){
                // A prestarted runtime that failed before initializing is replaced once, cold.
                if(warm&&!initialized&&!signal.aborted&&!(error instanceof BridgeError)){this.warm.fail(warm);warmFailed=true;metrics.warmStart=false;metrics.warmFailed=true;attempt--;continue;}
                // A native host call ends with the runtime's own stop after its denial; the call is complete.
                closeCall();if(error instanceof BridgeError||signal.aborted||!native||!calls.length)throw error;
                stoppedAtCall=true;
              }finally{if(relay)controller.signal.removeEventListener('abort',relay);}
              closeCall();
              const result=output.result;
              usages.push(normalizedUsage({usage:output.usage(attemptPriorUsage,{resumed:attemptResumed})}));usageRecorded=true;
              snapshotUsage();
              if(result?.usage)record.lastSdkUsage=result.usage;
              else if(stoppedAtCall)record.lastSdkUsage=addSdkUsage(attemptResumed?record.lastSdkUsage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},output.usage(attemptPriorUsage,{resumed:attemptResumed}));
              metrics.attempts.push({attempt:attempt+1,wallMs:performance.now()-attemptStart,usage:usages.at(-1),usageBasis:output.usageBasis,promptCharacters:prompt.length,...(warm?{warm:true}:{})});
              if(!(native&&calls.length&&initialized)&&(!initialized||!result||result.subtype!=='success'||result.is_error)){
                const message=(result?.errors??[]).join(' ');
                if(/11128|unapproved channel|conversation id missing/i.test(message))throw new BridgeError(400,'workbuddy_11128','WorkBuddy official runtime was rejected by channel validation (11128); no blind retry was performed');
                if(/401|authentication|12153/i.test(message))throw new BridgeError(401,'workbuddy_auth_rejected','WorkBuddy official runtime rejected the login; reopen WorkBuddy and retry');
                throw new BridgeError(502,'sdk_incomplete','Official WorkBuddy runtime did not return a successful terminal result');
              }
              if(result?.modelUsage&&Object.keys(result.modelUsage).some(model=>model!==body.model))throw new BridgeError(502,'model_mismatch','SDK usage reported another model');
              const text=native?gate.text||texts.join('')||String(result?.result??''):'';
              try{
                if(native){
                  decision=nativeDecision({calls,text,truncated:output.isTruncated()},body,validators,{allowUnfinished:unfinishedCorrected});
                  repairs=decision.repairs;source='native';format=decision.textCalls?'native-text':'native';
                }else{({decision,source,format,repairs}=output.decision(body,validators));projector.finish(decision);}
                metrics.attempts.at(-1).repairs=repairs;break;
              }
              catch(error){
                const fingerprint=native?digest({calls:calls.map(c=>[c.name,c.input]),text}):digest(output.candidates().map(c=>c.text));
                const lastAttempt=metrics.attempts.at(-1);
                lastAttempt.errorCode=error.code;
                lastAttempt.rejection={code:error.code,output:output.summary(),...(native?{nativeCalls:calls.length,textCharacters:text.length}:{}),
                  ...(error.decisionIssue?{tool:error.decisionIssue.tool,validationKeywords:error.decisionIssue.issues.map(i=>i.keyword)}:{})};
                lastAttempt.rejection.evidenceFile=await rejectedEvidence(this.cfg,{requestId:context.requestId??id,model:body.model,attempt:attempt+1,errorCode:error.code,output,credential});
                signal.throwIfAborted();
                const shown=native?gate.emitted>0:!!projector.emitted;
                const retry=!(!native&&shown)&&!!record.sessionId&&attempt<retryLimit&&!rejected.has(fingerprint)&&RETRYABLE.includes(error.code);
                // An announcement is still an answer: deliver it rather than fail when no retry remains.
                if(error.code==='unfinished_turn'&&!retry){decision={action:'final',content:text,repairs:[]};repairs=[];source='native';format='native';break;}
                if(!retry)throw error;
                rejected.add(fingerprint);if(error.code==='unfinished_turn')unfinishedCorrected=true;
                if(native&&shown)carried+=(carried?'\n\n':'')+gate.emittedText;
                const correction=native?nativeCorrection(body,error):correctionInput(body,error);
                metrics.attempts.at(-1).correction={promptCharacters:correction.prompt.length,schemaCharacters:correction.schemaCharacters,tools:correction.toolNames};
                prompt=correction.prompt;
                // Retries stay in the same native transcript, model, deadline and budget.
              }
            }
            const baseUsage=sumUsage(usages);
            const usage=baseUsage?{...baseUsage,bridge_decision_source:source,bridge_decision_format:format}:null;
            if(format==='dsml'||format==='native-text')this.metrics.decodedDsml++;
            if(repairs.length){this.metrics.localDecisionRepairs+=repairs.length;metrics.localDecisionRepairs=repairs;}
            const deltas=[];const message={role:'assistant',content:decision.content??null};
            if(native){
              // Whatever the host already displays stays the prefix of the recorded message.
              const shown=carried||gate.emittedText;let content=decision.content??'';
              if(carried)content=content?carried+'\n\n'+content:carried;
              else if(!content.startsWith(shown))content=shown+(content?'\n\n'+content:'');
              const tail=content.slice(shown.length);if(tail)send(chunk({content:tail}));
              if(content)deltas.push({content});message.content=content||null;
            }else if(decision.action==='final')deltas.push({content:decision.content});
            else if(decision.content){send(chunk({content:decision.content}));deltas.push({content:decision.content});}
            let echo=!native||!!decision.textCalls;
            if(decision.action==='tool_calls'){
              const used=new Set();
              // Native calls keep the runtime's IDs, so the host's results match the native transcript.
              const calls=decision.calls.map(call=>{
                let callId=native&&!decision.textCalls&&typeof call.id==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(call.id)&&!used.has(call.id)?call.id:null;
                if(!callId){callId=`call_${randomUUID().replaceAll('-','')}`;echo=true;}
                used.add(callId);return {id:callId,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}};
              });
              message.tool_calls=calls;
              calls.forEach((call,index)=>{
                const args=call.function.arguments;
                if(args.length<=32768){const delta={tool_calls:[{index,...call}]};send(chunk(delta));deltas.push(delta);return;}
                const first={tool_calls:[{index,id:call.id,type:'function',function:{name:call.function.name,arguments:''}}]};send(chunk(first));deltas.push(first);
                for(let at=0;at<args.length;){let end=Math.min(args.length,at+32768);if(end<args.length&&/[\uD800-\uDBFF]/.test(args[end-1]))end--;
                  const delta={tool_calls:[{index,function:{arguments:args.slice(at,end)}}]};send(chunk(delta));deltas.push(delta);at=end;}
              });
              if(native)this.metrics.hostCalls+=calls.length;
            }
            const finish=decision.action==='final'?'stop':'tool_calls';
            lease.commit({id,created,deltas,finish},message,{echo});
            if(metrics.attempts.length>1)this.metrics.recoveredRequests++;
            metrics.lastPromptTokens=usages.at(-1)?.prompt_tokens??null;
            metrics.outputTokensPerSecond=usage&&metrics.firstModelEventMs!==null?usage.completion_tokens/Math.max(.001,(performance.now()-start-metrics.firstModelEventMs)/1000):null;
            send(chunk({},finish,usage));send('[DONE]');success=true;prewarmNext=native&&finish==='tool_calls';
            this.metrics.completed++;this.metrics.lastFailure=null;
          }catch(error){
            const rawMessage=String(error?.message??'');
            if(!(error instanceof BridgeError)&&/11128|unapproved channel|conversation id missing/i.test(rawMessage))error=new BridgeError(400,'workbuddy_11128','Official WorkBuddy runtime was rejected by channel validation (11128); no blind retry was performed');
            const safe=publicError(signal.aborted?signal.reason:error);
            const redact=s=>redactSecrets(s,credential);
            const diagnostic=redact(rawMessage).split('\n')[0].slice(0,320);
            const evidenceFile=[...RETRYABLE,'output_budget'].includes(safe.body.error.code)?await decisionErrorEvidence(this.cfg,{requestId:context.requestId??id,model:body.model,errorCode:safe.body.error.code,output,credential}):null;
            this.metrics.lastFailure={at:new Date().toISOString(),code:safe.body.error.code,diagnostic,stderr:redact(runtimeStderr).slice(-800),output:output.summary(),evidenceFile};
            if(RETRYABLE.includes(safe.body.error.code)){
              if(this.failures.size>=32)this.failures.delete(this.failures.keys().next().value);
              this.failures.set(failureKey,{at:Date.now(),body:safe.body});
            }
            if(!usageRecorded){usages.push(normalizedUsage({usage:output.usage(attemptPriorUsage,{resumed:attemptResumed})}));metrics.attempts.push({attempt:usages.length,usage:usages.at(-1),usageBasis:output.usageBasis,errorCode:safe.body.error.code});}
            const usage=sumUsage(usages);
            metrics.knownUsage=usage;
            if(usage)send({id,created,model:body.model,object:'chat.completion.chunk',choices:[],usage});
            send(safe.body);
          }finally{
            controller.abort();signal.removeEventListener('abort',abort);
            if(!success||!record.sessionId)await lease.discard();lease.release();
            if(!closed){closed=true;sink.close();}
            if(prewarmNext)this.prewarm(record,body,credential,native);
          }
        })();
      },
      cancel:()=>{closed=true;controller.abort();q?.cleanup?.();q?.close?.();}
    });
    const response=new Response(stream,{headers:{'content-type':'text/event-stream'}});response.bridgeMetrics=metrics;return response;
  }
}
