问题：{{issues}}
状态：{{state}}
最近日志：{{logs}}

只输出 JSON：
{"diagnosis":"一句话判断","actions":[{"type":"动作","args":{}}],"safeMode":false}

动作只能从这些里选：clear_event_log、trim_memory、pause_agent、resume_agent、reset_budget、enter_safe_mode、exit_safe_mode、snapshot_save。
最多 3 个；不确定就留空。
