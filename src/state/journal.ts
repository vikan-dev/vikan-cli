import { randomUUID } from 'node:crypto'
import { agentRunStatusSchema, type AgentRunStatus } from '@vikan/sdk/agent'
import { bindingJournal, type BindingRef } from './binding.ts'
import type { Journal } from './files.ts'

/**
 * The runner journal (todo 09 T2, plan §5.2/§10.3): the durable receive and
 * execution ledger, appended through 05's atomic fsync'd JSONL primitive.
 *
 * Write-ahead discipline the crash matrix relies on:
 *   * a received command record is appended BEFORE the receive cursor moves
 *     past it — a crash between the two replays the same S2 record, which the
 *     commandId ledger dedupes;
 *   * a phase record is appended BEFORE the side effect it guards when the
 *     side effect is unobservable-checkable (prompt_dispatching), and
 *     immediately AFTER a side effect that reports an identity (pane_created,
 *     agent_started, prompt_acknowledged) — restarts adopt the existing
 *     target through the adapter instead of re-spawning;
 *   * a receipt is appended (state 'pending') BEFORE its HTTP call, so a
 *     lost response replays it; the server's idempotent receipts make the
 *     retry safe.
 *
 * Record shapes (all `{ type, ... }`; 05's unlink reads the `run` ones):
 *   cursor   { stream, nextSeqNum }              next UNPROCESSED seq (decimal string)
 *   command  { commandId, runId, kind, ... }     the commandId dedup ledger
 *   phase    { commandId, runId, phase }         prepared → … → prompt_acknowledged
 *   run      { runId, status, ... }              run→pane/agent map + status (last wins)
 *   receipt  { receiptId, payload, state }       pending → sent / refused
 */

export type RunnerPhase = 'prepared' | 'pane_created' | 'agent_started' | 'prompt_dispatching' | 'prompt_acknowledged'

export interface RunnerCommandEntry {
  readonly commandId: string
  readonly runId: string
  readonly kind: 'start' | 'continue' | 'cancel'
  readonly commandSeq: number
  /** The supplement text for 'continue'; null for 'start' (context comes from the run) and 'cancel'. */
  readonly prompt: string | null
  readonly expectedRunVersion: number | null
  readonly expiresAt: string | null
  readonly receivedAt: string
  readonly serverStatus?: string
}

export interface RunnerRunEntry {
  readonly runId: string
  status: AgentRunStatus
  claimEpoch: number | null
  runVersion: number
  paneId: string | null
  agentName: string | null
  sessionId: string | null
  herdrSessionId: string | null
  occupantId: string | null
  cancelRequested: boolean
  uncertain: boolean
  effect: 'create-pane' | 'start-agent' | 'prompt' | 'interrupt' | null
}

/**
 * A durable receipt intent, followed by its exact attempted HTTP request.
 * Retries preserve the epoch/version; a new session may carry confirmed
 * evidence across an explicit reconcile, but never across an arbitrary round.
 */
export type RunnerReceipt =
  | {
      readonly kind: 'command-ack'
      readonly commandId: string
      readonly outcome: 'accepted' | 'failed' | 'rejected' | 'stalled'
      readonly phase?: RunnerPhase
      readonly detail?: string
    }
  | {
      readonly kind: 'run-status'
      readonly runId: string
      readonly status: AgentRunStatus
      readonly reason?: string
      readonly eventId?: string
      readonly expectedRunVersion?: number
    }

export type RunnerReceiptState = 'pending' | 'sent' | 'refused'

export interface RunnerJournalView {
  /** Next unprocessed sequence per stream (decimal string). */
  readonly cursors: ReadonlyMap<string, string>
  /** The commandId dedup ledger. */
  readonly commands: ReadonlyMap<string, RunnerCommandEntry>
  /** Last phase per commandId. */
  readonly phases: ReadonlyMap<string, RunnerPhase>
  /** Last phase per runId, in journal order (the reconcile report). */
  readonly runPhases: ReadonlyMap<string, RunnerPhase>
  /** Run → status/claim/pane/agent map (last record per run wins). */
  readonly runs: ReadonlyMap<string, RunnerRunEntry>
  /** Receipts in first-appearance order, with their current state. */
  readonly controls: ReadonlySet<string>
  readonly receipts: readonly RunnerReceiptRecord[]
}

export interface RunnerReceiptRecord {
  readonly receiptId: string
  payload: RunnerReceipt
  state: RunnerReceiptState
  request?: { sessionId: string; claimEpoch: number; expectedRunVersion?: number }
}

export function receiptIdOf(receipt: RunnerReceipt): string {
  return receipt.kind === 'command-ack' ? `ack:${receipt.commandId}` : `status:${receipt.runId}:${receipt.eventId ?? receipt.status}`
}

export class RunnerJournal {
  private readonly controls = new Set<string>()
  private readonly cursors = new Map<string, string>()
  private readonly commands = new Map<string, RunnerCommandEntry>()
  private readonly phases = new Map<string, RunnerPhase>()
  private readonly runPhases = new Map<string, RunnerPhase>()
  private readonly runs = new Map<string, RunnerRunEntry>()
  private readonly receiptsById = new Map<string, RunnerReceiptRecord>()
  private readonly receiptOrder: string[] = []

  private constructor(private readonly journal: Journal) {}

  static open(configRoot: string, ref: BindingRef): RunnerJournal {
    const journal = bindingJournal(configRoot, ref)
    const runner = new RunnerJournal(journal)
    const records = journal.records()
    for (const record of records) runner.replay(record)
    if (records.length === 0) journal.append({ type: 'metadata', version: 1, installationId: randomUUID(), binding: ref })
    return runner
  }

  private replay(record: unknown): void {
    if (typeof record !== 'object' || record === null) throw new Error('Corrupt runner journal')
    const r = record as Record<string, unknown>
    switch (r.type) {
      case 'control':
        if (typeof r.commandId !== 'string') throw new Error('Corrupt control journal record')
        this.controls.add(r.commandId)
        return
      case 'metadata':
        if (r.version !== 1) throw new Error('Unsupported journal protocol; upgrade vikan before running.')
        return
      case 'cursor':
        if (typeof r.stream !== 'string' || typeof r.nextSeqNum !== 'string' || !/^(0|[1-9]\d*)$/.test(r.nextSeqNum)) throw new Error('Corrupt cursor journal record')
        this.cursors.set(r.stream, r.nextSeqNum)
        return
      case 'command': {
        const entry = parseCommandEntry(r)
        if (entry === undefined) throw new Error('Corrupt command journal record')
        this.commands.set(entry.commandId, entry)
        return
      }
      case 'phase':
        if (typeof r.commandId === 'string' && typeof r.runId === 'string' && isPhase(r.phase)) {
          this.phases.set(r.commandId, r.phase)
          this.runPhases.set(r.runId, r.phase)
        } else throw new Error('Unsupported or corrupt phase journal record; upgrade vikan before running.')
        return
      case 'run': {
        const entry = parseRunEntry(r)
        if (entry === undefined) throw new Error('Corrupt run journal record')
        {
          // Merge onto the previous view so partial updates (a pane id
          // learned later) do not erase earlier facts.
          const prior = this.runs.get(entry.runId)
          this.runs.set(entry.runId, { ...prior, ...entry })
        }
        return
      }
      case 'receipt': {
        if (typeof r.receiptId === 'string' && isReceipt(r.payload) && isReceiptState(r.state)) {
          const existing = this.receiptsById.get(r.receiptId)
          if (existing === undefined) {
            const created: RunnerReceiptRecord = { receiptId: r.receiptId, payload: r.payload, state: r.state, ...(r.request ? { request: r.request as RunnerReceiptRecord['request'] } : {}) }
            this.receiptsById.set(r.receiptId, created)
            this.receiptOrder.push(r.receiptId)
          } else {
            existing.payload = r.payload as RunnerReceipt
            existing.state = r.state
            existing.request = r.request as RunnerReceiptRecord['request']
          }
        } else throw new Error('Corrupt receipt journal record')
        return
      }
      default:
        throw new Error('Unsupported journal record; upgrade vikan before running.')
    }
  }

  view(): RunnerJournalView {
    return {
      controls: this.controls,
      cursors: this.cursors,
      commands: this.commands,
      phases: this.phases,
      runPhases: this.runPhases,
      runs: this.runs,
      receipts: this.receiptOrder.map((id) => this.receiptsById.get(id)!),
    }
  }

  cursor(stream: string): string | undefined {
    return this.cursors.get(stream)
  }

  /** First sight of a command: true when this append created the ledger entry. */
  appendCommand(entry: RunnerCommandEntry): boolean {
    if (this.commands.has(entry.commandId)) return false
    this.journal.append({ type: 'command', ...entry })
    this.commands.set(entry.commandId, entry)
    return true
  }

  /** Move the receive cursor AFTER the command (or skip) is durably recorded. */
  advanceCursor(stream: string, nextSeqNum: string): void {
    const prior = this.cursors.get(stream)
    if (prior !== undefined && BigInt(prior) >= BigInt(nextSeqNum)) return
    this.journal.append({ type: 'cursor', stream, nextSeqNum })
    this.cursors.set(stream, nextSeqNum)
  }

  recordControl(commandId: string): void {
    this.journal.append({ type: 'control', commandId })
    this.controls.add(commandId)
  }

  recordPhase(commandId: string, runId: string, phase: RunnerPhase): void {
    if (this.phases.get(commandId) === phase) return
    this.journal.append({ type: 'phase', commandId, runId, phase })
    this.phases.set(commandId, phase)
    this.runPhases.set(runId, phase)
  }

  recordRun(entry: Partial<RunnerRunEntry> & { readonly runId: string }): void {
    const prior = this.runs.get(entry.runId)
    // Skip undefined fields: a snapshot refresh carries only status/version/
    // claim and must not erase locally-known pane/agent facts.
    const carried: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entry)) {
      if (value !== undefined) carried[key] = value
    }
    const merged = { status: 'queued', runVersion: 1, claimEpoch: null, paneId: null, agentName: null, sessionId: null, herdrSessionId: null, occupantId: null, cancelRequested: false, uncertain: false, effect: null, ...prior, ...carried } as RunnerRunEntry
    if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(merged)) return
    this.journal.append({ type: 'run', ...merged })
    this.runs.set(entry.runId, merged)
  }

  /** Persist a receipt as pending; returns false when it already exists. */
  appendReceipt(payload: RunnerReceipt): boolean {
    const receiptId = receiptIdOf(payload)
    if (this.receiptsById.has(receiptId)) return false
    this.journal.append({ type: 'receipt', receiptId, payload, state: 'pending' })
    const record: RunnerReceiptRecord = { receiptId, payload, state: 'pending' }
    this.receiptsById.set(receiptId, record)
    this.receiptOrder.push(receiptId)
    return true
  }

  recordReceiptRequest(receiptId: string, request: NonNullable<RunnerReceiptRecord['request']>): void {
    const record = this.receiptsById.get(receiptId)!
    this.journal.append({ type: 'receipt', ...record, request })
    record.request = request
  }

  markReceipt(receiptId: string, state: RunnerReceiptState): void {
    const record = this.receiptsById.get(receiptId)
    if (record === undefined || record.state === state) return
    this.journal.append({ type: 'receipt', ...record, state })
    record.state = state
  }
}

function isPhase(value: unknown): value is RunnerPhase {
  return (
    value === 'prepared' || value === 'pane_created' || value === 'agent_started' ||
    value === 'prompt_dispatching' || value === 'prompt_acknowledged'
  )
}

function isReceiptState(value: unknown): value is RunnerReceiptState {
  return value === 'pending' || value === 'sent' || value === 'refused'
}

function isReceipt(value: unknown): value is RunnerReceipt {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  if (r.kind === 'command-ack') return typeof r.commandId === 'string' &&
    ['accepted', 'failed', 'rejected', 'stalled'].includes(String(r.outcome)) && (r.phase === undefined || isPhase(r.phase))
  if (r.kind === 'run-status') return typeof r.runId === 'string' && agentRunStatusSchema.safeParse(r.status).success
  return false
}

function parseCommandEntry(r: Record<string, unknown>): RunnerCommandEntry | undefined {
  if (
    typeof r.commandId !== 'string' || typeof r.runId !== 'string' || typeof r.commandSeq !== 'number' ||
    (r.kind !== 'start' && r.kind !== 'continue' && r.kind !== 'cancel') ||
    (r.prompt !== null && typeof r.prompt !== 'string') ||
    (r.expectedRunVersion !== null && typeof r.expectedRunVersion !== 'number') ||
    (r.expiresAt !== null && typeof r.expiresAt !== 'string')
  ) {
    return undefined
  }
  return {
    commandId: r.commandId,
    runId: r.runId,
    kind: r.kind,
    commandSeq: r.commandSeq,
    prompt: r.prompt,
    expectedRunVersion: r.expectedRunVersion,
    expiresAt: r.expiresAt,
    receivedAt: typeof r.receivedAt === 'string' ? r.receivedAt : '',
    ...(typeof r.serverStatus === 'string' ? { serverStatus: r.serverStatus } : {}),
  }
}

function parseRunEntry(r: Record<string, unknown>): RunnerRunEntry | undefined {
  if (typeof r.runId !== 'string' || !agentRunStatusSchema.safeParse(r.status).success) return undefined
  if (r.runVersion !== undefined && typeof r.runVersion !== 'number') return undefined
  if (r.claimEpoch !== undefined && r.claimEpoch !== null && typeof r.claimEpoch !== 'number') return undefined
  return {
    runId: r.runId,
    status: r.status as AgentRunStatus,
    claimEpoch: (r.claimEpoch ?? null) as number | null,
    runVersion: (r.runVersion ?? 1) as number,
    paneId: typeof r.paneId === 'string' ? r.paneId : null,
    agentName: typeof r.agentName === 'string' ? r.agentName : null,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
    herdrSessionId: typeof r.herdrSessionId === 'string' ? r.herdrSessionId : null,
    occupantId: typeof r.occupantId === 'string' ? r.occupantId : null,
    cancelRequested: r.cancelRequested === true, uncertain: r.uncertain === true,
    effect: (r.effect ?? null) as RunnerRunEntry['effect'],
  }
}
