import {BridgeError} from './errors.mjs';
export class Queue {
  constructor(limit,maxQueue){this.limit=limit;this.maxQueue=maxQueue;this.active=0;this.waiters=[];}
  async acquire(signal){
    signal.throwIfAborted();if(this.active<this.limit){this.active++;return ()=>this.release();}
    if(this.waiters.length>=this.maxQueue)throw new BridgeError(429,'queue_full','WorkBuddy bridge queue is full');
    return new Promise((resolve,reject)=>{const row={resolve,reject,signal};row.abort=()=>{this.waiters=this.waiters.filter(x=>x!==row);reject(signal.reason);};this.waiters.push(row);signal.addEventListener('abort',row.abort,{once:true});});
  }
  release(){const next=this.waiters.shift();if(next){next.signal.removeEventListener('abort',next.abort);next.resolve(()=>this.release());}else this.active--;}
}
