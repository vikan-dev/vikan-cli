import { AGENT_PROTOCOL_VERSION, agentBindingCommandsStream, agentCommandSchema, isUnsupportedAgentProtocolVersion } from '@vikan/sdk/agent'
import { apiFailure, type ActiveSubscription, type AgentCommand, type AgentRun, type VikanApiClient } from '../api/client.ts'
import type { RunnerJournal } from '../state/journal.ts'
import { S2TransportError, type S2Transport, type S2TailSession } from '../transport/s2.ts'
import { checkpoint, isSimulatedCrash, type CrashHook } from './crash.ts'

export interface ConsumerDeps {
  readonly api: VikanApiClient
  readonly transport: S2Transport
  readonly journal: RunnerJournal
  readonly bindingId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly onCommand: (commandId: string) => void
  readonly onSnapshot: (runs: readonly AgentRun[]) => void
  readonly s2ConnectedChanged: (connected: boolean) => void
  readonly onApiError?: (error: unknown) => void
  readonly log: (text: string) => void
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly crashHook?: CrashHook
  readonly retryMs?: number
}
export type ConsumerPause = { kind: 'protocol'; reason: string } | { kind: 'stopped' }

/** Subscribe cursor → durable authority snapshot → catch-up. Commands never
 * wait on execution. A retention gap repeats that ordering at a fresh cursor. */
export class CommandConsumer {
  private stopped = false
  private paused: ConsumerPause | undefined
  private tail: S2TailSession | undefined
  private resetCursor = false
  constructor(private readonly deps: ConsumerDeps) {}
  pauseState(): ConsumerPause | undefined { return this.paused }
  stop(): void { this.stopped = true; void this.tail?.close() }
  async run(): Promise<ConsumerPause> {
    let backoff = this.deps.retryMs ?? 2_000
    while (!this.stopped && !this.paused) {
      try { await this.consumeOnce(); backoff = this.deps.retryMs ?? 2_000 }
      catch (error) {
        if (isSimulatedCrash(error)) throw error
        if (error instanceof ConsumerPausedError || (error instanceof S2TransportError && error.failure.kind === 'protocol') || (apiFailure(error).kind === 'problem' &&
          (apiFailure(error) as { code: string }).code === 'protocol_version_unsupported')) {
          this.paused = { kind: 'protocol', reason: 'Command consumer PAUSED: unsupported or corrupt protocol; upgrade vikan. The unread position is retained.' }
          this.deps.log(this.paused.reason)
          break
        }
        this.deps.onApiError?.(error)
        backoff = Math.min(backoff * 2, 30_000)
      } finally { this.deps.s2ConnectedChanged(false) }
      if (!this.stopped) await this.deps.sleep(backoff)
    }
    return this.paused ?? { kind: 'stopped' }
  }
  private async consumeOnce(): Promise<void> {
    const response = await this.deps.api.issueSubscriptions({
      protocolVersion: AGENT_PROTOCOL_VERSION, sessionId: this.deps.sessionId,
      scopes: [{ kind: 'binding-commands', bindingId: this.deps.bindingId }],
    })
    const active = response.subscriptions.find((s): s is ActiveSubscription => s.status === 'active' && s.kind === 'binding-commands')
    if (!active || active.stream !== agentBindingCommandsStream(this.deps.bindingId) ||
      !active.operations.includes('read') || active.operations.includes('append')) throw new ConsumerPausedError()
    if (this.stopped) return
    const cursor = this.deps.journal.cursor(active.stream)
    if (cursor === undefined) this.deps.journal.advanceCursor(active.stream, active.nextSeqNum)
    await this.readAuthoritySnapshot()
    if (this.stopped) return
    // On a gap, only move after the replacement snapshot is fully durable.
    if (this.resetCursor) {
      this.deps.journal.advanceCursor(active.stream, active.nextSeqNum)
      this.resetCursor = false
    }
    const tail = await this.deps.transport.tail({ ...active, fromSeq: this.deps.journal.cursor(active.stream)! })
    this.tail = tail
    if (this.stopped) { await tail.close(); return }
    this.deps.s2ConnectedChanged(true)
    // Long-lived idle sessions still renew; token expiry need not end a read.
    const renew = setTimeout(() => void tail.close(), Math.max(1, Math.min(60_000, Date.parse(active.tokenExpiresAt) - this.deps.now() - 5_000)))
    renew.unref?.()
    try {
      for await (const record of tail) {
        if (this.stopped) break
        const next = this.deps.journal.cursor(active.stream)!
        if (BigInt(record.seqNum) < BigInt(next)) continue
        if (BigInt(record.seqNum) > BigInt(next)) {
          this.deps.log(`S2 gap at ${next}; recovering durable commands from the authority snapshot.`)
          this.resetCursor = true
          break
        }
        let raw: unknown
        try { raw = JSON.parse(record.body) } catch { throw new ConsumerPausedError() }
        const command = this.parse(raw)
        this.save(command)
        // Both identity and content are durable before advancing this cursor.
        this.deps.journal.advanceCursor(active.stream, String(BigInt(record.seqNum) + 1n))
        this.deps.onCommand(command.commandId)
      }
    } finally {
      clearTimeout(renew)
      this.tail = undefined
      await tail.close()
    }
  }
  private parse(raw: unknown): AgentCommand {
    const parsed = agentCommandSchema.safeParse(raw)
    if (!parsed.success || isUnsupportedAgentProtocolVersion(raw)) throw new ConsumerPausedError()
    const c = parsed.data
    if (c.bindingId !== this.deps.bindingId || c.projectId !== this.deps.projectId || c.workspaceId !== this.deps.workspaceId) throw new ConsumerPausedError()
    return c
  }
  private save(c: AgentCommand): void {
    checkpoint(this.deps.crashHook, `received:${c.commandId}`)
    this.deps.journal.appendCommand({
      commandId: c.commandId, runId: c.runId, kind: c.kind, commandSeq: c.commandSeq,
      prompt: c.prompt, expectedRunVersion: c.expectedRunVersion, expiresAt: c.expiresAt,
      receivedAt: new Date(this.deps.now()).toISOString(), serverStatus: c.status,
    })
    if (c.kind === 'cancel') this.deps.journal.recordRun({ runId: c.runId, cancelRequested: true })
    checkpoint(this.deps.crashHook, `persisted:${c.commandId}`)
  }
  async refreshAuthority(): Promise<void> {
    if (this.stopped || this.paused) return
    try { await this.readAuthoritySnapshot() } catch (error) {
      if (error instanceof ConsumerPausedError) {
        this.paused = { kind: 'protocol', reason: 'Command consumer PAUSED: upgrade vikan; authority protocol is unsupported.' }
        this.deps.log(this.paused.reason)
        this.deps.s2ConnectedChanged(false)
        await this.tail?.close()
      } else throw error
    }
  }
  private async readAuthoritySnapshot(): Promise<void> {
    const { runs } = await this.deps.api.listRuns({ bindingId: this.deps.bindingId })
    this.deps.onSnapshot(runs)
    for (const run of runs) {
      if (this.stopped) return
      const { commands } = await this.deps.api.listRunCommands(run.runId)
      for (const raw of commands) {
        const command = this.parse(raw)
        this.save(command)
        this.deps.onCommand(command.commandId)
      }
    }
  }
}
class ConsumerPausedError extends Error {}
