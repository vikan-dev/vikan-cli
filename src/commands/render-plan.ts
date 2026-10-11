import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readSync, statSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DELIVERABLE_TEXT_MAX_LENGTH } from '@vikan/sdk/agent'
import { MCP_FILE_MAX_BYTES } from '@vikan/sdk/agent'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.ts'
import { DeliverableLocalError } from '../state/deliverables.ts'
import { bundleSource, rendererCommit, rendererLicenses } from '../plan-renderer/resources.ts'
import { escapeHtml, validatePlanSource } from '../plan-renderer/validate.ts'
import type { CliDeps } from './types.ts'

export const renderPlanHelp = `Usage: vikan deliverables render-plan --source <plan.md> --output <plan.html>
       vikan deliverables render-plan --licenses

Purely local: no --run, pairing, Herdr, network, global skill or browser required.
Reads one UTF-8 regular-file snapshot. Outputs an independent offline HTML file
and JSON: outputPath, byteSize, sourceSha256, rendererCommit, document.
Use that exact document in publish-stage; attach the upload receipt's fileId.
Local success is not publication: confirm the publish-stage server receipt.

Write # vikan <title>, then ## panel headings (recommended 4–6, maximum 8).
Paragraphs, lists, GFM tables, links and explicit code blocks are supported.
Start fences at column 1; close with the same marker and at least its length.
HTML examples belong in text/ts/etc. code fences, never html/svg fences.
Optional flat frontmatter: title: vikan Plan, lang: en (or your task language).
The renderer fixes template=sheet, theme=shadcn, mode=auto and style=80.

Supported components (each example belongs inside a fenced block of that name):
  flow:      A -> B: handoff
  sequence:  Client -> Server: request
             Server --> Client: response
  tree:      Project
               CLI | Local rendering
               API | Existing publication
  er:        users
               id uuid PK
             plans
               id uuid PK
               owner uuid FK -> users
  timeline:  Now | Draft | One source
             Next | Publish | Confirm receipt
  callout:   Paragraphs or lists (optional fence args: info/warn/ok followed by a title)
  kv:        Owner: Agent
             Source: repository commit/path/lines
  ask:       Which option changes the plan?
             * Recommended | reason
             - Alternative | reason
             (2–6 options; exactly one * suggestion, or ask multi)

Ask belongs under a ## panel. Suggested selection is not confirmation.
Users copy replies/comments into vikan's supplement input, name the Plan
revision they reviewed, and submit explicitly. Nothing is sent automatically.

Disabled: raw HTML/SVG, images, code src references, annot/limits, remote active
resources, custom themes and video. Cite commit/path/lines for code evidence.
Limits: shared document contract (100,000 characters and complexity limits),
8 panels, 30 seconds, 5 MiB HTML, 64 KiB subprocess diagnostics.
Errors include source line numbers where applicable. Existing output survives
all failures. STE writing warnings are informational, not a publication gate.
Exit: 0 generated; 2 invalid arguments/source; 1 file/subprocess/output failure.
  -h, --help  Show this help
  --licenses Show the fixed renderer and complete bundled dependency notices
`

function parseArgs(argv: readonly string[]) {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1]
    if (!['--source', '--output'].includes(flag ?? '') || !value || value.startsWith('--') || values[flag!]) {
      throw new DeliverableLocalError(EXIT_USAGE, 'Use --source <plan.md> --output <plan.html>; see render-plan --help.')
    }
    values[flag!] = value
  }
  if (!values['--source'] || !values['--output']) throw new DeliverableLocalError(EXIT_USAGE, 'Both --source and --output are required; see render-plan --help.')
  return { source: values['--source'], output: values['--output'] }
}

/** A bounded read of one open descriptor; never read a pipe or follow file growth. */
function snapshot(path: string, limit: number, source: boolean) {
  const badInput = (message: string) => new DeliverableLocalError(source ? EXIT_USAGE : EXIT_FAILURE, message)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > limit) throw badInput(`${source ? 'L1: Source' : 'Renderer output'} must be a regular file of at most ${limit} bytes.`)
    const bytes = Buffer.alloc(info.size + 1)
    let size = 0, count = 0
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count
    if (size > info.size) throw badInput(`${source ? 'L1: Source' : 'Renderer output'} grew while being read; retry with a stable file.`)
    return { bytes: bytes.subarray(0, size), info }
  } finally { closeSync(fd) }
}

function differentOutput(sourcePath: string, outputPath: string, info: { dev: number; ino: number }) {
  if (sourcePath === outputPath) throw new DeliverableLocalError(EXIT_USAGE, 'Input and output must be different files.')
  try {
    const target = statSync(outputPath)
    if (target.dev === info.dev && target.ino === info.ino) throw new DeliverableLocalError(EXIT_USAGE, 'Input and output must be different files (including links).')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function runRenderPlanCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { deps.io.out(renderPlanHelp); return EXIT_OK }
  if (argv.length === 1 && argv[0] === '--licenses') { deps.io.out(rendererLicenses + '\n'); return EXIT_OK }
  let work: string | undefined, pending: string | undefined
  try {
    const args = parseArgs(argv)
    const sourcePath = resolve(deps.cwd(), args.source), outputPath = resolve(deps.cwd(), args.output)
    const sourceFile = snapshot(sourcePath, DELIVERABLE_TEXT_MAX_LENGTH * 4, true)
    differentOutput(sourcePath, outputPath, sourceFile.info)
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceFile.bytes) }
    catch { throw new DeliverableLocalError(EXIT_USAGE, 'L1: Source must contain valid UTF-8 text.') }
    const document = validatePlanSource(source)
    const sourceSha256 = createHash('sha256').update(sourceFile.bytes).digest('hex')
    work = mkdtempSync(join(tmpdir(), 'vikan-render-plan-'))
    const bundle = join(work, 'am.mjs'), input = join(work, 'source.md'), output = join(work, 'plan.html')
    writeFileSync(bundle, bundleSource, { mode: 0o600 })
    writeFileSync(input, sourceFile.bytes, { mode: 0o600 })
    const result = await deps.planRenderer.execute(deps.planRenderer.bunExecutable, [
      '--no-env-file', bundle, 'render', input, '-o', output, '--no-open',
      '--template', 'sheet', '--theme', 'shadcn', '--mode', 'auto', '--style', '80',
    ], { cwd: work, env: { ...deps.planRenderer.env, AM_HOME: join(work, 'am-home'), AM_NO_UPDATE_CHECK: '1', TMPDIR: work },
      timeoutMs: 30_000, maxDiagnosticBytes: 64 * 1024 })
    // Diagnostic spelling is pinned to this vendor commit. It is used only to
    // classify invalid draft errors; success always requires a verified file.
    if (result.code !== 0) throw new DeliverableLocalError(
      result.code === 2 || /^✗ (?:L\d+ |Cannot parse the draft:)/m.test(result.stderr) ? EXIT_USAGE : EXIT_FAILURE,
      `Renderer failed (exit ${result.code}). ${result.stderr.slice(0, 16 * 1024)}`,
    )
    if (result.stderr.trim()) deps.io.err(result.stderr.slice(0, 16 * 1024) + '\n')
    // Upstream writes STE/code warnings to stdout along with its progress log.
    // Keep those as diagnostics; our stdout remains a single machine-readable JSON.
    if (result.stdout.trim()) deps.io.err(result.stdout.slice(0, 48 * 1024) + '\n')
    const rendered = snapshot(output, MCP_FILE_MAX_BYTES, false)
    let html: string
    try { html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rendered.bytes) }
    catch { throw new Error('Renderer output is not UTF-8 HTML.') }
    const embedded = `<textarea id="am-source" hidden readonly aria-hidden="true">${escapeHtml(source)}</textarea>`
    if (!html.startsWith('<!doctype html>') || !html.includes(embedded) || !html.endsWith('</html>\n')) throw new Error('Renderer output is incomplete or its embedded source differs from the source snapshot.')
    // Branding and notices are wrapper-owned; the source snapshot stays exact.
    html = html.replace(/<title>([\s\S]*?)<\/title>/, (_, title: string) => `<title>${title.toLowerCase().includes('vikan') ? title : `vikan · ${title}`}</title>`)
    html = html.replace('</body>', `<details class="vikan-renderer-licenses" style="margin:2rem;max-width:80rem"><summary>vikan visual plan · renderer licenses</summary><pre style="white-space:pre-wrap">${escapeHtml(rendererLicenses)}</pre></details>\n</body>`)
    const bytes = Buffer.from(html)
    if (bytes.length > MCP_FILE_MAX_BYTES) throw new Error('HTML including licenses exceeds the 5 MiB limit.')
    // Rename a same-directory private file only once all validation has passed.
    pending = mkdtempSync(join(dirname(outputPath), '.vikan-render-plan-'))
    const ready = join(pending, 'ready.html')
    writeFileSync(ready, bytes, { mode: 0o600 })
    differentOutput(sourcePath, outputPath, sourceFile.info)
    renameSync(ready, outputPath)
    deps.io.out(JSON.stringify({ outputPath, byteSize: bytes.length, sourceSha256, rendererCommit, document }) + '\n')
    return EXIT_OK
  } catch (error) {
    deps.io.err(`vikan render-plan: ${error instanceof Error ? error.message.slice(0, 16 * 1024) : 'Local render failed.'}\n`)
    return error instanceof DeliverableLocalError ? error.exitCode : EXIT_FAILURE
  } finally {
    if (pending) rmSync(pending, { recursive: true, force: true })
    if (work) rmSync(work, { recursive: true, force: true })
  }
}
