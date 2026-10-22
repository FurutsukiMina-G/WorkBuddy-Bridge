/** A prompt source the SDK can start on before the host's next turn exists. */
export function promptQueue(){
  let resolve;const next=new Promise(r=>{resolve=r;});
  return {iterable:{async *[Symbol.asyncIterator](){const message=await next;if(message)yield message;}},push:message=>resolve(message),end:()=>resolve(null)};
}
export const userMessage=text=>({type:'user',session_id:'',message:{role:'user',content:text},parent_tool_use_id:null});
/** At most one pre-started runtime per context record. It boots while the host executes
 * the tool calls of the previous turn, and is used only by an exactly matching next turn. */
export class WarmRuntimes {
  constructor({ttlMs=120000,max=4}={}){this.ttlMs=ttlMs;this.max=max;this.entries=new Map();this.stats={started:0,used:0,discarded:0,expired:0};}
  get size(){return this.entries.size;}
  start(key,fingerprint,create){
    this.discard(key);
    if(!this.ttlMs||!this.max||this.entries.size>=this.max)return false;
    let handle;try{handle=create();}catch{return false;}
    const timer=setTimeout(()=>{if(this.entries.get(key)?.handle===handle){this.stats.expired++;this.discard(key);}},this.ttlMs);timer.unref?.();
    this.entries.set(key,{fingerprint,handle,timer});this.stats.started++;return true;
  }
  /** Hand over the runtime only if every option it was started with still applies. */
  take(key,fingerprint){
    const entry=this.entries.get(key);if(!entry)return null;
    this.entries.delete(key);clearTimeout(entry.timer);
    if(entry.fingerprint!==fingerprint||entry.handle.failed){this.stats.discarded++;entry.handle.close();return null;}
    this.stats.used++;return entry.handle;
  }
  discard(key){const entry=this.entries.get(key);if(!entry)return;this.entries.delete(key);clearTimeout(entry.timer);entry.handle.close();}
  close(){for(const key of [...this.entries.keys()])this.discard(key);}
}
