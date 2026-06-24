import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import appIcon from '../../build/icon.png?asset'
import { registerProjectIpc, seedIfEmpty } from './projects'
import { registerPtyIpc } from './pty'
import { registerMcpIpc } from './mcp'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Builder Hub',
    backgroundColor: '#0b0f17',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite sets ELECTRON_RENDERER_URL in dev (HMR); in prod we load the build.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('ping', () => 'pong')

  // Local-first data: seed the registry from the curated list on first run.
  seedIfEmpty()
  registerProjectIpc()
  registerPtyIpc()
  registerMcpIpc()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
