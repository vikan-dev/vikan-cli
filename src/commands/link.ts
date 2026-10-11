import { createVikanApiClient } from '../api/client.ts'
import { openUrlInBrowser } from '../browser.ts'
import { CLI_VERSION } from '../cli.ts'
import { EXIT_FAILURE, EXIT_OK } from '../exit.ts'
import { herdrFailureMessage } from '../herdr/context.ts'
import type { PairingOutcome } from '../auth/pairing.ts'
import { runPairing } from '../auth/pairing.ts'
import { resolveDirectoryIdentity, type DirectoryIdentity } from '../state/binding.ts'
import type { CliDeps } from './types.ts'

/**
 * `vikan link` (plan §5.2): pair this device and directory with a project in
 * the browser. Requires a REAL Herdr context — the env var alone is never
 * enough. The default command (`vikan`) reuses `pairDirectory` for its
 * embedded pairing; the online runner itself lands with task 09.
 */

export interface LinkGuard {
  readonly ok: boolean
  readonly code: number
  readonly directory?: DirectoryIdentity
}

/** The shared precondition of connect and link: Herdr context, API origin, directory. */
export function requireLinkContext(deps: CliDeps): LinkGuard {
  const detection = deps.detectHerdr()
  if (!detection.ok) {
    deps.io.err(`vikan: ${herdrFailureMessage(detection.reason)}\n`)
    return { ok: false, code: EXIT_FAILURE }
  }
  if (deps.apiOrigin === undefined) {
    deps.io.err('vikan: VIKAN_API_URL is not set. Point it at your vikan API origin (for example https://api.vikan.dev) and try again.\n')
    return { ok: false, code: EXIT_FAILURE }
  }
  return { ok: true, code: EXIT_OK, directory: resolveDirectoryIdentity(deps.cwd(), deps.exec) }
}

export async function pairDirectory(deps: CliDeps, apiOrigin: string, directory: DirectoryIdentity): Promise<PairingOutcome> {
  const api = createVikanApiClient({ apiOrigin, fetch: deps.fetch })
  return runPairing({
    api,
    configRoot: deps.configDir,
    apiOrigin,
    directoryKey: directory.key,
    directoryLabel: directory.label,
    deviceName: deps.deviceName,
    cliVersion: CLI_VERSION,
    io: { out: (text) => deps.io.out(text), openBrowser: (url) => openUrlInBrowser(url) },
    now: deps.now,
    sleep: deps.sleep,
  })
}

/** Print a terminal pairing outcome and return its exit code. */
export function reportPairingFailure(deps: CliDeps, outcome: PairingOutcome): number {
  const message = pairingFailureText(outcome)
  deps.io.err(`${message}\n`)
  return EXIT_FAILURE
}

function pairingFailureText(outcome: PairingOutcome): string {
  switch (outcome.kind) {
    case 'expired':
      return 'vikan: the pairing window expired before it was approved. Run `vikan link` again to start a fresh pairing.'
    case 'rejected':
      return 'vikan: the pairing request was rejected in the browser. Run `vikan link` again when you want to pair.'
    case 'conflict':
      return 'vikan: this directory is already linked to an active vikan binding. Revoke it first (`vikan unlink`, or the Agent page in the browser).'
    case 'rate-limited':
      return 'vikan: the API rate-limited the pairing request. Wait a few minutes and run `vikan link` again.'
    case 'network':
      return 'vikan: the API is unreachable. The pairing identity is saved locally — run `vikan link` again when online; it will reuse the same request.'
    case 'failed':
      return `vikan: pairing failed — ${outcome.reason}`
    default:
      return 'vikan: pairing failed.'
  }
}

export async function runLinkCommand(deps: CliDeps): Promise<number> {
  const guard = requireLinkContext(deps)
  if (!guard.ok || guard.directory === undefined || deps.apiOrigin === undefined) return guard.code
  const outcome = await pairDirectory(deps, deps.apiOrigin, guard.directory)
  if (outcome.kind === 'linked') {
    const binding = outcome.binding
    deps.io.out(
      [
        `Linked ${binding.directoryLabel} (${binding.path})`,
        `  binding   ${binding.bindingId}`,
        `  project   ${binding.projectId} in workspace ${binding.workspaceId}`,
        `  device    ${binding.deviceId} (${deps.deviceName})`,
        `  user      ${binding.userId}`,
        '',
        'Run `vikan` to go online.',
      ].join('\n'),
    )
    return EXIT_OK
  }
  return reportPairingFailure(deps, outcome)
}
