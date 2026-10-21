/** Escape literal JSON-string controls without changing their decoded values. */
export function escapeStringControls(source){
  if(!/^[{[]/.test(source))return {text:source,count:0};
  let quoted=false,escaped=false,count=0,text='';
  for(const char of source){
    if(quoted){
      if(escaped){
        // A backslash followed by a physical line break is not a JSON escape.
        // Do not invent line-continuation semantics or drop either character.
        if(char.charCodeAt(0)<32)return {text:source,count:0};
        escaped=false;text+=char;continue;
      }
      if(char==='\\'){escaped=true;text+=char;continue;}
      if(char==='"'){quoted=false;text+=char;continue;}
      if(char.charCodeAt(0)<32){text+=JSON.stringify(char).slice(1,-1);count++;continue;}
    }else if(char==='"')quoted=true;
    text+=char;
  }
  return {text,count};
}
export function parseJsonText(source){
  try{return {value:JSON.parse(source),repairs:[]};}
  catch(original){
    const normalized=escapeStringControls(source);if(!normalized.count)throw original;
    return {value:JSON.parse(normalized.text),repairs:[{kind:'json_string_controls',charactersEscaped:normalized.count}]};
  }
}
