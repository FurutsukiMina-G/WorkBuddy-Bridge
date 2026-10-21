import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {k as parseAuth,T as encrypted,dt as readKey,z as knownRegion} from '../vendor/workbuddy-connect-4.13.0.mjs';
import {BridgeError} from './errors.mjs';
const identity=c=>`${c.domain.toLowerCase()}:${c.uin||c.uid}`;
export class AuthManager {
  constructor({authFile,runtime,refresh,readLive,now=Date.now}){
    this.authFile=authFile;this.path=join(runtime,'auth-cache.json');this.runtime=runtime;this.refresh=refresh;this.now=now;
    this.readLive=readLive??(async()=>{const text=await readFile(authFile,'utf8');return parseAuth(text,authFile,encrypted(text)?await readKey():undefined);});
    this.cache=null;this.inflight=null;this.nextRefresh=0;this.state={state:'unknown',refreshes:0,recoveries:0};
  }
  async load(){
    let live;try{live=await this.readLive();}catch{/* A private refreshed copy can outlive a closed or updating desktop. */}
    if(!this.cache){try{this.cache=JSON.parse(await readFile(this.path,'utf8'));}catch{}}
    const valid=c=>c&&typeof c.accessToken==='string'&&c.accessToken&&typeof c.domain==='string'&&knownRegion(c.domain)==='cn'&&typeof c.uid==='string'&&c.uid&&Number.isFinite(c.expiresAtMs);
    if(!valid(this.cache))this.cache=null;
    if(!valid(live))live=null;
    // Follow the actual live sign-in. Never scan timestamped backups or rotate accounts.
    const previousDesktop=this.lastLiveToken??this.cache?.lastSeenDesktopToken;
    if(live&&(!this.cache||identity(live)!==identity(this.cache)||(live.lastRefreshAtMs??0)>(this.cache.lastRefreshAtMs??0)||previousDesktop&&live.accessToken!==previousDesktop))this.cache=live;
    if(live)this.lastLiveToken=live.accessToken;
    if(!this.cache)throw new BridgeError(503,'auth_unavailable','No readable WorkBuddy CN login; open WorkBuddy and sign in, then retry');
    return this.cache;
  }
  async get(){
    const c=await this.load();
    if(c.expiresAtMs-this.now()>600000){this.update(c,'ready');return c;}
    if(this.now()<this.nextRefresh&&c.expiresAtMs>this.now()+30000)return c;
    try{return await this.refreshOne(c);}catch(error){
      this.nextRefresh=this.now()+60000;this.state.state='refresh-degraded';
      if(c.expiresAtMs>this.now()+30000)return c;
      throw error;
    }
  }
  async recover(rejected){
    this.state.recoveries++;
    const c=await this.load();
    if(identity(c)!==identity(rejected))throw new BridgeError(401,'account_changed','WorkBuddy account changed during request; retry explicitly');
    if(c.accessToken!==rejected.accessToken&&c.expiresAtMs>this.now()+30000){this.update(c,'ready');return c;}
    // An upstream rejection overrides a future on-disk expiry. Refresh exactly once.
    return this.refreshOne(c);
  }
  refreshOne(c){
    this.inflight??=this.doRefresh(c).finally(()=>{this.inflight=null;});return this.inflight;
  }
  async doRefresh(c){
    if(!c.refreshToken)throw new BridgeError(401,'login_required','WorkBuddy login cannot refresh; sign in again in WorkBuddy');
    let result;try{result=await this.refresh(c);}catch{this.state.state='login-required';throw new BridgeError(401,'refresh_failed','WorkBuddy rejected or could not refresh the login; reopen WorkBuddy and retry');}
    if(!result.accessToken||!Number.isFinite(result.expiresInSec)||result.expiresInSec<=0)throw new BridgeError(502,'invalid_refresh','WorkBuddy refresh response is missing token expiry');
    const next={...c,...result,refreshToken:result.refreshToken??c.refreshToken,expiresAtMs:this.now()+result.expiresInSec*1000,lastRefreshAtMs:this.now(),lastSeenDesktopToken:this.lastLiveToken??c.lastSeenDesktopToken,source:'bridge'};
    if(knownRegion(next.domain)!=='cn')throw new BridgeError(401,'region_changed','WorkBuddy refresh changed region');
    await mkdir(this.runtime,{recursive:true});const temp=`${this.path}.${randomUUID()}.tmp`;
    // A failed durable write is an error, never a silently lost refreshed token.
    await writeFile(temp,JSON.stringify(next),{mode:0o600});
    for(let attempt=0;;attempt++){try{await rename(temp,this.path);break;}catch(e){if(!['EPERM','EBUSY','EACCES'].includes(e.code)||attempt===3)throw e;await new Promise(resolve=>setTimeout(resolve,50*2**attempt));}}
    this.cache=next;this.state.refreshes++;this.nextRefresh=0;this.update(next,'ready');return next;
  }
  update(c,state){this.state={...this.state,state,expiresAt:new Date(c.expiresAtMs).toISOString(),account:createHash('sha256').update(identity(c)).digest('hex').slice(0,12)};}
  status(){return {...this.state};}
}
