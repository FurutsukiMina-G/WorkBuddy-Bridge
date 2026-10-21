import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {config} from './config.mjs';
import {Provider} from './provider.mjs';
import {createBridge} from './server.mjs';
import {publicError} from './errors.mjs';
import {containChildren} from './contain.mjs';
const cfg=config();await mkdir(cfg.runtime,{recursive:true});
containChildren(cfg);
async function secret(name,generate){const path=join(cfg.runtime,name);try{return (await readFile(path,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;const value=generate();try{await writeFile(path,value,{flag:'wx',mode:0o600});return value;}catch(e){if(e.code==='EEXIST')return (await readFile(path,'utf8')).trim();throw e;}}}
const key=await secret('bridge-key',()=>randomBytes(32).toString('base64url'));
if(key.length<32)throw new Error('Invalid local bridge key');
const instanceId=await secret('instance-id',randomUUID);
const provider=new Provider(cfg);const bridge=createBridge({cfg,provider,key,instanceId});
bridge.server.on('error',error=>{console.error(JSON.stringify({event:'listener_failed',code:error.code}));process.exit(error.code==='EADDRINUSE'?78:1);});
await new Promise(resolve=>bridge.server.listen(cfg.port,'127.0.0.1',resolve));
await writeFile(join(cfg.runtime,'worker.pid'),String(process.pid));
console.log(JSON.stringify({event:'listening',service:'workbuddy-bridge',port:cfg.port,pid:process.pid,instanceId}));
let maintaining=false;
async function maintain(){if(maintaining)return;maintaining=true;try{await provider.auth.get();await provider.ready();provider.lastError=null;}catch(e){provider.lastError=publicError(e).body.error.code;}finally{maintaining=false;}}
void maintain();const timer=setInterval(()=>void maintain(),60000);timer.unref();
let closing=false;async function close(){if(closing)return;closing=true;clearInterval(timer);await bridge.close();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
