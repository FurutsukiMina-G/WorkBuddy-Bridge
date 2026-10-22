import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeError} from '../src/errors.mjs';
import {protocolAt,pendingAt} from '../src/protocol-text.mjs';
import {NativeTextGate,mayStartAnnounce} from '../src/native.mjs';
import {FinalTextProjector} from '../src/streaming.mjs';

// Oracle: the previous full-text implementations (0.3.1), kept verbatim. They rescanned
// everything on every chunk; the linear versions must stream exactly the same output.
const DSML=/<\/?｜｜(?:DSML|DS)｜｜|｜｜DSML｜｜>|｟DSML｠/;
const LINE=/^[ \t]*(?:<\/?(?:system_call|function_calls?|tool_calls?|custom_tool_call|invoke|parameter)\b|<name\s*=|"(?:tool_calls|calls)"\s*:\s*\[)/i;
const MARKERS=['<｜｜','</｜｜','｜｜DSML','<system_call','</system_call','<function_call','<tool_call','<custom_tool_call','<invoke','<parameter','<name','"tool_calls"','"calls"'];
const PARTIAL=['<｜｜DSML｜｜','</｜｜DSML｜｜','｜｜DSML｜｜'];
function lines(text){
  const out=[];let at=0,fenced=false;
  for(const line of text.split('\n')){const fence=/^[ \t]*(?:```|~~~)/.test(line);out.push({at,line,code:fenced||fence});if(fence)fenced=!fenced;at+=line.length+1;}
  return out;
}
function outsideCode(text){return lines(text).map(({line,code})=>code?' '.repeat(line.length):line.replace(/`[^`\n]*`/g,m=>' '.repeat(m.length))).join('\n');}
function jsonHead(source,params){
  let rest=source.slice(1).trimStart();if(!rest)return null;
  if(!rest.startsWith('"'))return false;
  const token=/^"(?:[^"\\\r\n]|\\.)*"/.exec(rest);
  if(!token)return /[\r\n]/.test(rest)?false:null;
  let key;try{key=JSON.parse(token[0]);}catch{return false;}
  rest=rest.slice(token[0].length).trimStart();if(!rest)return null;
  if(!rest.startsWith(':'))return false;
  rest=rest.slice(1).trimStart();
  if(params.has(key))return true;
  if(key==='action'){
    const values=['"tool_calls"','"final"'];
    if(values.some(v=>rest.startsWith(v)))return true;
    return values.some(v=>v.startsWith(rest))?null:false;
  }
  if(key==='calls'||key==='tool_calls')return rest?rest.startsWith('['):null;
  return false;
}
function oldProtocolAt(text,params=new Set()){
  const plain=outsideCode(String(text));let found=-1,at=0;
  const mark=index=>{if(found<0||index<found)found=index;};
  for(const line of plain.split('\n')){
    const dsml=DSML.exec(line);if(dsml)mark(at+dsml.index);
    if(LINE.test(line))mark(at+line.search(/\S/));at+=line.length+1;
  }
  for(const match of plain.matchAll(/^[ \t]*\{/gm)){
    const start=match.index+match[0].length-1;
    if(jsonHead(plain.slice(start),params)===true)mark(start);
  }
  return found;
}
function oldPendingAt(text,params=new Set()){
  text=outsideCode(String(text));let pending=-1;
  for(const match of text.matchAll(/^[ \t]*\{/gm)){
    const start=match.index+match[0].length-1;
    if(jsonHead(text.slice(start),params)===null){pending=start;break;}
  }
  const at=text.lastIndexOf('\n')+1,last=text.slice(at),start=last.trimStart();
  if(start&&MARKERS.some(m=>m.startsWith(start)))pending=pending<0?at+last.length-start.length:pending;
  for(let i=Math.max(0,text.length-12);i<text.length;i++)if(PARTIAL.some(p=>p.startsWith(text.slice(i))))return pending<0?i:Math.min(pending,i);
  return pending;
}
class OldGate {
  constructor(send,{enabled=true,params=new Set(),announce=true,structured=false}={}){this.send=send;this.enabled=enabled;this.params=params;this.announce=announce;this.structured=structured;this.text='';this.emitted=0;this.blocked=false;}
  push(delta){this.text+=delta;this.pump(false);}
  pump(final){
    if(!this.enabled||this.blocked)return;
    if(this.structured){this.release(this.text.length);return;}
    const leak=oldProtocolAt(this.text,this.params);
    if(leak>=0){this.release(leak);this.blocked=true;return;}
    if(!final){
      const head=this.text.trimStart();
      if(!head||this.announce&&head.length<=240&&mayStartAnnounce(head))return;
      const pending=oldPendingAt(this.text,this.params);this.release(pending>=0?pending:this.text.length);
    }else this.release(this.text.length);
  }
  release(end){
    if(end<=this.emitted)return;
    if(/[\uD800-\uDBFF]/.test(this.text[end-1]??''))end--;
    const text=this.text.slice(this.emitted,end);if(text){this.send(text);this.emitted=end;}
  }
}
class OldProjector {
  constructor(send){this.send=send;this.source='';this.at=null;this.decoded='';this.emitted='';this.closed=false;this.broken=false;}
  push(delta){
    this.source+=delta;if(this.closed||this.broken)return;
    if(this.at===null){const start=/^\s*\{\s*"action"\s*:\s*"final"\s*,\s*"content"\s*:\s*"/.exec(this.source);if(!start)return;this.at=start[0].length;}
    while(this.at<this.source.length){
      const c=this.source[this.at];if(c==='"'){this.closed=true;this.at++;break;}
      if(c!=='\\'){this.decoded+=c;this.at++;continue;}
      if(this.at+1>=this.source.length)break;const e=this.source[this.at+1];
      if(e==='u'){if(this.at+6>this.source.length)break;const hex=this.source.slice(this.at+2,this.at+6);if(!/^[\da-f]{4}$/i.test(hex)){this.broken=true;break;}this.decoded+=String.fromCharCode(parseInt(hex,16));this.at+=6;}
      else{const escapes={'"':'"','\\':'\\','/':'/',n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};if(!Object.hasOwn(escapes,e)){this.broken=true;break;}this.decoded+=escapes[e];this.at+=2;}
    }
    if(this.decoded.trimStart().startsWith('<')||!this.decoded.trim())return;
    let text=this.decoded;if(!this.closed&&/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
    const next=text.slice(this.emitted.length);if(next){this.send(next);this.emitted=text;}
  }
  finish(decision){
    if(this.emitted&&(decision.action!=='final'||!decision.content.startsWith(this.emitted)))throw new BridgeError(502,'ambiguous_decision','Streamed text conflicts with validated decision');
    if(decision.action==='final'){const tail=decision.content.slice(this.emitted.length);if(tail)this.send(tail);this.emitted=decision.content;}
  }
}

// Seeded so any mismatch is reproducible.
function random(seed){return ()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
const TOKENS=['hello ','The ','I',"'ll read the file.",'Ok, ','我先','读取配置。','完成：','中文 ','😀','\n','\n','\n\n','\r\n',' ','  ','\t','`','```','```xml\n','~~~\n','x`',
  '{','}','"','"file_path"','"theme"','"action"',':',' : ','"tool_calls"','"final"','"calls"','[',',','file\\u005fpath','"content": "x"','{"file_path": "a.ts"}',
  '<','</','<｜｜DSML｜｜','</｜｜DSML｜｜','｜｜DSML｜｜>','｜','DSML',' invoke name="x">','<invoke','<tool_call>','<name=','｟DSML｠','<b>','<parag','raph>','- item\n','## 标题\n'];
const params=new Set(['file_path','content']);
function chunked(text,next){const parts=[];for(let at=0;at<text.length;){const size=1+Math.floor(next()*9);parts.push(text.slice(at,at+size));at+=size;}return parts;}

test('the linear scan matches the previous full-text scan on random texts',()=>{
  const next=random(20261022);
  for(let n=0;n<3000;n++){
    let text='';const count=Math.floor(next()*40);for(let k=0;k<count;k++)text+=TOKENS[Math.floor(next()*TOKENS.length)];
    for(const cut of [text.length,Math.floor(next()*text.length),Math.floor(next()*text.length)]){
      const prefix=text.slice(0,cut);
      assert.equal(protocolAt(prefix,params),oldProtocolAt(prefix,params),JSON.stringify(prefix));
      assert.equal(pendingAt(prefix,params),oldPendingAt(prefix,params),JSON.stringify(prefix));
    }
  }
});
test('the linear gate streams exactly what the previous gate streamed, chunk by chunk',()=>{
  const next=random(4242);
  for(let n=0;n<3000;n++){
    let text='';const count=Math.floor(next()*50);for(let k=0;k<count;k++)text+=TOKENS[Math.floor(next()*TOKENS.length)];
    const options={params,announce:next()<0.7};
    const sentOld=[],sentNew=[],old=new OldGate(t=>sentOld.push(t),options),gate=new NativeTextGate(t=>sentNew.push(t),options);
    const parts=chunked(text,next);
    parts.forEach((part,i)=>{old.push(part);gate.push(part);assert.deepEqual(sentNew,sentOld,`${JSON.stringify(text)} after chunk ${i}`);});
    old.pump(true);gate.pump(true);
    assert.deepEqual(sentNew,sentOld,JSON.stringify(text));assert.equal(gate.blocked,old.blocked);assert.equal(gate.emitted,old.emitted);
    assert.equal(gate.text,text);assert.equal(gate.emittedText,text.slice(0,old.emitted));
  }
});
test('the linear JSON-mode projector streams exactly what the previous projector streamed',()=>{
  const next=random(777);
  const pieces=['abc ','中文','😀','"','\\','\n','\t','<b>','  ',' ','\u0001','x'];
  for(let n=0;n<2000;n++){
    let content='';const count=Math.floor(next()*30);for(let k=0;k<count;k++)content+=pieces[Math.floor(next()*pieces.length)];
    let raw=JSON.stringify({action:'final',content});const roll=next();
    // Raw controls, a padded envelope, a broken escape, or a non-final envelope.
    if(roll<0.2)raw=raw.replaceAll('\\n','\n');else if(roll<0.3)raw=raw.replace('{','{'+' '.repeat(40)).replace(':',' \n :');
    else if(roll<0.35)raw=raw.replace('"content":"','"content":"\\q');else if(roll<0.45)raw=JSON.stringify({action:'tool_calls',calls:[{name:'x',arguments:{content}}]});
    const sentOld=[],sentNew=[],old=new OldProjector(t=>sentOld.push(t)),projector=new FinalTextProjector(t=>sentNew.push(t));
    chunked(raw,next).forEach((part,i)=>{old.push(part);projector.push(part);assert.deepEqual(sentNew,sentOld,`${JSON.stringify(raw)} after chunk ${i}`);});
    assert.equal(projector.emitted,old.emitted);
    if(roll>=0.45&&!old.broken){old.finish({action:'final',content});projector.finish({action:'final',content});assert.deepEqual(sentNew,sentOld);}
  }
});
test('long answers stream in linear time and the gate never rescans settled lines',()=>{
  const paragraph='这是一段很长的最终回复，包含 `code`、列表和说明。The quick brown fox jumps over the lazy dog.\n';
  let text='';while(text.length<200000)text+=(text.length%5000<100?'```ts\nconst x = {"a": 1};\n```\n':'')+paragraph;
  const plainLine='没有换行的超长段落，The quick brown fox jumps over the lazy dog. '.repeat(1700);
  for(const sample of [text,plainLine]){
    let shown='';const gate=new NativeTextGate(t=>{shown+=t;},{params});const started=performance.now();
    for(let at=0;at<sample.length;at+=8)gate.push(sample.slice(at,at+8));
    // Only the open line is still in the scan window, not the 100K+ characters before it.
    assert.ok(gate.window.end-gate.window.start<=Math.max(sample.length-sample.lastIndexOf('\n'),200));
    gate.pump(true);assert.equal(shown,sample);
    // The previous full-text gate took about 10 s for 120K characters; this is generous headroom.
    assert.ok(performance.now()-started<1500,`${sample.length} characters took ${Math.round(performance.now()-started)} ms`);
  }
  const content=text,raw=JSON.stringify({action:'final',content});let projected='';
  const projector=new FinalTextProjector(t=>{projected+=t;});const started=performance.now();
  for(let at=0;at<raw.length;at+=8)projector.push(raw.slice(at,at+8));
  assert.equal(projected,content);assert.ok(projector.rest.length<16);assert.ok(performance.now()-started<1500);
});
