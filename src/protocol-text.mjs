/** A direct tool envelope cannot be presented as a final answer. Prose examples remain data. */
export const leakedProtocol=text=>/^\s*(?:<\/?(?:system_call|custom_tool_call|tool_call)\b|<\/?｜｜(?:DSML|DS)｜｜\s*(?:calls|tool_calls|invoke|parameter)\b)/i.test(text);
// Tool envelopes a model may print instead of calling. DSML is unambiguous anywhere outside code;
// the other envelopes count only at a line start, so prose and fenced examples remain answers.
const DSML=/<\/?｜｜(?:DSML|DS)｜｜|｜｜DSML｜｜>|｟DSML｠/;
const LINE=/^[ \t]*(?:<\/?(?:system_call|function_calls?|tool_calls?|custom_tool_call|invoke|parameter)\b|<name\s*=|\{\s*"action"\s*:\s*"(?:tool_calls|final)"|"(?:tool_calls|calls)"\s*:\s*\[)/i;
const MARKERS=['<｜｜','</｜｜','｜｜DSML','<system_call','</system_call','<function_call','<tool_call','<custom_tool_call','<invoke','<parameter','<name','{"action"','"tool_calls"','"calls"'];
const PARTIAL=['<｜｜DSML｜｜','</｜｜DSML｜｜','｜｜DSML｜｜'];
function lines(text){
  const out=[];let at=0,fenced=false;
  for(const line of text.split('\n')){const fence=/^[ \t]*(?:```|~~~)/.test(line);out.push({at,line,code:fenced||fence});if(fence)fenced=!fenced;at+=line.length+1;}
  return out;
}
/** Index of the first printed call envelope, or host argument object, outside code; -1 if none. */
export function protocolAt(text,params=new Set()){
  for(const {at,line,code}of lines(String(text))){
    if(code)continue;
    const plain=line.replace(/`[^`\n]*`/g,m=>' '.repeat(m.length));
    const dsml=DSML.exec(plain);if(dsml)return at+dsml.index;
    if(LINE.test(plain))return at+plain.search(/\S/);
    const key=/^[ \t]*\{\s*"([^"\\]{1,64})"\s*:/.exec(plain);if(key&&params.has(key[1]))return at+plain.search(/\S/);
  }
  return -1;
}
/** Where a possibly split envelope begins at the end of streamed text, or -1. */
export function pendingAt(text){
  // The open line may still become a line-start envelope or an argument object.
  const at=text.lastIndexOf('\n')+1,last=text.slice(at),start=last.trimStart();
  if(start&&(MARKERS.some(m=>m.startsWith(start))||start.startsWith('{"')))return at+last.length-start.length;
  // A DSML marker may begin anywhere: hold any suffix that can still grow into one.
  for(let i=Math.max(0,text.length-12);i<text.length;i++)if(PARTIAL.some(p=>p.startsWith(text.slice(i))))return i;
  return -1;
}
