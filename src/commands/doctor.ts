import { createVikanApiClient } from '../api/client.ts'
import { EXIT_FAILURE, EXIT_OK } from '../exit.ts'
import { herdrFailureMessage } from '../herdr/context.ts'
import { findBindingRecordsForPath, resolveDirectoryIdentity, scanBindingRecords, scanCredentialFilePaths } from '../state/binding.ts'
import { statSync } from 'node:fs'
import type { CliDeps } from './types.ts'

/**
 * `vikan doctor` (plan §5.2): check Bun, Herdr, Codex, config and network
 * without starting anything. It runs OUTSIDE Herdr too — outside, the Herdr
 * check simply fails with the reason. It never splits a pane, never starts
 * Codex, never reads any pane's output (not even the current one's), and
 * never prints a secret.
 */
export async function runDoctorCommand(deps: CliDeps): Promise<number> {
  const checks: { readonly ok: boolean; readonly label: string; readonly detail: string }[] = []

  checks.push({ ok: true, label: 'Bun', detail: `Bun ${Bun.version}` })

  const detection = deps.detectHerdr()
  if (detection.ok) {
    const { info } = detection
    checks.push({
      ok: true,
      label: 'Herdr',
      detail: `herdr ${info.herdrVersion} — pane ${info.paneId}, workspace ${info.workspaceId}, tab ${info.tabId}${info.sessionName === null ? '' : `, session ${info.sessionName}`}`,
    })
  } else {
    checks.push({ ok: false, label: 'Herdr', detail: herdrFailureMessage(detection.reason) })
  }

  const codex = deps.exec('codex', ['--version'])
  checks.push(
    codex.code === 0
      ? { ok: true, label: 'Codex', detail: codex.stdout.trim() || 'codex CLI available' }
      : { ok: false, label: 'Codex', detail: 'codex CLI not found on PATH — runs cannot start without it' },
  )

  try {
    const directory = resolveDirectoryIdentity(deps.cwd(), deps.exec)
    const linked = findBindingRecordsForPath(deps.configDir, directory.key).length
    checks.push({
      ok: true,
      label: 'Directory',
      detail: `${directory.isRepo ? 'git repo' : 'plain directory'} ${directory.key}${linked === 0 ? ' — not linked' : ` — ${linked} binding${linked === 1 ? '' : 's'}`}`,
    })
  } catch (error) {
    checks.push({ ok: false, label: 'Directory', detail: `the working directory could not be resolved (${error instanceof Error ? error.message : String(error)})` })
  }

  const bindings = scanBindingRecords(deps.configDir)
  const credentialFiles = scanCredentialFilePaths(deps.configDir)
  const badPermissions = credentialFiles.filter((path) => (statSync(path).mode & 0o777) !== 0o600)
  checks.push({
    ok: badPermissions.length === 0,
    label: 'Config',
    detail:
      credentialFiles.length === 0
        ? `${deps.configDir} — ${bindings.length} binding${bindings.length === 1 ? '' : 's'}, no credentials yet (pair with \`vikan link\`)`
        : badPermissions.length === 0
          ? `${deps.configDir} — ${bindings.length} binding${bindings.length === 1 ? '' : 's'}, ${credentialFiles.length} credential${credentialFiles.length === 1 ? '' : 's'} (owner-only)`
          : `${badPermissions.length} credential file(s) are readable beyond the owner — run chmod 600 on them`,
  })

  const origin = deps.apiOrigin ?? bindings[0]?.apiOrigin
  if (origin === undefined) {
    checks.push({ ok: true, label: 'Network', detail: 'no API origin configured yet (VIKAN_API_URL, or any saved binding)' })
  } else {
    try {
      const api = createVikanApiClient({ apiOrigin: origin, fetch: deps.fetch })
      await api.checkHealth()
      checks.push({ ok: true, label: 'Network', detail: `${origin} reachable` })
    } catch (error) {
      checks.push({ ok: false, label: 'Network', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  let failed = false
  for (const check of checks) {
    if (!check.ok) failed = true
    deps.io.out(`${check.ok ? '[ok]  ' : '[fail]'} ${check.label.padEnd(9)} ${check.detail}\n`)
  }
  return failed ? EXIT_FAILURE : EXIT_OK
}
