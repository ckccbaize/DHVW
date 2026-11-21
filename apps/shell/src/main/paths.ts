import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// 数据目录固定为 %APPDATA%/DigitalHuman，与文档一致；setName 只影响展示，不改变路径。
// DHVW_DATA_DIR 用于隔离测试与便携部署（与编排器同名变量保持一致）。
export const dataDir = process.env.DHVW_DATA_DIR
  ? path.resolve(process.env.DHVW_DATA_DIR)
  : path.join(app.getPath('appData'), 'DigitalHuman')
export const logDir = path.join(dataDir, 'logs')

/**
 * 编排器/角色的数据根：外壳落在 <dataDir>/data，编排器用 DHVW_DATA_DIR 指同一处。
 * 两者必须同源，否则像素角色、场景、记忆会分裂到两个目录。
 */
export const orchDataDir = path.join(dataDir, 'data')

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

ensureDir(dataDir)
ensureDir(logDir)

const isPackaged = app.isPackaged

/** 开发期：apps/shell/dist-electron/main → 仓库根；打包后：resources 目录 */
export function resourcesRoot(): string {
  return isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), '../..')
}

/** 安装根目录：打包后是 exe 所在目录，开发期是 apps/shell */
export function installRoot(): string {
  return isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()
}

/**
 * 应用图标 PNG：托盘与窗口共用同一份来源。
 * 打包后由 electron-builder 的 extraResources 拷到 resources/icon.png；
 * 开发期直接读 build/icon.png。换图标只改 build/icon.png。
 */
export function appIconPath(): string {
  return isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(resourcesRoot(), 'apps', 'shell', 'build', 'icon.png')
}

/**
 * 组件目录（OLVT 本体、ASR 模型、本地大模型）。
 *
 * **必须落在用户数据目录**：NSIS 升级时会把整个安装目录删掉再解包，
 * 组件放安装目录会导致每次更新都重下 OLVT 与 229 MB 的 ASR 模型（ADR-PC-019 修订）。
 */
export function componentsRoot(): string {
  return path.join(dataDir, 'components')
}

/** 旧版组件位置（安装目录内）：升级后仅用于「发现并迁移」，不再往里写新内容 */
export function legacyComponentsRoot(): string {
  return path.join(resourcesRoot(), 'components')
}

/** 内置 CPython 运行时：打包在 resources/runtime，开发期在 apps/shell/runtime */
export function runtimeDir(): string {
  return isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(app.getAppPath(), 'runtime')
}

/** 随包的数据文件目录（打包后 resources/，开发期 apps/shell/resources/） */
export function bundledResourceDir(): string {
  return isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

/** 随包的 OLVT 补丁 */
export function overridesRoot(): string {
  return path.join(bundledResourceDir(), 'olvt-overrides')
}

export function hostModuleRoot(): string {
  return path.join(resourcesRoot(), 'services', 'host')
}

export function rendererIndex(): string {
  return path.join(app.getAppPath(), 'dist', 'index.html')
}

export function shellLogFile(): string {
  return path.join(logDir, 'shell.jsonl')
}
