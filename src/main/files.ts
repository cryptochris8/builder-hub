import { app, clipboard, ipcMain, net, protocol, shell } from 'electron'
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join, normalize } from 'path'
import { pathToFileURL } from 'url'
import { allProjects } from './db'
import { classifyFile, isPathInside } from '../shared/hubLogic'
import type { FileEntry, ListDirResult, PasteResult, ReadTextResult } from '../shared/types'

// In-app file browsing/preview + clipboard support for the embedded terminal.
// Everything file-serving is gated by isAllowedPath(): only registered project
// folders (plus our paste-temp dir) are reachable from the renderer, so a
// compromised webview/renderer can't use these IPCs to read arbitrary disk.

const LIST_CAP = 1500
const TEXT_CAP = 512 * 1024 // read at most 512 KB of a text file
const SNIFF_BYTES = 8192

function pasteDir(): string {
  return join(app.getPath('temp'), 'builder-hub-paste')
}

// Canonicalize so symlinks/junctions inside a project can't smuggle reads from
// outside it. Nonexistent paths are denied (every caller targets existing files).
function canon(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

export function isAllowedPath(p: string): boolean {
  const real = canon(p)
  if (!real) return false
  const paste = canon(pasteDir())
  if (paste && isPathInside(real, paste)) return true
  return allProjects().some((proj) => isPathInside(real, canon(proj.path) ?? proj.path))
}

// ---------- listing ----------

function listDir(dir: string): ListDirResult {
  const path = normalize(dir)
  if (!isAllowedPath(path)) return { ok: false, entries: [], error: 'Path is outside your projects' }
  try {
    const dirents = readdirSync(path, { withFileTypes: true })
    const entries: FileEntry[] = []
    for (const d of dirents) {
      const full = join(path, d.name)
      const isDir = d.isDirectory()
      if (!isDir && !d.isFile()) continue // skip sockets/junctions oddities
      let size = 0
      if (!isDir) {
        try {
          size = statSync(full).size
        } catch {
          continue // vanished or unreadable — skip
        }
      }
      entries.push({
        name: d.name,
        path: full,
        isDir,
        size,
        kind: isDir ? 'other' : classifyFile(d.name)
      })
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    const truncated = entries.length > LIST_CAP
    return { ok: true, entries: truncated ? entries.slice(0, LIST_CAP) : entries, truncated }
  } catch (e) {
    return { ok: false, entries: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- text preview ----------

function readText(file: string): ReadTextResult {
  const path = normalize(file)
  if (!isAllowedPath(path)) return { ok: false, error: 'Path is outside your projects' }
  try {
    const size = statSync(path).size
    const toRead = Math.min(size, TEXT_CAP)
    const buf = Buffer.alloc(toRead)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, toRead, 0)
    } finally {
      closeSync(fd)
    }
    // UTF-16 BOMs first (PowerShell's Out-File default) — a NUL sniff would
    // misread these everyday Windows text files as binary.
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      const body = buf.subarray(2, 2 + ((buf.length - 2) & ~1)) // even byte count
      return { ok: true, content: body.toString('utf16le'), truncated: size > TEXT_CAP }
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)))
      body.swap16() // Node has no utf16be — swap to LE
      return { ok: true, content: body.toString('utf16le'), truncated: size > TEXT_CAP }
    }
    // Binary sniff: a NUL byte in the head means this isn't text.
    const head = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length))
    if (head.includes(0)) return { ok: false, error: 'Binary file — use Open externally' }
    return { ok: true, content: buf.toString('utf8'), truncated: size > TEXT_CAP }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- clipboard → terminal paste ----------

// Smart paste for the terminal. Text wins when both are present — Excel/Word/
// browser copies put a bitmap rendering alongside the text, and the user almost
// always means the text. A pure image (Win+Shift+S screenshot, copied image) is
// saved as a temp PNG so its path can be handed to Claude (vision input).
function readClipboardForPaste(): PasteResult {
  const text = clipboard.readText()
  if (text) return { kind: 'text', text }
  try {
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
      const dir = pasteDir()
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `paste-${Date.now()}.png`)
      writeFileSync(file, img.toPNG())
      return { kind: 'image', path: file }
    }
  } catch {
    /* unreadable image format */
  }
  return { kind: 'empty' }
}

// Pasted screenshots are only needed within the session that pasted them —
// sweep the previous sessions' PNGs at startup so %TEMP% doesn't accumulate a
// disk-resident history of everything ever pasted.
function purgePasteDir(): void {
  try {
    rmSync(pasteDir(), { recursive: true, force: true })
  } catch {
    /* locked or already gone — best-effort */
  }
}

// ---------- hubfile:// protocol (images / video / audio served from disk) ----------

// Must run before app.whenReady() — called from main/index.ts at module load.
export function registerHubfileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'hubfile', privileges: { stream: true, supportFetchAPI: true } }
  ])
}

// Call after app.whenReady().
export function registerHubfileProtocol(): void {
  protocol.handle('hubfile', (req) => {
    try {
      const url = new URL(req.url)
      let p = decodeURIComponent(url.pathname)
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1) // "/C:/…" → "C:/…"
      p = normalize(p)
      if (!isAllowedPath(p)) return new Response('Forbidden', { status: 403 })
      // Forward headers so Range requests work — without it, seeking in large
      // video/audio restarts the stream from byte 0.
      return net.fetch(pathToFileURL(p).toString(), { headers: req.headers })
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

// ---------- IPC ----------

export function registerFilesIpc(): void {
  purgePasteDir()
  ipcMain.handle('fs:list', (_e, dir: string) => listDir(dir))
  ipcMain.handle('fs:readText', (_e, file: string) => readText(file))
  ipcMain.handle('fs:openExternal', async (_e, file: string) => {
    const path = normalize(file)
    if (!isAllowedPath(path)) return { ok: false, error: 'Path is outside your projects' }
    const err = await shell.openPath(path)
    return err ? { ok: false, error: err } : { ok: true }
  })
  ipcMain.handle('fs:showInFolder', (_e, file: string) => {
    const path = normalize(file)
    if (!isAllowedPath(path)) return { ok: false, error: 'Path is outside your projects' }
    shell.showItemInFolder(path)
    return { ok: true }
  })
  ipcMain.handle('clipboard:readForPaste', () => readClipboardForPaste())
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text ?? '')
    return true
  })
}
