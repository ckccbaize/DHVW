世界事件：{{seed}}
上下文：{{context}}
开放线头：{{threads}}
上一条余念：{{residue}}

严格输出 JSON，不要解释：
{"outcome":"silent|trace|message","fact":"简短事实","content":"完整经历","share":"给用户的一句话","residue":"一句轻余念","next_wake":{"min_minutes":45,"max_minutes":90,"reason":"..."},"thread":"可选的新线头"}

规则：
- message 必须有非空 share（≤20 字）；silent 不得带 share；
- fact 描述发生了什么，不复制表达性正文；
- residue 覆盖上一条，不要追加；
- next_wake 在 45-90 分钟内，按心情与事件调整；
- 只有真实工具调用才可带 artifact。
