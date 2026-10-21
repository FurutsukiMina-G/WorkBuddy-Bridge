/** Reuse the native transcript; repeat only the schema involved in a validation error. */
export function correctionInput(body,error){
  const issue=error.decisionIssue;
  const pinned=body.tool_choice&&typeof body.tool_choice==='object'?body.tool_choice.function?.name:null;
  const target=issue?.tool??(error.code==='wrong_pinned_tool'?pinned:null);
  const schemas=target?(body.tools??[]).filter(t=>t.function.name===target):[];
  const contract={protocol:'host-decision-v1',rejected:error.code,tool_choice:body.tool_choice??'auto',
    tool_definitions:'unchanged; use the exact complete definitions already in this native session',
    ...(issue?{validation:issue}:{}),
    ...(schemas.length?{affected_tools:schemas}:{}),
    ...(issue&&!issue.tool?{declared_tool_names:(body.tools??[]).map(t=>t.function.name)}:{}),
    ...(body.response_format?{response_format:body.response_format}:{}),
  };
  const prompt='Your preceding host decision was rejected. No host tool was executed. Keep the original task and role priorities; correct only the complete next decision. '+
    'Return exactly one JSON object without markdown or a leading < marker: {"action":"final","content":"..."} or '+
    '{"action":"tool_calls","calls":[{"name":"declared tool name","arguments":{...}}]}. Finish all strings, objects and calls. Preserve unchanged arguments exactly and include every required field in full; never use placeholders or references to prior values.\n'+JSON.stringify(contract);
  return {prompt,schemaCharacters:schemas.length?JSON.stringify(schemas).length:0,toolNames:schemas.map(t=>t.function.name)};
}
