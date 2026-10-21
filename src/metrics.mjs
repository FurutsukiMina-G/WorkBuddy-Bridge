export function summarize(rows){
  const n=v=>typeof v==='number'&&Number.isFinite(v);
  const p50=values=>{const sorted=values.filter(n).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};
  const local=r=>r.context?.localReplay||['local-response-replay','local-rejection-replay'].includes(r.usage?.bridge_usage_source);
  const billed=rows.filter(r=>r.usage&&!local(r));
  const inference=rows.filter(r=>!local(r));
  const cache=billed.filter(r=>n(r.usage.prompt_tokens_details?.cached_tokens));
  const sum=(items,f)=>items.reduce((a,r)=>a+(n(f(r))?f(r):0),0);
  const corrections=inference.flatMap(r=>r.context?.attempts?.slice(1)??[]),knownCorrections=corrections.filter(a=>a.usage);
  const prompt=sum(billed,r=>r.usage.prompt_tokens),cachePrompt=sum(cache,r=>r.usage.prompt_tokens),cached=sum(cache,r=>r.usage.prompt_tokens_details.cached_tokens);
  return {requests:rows.length,completed:rows.filter(r=>r.outcome==='completed').length,failed:rows.filter(r=>r.outcome==='failed').length,
    cancelled:rows.filter(r=>r.outcome==='cancelled').length,localReplays:rows.filter(local).length,
    modelAttempts:inference.every(r=>Array.isArray(r.context?.attempts))?sum(rows,r=>r.context?.attempts?.length):null,
    correctionCalls:inference.every(r=>Array.isArray(r.context?.attempts))?sum(rows,r=>Math.max(0,(r.context?.attempts?.length??0)-1)):null,
    localDecisionRepairs:sum(rows,r=>r.context?.localDecisionRepairs?.length),
    correctionTokens:{prompt:sum(knownCorrections,a=>a.usage.prompt_tokens),completion:sum(knownCorrections,a=>a.usage.completion_tokens),
      reportedAttempts:knownCorrections.length,unknownAttempts:corrections.length-knownCorrections.length,
      requestsWithoutAttemptDetails:inference.filter(r=>!Array.isArray(r.context?.attempts)).length},
    tokens:{reportedRequests:billed.length,unknownRequests:rows.filter(r=>!r.usage).length,prompt,completion:sum(billed,r=>r.usage.completion_tokens),
      total:sum(billed,r=>r.usage.total_tokens),cacheRead:cache.length?cached:null,cacheWrite:billed.some(r=>n(r.usage.cache_creation_input_tokens))?sum(billed,r=>r.usage.cache_creation_input_tokens):null,
      cacheReportedRequests:cache.length,cacheHitRatio:cachePrompt?cached/cachePrompt:null},
    medianFirstTextMs:p50(inference.map(r=>r.firstTextMs)),medianFirstThinkingMs:p50(inference.map(r=>r.firstThinkingMs)),medianWallMs:p50(inference.map(r=>r.wallMs)),
    medianOutputTokensPerSecond:p50(inference.map(r=>r.context?.outputTokensPerSecond)),
    context:{deltaRequests:rows.filter(r=>r.context?.historyMode==='delta').length,resetRequests:rows.filter(r=>r.context?.reset).length,
      charactersAvoided:sum(rows,r=>r.context?.charactersAvoided),echoCharactersAvoided:sum(rows,r=>r.context?.echoCharactersAvoided),toolsReused:rows.filter(r=>r.context?.toolsReused).length},
    credits:null,source:'workbuddy-official-sdk; local replays excluded from upstream token/cache totals'};
}
