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
    try {
      fit.fit()
    } catch {
      /* container may be 0-sized briefly */
    }
    termRef.current = term
    fitRef.current = fit

    let disposed = false
    let unsubData = (): void => {}
    let unsubExit = (): void => {}

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
    })

    const onResize = (): void => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      if (idRef.current) hub.terminal.resize(idRef.current, term.cols, term.rows)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(host)

    return () => {
      disposed = true
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
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      const term = termRef.current
      if (term && idRef.current) hub.terminal.resize(idRef.current, term.cols, term.rows)
      term?.focus()
    })
  }, [active])

  return <div ref={hostRef} className="h-full w-full" />
}
