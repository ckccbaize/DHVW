import { app, session } from 'electron'

/**
 * 国内网络的硬约束：外壳不主动访问公网。
 * 关闭 Chromium 的后台联网、组件更新、域名可靠性上报与崩溃上报；
 * 渲染层只加载包内资源，任何第三方 CDN/字体/遥测都不会被请求。
 */
export function applyNetworkHardening(): void {
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-component-update')
  app.commandLine.appendSwitch('disable-domain-reliability')
  app.commandLine.appendSwitch('disable-client-side-phishing-detection')
  app.commandLine.appendSwitch('disable-breakpad')
  app.commandLine.appendSwitch('no-pings')
  app.commandLine.appendSwitch(
    'disable-features',
    'MediaRouter,OptimizationHints,Translate,AutofillServerCommunication,InterestFeedContentSuggestions',
  )
}

/** 必须在 app ready 之后调用。 */
export function hardenSessionSetup(): void {
  session.defaultSession.setSpellCheckerEnabled(false)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}
