import { afterEach, describe, expect, it, mock } from 'bun:test'
import packageJson from '../package.json'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from './index.ts'
import { fakeDeps, herdrOk, recordingExec } from './test-support/harness.ts'
import { startFakeApi, type FakeApi } from './test-support/fake-api.ts'

/**
 * Entry-level behavior: parsing, dispatch, exit codes, and the guarantee
 * that --help / --version / doctor work outside Herdr with no
 * configuration, while connect/link require a real Herdr context.
 */

let fakeApi: FakeApi | undefined
const envKeys = ['VIKAN_API_URL', 'VIKAN_CONFIG_DIR', 'HERDR_ENV', 'HERDR_SOCKET_PATH'] as const
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]))

afterEach(() => {
  fakeApi?.stop()
  fakeApi = undefined
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('vikan CLI entry', () => {
  it('prints usage and exits 0 outside Herdr and without configuration', async () => {
    const recorded = recordingExec()
    const fetch = mock()
    const { deps, out, err } = fakeDeps(fakeRoot(), { exec: recorded.exec, fetch })

    expect(await runCli(['--help'], deps)).toBe(EXIT_OK)
    expect(out.join('')).toContain('Usage: vikan <command> [options]')
    expect(out.join('')).toContain('unlink')
    expect(err).toEqual([])
    expect(recorded.calls).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('prints the package version and exits 0', async () => {
    const { deps, out } = fakeDeps(fakeRoot())
    expect(await runCli(['--version'], deps)).toBe(EXIT_OK)
    expect(out.join('')).toBe(`vikan ${packageJson.version}\n`)
  })

  it.each([['--frobnicate'], ['frobnicate']])(
    'rejects unusable arguments %s with usage on stderr and exit 2',
    async (argument) => {
      const { deps, out, err } = fakeDeps(fakeRoot())
      expect(await runCli([argument], deps)).toBe(EXIT_USAGE)
      expect(out).toEqual([])
      expect(err.join('')).toContain('Usage: vikan')
    },
  )

  it('connect (the default command) requires a Herdr context and never reports success', async () => {
    const { deps, err } = fakeDeps(fakeRoot(), { apiOrigin: 'https://api.example.test' })
    expect(await runCli(['connect'], deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('Herdr')
    expect(await runCli([], deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('Herdr')
  })

  it('connect inside Herdr without an API origin asks for VIKAN_API_URL', async () => {
    const { deps, err } = fakeDeps(fakeRoot(), { detectHerdr: () => herdrOk })
    expect(await runCli([], deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('VIKAN_API_URL')
  })

  it('link requires a Herdr context; status and doctor run anywhere', async () => {
    fakeApi = startFakeApi(() => 0)
    const { deps, out, err } = fakeDeps(fakeRoot(), { apiOrigin: fakeApi.origin })
    expect(await runCli(['link'], deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('Herdr')

    expect(await runCli(['status'], deps)).toBe(EXIT_FAILURE) // not linked — still answers, anywhere
    expect(err.join('')).toContain('not linked')

    expect(await runCli(['doctor'], deps)).toBe(EXIT_FAILURE) // ran fine outside Herdr; the Herdr check failed
    expect(out.join('')).toContain('[fail] Herdr')
  })
})

// env.ts freezes its values at module load; each `?n` import is a fresh parse
// of the current environment.
let fresh = 0
const loadEnv = async () => (await import(`./env.ts?${++fresh}`)).env as typeof import('./env.ts').env

describe('vikan CLI configuration', () => {
  it('reads vikan names through T3 Env and leaves HERDR_* alone', async () => {
    process.env['VIKAN_API_URL'] = 'https://api.vikan.test'
    process.env['VIKAN_CONFIG_DIR'] = '/tmp/vikan-test-config'
    process.env['HERDR_ENV'] = '1'
    process.env['HERDR_SOCKET_PATH'] = '/tmp/herdr.sock'
    const env = await loadEnv()
    expect(env.VIKAN_API_URL).toBe('https://api.vikan.test')
    expect(env.VIKAN_CONFIG_DIR).toBe('/tmp/vikan-test-config')
    expect(env.HERDR_ENV).toBe('1')
    expect(env.HERDR_SOCKET_PATH).toBe('/tmp/herdr.sock')
  })

  it('rejects an invalid VIKAN_API_URL', async () => {
    process.env['VIKAN_API_URL'] = 'not-a-url'
    await expect(loadEnv()).rejects.toThrow()
  })
})

let counter = 0
const fakeRoot = (): string => `/tmp/vikan-cli-entry-${process.pid}-${++counter}`
