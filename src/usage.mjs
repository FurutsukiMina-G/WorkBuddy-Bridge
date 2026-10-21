const valid=n=>Number.isSafeInteger(n)&&n>=0;
export function normalizedUsage(message){
  const u=message?.usage;if(!u||!valid(u.input_tokens)||!valid(u.output_tokens))return null;
  // WorkBuddy's runtime reports TOTAL input, with cache categories as subsets.
  const out={prompt_tokens:u.input_tokens,completion_tokens:u.output_tokens,total_tokens:u.input_tokens+u.output_tokens,
    bridge_usage_source:'workbuddy-official-sdk',bridge_credits:null,bridge_cache_status:'not_reported'};
  if(valid(u.cache_read_input_tokens)&&u.cache_read_input_tokens<=u.input_tokens){out.prompt_tokens_details={cached_tokens:u.cache_read_input_tokens};out.bridge_cache_status='reported';}
  if(valid(u.cache_creation_input_tokens)&&u.cache_creation_input_tokens<=u.input_tokens)out.cache_creation_input_tokens=u.cache_creation_input_tokens;
  return out;
}
export function sumUsage(items){
  const known=items.filter(Boolean);if(!known.length)return null;
  const out={prompt_tokens:0,completion_tokens:0,total_tokens:0,bridge_usage_source:'workbuddy-official-sdk',bridge_credits:null,
    bridge_usage_complete:known.length===items.length,bridge_cache_status:known.every(u=>u.bridge_cache_status==='reported')?'reported':known.some(u=>u.bridge_cache_status==='reported')?'partial':'not_reported'};
  for(const u of known)for(const k of ['prompt_tokens','completion_tokens','total_tokens'])out[k]+=u[k];
  if(out.bridge_cache_status==='reported')out.prompt_tokens_details={cached_tokens:known.reduce((n,u)=>n+u.prompt_tokens_details.cached_tokens,0)};
  if(known.every(u=>valid(u.cache_creation_input_tokens)))out.cache_creation_input_tokens=known.reduce((n,u)=>n+u.cache_creation_input_tokens,0);
  return out;
}
export const replayUsage=()=>({prompt_tokens:0,completion_tokens:0,total_tokens:0,bridge_usage_source:'local-response-replay',bridge_cache_status:'not_applicable',bridge_credits:null});
