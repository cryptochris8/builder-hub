import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import appIcon from '../../build/icon.png?asset'
import { registerProjectIpc, seedIfEmpty } from './projects'
import { registerPtyIpc, killAllPtys } from './pty'
import { registerMcpIpc } from './mcp'
import { registerGitIpc } from './git'
import { isAllowedPath, registerFilesIpc, registerHubfileProtocol, registerHubfileScheme } from './files'
import { registerHubContext } from './hubContext'
import { ensureHooksInstalled, registerHookIpc, startHookServer, stopHookServer } from './hookServer'
import { registerWorktreeIpc } from './worktrees'
import { registerHandoffIpc } from './handoff'
import { registerSettingsIpc } from './settings'
import { registerOrchestrator } from './orchestrator'
import { ensureStatusLineForSettings, registerStatusLineIpc } from './statusLine'
import { getSettings } from './settings'

// Custom scheme privileges must be declared before the app is ready.
registerHubfileScheme()

// One Hub only: the hook listener binds a fixed port, and a second instance
// would silently lose the status-board feature. Focus the first instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

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

  // Never let the app window itself navigate away (e.g. a file dropped outside a
  // drop zone would navigate the whole UI to file:///…). Reloads of our own URL
  // are still allowed.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const appUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url === appUrl
    if (!allowed) e.preventDefault()
  })

  // electron-vite sets ELECTRON_RENDERER_URL in dev (HMR); in prod we load the build.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Validate every <webview> before it attaches: strip any preload, force isolation,
// and only allow web URLs (Viewer) or file: URLs inside registered projects (PDF
// preview) — so renderer code can't mint a webview that reads arbitrary disk.
app.on('web-contents-created', (_e, contents) => {
  // A target=_blank / window.open inside an embedded Viewer must not spawn a bare
  // BrowserWindow: load it in the same guest (stays inside the Hub) — web URLs only.
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void contents.loadURL(url)
      return { action: 'deny' }
    })
    // A page inside a project may link to other local files; keep every file:
    // navigation (main frame, subframes/iframes, redirects) inside registered
    // projects — the same rule the attach guard and the address bar apply. Web
    // navigations are untouched.
    const guardFileNav = (event: { preventDefault: () => void }, url: string): void => {
      try {
        const u = new URL(url)
        if (u.protocol === 'file:' && !isAllowedPath(fileURLToPath(u))) event.preventDefault()
        else if (!['http:', 'https:', 'file:', 'about:'].includes(u.protocol)) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    }
    contents.on('will-navigate', guardFileNav)
    contents.on('will-redirect', guardFileNav)
    // will-navigate covers the main frame only; an <iframe src="file:///…"> inside
    // an in-project page renders inline without it.
    contents.on('will-frame-navigate', (details) => guardFileNav(details, details.url))
  }
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    try {
      const url = new URL(params.src ?? 'about:blank')
      if (url.protocol === 'file:') {
        if (!isAllowedPath(fileURLToPath(url))) event.preventDefault()
      } else if (!['http:', 'https:', 'about:'].includes(url.protocol)) {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })
})

app.whenReady().then(() => {
  // Must match electron-builder.yml appId, or packaged-build toasts won't show.
  if (process.platform === 'win32') app.setAppUserModelId('com.athletedomains.builderhub')

  ipcMain.handle('ping', () => 'pong')

  // Local-first data: seed the registry from the curated list on first run.
  seedIfEmpty()
  // Keep ~/.claude/builder-hub-projects.md (+ the marked block in ~/.claude/CLAUDE.md)
  // in sync so every Claude session can see and refer to all projects.
  registerHubContext()
  registerProjectIpc()
  registerSettingsIpc()
  registerPtyIpc()
  registerMcpIpc()
  registerGitIpc()
  registerFilesIpc()
  registerHubfileProtocol()
  registerWorktreeIpc()
  registerHandoffIpc()
  // Cockpit: Claude Code hooks POST session state to a localhost listener, and
  // the hook commands are (idempotently) wired into ~/.claude/settings.json.
  registerHookIpc()
  // Orchestration layer: session board, persistent context, creator stack, router.
  registerOrchestrator()
  registerStatusLineIpc()
  startHookServer()
  const hookInstall = ensureHooksInstalled()
  if (hookInstall.error) console.error('[builder-hub] hook wiring failed:', hookInstall.error)
  // v1.1: exact context-window data for switching cost (on by default; see statusLine.ts).
  ensureStatusLineForSettings(getSettings().statusLineTelemetry)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Don't leave embedded terminal processes running after the app exits.
app.on('will-quit', () => {
  killAllPtys()
  stopHookServer()
})
