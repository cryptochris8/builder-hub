import { useEffect, useRef, useState } from 'react'
import { hub } from '@/lib/api'
import { fileUrlToPath, normalizeUrl } from '@/lib/urls'

// Embedded browser tab: http(s) pages (docs, dashboards, localhost dev servers)
// AND local files inside a registered project (a built index.html, a game
// preview) — the "open inside Builder Hub whenever practical" policy. Local
// paths are checked against the project containment rule in main before they
// load, and the will-attach-webview guard still validates the initial src.

// Minimal surface of Electron's <webview> tag that we use.
interface WebviewEl extends HTMLElement {
  src: string
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
}

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'

export function ViewerPane({
  url,
  active,
  notify
}: {
  url: string
  active: boolean
  notify?: (msg: string, err?: boolean) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<WebviewEl | null>(null)
  const [addr, setAddr] = useState(url)
  const [current, setCurrent] = useState(url)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, fwd: false })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wv = document.createElement('webview') as unknown as WebviewEl
    wv.setAttribute('src', url)
    wv.setAttribute('partition', 'persist:hub') // persistent session → logins survive restarts
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = 'none'
    host.appendChild(wv)
    wvRef.current = wv

    const sync = (): void => {
      const u = wv.getURL()
      setAddr(u)
      setCurrent(u)
      try {
        setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
      } catch {
        /* not ready */
      }
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    const onTitle = (): void => {
      try {
        setTitle(wv.getTitle())
      } catch {
        /* ignore */
      }
    }
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('page-title-updated', onTitle)
    return () => {
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.remove()
    }
    // url is only the initial src; navigation afterward is internal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) wvRef.current?.focus()
  }, [active])

  const go = async (): Promise<void> => {
    const target = normalizeUrl(addr)
    setBlocked(null)
    if (/^file:/i.test(target)) {
      // Only files inside a registered project may load — same rule as the Files pane.
      const ok = await hub.fs.isAllowed(fileUrlToPath(target))
      if (!ok) {
        setBlocked('That file is outside your registered projects — open it externally instead.')
        return
      }
    }
    void wvRef.current?.loadURL(target)
  }

  const isFile = /^file:/i.test(current)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 pb-2">
        <button onClick={() => wvRef.current?.goBack()} disabled={!nav.back} className={btn} title="Back">
          ‹
        </button>
        <button
          onClick={() => wvRef.current?.goForward()}
          disabled={!nav.fwd}
          className={btn}
          title="Forward"
        >
          ›
        </button>
        <button onClick={() => wvRef.current?.reload()} className={btn} title="Reload">
          ⟳
        </button>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void go()
          }}
          spellCheck={false}
          placeholder="URL, localhost:5173, or a file inside this project"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-400"
        />
        <button
          onClick={() => {
            void hub.clipboard.writeText(current)
            notify?.('URL copied')
          }}
          className={btn}
          title="Copy URL"
        >
          Copy
        </button>
        {isFile ? (
          <>
            <button
              onClick={() => void hub.fs.showInFolder(fileUrlToPath(current))}
              className={btn}
              title="Reveal in Explorer"
            >
              🗁
            </button>
            <button
              onClick={() => void hub.fs.openExternal(fileUrlToPath(current))}
              className={btn}
              title="Open with the default app"
            >
              Open ↗
            </button>
          </>
        ) : (
          <button
            onClick={() => hub.launch.chrome(current)}
            className={btn}
            title="Open this URL in Google Chrome"
          >
            Chrome ↗
          </button>
        )}
      </div>
      {(title || blocked) && (
        <div
          className={`truncate pb-1 text-[11px] ${blocked ? 'text-rose-300' : 'text-slate-500'}`}
          title={title}
        >
          {blocked ?? title}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          className="absolute inset-0 overflow-hidden rounded-lg border border-white/10 bg-white"
        />
        {loading && (
          <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white">
            loading…
          </div>
        )}
      </div>
    </div>
  )
}
