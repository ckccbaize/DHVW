import { Menu, Tray, nativeImage } from 'electron'
import { appIconPath } from './paths'

interface TrayHooks {
  onShow: () => void
  onQuit: () => void
  onRestartHost: () => void
}

let tray: Tray | null = null

function icon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(appIconPath())
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 })
}

export function createTray(hooks: TrayHooks): Tray {
  tray = new Tray(icon())
  tray.setToolTip('DHVW 主机端')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主面板', click: hooks.onShow },
      { label: '重启服务宿主', click: hooks.onRestartHost },
      { type: 'separator' },
      { label: '退出', click: hooks.onQuit },
    ]),
  )
  tray.on('double-click', hooks.onShow)
  return tray
}
