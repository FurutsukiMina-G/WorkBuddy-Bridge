import {MARKER,attributes,failure} from './dsml-syntax.mjs';
import {compatibleDsml} from './dsml-compat.mjs';
import {executionPreamble} from './execution-preamble.mjs';
/** The SDK can emit its ordinary pre-tool progress sentence before DSML.
 * Keep it as assistant content, but do not mine documentation/code examples. */
export function decodeDsmlDocument(source,onRepair=()=>{}){
  const preamble=source.startsWith('<｜｜DSML｜｜')?null:executionPreamble(source);
  if(!source.startsWith('<｜｜DSML｜｜')&&!preamble)failure();
  const body=preamble?.document??source;let decision;
  try{decision=decodeDsml(body);}catch(error){const recovered=compatibleDsml(body);decision=recovered.decision;recovered.repairs.forEach(onRepair);}
  return preamble?{...decision,content:preamble.content}:decision;
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
