// URL helpers for the embedded Viewer (kept out of the component file so React
// Fast Refresh sees a components-only module).

/** Absolute Windows / POSIX path → file:/// URL (each segment encoded). */
export function fileUrl(p: string): string {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
}

/** file:/// URL → local path (Windows drive letters handled). */
export function fileUrlToPath(url: string): string {
  let p = decodeURIComponent(url.replace(/^file:\/\/\/?/i, ''))
  if (/^\/[a-z]:/i.test(p)) p = p.slice(1)
  return p.replace(/\//g, '\\')
}

const looksLikePath = (s: string): boolean =>
  /^[a-z]:[\\/]/i.test(s) || s.startsWith('\\\\') || s.startsWith('/')

/** What the Viewer's address bar loads: URLs as-is, local paths as file: URLs
 *  (main re-checks project containment before they load), bare hosts as https,
 *  localhost / IPs as http, anything else as a search. */
export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return 'about:blank'
  if (/^file:\/\//i.test(s)) return s
  if (looksLikePath(s)) return fileUrl(s)
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('about:')) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(s)) return `http://${s}`
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
