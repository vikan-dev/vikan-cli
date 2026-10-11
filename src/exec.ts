import { spawnSync } from 'node:child_process'

/**
 * Read-only command execution. Always an argv array — never a shell string —
 * so issue text or URLs can never be reinterpreted by a shell. Used for the
 * probes only (`git rev-parse`, `herdr --version`, `herdr pane current`,
 * `codex --version`); Herdr effects use the asynchronous executor below.
 */
export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type Exec = (command: string, args: readonly string[]) => ExecResult

export interface AsyncExecOptions {
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
}
export type AsyncExec = (command: string, args: readonly string[], options?: AsyncExecOptions) => Promise<ExecResult>

/** Herdr startup/activation must not block runner heartbeats or cancellation.
 * Capture the environment at the apps entry; pin the socket for every call.
 * No shell interprets arguments, including prompts. A timeout is uncertain. */
export function createAsyncExec(environment: Readonly<Record<string, string | undefined>>): AsyncExec {
  return async (command, args, options = {}) => {
    try {
      const child = Bun.spawn([command, ...args], { env: { ...environment, ...options.env },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs ?? 5000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited,
          new Response(child.stdout).text(), new Response(child.stderr).text()])
        return timedOut ? { code: 124, stdout: '', stderr: 'Command timed out; effect unconfirmed.' } : { code, stdout, stderr }
      } finally { clearTimeout(timer) }
    } catch { return { code: 127, stdout: '', stderr: 'Command could not be executed.' } }
  }
}

const NOT_FOUND = 127
const FAILED = 1

/** The production implementation. Synchronous: probes are short and local. */
export function execFile(command: string, args: readonly string[]): ExecResult {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined) {
    return { code: NOT_FOUND, stdout: '', stderr: result.error.message }
  }
  return { code: result.status ?? FAILED, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
