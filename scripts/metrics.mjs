import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {summarize} from '../src/metrics.mjs';
const args=process.argv.slice(2),index=args.indexOf('--limit');
const limit=index<0?100:Number(args[index+1]);if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw new Error('limit must be 1..100000');
const rows=[];let malformed=0;const stream=createReadStream(join(config().reports,'requests.ndjson'),{encoding:'utf8'});
stream.on('error',error=>{if(error.code!=='ENOENT')throw error;});
try{for await(const line of createInterface({input:stream,crlfDelay:Infinity})){if(!line.trim())continue;try{rows.push(JSON.parse(line));if(rows.length>limit)rows.shift();}catch{malformed++;}}}
catch(error){if(error.code!=='ENOENT')throw error;}
console.log(JSON.stringify({scope:`latest ${limit} requests`,malformedLines:malformed,...summarize(rows)},null,2));
