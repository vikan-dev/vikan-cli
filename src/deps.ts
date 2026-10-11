import { join, resolve } from 'node:path'
import os from 'node:os'
import { createAsyncExec, execFile } from './exec.ts'
import { detectHerdrContext } from './herdr/context.ts'
import { env, subprocessEnv, planRendererEnv } from './env.ts'
import { executeRenderer } from './plan-renderer/process.ts'
import type { CliIo, CliDeps } from './commands/types.ts'

/**
 * The production `CliDeps`: the one place where the environment (validated
 * by env.ts) meets the command layer. Everything here is injectable, so the
 * tests never touch the real home directory, network or Herdr.
 */
export function realCliDeps(io: CliIo, options: { stopSignal?: Promise<void> } = {}): CliDeps {
  return {
    io,
    configDir: resolve(env.VIKAN_CONFIG_DIR ?? join(os.homedir(), '.config', 'vikan')),
    invocation: [process.execPath, '--no-env-file', resolve(process.argv[1]!)],
    apiOrigin: env.VIKAN_API_URL,
    deviceName: `${os.userInfo().username}@${os.hostname()}`.slice(0, 120),
    cwd: () => process.cwd(),
    fetch: (url, init) => fetch(url, init),
    exec: execFile,
    execAsync: createAsyncExec(subprocessEnv),
    planRenderer: { bunExecutable: process.execPath, env: planRendererEnv, execute: executeRenderer },
    detectHerdr: () => detectHerdrContext(execFile, {
      HERDR_ENV: env.HERDR_ENV,
      HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH,
    }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
    now: () => Date.now(),
    stopSignal: options.stopSignal,
  }
}
