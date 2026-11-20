/**
 * 构造合规官方通道客户端：默认 QQOfficialClient（官方 Bot APIv2），当 account.channelType === "feishu" 时构造 FeishuClient。
 */
import { FeishuClient } from "./feishu-client.js";
import { QQOfficialClient } from "./qq-official-client.js";
import { ensureSnowLumaSdk } from "./sdk.js";

const actionClients = new Map();

export function createSnowLumaClient(account) {
  if (String(account?.channelType || "").toLowerCase() === "feishu") {
    return new FeishuClient({
      appId: account.appId,
      appSecret: account.appSecret || account.clientSecret,
      ownerOpenId: account.ownerOpenId,
      allowOpenIds: account.allowOpenIds,
      autoPairFirst: account.autoPairFirst !== false,
      onPaired: account.onPaired,
      apiBaseUrl: account.apiBaseUrl,
      wsEndpointUrl: account.wsEndpointUrl,
      fetchImpl: account.fetchImpl,
      WSImpl: account.WSImpl,
      now: account.now,
      log: account.log,
    });
  }
  return new QQOfficialClient({
    appId: account.appId,
    clientSecret: account.clientSecret,
    sandbox: account.sandbox,
    ownerOpenId: account.ownerOpenId,
    allowOpenIds: account.allowOpenIds,
    autoPairFirst: account.autoPairFirst !== false,
    onPaired: account.onPaired,
    proactiveCooldownMin: account.proactiveCooldownMin,
    proactiveDailyMax: account.proactiveDailyMax,
    ledgerStateFile: account.ledgerStateFile,
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
