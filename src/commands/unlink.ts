import { realpathSync } from 'node:fs'
import { acquireDirectoryLock, directoryStateRoot } from '../state/directory-lock.ts'
import { RunnerJournal } from '../state/journal.ts'
import { journalActiveRuns } from '../runner/reconcile.ts'
import { randomUUID } from 'node:crypto'
import { AGENT_RUN_NON_TERMINAL_STATUSES } from '@vikan/sdk/agent'
import { createVikanApiClient, apiFailure, apiFailureMessage } from '../api/client.ts'
import { EXIT_FAILURE, EXIT_OK } from '../exit.ts'
import {
  findBindingRecordsForPath,
  loadCredentialRecord,
  originDir,
  removeBindingState,
  resolveDirectoryIdentity,
  type BindingRecord,
} from '../state/binding.ts'
import type { CliDeps } from './types.ts'

/**
 * `vikan unlink` (plan §5.2, todo 09 T3): revoke this directory's binding
 * and clean the local link — with the stop-and-confirm flow now wired:
 *
 *   * an ACTIVE run engages a durable stop request per run (the server keeps
 *     the expectation until fulfilled — it never expires), and NOTHING is
 *     revoked or deleted: the journal is the recovery evidence, and the runs
 *     must reach a terminal state — the online runner confirming the stop —
 *     before unlink can complete. The stop's outcome is never claimed here;
 *   * a plain network failure is NOT a revocation: the local state is kept
 *     and the user is told to retry — only an explicit server receipt (or a
 *     server-side refusal proving the binding is already dead) clears
 *     local state.
 */
export async function runUnlinkCommand(deps: CliDeps): Promise<number> {
  const directory = resolveDirectoryIdentity(deps.cwd(), deps.exec)
  const bindings = findBindingRecordsForPath(deps.configDir, directory.key)

  if (bindings.length === 0) {
    deps.io.out('This directory is not linked; nothing to unlink.\n')
    return EXIT_OK
  }
  if (bindings.length > 1) {
    deps.io.err(
      `vikan unlink: this directory is linked ${bindings.length} times:\n${bindings.map((binding) => `  ${binding.apiOrigin} as ${binding.userId} (${binding.bindingId})`).join('\n')}\nUnlink is ambiguous — revoke the extras from the web Agent page first.\n`,
    )
    return EXIT_FAILURE
  }
  const binding = bindings[0]!

  // Recovery evidence check BEFORE anything destructive.
  const active = await activeRunsOf(deps, binding)
  if (active === undefined) {
    deps.io.err('vikan unlink: the API could not confirm activity — the binding is NOT revoked and local state is kept. Retry when the API is reachable.\n')
    return EXIT_FAILURE
  }
  if (active.length > 0) {
    return await engageStopAndWait(deps, binding, active)
  }

  const credential = loadCredentialRecord(deps.configDir, binding)
  if (credential === undefined) {
    deps.io.err(
      `vikan unlink: the local credential for this binding is missing, so the revocation cannot be signed.\nRevoke the binding from the vikan web Agent page, then remove the state under:\n  ${originDir(deps.configDir, binding.apiOrigin)}\n`,
    )
    return EXIT_FAILURE
  }

  const locked = acquireDirectoryLock(deps.directoryStateRoot ?? directoryStateRoot(), binding.path)
  if (!locked.ok) {
    deps.io.err('vikan unlink: the manager is still online. Stop it before removing recovery state.\n')
    return EXIT_FAILURE
  }
  const api = createVikanApiClient({ apiOrigin: binding.apiOrigin, fetch: deps.fetch, credential: credential.credential })
  try {
    locked.lock.bindRecovery({ configRoot: realpathSync(deps.configDir), apiOrigin: binding.apiOrigin, userId: binding.userId, bindingId: binding.bindingId })
    const remaining = await activeRunsOf(deps, binding)
    if (remaining === undefined) { deps.io.err('vikan unlink: activity is unconfirmed; local state is kept.\n'); return EXIT_FAILURE }
    if (remaining.length > 0) return await engageStopAndWait(deps, binding, remaining)
    if (RunnerJournal.open(deps.configDir, binding).view().receipts.some(r => r.state === 'pending')) {
      deps.io.err('vikan unlink: pending receipts must be recovered before local state can be removed.\n')
      return EXIT_FAILURE
    }
    await api.revokeBinding(binding.bindingId)
    locked.lock.clearRecovery()
    removeBindingState(deps.configDir, binding)
  } catch (error) {
    const failure = apiFailure(error)
    if (failure.kind === 'network' || failure.kind === 'timeout') {
      deps.io.err(
        'vikan unlink: the API could not be reached — the binding is NOT revoked and local state is kept.\nRun `vikan unlink` again when the API is reachable.\n',
      )
      return EXIT_FAILURE
    }
    if (failure.kind === 'problem' && (failure.code === 'unauthenticated' || failure.code === 'not_found')) {
      locked.lock.clearRecovery()
      removeBindingState(deps.configDir, binding)
      deps.io.out('vikan unlink: this binding is already gone server-side; the local state was removed.\n')
      return EXIT_OK
    }
    deps.io.err(`vikan unlink: ${apiFailureMessage(failure)}\nLocal state is kept.\n`)
    return EXIT_FAILURE
  } finally { locked.lock.release() }

  deps.io.out(
    `Unlinked ${binding.directoryLabel}: binding ${binding.bindingId} is revoked and the local credential is removed.\n`,
  )
  return EXIT_OK
}

/**
 * The server's run list is authority; the local journal is the offline
 * fallback — either view keeps unlink honest when the other is unavailable.
 */
async function activeRunsOf(deps: CliDeps, binding: BindingRecord): Promise<string[] | undefined> {
  const journalActive = journalActiveRuns(RunnerJournal.open(deps.configDir, binding)).map(run => run.runId)
  const credential = loadCredentialRecord(deps.configDir, binding)
  if (credential === undefined) return journalActive
  const api = createVikanApiClient({ apiOrigin: binding.apiOrigin, fetch: deps.fetch, credential: credential.credential })
  try {
    const { runs } = await api.listRuns({ bindingId: binding.bindingId })
    return [...new Set([...journalActive, ...runs
      .filter((run) => (AGENT_RUN_NON_TERMINAL_STATUSES as readonly string[]).includes(run.status))
      .map((run) => run.runId)])]
  } catch (error) {
    if (journalActive.length) return journalActive
    const failure = apiFailure(error)
    if (failure.kind === 'problem' && (failure.code === 'unauthenticated' || failure.code === 'not_found')) return []
    return undefined
  }
}

/** Request the durable stop for every active run; keep everything for recovery. */
async function engageStopAndWait(deps: CliDeps, binding: BindingRecord, runIds: string[]): Promise<number> {
  const credential = loadCredentialRecord(deps.configDir, binding)
  if (credential !== undefined) {
    const api = createVikanApiClient({ apiOrigin: binding.apiOrigin, fetch: deps.fetch, credential: credential.credential })
    for (const runId of runIds) {
      try {
        await api.createRunCommand(runId, { operationId: randomUUID(), kind: 'cancel' })
      } catch (error) {
        const failure = apiFailure(error)
        deps.io.out(`  stop request for run ${runId}: ${apiFailureMessage(failure)} (the durable intent stands if the server holds it)\n`)
        continue
      }
      deps.io.out(`  stop requested for run ${runId} — the runner must confirm the stop\n`)
    }
  }
  deps.io.err(
    `vikan unlink: this directory has ${runIds.length} unfinished vikan run${runIds.length === 1 ? '' : 's'} (${runIds.join(', ')}).\n` +
    'Stop requests remain pending confirmation — the online runner interrupts them and reports the result; a stop is only\n' +
    'certain when the run reaches a terminal state. Until then NOTHING is revoked or deleted: the binding,\n' +
    'credential and run journal are kept so the runs can still be stopped and recovered. Run `vikan unlink`\n' +
    'again once the runs have ended.\n',
  )
  return EXIT_FAILURE
}
