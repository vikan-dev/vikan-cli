import { randomUUID } from 'node:crypto'
import { AGENT_PROTOCOL_VERSION, agentBindingCommandsStream, agentRunScreensStream, type AgentRunStatus } from '@vikan/sdk/agent'

/**
 * The in-memory agent runtime (todo 09 test support): 07/08's endpoint
 * semantics — sessions/epochs, claims, receipts, command ladder, grants —
 * mounted into the fake API server. Mirrors the real handlers closely
 * enough that the CLI's recovery behavior is exercised against honest
 * server rules: claim-before-act, epoch-checked receipts, durable cancel
 * expectations, idempotent acks, concealment-style 404s.
 */

import type { FakeS2 } from './fake-s2.ts'

export interface FakeSession {
  readonly sessionId: string
  readonly bindingId: string
  epoch: number
  endedAt: string | null
  leaseExpiresAt: string
  s2Connected: boolean
}

export interface FakeRun {
  readonly runId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly bindingId: string
  readonly issueId: string | null
  readonly trigger: 'manual' | 'automation'
  status: AgentRunStatus
  runVersion: number
  claimSessionId: string | null
  claimEpoch: number | null
  captureEpoch: string | null
  readonly prompt: string
  cancelRequested: boolean
  cancelReason: string | null
  failureReason: string | null
  readonly queuedAt: string
  startedAt: string | null
  endedAt: string | null
}

export interface FakeCommand {
  readonly commandId: string
  readonly operationId: string
  readonly runId: string
  readonly bindingId: string
  readonly commandSeq: number
  readonly kind: 'start' | 'continue' | 'cancel'
  status: 'pending' | 'dispatched' | 'claimed' | 'acked' | 'expired' | 'rejected'
  readonly prompt: string | null
  readonly expectedRunVersion: number | null
  readonly issuedBy: string
  readonly issuedAt: string
  readonly expiresAt: string | null
  claimSessionId: string | null
  claimEpoch: number | null
  receiptOutcome: string | null
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const problem = (status: number, code: string, title: string): Response =>
  json({ type: `https://errors.zebra.dev/${code}`, status, title, instance: '/' }, status)

const SLOT_STATUSES: readonly AgentRunStatus[] = ['starting', 'running', 'awaiting_review', 'blocked', 'stopping', 'needs_reconciliation']
const TERMINAL: readonly AgentRunStatus[] = ['succeeded', 'cancelled', 'failed']
const NON_TERMINAL: readonly AgentRunStatus[] = ['queued', ...SLOT_STATUSES]

/** Receipt-legal transitions (mirrors 07's table). */
const RECEIPT_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: [],
  starting: ['running', 'blocked', 'stopping', 'failed', 'needs_reconciliation', 'cancelled'],
  running: ['awaiting_review', 'blocked', 'stopping', 'failed', 'needs_reconciliation', 'cancelled'],
  awaiting_review: ['running', 'stopping', 'cancelled', 'needs_reconciliation'],
  blocked: ['running', 'stopping', 'cancelled', 'failed', 'needs_reconciliation'],
  stopping: ['running', 'cancelled', 'needs_reconciliation'],
  needs_reconciliation: [],
  succeeded: [],
  cancelled: [],
  failed: [],
}

const CONTINUE_TTL_MS = 24 * 60 * 60 * 1000

export interface FakeRuntimeOptions {
  readonly now: () => number
  readonly s2: FakeS2 | undefined
  readonly heartbeatSeconds: number
  readonly leaseSeconds: number
  readonly s2Configured: boolean
  /** The bearer the device routes accept (shared with the fake API's state). */
  readonly credential: () => string | null
}

export interface FakeRuntimeCounters {
  online: number
  heartbeats: number
  offlines: number
  reconciles: number
  runClaims: number
  runReceipts: number
  commandClaims: number
  commandAcks: number
  subscriptions: number
  contexts: number
  runLists: number
  commandLists: number
  commandCreates: number
}

export class FakeRuntimeApi {
  readonly sessions: FakeSession[] = []
  readonly runs: FakeRun[] = []
  readonly commands: FakeCommand[] = []
  readonly counters: FakeRuntimeCounters = {
    online: 0, heartbeats: 0, offlines: 0, reconciles: 0, runClaims: 0, runReceipts: 0,
    commandClaims: 0, commandAcks: 0, subscriptions: 0, contexts: 0, runLists: 0, commandLists: 0, commandCreates: 0,
  }
  s2Configured: boolean
  /** Test switch: ack/status endpoints answer 503 (receipts pile up pending). */
  receiptsDown = false

  constructor(private readonly options: FakeRuntimeOptions) {
    this.s2Configured = options.s2Configured
  }

  private isoNow(): string {
    return new Date(this.options.now()).toISOString()
  }

  /* ─── test helpers (the web user, the automation trigger, the outbox) ─── */

  /** Create a queued run + its start command, delivered to the binding stream (06's outbox behavior). */
  queueRun(input: { prompt?: string; issueId?: string | null; trigger?: 'manual' | 'automation' } = {}): { runId: string; commandId: string } {
    const run: FakeRun = {
      runId: randomUUID(),
      workspaceId: '00000000-0000-7000-8000-00000000000a',
      projectId: '00000000-0000-7000-8000-00000000000c',
      bindingId: '00000000-0000-7000-8000-00000000000b',
      issueId: input.issueId ?? null,
      trigger: input.trigger ?? 'manual',
      status: 'queued',
      runVersion: 1,
      claimSessionId: null,
      claimEpoch: null,
      captureEpoch: null,
      prompt: input.prompt ?? 'Fake queued run prompt',
      cancelRequested: false,
      cancelReason: null,
      failureReason: null,
      queuedAt: this.isoNow(),
      startedAt: null,
      endedAt: null,
    }
    this.runs.push(run)
    const command = this.insertCommand(run, { kind: 'start', commandSeq: 1, prompt: null, expectedRunVersion: null, expiresAt: null })
    return { runId: run.runId, commandId: command.commandId }
  }

  /** The web user sends a supplement (target round pinned, 24h deadline). */
  sendContinue(runId: string, input: { prompt: string; expectedRunVersion: number; expiresAt?: string }): FakeCommand {
    const run = this.run(runId)
    const command = this.insertCommand(run, {
      kind: 'continue',
      commandSeq: this.nextCommandSeq(runId),
      prompt: input.prompt,
      expectedRunVersion: input.expectedRunVersion,
      expiresAt: input.expiresAt ?? new Date(this.options.now() + CONTINUE_TTL_MS).toISOString(),
    })
    return command
  }

  /** The web user (or unlink) requests the durable stop. */
  requestCancel(runId: string): FakeCommand {
    const run = this.run(runId)
    const existing = this.commands.filter((command) => command.runId === runId && command.kind === 'cancel').at(-1)
    if (run.cancelRequested && existing !== undefined) return existing
    run.cancelRequested = true
    run.cancelReason = 'The user requested to stop this run.'
    const command = this.insertCommand(run, { kind: 'cancel', commandSeq: this.nextCommandSeq(runId), prompt: null, expectedRunVersion: null, expiresAt: null })
    return command
  }

  /**
   * Test convenience: the run finishes its round (starting/running →
   * awaiting_review, the 10-style report) and the user confirms it
   * (→ succeeded), releasing the binding's execution slot for the next
   * queued run.
   */
  finishRun(runId: string): FakeRun {
    const run = this.run(runId)
    if (run.status === 'starting') this.transitionRun(run, 'running', null)
    if (run.status === 'running') this.transitionRun(run, 'awaiting_review', null)
    return this.confirmRun(runId)
  }

  /** The web user's explicit confirm (awaiting_review→succeeded, stopping→cancelled, needs_reconciliation→failed). */
  confirmRun(runId: string): FakeRun {
    const run = this.run(runId)
    if (TERMINAL.includes(run.status)) return run
    const outcome: AgentRunStatus | undefined =
      run.status === 'awaiting_review' ? 'succeeded' :
      run.status === 'stopping' ? 'cancelled' :
      run.status === 'needs_reconciliation' ? 'failed' : undefined
    if (outcome === undefined) throw new Error(`confirmRun: a run in '${run.status}' cannot be confirmed`)
    return this.transitionRun(run, outcome, null)
  }

  private insertCommand(run: FakeRun, input: { kind: 'start' | 'continue' | 'cancel'; commandSeq: number; prompt: string | null; expectedRunVersion: number | null; expiresAt: string | null }): FakeCommand {
    const command: FakeCommand = {
      commandId: randomUUID(),
      operationId: randomUUID(),
      runId: run.runId,
      bindingId: run.bindingId,
      commandSeq: input.commandSeq,
      kind: input.kind,
      status: 'pending',
      prompt: input.prompt,
      expectedRunVersion: input.expectedRunVersion,
      issuedBy: '00000000-0000-7000-8000-000000000001',
      issuedAt: this.isoNow(),
      expiresAt: input.expiresAt,
      claimSessionId: null,
      claimEpoch: null,
      receiptOutcome: null,
    }
    this.commands.push(command)
    // 08's deliverer: the durable intent commits, the S2 record follows.
    this.options.s2?.append(agentBindingCommandsStream(run.bindingId), JSON.stringify(this.commandDto(command)))
    return command
  }

  private nextCommandSeq(runId: string): number {
    return this.commands.filter((command) => command.runId === runId).length + 1
  }

  private run(runId: string): FakeRun {
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) throw new Error(`Fake runtime has no run ${runId}`)
    return run
  }

  runOfBinding(): FakeRun[] {
    return this.runs
  }

  /* ─── DTOs (the contract's exact shapes) ──────────────────────────────── */

  private runDto(run: FakeRun) {
    return {
      runId: run.runId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      bindingId: run.bindingId,
      issueId: run.issueId,
      trigger: run.trigger,
      status: run.status,
      runVersion: run.runVersion,
      claimEpoch: run.claimEpoch,
      captureEpoch: run.captureEpoch,
      paneId: null,
      agentName: null,
      prompt: run.prompt,
      cancelRequested: run.cancelRequested,
      cancelReason: run.cancelReason,
      failureReason: run.failureReason,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      retryOfRunId: null,
    }
  }

  private commandDto(command: FakeCommand) {
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.command',
      commandId: command.commandId,
      operationId: command.operationId,
      workspaceId: this.run(command.runId).workspaceId,
      projectId: this.run(command.runId).projectId,
      bindingId: command.bindingId,
      runId: command.runId,
      commandSeq: command.commandSeq,
      kind: command.kind,
      status: command.status,
      prompt: command.prompt,
      expectedRunVersion: command.expectedRunVersion,
      issuedBy: command.issuedBy,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      claim: command.claimEpoch === null ? null : { sessionId: command.claimSessionId, claimEpoch: command.claimEpoch },
    }
  }

  /* ─── routing (delegated from the fake API server) ────────────────────── */

  /** Handle one /api/agent/(sessions|runs|commands|subscriptions) request. */
  async route(request: Request, path: string): Promise<Response | undefined> {
    const method = request.method
    if (!/^\/api\/agent\/(sessions|runs|commands|subscriptions)/.test(path)) return undefined
    const auth = this.deviceAuth(request)
    if (auth !== undefined) return auth
    const body = async (): Promise<Record<string, unknown>> => {
      try {
        return (await request.json()) as Record<string, unknown>
      } catch {
        return {}
      }
    }

    if (method === 'POST' && path === '/api/agent/sessions') return this.online(await body())
    const sessionMatch = /^\/api\/agent\/sessions\/([^/]+)\/(heartbeat|offline|reconcile)$/.exec(path)
    if (method === 'POST' && sessionMatch !== null) {
      const session = this.liveSession(sessionMatch[1]!)
      if (session instanceof Response) return session
      if (sessionMatch[2] === 'heartbeat') return this.heartbeat(session, await body())
      if (sessionMatch[2] === 'offline') return this.offline(session)
      return this.reconcile(session, await body())
    }

    if (method === 'GET' && path === '/api/agent/runs') return this.listRuns(new URL(request.url))
    const getMatch = /^\/api\/agent\/runs\/([^/]+)$/.exec(path)
    if (method === 'GET' && getMatch !== null) {
      const run = this.runs.find(r => r.runId === getMatch[1])
      return run ? json(this.runDto(run)) : problem(404, 'not_found', 'Run not found.')
    }
    const contextMatch = /^\/api\/agent\/runs\/([^/]+)\/context$/.exec(path)
    if (method === 'GET' && contextMatch !== null) return this.runContext(contextMatch[1]!)
    const claimMatch = /^\/api\/agent\/runs\/([^/]+)\/claim$/.exec(path)
    if (method === 'POST' && claimMatch !== null) return this.claimRun(claimMatch[1]!, await body())
    const statusMatch = /^\/api\/agent\/runs\/([^/]+)\/status$/.exec(path)
    if (method === 'POST' && statusMatch !== null) return this.runReceipt(statusMatch[1]!, await body())
    const commandsMatch = /^\/api\/agent\/runs\/([^/]+)\/commands$/.exec(path)
    if (commandsMatch !== null) {
      if (method === 'GET') return this.listCommands(commandsMatch[1]!)
      if (method === 'POST') return this.createCommand(commandsMatch[1]!, await body())
    }
    const commandClaimMatch = /^\/api\/agent\/commands\/([^/]+)\/claim$/.exec(path)
    if (method === 'POST' && commandClaimMatch !== null) return this.claimCommand(commandClaimMatch[1]!, await body())
    const commandAckMatch = /^\/api\/agent\/commands\/([^/]+)\/ack$/.exec(path)
    if (method === 'POST' && commandAckMatch !== null) return this.ackCommand(commandAckMatch[1]!, await body())

    if (method === 'POST' && path === '/api/agent/subscriptions') return this.subscriptions(await body())
    return problem(404, 'not_found', `No fake route for ${method} ${path}`)
  }

  private deviceAuth(request: Request): Response | undefined {
    const authorization = request.headers.get('authorization')
    if (authorization === null) return problem(401, 'unauthenticated', 'Sign in first.')
    const expected = this.options.credential()
    if (expected !== null && authorization !== `Bearer ${expected}`) {
      return problem(401, 'unauthenticated', 'This device credential is missing, revoked, or no longer has access to its project. Run vikan link to pair again.')
    }
    return undefined
  }

  private liveSession(sessionId: string): FakeSession | Response {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId)
    if (session === undefined) return problem(404, 'not_found', 'Runner session not found.')
    if (session.endedAt !== null) {
      return problem(403, 'forbidden', 'This runner session has ended — it was superseded by a newer one or went offline. Start a new session before executing.')
    }
    return session
  }

  /* ─── handlers ─────────────────────────────────────────────────────────── */

  private online(input: Record<string, unknown>): Response {
    this.counters.online += 1
    if (input.bindingId !== '00000000-0000-7000-8000-00000000000b') return problem(404, 'not_found', 'Binding not found.')
    if (input.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      return problem(400, 'protocol_version_unsupported', `This server speaks agent protocol ${AGENT_PROTOCOL_VERSION}; the CLI offered ${String(input.protocolVersion)}. Upgrade the CLI.`)
    }
    const bindingId = String(input.bindingId)
    const epoch = Math.max(0, ...this.sessions.filter((session) => session.bindingId === bindingId).map((session) => session.epoch)) + 1
    const now = this.options.now()
    for (const session of this.sessions) {
      if (session.bindingId === bindingId && session.endedAt === null) session.endedAt = new Date(now).toISOString()
    }
    const session: FakeSession = {
      sessionId: randomUUID(),
      bindingId,
      epoch,
      endedAt: null,
      leaseExpiresAt: new Date(now + this.options.leaseSeconds * 1000).toISOString(),
      s2Connected: false,
    }
    this.sessions.push(session)
    return json({
      sessionId: session.sessionId,
      epoch,
      heartbeatIntervalSeconds: this.options.heartbeatSeconds,
      leaseExpiresAt: session.leaseExpiresAt,
      connectionState: this.s2Configured ? 'online' : 'degraded',
    }, 201)
  }

  private heartbeat(session: FakeSession, input: Record<string, unknown>): Response {
    this.counters.heartbeats += 1
    session.s2Connected = input.s2Connected === true
    session.leaseExpiresAt = new Date(this.options.now() + this.options.leaseSeconds * 1000).toISOString()
    return json({ leaseExpiresAt: session.leaseExpiresAt })
  }

  private offline(session: FakeSession): Response {
    this.counters.offlines += 1
    if (session.endedAt === null) session.endedAt = this.isoNow()
    return json({ offline: true })
  }

  private reconcile(session: FakeSession, input: Record<string, unknown>): Response {
    this.counters.reconciles += 1
    const reported = new Map(
      (Array.isArray(input.activeRuns) ? input.activeRuns : []).map((entry) => {
        const record = entry as { runId?: unknown; paneId?: unknown; agentName?: unknown; phase?: unknown }
        return [String(record.runId), record.phase]
      }),
    )
    const decisions: Array<{ runId: string; action: 'resume' | 'stop' | 'needs_reconciliation'; runVersion: number }> = []
    const slotRuns = this.runs
      .filter((run) => run.bindingId === session.bindingId && SLOT_STATUSES.includes(run.status))
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
    for (const run of slotRuns) {
      const phase = reported.get(run.runId)
      if (run.status === 'needs_reconciliation') {
        decisions.push({ runId: run.runId, action: 'needs_reconciliation', runVersion: run.runVersion })
        continue
      }
      if (phase === undefined) {
        this.transitionRun(run, 'needs_reconciliation', 'The runner restarted and no longer reports this run; its actual state cannot be determined.')
        decisions.push({ runId: run.runId, action: 'needs_reconciliation', runVersion: run.runVersion })
        continue
      }
      if (phase === 'prompt_dispatching' || phase === 'unknown') {
        this.transitionRun(run, 'needs_reconciliation', 'The prompt dispatch could not be confirmed after the restart; inspect the pane before resuming.')
        decisions.push({ runId: run.runId, action: 'needs_reconciliation', runVersion: run.runVersion })
        continue
      }
      if (run.status === 'stopping' && (phase === 'prepared' || phase === 'pane_created')) {
        this.transitionRun(run, 'cancelled', 'The stop was confirmed: no prompt was ever dispatched for this run.')
        decisions.push({ runId: run.runId, action: 'stop', runVersion: run.runVersion })
        continue
      }
      if (run.claimSessionId === session.sessionId && run.claimEpoch === session.epoch) {
        decisions.push({ runId: run.runId, action: 'resume', runVersion: run.runVersion })
        continue
      }
      this.reStampRunClaim(run, session)
      decisions.push({ runId: run.runId, action: 'resume', runVersion: run.runVersion })
    }
    return json({ decisions })
  }

  private listRuns(url: URL): Response {
    this.counters.runLists += 1
    const bindingId = url.searchParams.get('bindingId')
    const runs = this.runs
      .filter((run) => bindingId === null || run.bindingId === bindingId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
    return json({ runs: runs.map((run) => this.runDto(run)) })
  }

  private runContext(runId: string): Response {
    this.counters.contexts += 1
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) return problem(404, 'not_found', 'Run not found.')
    return json({
      runId: run.runId,
      prompt: run.prompt,
      project: {
        id: run.projectId,
        workspaceId: run.workspaceId,
        name: 'Fake Project',
      },
      issue: run.issueId === null ? null : {
        id: run.issueId,
        identifier: 'FAKE-1',
        title: 'A fake issue for the run',
        descriptionText: 'The saved issue body, server-rendered.',
        comments: [],
      },
    })
  }

  private claimRun(runId: string, input: Record<string, unknown>): Response {
    this.counters.runClaims += 1
    const session = this.liveSession(String(input.sessionId ?? ''))
    if (session instanceof Response) return session
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) return problem(404, 'not_found', 'Run not found.')

    if (run.status !== 'queued') {
      if (NON_TERMINAL.includes(run.status) && run.claimSessionId === session.sessionId && run.claimEpoch === session.epoch && run.captureEpoch !== null) {
        return json({ runId: run.runId, claimEpoch: run.claimEpoch, runVersion: run.runVersion, captureEpoch: run.captureEpoch })
      }
      if (TERMINAL.includes(run.status)) return problem(410, 'command_expired', 'This run already ended; it cannot start.')
      return problem(409, 'run_slot_conflict', 'Another session holds this binding’s execution slot.')
    }
    if (run.cancelRequested) {
      this.transitionRun(run, 'cancelled', run.cancelReason ?? 'A stop was requested before this run could start.')
      return problem(409, 'run_invalidated', `This queued run will not start: ${run.cancelReason ?? 'a stop was requested'}`)
    }
    const slotHolder = this.runs.find((candidate) => candidate !== run && candidate.bindingId === run.bindingId && SLOT_STATUSES.includes(candidate.status))
    if (slotHolder !== undefined) {
      return problem(409, 'run_slot_conflict', 'This binding already has an active run; this queued run waits in line.')
    }
    run.status = 'starting'
    run.runVersion += 1
    run.claimSessionId = session.sessionId
    run.claimEpoch = session.epoch
    run.captureEpoch = `cap-${randomUUID().replaceAll('-', '').slice(0, 24)}`
    run.startedAt = this.isoNow()
    return json({ runId: run.runId, claimEpoch: session.epoch, runVersion: run.runVersion, captureEpoch: run.captureEpoch })
  }

  private runReceipt(runId: string, input: Record<string, unknown>): Response {
    this.counters.runReceipts += 1
    if (this.receiptsDown) return problem(500, 'internal', 'The receipt endpoint is down (test).')
    const session = this.liveSession(String(input.sessionId ?? ''))
    if (session instanceof Response) return session
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) return problem(404, 'not_found', 'Run not found.')
    if (run.claimSessionId !== session.sessionId || run.claimEpoch !== session.epoch || input.claimEpoch !== run.claimEpoch) {
      return problem(409, 'stale_version', 'This run was re-claimed by a newer session; reload its current state.')
    }
    const status = String(input.status) as AgentRunStatus
    if (status === run.status) return json({ runId: run.runId, runVersion: run.runVersion, status: run.status })
    if (input.expectedRunVersion !== run.runVersion) {
      return problem(409, 'stale_version', 'The run changed since this receipt was made; reload and re-evaluate.')
    }
    if (!RECEIPT_TRANSITIONS[run.status]!.includes(status)) {
      return problem(403, 'forbidden', `A run in '${run.status}' cannot move to '${status}' by runner receipt.`)
    }
    const updated = this.transitionRun(run, status, input.reason === undefined ? null : String(input.reason))
    return json({ runId: updated.runId, runVersion: updated.runVersion, status: updated.status })
  }

  private createCommand(runId: string, input: Record<string, unknown>): Response {
    this.counters.commandCreates += 1
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) return problem(404, 'not_found', 'Run not found.')
    if (input.kind === 'cancel') {
      if (TERMINAL.includes(run.status)) return problem(403, 'forbidden', 'This run already ended; there is nothing to stop.')
      const command = this.requestCancel(run.runId)
      return json(this.commandDto(command), 201)
    }
    if (TERMINAL.includes(run.status)) return problem(410, 'command_expired', 'This run already ended; a supplement can no longer be delivered.')
    if (input.expectedRunVersion !== run.runVersion) {
      return problem(409, 'stale_version', 'The run changed since this supplement was written; reload and retry.')
    }
    const command = this.insertCommand(run, {
      kind: 'continue',
      commandSeq: this.nextCommandSeq(run.runId),
      prompt: String(input.prompt ?? ''),
      expectedRunVersion: input.expectedRunVersion === undefined ? null : Number(input.expectedRunVersion),
      expiresAt: new Date(this.options.now() + CONTINUE_TTL_MS).toISOString(),
    })
    return json(this.commandDto(command), 201)
  }

  private listCommands(runId: string): Response {
    this.counters.commandLists += 1
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) return problem(404, 'not_found', 'Run not found.')
    const commands = this.commands.filter((command) => command.runId === runId).sort((a, b) => a.commandSeq - b.commandSeq)
    return json({ commands: commands.map((command) => this.commandDto(command)) })
  }

  private claimCommand(commandId: string, input: Record<string, unknown>): Response {
    this.counters.commandClaims += 1
    const session = this.liveSession(String(input.sessionId ?? ''))
    if (session instanceof Response) return session
    const command = this.commands.find((candidate) => candidate.commandId === commandId)
    if (command === undefined) return problem(404, 'not_found', 'Command not found.')
    if (command.claimSessionId === session.sessionId && command.claimEpoch === session.epoch) {
      return json(this.commandDto(command))
    }
    if (command.status === 'acked' || command.status === 'rejected' || command.status === 'expired') {
      return problem(410, 'command_expired', 'This command is no longer claimable.')
    }
    if (command.expiresAt !== null && Date.parse(command.expiresAt) <= this.options.now()) {
      command.status = 'expired'
      return problem(410, 'command_expired', 'This command’s deadline passed; it is not delivered.')
    }
    const run = this.runs.find((candidate) => candidate.runId === command.runId)!
    if (run === undefined || TERMINAL.includes(run.status)) {
      return problem(410, 'command_expired', 'This run already ended; its commands are no longer deliverable.')
    }
    if (run.claimSessionId !== session.sessionId || run.claimEpoch !== session.epoch) {
      return problem(403, 'forbidden', 'Claim the run with this session before taking its commands.')
    }
    if (run.cancelRequested && command.kind !== 'cancel') {
      return problem(410, 'command_expired', 'A stop is pending on this run; this command is no longer deliverable.')
    }
    command.status = 'claimed'
    command.claimSessionId = session.sessionId
    command.claimEpoch = session.epoch
    return json(this.commandDto(command))
  }

  private ackCommand(commandId: string, input: Record<string, unknown>): Response {
    this.counters.commandAcks += 1
    if (this.receiptsDown) return problem(500, 'internal', 'The ack endpoint is down (test).')
    const session = this.liveSession(String(input.sessionId ?? ''))
    if (session instanceof Response) return session
    const command = this.commands.find((candidate) => candidate.commandId === commandId)
    if (command === undefined) return problem(404, 'not_found', 'Command not found.')
    if (command.claimEpoch !== null) {
      if (command.claimSessionId !== session.sessionId || input.claimEpoch !== command.claimEpoch) {
        return problem(409, 'stale_version', 'This command was re-claimed by a newer session; its receipt is refused.')
      }
    } else if (input.claimEpoch !== session.epoch) {
      return problem(409, 'stale_version', 'This receipt does not match the session’s claim epoch.')
    }
    if (command.status === 'acked' || command.status === 'rejected') {
      return json({ commandId: command.commandId, accepted: true })
    }
    if (command.status === 'expired') {
      return problem(410, 'command_expired', 'This command expired before its receipt arrived.')
    }
    command.status = input.outcome === 'rejected' ? 'rejected' : 'acked'
    command.receiptOutcome = String(input.outcome ?? '')
    if (command.claimSessionId === null) command.claimSessionId = session.sessionId
    if (command.claimEpoch === null) command.claimEpoch = session.epoch
    return json({ commandId: command.commandId, accepted: true })
  }

  private subscriptions(input: Record<string, unknown>): Response {
    this.counters.subscriptions += 1
    if (!this.s2Configured) return problem(503, 'agent_unconfigured', 'S2 delivery is not configured on this deployment.')
    if (input.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      return problem(400, 'protocol_version_unsupported', `This server speaks agent protocol ${AGENT_PROTOCOL_VERSION}; the client offered ${String(input.protocolVersion)}. Upgrade instead of executing unknown records.`)
    }
    const scopes = Array.isArray(input.scopes) ? input.scopes : []
    const subscriptions = []
    for (const scope of scopes) {
      const entry = scope as Record<string, unknown>
      if (entry.kind !== 'binding-commands' && entry.kind !== 'run-screens') {
        return problem(404, 'not_found', 'Scope not found.')
      }
      if (input.sessionId !== undefined) {
        const session = this.liveSession(String(input.sessionId))
        if (session instanceof Response) return session
      }
      const run = entry.kind === 'run-screens' ? this.runs.find(run => run.runId === entry.runId) : undefined
      const bindingId = run?.bindingId ?? String(entry.bindingId)
      if (bindingId !== '00000000-0000-7000-8000-00000000000b') return problem(404, 'not_found', 'Binding not found.')
      if (run && !run.captureEpoch) {
        subscriptions.push({ status: 'screens-pending', kind: 'run-screens', runId: run.runId, captureEpoch: null,
          screenState: TERMINAL.includes(run.status) ? 'expired' : 'awaiting-frame' })
        continue
      }
      const stream = run ? agentRunScreensStream(run.runId, run.captureEpoch!) : agentBindingCommandsStream(bindingId)
      const token = this.options.s2 === undefined ? 'fake-token' : this.options.s2.grantToken(stream)
      subscriptions.push({
        status: 'active',
        kind: entry.kind,
        stream,
        basin: 'fake-basin',
        token,
        tokenExpiresAt: new Date(this.options.now() + 60 * 60 * 1000).toISOString(),
        operations: run ? ['read', 'append', 'check-tail'] : ['read', 'check-tail'],
        nextSeqNum: this.options.s2 === undefined ? '0' : this.options.s2.tail(stream),
        onGap: 'refetch-authority',
        captureEpoch: run?.captureEpoch ?? null,
        screenState: run ? (this.options.s2?.bodiesOf(stream).length ? 'live' : 'awaiting-frame') : null,
      })
    }
    return json({ subscriptions })
  }

  /* ─── transitions ──────────────────────────────────────────────────────── */

  private transitionRun(run: FakeRun, status: AgentRunStatus, reason: string | null): FakeRun {
    run.status = status
    run.runVersion += 1
    if (TERMINAL.includes(status)) run.endedAt = this.isoNow()
    if (status === 'failed') run.failureReason = reason
    if (run.startedAt === null && (status === 'running' || status === 'starting')) run.startedAt = this.isoNow()
    return run
  }

  private reStampRunClaim(run: FakeRun, session: FakeSession): void {
    run.claimSessionId = session.sessionId
    run.claimEpoch = session.epoch
    run.runVersion += 1
  }
}
