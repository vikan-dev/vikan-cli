import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_PROTOCOL_VERSION } from '@vikan/sdk/agent'
import { runConnectCommand } from '../commands/connect.ts'
import { createVikanApiClient } from '../api/client.ts'
import { EXIT_FAILURE, EXIT_OK } from '../exit.ts'
import { acquireDirectoryLock, lockFilePath } from '../state/directory-lock.ts'
import {
  resolveDirectoryIdentity,
  saveBindingRecord,
  saveCredentialRecord,
  type BindingRecord,
} from '../state/binding.ts'
import { fakeDeps, herdrOk, recordingExec, tempConfigRoot } from '../test-support/harness.ts'
import { FAKE_API_IDS, startFakeApi, type FakeApi } from '../test-support/fake-api.ts'
import { RunnerWorld, waitFor } from '../test-support/runner-world.ts'
import { agentNameForRun } from '../runner/adapter.ts'

/**
 * T1: the online runner — connection, directory execution lock and the
 * independent consumption loop. Everything runs against the fake API (with
 * its in-memory agent runtime), the fake S2 store and the fake agent
 * adapter; no real Herdr, no real Codex, no real S2.
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

/* ─── the directory execution lock ────────────────────────────────────────── */

describe('directory execution lock', () => {
  it('refuses another manager regardless of elapsed time and releases only its fd', () => {
    const root = newRoot()
    const first = acquireDirectoryLock(root, '/repo')
    if (!first.ok) throw new Error('lock')
    expect(acquireDirectoryLock(root, '/repo').ok).toBe(false)
    first.lock.release()
    const second = acquireDirectoryLock(root, '/repo')
    if (!second.ok) throw new Error('second lock')
    first.lock.release()
    expect(acquireDirectoryLock(root, '/repo').ok).toBe(false)
    second.lock.release()
  })
  it('normalizes subdirectories and symlinks to the same checkout', () => {
    const root = newRoot()
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    symlinkSync(repo, join(root, 'link'))
    const exec = recordingExec(() => repo).exec
    const sub = resolveDirectoryIdentity(join(repo, 'sub'), exec).key
    const link = resolveDirectoryIdentity(join(root, 'link'), exec).key
    expect(sub).toBe(link)
    const first = acquireDirectoryLock(root, sub)
    if (!first.ok) throw new Error('lock')
    expect(acquireDirectoryLock(root, link).ok).toBe(false)
    first.lock.release()
  })
  it('retains recovery ownership across API, account and config changes', () => {
    const root = newRoot()
    const original = { configRoot: '/config-a', apiOrigin: 'https://api-a.test', userId: 'alice', bindingId: 'a' }
    const first = acquireDirectoryLock(root, '/repo')
    if (!first.ok) throw new Error('lock')
    first.lock.bindRecovery(original)
    first.lock.release()
    for (const changed of [{ ...original, configRoot: '/config-b' }, { ...original, apiOrigin: 'https://api-b.test' }, { ...original, userId: 'bob' }]) {
      const next = acquireDirectoryLock(root, '/repo')
      if (!next.ok) throw new Error('lock')
      expect(() => next.lock.bindRecovery(changed)).toThrow('unresolved recovery')
      next.lock.release()
    }
    const resume = acquireDirectoryLock(root, '/repo')
    if (!resume.ok) throw new Error('lock')
    resume.lock.bindRecovery(original)
    resume.lock.clearRecovery()
    resume.lock.release()
  })
  it('damaged recovery state requires inspection, even with no live manager', () => {
    const root = newRoot()
    writeFileSync(`${lockFilePath(root, '/repo')}.owner.json`, '')
    const locked = acquireDirectoryLock(root, '/repo')
    if (!locked.ok) throw new Error('lock')
    expect(() => locked.lock.bindRecovery({ configRoot: root, apiOrigin: 'a', userId: 'u', bindingId: 'b' })).toThrow('damaged')
    locked.lock.release()
  })
  it('missing owner or lock files cannot erase an established recovery owner', () => {
    const root = newRoot()
    const owner = { configRoot: root, apiOrigin: 'a', userId: 'u', bindingId: 'b' }
    for (const missing of ['owner', 'lock']) {
      const key = `/repo-${missing}`
      const first = acquireDirectoryLock(root, key)
      if (!first.ok) throw new Error('lock')
      first.lock.bindRecovery(owner)
      first.lock.release()
      rmSync(`${first.lock.path}${missing === 'owner' ? '.owner.json' : ''}`)
      const second = acquireDirectoryLock(root, key)
      if (!second.ok) throw new Error('lock')
      expect(() => second.lock.bindRecovery({ ...owner, userId: 'other' })).toThrow('damaged')
      second.lock.release()
    }
  })
  it('SIGKILL frees the kernel lock and two simultaneous recovery contenders cannot both acquire', async () => {
    const root = newRoot()
    const module = new URL('../state/directory-lock.ts', import.meta.url).pathname
    const child = () => Bun.spawn([process.execPath, '-e', `import { acquireDirectoryLock } from ${JSON.stringify(module)}; const result = acquireDirectoryLock(${JSON.stringify(root)}, '/repo'); console.log(result.ok ? 'held' : 'refused'); if (result.ok) setInterval(() => {}, 1000);`], { stdout: 'pipe', stderr: 'pipe' })
    const first = child()
    expect(new TextDecoder().decode((await first.stdout.getReader().read()).value)).toContain('held')
    first.kill('SIGKILL'); await first.exited
    const contenders = [child(), child()]
    try {
      const replies = await Promise.all(contenders.map(async c => new TextDecoder().decode((await c.stdout.getReader().read()).value)))
      expect(replies.filter(r => r.includes('held'))).toHaveLength(1)
      expect(replies.filter(r => r.includes('refused'))).toHaveLength(1)
    } finally { for (const c of contenders) c.kill(); await Promise.all(contenders.map(c => c.exited)) }
  })
})

/* ─── the connect command ─────────────────────────────────────────────────── */

describe('vikan connect — going online', () => {
  const seed = (cwdDir: string, origin: string): { record: BindingRecord; credential: string } => {
    const record: BindingRecord = {
      apiOrigin: origin,
      userId: FAKE_API_IDS.userId,
      workspaceId: FAKE_API_IDS.workspaceId,
      projectId: FAKE_API_IDS.projectId,
      deviceId: FAKE_API_IDS.deviceId,
      bindingId: FAKE_API_IDS.bindingId,
      path: cwdDir,
      directoryLabel: 'cwd',
      claimedAt: '2026-09-01T00:00:00.000Z',
      lastConfirmedAt: null, agentPageUrl: 'https://app.example.test/workspace/fake-workspace/agent',
    }
    const credential = 'c'.repeat(43) + 'on'
    return { record, credential }
  }

  it('pairs when unlinked, then goes online, reports honestly, and stops gracefully', async () => {
    const configRoot = newRoot()
    const clock = { value: 0 }
    fakeApi = startFakeApi(() => clock.value, { autoApproveAfter: 1 })
    let resolveStop!: () => void
    const stopSignal = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    const { deps, out, err } = fakeDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk, clock })
    // A hybrid sleep: the fake clock advances (pairing deadlines stay
    // deterministic) while every wait also yields a little real time, so the
    // runner's loops do not spin at unbounded speed.
    const hybridSleep = async (ms: number): Promise<void> => {
      clock.value += ms
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)))
    }
    const withStop = { ...deps, stopSignal, sleep: hybridSleep }
    const exit = runConnectCommand(withStop).then((code) => ({ code }))
    try {
      await waitFor(() => out.join('').includes('vikan online'), 5_000, 'the online banner')
    } finally {
      resolveStop()
    }
    const { code } = await exit
    expect(code).toBe(EXIT_OK)
    const printed = out.join('')
    expect(printed).toContain(`project   ${FAKE_API_IDS.projectId}`)
    expect(printed).toContain(`device    ${FAKE_API_IDS.deviceId}`)
    expect(printed).toContain('queue')
    expect(printed).toContain('Agent page https://app.example.test')
    // The real transport cannot reach S2 in tests: degraded, never "connected".
    expect(printed).toContain('degraded')
    // Graceful stop: offline marked, lock released.
    const runtime = fakeApi.state.runtime
    await waitFor(() => runtime.counters.offlines >= 1, 5_000, 'the offline mark')
    expect(runtime.sessions.every((session) => session.endedAt !== null)).toBe(true)
    expect(err.join('')).toContain('Stopped; panes and the recovery journal are kept.')
  })

  it('refuses to go online when another vikan already manages this checkout', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, err } = fakeDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk })
    const { record, credential } = seed(cwdDir, fakeApi.origin)
    save(configRoot, record, credential)
    fakeApi.state.credential = credential
    const holder = acquireDirectoryLock(configRoot, record.path)
    if (!holder.ok) throw new Error('test setup: lock not acquired')
    expect(await runConnectCommand(deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('already managed by another vikan process')
    holder.lock.release()
  })

  it('refuses when the local credential is missing', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, err } = fakeDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk })
    const { record } = seed(cwdDir, fakeApi.origin)
    save(configRoot, record, null)
    expect(await runConnectCommand(deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('credential')
  })

  it('stops with the revocation reason when the binding is refused', async () => {
    const configRoot = newRoot()
    fakeApi = startFakeApi(() => 0)
    const { deps, cwdDir, err } = fakeDeps(configRoot, { apiOrigin: fakeApi.origin, detectHerdr: () => herdrOk })
    const { record, credential } = seed(cwdDir, fakeApi.origin)
    save(configRoot, record, credential)
    fakeApi.state.credential = 'd'.repeat(43) + 'dead'
    expect(await runConnectCommand(deps)).toBe(EXIT_FAILURE)
    expect(err.join('')).toContain('refused')
    expect(err.join('')).toContain('pair again')
  })
})

/* ─── the consumption loop (fake S2 + fake adapter) ───────────────────────── */

describe('runner consumption loop', () => {
  let world: RunnerWorld | undefined

  afterEach(async () => {
    await world?.destroy()
    world = undefined
  })

  it('receives a queued run, claims it, dispatches the prompt and reports the receipts', async () => {
    world = new RunnerWorld()
    const { runId, commandId } = world.runtime.queueRun({ prompt: 'Write the tests' })
    await world.startRunner()
    await waitFor(() => world!.adapter.promptCountTotal() === 1, 5_000, 'the prompt dispatch')
    // Server state: claimed and running; the command acked.
    await waitFor(() => {
      const run = world!.runtime.runs.find((candidate) => candidate.runId === runId)
      const command = world!.runtime.commands.find((candidate) => candidate.commandId === commandId)
      return run?.status === 'running' && command?.status === 'acked'
    }, 5_000, 'the server-side run state and command ack')
    // Receipts all delivered; phases and the run→pane/agent mapping persisted.
    await waitFor(() => world!.journal.view().receipts.every((record) => record.state === 'sent'), 5_000, 'the receipts')
    const journal = world.journal
    expect(journal.view().phases.get(commandId)).toBe('prompt_acknowledged')
    const run = journal.view().runs.get(runId)!
    expect(run.status).toBe('running')
    expect(run.paneId).not.toBeNull()
    expect(run.agentName).toBe(agentNameForRun(runId))
    // Cursor advanced past the delivered record.
    const stream = `bindings/${FAKE_API_IDS.bindingId}/commands`
    expect(journal.cursor(stream)).toBe('1')
  })

  it('deduplicates a redelivered S2 record by its stable commandId', async () => {
    world = new RunnerWorld()
    world.runtime.queueRun({ prompt: 'Once' })
    await world.startRunner()
    await waitFor(() => world!.adapter.promptCountTotal() === 1, 5_000, 'the prompt dispatch')
    // A full duplicate delivery (the append-retry shape, evidence/01 D5).
    const body = JSON.stringify(
      JSON.parse(world.s2.bodiesOf(`bindings/${FAKE_API_IDS.bindingId}/commands`)[0]!),
    )
    world.s2.append(`bindings/${FAKE_API_IDS.bindingId}/commands`, body)
    world.s2.append(`bindings/${FAKE_API_IDS.bindingId}/commands`, body)
    await waitFor(() => world!.s2.bodiesOf(`bindings/${FAKE_API_IDS.bindingId}/commands`).length >= 3, 5_000, 'the redelivery')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(world!.adapter.promptCountTotal()).toBe(1)
  })

  it('does not wait for the task: supplements and stops flow while the run is live', async () => {
    world = new RunnerWorld()
    const { runId } = world.runtime.queueRun({ prompt: 'Long task' })
    await world.startRunner()
    await waitFor(() => world!.adapter.promptCountTotal() === 1, 5_000, 'the prompt dispatch')
    await waitFor(() => world!.runtime.runs.find((candidate) => candidate.runId === runId)!.status === 'running', 5_000, 'the running receipt')

    const agentName = agentNameForRun(runId)
    const continueCommand = world.runtime.sendContinue(runId, { prompt: 'Also add docs', expectedRunVersion: 3 })
    await waitFor(() => world!.adapter.promptCount(agentName) === 2, 5_000, 'the supplement dispatch')
    await waitFor(
      () => world!.runtime.commands.find((candidate) => candidate.commandId === continueCommand.commandId)?.status === 'acked',
      5_000,
      'the supplement receipt',
    )

    // The task never completes — the stop must still get through.
    world.runtime.requestCancel(runId)
    await waitFor(() => world!.adapter.interruptCount(agentName) === 1, 5_000, 'the interrupt')
    await waitFor(() => world!.runtime.runs.find((candidate) => candidate.runId === runId)?.status === 'stopping', 5_000, 'the stopping receipt')
    const serverRun = world.runtime.runs.find((candidate) => candidate.runId === runId)!
    expect(serverRun.status).toBe('stopping')
    // The stop stays unconfirmed — nothing pretends the agent ended.
    expect(world.journal.view().runs.get(runId)!.status).not.toBe('cancelled')
  })

  it('shows degraded and holds new work while S2 is unreachable', async () => {
    world = new RunnerWorld()
    await world.startRunner()
    world.runtime.queueRun({ prompt: 'Held work' })
    world.s2.setNetworkDown(true)
    await waitFor(() => world!.runtime.sessions.some((session) => session.endedAt === null && !session.s2Connected), 10_000, 'a degraded heartbeat')
    expect(world!.out.join('')).toContain('degraded')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(world.runtime.counters.runClaims).toBe(0)
    expect(world.adapter.events.length).toBe(0)
    // The run is still queued server-side — nothing was dropped or faked.
    expect(world.runtime.runs.every((run) => run.status === 'queued')).toBe(true)
  })

  it('pauses the consumer on an unknown protocol version and keeps the position', async () => {
    world = new RunnerWorld()
    const stream = `bindings/${FAKE_API_IDS.bindingId}/commands`
    await world.startRunner()
    await waitFor(() => world!.runtime.counters.subscriptions >= 1, 5_000, 'the first subscription')
    // A record from a FUTURE protocol: parseable shape, unsupported version.
    world.s2.append(stream, JSON.stringify({ protocolVersion: AGENT_PROTOCOL_VERSION + 1, type: 'run.command' }))
    await waitFor(() => world!.out.join('').includes('PAUSED'), 5_000, 'the pause message')
    expect(world.out.join('')).toContain('upgrade')
    // Nothing executed, the cursor never advanced past the unknown record
    // (it stays at the position recorded at subscription time).
    expect(world!.adapter.events.length).toBe(0)
    expect(world!.journal.cursor(stream)).toBe('0')
    // The runner stays alive: heartbeats continue.
    const beats = world.runtime.counters.heartbeats
    await waitFor(() => world!.runtime.counters.heartbeats > beats, 10_000, 'another heartbeat')
  })

  it('re-subscribes with fresh authorization after the S2 grant dies', async () => {
    world = new RunnerWorld()
    const { runId } = world.runtime.queueRun({ prompt: 'Reconnect' })
    await world.startRunner()
    await waitFor(() => world!.adapter.promptCountTotal() === 1, 5_000, 'the prompt dispatch')
    const subscriptions = world.runtime.counters.subscriptions
    const second = world.runtime.queueRun({ prompt: 'After reconnect' })
    // The grant dies (expiry/revocation — the definitive 401 path).
    world.s2.revokeAllGrants()
    // The consumer reconnects through a fresh subscription and RECEIVES the
    // queued command even while the first run still holds the slot.
    await waitFor(() => world!.journal.view().commands.has(second.commandId), 5_000, 'reception after the reconnect')
    await waitFor(() => world!.runtime.counters.subscriptions > subscriptions)
    // Free the slot: the parked start then executes — the reconnect is real.
    world.runtime.finishRun(runId)
    await waitFor(() => world!.adapter.promptCountTotal() === 2, 5_000, 'work after the reconnect')
    await waitFor(() => world!.runtime.runs.find((run) => run.runId === second.runId)?.status === 'running', 5_000, 'the reconnected run')
  })

  it('recovers commands from Postgres (the authority snapshot) on a stream gap', async () => {
    world = new RunnerWorld()
    const stream = `bindings/${FAKE_API_IDS.bindingId}/commands`
    const first = world.runtime.queueRun({ prompt: 'Before the gap' })
    await world.startRunner()
    await waitFor(() => world!.adapter.promptCountTotal() === 1, 5_000, 'the first dispatch')
    // The single execution slot: the second run queues while the first runs.
    const second = world.runtime.queueRun({ prompt: 'Trimmed away' })
    await waitFor(() => world!.journal.view().commands.has(second.commandId), 5_000, 'the second command received')
    // Retention trimmed the SECOND record while the cursor still points at
    // it; a newer record follows, so the tail sees seq > cursor: a gap.
    world.s2.trim(stream, '2')
    const third = world.runtime.queueRun({ prompt: 'After the trim' })
    await waitFor(() => world!.journal.view().commands.has(third.commandId), 10_000, 'the gap recovery')
    // The trimmed command came back from the authority snapshot, not the
    // stream — recovery never skips to the latest tail.
    expect(world.journal.view().commands.has(second.commandId)).toBe(true)
    // Parked commands retry independently, so either queued run can acquire
    // the freed slot first. Wait for the actual run, not a global prompt count.
    await waitFor(() => world!.runtime.runs.find(run => run.runId === first.runId)?.status === 'running')
    world.runtime.finishRun(first.runId)
    const remaining = new Set([second.runId, third.runId])
    while (remaining.size) {
      await waitFor(() => world!.runtime.runs.some(run => remaining.has(run.runId) && run.status === 'running'), 5_000, 'a recovered run to start')
      const active = world.runtime.runs.find(run => remaining.has(run.runId) && run.status === 'running')!
      world.runtime.finishRun(active.runId)
      remaining.delete(active.runId)
    }
    for (const { runId } of [first, second, third]) {
      expect(world.adapter.promptCount(agentNameForRun(runId))).toBe(1)
    }
    expect(world.adapter.promptCountTotal()).toBe(3)
    expect(world.journal.view().commands.has(third.commandId)).toBe(true)
  })
})

/* ─── session / claim / recovery contract connectivity ───────────────────── */

describe('agent runtime contract connectivity (fake API, real client)', () => {
  it('online → heartbeat → claim → receipt → offline, with honest refusals after offline', async () => {
    fakeApi = startFakeApi(() => Date.now(), {})
    fakeApi.state.credential = 'k'.repeat(43) + 'ey'
    const api = createClientOf(fakeApi)
    const opened = await api.openRunnerSession({
      bindingId: FAKE_API_IDS.bindingId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      cliVersion: 'test',
      herdr: { version: '0.9.0', protocolVersion: 22, sessionId: 'sess', workspaceId: 'w', tabId: 't', paneId: 'p' },
      agentKinds: ['codex'],
    })
    expect(opened.epoch).toBe(1)
    expect(opened.connectionState).toBe('online')

    const beat = await api.heartbeatRunnerSession(opened.sessionId, { s2Connected: true })
    expect(typeof beat.leaseExpiresAt).toBe('string')

    const { runId } = fakeApi.state.runtime.queueRun({ prompt: 'Contract check' })
    const claimed = await api.claimRun(runId, opened.sessionId)
    expect(claimed.claimEpoch).toBe(opened.epoch)
    expect(claimed.captureEpoch).not.toBeNull()
    const { commands } = await api.listRunCommands(runId)
    expect(commands).toHaveLength(1)
    const ack = await api.submitRunStatus(runId, {
      sessionId: opened.sessionId,
      claimEpoch: claimed.claimEpoch,
      expectedRunVersion: claimed.runVersion,
      status: 'running',
    })
    expect(ack.status).toBe('running')

    await api.offlineRunnerSession(opened.sessionId)
    // Everything session-scoped is refused after offline — never a silent no-op.
    await expect(api.heartbeatRunnerSession(opened.sessionId, { s2Connected: true })).rejects.toThrow()
    await expect(
      api.claimRun(fakeApi.state.runtime.queueRun({}).runId, opened.sessionId),
    ).rejects.toThrow()
    // Reconcile through a NEW session: the run the old session claimed gets
    // needs_reconciliation or a re-stamp — decided server-side.
    const second = await api.openRunnerSession({
      bindingId: FAKE_API_IDS.bindingId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      cliVersion: 'test',
      herdr: { version: '0.9.0', protocolVersion: 22, sessionId: 'sess', workspaceId: 'w', tabId: 't', paneId: 'p' },
      agentKinds: ['codex'],
    })
    expect(second.epoch).toBe(2)
    const reconciled = await api.reconcileRunnerSession(second.sessionId, { activeRuns: [{ runId, paneId: 'p1', agentName: 'a1', phase: 'prompt_acknowledged' }] })
    expect(reconciled.decisions.find((decision) => decision.runId === runId)?.action).toBe('resume')
  })
})

/* ─── local helpers ──────────────────────────────────────────────────────── */

function createClientOf(api: FakeApi) {
  return createVikanApiClient({ apiOrigin: api.origin, credential: 'k'.repeat(43) + 'ey' })
}

function save(configRoot: string, record: BindingRecord, credential: string | null): void {
  saveBindingRecord(configRoot, record)
  if (credential !== null) {
    saveCredentialRecord(configRoot, {
      apiOrigin: record.apiOrigin,
      userId: record.userId,
      bindingId: record.bindingId,
      deviceId: record.deviceId,
      credential,
    })
  }
}
