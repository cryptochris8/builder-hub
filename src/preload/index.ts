import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  CreateProjectOptions,
  CreateProjectResult,
  LaunchResult,
  McpServerInfo,
  Project,
  PtyCreateOptions,
  PtyData,
  PtyExit,
  RescanResult
} from '../shared/types'

// The single, typed bridge between the renderer (UI) and the main process.
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    add: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
    create: (opts: CreateProjectOptions): Promise<CreateProjectResult> =>
      ipcRenderer.invoke('projects:create', opts),
    update: (id: string, patch: Partial<Project>): Promise<Project | null> =>
      ipcRenderer.invoke('projects:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('projects:remove', id),
    rescan: (): Promise<RescanResult> => ipcRenderer.invoke('projects:rescan'),
    ensureContext: (id: string): Promise<{ seeded: boolean }> =>
      ipcRenderer.invoke('projects:ensureContext', id)
  },
  launch: {
    folder: (path: string): Promise<LaunchResult> => ipcRenderer.invoke('launch:folder', path),
    editor: (path: string): Promise<LaunchResult> => ipcRenderer.invoke('launch:editor', path),
    terminal: (path: string): Promise<LaunchResult> => ipcRenderer.invoke('launch:terminal', path),
    claude: (path: string): Promise<LaunchResult> => ipcRenderer.invoke('launch:claude', path),
    chrome: (url: string): Promise<LaunchResult> => ipcRenderer.invoke('launch:chrome', url),
    studio: (): Promise<LaunchResult> => ipcRenderer.invoke('launch:studio'),
    roblox: (input: string): Promise<LaunchResult> => ipcRenderer.invoke('launch:roblox', input)
  },
  terminal: {
    create: (opts: PtyCreateOptions): Promise<string> => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:input', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (cb: (p: PtyData) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: PtyData): void => cb(p)
      ipcRenderer.on('pty:data', h)
      return () => ipcRenderer.removeListener('pty:data', h)
    },
    onExit: (cb: (p: PtyExit) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: PtyExit): void => cb(p)
      ipcRenderer.on('pty:exit', h)
      return () => ipcRenderer.removeListener('pty:exit', h)
    }
  },
  system: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
    homeDir: (): Promise<string> => ipcRenderer.invoke('system:homeDir')
  },
  mcp: {
    list: (): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:list')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type HubApi = typeof api
