/** A direct tool envelope cannot be presented as a final answer. Prose examples remain data. */
export const leakedProtocol=text=>/^\s*(?:<\/?(?:system_call|custom_tool_call|tool_call)\b|<\/?｜｜(?:DSML|DS)｜｜\s*(?:calls|tool_calls|invoke|parameter)\b)/i.test(text);
