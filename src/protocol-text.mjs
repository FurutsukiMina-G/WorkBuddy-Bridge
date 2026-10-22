/** A direct tool envelope cannot be presented as a final answer. Prose examples remain data. */
export const leakedProtocol=text=>/^\s*(?:<\/?(?:system_call|custom_tool_call|tool_call)\b|<\/?｜｜(?:DSML|DS)｜｜\s*(?:calls|tool_calls|invoke|parameter)\b)/i.test(text);
// Tool envelopes a model may print instead of calling. DSML is unambiguous anywhere outside code;
// the other envelopes count only at a line start, so prose and fenced examples remain answers.
const DSML=/<\/?｜｜(?:DSML|DS)｜｜|｜｜DSML｜｜>|｟DSML｠/;
const LINE=/^[ \t]*(?:<\/?(?:system_call|function_calls?|tool_calls?|custom_tool_call|invoke|parameter)\b|<name\s*=|"(?:tool_calls|calls)"\s*:\s*\[)/i;
const MARKERS=['<｜｜','</｜｜','｜｜DSML','<system_call','</system_call','<function_call','<tool_call','<custom_tool_call','<invoke','<parameter','<name','"tool_calls"','"calls"'];
const PARTIAL=['<｜｜DSML｜｜','</｜｜DSML｜｜','｜｜DSML｜｜'];
function lines(text){
  const out=[];let at=0,fenced=false;
  for(const line of text.split('\n')){const fence=/^[ \t]*(?:```|~~~)/.test(line);out.push({at,line,code:fenced||fence});if(fence)fenced=!fenced;at+=line.length+1;}
  return out;
}
// Keep offsets intact when ignoring examples. JSON whitespace can cross line and chunk boundaries.
function outsideCode(text){return lines(text).map(({line,code})=>code?' '.repeat(line.length):line.replace(/`[^`\n]*`/g,m=>' '.repeat(m.length))).join('\n');}
/** true: protocol, null: the first property is still incomplete, false: ordinary JSON. */
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
/** Index of the first printed call envelope, or host argument object, outside code; -1 if none. */
export function protocolAt(text,params=new Set()){
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
/** Where a possibly split envelope begins at the end of streamed text, or -1. */
export function pendingAt(text,params=new Set()){
  text=outsideCode(String(text));let pending=-1;
  for(const match of text.matchAll(/^[ \t]*\{/gm)){
    const start=match.index+match[0].length-1;
    if(jsonHead(text.slice(start),params)===null){pending=start;break;}
  }
  // The open line may still become a line-start envelope or an argument object.
  const at=text.lastIndexOf('\n')+1,last=text.slice(at),start=last.trimStart();
  if(start&&MARKERS.some(m=>m.startsWith(start)))pending=pending<0?at+last.length-start.length:pending;
  // A DSML marker may begin anywhere: hold any suffix that can still grow into one.
  for(let i=Math.max(0,text.length-12);i<text.length;i++)if(PARTIAL.some(p=>p.startsWith(text.slice(i))))return pending<0?i:Math.min(pending,i);
  return pending;
}
