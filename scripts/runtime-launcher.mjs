import {spawn} from 'node:child_process';
import {join,dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {containChildren} from '../src/contain.mjs';
const actual=process.env.WORKBUDDY_BRIDGE_ACTUAL_CLI;
if(!actual)throw new Error('Missing explicit official WorkBuddy runtime');
containChildren({cliPath:actual});
const child=spawn(process.execPath,[join(dirname(actual),'../bin/codebuddy'),...process.argv.slice(2)],{
  windowsHide:true,env:{...process.env,CODEBUDDY_FORCE_LITE_WB_BUNDLE:'1'},stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.stdin.on('error',()=>{});let timer=null;
function stop(){if(timer)return;child.stdin.end();timer=setTimeout(()=>child.kill(),1000);timer.unref();}
// WorkBuddy desktop's stream-json runtime can keep its sidecars alive after
// producing the terminal result. Bound that shutdown independently of the SDK.
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{try{if(JSON.parse(line).type==='result')stop();}catch{}});
process.stdin.on('end',stop);process.stdin.on('close',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
child.on('error',()=>process.exit(1));
child.on('close',code=>{clearTimeout(timer);lines.close();process.exit(code??0);});
