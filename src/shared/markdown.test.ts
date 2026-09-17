import { describe, it, expect } from 'vitest'
import { escapeHtml, isSafeHref, markdownTitle, renderInline, renderMarkdown } from './markdown'

const A = ' target="_blank" rel="noopener noreferrer"'
const link = (href: string, text = href): string => `<a href="${href}"${A}>${text}</a>`

/** Every tag the renderer is allowed to emit, with only the attributes it sets itself.
 *  Anything else in the output is a leak. */
const ALLOWED_TAG =
  /^<(?:\/?(?:p|h[1-6]|ul|ol|li|pre|blockquote|hr|table|thead|tbody|tr|strong|em|del|a|br)|\/?code(?: class="language-[a-z0-9_-]*")?|\/?(?:th|td)(?: style="text-align:(?:left|center|right)")?|ol start="\d+"|a href="[^"<>]*" target="_blank" rel="noopener noreferrer")>$/
function assertOnlyOurTags(html: string): void {
  const tags = html.match(/<[^>]*>?/g) ?? []
  expect(tags.length).toBeGreaterThan(0)
  for (const tag of tags) {
    expect(tag).toMatch(ALLOWED_TAG)
    expect(tag).not.toMatch(/on\w+=/i)
  }
  // outside those tags every < and > must have been escaped
  expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/[<>]/)
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    )
  })
  it('leaves everything else alone', () => {
    expect(escapeHtml('plain text 123 äöü')).toBe('plain text 123 äöü')
    expect(escapeHtml('')).toBe('')
  })
  it('double-escapes an already-escaped entity (never passes markup through)', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })
  it('tolerates garbage input instead of throwing', () => {
    expect(escapeHtml(undefined as unknown as string)).toBe('')
    expect(escapeHtml(null as unknown as string)).toBe('')
    expect(escapeHtml(5 as unknown as string)).toBe('5')
  })
})

describe('isSafeHref', () => {
  it('accepts http, https and mailto (any case, surrounding whitespace trimmed)', () => {
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('http://example.com/a?b=1&c=2#x')).toBe(true)
    expect(isSafeHref('HTTPS://EXAMPLE.COM')).toBe(true)
    expect(isSafeHref('mailto:chris@example.com')).toBe(true)
    expect(isSafeHref('  https://example.com  ')).toBe(true)
  })
  it('rejects every other scheme', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeHref('file:///C:/Users/chris/secret.txt')).toBe(false)
    expect(isSafeHref('ftp://example.com')).toBe(false)
    expect(isSafeHref('//example.com')).toBe(false)
    expect(isSafeHref('/relative/path')).toBe(false)
    expect(isSafeHref('example.com')).toBe(false)
  })
  it('rejects hrefs containing whitespace, newlines, control or format characters', () => {
    expect(isSafeHref('https://exa mple.com')).toBe(false)
    expect(isSafeHref('https://example.com/\npath')).toBe(false)
    expect(isSafeHref('https://example.com/\tx')).toBe(false)
    expect(isSafeHref('https://example.com/\u0000')).toBe(false)
    expect(isSafeHref('https://example.com/\u0001x')).toBe(false)
    expect(isSafeHref('https://example.com/\u200bx')).toBe(false)
    expect(isSafeHref('https://example.com/\u00a0x')).toBe(false)
  })
  it('rejects empty, scheme-only and garbage input', () => {
    expect(isSafeHref('')).toBe(false)
    expect(isSafeHref('   ')).toBe(false)
    expect(isSafeHref('https://')).toBe(false)
    expect(isSafeHref('mailto:')).toBe(false)
    expect(isSafeHref(undefined as unknown as string)).toBe(false)
    expect(isSafeHref(null as unknown as string)).toBe(false)
    expect(isSafeHref(42 as unknown as string)).toBe(false)
  })
})

describe('renderInline', () => {
  it('returns plain text escaped, and empty for empty/garbage input', () => {
    expect(renderInline('hello world')).toBe('hello world')
    expect(renderInline('')).toBe('')
    expect(renderInline(undefined as unknown as string)).toBe('')
    expect(renderInline(null as unknown as string)).toBe('')
  })
  it('bold: ** and __', () => {
    expect(renderInline('a **bold** b')).toBe('a <strong>bold</strong> b')
    expect(renderInline('a __bold__ b')).toBe('a <strong>bold</strong> b')
  })
  it('em: * and _', () => {
    expect(renderInline('a *em* b')).toBe('a <em>em</em> b')
    expect(renderInline('a _em_ b')).toBe('a <em>em</em> b')
  })
  it('bold + em together and nested', () => {
    expect(renderInline('***both***')).toBe('<strong><em>both</em></strong>')
    expect(renderInline('**bold *em* bold**')).toBe('<strong>bold <em>em</em> bold</strong>')
    expect(renderInline('*em **bold** em*')).toBe('<em>em <strong>bold</strong> em</em>')
  })
  it('does not turn intraword underscores, lone stars or unmatched delimiters into markup', () => {
    expect(renderInline('snake_case_name')).toBe('snake_case_name')
    expect(renderInline('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(renderInline('a * b')).toBe('a * b')
    expect(renderInline('**unclosed')).toBe('**unclosed')
    expect(renderInline('* not em *')).toBe('* not em *')
    expect(renderInline('2**3')).toBe('2**3')
    expect(renderInline('~single~')).toBe('~single~')
  })
  it('code spans: contents escaped, never parsed, backtick runs matched by length', () => {
    expect(renderInline('use `a *b* c`')).toBe('use <code>a *b* c</code>')
    expect(renderInline('`<b>&</b>`')).toBe('<code>&lt;b&gt;&amp;&lt;/b&gt;</code>')
    expect(renderInline('`` a ` b ``')).toBe('<code>a ` b</code>')
    expect(renderInline('`[x](https://e.com)`')).toBe('<code>[x](https://e.com)</code>')
    expect(renderInline('`unclosed')).toBe('`unclosed')
    expect(renderInline('a `` b')).toBe('a `` b')
  })
  it('emphasis delimiters inside a code span do not close an outer span', () => {
    expect(renderInline('*em `a*b` em*')).toBe('<em>em <code>a*b</code> em</em>')
  })
  it('links: safe hrefs become anchors with target + rel', () => {
    expect(renderInline('[site](https://example.com)')).toBe(link('https://example.com', 'site'))
    expect(renderInline('[mail](mailto:a@b.co)')).toBe(link('mailto:a@b.co', 'mail'))
    expect(renderInline('[t](https://example.com "title")')).toBe(link('https://example.com', 't'))
    expect(renderInline('[t](<https://example.com>)')).toBe(link('https://example.com', 't'))
    expect(renderInline('[w](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
      link('https://en.wikipedia.org/wiki/Foo_(bar)', 'w')
    )
    expect(renderInline('[**b** and `c`](https://example.com)')).toBe(
      link('https://example.com', '<strong>b</strong> and <code>c</code>')
    )
  })
  it('links: unsafe hrefs render as literal "text (href)"', () => {
    expect(renderInline('[click](javascript:alert(1))')).toBe('click (javascript:alert(1))')
    expect(renderInline('[click](  JavaScript:alert(1))')).toBe('click (JavaScript:alert(1))')
    expect(renderInline('[f](file:///C:/x)')).toBe('f (file:///C:/x)')
    expect(renderInline('[d](data:text/html,x)')).toBe('d (data:text/html,x)')
    expect(renderInline('[v](vbscript:x)')).toBe('v (vbscript:x)')
    expect(renderInline('[rel](./local.md)')).toBe('rel (./local.md)')
    expect(renderInline('[sp](https://exa mple.com)')).toBe('sp (https://exa mple.com)')
  })
  it("links: an unsafe href keeps the link text's inline markup and drops any title", () => {
    expect(renderInline('[a **b** `c`](./rel.md)')).toBe('a <strong>b</strong> <code>c</code> (./rel.md)')
    expect(renderInline('[t](javascript:x "title")')).toBe('t (javascript:x)')
  })
  it('links: malformed syntax stays literal', () => {
    expect(renderInline('[no dest]')).toBe('[no dest]')
    // an unclosed link is literal — the bare URL after "(" still autolinks, as it would anywhere
    expect(renderInline('[unclosed](https://example.com')).toBe(`[unclosed](${link('https://example.com')}`)
    expect(renderInline('[unclosed](./x')).toBe('[unclosed](./x')
    expect(renderInline('[ref][1]')).toBe('[ref][1]')
    expect(renderInline('a [ b')).toBe('a [ b')
  })
  it('links: never nests anchors', () => {
    expect(renderInline('[https://a.com](https://b.com)')).toBe(link('https://b.com', 'https://a.com'))
    expect(renderInline('[x [y](https://a.com)](https://b.com)')).toBe(
      link('https://b.com', 'x y (https://a.com)')
    )
  })
  it('images render as their alt text, never as <img>', () => {
    expect(renderInline('![Logo](https://example.com/logo.png)')).toBe('[image: Logo]')
    expect(renderInline('![](x.png)')).toBe('[image]')
    expect(renderInline('![<b>](javascript:x)')).toBe('[image: &lt;b&gt;]')
  })
  it('autolinks bare http(s) URLs and leaves sentence punctuation outside', () => {
    expect(renderInline('see https://example.com/a?b=1&c=2.')).toBe(
      `see ${link('https://example.com/a?b=1&amp;c=2', 'https://example.com/a?b=1&amp;c=2')}.`
    )
    expect(renderInline('(https://example.com)')).toBe(`(${link('https://example.com')})`)
    expect(renderInline('<https://example.com>')).toBe(`&lt;${link('https://example.com')}&gt;`)
    expect(renderInline('https://example.com/x_(y)')).toBe(link('https://example.com/x_(y)'))
    expect(renderInline('**https://example.com**')).toBe(`<strong>${link('https://example.com')}</strong>`)
  })
  it('does not autolink mid-word or non-http schemes', () => {
    expect(renderInline('xhttps://example.com')).toBe('xhttps://example.com')
    expect(renderInline('ftp://example.com')).toBe('ftp://example.com')
    expect(renderInline('javascript://example.com')).toBe('javascript://example.com')
  })
  it('autolinks plain http:// too; bare mailto: and www. addresses stay text', () => {
    expect(renderInline('go http://example.com/x now')).toBe(`go ${link('http://example.com/x')} now`)
    expect(renderInline('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(renderInline('www.example.com')).toBe('www.example.com')
  })
  it('block syntax is inert in renderInline (headings, lists, fences are just text)', () => {
    expect(renderInline('# not heading\n- not list')).toBe('# not heading<br>- not list')
    expect(renderInline('> not quote')).toBe('&gt; not quote')
  })
  it('strikethrough', () => {
    expect(renderInline('a ~~gone~~ b')).toBe('a <del>gone</del> b')
    expect(renderInline('~~**x**~~')).toBe('<del><strong>x</strong></del>')
  })
  it('backslash escapes', () => {
    expect(renderInline('\\*not em\\*')).toBe('*not em*')
    expect(renderInline('\\_not em\\_')).toBe('_not em_')
    expect(renderInline('\\`not code\\`')).toBe('`not code`')
    expect(renderInline('\\[not a link\\](https://x.com)')).toBe(`[not a link](${link('https://x.com')})`)
    expect(renderInline('\\\\')).toBe('\\')
    expect(renderInline('\\a \\')).toBe('\\a \\')
  })
  it('renders a newline as a hard break', () => {
    expect(renderInline('a\nb')).toBe('a<br>b')
  })
  it('escapes raw HTML wherever it appears', () => {
    expect(renderInline('<b>x</b> & "q" \'s\'')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot; &#39;s&#39;')
    expect(renderInline('**<i>x</i>**')).toBe('<strong>&lt;i&gt;x&lt;/i&gt;</strong>')
  })
  it('treats CRLF and a lone CR as hard breaks (no stray \\r in the output)', () => {
    expect(renderInline('a\r\nb')).toBe('a<br>b')
    expect(renderInline('a\rb')).toBe('a<br>b')
    expect(renderInline('a\r\n')).toBe('a<br>')
  })
  it('keeps intraword underscores next to non-ASCII letters (Unicode alphanumerics)', () => {
    expect(renderInline('café_au_lait')).toBe('café_au_lait')
    expect(renderInline('naïve_case_x')).toBe('naïve_case_x')
    expect(renderInline('_a_é')).toBe('_a_é')
    expect(renderInline('日本_語_')).toBe('日本_語_')
    expect(renderInline('é _em_ ü')).toBe('é <em>em</em> ü')
  })
  it('a bare URL stops at a backtick so a following code span stays intact', () => {
    expect(renderInline('https://x.com/`code` after')).toBe(
      `${link('https://x.com/')}<code>code</code> after`
    )
    expect(renderInline('see https://x.com/`a b` end')).toBe(
      `see ${link('https://x.com/')}<code>a b</code> end`
    )
    expect(renderInline('https://x.com/a`b')).toBe(`${link('https://x.com/a')}\`b`)
  })
  it('caps link nesting instead of overflowing the stack, and never nests anchors', () => {
    const deep = '['.repeat(5000) + 'a' + '](https://x.com)'.repeat(5000)
    let html = ''
    expect(() => {
      html = renderInline(deep)
    }).not.toThrow()
    expect(html.length).toBeGreaterThan(0)
    expect(html.match(/<a /g)?.length ?? 0).toBe(1)
    // levels inside the anchor render as "text (href)"; past the cap the syntax is literal
    expect(html).toContain(' (https://x.com)')
    expect(html).toContain('a](https://x.com)')
    expect(html).not.toContain('<a href="https://x.com"' + A + '><a ')
    // modest nesting still renders fully
    expect(renderInline('[**[x](https://a.com)**](https://b.com)')).toBe(
      link('https://b.com', '<strong>x (https://a.com)</strong>')
    )
  })
})

describe('renderMarkdown: blocks', () => {
  it('returns empty for empty, whitespace-only and garbage input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   \n\n\t\n')).toBe('')
    expect(renderMarkdown(undefined as unknown as string)).toBe('')
    expect(renderMarkdown(null as unknown as string)).toBe('')
    expect(renderMarkdown(7 as unknown as string)).toBe('')
  })
  it('ATX headings h1..h6, with optional closing hashes and inline markup', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderMarkdown('## Two ##')).toBe('<h2>Two</h2>')
    expect(renderMarkdown('### Three')).toBe('<h3>Three</h3>')
    expect(renderMarkdown('#### Four')).toBe('<h4>Four</h4>')
    expect(renderMarkdown('##### Five')).toBe('<h5>Five</h5>')
    expect(renderMarkdown('###### Six')).toBe('<h6>Six</h6>')
    expect(renderMarkdown('# **Bold** title')).toBe('<h1><strong>Bold</strong> title</h1>')
    expect(renderMarkdown('#\tTabbed')).toBe('<h1>Tabbed</h1>')
  })
  it('is not a heading without a space or with more than six hashes', () => {
    expect(renderMarkdown('#nospace')).toBe('<p>#nospace</p>')
    expect(renderMarkdown('####### seven')).toBe('<p>####### seven</p>')
  })
  it('paragraphs: consecutive lines join with a space, blank lines separate', () => {
    expect(renderMarkdown('a\nb')).toBe('<p>a b</p>')
    expect(renderMarkdown('a\n\nb')).toBe('<p>a</p>\n<p>b</p>')
    expect(renderMarkdown('a\n\n\n\nb')).toBe('<p>a</p>\n<p>b</p>')
    expect(renderMarkdown('  indented   \n   more  ')).toBe('<p>indented<br>more</p>')
  })
  it('paragraphs: a line ending in two spaces is a hard break', () => {
    expect(renderMarkdown('a  \nb')).toBe('<p>a<br>b</p>')
    expect(renderMarkdown('a \nb')).toBe('<p>a b</p>')
    expect(renderMarkdown('a    \nb  \nc')).toBe('<p>a<br>b<br>c</p>')
  })
  it('paragraphs are interrupted by headings, fences, rules, quotes and bullet lists', () => {
    expect(renderMarkdown('text\n# h')).toBe('<p>text</p>\n<h1>h</h1>')
    expect(renderMarkdown('text\n- item')).toBe('<p>text</p>\n<ul><li>item</li></ul>')
    expect(renderMarkdown('text\n> q')).toBe('<p>text</p>\n<blockquote><p>q</p></blockquote>')
    expect(renderMarkdown('text\n***')).toBe('<p>text</p>\n<hr>')
    expect(renderMarkdown('text\n```\nc\n```')).toBe('<p>text</p>\n<pre><code>c</code></pre>')
  })
  it('an ordered list only interrupts a paragraph when it starts at 1', () => {
    expect(renderMarkdown('text\n1. one')).toBe('<p>text</p>\n<ol><li>one</li></ol>')
    expect(renderMarkdown('in 2024. it rained')).toBe('<p>in 2024. it rained</p>')
    expect(renderMarkdown('year\n2024. it rained')).toBe('<p>year 2024. it rained</p>')
  })
  it('fenced code blocks: escaped, not inline-parsed, language class sanitized', () => {
    expect(renderMarkdown('```ts\nconst a = 1\n```')).toBe(
      '<pre><code class="language-ts">const a = 1</code></pre>'
    )
    expect(renderMarkdown('```\nplain\n```')).toBe('<pre><code>plain</code></pre>')
    expect(renderMarkdown('~~~\ntilde\n~~~')).toBe('<pre><code>tilde</code></pre>')
    expect(renderMarkdown('```\n**not bold** [x](https://e.com)\n```')).toBe(
      '<pre><code>**not bold** [x](https://e.com)</code></pre>'
    )
    expect(renderMarkdown('```C++ {.line-numbers}\nx\n```')).toBe(
      '<pre><code class="language-c">x</code></pre>'
    )
    expect(renderMarkdown('```"><script>\nx\n```')).toBe('<pre><code class="language-script">x</code></pre>')
    expect(renderMarkdown('```js\nline 1\n\nline 3\n```')).toBe(
      '<pre><code class="language-js">line 1\n\nline 3</code></pre>'
    )
  })
  it('fenced code blocks: an unterminated fence swallows the rest as code', () => {
    expect(renderMarkdown('```\na\n# not a heading\n- not a list')).toBe(
      '<pre><code>a\n# not a heading\n- not a list</code></pre>'
    )
  })
  it('fenced code blocks: closer must match the fence char and be at least as long', () => {
    expect(renderMarkdown('````\n```\nstill code\n````')).toBe('<pre><code>```\nstill code</code></pre>')
    expect(renderMarkdown('```\n~~~\n```')).toBe('<pre><code>~~~</code></pre>')
    expect(renderMarkdown('```\ntabs\tkept\n```')).toBe('<pre><code>tabs\tkept</code></pre>')
  })
  it('an indented fence strips the same indent from its content', () => {
    expect(renderMarkdown('  ```\n  code\n  ```')).toBe('<pre><code>code</code></pre>')
    expect(renderMarkdown('  ```\n      deep\n  ```')).toBe('<pre><code>    deep</code></pre>')
  })
  it('a fence indented four or more spaces (or a tab) is still a fence — there are no indented code blocks', () => {
    expect(renderMarkdown('    ```sh\n    npm i\n    ```')).toBe(
      '<pre><code class="language-sh">npm i</code></pre>'
    )
    expect(renderMarkdown('\t```\n\tx\n\t```')).toBe('<pre><code>x</code></pre>')
    expect(renderMarkdown('    ```\n    x\n    ```\nafter')).toBe('<pre><code>x</code></pre>\n<p>after</p>')
    expect(renderMarkdown('text\n    ```\n    x\n    ```')).toBe('<p>text</p>\n<pre><code>x</code></pre>')
  })
  it('a bare fence with nothing after it is an empty code block', () => {
    expect(renderMarkdown('```')).toBe('<pre><code></code></pre>')
    expect(renderMarkdown('```js')).toBe('<pre><code class="language-js"></code></pre>')
  })
  it('unordered lists with -, * and +', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('+ a\n+ b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('- **a** and `b`')).toBe('<ul><li><strong>a</strong> and <code>b</code></li></ul>')
  })
  it('ordered lists, with a start attribute when not starting at 1', () => {
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(renderMarkdown('1. a\n1. b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(renderMarkdown('3. a\n4. b')).toBe('<ol start="3"><li>a</li><li>b</li></ol>')
    expect(renderMarkdown('1) a')).toBe('<ol><li>a</li></ol>')
  })
  it('nests one level by 2+ spaces of indentation (tabs count as 4)', () => {
    expect(renderMarkdown('- a\n  - b\n  - c\n- d')).toBe(
      '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>'
    )
    expect(renderMarkdown('1. a\n   - b\n2. c')).toBe('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>')
    expect(renderMarkdown('- a\n\t1. b')).toBe('<ul><li>a<ol><li>b</li></ol></li></ul>')
    expect(renderMarkdown('- a\n    - deep')).toBe('<ul><li>a<ul><li>deep</li></ul></li></ul>')
  })
  it('list items: continuation lines join the item, blank-separated items stay one list', () => {
    expect(renderMarkdown('- a\n  more\n- b')).toBe('<ul><li>a more</li><li>b</li></ul>')
    expect(renderMarkdown('- a\nlazy\n- b')).toBe('<ul><li>a lazy</li><li>b</li></ul>')
    expect(renderMarkdown('- a\n\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('- a\n\ntext')).toBe('<ul><li>a</li></ul>\n<p>text</p>')
  })
  it('list items: a different marker family or an outdented block ends the list', () => {
    expect(renderMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul>\n<ol><li>b</li></ol>')
    expect(renderMarkdown('- a\n# h')).toBe('<ul><li>a</li></ul>\n<h1>h</h1>')
    expect(renderMarkdown('- a\n---')).toBe('<ul><li>a</li></ul>\n<hr>')
    expect(renderMarkdown('-')).toBe('<ul><li></li></ul>')
    expect(renderMarkdown('-notalist')).toBe('<p>-notalist</p>')
    expect(renderMarkdown('1.5 things')).toBe('<p>1.5 things</p>')
  })
  it('a fenced code block indented under a list item stays inside that item', () => {
    expect(renderMarkdown('- a\n  ```\n  code\n  ```\n- b')).toBe(
      '<ul><li>a<pre><code>code</code></pre></li><li>b</li></ul>'
    )
    expect(renderMarkdown('1. Install:\n   ```sh\n   npm i\n   ```\n2. Run')).toBe(
      '<ol><li>Install:<pre><code class="language-sh">npm i</code></pre></li><li>Run</li></ol>'
    )
    // four-space indent (the common README shape) and text after the block, in source order
    expect(renderMarkdown('- a\n    ```\n    x\n    ```\n  after')).toBe(
      '<ul><li>a<pre><code>x</code></pre>after</li></ul>'
    )
    // a blank line before the fence does not end the list
    expect(renderMarkdown('- a\n\n  ```\n  x\n  ```\n- b')).toBe(
      '<ul><li>a<pre><code>x</code></pre></li><li>b</li></ul>'
    )
    // a fence opening on the marker line itself
    expect(renderMarkdown('- ```js\n  x\n  ```\n- b')).toBe(
      '<ul><li><pre><code class="language-js">x</code></pre></li><li>b</li></ul>'
    )
    expect(renderMarkdown('1. ```\n   x\n   ```\n2. b')).toBe(
      '<ol><li><pre><code>x</code></pre></li><li>b</li></ol>'
    )
    // under a nested item, and inside a blockquote
    expect(renderMarkdown('- a\n  - b\n    ```\n    x\n    ```\n- c')).toBe(
      '<ul><li>a<ul><li>b<pre><code>x</code></pre></li></ul></li><li>c</li></ul>'
    )
    expect(renderMarkdown('> - a\n>   ```\n>   x\n>   ```')).toBe(
      '<blockquote><ul><li>a<pre><code>x</code></pre></li></ul></blockquote>'
    )
  })
  it('a fence inside a list item is escaped, never inline-parsed, and an unterminated one stays in the item', () => {
    expect(renderMarkdown('- a\n  ```\n  **x** [y](https://e.com) <b>\n  ```')).toBe(
      '<ul><li>a<pre><code>**x** [y](https://e.com) &lt;b&gt;</code></pre></li></ul>'
    )
    expect(renderMarkdown('- a\n  ```C++\n  x\n  ```')).toBe(
      '<ul><li>a<pre><code class="language-c">x</code></pre></li></ul>'
    )
    expect(renderMarkdown('- a\n  ```\n  unterminated\n- b')).toBe(
      '<ul><li>a<pre><code>unterminated\n- b</code></pre></li></ul>'
    )
  })
  it("a fence at the list's own indent is a sibling block that ends the list", () => {
    expect(renderMarkdown('- a\n```\nc\n```')).toBe('<ul><li>a</li></ul>\n<pre><code>c</code></pre>')
    expect(renderMarkdown('- a\n\n```\nx\n```')).toBe('<ul><li>a</li></ul>\n<pre><code>x</code></pre>')
    expect(renderMarkdown('- a\n  ```\n  x\n  ```\n1. b')).toBe(
      '<ul><li>a<pre><code>x</code></pre></li></ul>\n<ol><li>b</li></ol>'
    )
  })
  it('blockquotes wrap inner blocks and nest', () => {
    expect(renderMarkdown('> a\n> b')).toBe('<blockquote><p>a b</p></blockquote>')
    expect(renderMarkdown('> a\n>\n> b')).toBe('<blockquote><p>a</p>\n<p>b</p></blockquote>')
    expect(renderMarkdown('> # h\n> - li')).toBe('<blockquote><h1>h</h1>\n<ul><li>li</li></ul></blockquote>')
    expect(renderMarkdown('> > deep')).toBe('<blockquote><blockquote><p>deep</p></blockquote></blockquote>')
    expect(renderMarkdown('>tight')).toBe('<blockquote><p>tight</p></blockquote>')
    expect(renderMarkdown('> a\n\n> b')).toBe(
      '<blockquote><p>a</p></blockquote>\n<blockquote><p>b</p></blockquote>'
    )
  })
  it('nested constructs: a blockquote holding a list holding inline markup', () => {
    expect(renderMarkdown('> - **a** `b`\n> - [c](https://e.com)')).toBe(
      `<blockquote><ul><li><strong>a</strong> <code>b</code></li><li>${link('https://e.com', 'c')}</li></ul></blockquote>`
    )
    expect(renderMarkdown('> 1. a\n>    - b')).toBe(
      '<blockquote><ol><li>a<ul><li>b</li></ul></li></ol></blockquote>'
    )
  })
  it('horizontal rules', () => {
    expect(renderMarkdown('---')).toBe('<hr>')
    expect(renderMarkdown('***')).toBe('<hr>')
    expect(renderMarkdown('___')).toBe('<hr>')
    expect(renderMarkdown('- - -')).toBe('<hr>')
    expect(renderMarkdown('----------')).toBe('<hr>')
    expect(renderMarkdown('--')).toBe('<p>--</p>')
    expect(renderMarkdown('-*-')).toBe('<p>-*-</p>')
  })
  it('tables: header, separator, body; alignment only for left/center/right', () => {
    expect(renderMarkdown('| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | 2 | 3 | 4 |')).toBe(
      '<table><thead><tr><th>a</th><th style="text-align:left">b</th><th style="text-align:center">c</th>' +
        '<th style="text-align:right">d</th></tr></thead><tbody><tr><td>1</td><td style="text-align:left">2</td>' +
        '<td style="text-align:center">3</td><td style="text-align:right">4</td></tr></tbody></table>'
    )
  })
  it('tables: outer pipes optional, cells inline-rendered, escaped pipes literal', () => {
    // GFM: a pipe splits the cell even inside a code span unless it is escaped
    expect(renderMarkdown('a | b\n--|--\n**1** | `x\\|y`')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><strong>1</strong></td><td><code>x|y</code></td></tr></tbody></table>'
    )
    expect(renderMarkdown('a | b\n--|--\n1 | `x|y`')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>`x</td></tr></tbody></table>'
    )
    expect(renderMarkdown('| a |\n|---|\n| x \\| y |')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>x | y</td></tr></tbody></table>'
    )
  })
  it('tables: cells render links, images and escaped HTML; spaced and tight separators both work', () => {
    expect(renderMarkdown('| [x](https://e.com) | <b> |\n|---|---|\n| ![i](y) | `<i>` |')).toBe(
      `<table><thead><tr><th>${link('https://e.com', 'x')}</th><th>&lt;b&gt;</th></tr></thead>` +
        '<tbody><tr><td>[image: i]</td><td><code>&lt;i&gt;</code></td></tr></tbody></table>'
    )
    expect(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    )
    expect(renderMarkdown('|a|b|\n|-|-|\n|1|2|')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    )
  })
  it('tables: short rows are padded, long rows truncated, no body rows is fine', () => {
    expect(renderMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>'
    )
    expect(renderMarkdown('| a |\n|---|')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody></tbody></table>'
    )
  })
  it('tables: end at a blank line or a line without a pipe; mismatched columns are not a table', () => {
    expect(renderMarkdown('| a |\n|---|\n| 1 |\n\ntext')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>\n<p>text</p>'
    )
    expect(renderMarkdown('| a |\n|---|\ntext')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody></tbody></table>\n<p>text</p>'
    )
    expect(renderMarkdown('| a | b |\n|---|\n| 1 |')).toBe('<p>| a | b | |---| | 1 |</p>')
    expect(renderMarkdown('a | b\n---')).toBe('<p>a | b</p>\n<hr>')
  })
  it('a table can follow a paragraph directly', () => {
    expect(renderMarkdown('intro\n| a |\n|---|\n| 1 |')).toBe(
      '<p>intro</p>\n<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
    )
  })
  it('renders a mixed document in order, joined by newlines', () => {
    const md = [
      '# Doc',
      '',
      'Intro with *em*.',
      '',
      '- one',
      '- two',
      '',
      '```sh',
      'npm test',
      '```',
      '',
      '> note',
      '',
      '---',
      '',
      'Bye.'
    ].join('\n')
    expect(renderMarkdown(md)).toBe(
      [
        '<h1>Doc</h1>',
        '<p>Intro with <em>em</em>.</p>',
        '<ul><li>one</li><li>two</li></ul>',
        '<pre><code class="language-sh">npm test</code></pre>',
        '<blockquote><p>note</p></blockquote>',
        '<hr>',
        '<p>Bye.</p>'
      ].join('\n')
    )
  })
})

describe('renderMarkdown: robustness', () => {
  it('treats CRLF and lone CR like LF', () => {
    expect(renderMarkdown('# T\r\n\r\na\r\nb\r\n')).toBe('<h1>T</h1>\n<p>a b</p>')
    expect(renderMarkdown('a\rb')).toBe('<p>a b</p>')
    expect(renderMarkdown('```\r\nx\r\n```\r\n')).toBe('<pre><code>x</code></pre>')
    expect(renderMarkdown('| a |\r\n|---|\r\n| 1 |')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
    )
    expect(renderMarkdown('> a\r\n> b')).toBe('<blockquote><p>a b</p></blockquote>')
    expect(renderMarkdown('- a\r\n- b\r\n')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('- a\r\n  ```\r\n  x\r\n  ```')).toBe(
      '<ul><li>a<pre><code>x</code></pre></li></ul>'
    )
  })
  it('tolerates tabs', () => {
    expect(renderMarkdown('-\titem')).toBe('<ul><li>item</li></ul>')
    expect(renderMarkdown('a\tb')).toBe('<p>a\tb</p>')
    expect(renderMarkdown('\t')).toBe('')
  })
  it('handles Windows paths as plain text (backslashes are not escapes before letters)', () => {
    expect(renderMarkdown('C:\\Users\\chris\\builder-hub')).toBe('<p>C:\\Users\\chris\\builder-hub</p>')
    expect(renderMarkdown('`C:\\Users\\chris`')).toBe('<p><code>C:\\Users\\chris</code></p>')
  })
  it('renders a 200 kB document well under a second', () => {
    const chunk = [
      '## Section heading',
      '',
      'A paragraph with **bold**, *em*, `code`, a [link](https://example.com/path?q=1) and https://bare.example.com/x.',
      'Second line with ~~strike~~ and \\*escaped\\* stars and <b>html</b>.  ',
      'After a hard break.',
      '',
      '- item one',
      '- item two with `code`',
      '  - nested',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted **text**',
      '',
      '| col | col |',
      '|:---:|----:|',
      '| a | b |',
      '',
      '```ts',
      'const x = "<script>"',
      '```',
      '',
      '---',
      ''
    ].join('\n')
    let md = ''
    while (md.length < 200 * 1024) md += chunk
    const t0 = performance.now()
    const html = renderMarkdown(md)
    const ms = performance.now() - t0
    expect(html.length).toBeGreaterThan(md.length / 2)
    expect(ms).toBeLessThan(1000)
  })
  it('stays linear on floods of unmatched delimiters', () => {
    const t0 = performance.now()
    renderMarkdown('*a '.repeat(30000))
    renderMarkdown('` '.repeat(30000) + '`` '.repeat(30000))
    renderMarkdown('~~ '.repeat(30000))
    expect(performance.now() - t0).toBeLessThan(1000)
  })
  it('stays linear on floods of brackets, parens and trailing URL punctuation (200 kB each)', () => {
    const t0 = performance.now()
    expect(renderMarkdown('['.repeat(200 * 1024))).toBe(`<p>${'['.repeat(200 * 1024)}</p>`)
    expect(renderMarkdown('![a]('.repeat(40 * 1024))).toBe(`<p>${'![a]('.repeat(40 * 1024)}</p>`)
    expect(renderMarkdown('[a]('.repeat(50 * 1024))).toBe(`<p>${'[a]('.repeat(50 * 1024)}</p>`)
    expect(renderMarkdown('https://x.com/' + ')'.repeat(200 * 1024))).toBe(
      `<p>${link('https://x.com/')}${')'.repeat(200 * 1024)}</p>`
    )
    expect(performance.now() - t0).toBeLessThan(1000)
  })
  it('caps blockquote nesting instead of overflowing the stack', () => {
    expect(renderMarkdown('> '.repeat(10) + 'x')).toBe(
      '<blockquote>'.repeat(10) + '<p>x</p>' + '</blockquote>'.repeat(10)
    )
    let html = ''
    expect(() => {
      html = renderMarkdown('>'.repeat(20000) + ' x')
    }).not.toThrow()
    // 32 real levels, then the rest of the line is an ordinary (escaped) paragraph
    expect(html.startsWith('<blockquote>'.repeat(32) + '<p>&gt;')).toBe(true)
    expect(html.endsWith(' x</p>' + '</blockquote>'.repeat(32))).toBe(true)
    expect(html).not.toContain('<blockquote>'.repeat(33))
  })
  it('caps list nesting: deeper items become siblings instead of recursing forever', () => {
    const md = Array.from({ length: 100 }, (_, k) => ' '.repeat(2 * k) + '- x').join('\n')
    let html = ''
    expect(() => {
      html = renderMarkdown(md)
    }).not.toThrow()
    expect(html.match(/<ul>/g)?.length).toBe(33)
    expect(html.match(/<li>/g)?.length).toBe(100)
    expect(html.match(/<\/ul>/g)?.length).toBe(33)
  })
  it('strips a leading UTF-8 BOM (Notepad writes one) but keeps one mid-text', () => {
    const bom = String.fromCharCode(0xfeff)
    expect(renderMarkdown(bom + '# T')).toBe('<h1>T</h1>')
    expect(renderMarkdown(bom + '- a')).toBe('<ul><li>a</li></ul>')
    expect(renderMarkdown(bom)).toBe('')
    expect(renderMarkdown(bom + '\r\n# T')).toBe('<h1>T</h1>')
    expect(renderMarkdown('a' + bom + 'b')).toBe('<p>a' + bom + 'b</p>')
  })
})

describe('renderMarkdown: XSS', () => {
  it('a script tag renders as text', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })
  it('an img with an onerror handler renders as text', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })
  it('a javascript: link never becomes an anchor', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).toBe('<p>click me (javascript:alert(1))</p>')
    expect(html).not.toContain('<a')
    expect(renderMarkdown('[x](JAVASCRIPT:alert(1))')).not.toContain('<a')
    expect(renderMarkdown('[x](java\tscript:alert(1))')).not.toContain('<a')
    expect(renderMarkdown('[x](&#106;avascript:alert(1))')).not.toContain('<a')
    expect(renderMarkdown('![x](javascript:alert(1))')).toBe('<p>[image: x]</p>')
  })
  it('link text containing quotes and tags is escaped inside the anchor', () => {
    expect(renderMarkdown('[a"><script>x</script>](https://example.com)')).toBe(
      `<p>${link('https://example.com', 'a&quot;&gt;&lt;script&gt;x&lt;/script&gt;')}</p>`
    )
    expect(renderMarkdown(`['single' "double"](https://example.com)`)).toBe(
      `<p>${link('https://example.com', '&#39;single&#39; &quot;double&quot;')}</p>`
    )
  })
  it('a safe href with quotes cannot break out of the attribute', () => {
    expect(renderMarkdown('[x](https://example.com/"onmouseover="alert(1))')).toBe(
      `<p>${link('https://example.com/&quot;onmouseover=&quot;alert(1)', 'x')}</p>`
    )
    expect(renderMarkdown("[x](https://example.com/'onmouseover='alert(1))")).toBe(
      `<p>${link('https://example.com/&#39;onmouseover=&#39;alert(1)', 'x')}</p>`
    )
    // a bare URL stops before "<" and sheds a trailing quote; the rest is escaped text
    expect(renderMarkdown('https://example.com/"><script>')).toBe(
      `<p>${link('https://example.com/')}&quot;&gt;&lt;script&gt;</p>`
    )
    expect(renderMarkdown('https://example.com/?q="x"y')).toBe(
      `<p>${link('https://example.com/?q=&quot;x&quot;y', 'https://example.com/?q=&quot;x&quot;y')}</p>`
    )
  })
  it('a code block containing </pre><script> stays inert', () => {
    expect(renderMarkdown('```html\n</pre><script>alert(1)</script>\n```')).toBe(
      '<pre><code class="language-html">&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>'
    )
    expect(renderMarkdown('`</code><script>x</script>`')).toBe(
      '<p><code>&lt;/code&gt;&lt;script&gt;x&lt;/script&gt;</code></p>'
    )
  })
  it('never emits a tag it did not build itself, anywhere in a hostile document', () => {
    const hostile = [
      '# <svg onload=alert(1)>',
      '<iframe src="https://evil.example"></iframe>',
      '- <a href="javascript:x">x</a>',
      '> <style>body{display:none}</style>',
      '| <script>x</script> | b |',
      '|---|---|',
      '| <img src=x onerror=x> | </td><script>y</script> |',
      '[<b>](https://example.com ""><script>")',
      '![<img src=x>](x)',
      '```<script>\n</script><script>alert(1)</script>\n```',
      '**<u>u</u>** ~~<s>s</s>~~ `<i>`',
      'https://example.com/</a><script>z</script>'
    ].join('\n')
    const html = renderMarkdown(hostile)
    assertOnlyOurTags(html)
    expect(html).not.toMatch(/<(script|img|iframe|svg|style|u|s|i)\b/i)
    expect(html).not.toMatch(/href="javascript/i)
  })
  it('the only-our-tags guard itself catches a leaked tag or attribute', () => {
    expect(() => assertOnlyOurTags('<p><img src=x></p>')).toThrow()
    expect(() => assertOnlyOurTags('<p onclick="x">a</p>')).toThrow()
    expect(() => assertOnlyOurTags('<p>a > b</p>')).toThrow()
    expect(() =>
      assertOnlyOurTags('<a href="javascript:x" target="_blank" rel="noopener noreferrer">a</a>')
    ).not.toThrow()
    expect(() => assertOnlyOurTags(renderMarkdown('# ok\n\n[a](https://x.com) `c`'))).not.toThrow()
  })
})

describe('markdownTitle', () => {
  it('takes the first # heading, stripped of inline markup and closing hashes', () => {
    expect(markdownTitle('# Hello')).toBe('Hello')
    expect(markdownTitle('intro\n\n# Later heading\ntext')).toBe('Later heading')
    expect(markdownTitle('# **Bold** `code` [link](https://e.com) #')).toBe('Bold code link')
    expect(markdownTitle('#   spaced   ')).toBe('spaced')
    expect(markdownTitle('# A & B <c>')).toBe('A & B <c>')
  })
  it('prefers the first h1 over an earlier h2', () => {
    expect(markdownTitle('## Sub\n# Main')).toBe('Main')
  })
  it('falls back to the first non-empty line (heading marker stripped)', () => {
    expect(markdownTitle('\n\nplain first line\nsecond')).toBe('plain first line')
    expect(markdownTitle('## Sub only')).toBe('Sub only')
    expect(markdownTitle('#nospace')).toBe('#nospace')
    expect(markdownTitle('---\nafter rule')).toBe('after rule')
    expect(markdownTitle('```\ncode\n```')).toBe('code')
  })
  it('handles CRLF, tabs and empty/garbage input', () => {
    expect(markdownTitle('# Win\r\n\r\ntext')).toBe('Win')
    expect(markdownTitle('\r\nfirst\r\n')).toBe('first')
    expect(markdownTitle('#\tTabbed')).toBe('Tabbed')
    expect(markdownTitle('')).toBe('')
    expect(markdownTitle('   \n\n  ')).toBe('')
    expect(markdownTitle(undefined as unknown as string)).toBe('')
    expect(markdownTitle(null as unknown as string)).toBe('')
  })
  it('does not let the # heading regex span lines (the stub regex did)', () => {
    // '^#\s+(.+)$' would have swallowed the blank lines and captured '# Real' verbatim
    expect(markdownTitle('#\n\n# Real')).toBe('Real')
    // a bare '#' line is empty heading content, so the fallback moves on
    expect(markdownTitle('#\n\nnot a title')).toBe('not a title')
    expect(markdownTitle('# #\n\nnext')).toBe('next')
  })
  it('never takes a "# comment" inside a fenced code block as the title', () => {
    expect(markdownTitle('```sh\n# install\nnpm i\n```\n\n# Real')).toBe('Real')
    expect(markdownTitle('intro\n~~~\n# fake\n~~~\n# Real')).toBe('Real')
    expect(markdownTitle('````\n```\n# fake\n```\n````\n# Real')).toBe('Real')
    expect(markdownTitle('    ```\n    # fake\n    ```\n# Real')).toBe('Real')
    expect(markdownTitle('- a\n  ```\n  # fake\n  ```\n# Real')).toBe('Real')
    // an unterminated fence hides every later heading, so the fallback applies
    expect(markdownTitle('```\n# a\n# b')).toBe('a')
    // no heading anywhere: the fallback may still come from fenced content
    expect(markdownTitle('```\n# only comment\n```')).toBe('only comment')
  })
  it('strips a leading UTF-8 BOM', () => {
    const bom = String.fromCharCode(0xfeff)
    expect(markdownTitle(bom + '# T')).toBe('T')
    expect(markdownTitle(bom + 'first')).toBe('first')
    expect(markdownTitle(bom)).toBe('')
  })
})
