import {F as Client} from '../vendor/workbuddy-connect-4.13.0.mjs';
import {AuthManager} from './auth.mjs';
import {BridgeError} from './errors.mjs';
import {SdkTransport} from './sdk-transport.mjs';
export class Provider {
  constructor(cfg,{client=new Client(),auth}={}){
    this.cfg=cfg;this.client=client;this.auth=auth??new AuthManager({...cfg,refresh:c=>client.refreshToken(c)});
    this.model=null;this.catalogAt=0;this.catalogFlight=null;this.lastError=null;this.transport=new SdkTransport(cfg,this.auth);
  }
  async ready(){
    if(this.model&&Date.now()-this.catalogAt<300000)return this.model;
    this.catalogFlight??=this.discover().finally(()=>{this.catalogFlight=null;});return this.catalogFlight;
  }
  async discover(){
    const credential=await this.auth.get();let models;
    try{models=await this.client.fetchModels(credential,AbortSignal.timeout(20000));}
    catch{throw new BridgeError(503,'catalog_unavailable','Cannot verify the live WorkBuddy model catalog; retry later');}
    const selected=models.find(m=>m.id===this.cfg.upstreamModel);
    if(!selected||!/^deepseek-v[0-9.]+-flash$/.test(selected.id)||!/deepseek.*flash/i.test(selected.name)||selected.supportsToolCall!==true)
      throw new BridgeError(503,'model_unverified','Configured model is not a verified native-tool DeepSeek Flash in the live WorkBuddy catalog');
    this.model=selected;this.catalogAt=Date.now();this.lastError=null;return selected;
  }
  async chat(body,signal,context){
    await this.ready();signal.throwIfAborted();return this.transport.chat(body,signal,context);
  }
  async close(){await this.transport.close();}
  status(){return {transport:'official-workbuddy-sdk',verifiedModel:this.model?.id??null,catalogAt:this.catalogAt?new Date(this.catalogAt).toISOString():null,auth:this.auth.status(),lastError:this.lastError,sdk:{...this.transport.metrics},context:this.transport.pool.stats()};}
}
