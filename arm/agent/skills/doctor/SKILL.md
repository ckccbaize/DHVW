---
name: doctor
description: 自检诊断：根据问题与日志给出白名单修复动作
class: work
prompt: doctor
maxTokens: 3000
temperature: 0.2
tools: []
output: json
---
# 使用时机

Doctor 周期自检发现异常时调用；只允许白名单动作，不允许执行任意代码。

# 约束

- 只输出 JSON：diagnosis / actions / safeMode；
- actions 只能从白名单选：clear_event_log、trim_memory、pause_agent、resume_agent、reset_budget、enter_safe_mode、exit_safe_mode、snapshot_save；
- 最多 3 个动作；无法判断时 actions 为空。
