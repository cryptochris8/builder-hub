import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { hub } from '@/lib/api'
import { clearClaudeQueue, registerClaudeTerminal } from '@/lib/terminalBus'

// One embedded terminal session (Claude Code, or a plain shell when runClaude is
// false). Owns its xterm instance + the main-process PTY.
//
// Clipboard, the way a terminal should behave on Windows:
//   Ctrl+C            copy when text is selected, otherwise ^C to the shell
//   Ctrl+V            smart paste (clipboard image → temp PNG → quoted path for Claude)
//   Ctrl+Shift+C/V    explicit copy / paste
//   Ctrl/Shift+Insert classic copy / paste
//   Right-click       copy the selection if there is one, else paste
//   Drag & drop file  paste its quoted path (hand any file/pic straight to Claude)
export function TerminalPane({
  cwd,
  active,
  runClaude = true,
  onSessionEnd,
  onOpenUrl
}: {
  cwd: string
  active: boolean
  runClaude?: boolean
  /** the session exited or failed to start — App uses this to replace the tab on next open */
  onSessionEnd?: () => void
  /** a clicked link — App opens it in an embedded Viewer tab (Chrome is the fallback) */
  onOpenUrl?: (url: string) => void
}) {
  const onOpenUrlRef = useRef(onOpenUrl)
  onOpenUrlRef.current = onOpenUrl
  const hostRef = useRef<HTMLDivElement>(null)
  const idRef = useRef<string | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Kept in a ref so an inline callback prop doesn't restart the PTY effect.
  const onSessionEndRef = useRef(onSessionEnd)
  onSessionEndRef.current = onSessionEnd

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true, // required by the unicode11 addon
      theme: { background: '#0b0f17', foreground: '#cbd5e1', cursor: '#818cf8' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Correct emoji/CJK cell widths — must be active BEFORE the first fit so the
    // width Claude latches at startup is measured with the right metrics.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // OSC 52 — lets TUIs (claude included) write to the system clipboard.
    term.loadAddon(new ClipboardAddon())
    // Clickable links — inside the Hub (Viewer tab) by default, Chrome as the fallback.
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        if (onOpenUrlRef.current) onOpenUrlRef.current(uri)
        else void hub.launch.chrome(uri)
      })
    )
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const copySelection = (): void => {
      const sel = term.getSelection()
      if (sel) void hub.clipboard.writeText(sel)
    }

    // Smart paste: an image on the clipboard becomes a temp PNG whose quoted path
    // is pasted (Claude reads image paths); text pastes as-is (bracketed-paste safe).
    const pasteClipboard = async (): Promise<void> => {
      const r = await hub.clipboard.readForPaste()
      if (r.kind === 'image' && r.path) term.paste(`"${r.path}" `)
      else if (r.kind === 'text' && r.text) term.paste(r.text)
    }

    // Returning false only stops xterm's own handling — it does NOT preventDefault,
    // and xterm keeps native paste listeners on its textarea. Without preventDefault
    // the browser's paste action would fire too and Ctrl+V would paste twice.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      const ctrl = e.ctrlKey && !e.altKey
      if (ctrl && key === 'v') {
        e.preventDefault()
        void pasteClipboard()
        return false
      }
      if (ctrl && e.shiftKey && key === 'c') {
        e.preventDefault()
        copySelection()
        return false
      }
      if (ctrl && !e.shiftKey && key === 'c' && term.hasSelection()) {
        e.preventDefault()
        copySelection()
        term.clearSelection()
        return false
      }
      if (e.key === 'Insert' && e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        copySelection()
        return false
      }
      if (e.key === 'Insert' && e.shiftKey && !e.ctrlKey) {
        e.preventDefault()
        void pasteClipboard()
        return false
      }
      return true
    })

    // Right-click: copy the selection if there is one, else paste (Windows Terminal style).
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (term.hasSelection()) {
        copySelection()
        term.clearSelection()
      } else {
        void pasteClipboard()
      }
    }
    // Drop a file anywhere on the terminal → paste its quoted path.
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (!files?.length) return
      const paths: string[] = []
      for (const f of files) {
        try {
          const p = hub.system.pathForFile(f)
          if (p) paths.push(`"${p}"`)
        } catch {
          /* not a disk file (e.g. dragged text) — skip */
        }
      }
      if (paths.length) term.paste(paths.join(' ') + ' ')
      term.focus()
    }
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    host.addEventListener('contextmenu', onContextMenu)
    host.addEventListener('drop', onDrop)
    host.addEventListener('dragover', onDragOver)

    let disposed = false
    let unsubData = (): void => {}
    let unsubExit = (): void => {}
    let unsubBus = (): void => {}
    let busRegistered = false
    let settleTimer = 0
    let capTimer = 0

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
      hub.terminal
        .create({ cwd, cols: term.cols, rows: term.rows, runClaude })
        .then((id) => {
          if (disposed) {
            hub.terminal.kill(id)
            return
          }
          idRef.current = id

          // Other panes (Files) can paste into this project's Claude session.
          // Register only after startup output settles (600ms quiet, 5s cap) so
          // queued "Send to Claude" text lands in Claude's prompt, not in the
          // booting shell. Live sends queue in the bus until then.
          const registerBus = (): void => {
            if (disposed || busRegistered || !runClaude) return
            busRegistered = true
            window.clearTimeout(settleTimer)
            window.clearTimeout(capTimer)
            unsubBus = registerClaudeTerminal(cwd, (text) => term.paste(text))
          }
          if (runClaude) capTimer = window.setTimeout(registerBus, 5000)

          unsubData = hub.terminal.onData((p) => {
            if (p.id !== id) return
            term.write(p.data)
            if (runClaude && !busRegistered) {
              window.clearTimeout(settleTimer)
              settleTimer = window.setTimeout(registerBus, 600)
            }
          })
          unsubExit = hub.terminal.onExit((p) => {
            if (p.id !== id) return
            term.write('\r\n\x1b[2m— session ended —\x1b[0m\r\n')
            // Stop routing "Send to Claude" into a dead PTY; let App replace the tab.
            idRef.current = null
            unsubBus()
            unsubBus = (): void => {}
            onSessionEndRef.current?.()
          })
          term.onData((d) => hub.terminal.write(id, d))
          // Re-assert the post-layout size once the child is up, as a belt-and-suspenders.
          safeFit()
          hub.terminal.resize(id, term.cols, term.rows)
        })
        .catch((err: unknown) => {
          if (disposed) return
          if (runClaude) clearClaudeQueue(cwd) // don't let queued sends haunt a later session
          const msg = String(err instanceof Error ? err.message : err).replace(
            /^Error invoking remote method 'pty:create': (Error: )?/,
            ''
          )
          term.writeln(`\x1b[31mFailed to start ${runClaude ? 'Claude' : 'shell'} session\x1b[0m`)
          term.writeln(`\x1b[2m${msg}\x1b[0m`)
          onSessionEndRef.current?.()
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
      window.clearTimeout(settleTimer)
      window.clearTimeout(capTimer)
      ro.disconnect()
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('drop', onDrop)
      host.removeEventListener('dragover', onDragOver)
      unsubBus()
      unsubData()
      unsubExit()
      if (idRef.current) hub.terminal.kill(idRef.current)
      term.dispose()
    }
  }, [cwd, runClaude])

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
