import type { CliIo } from '../commands/types.ts'
import { AGENT_PROTOCOL_VERSION } from '@vikan/sdk/agent'
import { apiFailure, type VikanApiClient } from '../api/client.ts'
import type { BindingRecord } from '../state/binding.ts'
import type { RunnerJournal } from '../state/journal.ts'
import type { DirectoryLock } from '../state/directory-lock.ts'
import type { HerdrContextInfo } from '../herdr/context.ts'
import { S2TransportError, type S2Transport } from '../transport/s2.ts'
import type { AgentAdapter } from './adapter.ts'
import { isSimulatedCrash } from './crash.ts'
import { interruptOwnedRuns, journalActiveRuns, reconcileJournal } from './reconcile.ts'
import { CommandConsumer } from './queue.ts'
import { Dispatcher } from './dispatch.ts'
import { MAX_PENDING_RECEIPTS, ReceiptQueue } from './receipts.ts'
import { ScreenPublisher } from '../screen/publisher.ts'

export type RunnerConnection = 'online' | 'degraded' | 'offline'
export interface VikanRunnerOptions {
  readonly api: VikanApiClient
  readonly binding: BindingRecord
  readonly journal: RunnerJournal
  readonly transport: S2Transport
  readonly adapter: AgentAdapter
  readonly lock: DirectoryLock
  readonly herdr: HerdrContextInfo
  readonly cliVersion: string
  readonly deliverablesCommand?: string
  readonly io: CliIo
  readonly stopSignal: Promise<void>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly crashHook?: (checkpoint: string) => void
  readonly pollMs?: number
  readonly retryMs?: number
}
export interface RunnerOutcome { readonly code: number; readonly reason: string }

/** Connectivity never decides whether Codex stopped. Shutdown fences all
 * workers, waits for bounded in-flight operations, then drains/offlines. */
export class VikanRunner {
  private sessionId = ''
  private epoch = 0
  private leaseExpiresAt = 0
  private heartbeatMs = 15_000
  private apiUp = false
  private s2Up = false
  private lastQueue = ''
  private connection: RunnerConnection | undefined
  private stopped = false
  private crashed = false
  private revoked = false
  private outcome: RunnerOutcome = { code: 0, reason: 'Stopped; panes and the recovery journal are kept.' }
  private consumer?: CommandConsumer
  private dispatcher?: Dispatcher
  private receipts?: ReceiptQueue
  private screens?: ScreenPublisher
  private readonly loops: Promise<unknown>[] = []
  private wake!: () => void
  private readonly stopRequested = new Promise<void>(resolve => { this.wake = resolve })
  private resolveFinished!: (outcome: RunnerOutcome) => void
  readonly whenStopped = new Promise<RunnerOutcome>(resolve => { this.resolveFinished = resolve })
  constructor(private readonly options: VikanRunnerOptions) {}
  private log(text: string): void { this.options.io.out(`${text}\n`) }
  private herdrSessionId(): string { return this.options.herdr.socketPath ?? this.options.herdr.sessionName ?? this.options.herdr.paneId }
  private connectionChanged(): void {
    const next = !this.apiUp ? 'offline' : this.s2Up ? 'online' : 'degraded'
    if (next === this.connection) return
    this.connection = next
    this.log(next === 'online' ? 'connected — receiving tasks (Ctrl-C to stop)' : next === 'degraded'
      ? 'degraded — API reachable, S2 unavailable; new work is held'
      : 'offline — API unreachable; execution outcome is unknown, nothing is revoked')
  }
  private onApiError = (error: unknown): void => {
    if (error instanceof S2TransportError) return
    const failure = apiFailure(error)
    if (failure.kind === 'problem' && failure.code === 'unauthenticated') {
      this.revoked = true
      this.requestStop({ code: 1, reason: 'The binding was refused or revoked; pair again with vikan link. Stop confirmation and recovery evidence are retained.' })
    } else if (failure.kind === 'problem' && failure.code === 'forbidden') {
      this.requestStop({ code: 1, reason: 'This session no longer has authority; no new actions are permitted.' })
    } else if (failure.kind === 'invalid-output' || (failure.kind === 'problem' && failure.code === 'protocol_version_unsupported')) {
      this.requestStop({ code: 1, reason: 'API protocol not understood; upgrade vikan. Recovery evidence is retained.' })
    } else if (failure.kind !== 'problem' || failure.status >= 500) {
      this.apiUp = false
      this.connectionChanged()
    }
  }
  private requestStop(outcome: RunnerOutcome): void {
    if (this.stopped) return
    this.stopped = true
    this.outcome = outcome
    this.consumer?.stop(); this.dispatcher?.stop(); this.receipts?.stop(); this.screens?.stop()
    this.wake()
  }
  stop(): Promise<RunnerOutcome> { this.requestStop(this.outcome); return this.whenStopped }
  private sleep = (ms: number): Promise<void> => Promise.race([this.options.sleep(ms), this.stopRequested])
  private track(promise: Promise<unknown>): void {
    this.loops.push(promise.catch(error => {
      if (isSimulatedCrash(error)) this.crashed = true
      this.requestStop({ code: 1, reason: error instanceof Error ? error.message : String(error) })
    }))
  }
  async run(): Promise<RunnerOutcome> {
    void this.options.stopSignal.then(() => this.requestStop(this.outcome))
    try {
      await this.online()
      if (!this.stopped) {
        this.track(this.heartbeat()) // renew leases while recovery is offline
        await reconcileJournal({
          api: this.options.api, journal: this.options.journal, adapter: this.options.adapter,
          sessionId: this.sessionId, sessionEpoch: this.epoch, herdrSessionId: this.herdrSessionId(),
          log: text => this.log(text), sleep: this.sleep, stopped: () => this.stopped,
          onApiError: this.onApiError, retryMs: this.options.retryMs,
        })
      }
      if (!this.stopped) {
        const shared = { api: this.options.api, journal: this.options.journal,
          log: (text: string) => this.log(text), sleep: this.sleep, now: this.options.now,
          onApiError: this.onApiError, crashHook: this.options.crashHook, pollMs: this.options.pollMs, retryMs: this.options.retryMs }
        this.receipts = new ReceiptQueue({ ...shared, sessionId: () => this.sessionId, sessionEpoch: () => this.epoch })
        this.dispatcher = new Dispatcher({ ...shared, adapter: this.options.adapter, receipts: this.receipts,
          deliverablesCommand: this.options.deliverablesCommand,
          sessionId: this.sessionId, sessionEpoch: this.epoch, herdrSessionId: this.herdrSessionId(), parkRetryMs: this.options.retryMs,
          canStartNewWork: () => {
            this.options.lock.heartbeat()
            if (this.receipts!.isCapped()) return { ok: false, reason: `the receipt backlog reached its cap (${MAX_PENDING_RECEIPTS}; two slots reserved for control); waiting for delivery.` }
            if (this.stopped || !this.apiUp || this.options.now() >= this.leaseExpiresAt) return { ok: false, reason: 'the API lease is not confirmed.' }
            if (!this.s2Up || this.consumer?.pauseState()) return { ok: false, reason: 'the S2 command consumer is unavailable.' }
            return { ok: true }
          },
        })
        this.consumer = new CommandConsumer({ ...shared, transport: this.options.transport,
          bindingId: this.options.binding.bindingId, projectId: this.options.binding.projectId, workspaceId: this.options.binding.workspaceId,
          sessionId: this.sessionId, onCommand: id => this.dispatcher!.enqueue(id),
          onSnapshot: runs => {
            this.dispatcher!.refreshRuns(runs)
            const summary = `${runs.filter(r => r.status === 'queued').length} queued, ${runs.filter(r => !['queued', 'succeeded', 'cancelled', 'failed'].includes(r.status)).length} occupying the checkout`
            if (summary !== this.lastQueue) { this.lastQueue = summary; this.log(`  queue     ${summary}`) }
          },
          s2ConnectedChanged: connected => { this.s2Up = connected; this.connectionChanged() },
        })
        this.screens = new ScreenPublisher({ ...shared, adapter: this.options.adapter, transport: this.options.transport,
          sessionId: this.sessionId, sessionEpoch: this.epoch, herdrSessionId: this.herdrSessionId(),
          canPublish: () => !this.stopped && this.apiUp && this.options.now() < this.leaseExpiresAt })
        this.track(this.receipts.run()); this.track(this.dispatcher.run()); this.track(this.consumer.run()); this.track(this.screens.run())
        await this.stopRequested
      }
    } catch (error) {
      if (isSimulatedCrash(error)) this.crashed = true
      this.onApiError(error)
      this.requestStop({ code: 1, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      this.consumer?.stop(); this.dispatcher?.stop(); this.receipts?.stop(); this.screens?.stop()
      this.wake()
      await Promise.allSettled(this.loops)
      if (!this.crashed) {
        if (!this.revoked) await this.receipts?.sendPendingOnce()
        if (this.revoked) await interruptOwnedRuns({ journal: this.options.journal, adapter: this.options.adapter,
          herdrSessionId: this.herdrSessionId(), log: text => this.log(text) })
        if (this.sessionId) {
          try { await this.options.api.offlineRunnerSession(this.sessionId) }
          catch { this.log('The offline mark is unconfirmed; the lease will expire. Recovery files are retained.') }
        }
        if (journalActiveRuns(this.options.journal).length === 0 &&
          !this.options.journal.view().receipts.some(r => r.state === 'pending')) this.options.lock.clearRecovery()
      }
      // A simulated crash closes the kernel fd, as process death would; it
      // does not clear recovery ownership, send receipts or mark offline.
      this.options.lock.release()
      this.options.io.err(`vikan: ${this.outcome.reason}\n`)
      this.resolveFinished(this.outcome)
    }
    return this.outcome
  }
  private async online(): Promise<void> {
    while (!this.stopped) {
      try {
        const opened = await this.options.api.openRunnerSession({
          bindingId: this.options.binding.bindingId, protocolVersion: AGENT_PROTOCOL_VERSION, cliVersion: this.options.cliVersion,
          herdr: { version: this.options.herdr.herdrVersion, protocolVersion: 22, sessionId: this.herdrSessionId(),
            workspaceId: this.options.herdr.workspaceId, tabId: this.options.herdr.tabId, paneId: this.options.herdr.paneId }, agentKinds: ['codex'],
        })
        this.sessionId = opened.sessionId; this.epoch = opened.epoch
        this.leaseExpiresAt = Date.parse(opened.leaseExpiresAt); this.heartbeatMs = opened.heartbeatIntervalSeconds * 1000
        this.apiUp = true; this.connectionChanged()
        const b = this.options.binding
        this.log(`vikan online — session ${this.sessionId} (epoch ${this.epoch})\n  project   ${b.projectId} in workspace ${b.workspaceId}\n  device    ${b.deviceId}\n  queue     ${journalActiveRuns(this.options.journal).length} unfinished runs; recovering authority\n  herdr     pane ${this.options.herdr.paneId}\n  Agent page ${b.agentPageUrl}`)
        return
      } catch (error) {
        this.onApiError(error)
        const failure = apiFailure(error)
        if (failure.kind === 'problem' && failure.status < 500 && failure.status !== 429) {
          this.requestStop({ code: 1, reason: `Going online was refused (${failure.title}); pair again with vikan link if access was revoked.` }); return
        }
        await this.sleep(this.options.retryMs ?? 2000)
      }
    }
  }
  private async heartbeat(): Promise<void> {
    while (!this.stopped) {
      await this.sleep(this.heartbeatMs)
      if (this.stopped) return
      this.options.lock.heartbeat()
      try {
        const beat = await this.options.api.heartbeatRunnerSession(this.sessionId, { s2Connected: this.s2Up })
        this.leaseExpiresAt = Date.parse(beat.leaseExpiresAt)
        this.apiUp = true; this.connectionChanged()
        if (!this.consumer?.pauseState()) await this.consumer?.refreshAuthority()
      } catch (error) { this.onApiError(error) }
    }
  }
}
