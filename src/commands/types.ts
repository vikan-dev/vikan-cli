import type { AsyncExec, Exec } from '../exec.ts'
import type { HerdrDetection } from '../herdr/context.ts'
import type { RendererExec } from '../plan-renderer/process.ts'

/** Where command output goes; tests capture it, the entry passes process streams. */
export interface CliIo {
  out(text: string): void
  err(text: string): void
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Everything a command needs. Fully injected: the entry wires the real
 * implementations from `env.ts`, the tests point them at temp directories,
 * fake Herdr execs and fake API servers.
 */
export interface CliDeps {
  readonly io: CliIo
  /** User-level vikan state directory (VIKAN_CONFIG_DIR or the default). */
  readonly configDir: string
  /** Test injection only; production uses the OS account state directory. */
  readonly directoryStateRoot?: string
  /** API origin from VIKAN_API_URL; commands that talk before linking need it. */
  readonly apiOrigin: string | undefined
  /** Human-readable device name reported to the server at pairing. */
  readonly deviceName: string
  /** Absolute Bun executable + source/bundle entry; never assumes a global bin. */
  readonly invocation: readonly string[]
  readonly cwd: () => string
  readonly fetch: FetchLike
  readonly exec: Exec
  readonly execAsync: AsyncExec
  /** Isolated local renderer; never use the environment-inheriting Herdr exec. */
  readonly planRenderer: {
    readonly bunExecutable: string
    readonly env: Readonly<Record<string, string>>
    readonly execute: RendererExec
  }
  /** Read-only Herdr context probe; commands require a real pane here. */
  readonly detectHerdr: () => HerdrDetection
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  /**
   * Resolves when the process received SIGINT/SIGTERM — the online runner's
   * graceful-stop trigger. Tests resolve it on demand; when absent, the
   * runner runs until the process dies.
   */
  readonly stopSignal?: Promise<void>
}
