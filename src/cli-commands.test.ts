import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, rmSync, statSync } from 'node:fs'
import { waitFor } from './test-support/runner-world.ts'
import { runDoctorCommand } from './commands/doctor.ts'
import { runLinkCommand } from './commands/link.ts'
import { runStatusCommand } from './commands/status.ts'
import { runUnlinkCommand } from './commands/unlink.ts'
import { runCli } from './cli.ts'
import { EXIT_FAILURE, EXIT_OK } from './exit.ts'
import {
  bindingJournal,
  bindingPath,
  credentialPath,
  journalPath,
  loadCredentialRecord,
  saveBindingRecord,
  saveCredentialRecord,
  scanBindingRecords,
  type BindingRecord,
} from './state/binding.ts'
import { startFakeApi, FAKE_API_IDS, type FakeApi } from './test-support/fake-api.ts'
import { fakeDeps, herdrOk, recordingExec, tempConfigRoot, type FakeDepsOverrides } from './test-support/harness.ts'
import type { CliDeps } from './commands/types.ts'

/**
 * T2: link / status / doctor / unlink / connect command behavior. All API
 * traffic goes to the in-process fake API; all Herdr probes are fake; the
 * config root is a temp directory. Nothing here touches a real Herdr
 * workspace, pane or agent.
 */

let fakeApi: FakeApi | undefined
const tempRoots: string[] = []

afterEach(() => {
  fakeApi?.stop()
  fakeApi = undefined
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const newRoot = (): string => {
  const dir = tempConfigRoot()
  tempRoots.push(dir)
  return dir
}

// The same ids the fake API answers with, so server and local state agree.
const BASE_BINDING: BindingRecord = {
  apiOrigin: 'https://api.example.test',
  userId: FAKE_API_IDS.userId,
  workspaceId: FAKE_API_IDS.workspaceId,
  projectId: FAKE_API_IDS.projectId,
  deviceId: FAKE_API_IDS.deviceId,
  bindingId: FAKE_API_IDS.bindingId,
  path: '',
  directoryLabel: 'cwd',
  claimedAt: '2026-09-01T00:00:00.000Z',
  lastConfirmedAt: null, agentPageUrl: 'https://app.example.test/workspace/fake-workspace/agent',
}

/** Seed a binding + owner-only credential that points at the fake API's fixed ids. */
const seedBinding = (configRoot: string, cwdDir: string): { record: BindingRecord; credential: string } => {
  const record = { ...BASE_BINDING, apiOrigin: fakeApi!.origin, path: cwdDir }
  const credential = 'c'.repeat(43) + 'li'
  saveBindingRecord(configRoot, record)
  saveCredentialRecord(configRoot, {
    apiOrigin: record.apiOrigin,
    userId: record.userId,
    bindingId: record.bindingId,
    deviceId: record.deviceId,
    credential,
  })
  fakeApi!.state.credential = credential
  return { record, credential }
}

describe('vikan link', () => {
  it('refuses to run outside a Herdr session, without any network traffic', async () => {
    const { deps, err } = fakeDeps(newRoot(), { apiOrigin: 'https://api.example.test' })
    const fetchCalls: string[] = []
    const watched: CliDeps = {
      ...deps,
      fetch: async (url) => {
        fetchCalls.push(String(url))
        return new Response('{}')
      },
    }
    expect(await runLinkCommand(watched)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('Herdr')
    expect(fetchCalls).toEqual([])
  })

  it('refuses to run without VIKAN_API_URL even inside Herdr', async () => {
    const { deps, err } = fakeDeps(newRoot(), { detectHerdr: () => herdrOk })
    expect(await runLinkCommand(deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('VIKAN_API_URL')
  })

  it('pairs through the fake API and prompts to run `vikan`', async () => {
    const configRoot = newRoot()
    const clock = { value: 0 }
    fakeApi = startFakeApi(() => clock.value, { autoApproveAfter: 2 })
    const { deps, cwdDir } = fakeDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk, clock })
    const out: string[] = []
    const withCapture: CliDeps = { ...deps, io: { out: (text) => out.push(text), err: () => {} } }
    expect(await runLinkCommand(withCapture)).toBe(EXIT_OK)
    expect(out.join('')).toContain('Run `vikan` to go online.')
    expect(scanBindingRecords(configRoot)).toHaveLength(1)
    expect(scanBindingRecords(configRoot)[0]!.path).toBe(cwdDir)
  })
})

describe('vikan connect (the default command)', () => {
  it('bare vikan resumes a saved binding without re-pairing or needing API env', async () => {
    fakeApi = startFakeApi(() => 0, { s2Configured: false })
    const configRoot = newRoot()
    const { deps, cwdDir, out } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    seedBinding(configRoot, cwdDir)
    const createsBefore = fakeApi.state.createCalls
    let stop!: () => void
    const running = runCli([], { ...deps, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))),
      stopSignal: new Promise<void>(resolve => { stop = resolve }) })
    try { await waitFor(() => out.join('').includes('vikan online')) } finally { stop() }
    expect(await running).toBe(EXIT_OK)
    expect(out.join('')).toContain('Herdr execution connected')
    expect(fakeApi.state.createCalls).toBe(createsBefore)
  })
})

describe('vikan status', () => {
  it('reports an unlinked directory without guessing', async () => {
    const { deps, err } = fakeDeps(newRoot())
    expect(await runStatusCommand(deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('not linked')
  })

  it('shows the binding and the server-confirmed state, updating lastConfirmedAt', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, out } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    const { record } = seedBinding(configRoot, cwdDir)
    expect(await runStatusCommand(deps)).toBe(EXIT_OK)
    const printed = out.join('')
    expect(printed).toContain(record.bindingId)
    expect(printed).toContain(record.projectId)
    expect(printed).toContain(fakeApi.origin)
    expect(printed).toContain('confirmed')
    expect(printed).toContain('offline')
    const updated = scanBindingRecords(configRoot).find((binding) => binding.bindingId === record.bindingId)
    expect(updated?.lastConfirmedAt).not.toBeNull()
  })

  it('says the binding is revoked when the server says so', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    fakeApi.state.bindingStatus = 'revoked'
    const { deps, cwdDir, out } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    seedBinding(configRoot, cwdDir)
    expect(await runStatusCommand(deps)).toBe(EXIT_OK)
    expect(out.join('')).toContain('REVOKED')
  })

  it('distinguishes an unreachable server from a confirmed state', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, out } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    const { record } = seedBinding(configRoot, cwdDir)
    const unreachable: CliDeps = {
      ...deps,
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    }
    expect(await runStatusCommand(unreachable)).toBe(EXIT_OK)
    const printed = out.join('')
    expect(printed).toContain('unreachable')
    expect(printed).toContain('never')
    const unchanged = scanBindingRecords(configRoot).find((binding) => binding.bindingId === record.bindingId)
    expect(unchanged?.lastConfirmedAt).toBeNull()
  })
})

describe('vikan doctor', () => {
  const doctorDeps = (configRoot: string, overrides: FakeDepsOverrides = {}) => {
    const recorded = recordingExec((cwd) => (cwd.startsWith(configRoot) ? configRoot : undefined))
    return { ...fakeDeps(configRoot, { ...overrides, exec: recorded.exec }), recorded }
  }

  it('runs outside Herdr and reports it as a failed check', async () => {
    fakeApi = startFakeApi(() => 0)
    const { deps, out } = doctorDeps(newRoot(), { apiOrigin: fakeApi.origin })
    expect(await runDoctorCommand(deps)).toBe(EXIT_FAILURE)
    const printed = out.join('')
    expect(printed).toContain('[ok]')
    expect(printed).toContain('[fail] Herdr')
    expect(printed).toContain('reachable')
  })

  it('passes every check inside Herdr with a healthy config and API', async () => {
    fakeApi = startFakeApi(() => 0)
    const configRoot = newRoot()
    const { deps, cwdDir, out } = doctorDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk })
    seedBinding(configRoot, cwdDir)
    expect(await runDoctorCommand(deps)).toBe(EXIT_OK)
    const printed = out.join('')
    expect(printed).toContain('pane w9:p1')
    expect(printed).toContain('session default')
    expect(printed).toContain('1 binding')
    expect(printed).not.toMatch(/\[fail\]/)
  })

  it('never splits a pane, starts Codex or reads pane output — and prints no secrets', async () => {
    fakeApi = startFakeApi(() => 0)
    const configRoot = newRoot()
    const { deps, cwdDir, out, recorded } = doctorDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk })
    const { credential } = seedBinding(configRoot, cwdDir)
    await runDoctorCommand(deps)
    for (const call of recorded.calls) {
      expect(`${call.command} ${call.args.join(' ')}`.startsWith('codex --version') || call.command === 'git').toBe(true)
    }
    expect(out.join('')).not.toContain(credential)
  })

  it('fails when a credential file is readable beyond its owner', async () => {
    fakeApi = startFakeApi(() => 0)
    const configRoot = newRoot()
    const { deps, cwdDir, out } = doctorDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk })
    const { record } = seedBinding(configRoot, cwdDir)
    chmodSync(credentialPath(configRoot, record), 0o644)
    expect(await runDoctorCommand(deps)).toBe(EXIT_FAILURE)
    expect(out.join('')).toContain('readable beyond the owner')
  })
})

describe('vikan unlink', () => {
  it('is a no-op success when the directory is not linked', async () => {
    fakeApi = startFakeApi(() => 0)
    const { deps } = fakeDeps(newRoot())
    expect(await runUnlinkCommand(deps)).toBe(EXIT_OK)
    expect(fakeApi.state.revocations).toEqual([])
  })

  it('refuses and keeps identity, credential and journal while a run is unfinished', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, err } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    const { record } = seedBinding(configRoot, cwdDir)
    bindingJournal(configRoot, record).append({ type: 'run', runId: 'run-1', status: 'running', at: 1 })
    expect(await runUnlinkCommand(deps)).toBe(EXIT_FAILURE)
    const complained = err.join('')
    expect(complained).toContain('unfinished vikan run')
    expect(complained).toContain('NOTHING is revoked or deleted')
    expect(fakeApi.state.revocations).toEqual([])
    expect(existsSync(bindingPath(configRoot, record))).toBe(true)
    expect(existsSync(credentialPath(configRoot, record))).toBe(true)
    expect(existsSync(journalPath(configRoot, record))).toBe(true)
  })

  it('revokes with the device bearer and removes local state when idle', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    const { record, credential } = seedBinding(configRoot, cwdDir)
    expect(await runUnlinkCommand(deps)).toBe(EXIT_OK)
    expect(fakeApi.state.revocations).toHaveLength(1)
    expect(fakeApi.state.revocations[0]!.bindingId).toBe(record.bindingId)
    expect(fakeApi.state.revocations[0]!.authorization).toBe(`Bearer ${credential}`)
    expect(scanBindingRecords(configRoot)).toHaveLength(0)
    expect(existsSync(credentialPath(configRoot, record))).toBe(false)
    expect(existsSync(journalPath(configRoot, record))).toBe(false)
  })

  it('a network failure is NOT a revocation: local state kept, retry advised', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, err } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    const { record } = seedBinding(configRoot, cwdDir)
    const flaky: CliDeps = {
      ...deps,
      fetch: async (url) => {
        if (String(url).includes('/revoke')) throw new TypeError('fetch failed')
        return fetch(url)
      },
    }
    expect(await runUnlinkCommand(flaky)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('NOT revoked')
    expect(fakeApi.state.revocations).toEqual([])
    expect(existsSync(bindingPath(configRoot, record))).toBe(true)
    expect(existsSync(credentialPath(configRoot, record))).toBe(true)
  })

  it('an explicit server refusal proves the binding is already dead: local cleanup only', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, out } = fakeDeps(configRoot, { detectHerdr: () => herdrOk })
    const { record } = seedBinding(configRoot, cwdDir)
    fakeApi.state.credential = 'd'.repeat(43) + 'dead'
    expect(await runUnlinkCommand(deps)).toBe(EXIT_OK)
    expect(fakeApi.state.revocations).toEqual([])
    expect(out.join('')).toContain('already gone server-side')
    expect(existsSync(bindingPath(configRoot, record))).toBe(false)
    expect(existsSync(credentialPath(configRoot, record))).toBe(false)
  })
})

describe('entry-level guardrails', () => {
  it('help and version never touch exec, fetch or config', async () => {
    const recorded = recordingExec()
    let fetched = 0
    const { deps } = fakeDeps(newRoot(), { exec: recorded.exec, fetch: async () => (fetched++, new Response('{}')) })
    expect(await runCli(['--help'], deps)).toBe(EXIT_OK)
    expect(await runCli(['--version'], deps)).toBe(EXIT_OK)
    expect(recorded.calls).toEqual([])
    expect(fetched).toBe(0)
  })

  it('unknown commands and options exit 2 with usage', async () => {
    const { deps, err } = fakeDeps(newRoot())
    expect(await runCli(['frobnicate'], deps)).toBe(2)
    expect(await runCli(['--frobnicate'], deps)).toBe(2)
    expect(err.join('')).toContain('Usage: vikan')
  })

  it('the doctor command runs through dispatch outside Herdr', async () => {
    fakeApi = startFakeApi(() => 0)
    const { deps, out } = fakeDeps(newRoot(), { apiOrigin: fakeApi.origin })
    expect(await runCli(['doctor'], deps)).toBe(EXIT_FAILURE)
    expect(out.join('')).toContain('[fail] Herdr')
  })

  it('credentials stay owner-only on disk', () => {
    fakeApi = startFakeApi(() => 0)
    const configRoot = newRoot()
    const record = { ...BASE_BINDING, apiOrigin: fakeApi.origin, path: '/x' }
    saveCredentialRecord(configRoot, {
      apiOrigin: record.apiOrigin,
      userId: record.userId,
      bindingId: record.bindingId,
      deviceId: record.deviceId,
      credential: 'c'.repeat(43) + 'xx',
    })
    expect(statSync(credentialPath(configRoot, record)).mode & 0o777).toBe(0o600)
    expect(loadCredentialRecord(configRoot, record)?.credential).toBe('c'.repeat(43) + 'xx')
  })
})
