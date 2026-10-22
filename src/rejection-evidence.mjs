import {mkdir,writeFile,readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const rejectedOwned=/^\d{13}-[0-9a-f-]{36}-attempt-\d+\.json$/;
const errorOwned=/^\d{13}-[0-9a-f-]{36}\.json$/;
export const redactSecrets=(text,credential)=>[credential?.accessToken,credential?.refreshToken].filter(v=>typeof v==='string'&&v).reduce((s,value)=>s.replaceAll(value,'[redacted]'),String(text));
async function writeBoundedEvidence(folder,name,owned,base,output,credential){
  try{
    await mkdir(folder,{recursive:true});
    let text=redactSecrets(JSON.stringify({...base,...output.evidence()}),credential);
    if(Buffer.byteLength(text)>1024*1024)text=redactSecrets(JSON.stringify({...base,limited:true,usage:(output.lastUsage!==undefined?output.lastUsage:output.usage())??null}),credential);
    const path=join(folder,name);
    await writeFile(path,text,{mode:0o600});
    const names=(await readdir(folder)).filter(n=>owned.test(n)).sort();
    const sizes=await Promise.all(names.map(async n=>({name:n,size:await stat(join(folder,n)).then(s=>s.size,()=>0)})));
    let bytes=sizes.reduce((n,f)=>n+f.size,0),count=sizes.length;
    for(const file of sizes){if(count<=32&&bytes<=8*1024*1024)break;if(file.name===name)continue;
      // Only single files matching this module's exact generated namespace.
      await rm(join(folder,file.name),{force:true}).catch(()=>{});bytes-=file.size;count--;}
    return path;
  }catch{return null;}
}
/** Bounded private MODEL OUTPUT evidence for rejected attempts, never host input. */
export async function rejectedEvidence(cfg,{requestId,model,attempt,errorCode,output,credential}){
  return writeBoundedEvidence(join(cfg.runtime,'rejected-decisions'),`${Date.now()}-${randomUUID()}-attempt-${attempt}.json`,rejectedOwned,{requestId,model,attempt,errorCode,summary:output.summary()},output,credential);
}
export async function decisionErrorEvidence(cfg,{requestId,model,errorCode,output,credential}){
  return writeBoundedEvidence(join(cfg.runtime,'decision-errors'),`${Date.now()}-${randomUUID()}.json`,errorOwned,{requestId,model,errorCode,summary:output.summary()},output,credential);
}
