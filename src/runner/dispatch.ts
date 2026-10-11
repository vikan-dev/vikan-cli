import { AGENT_RUN_TERMINAL_STATUSES, isUnsupportedAgentProtocolVersion, type AgentRunStatus } from '@vikan/sdk/agent'
import { ApiCallError, apiFailure, type AgentRun, type VikanApiClient } from '../api/client.ts'
import { agentNameForRun, isAgentAdapterUnavailable, type AgentAdapter, type AgentTarget, type AgentTargetStatus } from './adapter.ts'
import { checkpoint, isSimulatedCrash, type CrashHook } from './crash.ts'
import type { ReceiptQueue } from './receipts.ts'
import type { RunnerCommandEntry, RunnerJournal } from '../state/journal.ts'
import { issueDeliveryInstructions, projectDocumentDeliveryInstructions, runFindingsInstructions } from './deliverables.ts'

export const isTerminal = (status: AgentRunStatus): boolean => (AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
export interface NewWorkGate { (): { ok: true } | { ok: false; reason: string } }
export interface DispatcherDeps {
  readonly api: VikanApiClient
  readonly journal: RunnerJournal
  readonly adapter: AgentAdapter
  readonly receipts: ReceiptQueue
  readonly sessionId: string
  readonly deliverablesCommand?: string
  readonly sessionEpoch: number
  readonly herdrSessionId: string
  readonly log: (text: string) => void
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly canStartNewWork: NewWorkGate
  readonly onApiError?: (error: unknown) => void
  readonly crashHook?: CrashHook
  readonly pollMs?: number
  readonly parkRetryMs?: number
}

/** Execution and control are independent workers. They only wait for bounded
 * adapter operations (never for task completion), and both recheck the durable
 * cancel flag after awaits. The adapter performs its final occupant check. */
export class Dispatcher {
  private stopped = false
  private readonly pending = new Set<string>()
  private readonly parked = new Map<string, number>()
  private readonly logged = new Set<string>()
  constructor(private readonly deps: DispatcherDeps) {
    for (const command of deps.journal.view().commands.values()) this.enqueue(command.commandId)
  }
  enqueue(commandId: string): void {
    if (!this.done(commandId)) this.pending.add(commandId)
  }
  private done(commandId: string): boolean {
    return this.deps.journal.view().receipts.some(r => r.receiptId === `ack:${commandId}`)
  }
  async run(): Promise<void> { await Promise.all([this.worker(false), this.worker(true)]) }
  stop(): void { this.stopped = true }
  private async worker(control: boolean): Promise<void> {
    while (!this.stopped) {
      const commands = [...this.pending].map(id => this.deps.journal.view().commands.get(id)!)
        .filter(c => (c.kind === 'cancel') === control && (this.parked.get(c.commandId) ?? 0) <= this.deps.now())
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.commandSeq - b.commandSeq)
      const command = commands[0]
      if (!command) { await this.deps.sleep(this.deps.pollMs ?? 200); continue }
      try { await this.process(command) }
      catch (error) {
        if (isSimulatedCrash(error)) throw error
        if (isAgentAdapterUnavailable(error)) this.logOnce(error.message)
        else {
          const failure = apiFailure(error)
          if (failure.kind === 'problem' && failure.code === 'command_expired') this.acknowledge(command, 'rejected', failure.title)
          else this.deps.onApiError?.(error)
        }
      }
      if (this.done(command.commandId)) this.pending.delete(command.commandId)
      else this.parked.set(command.commandId, this.deps.now() + (this.deps.parkRetryMs ?? 1000))
    }
  }
  private logOnce(reason: string): void {
    if (!this.logged.has(reason)) { this.logged.add(reason); this.deps.log(reason) }
  }
  private target(command: RunnerCommandEntry): AgentTarget {
    const run = this.deps.journal.view().runs.get(command.runId)
    return { runId: command.runId, agentName: run?.agentName ?? agentNameForRun(command.runId),
      paneId: run?.paneId ?? null, occupantId: run?.occupantId ?? null,
      herdrSessionId: run?.herdrSessionId ?? this.deps.herdrSessionId }
  }
  private acknowledge(command: RunnerCommandEntry, outcome: 'accepted' | 'rejected' | 'stalled', detail?: string): void {
    this.deps.receipts.enqueue({ kind: 'command-ack', commandId: command.commandId, outcome,
      ...(detail ? { detail } : {}), ...(this.deps.journal.view().phases.get(command.commandId) ? { phase: this.deps.journal.view().phases.get(command.commandId)! } : {}) })
  }
  private status(command: RunnerCommandEntry, status: AgentRunStatus, reason?: string): boolean {
    const run = this.deps.journal.view().runs.get(command.runId)
    return this.deps.receipts.enqueue({ kind: 'run-status', runId: command.runId, status,
      eventId: `${command.commandId}:${status}`, expectedRunVersion: run?.runVersion,
      ...(reason ? { reason } : {}) })
  }
  private uncertain(command: RunnerCommandEntry, reason: string): void {
    this.deps.journal.recordRun({ runId: command.runId, uncertain: true, status: 'needs_reconciliation' })
    if (this.status(command, 'needs_reconciliation', reason)) this.acknowledge(command, 'stalled', reason)
    this.logOnce(`Run ${command.runId} needs_reconciliation: ${reason} No prompt is resent; the checkout remains occupied.`)
  }
  private completedPrompt(command: RunnerCommandEntry): void {
    // Keep the phase recoverable if the queue has no room for both results.
    if (this.status(command, 'running')) this.acknowledge(command, 'accepted')
  }
  private async process(command: RunnerCommandEntry): Promise<void> {
    if (this.done(command.commandId) || this.stopped) return
    const phase = this.deps.journal.view().phases.get(command.commandId)
    if (command.kind !== 'cancel' && phase === 'prompt_acknowledged') { this.completedPrompt(command); return }
    if (command.kind !== 'cancel' && phase === 'prompt_dispatching') {
      this.uncertain(command, 'Prompt delivery may have happened without a durable acknowledgement.'); return
    }
    if (command.kind === 'cancel') { await this.cancel(command); return }
    const gate = this.deps.canStartNewWork()
    if (!gate.ok) { this.logOnce(`Holding run ${command.runId}: ${gate.reason}`); return }
    const local = this.deps.journal.view().runs.get(command.runId)
    if (local?.uncertain || local?.status === 'needs_reconciliation') return
    if (command.kind === 'start') {
      // Local uncertainty survives a lost lock or a different server view.
      if ([...this.deps.journal.view().runs.values()].some(r => r.runId !== command.runId &&
        (r.uncertain || (r.status !== 'queued' && !isTerminal(r.status))))) {
        // Refresh lets an explicit server confirmation release the ordinary slot.
        this.refreshRuns((await this.deps.api.listRuns({})).runs)
        return
      }
      const target = await this.deps.adapter.verifyTarget(this.target(command)) // unavailable backend never claims
      if (this.stopped) return
      try {
        const claim = await this.deps.api.claimRun(command.runId, this.deps.sessionId)
        if (claim.claimEpoch !== this.deps.sessionEpoch) throw new Error('Unexpected run claim epoch')
        this.deps.journal.recordRun({ runId: command.runId, claimEpoch: claim.claimEpoch, runVersion: claim.runVersion,
          sessionId: this.deps.sessionId, agentName: this.target(command).agentName,
          herdrSessionId: this.target(command).herdrSessionId })
      } catch (error) {
        const failure = apiFailure(error)
        if (failure.kind === 'problem' && ['run_invalidated', 'command_expired'].includes(failure.code)) {
          const run = await this.deps.api.getRun(command.runId)
          this.refreshRuns([run]); this.acknowledge(command, 'rejected', failure.title); return
        }
        throw error
      }
      if (!phase) this.deps.journal.recordPhase(command.commandId, command.runId, 'prepared')
      if (!(await this.authorize(command))) return
      if (!(await this.spawn(command, target))) return
    }
    if (!(await this.authorize(command))) return
    const state = await this.deps.adapter.verifyTarget(this.target(command))
    if (state.status === 'agent-working' || state.status === 'blocked') return // queue supplements until ready
    if (state.status !== 'agent-ready') { this.uncertain(command, 'The saved Herdr target is missing or its occupant cannot be verified.'); return }
    this.rememberTarget(command, state)
    let prompt = command.prompt
    if (command.kind === 'start') {
      const context = await this.deps.api.getRunContext(command.runId)
      const current = await this.deps.api.getRun(command.runId)
      if (context.runId !== command.runId || current.runId !== command.runId || context.project.id !== current.projectId
        || context.project.workspaceId !== current.workspaceId || (context.issue?.id ?? null) !== current.issueId) {
        throw new ApiCallError({ kind: 'invalid-output' })
      }
      if (!this.deps.deliverablesCommand) throw new Error('Delivery CLI invocation is unavailable')
      prompt = [context.prompt, context.issue ? `# ${context.issue.identifier}: ${context.issue.title}\n${context.issue.descriptionText}\n${context.issue.comments.map(c => `- ${c.authorName}: ${c.body}`).join('\n')}` : '',
        context.projectDocument ? projectDocumentDeliveryInstructions(context, this.deps.deliverablesCommand)
          : context.issue ? issueDeliveryInstructions(context, this.deps.deliverablesCommand)
            : runFindingsInstructions(context, this.deps.deliverablesCommand)].filter(Boolean).join('\n\n')
    }
    if (prompt === null) { this.acknowledge(command, 'rejected', 'Missing prompt'); return }
    // API waits/context loading can change deadlines, epochs or cancel state.
    if (!(await this.authorize(command))) return
    this.deps.journal.recordPhase(command.commandId, command.runId, 'prompt_dispatching')
    this.deps.journal.recordRun({ runId: command.runId, effect: 'prompt' })
    try { await this.deps.adapter.sendPrompt({ ...this.target(command), prompt }) }
    catch (error) {
      if (isSimulatedCrash(error)) throw error
      this.uncertain(command, 'The adapter did not confirm prompt acceptance.'); return
    }
    checkpoint(this.deps.crashHook, `effect:prompt-acked:${command.commandId}`)
    this.deps.journal.recordPhase(command.commandId, command.runId, 'prompt_acknowledged')
    this.deps.journal.recordRun({ runId: command.runId, effect: null })
    checkpoint(this.deps.crashHook, `acknowledged:${command.commandId}`)
    this.completedPrompt(command)
  }
  private rememberTarget(command: RunnerCommandEntry, target: AgentTargetStatus): void {
    if ('paneId' in target) this.deps.journal.recordRun({ runId: command.runId, paneId: target.paneId,
      ...('occupantId' in target ? { occupantId: target.occupantId } : {}) })
  }
  private async spawn(command: RunnerCommandEntry, observed: AgentTargetStatus): Promise<boolean> {
    const { journal, adapter } = this.deps
    const run = journal.view().runs.get(command.runId)!
    const phase = journal.view().phases.get(command.commandId)
    if (observed.status === 'unknown' || observed.status === 'stopped' ||
      (observed.status === 'gone' && (run.effect !== null || phase !== 'prepared'))) {
      this.uncertain(command, 'A previous pane/agent effect cannot be established.'); return false
    }
    if (observed.status === 'agent-ready' || observed.status === 'agent-working' || observed.status === 'blocked') {
      this.rememberTarget(command, observed)
      journal.recordPhase(command.commandId, command.runId, 'agent_started')
      journal.recordRun({ runId: command.runId, effect: null })
      return true
    }
    if (observed.status === 'gone') {
      if (!(await this.authorize(command))) return false
      journal.recordRun({ runId: command.runId, effect: 'create-pane' })
      try {
        const pane = await adapter.createPane(this.target(command))
        checkpoint(this.deps.crashHook, `effect:pane-created:${command.commandId}`)
        journal.recordRun({ runId: command.runId, paneId: pane.paneId, effect: null })
        journal.recordPhase(command.commandId, command.runId, 'pane_created')
      } catch (error) {
        if (isSimulatedCrash(error)) throw error
        this.uncertain(command, 'Pane creation did not return a trustworthy result.'); return false
      }
    } else {
      if (run.effect === 'start-agent') { this.uncertain(command, 'Agent start may already have happened.'); return false }
      this.rememberTarget(command, observed)
      journal.recordRun({ runId: command.runId, effect: null })
      journal.recordPhase(command.commandId, command.runId, 'pane_created')
    }
    if (!(await this.authorize(command))) return false
    journal.recordRun({ runId: command.runId, effect: 'start-agent' })
    try {
      const target = this.target(command)
      const started = await adapter.startAgent({ ...target, paneId: target.paneId! })
      checkpoint(this.deps.crashHook, `effect:agent-started:${command.commandId}`)
      journal.recordRun({ runId: command.runId, occupantId: started.occupantId, effect: null })
      journal.recordPhase(command.commandId, command.runId, 'agent_started')
      return true
    } catch (error) {
      if (isSimulatedCrash(error)) throw error
      this.uncertain(command, 'Agent startup did not return a trustworthy result.'); return false
    }
  }
  /** Claims never substitute for current run/version/deadline validation:
   * the API permits idempotent claims even after a command was acknowledged. */
  private async authorize(command: RunnerCommandEntry): Promise<boolean> {
    if (this.stopped) return false
    const current = await this.deps.api.getRun(command.runId)
    this.refreshRuns([current])
    if (this.stopped) return false
    if (isTerminal(current.status)) { this.acknowledge(command, 'rejected', 'The run ended.'); return false }
    if (current.claimEpoch !== this.deps.sessionEpoch ||
      this.deps.journal.view().runs.get(command.runId)?.sessionId !== this.deps.sessionId) return false
    if (command.kind !== 'cancel') {
      if (current.cancelRequested || current.status === 'stopping' || current.status === 'needs_reconciliation' ||
        this.deps.journal.view().runs.get(command.runId)?.uncertain) return false
      if (!this.deps.canStartNewWork().ok) return false
    }
    const claimed = await this.deps.api.claimCommand(command.commandId, this.deps.sessionId)
    if (claimed.commandId !== command.commandId || claimed.runId !== command.runId || claimed.kind !== command.kind ||
      claimed.prompt !== command.prompt || claimed.commandSeq !== command.commandSeq ||
      claimed.expectedRunVersion !== command.expectedRunVersion || claimed.expiresAt !== command.expiresAt ||
      isUnsupportedAgentProtocolVersion(claimed)) throw new ApiCallError({ kind: 'invalid-output' })
    if (claimed.claim?.sessionId !== this.deps.sessionId || claimed.claim.claimEpoch !== this.deps.sessionEpoch) return false
    if (claimed.status !== 'claimed') { this.acknowledge(command, 'rejected', 'Command already settled by the server.'); return false }
    if (command.kind === 'continue') {
      if (command.expectedRunVersion !== current.runVersion || (command.expiresAt !== null && this.deps.now() >= Date.parse(command.expiresAt))) {
        this.acknowledge(command, 'rejected', 'The supplement target round or deadline is no longer valid.'); return false
      }
      const previous = (await this.deps.api.listRunCommands(command.runId)).commands
        .some(c => c.commandSeq < command.commandSeq && !['acked', 'rejected', 'expired'].includes(c.status) && !this.done(c.commandId))
      if (previous) return false
    }
    const latest = await this.deps.api.getRun(command.runId)
    this.refreshRuns([latest])
    if (latest.claimEpoch !== this.deps.sessionEpoch || isTerminal(latest.status)) return false
    if (command.kind === 'continue' && latest.runVersion !== command.expectedRunVersion) {
      this.acknowledge(command, 'rejected', 'The target round changed during validation.'); return false
    }
    return !this.stopped && (command.kind === 'cancel' ||
      (this.deps.canStartNewWork().ok && !this.deps.journal.view().runs.get(command.runId)?.cancelRequested &&
        (command.expiresAt === null || this.deps.now() < Date.parse(command.expiresAt))))
  }
  private async cancel(command: RunnerCommandEntry): Promise<void> {
    if (this.deps.journal.view().controls.has(command.commandId)) {
      if (this.status(command, 'stopping', 'Interrupt issued; stop unconfirmed.')) this.acknowledge(command, 'accepted', 'Interrupt issued; stop unconfirmed.')
      return
    }
    const run = await this.deps.api.getRun(command.runId)
    this.refreshRuns([run])
    if (isTerminal(run.status)) { this.acknowledge(command, 'rejected', 'Run already ended.'); return }
    if (run.status === 'queued') {
      try { await this.deps.api.claimRun(command.runId, this.deps.sessionId) } catch (error) {
        if (apiFailure(error).kind !== 'problem') throw error
      }
      return
    }
    if (!(await this.authorize(command))) return
    const local = this.deps.journal.view().runs.get(command.runId)!
    if (local.effect === 'interrupt') { this.uncertain(command, 'Interrupt result is unknown.'); return }
    const target = await this.deps.adapter.verifyTarget(this.target(command))
    if (this.stopped) return
    if (target.status === 'unknown' || target.status === 'pane-only') { this.uncertain(command, 'Cannot safely target the owned agent for stopping.'); return }
    if (target.status === 'gone' || target.status === 'stopped') {
      this.deps.journal.recordRun({ runId: command.runId, uncertain: false, effect: null })
      if (this.status(command, 'cancelled')) this.acknowledge(command, 'accepted', 'Owned agent observed stopped.'); return
    }
    this.rememberTarget(command, target)
    if (!(await this.authorize(command))) return
    // Record before Ctrl-C; never call a successful send a confirmed stop.
    this.deps.journal.recordRun({ runId: command.runId, effect: 'interrupt', cancelRequested: true })
    try { await this.deps.adapter.interrupt(this.target(command)) }
    catch (error) {
      if (isSimulatedCrash(error)) throw error
      this.uncertain(command, 'The stop request could not be confirmed.'); return
    }
    checkpoint(this.deps.crashHook, `effect:interrupt:${command.commandId}`)
    this.deps.journal.recordControl(command.commandId)
    this.deps.journal.recordRun({ runId: command.runId, effect: null })
    if (this.status(command, 'stopping', 'Interrupt issued; stop unconfirmed.')) this.acknowledge(command, 'accepted', 'Interrupt issued; stop unconfirmed.')
  }
  refreshRuns(runs: readonly AgentRun[]): void {
    for (const run of runs) {
      const known = this.deps.journal.view().runs.get(run.runId)
      if (known && known.runVersion > run.runVersion) continue
      this.deps.journal.recordRun({ runId: run.runId, status: known?.uncertain && !isTerminal(run.status) ? 'needs_reconciliation' : run.status, runVersion: run.runVersion,
        claimEpoch: run.claimEpoch, uncertain: isTerminal(run.status) ? false : known?.uncertain,
        cancelRequested: (known?.cancelRequested ?? false) || run.cancelRequested })
    }
  }
}
