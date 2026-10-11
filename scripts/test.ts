import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 每个文件独立执行，避免 Bun 的模块 mock 与 env 缓存跨测试文件污染。
const root = fileURLToPath(new URL('../', import.meta.url))
const filters = process.argv.slice(2).map(filter => filter.replace(/^\.\//, '').replace(/^src\//, ''))
const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true })
  .map(path => path.toString())
  .filter(path => path.endsWith('.test.ts') && (!filters.length || filters.some(filter => path.includes(filter))))
  .sort()
if (!files.length) throw new Error('No matching test files.')
let failed = false
for (const file of files) {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'test', `./src/${file}`], {
    cwd: root, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, NODE_ENV: 'test' },
  })
  if (await child.exited !== 0) failed = true
}
if (failed) process.exit(1)
