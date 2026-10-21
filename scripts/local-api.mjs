import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
export const cfg=config();
export async function localApi(path,body,{signal=AbortSignal.timeout(30000)}={}){
  const key=(await readFile(join(cfg.runtime,'bridge-key'),'utf8')).trim();
  return fetch(`http://127.0.0.1:${cfg.port}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal});
}
