import { chmodSync, closeSync, fsyncSync, fstatSync, ftruncateSync, readSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * Local state file primitives (plan §5.2): small JSON files and append-only
 * journals, always written atomically (same-directory temp file + rename) so
 * a crash can never leave a half-written binding or credential behind.
 *
 * The runner journal that lands with task 09 is built on `openJournal`; this
 * module is the shared base it and unlink's activity check both use.
 */

/** Owner-only permissions for every file that carries a secret. */
export const FILE_MODE_SECRET = 0o600

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/**
 * Atomic JSON write. The temp file lives in the target directory so the
 * rename is a POSIX atomic replace; the explicit chmod beats any umask.
 */
export function writeJsonFile(path: string, value: unknown, options: { mode?: number } = {}): void {
  ensureDir(dirname(path))
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: options.mode ?? 0o666, flag: 'wx' })
  if (options.mode !== undefined) chmodSync(tmp, options.mode)
  const fd = openSync(tmp, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
  const parent = openSync(dirname(path), 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

/** Parsed content, or undefined when the file is missing or unreadable. */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export interface Journal {
  /** Append one record; fsync'd before it counts as written. */
  append(record: Record<string, unknown>): void
  /** All records in order; a truncated final line (mid-write crash) is skipped. */
  records(): unknown[]
}

export function openJournal(path: string): Journal {
  return {
    append(record: Record<string, unknown>): void {
      ensureDir(dirname(path))
      const fd = openSync(path, 'a+', FILE_MODE_SECRET)
      try {
        const size = fstatSync(fd).size
        const last = Buffer.alloc(1)
        if (size > 0) readSync(fd, last, 0, 1, size - 1)
        // Repair only a torn tail; normal appends do not reread all history.
        if (size > 0 && last[0] !== 10) {
          const text = readFileSync(path, 'utf8')
          ftruncateSync(fd, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)))
        }
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
        let offset = 0
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const parent = openSync(dirname(path), 'r')
      try { fsyncSync(parent) } finally { closeSync(parent) }
    },
    records(): unknown[] {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const records: unknown[] = []
      for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
        if (line === '') continue
        try {
          records.push(JSON.parse(line))
        } catch {
          throw new Error(`Corrupt journal record in ${path}; recovery must be inspected before execution.`)
        }
      }
      return records
    },
  }
}
