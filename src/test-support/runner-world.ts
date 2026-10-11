import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVikanApiClient } from '../api/client.ts'
import type { BindingRecord } from '../state/binding.ts'
import { saveBindingRecord, saveCredentialRecord } from '../state/binding.ts'
import { acquireDirectoryLock } from '../state/directory-lock.ts'
import { RunnerJournal } from '../state/journal.ts'
import { VikanRunner } from '../runner/session.ts'
import type { AgentAdapter } from '../runner/adapter.ts'
import type { CrashHook } from '../runner/crash.ts'
import { FakeAgentAdapter } from './fake-adapter.ts'
import { FakeS2 } from './fake-s2.ts'
import { FAKE_API_IDS, startFakeApi, type FakeApi } from './fake-api.ts'
import type { CliIo } from '../commands/types.ts'
import { deliverablesCommand } from '../runner/deliverables.ts'
import type { S2Transport } from '../transport/s2.ts'

/**
 * The full fake runner world (todo 09 test support): fake API (with the
 * in-memory agent runtime), fake S2 store, fake agent adapter and a temp
 * config root, wired into a real VikanRunner with test timings. Simulated
 * crashes close the kernel lock fd without clearing recovery ownership or
 * sending receipts, then the next start reopens the same on-disk journal.
 */

const CREDENTIAL = 'r'.repeat(43) + 'w'

export interface RunnerWorldOptions {
  /** Crash-injection checkpoints (thrown as SimulatedCrash). */
  readonly crashHook?: CrashHook
}

export class RunnerWorld {
  readonly configRoot: string
  readonly s2 = new FakeS2()
  readonly adapter = new FakeAgentAdapter()
  readonly binding: BindingRecord
  readonly fakeApi: FakeApi
  readonly out: string[] = []
  readonly err: string[] = []
  private runner: VikanRunner | undefined
  private crashHook: CrashHook | undefined

  constructor(options: RunnerWorldOptions = {}) {
    this.configRoot = realpathSync(mkdtempSync(join(tmpdir(), 'vikan-runner-world-')))
    this.crashHook = options.crashHook
    this.fakeApi = startFakeApi(() => Date.now(), {
      s2: this.s2,
      heartbeatSeconds: 5,
      leaseSeconds: 45,
      s2Configured: true,
    })
    this.fakeApi.state.credential = CREDENTIAL
    this.binding = {
      apiOrigin: this.fakeApi.origin,
      userId: FAKE_API_IDS.userId,
      workspaceId: FAKE_API_IDS.workspaceId,
      projectId: FAKE_API_IDS.projectId,
      deviceId: FAKE_API_IDS.deviceId,
      bindingId: FAKE_API_IDS.bindingId,
      path: '/fake/checkout',
      directoryLabel: 'checkout',
      claimedAt: new Date().toISOString(),
      lastConfirmedAt: null, agentPageUrl: 'https://app.example.test/workspace/fake-workspace/agent',
    }
    saveBindingRecord(this.configRoot, this.binding)
    saveCredentialRecord(this.configRoot, {
      apiOrigin: this.binding.apiOrigin,
      userId: this.binding.userId,
      bindingId: this.binding.bindingId,
      deviceId: this.binding.deviceId,
      credential: CREDENTIAL,
    })
  }

  get runtime() {
    return this.fakeApi.state.runtime
  }

  get journal() {
    return RunnerJournal.open(this.configRoot, this.binding)
  }

  private readonly io: CliIo = {
    out: (text) => this.out.push(text),
    err: (text) => this.err.push(text),
  }

  /** Test timings: loops poll in milliseconds, sleeps cap at 15ms real. */
  private readonly sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15)))

  fetchOverride?: (url: string, init?: RequestInit) => Promise<Response>
  transportOverride?: S2Transport

  api() {
    return createVikanApiClient({ apiOrigin: this.fakeApi.origin, credential: CREDENTIAL, fetch: (url, init) => this.fetchOverride ? this.fetchOverride(url, init) : fetch(url, init) })
  }

  async startRunner(adapter: AgentAdapter = this.adapter, hook: CrashHook | undefined = this.crashHook): Promise<VikanRunner> {
    if (this.runner !== undefined) throw new Error('A runner is already active in this world')
    const lock = acquireDirectoryLock(this.configRoot, this.binding.path)
    if (!lock.ok) throw new Error(`Test world could not acquire the lock: ${lock.reason}`)
    lock.lock.bindRecovery({ configRoot: this.configRoot, apiOrigin: this.binding.apiOrigin, userId: this.binding.userId, bindingId: this.binding.bindingId })
    const runner = new VikanRunner({
      api: this.api(),
      binding: this.binding,
      journal: RunnerJournal.open(this.configRoot, this.binding),
      transport: this.transportOverride ?? this.s2.transport(),
      adapter,
      lock: lock.lock,
      herdr: {
        herdrVersion: '0.9.0',
        paneId: 'w1:p2',
        workspaceId: 'w1',
        tabId: 'w1:t1',
        terminalId: 'term_1',
        paneCwd: this.binding.path,
        sessionName: 'test-session',
        socketPath: '/tmp/fake-herdr.sock',
      },
      cliVersion: 'test',
      deliverablesCommand: deliverablesCommand([process.execPath, '--no-env-file', new URL('../index.ts', import.meta.url).pathname], this.configRoot, this.fakeApi.origin),
      io: this.io,
      stopSignal: new Promise<void>(() => {}),
      now: () => Date.now(),
      sleep: this.sleep,
      crashHook: hook,
      pollMs: 10,
      retryMs: 10,
    })
    this.runner = runner
    void runner.run().catch(error => {
      this.err.push(`Runner failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
    await waitFor(() => this.runtime.sessions.some((session) => session.endedAt === null))
    return runner
  }

  /** Resolve the runner's stop signal: graceful shutdown. */
  async stopRunner(): Promise<void> {
    const runner = this.runner
    if (runner === undefined) return
    await runner.stop()
    this.runner = undefined
  }

  /** After a simulated crash has finished, allow a new process/session. */
  crash(): void {
    this.runner = undefined
    this.crashHook = undefined
  }

  async destroy(): Promise<void> {
    // Stop the runner first so its loops (and their timers) wind down before
    // the API server and the temp root disappear.
    const runner = this.runner
    this.runner = undefined
    if (runner !== undefined) await runner.stop().catch(() => undefined)
    this.fakeApi.stop()
    rmSync(this.configRoot, { recursive: true, force: true })
  }
}

/** Poll until the predicate holds (bounded; 10ms steps). */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
