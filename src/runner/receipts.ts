import { apiFailure, type VikanApiClient } from '../api/client.ts'
import { checkpoint, isSimulatedCrash, type CrashHook } from './crash.ts'
import { receiptIdOf, type RunnerJournal, type RunnerReceipt, type RunnerReceiptRecord } from '../state/journal.ts'

export const MAX_PENDING_RECEIPTS = 64
// Reserve two durable results for a stop even while new work is backpressured.
export const NEW_WORK_RECEIPT_LIMIT = MAX_PENDING_RECEIPTS - 2
export interface ReceiptQueueDeps {
  readonly api: VikanApiClient
  readonly journal: RunnerJournal
  readonly sessionId: () => string
  readonly sessionEpoch: () => number
  readonly log: (text: string) => void
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly onApiError?: (error: unknown) => void
  readonly crashHook?: CrashHook
  readonly pollMs?: number
  readonly retryMs?: number
}

/** Results are durable before HTTP. Each attempted request is frozen on disk:
 * an HTTP retry never acquires a newer version merely because a timer fired.
 * A new session must explicitly reconcile/reclaim before replaying evidence. */
export class ReceiptQueue {
  private stopped = false
  private sending: Promise<void> | undefined
  constructor(private readonly deps: ReceiptQueueDeps) {}
  enqueue(receipt: RunnerReceipt): boolean {
    if (this.deps.journal.view().receipts.some(r => r.receiptId === receiptIdOf(receipt))) return true
    if (this.pendingCount() >= MAX_PENDING_RECEIPTS) return false
    return this.deps.journal.appendReceipt(receipt)
  }
  pendingCount(): number { return this.deps.journal.view().receipts.filter(r => r.state === 'pending').length }
  isCapped(): boolean { return this.pendingCount() >= NEW_WORK_RECEIPT_LIMIT }
  async run(): Promise<void> {
    while (!this.stopped) {
      await this.sendPendingOnce()
      await this.deps.sleep(this.pendingCount() ? this.deps.retryMs ?? 2_000 : this.deps.pollMs ?? 200)
    }
  }
  stop(): void { this.stopped = true }
  async sendPendingOnce(): Promise<void> {
    if (this.sending) return this.sending
    this.sending = this.drain()
    try { await this.sending } finally { this.sending = undefined }
  }
  private async drain(): Promise<void> {
    for (const record of this.deps.journal.view().receipts) {
      if (record.state !== 'pending') continue
      if (!(await this.send(record))) break // preserve order on unknown HTTP outcome
    }
  }
  private async send(record: RunnerReceiptRecord): Promise<boolean> {
    const { journal, api } = this.deps
    const receipt = record.payload
    const sessionId = this.deps.sessionId()
    const claimEpoch = this.deps.sessionEpoch()
    checkpoint(this.deps.crashHook, `pre-receipt:${record.receiptId}`)
    try {
      if (receipt.kind === 'command-ack') {
        const command = journal.view().commands.get(receipt.commandId)
        if (command !== undefined && (!record.request || record.request.sessionId !== sessionId)) {
          const commands = (await api.listRunCommands(command.runId)).commands
          const current = commands.find(c => c.commandId === command.commandId)
          if (current?.status === 'acked' || current?.status === 'rejected') {
            journal.markReceipt(record.receiptId, 'sent')
            return true
          }
          const run = journal.view().runs.get(command.runId)
          if (run?.sessionId !== sessionId || run.claimEpoch !== claimEpoch) {
            journal.markReceipt(record.receiptId, 'refused')
            return true // preserved evidence, no authority to re-stamp it
          }
          if (current?.claim?.sessionId !== sessionId) await api.claimCommand(command.commandId, sessionId)
        }
        if (!record.request || record.request.sessionId !== sessionId) journal.recordReceiptRequest(record.receiptId, { sessionId, claimEpoch })
        await api.ackCommand(receipt.commandId, {
          ...record.request!, outcome: receipt.outcome,
          ...(receipt.phase ? { phase: receipt.phase } : {}),
          ...(receipt.detail ? { detail: receipt.detail.slice(0, 2000) } : {}),
        })
      } else {
        const run = journal.view().runs.get(receipt.runId)
        if (!run || run.sessionId !== sessionId || run.claimEpoch !== claimEpoch) {
          journal.markReceipt(record.receiptId, 'refused')
          return true
        }
        if (!record.request || record.request.sessionId !== sessionId) {
          const current = await api.getRun(receipt.runId)
          if (current.status === receipt.status) {
            journal.recordRun({ runId: current.runId, status: current.status, runVersion: current.runVersion })
            journal.markReceipt(record.receiptId, 'sent')
            return true
          }
          // Recovery only replays a proven acknowledged start. Other stale
          // results stay as facts; they must not overwrite a newer round.
          const recoveredStart = receipt.status === 'running' && current.status === 'starting' &&
            journal.view().runPhases.get(receipt.runId) === 'prompt_acknowledged' && !run.uncertain
          if ((receipt.status === 'running' && current.cancelRequested) || current.claimEpoch !== claimEpoch ||
            (receipt.expectedRunVersion !== undefined && current.runVersion !== receipt.expectedRunVersion && !recoveredStart)) {
            journal.markReceipt(record.receiptId, 'refused')
            this.deps.log(`Receipt ${record.receiptId} targets an older round; recovery evidence is retained.`)
            return true
          }
          journal.recordReceiptRequest(record.receiptId, { sessionId, claimEpoch, expectedRunVersion: current.runVersion })
        }
        const ack = await api.submitRunStatus(receipt.runId, {
          ...record.request!, expectedRunVersion: record.request!.expectedRunVersion!, status: receipt.status,
          ...(receipt.reason ? { reason: receipt.reason.slice(0, 2000) } : {}),
        })
        journal.recordRun({ runId: ack.runId, status: ack.status, runVersion: ack.runVersion })
      }
      checkpoint(this.deps.crashHook, `receipt-accepted:${record.receiptId}`)
      journal.markReceipt(record.receiptId, 'sent')
      return true
    } catch (error) {
      if (isSimulatedCrash(error)) throw error
      this.deps.onApiError?.(error)
      const failure = apiFailure(error)
      if (failure.kind !== 'problem' || failure.status >= 500 || failure.status === 429) return false
      journal.markReceipt(record.receiptId, 'refused')
      this.deps.log(`Receipt ${record.receiptId} was refused (${failure.code}); its evidence is retained.`)
      return true
    }
  }
}
