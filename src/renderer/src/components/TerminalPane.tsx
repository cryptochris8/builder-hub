import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { hub } from '@/lib/api'

// One embedded Claude Code session. Owns its xterm instance + the main-process PTY.
export function TerminalPane({ cwd, active }: { cwd: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const idRef = useRef<string | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0f17', foreground: '#cbd5e1', cursor: '#818cf8' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    let disposed = false
    let unsubData = (): void => {}
    let unsubExit = (): void => {}

    // Fit to the container, but only when it actually has a size. xterm measures a
    // 0-width cell on a 0-size/unfonted element, so fit() silently no-ops (leaving the
    // 80-col default) or computes a tiny column count — both cause narrow wrapping.
    const safeFit = (): void => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* not measurable yet */
      }
    }

    // Claude Code latches its width at startup and does NOT reflow on resize, so the
    // PTY must already be the right size when it spawns. Wait for the host to have a
    // real size (and fonts to load) before fitting + creating the session.
    let tries = 0
    const start = (): void => {
      if (disposed) return
      if ((host.offsetWidth === 0 || host.offsetHeight === 0) && tries++ < 30) {
        requestAnimationFrame(start)
        return
      }
      safeFit()
      hub.terminal.create({ cwd, cols: term.cols, rows: term.rows, runClaude: true }).then((id) => {
        if (disposed) {
          hub.terminal.kill(id)
          return
        }
        idRef.current = id
        unsubData = hub.terminal.onData((p) => {
          if (p.id === id) term.write(p.data)
        })
        unsubExit = hub.terminal.onExit((p) => {
          if (p.id === id) term.write('\r\n\x1b[2m— session ended —\x1b[0m\r\n')
        })
        term.onData((d) => hub.terminal.write(id, d))
        // Re-assert the post-layout size once the child is up, as a belt-and-suspenders.
        safeFit()
        hub.terminal.resize(id, term.cols, term.rows)
      })
    }

    // Gate the first fit on font loading, then defer two frames so cell metrics settle.
    Promise.resolve(document.fonts?.ready).then(() => {
      if (!disposed) requestAnimationFrame(() => requestAnimationFrame(start))
    })

    let raf = 0
    const onResize = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        safeFit()
        if (idRef.current) hub.terminal.resize(idRef.current, term.cols, term.rows)
      })
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(host)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      unsubData()
      unsubExit()
      if (idRef.current) hub.terminal.kill(idRef.current)
      term.dispose()
    }
  }, [cwd])

  // Re-fit + focus when this tab becomes active (it may have been hidden at 0 size).
  useEffect(() => {
    if (!active) return
    const host = hostRef.current
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (host && host.offsetWidth > 0 && host.offsetHeight > 0) {
          try {
            fitRef.current?.fit()
          } catch {
            /* ignore */
          }
        }
        const term = termRef.current
        if (term && idRef.current) hub.terminal.resize(idRef.current, term.cols, term.rows)
        term?.focus()
      })
    )
  }, [active])

  return <div ref={hostRef} className="h-full w-full" />
}
