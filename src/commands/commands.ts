/**
 * The `vikan` command table — metadata only, for `--help` and dispatch.
 * Handlers live in commands/*.ts and are wired in cli.ts.
 */
export interface CommandDefinition {
  /** Name typed after `vikan`. */
  readonly name: string
  /** One-line description printed by `vikan --help`. */
  readonly summary: string
  /** Argument hint printed after the name, e.g. `[--project <id>]`. */
  readonly usage?: string
}

export const commands: readonly CommandDefinition[] = [
  { name: 'deliverables', usage: '<command> [options]', summary: 'Publish issue plans, upload evidence and submit validation from the current run (see deliverables --help)' },
  {
    name: 'connect',
    summary: 'Pair this directory if needed, then connect to the vikan project (default when run without a command)',
    usage: '[--project <id>]',
  },
  {
    name: 'link',
    summary: 'Pair this device and directory with a vikan project in the browser',
    usage: '[--project <id>]',
  },
  {
    name: 'status',
    summary: 'Show the current binding, connection and run',
  },
  {
    name: 'doctor',
    summary: 'Check Bun, Herdr, Codex, config and network without starting anything',
  },
  {
    name: 'unlink',
    summary: 'Revoke this directory binding and local credentials',
  },
]
