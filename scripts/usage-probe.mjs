import {query} from '@tencent-ai/agent-sdk';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {config} from '../src/config.mjs';
import {AuthManager} from '../src/auth.mjs';
import {Provider} from '../src/provider.mjs';
import {Completion,sseEvents} from '../src/protocol.mjs';
import {containChildren} from '../src/contain.mjs';
const cfg=config();cfg.runtime=join(cfg.runtime,'usage-probe',randomUUID());containChildren(cfg);
const provider=new Provider(cfg);await provider.ready();const snapshots=[];let turn=0;
provider.transport.run=async function*(input){
  for await(const m of query(input)){
    if(m.type==='assistant'||m.type==='result'||m.type==='stream_event'&&(m.event?.usage||m.event?.message?.usage))snapshots.push({turn,type:m.type,event:m.event?.type,usage:m.usage??m.message?.usage??m.event?.usage??m.event?.message?.usage});
    yield m;
  }
};
const body={model:provider.model.id,prompt_cache_key:randomUUID(),max_tokens:512,reasoning_effort:'low',messages:[{role:'user',content:'Remember marker USAGE_PROBE_42 and reply exactly OK.'}]};
try{
  for(turn=1;turn<=2;turn++){
    const c=new Completion(body.model),r=await provider.chat(body,AbortSignal.timeout(120000));for await(const event of sseEvents(r.body))c.accept(event,body.model);c.validate();
    body.messages.push(c.result().choices[0].message,{role:'user',content:'Reply with the remembered marker only.'});
  }
}finally{await provider.close();}
await mkdir(cfg.reports,{recursive:true});await writeFile(join(cfg.reports,'usage-probe.json'),JSON.stringify(snapshots,null,2));console.log(JSON.stringify(snapshots,null,2));
