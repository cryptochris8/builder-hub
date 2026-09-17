import { app, BrowserWindow, Notification, ipcMain } from 'electron'
import { createServer } from 'http'
import type { Server } from 'http'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { allProjects } from './db'
import {
  HUB_HOOK_PORT,
  ensureHubHooks,
  resolveSessionProject,
  stateForHookEvent
} from '../shared/sessionLogic'
import type { ClaudeStatusEvent } from '../shared/types'
import { handleHook, handleStatusLine } from './orchestrator'

// Tier-2 cockpit, part (a): Claude Code hooks → Hub notifications.
//
// Claude Code (any session — embedded or external) runs a tiny curl on
// UserPromptSubmit / Stop / Notification / SessionEnd that POSTs the hook's
// stdin JSON to 127.0.0.1:44711/hook. The Hub broadcasts the derived state to
// the renderer (status dots + rail) and raises a native OS notification when a
// session needs you and the Hub window isn't focused.
//
// The listener replies 204 with an EMPTY body by default: curl prints the
// response body to stdout, and Claude Code interprets hook stdout (a JSON
// "decision" on Stop could block Claude from stopping). Silence is safety.
// The orchestrator (2026-09 upgrade) answers a few events ON PURPOSE with hook
// JSON — SessionStart context, UserPromptSubmit tool cards, PreToolUse conflict
// warnings — and only ever with additionalContext/systemMessage, never a
// decision. /statusline (opt-in) answers plain text for Claude's status bar.

// PostToolUse payloads embed tool_response (a Read of a big file, a long Bash
// stdout); the board only needs their tool_name/tool_input, but the whole body
// must fit or the event is lost. Loopback-only, so 4 MB is a safe ceiling.
const MAX_BODY = 4 * 1024 * 1024

let server: Server | null = null
let listenError: string | null = null

interface HookPayload {
  hook_event_name?: string
  cwd?: string
  message?: string
  session_id?: string
}

function broadcast(event: ClaudeStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('claude:status', event)
  }
}

function anyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => w.isFocused())
}

// Throttle OS toasts per cwd so a hook loop (or a spoofing local process) can't
// flood the notification center.
const lastToast = new Map<string, number>()
const TOAST_GAP_MS = 8_000

function notifyOs(state: 'waiting' | 'done', cwd: string, message?: string): void {
  if (anyWindowFocused() || !Notification.isSupported()) return
  const key = cwd.toLowerCase()
  const last = lastToast.get(key) ?? 0
  if (Date.now() - last < TOAST_GAP_MS) return
  lastToast.set(key, Date.now())
  const { label } = resolveSessionProject(cwd, allProjects())
  const n = new Notification({
    title: state === 'waiting' ? `Claude is waiting — ${label}` : `Claude finished — ${label}`,
    body: message ?? (state === 'waiting' ? 'A session needs your input.' : 'The turn is complete.'),
    silent: state === 'done' // only the "needs you" case gets a sound
  })
  n.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  n.show()
}

function handlePayload(payload: HookPayload): void {
  // Everything here is untrusted input (any local process can POST) — validate
  // types before use so a junk payload can't throw in the renderer listener.
  const state = stateForHookEvent(typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '')
  if (!state || typeof payload.cwd !== 'string' || !payload.cwd) return
  const message = typeof payload.message === 'string' ? payload.message : undefined
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined
  broadcast({ cwd: payload.cwd, state, message, sessionId, at: Date.now() })
  if (state === 'waiting' || state === 'done') notifyOs(state, payload.cwd, message)
}

export function startHookServer(): void {
  server = createServer((req, res) => {
    // Browsers attach an Origin header to cross-origin POSTs; our curl never
    // does. Rejecting it closes the drive-by-web-page spoofing vector.
    const route = req.url === '/hook' ? 'hook' : req.url === '/statusline' ? 'statusline' : null
    if (req.method !== 'POST' || !route || req.headers.origin) {
      res.writeHead(req.headers.origin ? 403 : 404)
      res.end()
      return
    }
    // Accumulate raw bytes and decode ONCE — per-chunk toString can split a
    // multi-byte UTF-8 char and corrupt the JSON.
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      let payload: Record<string, unknown> | null = null
      if (!overflow) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            payload = parsed as Record<string, unknown>
        } catch {
          /* malformed hook payload — ignore */
        }
      }
      if (route === 'statusline') {
        const text = payload ? handleStatusLine(payload) : ''
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(text)
        return
      }
      let reply: Record<string, unknown> | undefined
      if (payload) {
        try {
          handlePayload(payload as HookPayload) // legacy status board + OS toasts
        } catch (e) {
          console.error('[builder-hub] hook status error:', e)
        }
        reply = (await handleHook(payload)).response // session board + context/tool/conflict replies (never throws)
      }
      if (reply) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(reply))
      } else {
        res.writeHead(204) // empty body — see header comment
        res.end()
      }
    })
    req.on('error', () => {
      /* client vanished — nothing to do */
    })
  })
  server.on('error', (e: NodeJS.ErrnoException) => {
    listenError = e.code === 'EADDRINUSE' ? `Port ${HUB_HOOK_PORT} is in use` : (e.message ?? 'listen failed')
    server = null
  })
  server.listen(HUB_HOOK_PORT, '127.0.0.1')
}

export function stopHookServer(): void {
  server?.close()
  server = null
}

// ---------- wiring Claude Code's settings.json ----------

function settingsPath(): string {
  return join(app.getPath('home'), '.claude', 'settings.json')
}

let installError: string | null = null

// Idempotently add/upgrade our hook commands in ~/.claude/settings.json (atomic
// write, .bak of the previous version). A file we can't parse is left untouched
// and the error is surfaced via hooks:info (Connections panel).
export function ensureHooksInstalled(): { changed: boolean; error?: string } {
  try {
    const file = settingsPath()
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const { next, changed, error } = ensureHubHooks(current)
    if (error) {
      installError = error
      return { changed: false, error }
    }
    if (!changed) {
      installError = null
      return { changed: false }
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, next, 'utf8')
    try {
      if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    } catch {
      /* best-effort backup */
    }
    renameSync(tmp, file)
    installError = null
    return { changed: true }
  } catch (e) {
    installError = e instanceof Error ? e.message : String(e)
    return { changed: false, error: installError }
  }
}

export function registerHookIpc(): void {
  ipcMain.handle('hooks:info', () => ({
    listening: server !== null && server.listening,
    port: HUB_HOOK_PORT,
    error: listenError ?? undefined,
    installError: installError ?? undefined
  }))
}
