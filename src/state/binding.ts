import { createHash } from 'node:crypto'
import { readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { AGENT_RUN_NON_TERMINAL_STATUSES } from '@vikan/sdk/agent'
import { uuidSchema } from '@vikan/sdk/agent'
import type { Exec } from '../exec.ts'
import { FILE_MODE_SECRET, openJournal, readJsonFile, removePath, writeJsonFile, type Journal } from './files.ts'

/**
 * The persisted binding store (plan §5.2, §6.1). Layout, all under the
 * user-level config root:
 *
 *   origins/<origin-slug>/pending/<directory-slug>.json     pairing in flight (secrets, 0600)
 *   origins/<origin-slug>/users/<userId>/bindings/<bindingId>.json
 *   origins/<origin-slug>/users/<userId>/credentials/<deviceId>.json   (0600)
 *   origins/<origin-slug>/users/<userId>/journal/<bindingId>.jsonl
 *
 * The origin slug isolates state per API instance; the users/ level isolates
 * accounts on the same machine. Nothing here is ever written into a
 * repository, AGENTS.md or Codex global settings.
 */

/** The full binding identity, exactly the fields the plan requires. */
export const bindingRecordSchema = z.strictObject({
  apiOrigin: z.url(),
  userId: uuidSchema,
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  deviceId: uuidSchema,
  bindingId: uuidSchema,
  /** Normalized directory key: the git repo root, or realpath of a plain directory. */
  path: z.string().min(1),
  directoryLabel: z.string().min(1),
  claimedAt: z.string().min(1),
  /** Last time the server confirmed this binding (bindings.list succeeded). */
  lastConfirmedAt: z.string().nullable(),
  /** Returned by the server; the CLI never guesses a workspace routing slug. */
  agentPageUrl: z.url(),
})
export interface BindingRecord {
  readonly apiOrigin: string
  readonly userId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly deviceId: string
  readonly bindingId: string
  /** Normalized directory key: the git repo root, or realpath of a plain directory. */
  readonly path: string
  readonly directoryLabel: string
  readonly claimedAt: string
  lastConfirmedAt: string | null
  readonly agentPageUrl: string
}

export const credentialRecordSchema = z.strictObject({
  apiOrigin: z.url(),
  userId: uuidSchema,
  bindingId: uuidSchema,
  deviceId: uuidSchema,
  /** The bearer token itself — never logged, only sent as an Authorization header. */
  credential: z.string().min(43).max(128),
})
export interface CredentialRecord {
  readonly apiOrigin: string
  readonly userId: string
  readonly bindingId: string
  readonly deviceId: string
  readonly credential: string
}

export interface BindingRef {
  readonly apiOrigin: string
  readonly userId: string
  readonly bindingId: string
}

export interface CredentialRef {
  readonly apiOrigin: string
  readonly userId: string
  readonly deviceId: string
}

const slug = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24)

export function originDir(configRoot: string, apiOrigin: string): string {
  return join(configRoot, 'origins', slug(apiOrigin))
}

export function bindingPath(configRoot: string, ref: BindingRef): string {
  return join(originDir(configRoot, ref.apiOrigin), 'users', ref.userId, 'bindings', `${ref.bindingId}.json`)
}

export function credentialPath(configRoot: string, ref: CredentialRef): string {
  return join(originDir(configRoot, ref.apiOrigin), 'users', ref.userId, 'credentials', `${ref.deviceId}.json`)
}

export function journalPath(configRoot: string, ref: BindingRef): string {
  return join(originDir(configRoot, ref.apiOrigin), 'users', ref.userId, 'journal', `${ref.bindingId}.jsonl`)
}

/** Pending pairing state is keyed by directory so a rerun reuses the same identity. */
export function pendingPath(configRoot: string, apiOrigin: string, directoryKey: string): string {
  return join(originDir(configRoot, apiOrigin), 'pending', `${slug(directoryKey)}.json`)
}

export function bindingJournal(configRoot: string, ref: BindingRef): Journal {
  return openJournal(journalPath(configRoot, ref))
}

export function saveBindingRecord(configRoot: string, record: BindingRecord): void {
  writeJsonFile(bindingPath(configRoot, record), bindingRecordSchema.parse(record))
}

export function loadBindingRecord(configRoot: string, ref: BindingRef): BindingRecord | undefined {
  const parsed = bindingRecordSchema.safeParse(readJsonFile(bindingPath(configRoot, ref)))
  return parsed.success ? parsed.data : undefined
}

export function saveCredentialRecord(configRoot: string, record: CredentialRecord): void {
  writeJsonFile(credentialPath(configRoot, record), credentialRecordSchema.parse(record), { mode: FILE_MODE_SECRET })
}

export function loadCredentialRecord(configRoot: string, ref: CredentialRef): CredentialRecord | undefined {
  const parsed = credentialRecordSchema.safeParse(readJsonFile(credentialPath(configRoot, ref)))
  return parsed.success ? parsed.data : undefined
}

/** Remove the binding, its credential and its journal — unlink's cleanup step. */
export function removeBindingState(configRoot: string, binding: BindingRecord): void {
  removePath(bindingPath(configRoot, binding))
  removePath(credentialPath(configRoot, binding))
  removePath(journalPath(configRoot, binding))
}

function* userDirectories(configRoot: string): Generator<{ readonly usersDir: string; readonly userId: string }> {
  let originSlugs: string[]
  try {
    originSlugs = readdirSync(join(configRoot, 'origins'))
  } catch {
    return
  }
  for (const origin of originSlugs) {
    const usersDir = join(configRoot, 'origins', origin, 'users')
    let userIds: string[]
    try {
      userIds = readdirSync(usersDir)
    } catch {
      continue
    }
    for (const userId of userIds) yield { usersDir, userId }
  }
}

/** Every valid binding on this machine, across origins and accounts. */
export function scanBindingRecords(configRoot: string): BindingRecord[] {
  const found: BindingRecord[] = []
  for (const { usersDir, userId } of userDirectories(configRoot)) {
    const bindingsDir = join(usersDir, userId, 'bindings')
    let files: string[]
    try {
      files = readdirSync(bindingsDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const parsed = bindingRecordSchema.safeParse(readJsonFile(join(bindingsDir, file)))
      if (parsed.success) found.push(parsed.data)
    }
  }
  return found
}

/** Bindings whose directory key matches — one entry per origin/account pair. */
export function findBindingRecordsForPath(configRoot: string, directoryKey: string): BindingRecord[] {
  return scanBindingRecords(configRoot).filter((binding) => binding.path === directoryKey)
}

/** All credential file paths on this machine, for doctor's permission check. */
export function scanCredentialFilePaths(configRoot: string): string[] {
  const paths: string[] = []
  for (const { usersDir, userId } of userDirectories(configRoot)) {
    const credentialsDir = join(usersDir, userId, 'credentials')
    let files: string[]
    try {
      files = readdirSync(credentialsDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.endsWith('.json')) paths.push(join(credentialsDir, file))
    }
  }
  return paths
}

/**
 * Runs the journal reports as unfinished. Runner records are
 * `{ type: 'run', runId, status, ... }`; the LAST status per run wins. A
 * queued or in-flight run keeps unlink on hold — never delete recovery
 * evidence while something may still be executing.
 */
export function activeRunIds(journal: Journal): string[] {
  const latest = new Map<string, string>()
  for (const record of journal.records()) {
    if (typeof record !== 'object' || record === null) continue
    const { type, runId, status } = record as { type?: unknown; runId?: unknown; status?: unknown }
    if (type !== 'run' || typeof runId !== 'string' || typeof status !== 'string') continue
    latest.set(runId, status)
  }
  return [...latest.entries()]
    .filter(([, status]) => (AGENT_RUN_NON_TERMINAL_STATUSES as readonly string[]).includes(status))
    .map(([runId]) => runId)
}

export interface DirectoryIdentity {
  /** The binding key: git repo root when inside a repo, else realpath of the directory. */
  readonly key: string
  readonly label: string
  readonly isRepo: boolean
}

/**
 * Normalize the runtime directory (plan §5.2): resolve symlinks with realpath,
 * then bind git checkouts at their REAL repo root so running from any
 * subdirectory — or through a symlink — finds the same binding.
 */
export function resolveDirectoryIdentity(cwd: string, exec: Exec): DirectoryIdentity {
  const real = realpathSync(cwd)
  const git = exec('git', ['-C', real, 'rev-parse', '--show-toplevel'])
  const top = git.code === 0 ? git.stdout.trim() : ''
  if (top !== '') {
    const key = realpathSync(top)
    return { key, label: basename(key), isRepo: true }
  }
  return { key: real, label: basename(real), isRepo: false }
}
