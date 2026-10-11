import { Lexer, Marked } from 'marked'
import { deliverableDocumentInputSchema } from '@vikan/sdk/agent'
import { DeliverableLocalError } from '../state/deliverables.ts'
import { EXIT_USAGE } from '../exit.ts'

const markdown = new Marked({ gfm: true })
const components = new Set(['flow', 'sequence', 'tree', 'er', 'timeline', 'callout', 'kv', 'ask'])
const forbiddenFences = new Set(['html', 'svg', 'annot', 'limits'])
// Match the pinned renderer's outer parser, before its Markdown lexer runs.
const fenceOpen = /^(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/
const attrs = /([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g
const spacedImage = /(`[^`\n]*`)|(!\[[^\]\n]*\]\()\s*((?:[^()<>"\n]|\([^()<>"\n]*\))*?)(\s+"[^"\n]*")?\s*\)/g
function invalid(line: number, message: string): never {
  throw new DeliverableLocalError(EXIT_USAGE, `L${line}: ${message}`)
}

interface MarkdownNode {
  type: string
  raw: string
  text?: string
  href?: string
  tokens?: MarkdownNode[]
  items?: MarkdownNode[]
  header?: MarkdownCell[]
  rows?: MarkdownCell[][]
}
interface MarkdownCell { text: string; tokens: MarkdownNode[] }

/** Walk token siblings in source order, then their own text (blockquote/list
 * prefixes may have been removed). Earlier literal code must not steal the
 * location of an identical active tag or image later in the paragraph. */
function inspectTokens(tokens: readonly MarkdownNode[], input: string, line: number): void {
  let cursor = 0
  for (const token of tokens) {
    const position = input.indexOf(token.raw, cursor)
    const start = position < 0 ? cursor : position
    const at = line + input.slice(0, start).split('\n').length - 1
    cursor = start + token.raw.length
    if (token.type === 'html') invalid(at, 'Raw HTML tags are disabled. Put examples in a text code block or use Markdown.')
    if (token.type === 'image') invalid(at, 'Images are disabled. Describe the evidence using its commit, path and line numbers.')
    if (token.type === 'link') {
      // Entity/control obfuscation must not turn a link into an active URI scheme.
      const href = String(token.href).replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_: string, hex: string | undefined, dec: string) => {
        const n = Number.parseInt(hex ?? dec, hex ? 16 : 10)
        return n <= 0x10ffff ? String.fromCodePoint(n) : ''
      }).replace(/&colon;/gi, ':').replace(/&(?:tab|newline);/gi, '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
      if (/^[a-z][\w+.-]*:/i.test(href) && !/^(https?|mailto):/i.test(href)) invalid(at, 'Use an http, https, mailto, relative or fragment link.')
    }
    if (token.tokens) {
      const text = token.text ?? token.raw, offset = Math.max(0, token.raw.indexOf(text))
      inspectTokens(token.tokens, text, at + token.raw.slice(0, offset).split('\n').length - 1)
    }
    if (token.items) inspectTokens(token.items, token.raw, at)
    for (const cell of token.header ?? []) inspectTokens(cell.tokens, cell.text, at)
    token.rows?.forEach((row, index) => { for (const cell of row) inspectTokens(cell.tokens, cell.text, at + index + 2) })
  }
}

function validateMarkdown(text: string, line: number, inline = false): void {
  // The renderer accepts spaces in image destinations; use the same preprocessing.
  const input = text.replace(spacedImage, (whole, code, head, dest: string, title = '') => code || !/\s/.test(dest) ? whole : `${head}<${dest}>${title})`)
  const tokens = inline ? Lexer.lexInline(input, { gfm: true }) : markdown.lexer(input)
  inspectTokens(tokens, input, line)
}

/** Validate only the wrapper's restricted syntax; upstream still owns rendering. */
export function validatePlanSource(source: string): { format: 'text'; text: string } {
  if (!source.trim()) invalid(1, 'The plan source is empty.')
  if (source.includes('\0')) invalid(1, 'NUL characters are not valid plan text.')
  const document = deliverableDocumentInputSchema.safeParse({ format: 'text', text: source })
  if (!document.success) invalid(1, 'Plan text exceeds the shared document size or complexity limits (at most 100,000 characters).')
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let start = 0, panels = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end < 0) invalid(1, 'Close frontmatter with --- on its own line.')
    for (let i = 1; i < end; i++) {
      const line = lines[i]!.trim()
      if (/^(?:stageId|stage-id|stage_id|revision)\s*:/i.test(line)) invalid(i + 1, 'Stage IDs and revisions are assigned only by the publish receipt.')
      validateMarkdown(line, i + 1, true)
    }
    start = end + 1
  }
  let mdStart = start
  const flush = (end: number) => { if (end > mdStart) validateMarkdown(lines.slice(mdStart, end).join('\n'), mdStart + 1) }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!, fence = line.match(fenceOpen)
    if (!fence) {
      if (/^\s+(?:`{3,}|~{3,})/.test(line)) invalid(i + 1, 'Start fenced blocks at the beginning of the line (no indentation).')
      if (/^##\s+(.+?)\s*$/.test(line)) {
        if (++panels > 8) invalid(i + 1, 'Use at most 8 panels; combine related sections.')
        flush(i)
        validateMarkdown(line, i + 1, true)
        mdStart = i + 1
      }
      continue
    }
    flush(i)
    const marker = fence[1]!, bare = fence[2]!.includes('=')
    const lang = bare ? '' : fence[2]!.toLowerCase()
    const args = bare ? `${fence[2]} ${fence[3]}` : fence[3]!
    if (forbiddenFences.has(lang)) invalid(i + 1, `${lang} blocks are disabled. Use text for literal code, or a supported diagram.`)
    if ([...args.matchAll(attrs)].some(match => match[1]!.toLowerCase() === 'src')) invalid(i + 1, 'Code src references are disabled. Paste explicit code and cite commit/path/lines.')
    const closing = new RegExp(`^${marker[0]}{${marker.length},}\\s*$`)
    let end = i + 1
    while (end < lines.length && !closing.test(lines[end]!)) end++
    if (end === lines.length) invalid(i + 1, 'Unclosed fence; close with the same marker and at least the opening length.')
    if (components.has(lang)) {
      if (lang === 'ask' && panels === 0) invalid(i + 1, 'Put ask under the ## panel whose plan it changes.')
      const body = lines.slice(i + 1, end)
      if (lang === 'callout') validateMarkdown(body.join('\n'), i + 2)
      else if (['kv', 'tree', 'timeline', 'ask'].includes(lang)) {
        let askQuestion = true
        body.forEach((raw, index) => {
          if (!raw.trim() || lang !== 'tree' && raw.trim().startsWith('//')) return
          const question = lang === 'ask' && askQuestion
          askQuestion = false
          const value = lang === 'kv' ? raw.replace(/^[^:：]*[:：]\s*/, '') : question ? raw.trim() : raw.trim().replace(/^[*+~-]\s*/, '')
          // These components split fields before Markdown parsing. Validate each
          // field so a code span cannot hide a tag on the other side of a pipe.
          for (const field of lang === 'kv' || question ? [value] : value.split('|')) validateMarkdown(field, i + index + 2, true)
        })
      }
    }
    i = end
    mdStart = end + 1
  }
  flush(lines.length)
  return { format: 'text', text: source }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
