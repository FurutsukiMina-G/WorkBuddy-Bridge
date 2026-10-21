export class BridgeError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
export function publicError(error){
  if(error instanceof BridgeError)return {status:error.status,body:{error:{type:'bridge_error',code:error.code,message:error.message}}};
  if(error?.name==='TimeoutError')return publicError(new BridgeError(504,'timeout','WorkBuddy request deadline exceeded'));
  if(error?.name==='AbortError')return publicError(new BridgeError(499,'cancelled','Request cancelled'));
  return publicError(new BridgeError(502,'upstream_failure','WorkBuddy transport failed; see token-free health diagnostics'));
}
