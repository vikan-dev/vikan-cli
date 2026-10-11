import { AGENT_PROTOCOL_VERSION } from '@vikan/sdk/agent'
import { uuidSchema } from '@vikan/sdk/agent'
import { z } from 'zod'
import { apiFailure, apiFailureMessage, type VikanApiClient } from '../api/client.ts'
import { generateSecret, sha256Hex } from './secrets.ts'
import {
  pendingPath,
  saveBindingRecord,
  saveCredentialRecord,
  type BindingRecord,
} from '../state/binding.ts'
import { FILE_MODE_SECRET, readJsonFile, removePath, writeJsonFile } from '../state/files.ts'

/**
 * The browser pairing flow (plan §6.1, todo 05 T1):
 *
 *   1. persist two independent high-entropy secrets (pairing secret + device
 *      credential) BEFORE anything crosses the wire — only their SHA-256
 *      digests are ever sent;
 *   2. create the link request (idempotent per pairing-secret hash, so a
 *      create whose response was lost replays the SAME request);
 *   3. print the verification URL and user code, try to open a browser;
 *   4. poll claim with the same request identity until approved — a claim
 *      whose response was lost simply retries: replays return the same
 *      binding, and the credential is already safe on disk;
 *   5. on success persist the binding (7 identity fields) and credential.
 *
 * A reused pending request that turns out to be dead server-side is retried
 * ONCE with fresh secrets; rejected/expired/conflict are distinct, explicit
 * outcomes. Nothing in this module prints secrets.
 */

export type PairingOutcome =
  | { kind: 'linked'; binding: BindingRecord }
  | { kind: 'expired' }
  | { kind: 'rejected' }
  | { kind: 'conflict' }
  | { kind: 'rate-limited' }
  | { kind: 'network' }
  | { kind: 'failed'; reason: string }

/** Internal: the reused request identity is dead — regenerate and retry once. */
type AttemptOutcome = PairingOutcome | { kind: 'stale' }

const pendingPairingSchema = z.strictObject({
  apiOrigin: z.url(),
  directoryKey: z.string().min(1),
  directoryLabel: z.string().min(1),
  deviceName: z.string().min(1),
  cliVersion: z.string().min(1),
  pairingSecret: z.string().min(32),
  deviceCredential: z.string().min(32),
  createdAt: z.string().min(1),
  requestId: uuidSchema.nullable(),
  userCode: z.string().nullable(),
  verificationUrl: z.url().nullable(),
  expiresAt: z.string().nullable(),
  pollIntervalSeconds: z.number().int().min(1).nullable(),
})

interface PendingPairing {
  readonly apiOrigin: string
  readonly directoryKey: string
  readonly directoryLabel: string
  readonly deviceName: string
  readonly cliVersion: string
  readonly pairingSecret: string
  readonly deviceCredential: string
  readonly createdAt: string
  requestId: string | null
  userCode: string | null
  verificationUrl: string | null
  expiresAt: string | null
  pollIntervalSeconds: number | null
}

export interface PairingIo {
  out(text: string): void
  /** Returns false when no browser was opened (the URL must be shown for copying). */
  openBrowser: (url: string) => boolean
}

export interface PairingParams {
  readonly api: VikanApiClient
  readonly configRoot: string
  readonly apiOrigin: string
  readonly directoryKey: string
  readonly directoryLabel: string
  readonly deviceName: string
  readonly cliVersion: string
  readonly io: PairingIo
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export async function runPairing(params: PairingParams): Promise<PairingOutcome> {
  for (let round = 0; round < 2; round++) {
    const reuse = round === 0
    let pending = reuse ? loadPending(params) : undefined
    if (pending !== undefined && pending.expiresAt !== null && Date.parse(pending.expiresAt) <= params.now()) {
      deletePending(params)
      pending = undefined
    }
    if (pending === undefined) {
      pending = newPending(params)
      savePending(params, pending)
    }
    const outcome = await attemptWithPending(params, pending, pending.requestId !== null)
    if (outcome.kind === 'stale') continue
    return outcome
  }
  return { kind: 'failed', reason: 'Pairing could not be established after retrying with fresh secrets.' }
}

function loadPending(params: PairingParams): PendingPairing | undefined {
  const parsed = pendingPairingSchema.safeParse(
    readJsonFile(pendingPath(params.configRoot, params.apiOrigin, params.directoryKey)),
  )
  return parsed.success ? parsed.data : undefined
}

function newPending(params: PairingParams): PendingPairing {
  return {
    apiOrigin: params.apiOrigin,
    directoryKey: params.directoryKey,
    directoryLabel: params.directoryLabel,
    deviceName: params.deviceName,
    cliVersion: params.cliVersion,
    pairingSecret: generateSecret(),
    deviceCredential: generateSecret(),
    createdAt: new Date(params.now()).toISOString(),
    requestId: null,
    userCode: null,
    verificationUrl: null,
    expiresAt: null,
    pollIntervalSeconds: null,
  }
}

function savePending(params: PairingParams, pending: PendingPairing): void {
  writeJsonFile(pendingPath(params.configRoot, pending.apiOrigin, pending.directoryKey), pending, {
    mode: FILE_MODE_SECRET,
  })
}

function deletePending(params: PairingParams): void {
  removePath(pendingPath(params.configRoot, params.apiOrigin, params.directoryKey))
}

async function attemptWithPending(params: PairingParams, pending: PendingPairing, reused: boolean): Promise<AttemptOutcome> {
  // Create with hashes only; retry the same identity when the response is lost.
  let created: Awaited<ReturnType<VikanApiClient['createLinkRequest']>> | undefined
  for (let attempt = 0; created === undefined; attempt++) {
    try {
      created = await params.api.createLinkRequest({
        pairingSecretHash: sha256Hex(pending.pairingSecret),
        deviceCredentialHash: sha256Hex(pending.deviceCredential),
        deviceName: pending.deviceName,
        cliVersion: pending.cliVersion,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        directoryKey: pending.directoryKey,
        directoryLabel: pending.directoryLabel,
      })
    } catch (error) {
      const failure = apiFailure(error)
      if (failure.kind === 'network' || failure.kind === 'timeout') {
        if (attempt >= 2) return { kind: 'network' }
        await params.sleep(5_000)
        continue
      }
      if (failure.kind === 'problem' && failure.code === 'rate_limited') {
        return { kind: 'rate-limited' }
      }
      return { kind: 'failed', reason: apiFailureMessage(failure) }
    }
  }

  pending.requestId = created.requestId
  pending.userCode = created.userCode
  pending.verificationUrl = created.verificationUrl
  pending.expiresAt = created.expiresAt
  pending.pollIntervalSeconds = created.pollIntervalSeconds
  savePending(params, pending)

  announce(params, pending)

  const deadline = Date.parse(created.expiresAt)
  const intervalMs = (pending.pollIntervalSeconds ?? 5) * 1_000
  while (params.now() < deadline) {
    await params.sleep(intervalMs)
    try {
      const claimed = await params.api.claimLinkRequest(created.requestId, pending.pairingSecret)
      if (claimed.directoryKey !== pending.directoryKey) {
        deletePending(params)
        return { kind: 'failed', reason: 'The server returned a binding for a different directory; refusing to save it.' }
      }
      const binding = persistClaimed(params, pending, claimed)
      deletePending(params)
      return { kind: 'linked', binding }
    } catch (error) {
      const failure = apiFailure(error)
      // Unknown outcomes (network/timeout) keep polling: claim is idempotent.
      if (failure.kind === 'network' || failure.kind === 'timeout') continue
      if (failure.kind === 'problem') {
        if (failure.code === 'link_pending' || failure.code === 'rate_limited') continue
        if (failure.code === 'link_gone' || failure.code === 'link_not_found') {
          deletePending(params)
          return classifyGone(failure.title, reused)
        }
      }
      return { kind: 'failed', reason: apiFailureMessage(failure) }
    }
  }
  deletePending(params)
  return { kind: 'expired' }
}

/**
 * `link_gone` is the server's uniform terminal refusal. The directory
 * conflict is a hard stop; an identity carried over from a previous run is
 * stale and gets one regeneration; anything else names its own reason.
 */
function classifyGone(title: string, reused: boolean): AttemptOutcome {
  if (title.includes('already linked')) return { kind: 'conflict' }
  if (reused) return { kind: 'stale' }
  if (title.toLowerCase().includes('reject')) return { kind: 'rejected' }
  if (title.toLowerCase().includes('expire')) return { kind: 'expired' }
  return { kind: 'failed', reason: title }
}

function persistClaimed(
  params: PairingParams,
  pending: PendingPairing,
  claimed: Awaited<ReturnType<VikanApiClient['claimLinkRequest']>>,
): BindingRecord {
  const binding: BindingRecord = {
    apiOrigin: params.apiOrigin,
    userId: claimed.userId,
    workspaceId: claimed.workspaceId,
    projectId: claimed.projectId,
    deviceId: claimed.deviceId,
    bindingId: claimed.bindingId,
    path: pending.directoryKey,
    directoryLabel: pending.directoryLabel,
    claimedAt: claimed.claimedAt,
    lastConfirmedAt: new Date(params.now()).toISOString(),
    agentPageUrl: claimed.agentPageUrl,
  }
  saveBindingRecord(params.configRoot, binding)
  saveCredentialRecord(params.configRoot, {
    apiOrigin: params.apiOrigin,
    userId: claimed.userId,
    bindingId: claimed.bindingId,
    deviceId: claimed.deviceId,
    credential: pending.deviceCredential,
  })
  return binding
}

function announce(params: PairingParams, pending: PendingPairing): void {
  const url = pending.verificationUrl
  const code = pending.userCode
  if (url === null || code === null) return
  const minutes = Math.max(1, Math.round((Date.parse(pending.expiresAt ?? '') - params.now()) / 60_000))
  params.io.out(
    `\nVerify this device in the browser (code ${code}, valid about ${minutes} minute${minutes === 1 ? '' : 's'}):\n\n  ${url}\n\n`,
  )
  params.io.out(
    params.io.openBrowser(url)
      ? 'Opening the verification page in your browser.\n'
      : 'No local browser was opened — open the URL on this or any other device.\n',
  )
}
