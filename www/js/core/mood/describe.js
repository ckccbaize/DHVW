// 把 4 维心情翻译成自然语言，供 LLM 提示词使用；不把数字直接塞给模型。
export function describeMood(m = {}) {
  const parts = [];
  const e = Number(m.energy) || 0;
  const v = Number(m.valence) || 0;
  const s = Number(m.social) || 0;
  const f = Number(m.focus) || 0;

  if (e < -0.35) parts.push("身体很乏，做什么都提不起劲");
  else if (e < -0.15) parts.push("有点累");
  else if (e > 0.35) parts.push("精神很足");
  else if (e > 0.15) parts.push("精神不错");

  if (v < -0.35) parts.push("心里发沉，容易往坏处想");
  else if (v < -0.15) parts.push("情绪有点低");
  else if (v > 0.35) parts.push("心情轻快");
  else if (v > 0.15) parts.push("心情还算好");

  if (s < -0.3) parts.push("很想一个人待着");
  else if (s < -0.15) parts.push("不太想说话");
  else if (s > 0.3) parts.push("想有人陪着说说话");
  else if (s > 0.15) parts.push("愿意和人待在一起");

  if (f < -0.3) parts.push("注意力很散");
  else if (f < -0.15) parts.push("有点走神");
  else if (f > 0.3) parts.push("注意力很集中");
  else if (f > 0.15) parts.push("能静下心");

  return parts.length ? parts.join("，") : "情绪平稳";
}

/** 给提示词的语气约束：让输出自然偏向当前情绪。 */
export function moodTone(m = {}) {
  const v = Number(m.valence) || 0;
  const e = Number(m.energy) || 0;
  if (v < -0.3) return "语气低一点，少用轻快词，别强行积极";
  if (v > 0.3) return "语气松一点，可以有一点轻快";
  if (e < -0.3) return "句子短一点，动作慢一点，不要兴奋";
  if (e > 0.3) return "可以主动一点，动作利落一点";
  return "语气自然，不要刻意抒情";
}
