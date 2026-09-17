// Minimal, SAFE Markdown → HTML for the in-app viewer. PURE, tested.
//
// Scope (deliberately small, no dependency): ATX headings (#..######),
// paragraphs, hard line breaks, **bold**, *em*, `code`, fenced ``` code blocks
// (language class only), - / * / + and 1. lists (nested by 2+ spaces, one
// level of nesting is enough), > blockquotes, --- rules, [text](url) links
// (http/https/mailto only; everything else renders as plain text), images
// rendered as their alt text in brackets, simple | tables |.
//
// Security: EVERY piece of user text is HTML-escaped before it is wrapped; raw
// HTML in the source is escaped, never passed through; link hrefs are
// allowlisted by scheme and get rel="noopener noreferrer" + target="_blank".
//
// Output shape (stable, so tests can assert exact strings): block elements are
// joined by '\n'; containers (lists, tables, blockquotes) are emitted compactly
// with no whitespace between their own tags.

/** Escape &, <, >, ", ' for safe insertion into HTML text/attributes.
 *  Tolerates garbage (null/undefined → '', anything else stringified). */
export function escapeHtml(s: string): string {
  if (typeof s !== 'string') s = s == null ? '' : String(s)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** CommonMark's ASCII punctuation — the only characters a backslash escapes. */
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
const LINK_ATTRS = ' target="_blank" rel="noopener noreferrer"'
/** A bare URL may only start at the beginning of the text or after one of these. */
const AUTOLINK_PREV = /[\s(*_~"'[<]/
/** A bare URL stops at whitespace, `<`, `>` or a backtick (a code span binds tighter). */
const AUTOLINK = /https?:\/\/[^\s<>`]+/iy
/** Punctuation a bare URL is not allowed to end with (it belongs to the sentence). */
const URL_TRAIL = '.,:;!?\'"*_~]'
const LINK_DEST = /^(?:<([^<>]*)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?$/
/** Inline constructs nest through recursion (emphasis text, link text); past this
 *  depth the delimiters are literal so a hostile document can't blow the stack. */
const MAX_INLINE_DEPTH = 16

const isWs = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
/** A letter or digit in any script — so `café_au_lait` keeps its underscores. */
const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

/** Index of the next backtick run of EXACTLY `len` starting at or after `from`, else -1. */
function findBacktickRun(s: string, from: number, len: number): number {
  let j = from
  while (j < s.length) {
    const p = s.indexOf('`', j)
    if (p === -1) return -1
    let q = p
    while (q < s.length && s[q] === '`') q++
    if (q - p === len) return p
    j = q
  }
  return -1
}

/** One pass over the text: a 1 in `mask` marks every character that is part of
 *  a code span (delimiters included), and `closeAt` maps each opening run's
 *  index to the index of its closing run. Everything else (emphasis, links,
 *  autolinks) skips masked characters, so markup inside `code` is inert. */
function scanCodeSpans(s: string): { mask: Uint8Array; closeAt: Map<number, number> } {
  const n = s.length
  const mask = new Uint8Array(n)
  const closeAt = new Map<number, number>()
  let i = 0
  while (i < n) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c !== '`') {
      i++
      continue
    }
    let k = i
    while (k < n && s[k] === '`') k++
    const len = k - i
    const close = findBacktickRun(s, k, len)
    if (close === -1) {
      i = k
      continue
    }
    closeAt.set(i, close)
    mask.fill(1, i, close + len)
    i = close + len
  }
  return { mask, closeAt }
}

/** Find a closing delimiter run of exactly `len` × `ch` at or after `from`
 *  (right-flanking: preceded by non-space; `_` also must not run into a word). */
function findCloser(s: string, from: number, ch: string, len: number, mask: Uint8Array): number {
  const n = s.length
  let j = from
  while (j < n) {
    if (mask[j]) {
      j++
      continue
    }
    const c = s[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c !== ch) {
      j++
      continue
    }
    let k = j
    while (k < n && s[k] === ch) k++
    const prev = s[j - 1]
    if (k - j === len && prev !== ch && !isWs(prev) && (ch !== '_' || !isAlnum(s[k]))) return j
    j = k
  }
  return -1
}

/** One pass matching every `open` to its `close` (nesting-aware, backslash
 *  escapes and code spans skipped): opener index → closer index. Precomputing
 *  keeps a flood of unmatched `[` or `(` linear instead of quadratic. */
function scanPairs(s: string, open: string, close: string, mask: Uint8Array): Map<number, number> {
  const pairs = new Map<number, number>()
  const stack: number[] = []
  for (let j = 0; j < s.length; j++) {
    if (mask[j]) continue
    const c = s[j]
    if (c === '\\') j++
    else if (c === open) stack.push(j)
    else if (c === close && stack.length > 0) pairs.set(stack.pop() as number, j)
  }
  return pairs
}

/** `[text](dest)` → the href part of dest: `<url>` or the first token, an
 *  optional "title" dropped, backslash escapes removed. */
function linkHref(dest: string): string {
  const m = LINK_DEST.exec(dest.trim())
  const raw = m ? (m[1] ?? m[2] ?? '') : dest.trim()
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function anchor(href: string, innerHtml: string): string {
  return `<a href="${escapeHtml(href.trim())}"${LINK_ATTRS}>${innerHtml}</a>`
}

/** Strip trailing sentence punctuation and unbalanced `)` from a bare URL.
 *  Paren counts are kept incrementally so a long run of `)` stays linear. */
function trimBareUrl(url: string): string {
  let opens = 0
  let closes = 0
  for (const ch of url) {
    if (ch === '(') opens++
    else if (ch === ')') closes++
  }
  let end = url.length
  while (end > 0) {
    const last = url[end - 1]
    if (URL_TRAIL.includes(last)) end--
    else if (last === ')' && opens < closes) {
      closes--
      end--
    } else break
  }
  return url.slice(0, end)
}

const EMPHASIS_TAG: Record<string, string | undefined> = {
  '*1': 'em',
  '*2': 'strong',
  '*3': 'strong-em',
  _1: 'em',
  _2: 'strong',
  _3: 'strong-em',
  '~2': 'del'
}

/** The inline scanner. `noLinks` is set while rendering link text, so a link
 *  (or bare URL) inside a link never produces nested <a> elements. `depth`
 *  counts recursion; at MAX_INLINE_DEPTH emphasis and links stay literal. */
function inline(s: string, noLinks: boolean, depth: number): string {
  const n = s.length
  const { mask, closeAt } = scanCodeSpans(s)
  const nest = depth < MAX_INLINE_DEPTH
  let brackets: Map<number, number> | undefined
  let parens: Map<number, number> | undefined
  /** delimiter key → earliest position known to have no closer after it (a
   *  closer is a purely local property, so a failed search never succeeds
   *  from a later start — this keeps floods of unmatched `*` linear). */
  const noCloser = new Map<string, number>()
  let out = ''
  let lit = 0 // start of the pending literal run
  let i = 0
  const flush = (to: number): void => {
    if (to > lit) out += escapeHtml(s.slice(lit, to))
  }
  const emit = (from: number, html: string, next: number): void => {
    flush(from)
    out += html
    i = next
    lit = next
  }

  while (i < n) {
    const c = s[i]

    if (c === '\n') {
      emit(i, '<br>', i + 1)
      continue
    }

    if (c === '\\') {
      const nx = s[i + 1]
      if (nx !== undefined && ESCAPABLE.includes(nx)) emit(i, escapeHtml(nx), i + 2)
      else i++
      continue
    }

    if (c === '`') {
      let k = i
      while (k < n && s[k] === '`') k++
      const close = closeAt.get(i)
      if (close === undefined) {
        i = k
        continue
      }
      let code = s.slice(k, close).replace(/\n/g, ' ')
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') {
        code = code.slice(1, -1)
      }
      emit(i, `<code>${escapeHtml(code)}</code>`, close + (k - i))
      continue
    }

    if (c === '*' || c === '_' || c === '~') {
      let k = i
      while (k < n && s[k] === c) k++
      const len = k - i
      const key = c + len
      const tag = EMPHASIS_TAG[key]
      const canOpen = nest && tag !== undefined && k < n && !isWs(s[k]) && (c !== '_' || !isAlnum(s[i - 1]))
      if (canOpen) {
        const failedFrom = noCloser.get(key)
        let close = -1
        if (failedFrom === undefined || k < failedFrom) {
          close = findCloser(s, k, c, len, mask)
          if (close === -1) noCloser.set(key, k)
        }
        if (close !== -1) {
          const innerHtml = inline(s.slice(k, close), noLinks, depth + 1)
          const html =
            tag === 'strong-em' ? `<strong><em>${innerHtml}</em></strong>` : `<${tag}>${innerHtml}</${tag}>`
          emit(i, html, close + len)
          continue
        }
      }
      i = k
      continue
    }

    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const isImage = c === '!'
      const open = isImage ? i + 1 : i
      brackets ??= scanPairs(s, '[', ']', mask)
      const close = brackets.get(open) ?? -1
      if (close !== -1 && s[close + 1] === '(') {
        parens ??= scanPairs(s, '(', ')', mask)
        const end = parens.get(close + 1) ?? -1
        if (end !== -1) {
          const text = s.slice(open + 1, close)
          if (isImage) {
            const alt = text.trim()
            emit(i, escapeHtml(alt ? `[image: ${alt}]` : '[image]'), end + 1)
            continue
          }
          if (nest) {
            const href = linkHref(s.slice(close + 2, end))
            const textHtml = inline(text, true, depth + 1)
            const html =
              !noLinks && isSafeHref(href) ? anchor(href, textHtml) : `${textHtml} (${escapeHtml(href)})`
            emit(i, html, end + 1)
            continue
          }
        }
      }
      i++
      continue
    }

    if ((c === 'h' || c === 'H') && !noLinks && (i === 0 || AUTOLINK_PREV.test(s[i - 1]))) {
      AUTOLINK.lastIndex = i
      const m = AUTOLINK.exec(s)
      if (m) {
        const url = trimBareUrl(m[0])
        if (isSafeHref(url)) {
          emit(i, anchor(url, escapeHtml(url)), i + url.length)
          continue
        }
      }
    }

    i++
  }
  flush(n)
  return out
}

/** Inline markup only (bold, em, code, links) — used per line/cell. Pure.
 *  A '\n' (or CRLF / lone CR) in the text is a hard line break (<br>). */
export function renderInline(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  return inline(text.replace(/\r\n?/g, '\n'), false, 0)
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const BLANK = /^[ \t]*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const BLOCKQUOTE = /^ {0,3}> ?(.*)$/
/** A fence may sit at any indentation: this renderer has no indented code
 *  blocks, so CommonMark's 3-space cap would only turn a fence nested under a
 *  list item (a common README shape) into paragraph text. */
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const HARD_BREAK = / {2,}$/
/** Blockquotes and lists nest through recursion; past this depth a deeper
 *  `>` line is a paragraph and a deeper list item a sibling (no stack blowup
 *  on a line of 5 000 `>`). */
const MAX_BLOCK_DEPTH = 32
/** A UTF-8 BOM at the start of a file (Notepad writes one) is not content. */
const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

interface Fence {
  /** indentation in columns (a tab is 4), compared against a list's base */
  indent: number
  /** leading whitespace characters, the most that is stripped from each content line */
  strip: number
  char: string
  len: number
  lang: string
}

interface ListItemMatch {
  indent: number
  ordered: boolean
  num: number
  text: string
}

const isBlank = (line: string): boolean => BLANK.test(line)

function matchFence(line: string): Fence | null {
  const m = FENCE.exec(line)
  if (!m) return null
  const char = m[2][0]
  const info = m[3]
  if (char === '`' && info.includes('`')) return null
  const lang = (info.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return { indent: indentWidth(m[1]), strip: m[1].length, char, len: m[2].length, lang }
}

function isFenceClose(line: string, fence: Fence): boolean {
  const m = FENCE_CLOSE.exec(line)
  return m !== null && m[1][0] === fence.char && m[1].length >= fence.len
}

/** Read the body of a fenced block whose opener is the line before `start`:
 *  every line up to the closing fence (or EOF) with at most `strip` leading
 *  whitespace characters removed, escaped and never inline-parsed. `next` is
 *  the line after the closer (one past EOF for an unterminated block). */
function readFence(
  lines: string[],
  start: number,
  fence: Fence,
  strip: number
): { html: string; next: number } {
  const code: string[] = []
  let i = start
  while (i < lines.length && !isFenceClose(lines[i], fence)) {
    const l = lines[i]
    let k = 0
    while (k < strip && (l[k] === ' ' || l[k] === '\t')) k++
    code.push(l.slice(k))
    i++
  }
  const cls = fence.lang ? ` class="language-${fence.lang}"` : ''
  return { html: `<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`, next: i + 1 }
}

/** Leading whitespace width; a tab counts as 4 columns. */
function indentWidth(line: string): number {
  let w = 0
  for (const ch of line) {
    if (ch === ' ') w++
    else if (ch === '\t') w += 4
    else break
  }
  return w
}

function matchListItem(line: string): ListItemMatch | null {
  const m = LIST_ITEM.exec(line)
  if (!m) return null
  const marker = m[2]
  const ordered = marker.length > 1
  return {
    indent: indentWidth(m[1]),
    ordered,
    num: ordered ? parseInt(marker, 10) : 1,
    text: m[3] ?? ''
  }
}

/** Split a table row into trimmed cells; `\|` is a literal pipe inside a cell. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false
  const header = lines[i]
  const sep = lines[i + 1]
  if (!header.includes('|') || !sep.includes('|') || !TABLE_SEP.test(sep)) return false
  return splitRow(header).length === splitRow(sep).length
}

function cellAlign(sep: string): string {
  const left = sep.startsWith(':')
  const right = sep.endsWith(':')
  if (left && right) return ' style="text-align:center"'
  if (left) return ' style="text-align:left"'
  if (right) return ' style="text-align:right"'
  return ''
}

/** Does the line at `i` open a block that ends a paragraph? Per CommonMark an
 *  ordered list interrupts a paragraph only when it starts at 1, and an empty
 *  list item never does. */
function interruptsParagraph(lines: string[], i: number): boolean {
  const line = lines[i]
  if (matchFence(line) || ATX.test(line) || HR.test(line) || BLOCKQUOTE.test(line)) return true
  if (isTableStart(lines, i)) return true
  const li = matchListItem(line)
  return li !== null && li.text !== '' && (!li.ordered || li.num === 1)
}

/** Paragraph lines → one inline string: trimmed, joined by ' ', or by '\n'
 *  (a hard break) after a line that ends in two or more spaces. */
function joinLines(ls: string[]): string {
  let s = ''
  for (let k = 0; k < ls.length; k++) {
    if (k > 0) s += HARD_BREAK.test(ls[k - 1]) ? '\n' : ' '
    s += ls[k].trim()
  }
  return s
}

function renderTable(lines: string[], start: number, out: string[]): number {
  const cols = splitRow(lines[start])
  const aligns = splitRow(lines[start + 1]).map(cellAlign)
  let html = '<table><thead><tr>'
  cols.forEach((cell, c) => {
    html += `<th${aligns[c]}>${renderInline(cell)}</th>`
  })
  html += '</tr></thead><tbody>'
  let i = start + 2
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
    const cells = splitRow(lines[i])
    html += '<tr>'
    for (let c = 0; c < cols.length; c++) html += `<td${aligns[c]}>${renderInline(cells[c] ?? '')}</td>`
    html += '</tr>'
    i++
  }
  out.push(html + '</tbody></table>')
  return i
}

/** An item's content in source order: runs of text lines (rendered inline as
 *  one string) interleaved with already-rendered blocks (a nested list, a
 *  fenced code block). */
type ListItem = Array<string[] | string>

function appendText(item: ListItem, line: string): void {
  const last = item[item.length - 1]
  if (Array.isArray(last)) last.push(line)
  else item.push([line])
}

/** Parse one list whose first item is at `start` (its indent is the list's
 *  base). Items indented 2+ columns deeper open a nested list; a fence indented
 *  deeper than the base (or opening on the marker line) is a code block inside
 *  the item; a non-blank, non-marker line continues the last item; a blank
 *  line ends the list unless the next non-blank line is another item at or
 *  below this depth, or such an indented fence. */
function parseList(
  lines: string[],
  start: number,
  base: number,
  ordered: boolean,
  depth: number
): { html: string; next: number } {
  const n = lines.length
  const items: ListItem[] = []
  let i = start
  while (i < n) {
    const line = lines[i]
    if (isBlank(line)) {
      let j = i + 1
      while (j < n && isBlank(lines[j])) j++
      if (j < n) {
        const m = matchListItem(lines[j])
        const f = matchFence(lines[j])
        if ((m && m.indent >= base && !HR.test(lines[j])) || (f && f.indent > base && items.length > 0)) {
          i = j
          continue
        }
      }
      break
    }
    const fence = matchFence(line)
    if (fence) {
      if (fence.indent <= base || items.length === 0) break
      const block = readFence(lines, i + 1, fence, fence.strip)
      items[items.length - 1].push(block.html)
      i = block.next
      continue
    }
    if (HR.test(line) || ATX.test(line) || BLOCKQUOTE.test(line)) break
    if (isTableStart(lines, i)) break
    const m = matchListItem(line)
    if (m) {
      if (m.indent < base) break
      if (m.indent >= base + 2 && items.length > 0 && depth < MAX_BLOCK_DEPTH) {
        const nested = parseList(lines, i, m.indent, m.ordered, depth + 1)
        items[items.length - 1].push(nested.html)
        i = nested.next
        continue
      }
      if (m.ordered !== ordered) break
      const onMarker = matchFence(m.text)
      if (onMarker) {
        // `- ```js` opens a block whose body is indented to the item's content column
        const block = readFence(lines, i + 1, onMarker, line.length - m.text.length)
        items.push([block.html])
        i = block.next
        continue
      }
      items.push([[m.text]])
      i++
      continue
    }
    if (items.length === 0) break
    appendText(items[items.length - 1], line)
    i++
  }
  const first = matchListItem(lines[start])
  const tag = ordered ? 'ol' : 'ul'
  const startAttr = ordered && first && first.num !== 1 ? ` start="${first.num}"` : ''
  const renderPart = (p: string[] | string): string =>
    typeof p === 'string' ? p : renderInline(joinLines(p))
  const body = items.map((it) => `<li>${it.map(renderPart).join('')}</li>`).join('')
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i }
}

function renderBlocks(lines: string[], depth: number): string[] {
  const out: string[] = []
  const n = lines.length
  let i = 0
  while (i < n) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = matchFence(line)
    if (fence) {
      const block = readFence(lines, i + 1, fence, fence.strip)
      out.push(block.html)
      i = block.next
      continue
    }

    const h = ATX.exec(line)
    if (h) {
      const level = h[1].length
      const text = (h[2] ?? '').replace(/(^|[ \t]+)#+[ \t]*$/, '').trim()
      out.push(`<h${level}>${renderInline(text)}</h${level}>`)
      i++
      continue
    }

    if (HR.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    if (depth < MAX_BLOCK_DEPTH && BLOCKQUOTE.test(line)) {
      const inner: string[] = []
      while (i < n) {
        const m = BLOCKQUOTE.exec(lines[i])
        if (!m) break
        inner.push(m[1])
        i++
      }
      out.push(`<blockquote>${renderBlocks(inner, depth + 1).join('\n')}</blockquote>`)
      continue
    }

    if (isTableStart(lines, i)) {
      i = renderTable(lines, i, out)
      continue
    }

    const li = matchListItem(line)
    if (li) {
      const list = parseList(lines, i, li.indent, li.ordered, depth)
      out.push(list.html)
      i = list.next
      continue
    }

    const para: string[] = [line]
    i++
    while (i < n && !isBlank(lines[i]) && !interruptsParagraph(lines, i)) {
      para.push(lines[i])
      i++
    }
    out.push(`<p>${renderInline(joinLines(para))}</p>`)
  }
  return out
}

/** Whole document → HTML string (no <html>/<body>; wrap it yourself). Pure. */
export function renderMarkdown(md: string): string {
  if (typeof md !== 'string') return ''
  const text = stripBom(md).replace(/\r\n?/g, '\n')
  if (text.trim() === '') return ''
  return renderBlocks(text.split('\n'), 0).join('\n')
}

// ---------------------------------------------------------------------------
// Title + href policy
// ---------------------------------------------------------------------------

/** Inline markup → plain text (tags dropped, entities restored). Only ever
 *  fed renderInline output, whose tags and entities are all ours. */
function plainText(inlineMd: string): string {
  return renderInline(inlineMd)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const H1 = /^ {0,3}#[ \t]+(.+)$/
const CLOSING_HASHES = /(^|[ \t]+)#+[ \t]*$/

/** First "# Title" (or the first non-empty line) — for tab titles. A `# comment`
 *  inside a fenced code block is code, not a heading, and never wins; the
 *  fallback is the first non-blank line that is not a rule or a fence marker,
 *  with any heading marker stripped. */
export function markdownTitle(md: string): string {
  if (typeof md !== 'string') return ''
  const lines = stripBom(md).replace(/\r\n?/g, '\n').split('\n')
  let fallback = ''
  let fence: Fence | null = null
  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) {
        fence = null
        continue
      }
    } else {
      fence = matchFence(line)
      if (fence) continue
      const m = H1.exec(line)
      if (m) {
        const h1 = plainText(m[1].replace(CLOSING_HASHES, ''))
        if (h1) return h1
      }
    }
    if (fallback || isBlank(line) || HR.test(line)) continue
    fallback = plainText(line.replace(/^ {0,3}#{1,6}[ \t]+/, '').replace(CLOSING_HASHES, ''))
  }
  return fallback
}

/** True for a link href the renderer will keep (http, https, mailto). Anything
 *  containing whitespace, a control or format character is rejected outright. */
export function isSafeHref(href: string): boolean {
  if (typeof href !== 'string') return false
  const h = href.trim()
  if (h === '' || /[\s\p{Cc}\p{Cf}]/u.test(h)) return false
  return /^(https?:\/\/|mailto:)\S/i.test(h)
}
