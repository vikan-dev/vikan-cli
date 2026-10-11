import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './cli.ts'
import { fakeDeps } from './test-support/harness.ts'
import { executeRenderer } from './plan-renderer/process.ts'
import { escapeHtml, validatePlanSource } from './plan-renderer/validate.ts'
import { rendererCommit } from './plan-renderer/resources.ts'

const source = `---
title: vikan Plan
lang: en
---
# vikan Plan
## A Scope
One source generates the document and attachment.
\`\`\`flow
Draft -> Render: snapshot
Render -> Publish: HTML
\`\`\`
## B Comparison
| Option | Outcome |
| --- | --- |
| Local | Offline |
\`\`\`text
<img src="example.png"> is a code example, not an image.
\`\`\`
## C Decision
\`\`\`ask
Which option changes the plan?
* Local | Works offline
- Hosted | Requires a service
\`\`\`
## D Steps
1. Render.
2. Upload and confirm publication.
`
const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vikan-plan-test-')); roots.push(root)
  const test = fakeDeps(join(root, 'unpaired'), {
    cwd: () => root,
    fetch: async () => { throw new Error('network must not run') },
    exec: () => { throw new Error('Herdr/git must not run') },
    detectHerdr: () => { throw new Error('Herdr must not run') },
  })
  roots.push(test.cwdDir)
  const input = join(root, "plan ' $(literal).md"), output = join(root, 'plan.html')
  writeFileSync(input, source)
  const args = ['deliverables', 'render-plan', '--source', input, '--output', output]
  return { ...test, root, input, output, args }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('local render-plan', () => {
  it('renders the single snapshot without identity/network and preserves source, hash, code, diagrams and notices', async () => {
    const f = setup(), workDirs: string[] = []
    const code = await runCli(f.args, { ...f.deps, planRenderer: { ...f.deps.planRenderer, execute: async (bun, args, options) => {
      workDirs.push(options.cwd)
      expect(statSync(options.cwd).mode & 0o777).toBe(0o700)
      expect(options.env).toEqual({ CI: '1', AM_HOME: join(options.cwd, 'am-home'), AM_NO_UPDATE_CHECK: '1', TMPDIR: options.cwd })
      expect(options.timeoutMs).toBe(30_000)
      writeFileSync(f.input, 'changed after the only source read')
      return executeRenderer(bun, args, options)
    } } })
    expect(code).toBe(0)
    const result = JSON.parse(f.out.join('')), html = readFileSync(f.output, 'utf8')
    expect(result).toEqual({ outputPath: f.output, byteSize: Buffer.byteLength(html), sourceSha256: createHash('sha256').update(source).digest('hex'),
      rendererCommit, document: { format: 'text', text: source } })
    expect(html).toContain(`<textarea id="am-source" hidden readonly aria-hidden="true">${escapeHtml(source)}</textarea>`)
    for (const text of ['<svg', '<table', 'data-suggested', '&lt;img src=', 'vikan visual plan', 'Chris Pettitt', 'John Gruber']) expect(html).toContain(text)
    expect(html).not.toMatch(/<(?:script|img)\b[^>]+src=/)
    expect(existsSync(f.deps.configDir)).toBe(false)
    expect(workDirs.every(path => !existsSync(path))).toBe(true)
  })

  it('rejects unsupported active syntax and invalid fences with line diagnostics before rendering', async () => {
    const f = setup()
    const invalid = ['<img src="x">', '![alt](secret.png)', '![alt](a b.png)', '![alt][id]\n\n[id]: secret.png',
      '```HTML\n<p>active</p>\n```', '```svg\n<svg/>\n```', '```ts src="secret.ts"\n```',
      '```src=secret.ts\n```', '```ts ;src=secret.ts\n```', '```flow\nA -> B', '```annot\nx\n```',
      '```ask\nQuestion?\n* ![x](secret.png)\n- Safe\n```', '```kv\nValue: <img src="x">\n```',
      '```tree\n// ![x](secret.png)\n```',
      '## A First\n[go]: https://example.com\n\n[go]\n## B Second\n[go]: javascript:alert(1)\n\n[go]',
      '[click](javascript:alert%281%29)', ...Array.from({ length: 1 }, () => Array(9).fill('## Panel').join('\n'))]
    const deps = { ...f.deps, planRenderer: { ...f.deps.planRenderer, execute: async () => { throw new Error('should not render') } } }
    for (const text of invalid) {
      f.err.length = 0
      writeFileSync(f.input, `# vikan\n## Scope\n${text}\n`)
      expect(await runCli(f.args, deps)).toBe(2)
      expect(f.err.join('')).toMatch(/L\d+:/)
      expect(existsSync(f.output)).toBe(false)
    }
    expect(validatePlanSource('## Scope\n```text\n<img src="secret">\n```\nInline `<script>`')).toMatchObject({ format: 'text' })
    expect(validatePlanSource('## Scope\n```kv\nExample: `<div> | safe`\n```\n```ask\nNeed `<div> | safe`?\n* Yes\n- No\n```')).toMatchObject({ format: 'text' })
    expect(() => validatePlanSource('## Scope\n`![example](image.png)`\n\nActual image:\n![example](image.png)')).toThrow('L5: Images are disabled')
  })

  it('reports STE warnings on stderr while still returning a successful JSON result', async () => {
    const f = setup()
    writeFileSync(f.input, '---\nlang: en\n---\n# vikan Plan\n## Scope\nIt is imperative that the operator ensures the hydraulic reservoir is replenished prior to commencing operation.\n')
    expect(await runCli(f.args, f.deps)).toBe(0)
    expect(JSON.parse(f.out.join('')).document.format).toBe('text')
    expect(f.err.join('')).toContain('warning')
  })

  it('preserves old output and cleans private work on process, artifact and source failures', async () => {
    const f = setup(), work: string[] = []
    writeFileSync(f.output, 'previous valid output')
    for (const mode of ['exit', 'missing', 'mismatch', 'oversize']) {
      const code = await runCli(f.args, { ...f.deps, planRenderer: { ...f.deps.planRenderer, execute: async (_bun, args, options) => {
        work.push(options.cwd)
        const target = args[args.indexOf('-o') + 1]!
        if (mode === 'mismatch') writeFileSync(target, '<!doctype html>wrong source</html>\n')
        if (mode === 'oversize') writeFileSync(target, Buffer.alloc(5 * 1024 * 1024 + 1))
        return { code: mode === 'exit' ? 1 : 0, stdout: '', stderr: '' }
      } } })
      expect(code).toBe(1)
      expect(readFileSync(f.output, 'utf8')).toBe('previous valid output')
    }
    expect(work.every(path => !existsSync(path))).toBe(true)
    expect(readdirSync(f.root).some(name => name.startsWith('.vikan-render-plan-'))).toBe(false)
    writeFileSync(f.input, Buffer.from([0xc3, 0x28]))
    expect(await runCli(f.args, f.deps)).toBe(2)
    rmSync(f.input)
    expect(await runCli(f.args, f.deps)).toBe(1)
    writeFileSync(f.input, source)
    rmSync(f.output); linkSync(f.input, f.output)
    expect(await runCli(f.args, f.deps)).toBe(2)
    expect(readFileSync(f.input, 'utf8')).toBe(source)
  })

  it('bounds subprocess time and diagnostic output using a genuinely isolated environment', async () => {
    const f = setup(), options = { cwd: f.root, env: { ONLY_RENDERER: 'present' }, timeoutMs: 5_000, maxDiagnosticBytes: 1024 }
    const result = await executeRenderer(process.execPath, ['--no-env-file', '-e', 'console.log(JSON.stringify(process.env))'], options)
    expect(JSON.parse(result.stdout)).toEqual({ ONLY_RENDERER: 'present' })
    await expect(executeRenderer(process.execPath, ['--no-env-file', '-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 30 })).rejects.toThrow('time limit')
    await expect(executeRenderer(process.execPath, ['--no-env-file', '-e', 'console.log("x".repeat(10000))'], options)).rejects.toThrow('diagnostic output limit')
  })

  it('runs a single moved CLI bundle from an unrelated cwd with hostile user AM configuration', async () => {
    const f = setup(), built = join(f.root, 'build'), elsewhere = mkdtempSync(join(tmpdir(), 'vikan-plan-moved-')); roots.push(elsewhere)
    const bundle = await Bun.build({ entrypoints: [new URL('./index.ts', import.meta.url).pathname], outdir: built, target: 'bun' })
    expect(bundle.success).toBe(true)
    const entry = join(elsewhere, 'index.js'); copyFileSync(join(built, 'index.js'), entry); rmSync(built, { recursive: true })
    const userHome = join(elsewhere, 'user-am-home')
    const child = Bun.spawn([process.execPath, '--no-env-file', entry, ...f.args], { cwd: elsewhere, stdout: 'pipe', stderr: 'pipe',
      env: { VIKAN_CONFIG_DIR: join(elsewhere, 'unpaired'), AM_HOME: userHome, AM_THEME: 'missing', AM_NO_UPDATE_CHECK: '0' } })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(0)
    expect(stderr).not.toContain('vikan render-plan:')
    expect(JSON.parse(stdout).document).toEqual({ format: 'text', text: source })
    expect(JSON.parse(stdout).sourceSha256).toBe(createHash('sha256').update(source).digest('hex'))
    expect(existsSync(userHome)).toBe(false)
    expect(readdirSync(elsewhere)).toEqual(['index.js'])
  }, 15_000)
})
