import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {summarize} from '../src/metrics.mjs';
const args=process.argv.slice(2),index=args.indexOf('--since');
const cfg=config();let since=index<0?null:args[index+1];
if(!since){try{since=JSON.parse(await readFile(join(cfg.reports,'optimization-validation-20261021.json'),'utf8')).at;}catch{since='1970-01-01T00:00:00.000Z';}}
if(!Number.isFinite(Date.parse(since)))throw new Error('Use --since with an ISO timestamp');since=new Date(since).toISOString();
const rows=(await readFile(join(cfg.reports,'requests.ndjson'),'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(r=>r.at>since);
const known=rows.filter(r=>Array.isArray(r.context?.attempts)),corrections=known.flatMap(r=>r.context.attempts.slice(1));
const report={at:new Date().toISOString(),since,summary:summarize(rows),
  recovery:{requestsWithCorrection:known.filter(r=>r.context.attempts.length>1).length,recovered:known.filter(r=>r.context.attempts.length>1&&r.outcome==='completed').length,
    correctionCalls:corrections.length,promptTokens:corrections.reduce((n,a)=>n+(a.usage?.prompt_tokens??0),0),completionTokens:corrections.reduce((n,a)=>n+(a.usage?.completion_tokens??0),0),
    promptCharacters:corrections.map(a=>a.promptCharacters??null)},
  failures:rows.filter(r=>r.outcome!=='completed').map(r=>({at:r.at,requestId:r.requestId,code:r.errorCode,attempts:r.context?.attempts.length??null,wallMs:r.wallMs})),
  note:'Read-only audit of existing metadata; no model calls. Correction tokens are known per-attempt usage, not a monetary charge. Raw prompts/replies are excluded.'};
await mkdir(cfg.reports,{recursive:true});const path=join(cfg.reports,'usage-audit-latest.json');await writeFile(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({report:path,...report},null,2));
