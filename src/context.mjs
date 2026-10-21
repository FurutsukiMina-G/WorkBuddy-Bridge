import {createHash,randomUUID} from 'node:crypto';
import {mkdir,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {BridgeError} from './errors.mjs';

export function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])]));
  return value;
}
export const digest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function textContent(content){
  if(content==null)return '';
  if(typeof content==='string')return content;
  if(Array.isArray(content)&&content.every(p=>p?.type==='text'&&typeof p.text==='string'))return content.map(p=>p.text).join('\n');
  throw new BridgeError(400,'unsupported_content','Only text message content is supported');
}
export function semanticMessages(messages){return messages.map(m=>({role:m.role,content:textContent(m.content),
  ...(m.name!==undefined?{name:m.name}:{}),...(m.tool_call_id!==undefined?{tool_call_id:m.tool_call_id}:{}),
  ...(m.tool_calls!==undefined?{tool_calls:Array.isArray(m.tool_calls)?m.tool_calls.map(call=>{
    const args=call?.function?.arguments;if(typeof args!=='string')return call;
    try{return {...call,function:{...call.function,arguments:JSON.stringify(stable(JSON.parse(args)))}};}catch{return call;}
  }):m.tool_calls}:{}),
}));}
export async function abortable(promise,signal){
  signal.throwIfAborted();let abort;
  try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
  finally{signal.removeEventListener('abort',abort);}
}
/** Resume transcripts, never authenticated idle processes. Store hashes of host history. */
export class ContextPool {
  constructor(cfg){this.cfg=cfg;this.records=new Map();this.clients=new Map();this.tools=new Map();this.locks=new Map();this.pendingCleanup=new Set();this.closed=false;
    this.cleanup=this.sweepOrphans();this.timer=setInterval(()=>{void this.sweep();void this.sweepOrphans();},60000);this.timer.unref();}
  async sweepOrphans(){
    const parent=join(this.cfg.runtime,'sdk');const entries=await readdir(parent,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries){
      if(!entry.isDirectory()||!/^[-0-9a-f]{36}$/.test(entry.name)||this.records.has(entry.name))continue;
      const dir=join(parent,entry.name);let owner;try{owner=JSON.parse(await readFile(join(dir,'.bridge-owner.json'),'utf8'));}catch{continue;}
      if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)continue;
      try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')await this.remove({id:entry.name,dir});}
    }
  }
  stats(){return {sessions:this.records.size,locks:this.locks.size,mode:'sdk-resume',idleMs:this.cfg.sessionIdleMs??3600000,maxSessions:this.cfg.maxSessions??8};}
  async remove(record){
    this.records.delete(record.id);for(const map of [this.clients,this.tools])for(const [k,v]of map)if(v===record.id)map.delete(k);
    const parent=resolve(this.cfg.runtime,'sdk'),inside=relative(parent,resolve(record.dir));
    if(!inside||inside.startsWith('..')||isAbsolute(inside))return;
    const clean=()=>rm(record.dir,{recursive:true,force:true}).catch(()=>{});
    await clean();const timer=setTimeout(()=>{this.pendingCleanup.delete(timer);void clean();},10000);timer.unref();this.pendingCleanup.add(timer);
  }
  async sweep(){for(const r of this.records.values())if(!r.busy&&Date.now()-r.touched>(this.cfg.sessionIdleMs??3600000))await this.remove(r);}
  async acquire(body,credential,signal){
    await this.cleanup;
    if(this.closed)throw new BridgeError(503,'shutting_down','Context pool closed');
    const scope=digest({model:body.model,publicModel:body.bridge_public_model,effort:body.reasoning_effort,max:body.max_tokens,uid:credential.uid,domain:credential.domain});
    const messages=semanticMessages(body.messages),hashes=messages.map(digest),requestHash=digest({...body,messages,stream:undefined,stream_options:undefined});
    const client=body.prompt_cache_key?scope+':'+digest(body.prompt_cache_key):null;
    let owner=client?this.clients.get(client):undefined;
    if(!client)for(const m of [...messages].reverse()){
      const ids=[m.tool_call_id,...(m.tool_calls??[]).map(c=>c.id)].filter(Boolean);
      owner=ids.map(id=>this.tools.get(scope+':'+id)).find(Boolean);if(owner)break;
    }
    const lockKey=client??this.records.get(owner)?.lockKey??randomUUID();const prior=this.locks.get(lockKey)??Promise.resolve();let unlock;
    const gate=new Promise(r=>{unlock=r;});const tail=prior.then(()=>gate);this.locks.set(lockKey,tail);
    let owns=false,record;
    const release=()=>{if(record){record.busy=false;record.touched=Date.now();}unlock();if(this.locks.get(lockKey)===tail)this.locks.delete(lockKey);};
    try{
      await abortable(prior,signal);owns=true;signal.throwIfAborted();
      if(this.closed)throw new BridgeError(503,'shutting_down','Context pool closed');
      if(client)owner=this.clients.get(client);
      record=this.records.get(owner);let reset=null;
      if(record){
        const same=record.requestHash===requestHash;
        const prefix=record.history.length<=hashes.length&&record.history.every((h,i)=>h===hashes[i]);
        if(record.scope!==scope||(!same&&!prefix)||Date.now()-record.touched>(this.cfg.sessionIdleMs??3600000)){
          let at=0;while(at<Math.min(record.history.length,hashes.length)&&record.history[at]===hashes[at])at++;
          reset={reason:hashes.length<record.history.length?'history_shortened':'history_rewritten',firstChangedIndex:at,previousMessages:record.history.length,currentMessages:hashes.length,previousHash:record.history[at]??null,currentHash:hashes[at]??null};
          await this.remove(record);record=null;
        }else if(!record.sessionId&&!same){await this.remove(record);record=null;reset={reason:'sdk_session_id_unavailable'};}
      }
      if(!record){
        await this.sweep();
        while(this.records.size>=(this.cfg.maxSessions??8)){
          const idle=[...this.records.values()].filter(r=>!r.busy).sort((a,b)=>a.touched-b.touched)[0];
          if(!idle)throw new BridgeError(429,'sessions_busy','All context slots are active');await this.remove(idle);
        }
        const id=randomUUID();record={id,scope,lockKey,dir:join(this.cfg.runtime,'sdk',id),sessionId:null,history:[],toolSignature:null,touched:Date.now(),busy:true};
        this.records.set(id,record);
        try{await mkdir(record.dir,{recursive:true});await writeFile(join(record.dir,'.bridge-owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}
        catch(error){await this.remove(record);throw error;}
        if(client)this.clients.set(client,id);
      }
      record.busy=true;
      const replay=record.requestHash===requestHash&&record.response&&Date.now()-record.completedAt<(this.cfg.replayMs??120000);
      const reused=!!record.sessionId&&!replay;
      // The last validated assistant decision is already in the native transcript.
      // Only its host-assigned tool IDs need an acknowledgement, never its large arguments.
      const delta=reused?messages.slice(record.history.length):messages;
      let echo=null,echoCharactersAvoided=0;
      if(reused&&record.message?.tool_calls?.length){
        echo={role:'assistant',prior_decision_calls:record.message.tool_calls.map(c=>({id:c.id,name:c.function.name,arguments_sha256:digest(c.function.arguments)})),content:'Host assigned these IDs to your preceding validated decision; arguments are unchanged. Only the following tool results describe execution.'};
        echoCharactersAvoided=JSON.stringify(record.message).length;
        if(JSON.stringify(echo).length<echoCharactersAvoided)echoCharactersAvoided-=JSON.stringify(echo).length;
        else{echo=record.message;echoCharactersAvoided=0;}
      }
      const toolSignature=digest(body.tools??[]),toolsReused=reused&&record.toolSignature===toolSignature;
      return {record,messages:echo?[echo,...delta]:delta,replay:replay?record.response:null,reused,toolsReused,
        metrics:{historyMode:reused?'delta':'full',sentMessageCount:delta.length,toolsReused,echoCharactersAvoided,reset,localReplay:!!replay},
        commit:(response,message)=>{
          record.requestHash=requestHash;record.response=response;record.message=message;record.completedAt=Date.now();record.toolSignature=toolSignature;
          record.history=[...hashes,digest(semanticMessages([message])[0])];
          for(const c of message.tool_calls??[])this.tools.set(scope+':'+c.id,record.id);
        },release,discard:()=>this.remove(record)};
    }catch(e){if(owns)release();else void prior.then(release);throw e;}
  }
  async close(){this.closed=true;clearInterval(this.timer);for(const r of [...this.records.values()])if(!r.busy)await this.remove(r);}
}
