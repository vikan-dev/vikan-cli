/**
 * Crash-injection seam for the recovery tests (todo 09 verification): the
 * runner calls `checkpoint` at each durability boundary; a test hook throws
 * `SimulatedCrashError` to kill the runner exactly there — no cleanup, no
 * offline, no lock release — so the next start replays whatever the fsync'd
 * journal holds, the same way a real `kill -9` would.
 *
 * Production never sets a hook; every component re-throws the error so it
 * escapes their error handling instead of being classified as a network
 * blip.
 */

export type CrashHook = (checkpoint: string) => void

export class SimulatedCrashError extends Error {
  readonly checkpoint: string

  constructor(checkpoint: string) {
    super(`Simulated crash at ${checkpoint}`)
    this.name = 'SimulatedCrashError'
    this.checkpoint = checkpoint
  }
}

export function isSimulatedCrash(error: unknown): error is SimulatedCrashError {
  return error instanceof SimulatedCrashError
}

/** Invoke the test hook; a throwing hook aborts the caller's loop. */
export function checkpoint(hook: CrashHook | undefined, name: string): void {
  hook?.(name)
}
