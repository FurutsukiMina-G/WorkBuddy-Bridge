import {config} from '../src/config.mjs';
import {Provider} from '../src/provider.mjs';
import {modelsFor} from '../src/protocol.mjs';
import {publicError} from '../src/errors.mjs';
try{const p=new Provider(config());const model=await p.ready();console.log(JSON.stringify({source:'workbuddy-cn-live-catalog',upstream:model,models:modelsFor(model)},null,2));}catch(e){console.error(JSON.stringify(publicError(e).body));process.exitCode=1;}
