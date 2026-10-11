import { describe, expect, it } from 'bun:test'
import { processBirthIdentity } from './process-identity.ts'

describe('native process birth identity', () => {
  it('stays stable across independent readers, including CLI restarts', async () => {
    const identity = processBirthIdentity(process.pid)
    expect(processBirthIdentity(process.pid)).toBe(identity)
    const moduleUrl = new URL('./process-identity.ts', import.meta.url).href
    const reader = Bun.spawn([process.execPath, '--no-env-file', '-e',
      `import { processBirthIdentity } from ${JSON.stringify(moduleUrl)}; console.log(processBirthIdentity(${process.pid}))`],
    { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(reader.stdout).text()
    expect(await reader.exited).toBe(0)
    expect(output.trim()).toBe(identity)
  })

  it('distinguishes live processes and refuses exited or invalid PIDs', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', 'await Bun.sleep(30000)'],
      { stdout: 'ignore', stderr: 'ignore' })
    try {
      const identity = processBirthIdentity(child.pid)
      expect(processBirthIdentity(child.pid)).toBe(identity)
      expect(identity).not.toBe(processBirthIdentity(process.pid))
    } finally {
      child.kill()
      await child.exited
    }
    expect(() => processBirthIdentity(child.pid)).toThrow()
    for (const pid of [0, -1, 1.5, 0x80000000]) expect(() => processBirthIdentity(pid)).toThrow()
  })
})
