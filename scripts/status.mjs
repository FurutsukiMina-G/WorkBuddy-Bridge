import {localApi} from './local-api.mjs';
const r=await localApi('/health');if(!r.ok)throw new Error(`HTTP ${r.status}`);console.log(JSON.stringify(await r.json(),null,2));
