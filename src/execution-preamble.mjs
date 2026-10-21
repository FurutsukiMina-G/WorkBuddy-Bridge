/** Recognize only a bounded execution announcement followed by a whole document. */
export function executionPreamble(source){
  const match=/^([\s\S]{1,1024}?)\r?\n[ \t]*((?:<｜｜DSML｜｜\s+(?:calls|tool_calls)\s*>|<?\{\s*"action"\s*:)[\s\S]*)$/.exec(source);
  if(!match)return null;
  const content=match[1].trim();
  const announcement=/^(?:(?:first|to start)[,:]?\s+)?(?:I['’]ll|I will|Let me|I['’]m going to|I am going to)\s+(?:start|begin|read|check|inspect|look|search|open|use|first)\b/i.test(content)||
    /^(?:我(?:先|会|将|准备)|先(?:读取|读|查看|检查|搜索)|接下来(?:我会|先)|正在(?:检查|读取|搜索))/.test(content);
  if(!announcement||/```|[{}]|\b(?:example|syntax|protocol)\s*:|\bexamples?\s+(?:follows|below)|(?:给出|展示|提供|举).{0,12}(?:示例|例子|演示)|(?:示例|例子|演示)[：:]/i.test(content))return null;
  return {content,document:match[2]};
}
