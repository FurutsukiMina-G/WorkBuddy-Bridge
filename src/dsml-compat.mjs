import {MARKER,attributes,failure} from './dsml-syntax.mjs';
/** Parse explicit named/typed values; normalize only observed boundary spellings.
 * No values, types, named fields, invoke boundaries or terminal root are invented. */
export function compatibleDsml(source){
  const root=/^<｜｜DSML｜｜\s+(calls|tool_calls)\s*>/.exec(source);if(!root)failure();
  let cursor=root[0].length,call=null,param=null,lastParameter=false,tokens=0;
  const calls=[],counts=new Map();const repair=kind=>counts.set(kind,(counts.get(kind)??0)+1);
  function token(){
    const at=source.indexOf(MARKER,cursor);if(at<0)failure();
    const start=source.slice(at-2,at)==='</'?at-2:source[at-1]==='<'?at-1:at;
    const end=source.indexOf('>',at+MARKER.length);if(end<0)failure();
    const header=source.slice(at+MARKER.length,end).trim(),bare=start===at,closed=source.slice(start,start+2)==='</';
    if(header.includes(MARKER)||header.includes('<'))failure();
    if(bare&&header)failure();
    if(!header)return {start,end:end+1,kind:'generic',closed,bare};
    const named=/^(calls|tool_calls|invoke|parameter)\b([\s\S]*)$/.exec(header);if(!named)failure();
    const kind=named[1],attrs=attributes(named[2],kind==='parameter'?['name','string']:kind==='invoke'?['name']:[]);
    return {start,end:end+1,kind,attrs,closed,bare};
  }
  function begin(t){
    if(!call||!t.attrs.name||!['true','false'].includes(t.attrs.string)||Object.hasOwn(call.arguments,t.attrs.name)||Object.keys(call.arguments).length>=128)failure();
    param={name:t.attrs.name,string:t.attrs.string,start:t.end};lastParameter=false;
  }
  function finish(end){
    const value=source.slice(param.start,end);if(value.includes(MARKER))failure();
    if(param.string==='true')call.arguments[param.name]=value;
    else{try{call.arguments[param.name]=JSON.parse(value);}catch{failure();}}
    param=null;lastParameter=true;
  }
  function finishCall(){
    if(!call||param||calls.length>=32)failure();
    calls.push({name:call.name,arguments:Object.fromEntries(Object.entries(call.arguments))});call=null;lastParameter=false;
  }
  while(++tokens<=4096){
    const t=token();
    if(param){
      if(t.kind==='parameter'&&t.closed){
        if(!Object.keys(t.attrs).length){finish(t.start);}
        else if(t.attrs.name===param.name){
          if(t.attrs.string!==undefined&&t.attrs.string!==param.string)failure();
          finish(t.start);repair('dsml_decorated_parameter_close');
        }else{
          // An explicitly named and typed next parameter was emitted with '/'.
          // Its marker terminates the preceding value and starts its own value.
          finish(t.start);begin(t);repair('dsml_slashed_parameter_open');
        }
      }else if(t.kind==='generic'&&t.closed){finish(t.start);repair('dsml_generic_close');}
      else failure(); // Never extract a nested call or an unclosed value.
    }else{
      if(source.slice(cursor,t.start).trim())failure();
      if(t.kind===root[1]){
        if(call||!calls.length||source.slice(t.end).trim())failure();
        if(!t.closed)repair('dsml_terminal_root_slash');
        if(!counts.size)failure();
        return {decision:{action:'tool_calls',calls},repairs:[...counts].map(([kind,count])=>({kind,count}))};
      }
      if(t.kind==='calls'||t.kind==='tool_calls')failure();
      if(t.kind==='invoke'){
        if(t.closed){if(Object.keys(t.attrs).length)failure();finishCall();}
        else{if(call||!t.attrs.name)failure();call={name:t.attrs.name,arguments:Object.create(null)};lastParameter=false;}
      }else if(t.kind==='parameter'){
        if(t.closed&&!Object.keys(t.attrs).length){
          if(!call||!lastParameter)failure();repair('dsml_redundant_parameter_close');
        }else{begin(t);if(t.closed)repair('dsml_slashed_parameter_open');}
      }else if(t.kind==='generic'){
        if(call)finishCall();else if(!calls.length)failure();
        repair('dsml_generic_close');
      }else failure();
    }
    cursor=t.end;
  }
  failure();
}
