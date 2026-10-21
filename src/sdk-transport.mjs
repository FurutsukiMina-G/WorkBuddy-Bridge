import {query} from '@tencent-ai/agent-sdk';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {DECISION_INSTRUCTIONS,decisionInput,compileTools} from './decision.mjs';
import {DecisionOutput} from './decision-output.mjs';
import {BridgeError,publicError} from './errors.mjs';
import {runtimePath} from './contain.mjs';
import {ContextPool,digest} from './context.mjs';
import {FinalTextProjector} from './streaming.mjs';
import {normalizedUsage,sumUsage,replayUsage} from './usage.mjs';
import {correctionInput} from './recovery.mjs';
import {rejectedEvidence} from './rejection-evidence.mjs';
export {normalizedUsage} from './usage.mjs';
// Explicit denies complement tools:[] on WorkBuddy builds that still enumerate
// their entire tool registry in the init event. The hook covers newly added tools.
const DENIED_TOOLS=['Agent','Read','Write','Edit','Bash','Glob','Grep','PowerShell','EnterPlanMode','ExitPlanMode','TaskCreate','TaskGet','TaskUpdate','TaskList','WebFetch','WebSearch','TaskStop','TaskOutput','Skill','AskUserQuestion','StructuredOutput','ToolSearch','DeferExecuteTool','SendMessage','TeamCreate','TeamDelete','ImageGen','LibraryUpload','VideoGen','AudioTranscribe','A2AGetAgentCard','A2ASendMessage','A2AGetTask','A2ACancelTask','ListMcpResources','ReadMcpResource','MessageColleague','SpeakInChannel','ChannelTasks','CreateColleague','CreateChannel','ListColleagues'];
export function sdkOptions(cfg,credential,body,dir,controller,onDenied,onStderr=()=>{}){
  const cli=runtimePath(cfg);
  if(!existsSync(cli))throw new BridgeError(503,'runtime_missing','WorkBuddy runtime missing; set WORKBUDDY_CLI to its official codebuddy-lite-wb.mjs');
  const env={...process.env,CODEBUDDY_AUTH_TOKEN:credential.accessToken,CODEBUDDY_BASE_URL:'https://copilot.tencent.com/v2',ACC_USER_ID:credential.uid,
    CODEBUDDY_CUSTOM_HEADERS:`X-Domain: ${credential.domain}`,CODEBUDDY_CONFIG_DIR:join(dir,'home'),WORKBUDDY_CONFIG_DIR:join(dir,'home'),
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS:'1',CODEBUDDY_DISABLE_AUTO_MEMORY:'1',CODEBUDDY_DISABLE_CRON:'1',DISABLE_TELEMETRY:'1',
    CODEBUDDY_CODE_MAX_OUTPUT_TOKENS:String(body.max_tokens),CODEBUDDY_API_KEY:undefined,CODEBUDDY_API_KEY_HELPER_DISABLED:'1',
    ACC_PRODUCT_CONFIG:undefined,ACC_PRODUCT_CONFIG_V2:undefined,ACC_PRODUCT_CONFIG_V3:undefined,ACC_PRODUCT_CONFIG_PATH:undefined,WORKBUDDY_BRIDGE_ACTUAL_CLI:cli};
  return {model:body.model,cwd:dir,tools:[],disallowedTools:DENIED_TOOLS,settingSources:[],strictMcpConfig:true,mcpServers:{},agents:{},
    canUseTool:async()=>{onDenied();return {behavior:'deny',message:'Only the external host can execute tools'};},
    hooks:{PreToolUse:[{hooks:[async()=>{onDenied();return {continue:false,stopReason:'Only the external host executes tools',hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Host-owned tools'}};}]}]},
    systemPrompt:{append:DECISION_INSTRUCTIONS},maxTurns:1,includePartialMessages:true,persistSession:false,effort:body.reasoning_effort,
    abortController:controller,pathToCodebuddyCode:join(cfg.root??resolve(import.meta.dirname,'..'),'scripts/runtime-launcher.mjs'),executable:process.execPath,env,stderr:onStderr};
}
export class SdkTransport {
  constructor(cfg,auth,{run=query}={}){
    this.cfg=cfg;this.auth=auth;this.run=run;this.pool=new ContextPool(cfg);this.failures=new Map();
    this.metrics={started:0,completed:0,deniedTools:0,decodedDsml:0,replays:0,correctionCalls:0,recoveredRequests:0,localDecisionRepairs:0,lastFailure:null};
  }
  async close(){await this.pool.close();}
  async chat(body,signal,context={}){
    // Compile BEFORE spawning a runtime or making a billable request.
    const validators=compileTools(body.tools);const credential=await this.auth.get();signal.throwIfAborted();
    const lease=await this.pool.acquire(body,credential,signal);const {record,metrics}=lease;
    const failureKey=digest({body,uid:credential.uid,domain:credential.domain});
    for(const [key,f]of this.failures)if(Date.now()-f.at>120000)this.failures.delete(key);
    Object.assign(metrics,{attempts:[],firstTextMs:null,firstThinkingMs:null,firstModelEventMs:null});
    let prompt=decisionInput(body,{messages:lease.messages,toolsReused:lease.toolsReused,delta:lease.reused});
    metrics.promptCharacters=prompt.length;metrics.fullPromptCharacters=decisionInput(body).length;
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
          let output=new DecisionOutput(),usageRecorded=false,attemptPriorUsage=record.lastSdkUsage,attemptResumed=!!record.sessionId;const usages=[];let success=false;
          try{
            send(chunk({role:'assistant',content:''}));
            const failure=this.failures.get(failureKey);
            if(failure){metrics.localReplay=true;send(chunk({},null,{...replayUsage(),bridge_usage_source:'local-rejection-replay'}));send(failure.body);return;}
            if(lease.replay){
              signal.throwIfAborted();this.metrics.replays++;
              for(const delta of lease.replay.deltas)send(chunk(delta));
              send(chunk({},lease.replay.finish,replayUsage()));send('[DONE]');success=true;return;
            }
            let decision,source,format,projector,repairs;const rejected=new Set();
            const retryLimit=this.cfg.decisionRetries??2;
            for(let attempt=0;;attempt++){
              signal.throwIfAborted();usageRecorded=false;output=new DecisionOutput();
              attemptPriorUsage=record.lastSdkUsage;attemptResumed=!!record.sessionId;
              let initialized=false,chars=0;const attemptStart=performance.now();
              const needsTool=body.tool_choice==='required'||typeof body.tool_choice==='object';
              projector=new FinalTextProjector(text=>send(chunk({content:text})),{enabled:!needsTool});
              const options=sdkOptions(this.cfg,credential,body,record.dir,controller,()=>{this.metrics.deniedTools++;},s=>{runtimeStderr=(runtimeStderr+s).slice(-3000);});
              options.persistSession=true;if(record.sessionId)options.resume=record.sessionId;
              this.metrics.started++;if(attempt)this.metrics.correctionCalls++;
              q=this.run({prompt,options});
              for await(const m of q){
                signal.throwIfAborted();if(m.isReplay)continue;
                output.observe(m);
                if(m.type==='system'&&m.subtype==='init'){
                  if(m.model!==body.model)throw new BridgeError(502,'model_mismatch','Official WorkBuddy runtime selected a different model');
                  if(m.mcp_servers?.length||m.plugins?.length||m.skills?.length)throw new BridgeError(502,'isolation_failed','Official runtime loaded external tools, plugins or skills');
                  initialized=true;if(typeof m.session_id==='string')record.sessionId=m.session_id;
                }
                if(m.type==='assistant'){
                  if(m.message?.model!==body.model)throw new BridgeError(502,'model_mismatch','Official WorkBuddy response used a different model');
                  if(m.message.content?.some(b=>b.type==='tool_use'))throw new BridgeError(502,'native_tool_blocked','Runtime attempted a native tool; no host action was returned');
                }
                if(m.type==='result'&&typeof m.session_id==='string')record.sessionId=m.session_id;
                if(m.type==='stream_event'){
                  const event=m.event;if(event?.type==='content_block_start'&&event.content_block?.type==='tool_use')throw new BridgeError(502,'native_tool_blocked','Runtime attempted a native tool');
                  if(!initialized)throw new BridgeError(502,'sdk_incomplete','SDK streamed output before verifying runtime initialization');
                  if(event?.message?.model&&event.message.model!==body.model)throw new BridgeError(502,'model_mismatch','SDK streamed a different model');
                  const delta=event?.delta;
                  const visible=delta?.type==='text_delta'?delta.text:event?.type==='content_block_start'&&event.content_block?.type==='text'?event.content_block.text:null;
                  if(delta?.type==='thinking_delta'){
                    const now=performance.now()-start;metrics.firstModelEventMs??=now;metrics.firstThinkingMs??=now;
                    chars+=delta.thinking.length;send(chunk({reasoning_content:delta.thinking}));
                  }
                  if(visible){const now=performance.now()-start;metrics.firstModelEventMs??=now;metrics.firstTextMs??=now;chars+=visible.length;projector.push(visible);}
                  if(chars>16*1024*1024)throw new BridgeError(502,'response_too_large','Official SDK response exceeds limit');
                }
              }
              const result=output.result;
              usages.push(normalizedUsage({usage:output.usage(attemptPriorUsage,{resumed:attemptResumed})}));usageRecorded=true;
              if(result?.usage)record.lastSdkUsage=result.usage;
              metrics.attempts.push({attempt:attempt+1,wallMs:performance.now()-attemptStart,usage:usages.at(-1),usageBasis:output.usageBasis,promptCharacters:prompt.length});
              if(!initialized||!result||result.subtype!=='success'||result.is_error){
                const message=(result?.errors??[]).join(' ');
                if(/11128|unapproved channel|conversation id missing/i.test(message))throw new BridgeError(400,'workbuddy_11128','WorkBuddy official runtime was rejected by channel validation (11128); no blind retry was performed');
                if(/401|authentication|12153/i.test(message))throw new BridgeError(401,'workbuddy_auth_rejected','WorkBuddy official runtime rejected the login; reopen WorkBuddy and retry');
                throw new BridgeError(502,'sdk_incomplete','Official WorkBuddy runtime did not return a successful terminal result');
              }
              if(result.modelUsage&&Object.keys(result.modelUsage).some(model=>model!==body.model))throw new BridgeError(502,'model_mismatch','SDK usage reported another model');
              try{({decision,source,format,repairs}=output.decision(body,validators));projector.finish(decision);metrics.attempts.at(-1).repairs=repairs;break;}
              catch(error){
                const fingerprint=digest(output.candidates().map(c=>c.text));
                const lastAttempt=metrics.attempts.at(-1);
                lastAttempt.errorCode=error.code;
                lastAttempt.rejection={code:error.code,output:output.summary(),
                  ...(error.decisionIssue?{tool:error.decisionIssue.tool,validationKeywords:error.decisionIssue.issues.map(i=>i.keyword)}:{})};
                lastAttempt.rejection.evidenceFile=await rejectedEvidence(this.cfg,{requestId:context.requestId??id,model:body.model,attempt:attempt+1,errorCode:error.code,output,credential});
                signal.throwIfAborted();
                if(projector.emitted||!record.sessionId||attempt>=retryLimit||rejected.has(fingerprint)||
                  !['invalid_decision','invalid_tool_arguments','required_tool_missing','tools_disabled','wrong_pinned_tool','ambiguous_decision'].includes(error.code))throw error;
                rejected.add(fingerprint);
                const correction=correctionInput(body,error);
                metrics.attempts.at(-1).correction={promptCharacters:correction.prompt.length,schemaCharacters:correction.schemaCharacters,tools:correction.toolNames};
                prompt=correction.prompt;
                // Retries stay in the same native transcript, model, deadline and budget.
              }
            }
            const baseUsage=sumUsage(usages);
            const usage=baseUsage?{...baseUsage,bridge_decision_source:source,bridge_decision_format:format}:null;
            if(format==='dsml')this.metrics.decodedDsml++;
            if(repairs.length){this.metrics.localDecisionRepairs+=repairs.length;metrics.localDecisionRepairs=repairs;}
            const deltas=[];const message={role:'assistant',content:decision.content??null};
            if(decision.action==='final')deltas.push({content:decision.content});
            else{
              if(decision.content){send(chunk({content:decision.content}));deltas.push({content:decision.content});}
              const calls=decision.calls.map(call=>({id:`call_${randomUUID().replaceAll('-','')}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
              message.tool_calls=calls;
              calls.forEach((call,index)=>{
                const args=call.function.arguments;
                if(args.length<=32768){const delta={tool_calls:[{index,...call}]};send(chunk(delta));deltas.push(delta);return;}
                const first={tool_calls:[{index,id:call.id,type:'function',function:{name:call.function.name,arguments:''}}]};send(chunk(first));deltas.push(first);
                for(let at=0;at<args.length;){let end=Math.min(args.length,at+32768);if(end<args.length&&/[\uD800-\uDBFF]/.test(args[end-1]))end--;
                  const delta={tool_calls:[{index,function:{arguments:args.slice(at,end)}}]};send(chunk(delta));deltas.push(delta);at=end;}
              });
            }
            const finish=decision.action==='final'?'stop':'tool_calls';
            lease.commit({id,created,deltas,finish},message);
            if(metrics.attempts.length>1)this.metrics.recoveredRequests++;
            metrics.lastPromptTokens=usages.at(-1)?.prompt_tokens??null;
            metrics.outputTokensPerSecond=usage&&metrics.firstModelEventMs!==null?usage.completion_tokens/Math.max(.001,(performance.now()-start-metrics.firstModelEventMs)/1000):null;
            send(chunk({},finish,usage));send('[DONE]');success=true;
            this.metrics.completed++;this.metrics.lastFailure=null;
          }catch(error){
            const rawMessage=String(error?.message??'');
            if(!(error instanceof BridgeError)&&/11128|unapproved channel|conversation id missing/i.test(rawMessage))error=new BridgeError(400,'workbuddy_11128','Official WorkBuddy runtime was rejected by channel validation (11128); no blind retry was performed');
            const safe=publicError(signal.aborted?signal.reason:error);
            const redact=s=>String(s).replaceAll(credential.accessToken,'[redacted]').replaceAll(credential.refreshToken||'__NO_REFRESH_TOKEN__','[redacted]');
            const diagnostic=redact(rawMessage).split('\n')[0].slice(0,320);let evidenceFile=null;
            if(['invalid_decision','invalid_tool_arguments','required_tool_missing','tools_disabled','wrong_pinned_tool','ambiguous_decision','output_budget'].includes(safe.body.error.code)){
              try{
                const folder=join(this.cfg.runtime,'decision-errors');await mkdir(folder,{recursive:true});
                evidenceFile=join(folder,`${Date.now()}-${randomUUID()}.json`);
                await writeFile(evidenceFile,redact(JSON.stringify({requestId:context.requestId??id,model:body.model,errorCode:safe.body.error.code,...output.evidence()},null,2)),{mode:0o600});
              }catch{evidenceFile=null;}
            }
            this.metrics.lastFailure={at:new Date().toISOString(),code:safe.body.error.code,diagnostic,stderr:redact(runtimeStderr).slice(-800),output:output.summary(),evidenceFile};
            if(['invalid_decision','invalid_tool_arguments','required_tool_missing','tools_disabled','wrong_pinned_tool','ambiguous_decision'].includes(safe.body.error.code)){
              if(this.failures.size>=32)this.failures.delete(this.failures.keys().next().value);
              this.failures.set(failureKey,{at:Date.now(),body:safe.body});
            }
            if(!usageRecorded){usages.push(normalizedUsage({usage:output.usage(attemptPriorUsage,{resumed:attemptResumed})}));metrics.attempts.push({attempt:usages.length,usage:usages.at(-1),usageBasis:output.usageBasis,errorCode:safe.body.error.code});}
            const usage=sumUsage(usages);
            if(usage)send({id,created,model:body.model,object:'chat.completion.chunk',choices:[],usage});
            send(safe.body);
          }finally{
            controller.abort();signal.removeEventListener('abort',abort);
            if(!success||!record.sessionId)await lease.discard();lease.release();
            if(!closed){closed=true;sink.close();}
          }
        })();
      },
      cancel:()=>{closed=true;controller.abort();q?.close?.();}
    });
    const response=new Response(stream,{headers:{'content-type':'text/event-stream'}});response.bridgeMetrics=metrics;return response;
  }
}
