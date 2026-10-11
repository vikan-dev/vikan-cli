import { createVikanApiClient } from '../api/client.ts'
import { CLI_VERSION } from '../cli.ts'
import { EXIT_FAILURE, EXIT_OK } from '../exit.ts'
import { assertHerdrExecutionPlatform, HerdrAgentAdapter } from '../herdr/adapter.ts'
import { HerdrOwnerStore } from '../state/herdr.ts'
import { realpathSync } from 'node:fs'
import { acquireDirectoryLock, directoryStateRoot } from '../state/directory-lock.ts'
import { RunnerJournal } from '../state/journal.ts'
import { VikanRunner } from '../runner/session.ts'
import { deliverablesCommand } from '../runner/deliverables.ts'
import { createS2Transport } from '../transport/s2.ts'
import { findBindingRecordsForPath, loadCredentialRecord, resolveDirectoryIdentity, type BindingRecord } from '../state/binding.ts'
import type { HerdrContextInfo } from '../herdr/context.ts'
import type { CliDeps } from './types.ts'
import { pairDirectory, reportPairingFailure } from './link.ts'

/**
 * `vikan` / `vikan connect` (plan §5.2, todo 09 T1): the default command.
 * With no binding it reuses the exact `vikan link` pairing flow, then goes
 * ONLINE for real: the directory execution lock (one manager per checkout,
 * whatever the API origin or account), a runner session with its own epoch,
 * restart reconciliation, the S2 command consumer, the dispatcher, the
 * receipt pump and the heartbeat — until the stop signal.
 *
 * Herdr effects use durable ownership and the same recovery/claim fences.
 */

export async function runConnectCommand(deps: CliDeps): Promise<number> {
  try { assertHerdrExecutionPlatform() }
  catch (error) {
    deps.io.err(`vikan connect: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_FAILURE
  }
  const detection = deps.detectHerdr()
  if (!detection.ok) { deps.io.err('vikan: connect requires a verified Herdr pane.\n'); return EXIT_FAILURE }
  if (deps.exec('codex', ['--version']).code !== 0) { deps.io.err('vikan: Codex is unavailable; install it before connecting.\n'); return EXIT_FAILURE }
  const directory = resolveDirectoryIdentity(deps.cwd(), deps.exec)

  const bindings = findBindingRecordsForPath(deps.configDir, directory.key)
  if (bindings.length > 1) {
    deps.io.err(
      `vikan: this directory is linked ${bindings.length} times (${bindings.map((b) => `${b.apiOrigin} as ${b.userId}`).join(', ')}).\nUnlink the others first — one binding per directory.\n`,
    )
    return EXIT_FAILURE
  }

  let binding: BindingRecord | undefined = bindings[0]
  if (binding === undefined) {
    if (deps.apiOrigin === undefined) { deps.io.err('vikan: VIKAN_API_URL is required for initial pairing.\n'); return EXIT_FAILURE }
    deps.io.out('This directory is not linked to a vikan project — starting browser pairing.\n')
    const outcome = await pairDirectory(deps, deps.apiOrigin, directory)
    if (outcome.kind !== 'linked') return reportPairingFailure(deps, outcome)
    binding = outcome.binding
    deps.io.out(`Linked ${binding.directoryLabel} to project ${binding.projectId} (binding ${binding.bindingId}).\n`)
  } else {
    deps.io.out(`This directory is linked to project ${binding.projectId} (binding ${binding.bindingId}).\n`)
  }

  return connectOnline(deps, binding, detection.info)
}

async function connectOnline(deps: CliDeps, binding: BindingRecord, herdr: HerdrContextInfo): Promise<number> {
  const credential = loadCredentialRecord(deps.configDir, binding)
  if (credential === undefined) {
    deps.io.err(
      'vikan connect: the local credential for this binding is missing, so the device cannot authenticate.\nRun `vikan link` to pair again, or restore the credential file under the vikan config directory.\n',
    )
    return EXIT_FAILURE
  }

  // One manager per checkout — the lock is keyed by the normalized path
  // only, so a second vikan from a subdirectory, a symlink or a different
  // server/account cannot manage the same checkout.
  const lock = acquireDirectoryLock(deps.directoryStateRoot ?? directoryStateRoot(), binding.path)
  if (!lock.ok) {
    deps.io.err(`vikan connect: this checkout is already managed by another vikan process.\n${lock.reason}\n`)
    return EXIT_FAILURE
  }

  let journal: RunnerJournal
  try {
    lock.lock.bindRecovery({ configRoot: realpathSync(deps.configDir), apiOrigin: binding.apiOrigin, userId: binding.userId, bindingId: binding.bindingId })
    journal = RunnerJournal.open(deps.configDir, binding)
  } catch (error) {
    lock.lock.release()
    deps.io.err(`vikan: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_FAILURE
  }
  deps.io.out('Herdr execution connected; Codex uses your local model, reasoning, sandbox and approval settings.\n')
  const runner = new VikanRunner({
    api: createVikanApiClient({ apiOrigin: binding.apiOrigin, fetch: deps.fetch, credential: credential.credential }),
    binding,
    journal,
    transport: createS2Transport(),
    adapter: new HerdrAgentAdapter({ context: herdr, cwd: binding.path, exec: deps.execAsync,
      store: new HerdrOwnerStore(deps.configDir, binding) }),
    lock: lock.lock,
    herdr,
    cliVersion: CLI_VERSION,
    deliverablesCommand: deliverablesCommand(deps.invocation, deps.configDir, binding.apiOrigin),
    io: deps.io,
    stopSignal: deps.stopSignal ?? new Promise<void>(() => {}),
    now: deps.now,
    sleep: deps.sleep,
  })
  const outcome = await runner.run()
  return outcome.code === 0 ? EXIT_OK : EXIT_FAILURE
}
