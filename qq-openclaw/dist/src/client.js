/**
 * 魔改替换原 client.js：构造合规 QQOfficialClient（官方 APIv2 单聊+多模态）并注册供工具/主动引擎复用。
 */
import { QQOfficialClient } from "./qq-official-client.js";
import { ensureSnowLumaSdk } from "./sdk.js";

const actionClients = new Map();

export function createSnowLumaClient(account) {
  return new QQOfficialClient({
    appId: account.appId,
    clientSecret: account.clientSecret,
    sandbox: account.sandbox,
    ownerOpenId: account.ownerOpenId,
    allowOpenIds: account.allowOpenIds,
    proactiveCooldownMin: account.proactiveCooldownMin,
    proactiveDailyMax: account.proactiveDailyMax,
    authUrl: account.authUrl,
    apiBaseUrl: account.apiBaseUrl,
    fetchImpl: account.fetchImpl,
    WSImpl: account.WSImpl,
    now: account.now,
    log: account.log,
  });
}

export function registerActionClient(accountId, client) {
  actionClients.set(accountId, client);
}
export function unregisterActionClient(accountId) {
  actionClients.delete(accountId);
}
export function tryGetActionClient(accountId) {
  return actionClients.get(accountId);
}
export function __resetActionClients() {
  actionClients.clear();
}

export async function acquireActionClient(account) {
  await ensureSnowLumaSdk();
  const live = actionClients.get(account.accountId);
  if (live) return { client: live, release: () => {} };
  const client = createSnowLumaClient(account);
  return { client, release: () => client.close() };
}

export async function detectSelfId(client) {
  try {
    const info = await client.getLoginInfo();
    return info.user_id;
  } catch {
    return undefined;
  }
}
