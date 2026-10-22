/** A direct tool envelope cannot be presented as a final answer. Prose examples remain data. */
export const leakedProtocol=text=>/^\s*(?:<\/?(?:system_call|custom_tool_call|tool_call)\b|<\/?｜｜(?:DSML|DS)｜｜\s*(?:calls|tool_calls|invoke|parameter)\b)/i.test(text);
// Tool envelopes a model may print instead of calling. DSML is unambiguous anywhere outside code;
// the other envelopes count only at a line start, so prose and fenced examples remain answers.
const DSML=/<\/?｜｜(?:DSML|DS)｜｜|｜｜DSML｜｜>|｟DSML｠/;
const LINE=/^[ \t]*(?:<\/?(?:system_call|function_calls?|tool_calls?|custom_tool_call|invoke|parameter)\b|<name\s*=|"(?:tool_calls|calls)"\s*:\s*\[)/i;
const MARKERS=['<｜｜','</｜｜','｜｜DSML','<system_call','</system_call','<function_call','<tool_call','<custom_tool_call','<invoke','<parameter','<name','"tool_calls"','"calls"'];
const PARTIAL=['<｜｜DSML｜｜','</｜｜DSML｜｜','｜｜DSML｜｜'];
const SPACE=/\s/,KEY=/"(?:[^"\\\r\n]|\\.)*"/y,BREAK=/[\r\n]/g;
function lines(text,fenced){
  const out=[];let at=0;
  for(const line of text.split('\n')){const fence=/^[ \t]*(?:```|~~~)/.test(line);out.push({at,line,code:fenced||fence,fenced});if(fence)fenced=!fenced;at+=line.length+1;}
  return out;
}
// Keep offsets intact when ignoring examples. JSON whitespace can cross line and chunk boundaries.
const mask=({line,code})=>code?' '.repeat(line.length):line.replace(/`[^`\n]*`/g,m=>' '.repeat(m.length));
/** Decide the line-start JSON object at source[start]. state true: protocol, null: its first property is
 * still incomplete, false: ordinary JSON. `at` is just past the last character the decision read. */
function jsonHead(source,start,params){
  const n=source.length;let i=start+1;
  const skip=()=>{while(i<n&&SPACE.test(source[i]))i++;};
  skip();if(i>=n)return {state:null};
  if(source[i]!=='"')return {state:false,at:i+1};
  KEY.lastIndex=i;const token=KEY.exec(source);
  if(!token){BREAK.lastIndex=i;const line=BREAK.exec(source);return line?{state:false,at:line.index+1}:{state:null};}
  let key;try{key=JSON.parse(token[0]);}catch{return {state:false,at:i+token[0].length};}
  i+=token[0].length;skip();if(i>=n)return {state:null};
  if(source[i]!==':')return {state:false,at:i+1};
  i++;skip();
  if(params.has(key))return {state:true,at:i};
  if(key==='action'){
    const values=['"tool_calls"','"final"'];
    if(values.some(v=>source.startsWith(v,i)))return {state:true,at:i};
    const rest=source.slice(i,i+12);return values.some(v=>v.startsWith(rest))?{state:null}:{state:false,at:i+rest.length};
  }
  if(key==='calls'||key==='tool_calls')return i<n?{state:source[i]==='[',at:i+1}:{state:null};
  return {state:false,at:i};
}
/** One pass over text that begins at a line start (inside a fence when `fenced`):
 * leak — first printed call envelope or host argument object outside code, or -1;
 * pending — where a possibly split envelope begins at the end, or -1;
 * settled — start of the first line whose classification can still change, with its fence state.
 * A completed line never changes, except a line-start JSON head not yet decided by completed lines. */
export function scanText(source,params=new Set(),{fenced=false}={}){
  const text=String(source),all=lines(text,fenced),last=all[all.length-1],masked=all.map(mask),plain=masked.join('\n');
  let leak=-1,pending=-1,settled={offset:last.at,fenced:last.fenced};
  const mark=index=>{if(leak<0||index<leak)leak=index;};
  masked.forEach((line,k)=>{const at=all[k].at,dsml=DSML.exec(line);if(dsml)mark(at+dsml.index);if(LINE.test(line))mark(at+line.search(/\S/));});
  let open=false;
  for(const match of plain.matchAll(/^[ \t]*\{/gm)){
    const start=match.index+match[0].length-1,head=jsonHead(plain,start,params);
    if(head.state===true)mark(start);
    else if(head.state===null&&pending<0)pending=start;
    if(!open&&start<last.at&&(head.state===null||start+head.at>last.at)){
      const line=all.findLast(l=>l.at<=start);settled={offset:line.at,fenced:line.fenced};open=true;
    }
  }
  // The open line may still become a line-start envelope or an argument object.
  const at=last.at,lastLine=masked[masked.length-1],head=lastLine.trimStart();
  if(head&&MARKERS.some(m=>m.startsWith(head)))pending=pending<0?at+lastLine.length-head.length:pending;
  // A DSML marker may begin anywhere: hold any suffix that can still grow into one.
  for(let i=Math.max(0,plain.length-12);i<plain.length;i++)if(PARTIAL.some(p=>p.startsWith(plain.slice(i)))){pending=pending<0?i:Math.min(pending,i);break;}
  return {leak,pending,settled};
}
/** Raw-text DSML test for newly streamed characters; a hit is settled by the exact scan. */
export const hasDsml=text=>DSML.test(text);
/** First index in the stream's last characters where a split DSML marker may begin, or -1.
 * Markers hold no line break, so suffixes reaching into earlier lines never match. */
export function partialAt(tail,length){for(let i=0;i<tail.length;i++)if(PARTIAL.some(p=>p.startsWith(tail.slice(i))))return length-tail.length+i;return -1;}
/** Index of the first printed call envelope, or host argument object, outside code; -1 if none. */
export function protocolAt(text,params=new Set(),options){return scanText(text,params,options).leak;}
/** Where a possibly split envelope begins at the end of streamed text, or -1. */
export function pendingAt(text,params=new Set(),options){return scanText(text,params,options).pending;}
