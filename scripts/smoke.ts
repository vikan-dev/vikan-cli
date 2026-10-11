import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import manifest from '../package.json'

// 验证仓库外 bundle 与真正安装后的源码 bin，不控制真实终端。
const root = await mkdtemp(join(tmpdir(), 'vikan-cli-smoke-'))
try {
  const entry = join(root, 'index.js')
  await copyFile(new URL('../dist/index.js', import.meta.url), entry)
  const execute = async (command: string[], cwd = root) => {
    const child = Bun.spawn(command, {
      cwd, env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, VIKAN_CONFIG_DIR: join(root, 'config') },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    assert.equal(code, 0, stderr)
    return stdout
  }
  const run = (...args: string[]) => execute([process.execPath, '--no-env-file', entry, ...args])
  assert.equal((await run('--version')).trim(), `vikan ${manifest.version}`)
  assert.match(await run('--help'), /Usage: vikan/)
  const licenses = await run('deliverables', 'render-plan', '--licenses')
  for (const name of ['MIT License', 'vikan SDK', 'S2 Streamstore', 'Zod', 'T3 Env']) assert.ok(licenses.includes(name), `Missing notice: ${name}`)
  const source = '# vikan Plan\n## Scope\nBuild an independent CLI.\n## Validation\nRun the local checks.\n'
  await writeFile(join(root, 'plan.md'), source)
  const result = JSON.parse(await run('deliverables', 'render-plan', '--source', 'plan.md', '--output', 'plan.html'))
  assert.equal(result.document.text, source)
  assert.match(await readFile(join(root, 'plan.html'), 'utf8'), /vikan Plan/)
  const consumer = join(root, 'consumer')
  await mkdir(consumer)
  const tarball = join(root, `vikan-cli-${manifest.version}.tgz`)
  await execute([process.execPath, 'pm', 'pack', '--ignore-scripts', '--destination', root], fileURLToPath(new URL('../', import.meta.url)))
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { '@vikan/cli': tarball } }))
  await execute([process.execPath, 'install', '--ignore-scripts'], consumer)
  const bin = join(consumer, 'node_modules', '.bin', 'vikan')
  assert.equal((await execute([bin, '--version'])).trim(), `vikan ${manifest.version}`)
  const installed = JSON.parse(await execute([bin, 'deliverables', 'render-plan', '--source', 'plan.md', '--output', 'installed.html']))
  assert.equal(installed.document.text, source)
  console.log('Standalone bundle and installed package bin: version, notices and offline rendering passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
