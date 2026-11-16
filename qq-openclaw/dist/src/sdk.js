/**
 * 魔改替换原 @snowluma/sdk 动态加载层：不再加载违规的 NTQQ OneBot SDK，
 * 而是直接提供兼容的消息链构造器（chain/text/image/record/reply/parseSegments）与 QQOfficialClient。
 */
import { QQOfficialClient } from "./qq-official-client.js";

class LocalMessageChain {
  constructor(items = []) {
    this.items = items;
  }
  text(value = "") {
    return new LocalMessageChain([...this.items, { type: "text", data: { text: String(value) } }]);
  }
  image(file) {
    return new LocalMessageChain([...this.items, { type: "image", data: { file: String(file) } }]);
  }
  record(file) {
    return new LocalMessageChain([...this.items, { type: "record", data: { file: String(file) } }]);
  }
  reply(id) {
    return new LocalMessageChain([...this.items, { type: "reply", data: { id: String(id) } }]);
  }
  at(qq) {
    return this.text(`@${qq} `);
  }
  toSegments() {
    return [...this.items];
  }
}

const compatSdk = {
  SnowLumaWebSocketClient: QQOfficialClient,
  SnowLumaHttpClient: QQOfficialClient,
  chain: () => new LocalMessageChain(),
  text: (v = "") => new LocalMessageChain().text(v),
  image: (f) => new LocalMessageChain().image(f),
  record: (f) => new LocalMessageChain().record(f),
  reply: (id) => new LocalMessageChain().reply(id),
  parseSegments: (raw) => (typeof raw === "string" && raw ? [{ type: "text", data: { text: raw } }] : []),
};

export async function ensureSnowLumaSdk() {
  return compatSdk;
}

export function getSnowLumaSdk() {
  return compatSdk;
}

export function tryGetSnowLumaSdk() {
  return compatSdk;
}
