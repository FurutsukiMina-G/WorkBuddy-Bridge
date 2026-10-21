import {BridgeError} from './errors.mjs';
const MARKER='｜｜DSML｜｜';
const failure=()=>{throw new BridgeError(502,'invalid_decision','WorkBuddy returned an incomplete or ambiguous DSML decision');};
/** The SDK can emit its ordinary pre-tool progress sentence before DSML.
 * Keep it as assistant content, but do not mine documentation/code examples. */
export function decodeDsmlDocument(source){
  if(source.startsWith('<｜｜DSML｜｜'))return decodeDsml(source);
  const marker=source.indexOf('<｜｜DSML｜｜');if(marker<0)failure();
  const before=source.slice(0,marker),content=before.trim();
  const announcement=/^(?:(?:first|to start)[,:]?\s+)?(?:I['’]ll|I will|Let me|I['’]m going to|I am going to)\s+(?:start|begin|read|check|inspect|look|search|open|use|first)\b/i.test(content)||/^(?:我(?:先|会|将|准备)|先(?:读取|读|查看|检查|搜索)|接下来(?:我会|先))/.test(content);
  if(!announcement||content.length>1024||!/(?:^|\n)[ \t]*$/.test(before)||/```|[{}]|\b(?:example|syntax|protocol)\s*:/i.test(content))failure();
  const decision=decodeDsml(source.slice(marker));return {...decision,content};
}
function attributes(text,allowed){
  const attrs=Object.create(null);let rest=text;
  while(rest.trim()){
    const match=/^\s+([A-Za-z_][\w.-]*)\s*=\s*"([^"\r\n]*)"/.exec(rest);
    if(!match||!allowed.includes(match[1])||Object.hasOwn(attrs,match[1]))failure();
    attrs[match[1]]=match[2];rest=rest.slice(match[0].length);
  }
  return attrs;
}
/** Decode complete generated DSML only. Never extract calls from prose, repair
 * broken boundaries, coerce parameter types, or execute any part of the batch. */
export function decodeDsml(source){
  const open=/^<｜｜DSML｜｜\s+(calls|tool_calls)\s*>/.exec(source);
  if(!open)failure();let cursor=open[0].length;const calls=[];
  const skip=()=>{const whitespace=/^\s*/.exec(source.slice(cursor))[0];cursor+=whitespace.length;};
  const consume=regex=>{skip();const match=regex.exec(source.slice(cursor));if(!match)failure();cursor+=match[0].length;return match;};
  while(true){
    skip();
    const close=new RegExp(`^<\\/${MARKER}\\s+${open[1]}\\s*>`).exec(source.slice(cursor));
    if(close){cursor+=close[0].length;skip();if(cursor!==source.length||!calls.length)failure();return {action:'tool_calls',calls};}
    if(calls.length>=32)failure();
    const invocation=consume(/^<｜｜DSML｜｜\s+invoke\b([^>]*)>/);
    const invoked=attributes(invocation[1],['name']);if(!invoked.name)failure();
    const args=Object.create(null);
    while(true){
      skip();const invokeEnd=/^<\/｜｜DSML｜｜\s+invoke\s*>/.exec(source.slice(cursor));
      if(invokeEnd){cursor+=invokeEnd[0].length;break;}
      const parameter=consume(/^<｜｜DSML｜｜\s+parameter\b([^>]*)>/);
      const attr=attributes(parameter[1],['name','string']);
      if(!attr.name||!['true','false'].includes(attr.string)||Object.hasOwn(args,attr.name))failure();
      const tail=source.slice(cursor),end=/<\/｜｜DSML｜｜\s+parameter\s*>/.exec(tail);
      if(!end)failure();const value=tail.slice(0,end.index);
      // A nested/unfinished protocol marker is not part of a canonical scalar.
      // Refuse ambiguous boundaries instead of dropping trailing intended calls.
      if(value.includes(MARKER))failure();
      if(attr.string==='true')args[attr.name]=value;
      else {try{args[attr.name]=JSON.parse(value);}catch{failure();}}
      cursor+=end.index+end[0].length;
    }
    calls.push({name:invoked.name,arguments:Object.fromEntries(Object.entries(args))});
  }
}
