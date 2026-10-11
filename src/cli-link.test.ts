import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVikanApiClient } from './api/client.ts'
import { runPairing, type PairingOutcome, type PairingParams } from './auth/pairing.ts'
import { generateSecret, sha256Hex } from './auth/secrets.ts'
import {
  activeRunIds,
  bindingJournal,
  bindingPath,
  credentialPath,
  findBindingRecordsForPath,
  journalPath,
  loadCredentialRecord,
  pendingPath,
  resolveDirectoryIdentity,
  saveBindingRecord,
  saveCredentialRecord,
  scanBindingRecords,
  type BindingRecord,
} from './state/binding.ts'
import { openJournal, writeJsonFile, FILE_MODE_SECRET } from './state/files.ts'
import { FAKE_API_IDS, startFakeApi, type FakeApi, type FakeApiOptions } from './test-support/fake-api.ts'
import { fakeClockSleep, recordingExec, T0 } from './test-support/harness.ts'
import type { FetchLike } from './commands/types.ts'

/**
 * T1: persistent credentials, normalized directory binding and the pairing
 * protocol — against a fake API server speaking the real contract wire
 * format. No real agent, no real Herdr, no real home directory.
 */

const UUIDS = {
  userId: '00000000-0000-7000-8000-000000000021',
  otherUserId: '00000000-0000-7000-8000-000000000022',
  workspaceId: '00000000-0000-7000-8000-000000000023',
  projectId: '00000000-0000-7000-8000-000000000024',
  deviceId: '00000000-0000-7000-8000-000000000025',
} as const

let fakeApi: FakeApi | undefined
const tempDirs: string[] = []

afterEach(() => {
  fakeApi?.stop()
  fakeApi = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vikan-cli-link-')))
  tempDirs.push(dir)
  return dir
}

const asLinked = (outcome: PairingOutcome): BindingRecord => {
  if (outcome.kind !== 'linked') throw new Error(`expected a linked outcome, got ${outcome.kind}`)
  return outcome.binding
}

describe('atomic secret-bearing file writes', () => {
  it('writes JSON atomically with owner-only permissions and no leftover temp files', () => {
    const dir = tmp()
    const file = join(dir, 'nested', 'credential.json')
    writeJsonFile(file, { credential: 'x'.repeat(43) }, { mode: FILE_MODE_SECRET })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ credential: 'x'.repeat(43) })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['credential.json'])

    writeJsonFile(file, { credential: 'y'.repeat(43) }, { mode: FILE_MODE_SECRET })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ credential: 'y'.repeat(43) })
    expect(readdirSync(join(dir, 'nested'))).toEqual(['credential.json'])
  })

  it('writes plain JSON for non-secret files', () => {
    const dir = tmp()
    const file = join(dir, 'binding.json')
    writeJsonFile(file, { path: '/x' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ path: '/x' })
    expect(statSync(file).mode & 0o777).not.toBe(0o600)
  })
})

describe('normalized directory identity', () => {
  it('binds a git checkout at its real repo root from a subdirectory', () => {
    const root = tmp()
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const exec = recordingExec((cwd) => (cwd === root || cwd.startsWith(`${root}/`) ? root : undefined))
    const identity = resolveDirectoryIdentity(sub, exec.exec)
    expect(identity.key).toBe(root)
    expect(identity.label).toBe(root.split('/').pop()!)
    expect(identity.isRepo).toBe(true)
  })

  it('resolves a symlinked checkout to the same repo-root key', () => {
    const root = tmp()
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const outside = tmp()
    const link = join(outside, 'repo-link')
    symlinkSync(root, link)
    const exec = recordingExec((cwd) => (cwd === root || cwd.startsWith(`${root}/`) ? root : undefined))
    expect(resolveDirectoryIdentity(link, exec.exec).key).toBe(root)
    expect(resolveDirectoryIdentity(sub, exec.exec).key).toBe(root)
  })

  it('uses the realpath of a plain directory when git is absent', () => {
    const dir = tmp()
    const identity = resolveDirectoryIdentity(dir, recordingExec().exec)
    expect(identity.key).toBe(dir)
    expect(identity.isRepo).toBe(false)
  })
})

describe('binding store: origin and account isolation', () => {
  const binding = (origin: string, user: string, suffix: string): BindingRecord => ({
    apiOrigin: origin,
    userId: user,
    workspaceId: UUIDS.workspaceId,
    projectId: UUIDS.projectId,
    deviceId: UUIDS.deviceId,
    bindingId: `00000000-0000-7000-8000-0000000000${suffix}`,
    path: '/same/checkout',
    directoryLabel: 'checkout',
    claimedAt: new Date(T0).toISOString(),
    lastConfirmedAt: null, agentPageUrl: 'https://app.example.test/workspace/fake-workspace/agent',
  })

  it('keeps bindings for different origins and accounts in separate state trees', () => {
    const configRoot = tmp()
    saveBindingRecord(configRoot, binding('https://api.one.test', UUIDS.userId, 'a1'))
    saveBindingRecord(configRoot, binding('https://api.two.test', UUIDS.userId, 'b1'))
    saveBindingRecord(configRoot, binding('https://api.one.test', UUIDS.otherUserId, 'c1'))
    const found = findBindingRecordsForPath(configRoot, '/same/checkout')
    expect(found).toHaveLength(3)
    const storePaths = found.map((record) => bindingPath(configRoot, record))
    expect(new Set(storePaths).size).toBe(3)
  })

  it('stores the credential separately, owner-only, never inside the binding file', () => {
    const configRoot = tmp()
    const credential = generateSecret()
    const record = binding('https://api.one.test', UUIDS.userId, 'a2')
    saveBindingRecord(configRoot, record)
    saveCredentialRecord(configRoot, {
      apiOrigin: record.apiOrigin,
      userId: record.userId,
      bindingId: record.bindingId,
      deviceId: record.deviceId,
      credential,
    })
    expect(statSync(credentialPath(configRoot, record)).mode & 0o777).toBe(0o600)
    expect(readFileSync(bindingPath(configRoot, record), 'utf8')).not.toContain(credential)
    expect(loadCredentialRecord(configRoot, record)?.credential).toBe(credential)
  })
})

describe('pairing against the fake API', () => {
  const startHarness = (options: { server?: FakeApiOptions; wrapFetch?: (base: FetchLike) => FetchLike } = {}): {
    configRoot: string
    repoDir: string
    out: string[]
    clock: { value: number }
    params: () => PairingParams
  } => {
    const configRoot = tmp()
    const repoDir = tmp()
    const clock = { value: T0 }
    const out: string[] = []
    fakeApi = startFakeApi(() => clock.value, options.server)
    const baseFetch: FetchLike = (url, init) => fetch(url, init)
    const apiFetch = options.wrapFetch === undefined ? baseFetch : options.wrapFetch(baseFetch)
    return {
      configRoot,
      repoDir,
      out,
      clock,
      params: () => ({
        api: createVikanApiClient({ apiOrigin: fakeApi!.origin, fetch: (url, init) => apiFetch(url, init) }),
        configRoot,
        apiOrigin: fakeApi!.origin,
        directoryKey: repoDir,
        directoryLabel: 'repo',
        deviceName: 'tester@host',
        cliVersion: '0.0.0-test',
        io: { out: (text: string) => out.push(text), openBrowser: () => false },
        now: () => clock.value,
        sleep: fakeClockSleep(clock),
      }),
    }
  }

  it('links after browser approval and persists the full binding identity', async () => {
    const harness = startHarness({ server: { autoApproveAfter: 2 } })
    const binding = asLinked(await runPairing(harness.params()))
    expect(binding).toMatchObject({
      apiOrigin: fakeApi!.origin,
      userId: FAKE_API_IDS.userId,
      workspaceId: FAKE_API_IDS.workspaceId,
      projectId: FAKE_API_IDS.projectId,
      deviceId: FAKE_API_IDS.deviceId,
      bindingId: FAKE_API_IDS.bindingId,
      path: harness.repoDir,
    })
    expect(existsSync(pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir))).toBe(false)
    const stored = scanBindingRecords(harness.configRoot)
    expect(stored).toHaveLength(1)
    expect(statSync(credentialPath(harness.configRoot, stored[0]!)).mode & 0o777).toBe(0o600)
    expect(loadCredentialRecord(harness.configRoot, stored[0]!)?.credential).toHaveLength(43)
  })

  it('persists the secrets locally before the create request leaves the machine', async () => {
    let pendingExistedAtCreate: boolean | undefined
    const harness = startHarness({
      wrapFetch: (base) => async (url, init) => {
        if (String(url).endsWith('/api/agent/link-requests') && init?.method === 'POST') {
          pendingExistedAtCreate = existsSync(pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir))
        }
        return base(url, init)
      },
    })
    await runPairing(harness.params())
    expect(pendingExistedAtCreate).toBe(true)
  })

  it('sends only hashes, prints URL and user code, never the secrets', async () => {
    const harness = startHarness({ server: { autoApproveAfter: 1 } })
    const binding = asLinked(await runPairing(harness.params()))
    const credential = loadCredentialRecord(harness.configRoot, binding)!.credential
    const created = fakeApi!.state.requests[0]!
    const printed = harness.out.join('')
    expect(printed).toContain(created.requestId)
    expect(printed).toContain('WX3K9PBQ')
    expect(printed).toContain('open the URL on this or any other device')
    expect(printed).not.toContain(credential)
    expect(created.pairingSecretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(created.deviceCredentialHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex(credential)).toBe(created.deviceCredentialHash)
  })

  it('writes nothing into the repository directory', async () => {
    const harness = startHarness({ server: { autoApproveAfter: 1 } })
    const before = readdirSync(harness.repoDir)
    await runPairing(harness.params())
    expect(readdirSync(harness.repoDir)).toEqual(before)
  })

  it('recovers when the claim response is lost: same request identity, replayed result', async () => {
    let dropped = 0
    const harness = startHarness({
      server: { autoApproveAfter: 1 },
      wrapFetch: (base) => async (url, init) => {
        const response = await base(url, init)
        if (String(url).includes('/claim') && response.ok && dropped === 0) {
          dropped += 1
          await response.body?.cancel().catch(() => {})
          throw new TypeError('simulated connection loss after the server answered')
        }
        return response
      },
    })
    const binding = asLinked(await runPairing(harness.params()))
    expect(dropped).toBe(1)
    expect(fakeApi!.state.claims).toBeGreaterThanOrEqual(2)
    expect(scanBindingRecords(harness.configRoot)).toHaveLength(1)
    expect(loadCredentialRecord(harness.configRoot, binding)?.credential).toHaveLength(43)
  })

  it('reuses a pending request identity across runs instead of minting new secrets', async () => {
    const harness = startHarness()
    const pairingSecret = generateSecret()
    const deviceCredential = generateSecret()
    const requestId = randomUUID()
    seedPending(harness, { pairingSecret, deviceCredential, requestId })
    fakeApi!.state.requests.push({
      requestId,
      pairingSecretHash: sha256Hex(pairingSecret),
      deviceCredentialHash: sha256Hex(deviceCredential),
      status: 'approved',
      input: { directoryKey: harness.repoDir, directoryLabel: 'repo', deviceName: 'tester@host', cliVersion: '0.0.0-test', protocolVersion: 1 },
    })
    const binding = asLinked(await runPairing(harness.params()))
    expect(fakeApi!.state.requests).toHaveLength(1)
    expect(fakeApi!.state.createCalls).toBe(1)
    expect(loadCredentialRecord(harness.configRoot, binding)?.credential).toBe(deviceCredential)
    expect(harness.out.join('')).not.toContain(pairingSecret)
  })

  it('regenerates once when a carried-over request was already dead server-side', async () => {
    const harness = startHarness({ server: { autoApproveAfter: 3 } })
    const staleSecret = generateSecret()
    const requestId = randomUUID()
    seedPending(harness, { pairingSecret: staleSecret, deviceCredential: generateSecret(), requestId })
    fakeApi!.state.requests.push({
      requestId,
      pairingSecretHash: sha256Hex(staleSecret),
      deviceCredentialHash: sha256Hex(generateSecret()),
      status: 'rejected',
      input: { directoryKey: harness.repoDir, directoryLabel: 'repo', deviceName: 'tester@host', cliVersion: '0.0.0-test', protocolVersion: 1 },
    })
    expect(asLinked(await runPairing(harness.params()))).toBeTruthy()
    expect(fakeApi!.state.requests).toHaveLength(2)
  })

  it('reports a rejected pairing as an explicit terminal outcome', async () => {
    const harness = startHarness({ server: { rejectAfterCreate: true } })
    const outcome = await runPairing(harness.params())
    expect(outcome.kind).toBe('rejected')
    expect(existsSync(pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir))).toBe(false)
  })

  it('reports expiry when the window passes without approval, and clears the pending state', async () => {
    const harness = startHarness({
      wrapFetch: (base) => async (url, init) => {
        const response = await base(url, init)
        if (String(url).endsWith('/api/agent/link-requests') && init?.method === 'POST' && response.ok) {
          const body = JSON.parse(await response.text()) as { expiresAt: string; pollIntervalSeconds: number }
          body.expiresAt = new Date(harness.clock.value + 12_000).toISOString()
          body.pollIntervalSeconds = 5
          return new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } })
        }
        return response
      },
    })
    const outcome = await runPairing(harness.params())
    expect(outcome.kind).toBe('expired')
    expect(existsSync(pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir))).toBe(false)
  })

  it('treats a directory conflict as terminal, not retryable', async () => {
    const harness = startHarness()
    fakeApi!.setClaimOverride(() => jsonProblem(410, 'link_gone', 'This directory is already linked to an active vikan binding; revoke it first.'))
    expect((await runPairing(harness.params())).kind).toBe('conflict')
  })

  it('keeps the pairing identity on disk when create is rate-limited', async () => {
    const harness = startHarness()
    fakeApi!.setCreateOverride(() => jsonProblem(429, 'rate_limited', 'Too many create requests; retry after the current window.'))
    expect((await runPairing(harness.params())).kind).toBe('rate-limited')
    expect(existsSync(pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir))).toBe(true)
  })

  it('keeps the persisted identity when the API is unreachable', async () => {
    const harness = startHarness({
      wrapFetch: () => async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect((await runPairing(harness.params())).kind).toBe('network')
    expect(existsSync(pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir))).toBe(true)
  })
})

describe('run journal: the activity check unlink relies on', () => {
  it('reports runs whose latest record is non-terminal, ignoring finished ones and fragments', () => {
    const dir = tmp()
    const journal = openJournal(join(dir, 'journal.jsonl'))
    journal.append({ type: 'run', runId: 'r1', status: 'running', at: 1 })
    expect(activeRunIds(journal)).toEqual(['r1'])
    journal.append({ type: 'run', runId: 'r1', status: 'succeeded', at: 2 })
    journal.append({ type: 'run', runId: 'r2', status: 'queued', at: 3 })
    expect(activeRunIds(journal)).toEqual(['r2'])
    writeFileSync(join(dir, 'journal.jsonl'), '{"type":"run","runId":"r3","status":"runni', { flag: 'a' })
    expect(activeRunIds(journal)).toEqual(['r2'])
  })

  it('is empty for a binding with no journal; journal paths nest per origin and user', () => {
    const configRoot = tmp()
    const record: BindingRecord = {
      apiOrigin: 'https://api.one.test',
      userId: UUIDS.userId,
      workspaceId: UUIDS.workspaceId,
      projectId: UUIDS.projectId,
      deviceId: '00000000-0000-7000-8000-000000000026',
      bindingId: '00000000-0000-7000-8000-000000000027',
      path: '/x',
      directoryLabel: 'x',
      claimedAt: new Date(T0).toISOString(),
      lastConfirmedAt: null, agentPageUrl: 'https://app.example.test/workspace/fake-workspace/agent',
    }
    expect(activeRunIds(bindingJournal(configRoot, record))).toEqual([])
    expect(journalPath(configRoot, record)).toContain(
      join('origins', createHash('sha256').update('https://api.one.test').digest('hex').slice(0, 24), 'users', UUIDS.userId, 'journal'),
    )
  })
})

function seedPending(
  harness: { configRoot: string; repoDir: string },
  secrets: { pairingSecret: string; deviceCredential: string; requestId: string },
): void {
  writeJsonFile(
    pendingPath(harness.configRoot, fakeApi!.origin, harness.repoDir),
    {
      apiOrigin: fakeApi!.origin,
      directoryKey: harness.repoDir,
      directoryLabel: 'repo',
      deviceName: 'tester@host',
      cliVersion: '0.0.0-test',
      pairingSecret: secrets.pairingSecret,
      deviceCredential: secrets.deviceCredential,
      createdAt: new Date(T0).toISOString(),
      requestId: secrets.requestId,
      userCode: 'OLDCODE1',
      verificationUrl: `https://app.example.test/agent/link/${secrets.requestId}`,
      expiresAt: new Date(T0 + 600_000).toISOString(),
      pollIntervalSeconds: 5,
    },
    { mode: FILE_MODE_SECRET },
  )
}

function jsonProblem(status: number, code: string, title: string): Response {
  return new Response(JSON.stringify({ type: `https://errors.zebra.dev/${code}`, status, title, instance: '/' }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
