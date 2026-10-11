import { createHash } from 'node:crypto'
import { constants, closeSync, fsyncSync, fstatSync, statSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { dlopen, FFIType } from 'bun:ffi'
import { z } from 'zod'
import { FILE_MODE_SECRET, writeJsonFile } from './files.ts'

// Kernel locks survive neither exit nor SIGKILL. Never unlink this inode:
// unlink + O_EXCL takeover permits two contenders to lock different inodes.
const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const recoveryOwnerSchema = z.strictObject({
  configRoot: z.string(), apiOrigin: z.string(), userId: z.string(), bindingId: z.string(),
})
export type RecoveryOwner = z.infer<typeof recoveryOwnerSchema>
const ownerSchema = z.strictObject({
  pid: z.number().int().positive(), directoryKey: z.string(),
  recovery: recoveryOwnerSchema.nullable(),
})

/** OS account home, deliberately independent of HOME, API/account and VIKAN_CONFIG_DIR. */
export function directoryStateRoot(): string {
  return join(userInfo().homedir, '.local', 'state', 'vikan', 'directories')
}

export interface DirectoryLock {
  readonly directoryKey: string
  readonly path: string
  readonly pid: number
  heartbeat(): void
  /** Persist the recovery owner before any claim; another config cannot hide it. */
  bindRecovery(owner: RecoveryOwner): void
  clearRecovery(): void
  release(): void
}
export type LockAcquisition =
  | { ok: true; lock: DirectoryLock }
  | { ok: false; reason: string; lockPath: string }

/** stateRoot is injected by tests only; the CLI always uses directoryStateRoot(). */
export function lockFilePath(stateRoot: string, directoryKey: string): string {
  return join(stateRoot, `${createHash('sha256').update(directoryKey).digest('hex')}.lock`)
}

export function acquireDirectoryLock(stateRoot: string, directoryKey: string): LockAcquisition {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const path = lockFilePath(stateRoot, directoryKey)
  let created = false
  let fd: number
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
  }
  if (fstatSync(fd).uid !== process.getuid?.()) {
    closeSync(fd)
    return { ok: false, lockPath: path, reason: 'The checkout lock belongs to another OS user.' }
  }
  if (libc.symbols.flock(fd, 2 | 4) !== 0) { // LOCK_EX | LOCK_NB
    closeSync(fd)
    return { ok: false, lockPath: path, reason: 'Another vikan process still holds this checkout lock; elapsed time never overrides a live holder.' }
  }
  let released = false
  let recovery: RecoveryOwner | null = null
  let damaged = false
  // The flock inode never changes. Recovery metadata is a separate atomic
  // replacement; truncating the lock file must never erase an active owner.
  const ownerPath = `${path}.owner.json`
  try {
    const parsed = ownerSchema.parse(JSON.parse(readFileSync(ownerPath, 'utf8')))
    if (parsed.directoryKey !== directoryKey) throw new Error('Directory identity mismatch')
    recovery = parsed.recovery
    if (created) damaged = true // owner exists but its persistent lock inode disappeared
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || fstatSync(fd).size !== 0) damaged = true
  }
  const inode = fstatSync(fd)
  const assertHeld = (): void => {
    if (released) throw new Error('Directory lock already released')
    const current = statSync(path)
    if (current.ino !== inode.ino || current.dev !== inode.dev) throw new Error('Directory lock inode replaced; stopping this manager')
  }
  const persist = (): void => {
    assertHeld()
    writeJsonFile(ownerPath, { pid: process.pid, directoryKey, recovery }, { mode: FILE_MODE_SECRET })
    // A permanent initialized marker distinguishes a missing owner record
    // from a first acquisition that died before ever claiming any work.
    if (fstatSync(fd).size === 0) { writeSync(fd, '1'); fsyncSync(fd) }
  }
  return {
    ok: true,
    lock: {
      directoryKey, path, pid: process.pid,
      heartbeat: assertHeld,
      bindRecovery(owner) {
        if (damaged) throw new Error(`The checkout recovery owner is damaged (${path}); inspect existing panes and recovery files before proceeding.`)
        if (recovery !== null && JSON.stringify(recovery) !== JSON.stringify(owner)) {
          throw new Error(`This checkout has unresolved recovery state in ${recovery.configRoot} for binding ${recovery.bindingId}. Resume that binding before changing API, account or config directory.`)
        }
        recovery = owner
        persist()
      },
      clearRecovery() { recovery = null; persist() },
      release() {
        if (released) return
        released = true
        libc.symbols.flock(fd, 8) // LOCK_UN
        closeSync(fd)
      },
    },
  }
}
