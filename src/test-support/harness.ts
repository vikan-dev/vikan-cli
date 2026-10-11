import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliIo, CliDeps } from '../commands/types.ts'
import type { Exec, ExecResult } from '../exec.ts'
import type { HerdrDetection } from '../herdr/context.ts'
import { executeRenderer } from '../plan-renderer/process.ts'

/**
 * Test harness pieces: captured IO, temp config roots, a fake exec that
 * records every command (so tests can prove doctor never splits panes or
 * starts agents) and a configurable CliDeps factory.
 */

export function captureIo(): { out: string[]; err: string[]; io: CliIo } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (text: string): void => {
        out.push(text)
      },
      err: (text: string): void => {
        err.push(text)
      },
    },
  }
}

export interface RecordingExec {
  readonly calls: { command: string; args: readonly string[] }[]
  readonly exec: Exec
}

/** Git reports "not a repository" for everything unless a test maps a root; codex answers its version. */
export function recordingExec(gitTopFor: (cwd: string) => string | undefined = () => undefined): RecordingExec {
  const calls: { command: string; args: readonly string[] }[] = []
  const notARepo: ExecResult = { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
  const exec: Exec = (command, args) => {
    calls.push({ command, args })
    if (command === 'git') {
      const top = gitTopFor(String(args[1] ?? ''))
      if (top !== undefined && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--show-toplevel') {
        return { code: 0, stdout: `${top}\n`, stderr: '' }
      }
      return notARepo
    }
    if (command === 'codex' && args[0] === '--version') {
      return { code: 0, stdout: 'codex-cli 0.154.0\n', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: `${command}: not found (fake exec)` }
  }
  return { calls, exec }
}

export const T0 = 1_758_000_000_000

export const herdrOk: HerdrDetection = {
  ok: true,
  info: {
    herdrVersion: '0.9.0',
    paneId: 'w9:p1',
    workspaceId: 'w9',
    tabId: 'w9:t1',
    terminalId: 'term_test',
    paneCwd: '/fake/cwd',
    sessionName: 'default',
    socketPath: '/fake/herdr.sock',
  },
}

export interface FakeDepsOverrides extends Partial<Omit<CliDeps, 'io' | 'configDir' | 'sleep' | 'now' | 'exec' | 'fetch' | 'cwd' | 'detectHerdr' | 'apiOrigin' | 'deviceName'>> {
  readonly io?: CliIo
  readonly apiOrigin?: string
  readonly cwd?: () => string
  readonly fetch?: CliDeps['fetch']
  readonly exec?: Exec
  readonly detectHerdr?: CliDeps['detectHerdr']
  /** Share this clock with a fake API so pairing deadlines are deterministic. */
  readonly clock?: { value: number }
}

export function tempConfigRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'vikan-cli-test-')))
}

/** CliDeps on a temp config root; `clock.value` drives sleep/now (shareable with the fake API). */
export function fakeDeps(configRoot: string, overrides: FakeDepsOverrides = {}): {
  deps: CliDeps
  clock: { value: number }
  cwdDir: string
  out: string[]
  err: string[]
} {
  const clock = overrides.clock ?? { value: T0 }
  const recorded = recordingExec()
  const cwdDir = realpathSync(mkdtempSync(join(tmpdir(), 'vikan-cli-cwd-')))
  const captured = captureIo()
  const deps: CliDeps = {
    io: overrides.io ?? captured.io,
    configDir: configRoot,
    directoryStateRoot: overrides.directoryStateRoot ?? configRoot,
    apiOrigin: overrides.apiOrigin,
    deviceName: 'tester@host',
    invocation: overrides.invocation ?? [process.execPath, '--no-env-file', new URL('../index.ts', import.meta.url).pathname],
    cwd: overrides.cwd ?? (() => cwdDir),
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    exec: overrides.exec ?? recorded.exec,
    execAsync: overrides.execAsync ?? (async (command, args) => (overrides.exec ?? recorded.exec)(command, args)),
    planRenderer: overrides.planRenderer ?? { bunExecutable: process.execPath, env: { CI: '1' }, execute: executeRenderer },
    detectHerdr: overrides.detectHerdr ?? (() => ({ ok: false, reason: 'no-herdr-env' })),
    sleep: fakeClockSleep(clock),
    now: () => clock.value,
  }
  return { deps, clock, cwdDir, out: captured.out, err: captured.err }
}

/** A sleep that advances a fake clock instead of waiting. */
export function fakeClockSleep(clock: { value: number }): (ms: number) => Promise<void> {
  return async (ms: number) => {
    clock.value += ms
  }
}
