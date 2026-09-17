import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  CapabilityMatch,
  ClaudeStatusEvent,
  ContextFreshness,
  CreateProjectOptions,
  CreateProjectResult,
  CreatorStack,
  CreatorStackEntry,
  HandoffPacket,
  ProjectContext,
  ProjectContextPatch,
  SessionRecord,
  StatusLineInfo,
  GitActionResult,
  GitStatus,
  HandoffInput,
  HandoffSaveResult,
  HubSettings,
  SettingsSaveResult,
  LaunchResult,
  ListDirResult,
  McpActionResult,
  McpListLive,
  McpScope,
  McpServerInfo,
  McpTransport,
  PasteResult,
  Project,
  ProjectPatch,
  PtyCreateOptions,
  PtyData,
  PtyExit,
  ReadTextResult,
  RescanResult,
  WorktreeCreateResult,
  WorktreeDiffResult,
  WorktreeInfo
} from '../shared/types'

// The single, typed bridge between the renderer (UI) and the main process.
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    add: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
    create: (opts: CreateProjectOptions): Promise<CreateProjectResult> =>
      ipcRenderer.invoke('projects:create', opts),
    update: (id: string, patch: ProjectPatch): Promise<Project | null> =>
      ipcRenderer.invoke('projects:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('projects:remove', id),
    rescan: (): Promise<RescanResult> => ipcRenderer.invoke('projects:rescan'),
    ensureContext: (id: string): Promise<{ seeded: boolean }> =>
      ipcRenderer.invoke('projects:ensureContext', id),
    touch: (id: string): Promise<Project | null> => ipcRenderer.invoke('projects:touch', id)
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
  settings: {
    get: (): Promise<HubSettings> => ipcRenderer.invoke('settings:get'),
    /** Only ever a mode string — main re-validates it against the allowlist before
     *  it can reach the `claude` argv. The renderer never passes flags. */
    set: (patch: Partial<HubSettings>): Promise<SettingsSaveResult> =>
      ipcRenderer.invoke('settings:set', patch)
  },
  system: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
    homeDir: (): Promise<string> => ipcRenderer.invoke('system:homeDir'),
    /** Absolute path of a File dropped onto the window (File.path is gone in Electron 32+). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  fs: {
    list: (dir: string): Promise<ListDirResult> => ipcRenderer.invoke('fs:list', dir),
    readText: (file: string): Promise<ReadTextResult> => ipcRenderer.invoke('fs:readText', file),
    /** true when the path is inside a registered project (Viewer file: URLs) */
    isAllowed: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:isAllowed', p),
    openExternal: (file: string): Promise<LaunchResult> => ipcRenderer.invoke('fs:openExternal', file),
    showInFolder: (file: string): Promise<LaunchResult> => ipcRenderer.invoke('fs:showInFolder', file)
  },
  clipboard: {
    readForPaste: (): Promise<PasteResult> => ipcRenderer.invoke('clipboard:readForPaste'),
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text)
  },
  mcp: {
    list: (): Promise<McpServerInfo[]> => ipcRenderer.invoke('mcp:list'),
    live: (): Promise<McpListLive> => ipcRenderer.invoke('mcp:live'),
    add: (opts: {
      name: string
      url: string
      transport?: McpTransport
      scope?: McpScope
      headerName?: string
      token?: string
    }): Promise<McpActionResult> => ipcRenderer.invoke('mcp:add', opts),
    remove: (name: string, scope?: McpScope): Promise<McpActionResult> =>
      ipcRenderer.invoke('mcp:remove', name, scope),
    login: (name: string): Promise<McpActionResult> => ipcRenderer.invoke('mcp:login', name),
    logout: (name: string): Promise<McpActionResult> => ipcRenderer.invoke('mcp:logout', name)
  },
  git: {
    statuses: (items: { id: string; path: string }[]): Promise<Record<string, GitStatus>> =>
      ipcRenderer.invoke('git:statuses', items)
  },
  claude: {
    /** live session-state events fed by Claude Code hooks (working/waiting/done/ended) */
    onStatus: (cb: (e: ClaudeStatusEvent) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: ClaudeStatusEvent): void => cb(p)
      ipcRenderer.on('claude:status', h)
      return () => ipcRenderer.removeListener('claude:status', h)
    },
    hooksInfo: (): Promise<{ listening: boolean; port: number; error?: string; installError?: string }> =>
      ipcRenderer.invoke('hooks:info')
  },
  handoff: {
    /** Generate + save a Claude Code handoff into <project>/handoffs/. */
    save: (projectId: string, input: HandoffInput): Promise<HandoffSaveResult> =>
      ipcRenderer.invoke('handoff:save', projectId, input)
  },
  // ---------- 2026-09 upgrade: session board · routing · context · creator stack ----------
  board: {
    /** every session the Hub knows about (live + recently ended), newest first */
    list: (): Promise<SessionRecord[]> => ipcRenderer.invoke('board:list'),
    onChange: (cb: (rows: SessionRecord[]) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, rows: SessionRecord[]): void => cb(rows)
      ipcRenderer.on('hub:board', h)
      return () => ipcRenderer.removeListener('hub:board', h)
    },
    lock: (sessionId: string, locked: boolean): Promise<SessionRecord | null> =>
      ipcRenderer.invoke('board:lock', sessionId, locked),
    dismiss: (sessionId: string): Promise<SessionRecord | null> =>
      ipcRenderer.invoke('board:dismiss', sessionId),
    recommend: (sessionId: string): Promise<SessionRecord | null> =>
      ipcRenderer.invoke('board:recommend', sessionId),
    /** type /model + /effort into the idle embedded session (main gates it) */
    apply: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('board:apply', sessionId),
    /** persist the recommendation as the project's / task's session profile */
    applyAtLaunch: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('board:applyAtLaunch', sessionId),
    /** v1.1: refresh context size, clear a dismissal and recompute the recommendation */
    reassess: (sessionId: string): Promise<SessionRecord | null> =>
      ipcRenderer.invoke('board:reassess', sessionId),
    /** v1.1: publish a handoff, then switch (typed now when safe, else saved for the next launch) */
    handoffAndSwitch: (
      sessionId: string
    ): Promise<{ ok: boolean; error?: string; path?: string; switched?: 'now' | 'launch' | 'none' }> =>
      ipcRenderer.invoke('board:handoffAndSwitch', sessionId)
  },
  context: {
    get: (
      projectId: string
    ): Promise<{
      context: ProjectContext | null
      freshness: ContextFreshness | null
      filePath: string
    } | null> => ipcRenderer.invoke('context:get', projectId),
    update: (projectId: string, patch: ProjectContextPatch): Promise<ProjectContext | null> =>
      ipcRenderer.invoke('context:update', projectId, patch),
    /** deterministic rescan of the project folder (zero tokens) */
    reindex: (
      projectId: string
    ): Promise<{ context: ProjectContext; freshness: ContextFreshness; filePath: string } | null> =>
      ipcRenderer.invoke('context:reindex', projectId),
    /** re-probe freshness only */
    refresh: (projectId: string): Promise<ContextFreshness | null> =>
      ipcRenderer.invoke('context:refresh', projectId),
    /** main re-probes at every SessionStart (and on Reindex/refresh) — the latest verdict per project */
    onFreshness: (cb: (p: { projectId: string; freshness: ContextFreshness }) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { projectId: string; freshness: ContextFreshness }): void => cb(p)
      ipcRenderer.on('hub:freshness', h)
      return () => ipcRenderer.removeListener('hub:freshness', h)
    },
    packet: (projectId: string): Promise<{ packet: HandoffPacket; markdown: string } | null> =>
      ipcRenderer.invoke('context:packet', projectId),
    publishHandoff: (
      projectId: string,
      overrides?: Partial<HandoffPacket>,
      /** the session the handoff is for (a SessionBar knows it); else the project's latest */
      sessionId?: string
    ): Promise<HandoffSaveResult> =>
      ipcRenderer.invoke('context:publishHandoff', projectId, overrides, sessionId)
  },
  creatorStack: {
    list: (): Promise<{ stack: CreatorStack; filePath: string }> => ipcRenderer.invoke('creatorStack:list'),
    reindex: (): Promise<CreatorStack> => ipcRenderer.invoke('creatorStack:reindex'),
    upsert: (entry: CreatorStackEntry): Promise<CreatorStack | null> =>
      ipcRenderer.invoke('creatorStack:upsert', entry),
    remove: (id: string): Promise<CreatorStack> => ipcRenderer.invoke('creatorStack:remove', id),
    /** what Claude would be pointed at for this text */
    find: (query: string): Promise<CapabilityMatch[]> => ipcRenderer.invoke('creatorStack:find', query)
  },
  statusLine: {
    info: (): Promise<StatusLineInfo> => ipcRenderer.invoke('statusline:info'),
    set: (install: boolean): Promise<StatusLineInfo> => ipcRenderer.invoke('statusline:set', install)
  },
  worktrees: {
    list: (projectPath: string): Promise<WorktreeInfo[]> => ipcRenderer.invoke('worktree:list', projectPath),
    create: (projectPath: string, task: string): Promise<WorktreeCreateResult> =>
      ipcRenderer.invoke('worktree:create', projectPath, task),
    diff: (projectPath: string, worktreePath: string): Promise<WorktreeDiffResult> =>
      ipcRenderer.invoke('worktree:diff', projectPath, worktreePath),
    merge: (projectPath: string, branch: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('worktree:merge', projectPath, branch),
    remove: (
      projectPath: string,
      worktreePath: string,
      branch: string,
      force: boolean
    ): Promise<GitActionResult> =>
      ipcRenderer.invoke('worktree:remove', projectPath, worktreePath, branch, force)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type HubApi = typeof api
