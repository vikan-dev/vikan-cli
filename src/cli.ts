/**
 * `vikan` argument parsing and dispatch. Returns an exit code instead of
 * calling `process.exit` so tests can assert behavior.
 *
 * `--help` / `--version` stay configuration-free: every command handler and
 * helper below takes its environment fully injected (`CliDeps`), and none of
 * these modules read `process.env`, open connections or start a login at
 * import time — only at command execution.
 */
import { runConnectCommand } from './commands/connect.ts'
import { runDoctorCommand } from './commands/doctor.ts'
import { runLinkCommand } from './commands/link.ts'
import { runStatusCommand } from './commands/status.ts'
import { runUnlinkCommand } from './commands/unlink.ts'
import { runDeliverablesCommand } from './commands/deliverables.ts'
import { commands } from './commands/commands.ts'
import type { CliDeps } from './commands/types.ts'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.ts'

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.ts'

/**
 * Kept in sync with package.json by cli-entry.test.ts, which asserts the
 * `--version` output against the manifest. A constant (not a JSON import) so
 * the built bin stays a single self-contained file with no workspace strings.
 */
const VERSION = '0.1.0'

/** The version reported to the server at pairing (`cliVersion`). */
export const CLI_VERSION = VERSION

const PROGRAM = 'vikan'
const DEFAULT_COMMAND = 'connect'

const handlers: Record<string, (deps: CliDeps) => Promise<number>> = {
  connect: runConnectCommand,
  link: runLinkCommand,
  status: runStatusCommand,
  doctor: runDoctorCommand,
  unlink: runUnlinkCommand,
}

export function usageText(): string {
  const rows = commands.map((command) => ({
    label: `  ${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}`,
    summary: command.summary,
  }))
  const width = Math.max(...rows.map((row) => row.label.length)) + 2
  return [
    `${PROGRAM} ${VERSION} — run Codex through Herdr for a vikan project`,
    '',
    `Usage: ${PROGRAM} <command> [options]`,
    '',
    'Commands:',
    ...rows.map((row) => row.label.padEnd(width) + row.summary),
    '',
    'Options:',
    '  -h, --help     Show this help and exit',
    '  -v, --version  Print the CLI version and exit',
    '',
    `${PROGRAM} without a command runs \`${DEFAULT_COMMAND}\`.`,
    '',
  ].join('\n')
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const head = argv[0]
  if (head === '-h' || head === '--help' || head === 'help') {
    deps.io.out(usageText())
    return EXIT_OK
  }
  if (head === '-v' || head === '--version' || head === 'version') {
    deps.io.out(`${PROGRAM} ${VERSION}\n`)
    return EXIT_OK
  }

  const name = head ?? DEFAULT_COMMAND
  if (name.startsWith('-')) {
    deps.io.err(`Unknown option: ${name}\n\n${usageText()}`)
    return EXIT_USAGE
  }
  const command = commands.find((candidate) => candidate.name === name)
  if (command === undefined) {
    deps.io.err(`Unknown command: ${name}\n\n${usageText()}`)
    return EXIT_USAGE
  }

  try {
    if (name === 'deliverables') return await runDeliverablesCommand(argv.slice(1), deps)
    return await handlers[name]!(deps)
  } catch (error) {
    deps.io.err(`vikan ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_FAILURE
  }
}
