import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../src/config.mjs';
for(const dir of ['src','scripts','tests'])for(const name of await readdir(`${ROOT}/${dir}`)){if(!name.endsWith('.mjs'))continue;const r=spawnSync(process.execPath,['--check',`${ROOT}/${dir}/${name}`],{encoding:'utf8',windowsHide:true});if(r.status!==0){process.stderr.write(r.stderr);process.exitCode=1;}}
if(!process.exitCode)console.log('Syntax checks passed');
