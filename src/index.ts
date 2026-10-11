#!/usr/bin/env bun
/**
 * `vikan` entry point. Parsing and dispatch live in cli.ts; this file wires
 * argv, stdio, stop signals and the real command dependencies (the ONLY
 * place besides env.ts that touches the process), guarded by
 * `import.meta.main` so tests can import it without running the binary.
 */
import process from 'node:process'
import { runCli } from './cli.ts'
import { realCliDeps } from './deps.ts'

export { runCli } from './cli.ts'
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.ts'

/** 供主应用的开发入口复用；在同一进程处理信号，避免包装进程遗留 runner。 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const io = {
    out: (text: string): void => {
      process.stdout.write(text)
    },
    err: (text: string): void => {
      process.stderr.write(text)
    },
  }
  // The online runner's graceful-stop trigger: first signal stops, a second
  // forces the exit — local Codex work is not waited on beyond the drain.
  let signaled = false
  const stopSignal = new Promise<void>((resolve) => {
    const onSignal = (): void => {
      if (signaled) process.exit(130)
      signaled = true
      resolve()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
  process.exitCode = await runCli(argv, realCliDeps(io, { stopSignal }))
}

if (import.meta.main) await main()
