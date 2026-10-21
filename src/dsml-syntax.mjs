import {BridgeError} from './errors.mjs';
export const MARKER='｜｜DSML｜｜';
export const failure=()=>{throw new BridgeError(502,'invalid_decision','WorkBuddy returned an incomplete or ambiguous DSML decision');};
export function attributes(text,allowed){
  const attrs=Object.create(null);let rest=text;
  while(rest.trim()){
    const match=/^\s+([A-Za-z_][\w.-]*)\s*=\s*"([^"\r\n]*)"/.exec(rest);
    if(!match||!allowed.includes(match[1])||Object.hasOwn(attrs,match[1]))failure();
    attrs[match[1]]=match[2];rest=rest.slice(match[0].length);
  }
  return attrs;
}
