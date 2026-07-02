import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { prettyBytes } from '@shared/projectLogic'
import { hub } from '@/lib/api'

// In-app file browser + preview for one project: images/video/audio render
// inline (served over the hubfile:// protocol), text/code in a viewer, PDFs in
// an embedded webview — and any file's path can be handed straight to Claude.

/** Serve a disk path through the main process's guarded hubfile:// protocol. */
function hubfileUrl(p: string): string {
  return 'hubfile:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

const KIND_ICON: Record<string, string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  pdf: '📕',
  text: '📄',
  other: '▫'
}

// Heavy folders stay listed but load lazily anyway; just dim them.
const DIM_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next'])

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'

export function FilesPane({
  root,
  active,
  onSendToClaude
}: {
  root: string
  active: boolean
  onSendToClaude: (text: string) => void
}) {
  const [dirCache, setDirCache] = useState<Record<string, FileEntry[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]))
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [sent, setSent] = useState(false)

  const loadDir = useCallback(async (dir: string): Promise<void> => {
    const res = await hub.fs.list(dir)
    if (res.ok) {
      setDirCache((prev) => ({ ...prev, [dir]: res.entries }))
      setErrors((prev) => {
        if (!(dir in prev)) return prev
        const next = { ...prev }
        delete next[dir]
        return next
      })
    } else {
      setErrors((prev) => ({ ...prev, [dir]: res.error ?? 'Could not read folder' }))
    }
  }, [])

  useEffect(() => {
    void loadDir(root)
  }, [root, loadDir])

  const toggleDir = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) {
        next.delete(dir)
      } else {
        next.add(dir)
        if (!dirCache[dir]) void loadDir(dir)
      }
      return next
    })
  }

  const refresh = (): void => {
    setDirCache({})
    setErrors({})
    void loadDir(root)
    for (const dir of expanded) if (dir !== root) void loadDir(dir)
  }

  const sendToClaude = (p: string): void => {
    onSendToClaude(`"${p}" `)
    setSent(true)
    window.setTimeout(() => setSent(false), 1500)
  }

  const Row = ({ entry, depth }: { entry: FileEntry; depth: number }): React.JSX.Element => {
    const isOpen = entry.isDir && expanded.has(entry.path)
    const isSelected = selected?.path === entry.path
    const dim = entry.isDir && DIM_DIRS.has(entry.name)
    return (
      <>
        <div
          onClick={() => (entry.isDir ? toggleDir(entry.path) : setSelected(entry))}
          onDoubleClick={() => {
            if (!entry.isDir && entry.kind === 'other') void hub.fs.openExternal(entry.path)
          }}
          title={entry.path}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          className={`flex cursor-pointer items-center gap-1.5 rounded py-[3px] pr-2 text-xs ${
            isSelected
              ? 'bg-indigo-500/20 text-white'
              : dim
                ? 'text-slate-600 hover:bg-white/5'
                : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <span className="w-3 shrink-0 text-center text-slate-500">
            {entry.isDir ? (isOpen ? '▾' : '▸') : KIND_ICON[entry.kind]}
          </span>
          <span className="truncate">{entry.name}</span>
          {!entry.isDir && (
            <span className="ml-auto shrink-0 text-[10px] text-slate-600">{prettyBytes(entry.size)}</span>
          )}
        </div>
        {isOpen && (
          <div>
            {errors[entry.path] && (
              <div
                style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
                className="py-1 text-[11px] text-rose-400/80"
              >
                {errors[entry.path]}
              </div>
            )}
            {(dirCache[entry.path] ?? []).map((child) => (
              <Row key={child.path} entry={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Tree */}
      <div className="flex w-72 shrink-0 flex-col rounded-lg border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs text-slate-400" title={root}>
            {root}
          </span>
          <button onClick={refresh} className={btn} title="Refresh">
            ⟳
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {errors[root] && <div className="px-2 py-1 text-[11px] text-rose-400/80">{errors[root]}</div>}
          {(dirCache[root] ?? []).map((entry) => (
            <Row key={entry.path} entry={entry} depth={0} />
          ))}
          {!dirCache[root] && !errors[root] && (
            <div className="px-2 py-2 text-xs text-slate-600">Loading…</div>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-white/10 bg-white/[0.02]">
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={selected.path}>
                {KIND_ICON[selected.kind]} {selected.name}
                <span className="ml-2 text-slate-600">{prettyBytes(selected.size)}</span>
              </span>
              <button
                onClick={() => sendToClaude(selected.path)}
                className={`${btn} !bg-indigo-500/80 !text-white hover:!bg-indigo-400`}
                title="Paste this file's path into this project's Claude session"
              >
                {sent ? '✓ Sent' : '▸ Send to Claude'}
              </button>
              <button
                onClick={() => void hub.clipboard.writeText(selected.path)}
                className={btn}
                title="Copy full path"
              >
                Copy path
              </button>
              <button
                onClick={() => void hub.fs.openExternal(selected.path)}
                className={btn}
                title="Open with the default app"
              >
                Open ↗
              </button>
              <button
                onClick={() => void hub.fs.showInFolder(selected.path)}
                className={btn}
                title="Show in Explorer"
              >
                🗁
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <Preview key={selected.path} entry={selected} active={active} />
            </div>
          </>
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center text-sm text-slate-600">
            <div>
              Select a file to preview it here.
              <div className="mt-2 text-xs text-slate-700">
                Images, video, audio, PDFs and text render in-app · anything else opens externally ·{' '}
                <span className="text-slate-500">▸ Send to Claude</span> pastes the file's path into the
                project's session.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Preview({ entry, active }: { entry: FileEntry; active: boolean }): React.JSX.Element {
  switch (entry.kind) {
    case 'image':
      return <ImagePreview path={entry.path} />
    case 'video':
      return (
        <div className="grid h-full place-items-center bg-black/40 p-3">
          <video src={hubfileUrl(entry.path)} controls className="max-h-full max-w-full" />
        </div>
      )
    case 'audio':
      return (
        <div className="grid h-full place-items-center p-6">
          <audio src={hubfileUrl(entry.path)} controls />
        </div>
      )
    case 'pdf':
      return <PdfPreview path={entry.path} active={active} />
    case 'text':
      return <TextPreview path={entry.path} />
    default:
      return (
        <div className="grid h-full place-items-center p-8 text-center text-sm text-slate-500">
          <div>
            No in-app preview for this file type.
            <div className="mt-1 text-xs text-slate-600">Use Open ↗ to launch it in its default app.</div>
          </div>
        </div>
      )
  }
}

function ImagePreview({ path }: { path: string }): React.JSX.Element {
  const [fit, setFit] = useState(true)
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <div className="grid h-full place-items-center text-sm text-slate-500">Couldn't load this image.</div>
    )
  return (
    <div className="relative h-full">
      <button
        onClick={() => setFit((f) => !f)}
        className="absolute right-2 top-2 z-10 rounded-md bg-black/60 px-2 py-1 text-[11px] text-slate-200 hover:bg-black/80"
      >
        {fit ? 'Fit → 100%' : '100% → Fit'}
      </button>
      <div className={`h-full ${fit ? 'grid place-items-center p-3' : 'overflow-auto p-3'}`}>
        <img
          src={hubfileUrl(path)}
          onError={() => setFailed(true)}
          className={fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'}
          alt={path}
        />
      </div>
    </div>
  )
}

function TextPreview({ path }: { path: string }): React.JSX.Element {
  const [state, setState] = useState<{ content?: string; truncated?: boolean; error?: string } | null>(null)
  useEffect(() => {
    let live = true
    hub.fs.readText(path).then((r) => {
      if (live) setState(r.ok ? { content: r.content, truncated: r.truncated } : { error: r.error })
    })
    return () => {
      live = false
    }
  }, [path])

  if (!state) return <div className="p-4 text-xs text-slate-600">Loading…</div>
  if (state.error) return <div className="p-4 text-xs text-rose-400/80">{state.error}</div>
  return (
    <div className="h-full">
      {state.truncated && (
        <div className="border-b border-amber-400/20 bg-amber-400/5 px-3 py-1 text-[11px] text-amber-300/90">
          Large file — showing the first 512 KB.
        </div>
      )}
      <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-300">
        {state.content}
      </pre>
    </div>
  )
}

// Electron's built-in PDF viewer, hosted in a <webview> (created imperatively —
// same approach as ViewerPane).
function PdfPreview({ path, active }: { path: string; active: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wv = document.createElement('webview')
    wv.setAttribute('src', 'file:///' + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'))
    wv.setAttribute('plugins', '')
    // Fresh in-memory session: a PDF's hyperlinks can navigate this guest anywhere,
    // so keep it out of the default session where hubfile:// is registered.
    wv.setAttribute('partition', 'pdf-preview')
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = 'none'
    host.appendChild(wv)
    return () => {
      wv.remove()
    }
  }, [path])
  useEffect(() => {
    if (active) (hostRef.current?.firstElementChild as HTMLElement | null)?.focus()
  }, [active])
  return <div ref={hostRef} className="h-full bg-white/5" />
}
