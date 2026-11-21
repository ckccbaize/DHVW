// 打包用的纯函数：文本归一化、README 渲染、写 zip。
// 抽成独立模块是为了能单测——bat 编码那类问题只有测出来才不会复发。
import zlib from "node:zlib";

/**
 * 归一化成 CRLF。src/pack.mjs 里所有文本落盘前都要过这一道。
 * @param {string} text
 */
export function toCrlfText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/** 归一化成 LF（Unix 脚本、部署脚本）。 */
export function toLfText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * cmd.exe 按 OEM 代码页解析批处理，非 ASCII 字符会让整行错位成随机命令
 * （实测：「'llama-server' 不是内部或外部命令」）。因此 bat 必须是纯 ASCII + CRLF。
 * @param {string} text 已是 CRLF 的批处理源码
 * @returns {string} 不合法时抛错
 */
export function assertAsciiBat(text, label = "bat") {
  const lone = [...text.matchAll(/(?<!\r)\n/g)].length;
  if (lone > 0) throw new Error(`${label}: ${lone} 处孤立 LF，cmd.exe 不认，必须全 CRLF`);
  const bad = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7e || (code < 0x20 && code !== 0x0d && code !== 0x0a)) {
      bad.push({ index: i, char: text[i], code });
      if (bad.length >= 5) break;
    }
  }
  if (bad.length) {
    const list = bad.map((b) => `U+${b.code.toString(16)}@${b.index}`).join(", ");
    throw new Error(`${label}: 含非 ASCII 字符（${list}），必须改成纯 ASCII，中文说明放 README`);
  }
  return text;
}

/**
 * 渲染 `{{KEY}}` 占位符。缺变量或残留占位符都报错，避免半成品说明混进发布包。
 * @param {string} template
 * @param {Record<string, string|number>} vars
 */
export function renderTemplate(template, vars) {
  const missing = [];
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key) => {
    if (!(key in vars)) {
      missing.push(key);
      return _m;
    }
    return String(vars[key]);
  });
  if (missing.length) throw new Error(`模板缺少变量：${[...new Set(missing)].join(", ")}`);
  const leftover = out.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) throw new Error(`模板渲染后仍有占位符：${[...new Set(leftover)].join(", ")}`);
  return out;
}

// ---------- zip ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 日期/时间（zip 头用）。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  };
}

/**
 * 生成 zip（保留 Unix 权限位；Windows 自带 Compress-Archive 会写成反斜杠路径 + 丢权限，
 * 在 Linux/macOS 上解压得到不可执行的壳）。
 * @param {{name: string, data: Buffer|string, mode?: number}[]} entries
 * @param {{mtime?: Date}} [opts]
 * @returns {Buffer}
 */
export function zipBuffer(entries, opts = {}) {
  const { time: dosTime, date: dosDate } = dosDateTime(opts.mtime || new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const deflated = deflateRaw(data);
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const mode = entry.mode ?? (nameBuf.toString().endsWith("/") ? 0o40755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags: 文件名全 ASCII，不需要 UTF-8 位
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function deflateRaw(data) {
  return zlib.deflateRawSync(data, { level: 9 });
}
