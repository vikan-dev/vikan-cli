import { AGENT_RUN_NON_TERMINAL_STATUSES } from '@vikan/sdk/agent'
import { apiFailure, type VikanApiClient, type SessionReconcileInput } from '../api/client.ts'
import type { RunnerJournal, RunnerRunEntry } from '../state/journal.ts'
import { agentNameForRun, type AgentAdapter, type AgentTarget } from './adapter.ts'
import { isSimulatedCrash } from './crash.ts'

export function targetOfRun(run: RunnerRunEntry, herdrSessionId: string): AgentTarget {
  return { runId: run.runId, paneId: run.paneId, agentName: run.agentName ?? agentNameForRun(run.runId),
    occupantId: run.occupantId, herdrSessionId: run.herdrSessionId ?? herdrSessionId }
}
export function journalActiveRuns(journal: RunnerJournal): RunnerRunEntry[] {
  return [...journal.view().runs.values()].filter(r => r.uncertain || (AGENT_RUN_NON_TERMINAL_STATUSES as readonly string[]).includes(r.status))
}

/** Verify actual targets before reporting phases to PG. A stored acknowledgement
 * proves delivery, not that a pane still hosts the same Codex after a restart. */
export async function reconcileJournal(deps: {
  api: VikanApiClient; journal: RunnerJournal; adapter: AgentAdapter;
  sessionId: string; sessionEpoch: number; herdrSessionId: string;
  log: (text: string) => void; sleep: (ms: number) => Promise<void>;
  stopped: () => boolean; onApiError: (error: unknown) => void; retryMs?: number;
}): Promise<void> {
  while (!deps.stopped()) {
    const activeRuns: SessionReconcileInput['activeRuns'] = []
    for (const run of journalActiveRuns(deps.journal)) {
      if (run.status === 'queued' && !run.effect && !run.paneId) continue
      let phase: SessionReconcileInput['activeRuns'][number]['phase'] = deps.journal.view().runPhases.get(run.runId) ?? 'unknown'
      try {
        const target = await deps.adapter.verifyTarget(targetOfRun(run, deps.herdrSessionId))
        if ('paneId' in target) deps.journal.recordRun({ runId: run.runId, paneId: target.paneId,
          ...('occupantId' in target ? { occupantId: target.occupantId } : {}) })
        if (target.status === 'gone' || target.status === 'unknown' || target.status === 'stopped' || run.uncertain ||
          (target.status === 'pane-only' && (run.effect === 'start-agent' || !['prepared', 'pane_created'].includes(phase))) || run.effect === 'interrupt') phase = 'unknown'
      } catch (error) {
        if (isSimulatedCrash(error)) throw error
        phase = 'unknown'
      }
      if (phase === 'prompt_dispatching' || phase === 'unknown') deps.journal.recordRun({ runId: run.runId, uncertain: true, status: 'needs_reconciliation' })
      const latest = deps.journal.view().runs.get(run.runId)!
      // No invented pane IDs: unobserved targets are omitted, which asks PG
      // to retain the slot as needs_reconciliation.
      if (latest.paneId) activeRuns.push({ runId: run.runId, paneId: latest.paneId,
        agentName: latest.agentName ?? agentNameForRun(run.runId), phase })
    }
    if (activeRuns.length > 50) throw new Error('Too many recovery targets; no evidence may be silently truncated.')
    if (deps.stopped()) return
    try {
      const before = new Map(deps.journal.view().runs)
      const response = await deps.api.reconcileRunnerSession(deps.sessionId, { activeRuns })
      for (const decision of response.decisions) {
        if (decision.action === 'resume') {
          deps.journal.recordRun({ runId: decision.runId, claimEpoch: deps.sessionEpoch, sessionId: deps.sessionId, runVersion: decision.runVersion })
          const prior = before.get(decision.runId)
          // Reconciliation itself increments the version without changing the
          // round. Carry a proven pending prompt receipt across exactly that
          // increment; never refresh an arbitrary stale receipt to "latest".
          if (prior && !prior.uncertain && decision.runVersion === prior.runVersion + 1 &&
            activeRuns.find(r => r.runId === decision.runId)?.phase === 'prompt_acknowledged') {
            for (const receipt of deps.journal.view().receipts) {
              const payload = receipt.payload
              if (receipt.state === 'pending' && payload.kind === 'run-status' && payload.runId === decision.runId &&
                payload.status === 'running' && (receipt.request?.expectedRunVersion ?? payload.expectedRunVersion) === prior.runVersion) {
                deps.journal.recordReceiptRequest(receipt.receiptId, { sessionId: deps.sessionId,
                  claimEpoch: deps.sessionEpoch, expectedRunVersion: decision.runVersion })
              }
            }
          }
        } else if (decision.action === 'stop') {
          deps.journal.recordRun({ runId: decision.runId, status: 'cancelled', runVersion: decision.runVersion })
        } else {
          deps.journal.recordRun({ runId: decision.runId, status: 'needs_reconciliation', uncertain: true, runVersion: decision.runVersion })
        }
        deps.log(`Recovery ${decision.runId}: ${decision.action}.`)
      }
      return
    } catch (error) {
      if (isSimulatedCrash(error)) throw error
      deps.onApiError(error)
      const failure = apiFailure(error)
      if (failure.kind === 'problem' && failure.status < 500 && failure.status !== 429) throw error
      deps.log('offline — recovery is waiting for the API; no new work starts.')
      await deps.sleep(deps.retryMs ?? 2000)
    }
  }
}

/** Revocation is an explicit stop intent, independent of API availability.
 * Never infer stopped from a timeout, or target an unverified occupant. */
export async function interruptOwnedRuns(deps: {
  journal: RunnerJournal; adapter: AgentAdapter; herdrSessionId: string; log: (text: string) => void;
}): Promise<void> {
  for (const run of journalActiveRuns(deps.journal)) {
    if (!run.agentName) continue
    try {
      const target = targetOfRun(run, deps.herdrSessionId)
      const observed = await deps.adapter.verifyTarget(target)
      if (observed.status !== 'agent-ready' && observed.status !== 'agent-working' && observed.status !== 'blocked') continue
      deps.journal.recordRun({ runId: run.runId, uncertain: true, effect: 'interrupt', cancelRequested: true })
      await deps.adapter.interrupt({ ...target, paneId: observed.paneId, occupantId: observed.occupantId })
      deps.journal.recordRun({ runId: run.runId, status: 'stopping', effect: null })
      deps.log(`Interrupt issued for ${run.runId}; stop unconfirmed, recovery files retained.`)
    } catch (error) {
      if (isSimulatedCrash(error)) throw error
      deps.journal.recordRun({ runId: run.runId, uncertain: true, status: 'needs_reconciliation' })
      deps.log(`Stop for ${run.runId} could not be confirmed; recovery files retained.`)
    }
  }
}
