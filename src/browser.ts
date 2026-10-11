import { spawnSync } from 'node:child_process'

/**
 * Best-effort browser opening for the pairing URL. `xdg-open` on Linux,
 * `open` on macOS — only when the opener actually exists; anything else
 * degrades to printing the URL (pairing never depends on localhost or a
 * local browser, so copying it to another device is a first-class path).
 */
const OPENER_BY_PLATFORM: Partial<Record<typeof process.platform, string>> = {
  linux: 'xdg-open',
  darwin: 'open',
}

export function openUrlInBrowser(url: string): boolean {
  const opener = OPENER_BY_PLATFORM[process.platform]
  if (opener === undefined || Bun.which(opener) === null) return false
  const result = spawnSync(opener, [url], { timeout: 10_000 })
  return result.error === undefined && result.status === 0
}
