// 本地记忆索引（W7）：bigram 倒排 + 时间衰减。
// 设备只做字面召回；语义召回走 PC（W8）。契约：MEMORY-AND-SYNC.md §2。

/** 分词：ASCII 词 + CJK 二元组（bigram）；标点/空白丢弃。 */
export function tokenize(text) {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
  if (!s) return [];
  const out = [];
  for (const chunk of s.split(" ")) {
    if (!chunk) continue;
    if (/^[a-z0-9]+$/.test(chunk)) {
      out.push(chunk);
      continue;
    }
    const chars = [...chunk];
    if (chars.length === 1) {
      out.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/**
 * 倒排索引：term -> Map<docId, tf>；文档保留 tokens 计数用于删除。
 * 打分：Σ (1+ln tf) × idf × 0.5^(age/halfLifeDays)。
 */
export function createBigramIndex({ halfLifeDays = 30 } = {}) {
  const docs = new Map(); // id -> {id,text,t,tier,meta,tf}
  const postings = new Map(); // term -> Map<id, tf>

  function remove(id) {
    const doc = docs.get(id);
    if (!doc) return false;
    for (const term of doc.tf.keys()) {
      const m = postings.get(term);
      if (!m) continue;
      m.delete(id);
      if (m.size === 0) postings.delete(term);
    }
    docs.delete(id);
    return true;
  }

  function add(doc) {
    if (!doc || !doc.id || !doc.text) throw new Error("文档需要 id 与 text");
    remove(doc.id);
    const tf = new Map();
    for (const term of tokenize(doc.text)) tf.set(term, (tf.get(term) || 0) + 1);
    const rec = {
      id: doc.id,
      text: doc.text,
      t: Number.isFinite(doc.t) ? doc.t : Date.now(),
      tier: doc.tier || null,
      meta: doc.meta || null,
      tf,
    };
    docs.set(doc.id, rec);
    for (const [term, n] of tf) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(doc.id, n);
    }
    return rec;
  }

  function search(query, { k = 5, now = Date.now(), halfLife = halfLifeDays } = {}) {
    const terms = tokenize(query);
    if (!terms.length || docs.size === 0) return [];
    const N = docs.size;
    const scores = new Map();
    for (const term of terms) {
      const m = postings.get(term);
      if (!m) continue;
      const idf = Math.log(1 + N / (1 + m.size));
      for (const [id, tf] of m) {
        const w = (1 + Math.log(tf)) * idf;
        scores.set(id, (scores.get(id) || 0) + w);
      }
    }
    const out = [];
    for (const [id, s] of scores) {
      const doc = docs.get(id);
      const ageDays = Math.max(0, (now - doc.t) / 86400000);
      const decay = Math.pow(0.5, ageDays / halfLife);
      out.push({
        id,
        text: doc.text,
        t: doc.t,
        tier: doc.tier,
        meta: doc.meta,
        score: Number((s * decay).toFixed(4)),
      });
    }
    out.sort((a, b) => b.score - a.score || b.t - a.t);
    return out.slice(0, k);
  }

  return {
    add,
    remove,
    search,
    clear() {
      docs.clear();
      postings.clear();
    },
    get size() {
      return docs.size;
    },
    get terms() {
      return postings.size;
    },
    all() {
      return [...docs.values()].map(({ tf, ...d }) => d);
    },
  };
}
