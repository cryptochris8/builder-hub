import { useEffect, useRef, useState } from 'react'
import { hub } from '@/lib/api'

// Minimal surface of Electron's <webview> tag that we use.
interface WebviewEl extends HTMLElement {
  src: string
  getURL(): string
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
}

function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('about:')) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(s)) return `http://${s}`
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'

export function ViewerPane({ url, active }: { url: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<WebviewEl | null>(null)
  const [addr, setAddr] = useState(url)
  const [loading, setLoading] = useState(true)

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

    const sync = (): void => setAddr(wv.getURL())
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    return () => {
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.remove()
    }
    // url is only the initial src; navigation afterward is internal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) wvRef.current?.focus()
  }, [active])

  const go = (): void => {
    void wvRef.current?.loadURL(normalizeUrl(addr))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 pb-2">
        <button onClick={() => wvRef.current?.goBack()} className={btn} title="Back">
          ‹
        </button>
        <button onClick={() => wvRef.current?.goForward()} className={btn} title="Forward">
          ›
        </button>
        <button onClick={() => wvRef.current?.reload()} className={btn} title="Reload">
          ⟳
        </button>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-400"
        />
        <button
          onClick={() => hub.launch.chrome(addr)}
          className={btn}
          title="Open this URL in Google Chrome"
        >
          Chrome ↗
        </button>
      </div>
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
