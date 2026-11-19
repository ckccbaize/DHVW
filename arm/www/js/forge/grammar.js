// 端侧剧情文法（M11-T18 / MAP-SCENE-DESIGN §6）：模板 × 状态 × 因果规则，30–80 字，24h 去重。
// 纯函数、确定性（同 seed 同文本）、零网络零 token。端侧**不产出台词**。

/** fnv1a 字符串哈希（确定性种子）。 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG：同种子同序列。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOM_NAME = {
  bedroom: "卧室",
  bathroom: "浴室",
  bath: "浴室",
  hall: "门厅",
  balcony: "阳台",
  living: "起居室",
  kitchen: "厨房",
  entry: "玄关",
  study: "书房",
  outside: "外面",
};

/** 小时 → 时间词，避免出现「上午00:00」这种矛盾锚点。 */
export function hourWord(hour) {
  if (hour < 5) return "凌晨";
  if (hour < 8) return "清早";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

const WEATHER_WORD = {
  clear: "天很干净",
  cloudy: "云压得低",
  rain: "窗外在下雨",
  snow: "外面落着雪",
};

/** 动作 → 具体动作短语（每类 3 条，避免一句话重复）。 */
const ACT_PHRASE = {
  sleep: ["把被子拉到下巴", "侧过身又睡了一会儿", "听着窗外的声音慢慢睡过去"],
  rest: ["靠着坐了一会儿", "什么也没做，只是歇着", "把腿蜷起来发了会儿呆"],
  dress: ["换了件宽松的毛衣", "把衣服叠好放进柜子", "在镜子前站了一会儿"],
  sit: ["坐下来", "拖着凳子挪到窗边", "坐在那儿晃了晃脚"],
  eat: ["慢慢吃完一顿饭", "把碗筷收进水槽", "热了杯牛奶"],
  light: ["把灯拧亮了一点", "关了灯，只留一盏小的", "调了调灯的角度"],
  cook: ["切了点菜下锅", "守着锅等水开", "把灶台擦干净"],
  watch: ["看了半集老剧", "盯着屏幕没怎么看进去", "把声音调小了一点"],
  read: ["翻了几页书", "把书签夹回原处", "抄下一句话"],
  work: ["写了几行字", "把纸摊开又收起来", "对着屏幕想了很久"],
  play: ["逗了会儿猫", "把玩具球滚出去", "蹲下来看猫吃饭"],
  bath: ["泡了会儿热水", "把毛巾挂回架子上", "擦干了头发"],
  wash: ["洗了把脸", "把洗手台擦干净", "看着镜子里的自己"],
  toilet: ["进去待了一小会儿", "洗了手出来", "顺手换了卷纸"],
  laundry: ["把衣服塞进洗衣机", "晾好一篮衣服", "把袜子配成对"],
  water: ["给绿植浇了水", "擦掉叶子上的灰", "把花盆转了个方向"],
};

const STATE_PHRASE = [
  "心里有点空",
  "心情还不错",
  "有点困",
  "觉得安静得刚好",
  "想起一件小事",
  "没什么特别的理由",
  "觉得今天过得挺快",
  "有点想说话又没说",
];

const CLOSE_PHRASE = [
  "就这样过了一小段。",
  "时间又往前走了一点。",
  "屋子还是老样子。",
  "她把这件事记在了心里。",
  "窗外的光挪了一格。",
  "这一天又短了一点。",
];

const TEMPLATES = [
  (v) => `${v.time}，她在${v.room}${v.act}，${v.state}。${v.close}`,
  (v) => `${v.time}的${v.room}里，她${v.act}。${v.weather}，${v.state}。`,
  (v) => `${v.time}，${v.weather}。她在${v.room}${v.act}，${v.close}`,
  (v) => `第${v.day}天${v.time}，她${v.act}。${v.state}，于是又${v.act2}。${v.close}`,
  (v) => `${v.time}，${v.room}很静。她${v.act}，${v.state}。${v.close}`,
  (v) => `${v.time}她${v.act}，${v.weather}。${v.state}，${v.close}`,
];

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

function actPhrase(rng, act) {
  const bank = ACT_PHRASE[act] || ["待了一会儿", "做了点小事", "在原地停了停"];
  return pick(rng, bank);
}

/**
 * 生成一条端侧剧情。
 * @param {{seed:string|number, day:number, minute:number, phase:string, weather:string,
 *          room:string, act:string, recent?:string[]}} ctx
 * @returns {{text:string, id:string, seed:number, ok:boolean, reason?:string}}
 */
export function generatePlot(ctx) {
  const seedStr = `${ctx.seed}|${ctx.day}|${Math.floor(ctx.minute)}|${ctx.room}|${ctx.act}|${ctx.weather}`;
  const seed = typeof ctx.seed === "number" ? ctx.seed >>> 0 : fnv1a(seedStr);
  const recent = new Set(ctx.recent || []);

  for (let attempt = 0; attempt < 4; attempt++) {
    const rng = mulberry32((seed + attempt * 0x9e3779b1) >>> 0);
    const hh = Math.floor(ctx.minute / 60);
    const mm = Math.floor(ctx.minute % 60);
    const v = {
      day: ctx.day,
      time: `${hourWord(hh)}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      room: ROOM_NAME[ctx.room] || "屋里",
      weather: WEATHER_WORD[ctx.weather] || WEATHER_WORD.clear,
      act: actPhrase(rng, ctx.act),
      act2: actPhrase(rng, ctx.act),
      state: pick(rng, STATE_PHRASE),
      close: pick(rng, CLOSE_PHRASE),
    };
    const text = pick(rng, TEMPLATES)(v);
    const gate = plotGate(text, recent);
    if (gate.ok) return { text, id: `plot-${seed}-${attempt}`, seed, ok: true };
    if (attempt === 3) return { text, id: `plot-${seed}-${attempt}`, seed, ok: false, reason: gate.reason };
  }
  return { text: "", id: `plot-${seed}`, seed, ok: false, reason: "unreachable" };
}

/** 质量闸门：非空 / 含时间锚点 / 30–80 字 / 24h 不重复（§10.7.3）。 */
export function plotGate(text, recent = new Set()) {
  if (!text || !text.trim()) return { ok: false, reason: "empty" };
  const len = [...text].length;
  if (len < 30) return { ok: false, reason: `too_short:${len}` };
  if (len > 80) return { ok: false, reason: `too_long:${len}` };
  if (!/(第\d+天|凌晨|清早|上午|中午|下午|傍晚|晚上|深夜|夜里)/.test(text)) {
    return { ok: false, reason: "no_time_anchor" };
  }
  if (recent.has(text)) return { ok: false, reason: "duplicate" };
  return { ok: true };
}
