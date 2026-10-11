import { createVikanApiClient, apiFailure, apiFailureMessage } from '../api/client.ts'
import { AGENT_RUN_NON_TERMINAL_STATUSES } from '@vikan/sdk/agent'
import { EXIT_FAILURE, EXIT_OK } from '../exit.ts'
import { findBindingRecordsForPath, loadCredentialRecord, resolveDirectoryIdentity, saveBindingRecord, type BindingRecord } from '../state/binding.ts'
import { journalActiveRuns } from '../runner/reconcile.ts'
import { RunnerJournal } from '../state/journal.ts'
import type { CliDeps } from './types.ts'

/**
 * `vikan status` (plan §5.2, todo 09 T3): show the current binding, the
 * server-confirmed state, the current run and the local journal's pending
 * receipts. Read-only: it never requires Herdr, never starts anything, and
 * when the server cannot be reached it says so instead of guessing —
 * "last confirmed" is a fact about a successful server answer, not about a
 * timeout.
 */
export async function runStatusCommand(deps: CliDeps): Promise<number> {
  const directory = resolveDirectoryIdentity(deps.cwd(), deps.exec)
  const bindings = findBindingRecordsForPath(deps.configDir, directory.key)

  if (bindings.length === 0) {
    deps.io.err('This directory is not linked to a vikan project. Run `vikan link` inside a Herdr pane to pair it.\n')
    return EXIT_FAILURE
  }

  const detection = deps.detectHerdr()
  const herdrLine = detection.ok
    ? `  herdr     pane ${detection.info.paneId}${detection.info.sessionName === null ? '' : `, session ${detection.info.sessionName}`}`
    : '  herdr     not in a Herdr session'

  for (const binding of bindings) {
    printBinding(deps, binding, herdrLine)
    const credential = loadCredentialRecord(deps.configDir, binding)
    if (credential === undefined) {
      deps.io.out('  server    not confirmed — the local credential for this binding is missing\n')
      continue
    }
    const api = createVikanApiClient({ apiOrigin: binding.apiOrigin, fetch: deps.fetch, credential: credential.credential })
    try {
      const { bindings: serverBindings } = await api.listBindings()
      const serverBinding = serverBindings.find((candidate) => candidate.bindingId === binding.bindingId)
      if (serverBinding === undefined) {
        deps.io.out('  server    not confirmed — the server no longer knows this binding; run `vikan link` to pair again\n')
        continue
      }
      saveBindingRecord(deps.configDir, { ...binding, lastConfirmedAt: new Date(deps.now()).toISOString() })
      deps.io.out(
        serverBinding.status === 'active'
          ? `  server    confirmed — binding active, connection ${serverBinding.connectionState}\n`
          : '  server    confirmed — binding REVOKED server-side; run `vikan link` to pair again\n',
      )
      await printRuns(deps, api, binding)
    } catch (error) {
      const failure = apiFailure(error)
      const reason = failure.kind === 'network' || failure.kind === 'timeout' ? 'unreachable' : 'refused the request'
      deps.io.out(`  server    ${reason} — last confirmed ${formatConfirmedAt(binding.lastConfirmedAt, deps.now())} (${apiFailureMessage(failure)})\n`)
      const journal = RunnerJournal.open(deps.configDir, binding)
      for (const run of journalActiveRuns(journal)) deps.io.out(`  local run ${run.runId} ${run.uncertain ? 'needs_reconciliation' : run.status} (last known; execution may continue)\n`)
      deps.io.out(`  journal   ${journal.view().receipts.filter(r => r.state === 'pending').length} pending receipts\n`)
    }
  }

  if (bindings.length > 1) {
    deps.io.out('Multiple bindings match this directory; `vikan` refuses to connect until only one remains.\n')
  }
  return EXIT_OK
}

/** The current run line: the server's non-terminal runs, or the journal's local view. */
async function printRuns(deps: CliDeps, api: ReturnType<typeof createVikanApiClient>, binding: BindingRecord): Promise<void> {
  const journal = RunnerJournal.open(deps.configDir, binding)
  const pending = journal.view().receipts.filter((record) => record.state === 'pending')
  try {
    const { runs } = await api.listRuns({ bindingId: binding.bindingId })
    const active = runs.filter((run) => (AGENT_RUN_NON_TERMINAL_STATUSES as readonly string[]).includes(run.status))
    if (active.length === 0) {
      deps.io.out('  runs      none\n')
    } else {
      for (const run of active) {
        deps.io.out(`  runs      ${run.runId} ${run.status} (version ${run.runVersion}, epoch ${run.claimEpoch ?? '-'})\n`)
      }
    }
  } catch {
    deps.io.out('  runs      unknown — the server run list is unreachable\n')
  }
  deps.io.out(pending.length === 0 ? '  journal   no pending receipts\n' : `  journal   ${pending.length} pending receipt${pending.length === 1 ? '' : 's'} to report\n`)
}

function printBinding(deps: CliDeps, binding: BindingRecord, herdrLine: string): void {
  deps.io.out(
    [
      `vikan status — ${binding.directoryLabel} at ${binding.path}`,
      `  api       ${binding.apiOrigin}`,
      `  binding   ${binding.bindingId} (claimed ${binding.claimedAt})`,
      `  project   ${binding.projectId}`,
      `  workspace ${binding.workspaceId}`,
      `  user      ${binding.userId}`,
      `  device    ${binding.deviceId}`,
      herdrLine,
      '',
    ].join('\n'),
  )
}

function formatConfirmedAt(lastConfirmedAt: string | null, now: number): string {
  if (lastConfirmedAt === null) return 'never'
  const minutes = Math.max(0, Math.round((now - Date.parse(lastConfirmedAt)) / 60_000))
  if (minutes < 1) return 'just now'
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
}
