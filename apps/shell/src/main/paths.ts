import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// 数据目录固定为 %APPDATA%/DigitalHuman，与文档一致；setName 只影响展示，不改变路径。
export const dataDir = path.join(app.getPath('appData'), 'DigitalHuman')
export const logDir = path.join(dataDir, 'logs')

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
 * 组件与依赖等“运行环境”目录，必须落在安装根目录内（resources/components），
 * 这样卸载时会随安装目录一起删除，不在用户机器上散落（ADR-PC-019）。
 */
export function componentsRoot(): string {
  return path.join(resourcesRoot(), 'components')
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
