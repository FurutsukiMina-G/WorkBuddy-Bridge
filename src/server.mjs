import {createServer} from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Queue} from './queue.mjs';
import {modelsFor,prepareRequest,sseEvents,Completion} from './protocol.mjs';
import {BridgeError,publicError} from './errors.mjs';
import {abortable} from './context.mjs';
import {summarize} from './metrics.mjs';
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
function authorize(header,key){const token=/^Bearer (.+)$/i.exec(header??'')?.[1]??'';const a=Buffer.from(token),b=Buffer.from(key);return a.length===b.length&&timingSafeEqual(a,b);}
async function write(res,text,signal){signal.throwIfAborted();if(res.destroyed)throw new DOMException('Disconnected','AbortError');if(!res.write(text))await once(res,'drain',{signal});}
async function readBody(req,limit,signal){const chunks=[];let length=0;for await(const chunk of req){signal.throwIfAborted();length+=chunk.length;if(length>limit)throw new BridgeError(413,'body_too_large','Request body exceeds limit');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BridgeError(400,'invalid_json','Malformed JSON body');}}
export function createBridge({cfg,provider,key,instanceId,log}){
  const queue=new Queue(cfg.concurrency,cfg.queueLimit);const controllers=new Set();let shuttingDown=false;
  const stats={requests:0,completed:0,failed:0,cancelled:0,startedAt:new Date().toISOString()};
  const recent=[];
  const record=log??(async row=>{await mkdir(cfg.reports,{recursive:true});await appendFile(join(cfg.reports,'requests.ndjson'),JSON.stringify(row)+'\n');});
  const server=createServer((req,res)=>{handle(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:{code:'internal',message:'Bridge request failed'}});else res.destroy();});});
  server.headersTimeout=15000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=1000;
  async function handle(req,res){
    const started=Date.now(),requestId=randomUUID();res.setHeader('x-request-id',requestId);
    // No browser origins are needed by DSH. Reject browser requests and DNS rebinding.
    if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')||req.headers.origin){json(res,403,{error:{code:'origin_not_allowed',message:'Only direct loopback API clients are allowed'}});return;}
    if(!authorize(req.headers.authorization,key)){json(res,401,{error:{code:'unauthorized',message:'Local Bearer key required'}});return;}
    if(req.method==='GET'&&req.url==='/health'){
      json(res,200,{service:'workbuddy-bridge',version:cfg.version,instanceId,pid:process.pid,ready:!!provider.model&&!provider.lastError,active:queue.active,queued:queue.waiters.length,...stats,provider:provider.status()});return;
    }
    if(req.method==='GET'&&req.url==='/metrics'){json(res,200,{scope:'latest 1000 requests since worker start',...summarize(recent)});return;}
    if(req.method==='GET'&&req.url==='/v1/models'){
      try{const info=await provider.ready();json(res,200,{object:'list',data:modelsFor(info).map(m=>({...m,object:'model',created:0,owned_by:'workbuddy',upstream_id:info.id}))});}catch(e){const p=publicError(e);json(res,p.status,p.body);}return;
    }
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){json(res,404,{error:{code:'not_found',message:'Unknown route'}});return;}
    if(shuttingDown){json(res,503,{error:{code:'shutting_down',message:'Bridge is shutting down'}});return;}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')){json(res,415,{error:{code:'content_type',message:'Use application/json'}});return;}
    const controller=new AbortController();controllers.add(controller);
    const deadline=setTimeout(()=>controller.abort(new DOMException('Deadline exceeded','TimeoutError')),cfg.timeoutMs);deadline.unref();
    const disconnect=()=>{if(!res.writableEnded)controller.abort(new DOMException('Disconnected','AbortError'));};res.on('close',disconnect);req.on('aborted',disconnect);
    let release,heartbeat,completion,selected,upstream,outcome='failed',errorCode=null,firstEventMs=null,firstTextMs=null,firstThinkingMs=null,transportMetrics=null,queueMs=null,usageSent=false;
    stats.requests++;
    try{
      const body=await readBody(req,cfg.bodyLimit,controller.signal);
      const info=await abortable(provider.ready(),controller.signal);({selected,upstream}=prepareRequest(body,info));
      completion=new Completion(selected.id);
      const streaming=body.stream===true;
      if(streaming){res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.flushHeaders();heartbeat=setInterval(()=>{if(!res.destroyed&&res.writableLength<65536)res.write(': keepalive\n\n');},cfg.heartbeatMs);heartbeat.unref();}
      const queuedAt=Date.now();
      release=await queue.acquire(controller.signal);
      queueMs=Date.now()-queuedAt;
      const response=await provider.chat(upstream,controller.signal,{requestId});
      transportMetrics=response.bridgeMetrics??null;
      const pending=[];
      for await(const data of sseEvents(response.body,{signal:controller.signal})){
        const chunk=completion.accept(data,info.id);
        for(const choice of chunk?.choices??[]){
          if(choice.delta?.content){firstTextMs??=Date.now()-started;firstEventMs??=firstTextMs;}
          if(choice.delta?.reasoning_content){firstThinkingMs??=Date.now()-started;firstEventMs??=firstThinkingMs;}
          if(choice.delta?.tool_calls?.length)firstEventMs??=Date.now()-started;
        }
        if(completion.done)break;
        if(chunk&&streaming){
          // A tool may execute as soon as the host sees a terminal frame. Hold it
          // until both the final arguments and the upstream [DONE] are verified.
          if(completion.finish)pending.push(chunk);else{await write(res,`data: ${JSON.stringify(chunk)}\n\n`,controller.signal);if(chunk.usage)usageSent=true;}
        }
      }
      completion.validate(upstream.tools);
      if(streaming){for(const chunk of pending){await write(res,`data: ${JSON.stringify(chunk)}\n\n`,controller.signal);if(chunk.usage)usageSent=true;}await write(res,'data: [DONE]\n\n',controller.signal);res.end();}
      else json(res,200,completion.result());
      stats.completed++;outcome='completed';
    }catch(error){
      const reason=controller.signal.aborted?controller.signal.reason:error;const p=publicError(reason);errorCode=p.body.error.code;
      // Deadline cancellation stops SSE consumption before the transport can send
      // its error usage frame. Preserve its latest known official subtotal.
      const knownUsage=completion?.usage??transportMetrics?.knownUsage??null;
      if(completion&&!completion.usage&&knownUsage)completion.usage=knownUsage;
      if(errorCode==='cancelled'){stats.cancelled++;outcome='cancelled';}else stats.failed++;
      if(!res.destroyed&&!res.writableEnded){if(!res.headersSent)json(res,p.status,{...p.body,...(knownUsage?{usage:knownUsage}:{})});else{
        if(knownUsage&&!usageSent)res.write(`data: ${JSON.stringify({id:completion?.id,created:completion?.created,model:selected?.id,object:'chat.completion.chunk',choices:[],usage:knownUsage})}\n\n`);
        res.write(`data: ${JSON.stringify(p.body)}\n\n`);res.end();}}
    }finally{
      clearTimeout(deadline);clearInterval(heartbeat);res.removeListener('close',disconnect);req.removeListener('aborted',disconnect);controller.abort();controllers.delete(controller);release?.();
      const row={at:new Date().toISOString(),requestId,model:selected?.id??null,upstream:upstream?.model??null,outcome,errorCode,wallMs:Date.now()-started,
        firstEventMs,firstTextMs,firstThinkingMs,queueMs,usage:completion?.usage??null,context:transportMetrics,
        contextPressure:transportMetrics?.lastPromptTokens?{native:transportMetrics.lastPromptTokens/(provider.model?.contextWindow??1000000),selectedBudget:transportMetrics.lastPromptTokens/selected.contextWindow}:null};
      recent.push(row);if(recent.length>1000)recent.shift();await record(row).catch(()=>{});
    }
  }
  return {server,queue,stats,async close(){shuttingDown=true;for(const c of controllers)c.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await provider.close?.();}};
}
