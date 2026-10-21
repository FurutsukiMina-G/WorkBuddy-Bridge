import {mkdir,writeFile,readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const owned=/^\d{13}-[0-9a-f-]{36}-attempt-\d+\.json$/;
/** Bounded private MODEL OUTPUT evidence for rejected attempts, never host input. */
export async function rejectedEvidence(cfg,{requestId,model,attempt,errorCode,output,credential}){
  try{
    const folder=join(cfg.runtime,'rejected-decisions');await mkdir(folder,{recursive:true});
    const redact=text=>[credential.accessToken,credential.refreshToken].filter(v=>typeof v==='string'&&v).reduce((s,value)=>s.replaceAll(value,'[redacted]'),text);
    const base={requestId,model,attempt,errorCode,summary:output.summary()};
    let text=redact(JSON.stringify({...base,...output.evidence()}));
    if(Buffer.byteLength(text)>1024*1024)text=redact(JSON.stringify({...base,limited:true,usage:output.usage()??null}));
    const name=`${Date.now()}-${randomUUID()}-attempt-${attempt}.json`,path=join(folder,name);
    await writeFile(path,text,{mode:0o600});
    const names=(await readdir(folder)).filter(n=>owned.test(n)).sort();
    const sizes=await Promise.all(names.map(async name=>({name,size:await stat(join(folder,name)).then(s=>s.size,()=>0)})));
    let bytes=sizes.reduce((n,f)=>n+f.size,0),count=sizes.length;
    for(const file of sizes){if(count<=32&&bytes<=8*1024*1024)break;if(file.name===name)continue;
      // Only single files matching this module's exact generated namespace.
      await rm(join(folder,file.name),{force:true}).catch(()=>{});bytes-=file.size;count--;}
    return path;
  }catch{return null;}
}
