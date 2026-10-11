import { z } from 'zod'
import type { Exec } from '../exec.ts'

/**
 * Read-only Herdr context detection (plan §5.2, §10.1): never trust
 * `HERDR_ENV=1` alone — the pane, workspace and tab identities must come
 * from the Herdr server itself, via `herdr pane current --current`. This
 * module only ever asks questions; it never splits, focuses, starts agents
 * or reads any pane's content (not even this pane's output).
 *
 * The session name is resolved from `herdr session list` by matching the
 * socket path Herdr exported into the environment — best effort, because the
 * socket path alone is already a stable session identity.
 */

const paneCurrentSchema = z.object({
  result: z.object({
    type: z.literal('pane_current'),
    pane: z.object({
      pane_id: z.string().min(1),
      workspace_id: z.string().min(1),
      tab_id: z.string().min(1),
      terminal_id: z.string().min(1),
      cwd: z.string().min(1),
    }),
  }),
})

export interface HerdrContextInfo {
  readonly herdrVersion: string
  readonly paneId: string
  readonly workspaceId: string
  readonly tabId: string
  readonly terminalId: string
  readonly paneCwd: string
  readonly sessionName: string | null
  readonly socketPath: string | null
}

export type HerdrFailureReason = 'no-herdr-env' | 'herdr-unavailable' | 'no-current-pane'

export type HerdrDetection =
  | { ok: true; info: HerdrContextInfo }
  | { ok: false; reason: HerdrFailureReason }

export interface HerdrEnvValues {
  readonly HERDR_ENV?: string | undefined
  readonly HERDR_SOCKET_PATH?: string | undefined
}

export function herdrFailureMessage(reason: HerdrFailureReason): string {
  switch (reason) {
    case 'no-herdr-env':
      return 'vikan must run inside a Herdr pane. Start it from a terminal pane in a Herdr session.'
    case 'herdr-unavailable':
      return 'The herdr CLI is not available. Install Herdr and check that `herdr --version` works.'
    case 'no-current-pane':
      return 'Herdr is running but the current pane could not be identified. Run vikan from an interactive Herdr pane.'
  }
}

export function detectHerdrContext(exec: Exec, envValues: HerdrEnvValues): HerdrDetection {
  // Necessary but never sufficient: the env var is a hint, the socket is the proof.
  if (envValues.HERDR_ENV !== '1') return { ok: false, reason: 'no-herdr-env' }
  const version = exec('herdr', ['--version'])
  if (version.code !== 0) return { ok: false, reason: 'herdr-unavailable' }
  const herdrVersion = version.stdout.trim().split(/\s+/).at(-1) ?? ''

  const current = exec('herdr', ['pane', 'current', '--current'])
  let pane: z.infer<typeof paneCurrentSchema>['result']['pane'] | undefined
  if (current.code === 0) {
    try {
      const parsed = paneCurrentSchema.safeParse(JSON.parse(current.stdout))
      if (parsed.success) pane = parsed.data.result.pane
    } catch {
      // Malformed output falls through to the explicit no-current-pane refusal.
    }
  }
  if (pane === undefined) return { ok: false, reason: 'no-current-pane' }

  const socketPath = envValues.HERDR_SOCKET_PATH ?? null
  return {
    ok: true,
    info: {
      herdrVersion,
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      tabId: pane.tab_id,
      terminalId: pane.terminal_id,
      paneCwd: pane.cwd,
      sessionName: socketPath === null ? null : sessionNameOf(exec, socketPath),
      socketPath,
    },
  }
}

/** Find the session row whose socket is the socket this pane talks to. */
function sessionNameOf(exec: Exec, socketPath: string): string | null {
  const listing = exec('herdr', ['session', 'list'])
  if (listing.code !== 0) return null
  for (const line of listing.stdout.split('\n')) {
    if (line.includes(socketPath)) return line.trim().split(/\s+/)[0] ?? null
  }
  return null
}
