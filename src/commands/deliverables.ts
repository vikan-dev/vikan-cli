import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { uuidSchema } from '@vikan/sdk/agent'
import { agentDeliverableClaimSchema } from '@vikan/sdk/agent'
import { FILE_MAX_BYTES, fileMimeTypeSchema, normalizeFileMimeType } from '@vikan/sdk/agent'
import { DELIVERABLE_BODY_MAX_BYTES, parseIssueDeliverablesSummary } from '@vikan/sdk/agent'
import { ApiCallError, apiFailure, createVikanApiClient, type ApiFailure } from '../api/client.ts'
import { findBindingRecordsForPath, loadCredentialRecord, resolveDirectoryIdentity } from '../state/binding.ts'
import { RunnerJournal } from '../state/journal.ts'
import { acquireDirectoryLock } from '../state/directory-lock.ts'
import { bytesHash, DeliverableLocalError, DeliverableStore, deliverableRequestSchema,
  type DeliverableRecord, type DeliverableRequest, type DeliverableReceipt } from '../state/deliverables.ts'
import { EXIT_AUTH, EXIT_CONFLICT, EXIT_CONTEXT, EXIT_FAILURE, EXIT_OK, EXIT_UNCONFIRMED, EXIT_USAGE } from '../exit.ts'
import { deliverablesCommand } from '../runner/deliverables.ts'
import type { CliDeps } from './types.ts'
import { runRenderPlanCommand } from './render-plan.ts'

export const deliverablesHelp = `Usage: vikan deliverables <command> [options]

Local command (no run, pairing, Herdr or network):
  render-plan        --source <plan.md> --output <plan.html> (see render-plan --help / --licenses)

Run commands (require --run <UUID>):
  context            Read the authorized issue/run summary and local operation receipts
  status             Read local receipts only (last confirmed, no network)
  publish-stage       --manifest <path>
  publish-findings   --manifest <path> (issue-less explore runs)
  project-document   --manifest <path> (project-document Agent result)
  upload             --file <path> --operation-id <UUID> [--mime <type>]
  finish-stage  --stage <UUID> --manifest <path>
  retry              --operation-id <UUID> (uses saved input/bytes, current claim)

Run from the paired checkout in this run's Herdr pane. --run is an identity
check, never authority: pairing and the runner journal provide authentication.
No credential, sessionId, claimEpoch, owner or sourceRunId belongs in arguments
or manifests. All successes are JSON on stdout; guidance goes to stderr.

Manifests use the shared contract:
  publish-stage: operationId, stage (plan|design|validation|another-key), expectedLatestStageId (UUID or null), title, summary, document
                  Optional: status (completed by default, or running), basedOnStageId, checks, files
  finish-stage: operationId, expectedVersion, status (completed|failed), summary,
                      document, checks, files, failureReason (null unless failed)
  publish-findings: operationId, findings: [{ title, body }] (1-50 entries;
                      the exploration's discoveries, plain text incl. Markdown)
  document: {"format":"text","text":"Literal text, including Markdown"}
          or {"format":"json","content":{"type":"doc","content":[{"type":"paragraph"}]}}
  check: {"id":"typecheck","title":"Types","status":"passed","command":"bun run typecheck","detail":null}
  file: {"fileId":"UUID from upload receipt","posterFileId":null,"caption":"Actual evidence","checkIds":[]}

Use a saved UUID per logical action; repeat it with the same input to recover
the server receipt. A new stage revision needs a new UUID.
Uploads copy only the explicit file (max 50 MiB); default MIME comes from its
extension, while preview capability is verified by the server. Retry retains
the original bytes even if the source is removed. status/context show which
operations committed. Files/posters must have ready upload receipts for this run.
Finish replaces the complete checks/files set. completed means execution ended,
not that checks passed or a human accepted it. Empty checks never mean passed.

Exit: 0 success, 1 local failure, 2 invalid arguments/manifest, 3 authentication,
      4 directory/pane/run/session mismatch, 5 unconfirmed/retryable, 6 conflict.
  -h, --help  Show this help without pairing or network
`

const optionsByCommand = {
  context: [], status: [], 'publish-stage': ['manifest'],
  'publish-findings': ['manifest'], 'project-document': ['manifest'],
  upload: ['file', 'operation-id', 'mime'], 'finish-stage': ['stage', 'manifest'], retry: ['operation-id'],
} as const
type Command = keyof typeof optionsByCommand
function parseArgs(argv: readonly string[]) {
  const command = argv[0] as Command
  if (!Object.hasOwn(optionsByCommand, command)) throw new DeliverableLocalError(EXIT_USAGE, 'Choose a deliverables command; see deliverables --help.')
  const allowed: readonly string[] = ['run', ...optionsByCommand[command]]
  const values: Record<string, string> = {}
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || !value || value.startsWith('--') || values[flag.slice(2)] !== undefined) {
      throw new DeliverableLocalError(EXIT_USAGE, 'Unknown, duplicate or missing option; see deliverables --help.')
    }
    values[flag.slice(2)] = value
  }
  for (const key of allowed.filter(key => key !== 'mime')) {
    if (!values[key]) throw new DeliverableLocalError(EXIT_USAGE, `Missing --${key}; see deliverables --help.`)
  }
  for (const key of ['run', 'operation-id', 'stage']) {
    if (values[key]) values[key] = uuidSchema.parse(values[key]).toLowerCase()
  }
  if (values.mime) fileMimeTypeSchema.parse(values.mime)
  return { command, values, runId: values.run! }
}

/** Never open FIFOs/devices or scan directories; bound reads even if a file grows. */
function readInput(path: string, limit: number): Buffer {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > limit) throw new Error('size/type')
    const bytes = Buffer.alloc(info.size + 1)
    // readFileSync would allow a concurrently growing file to exceed the limit.
    let size = 0, count: number
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count
    if (size > info.size) throw new Error('changed')
    return bytes.subarray(0, size)
  } catch { throw new DeliverableLocalError(EXIT_USAGE, `Input must be a readable regular file of at most ${limit} bytes. Saved operations can be retried without the source file.`) }
  finally { if (fd !== undefined) closeSync(fd) }
}

function localContext(deps: CliDeps, runId: string) {
  const directory = resolveDirectoryIdentity(deps.cwd(), deps.exec)
  const bindings = findBindingRecordsForPath(deps.configDir, directory.key)
  if (bindings.length !== 1) throw new DeliverableLocalError(EXIT_CONTEXT, 'Use the single paired checkout for this run. Run link in its Herdr pane if this directory is not paired.')
  const binding = bindings[0]!
  if (deps.apiOrigin && new URL(deps.apiOrigin).origin !== new URL(binding.apiOrigin).origin) {
    throw new DeliverableLocalError(EXIT_CONTEXT, 'VIKAN_API_URL differs from this directory binding; use its paired API origin.')
  }
  const credential = loadCredentialRecord(deps.configDir, binding)
  if (!credential || credential.bindingId !== binding.bindingId || credential.userId !== binding.userId
    || credential.apiOrigin !== binding.apiOrigin || credential.deviceId !== binding.deviceId) {
    throw new DeliverableLocalError(EXIT_AUTH, 'Pairing credential is missing or mismatched. Restore this binding credential or pair again with link; keep saved submissions.')
  }
  const journal = RunnerJournal.open(deps.configDir, binding), local = journal.view().runs.get(runId)
  const phase = journal.view().runPhases.get(runId)
  if (!local || !local.sessionId || !local.claimEpoch || local.uncertain || !['prompt_dispatching', 'prompt_acknowledged'].includes(phase ?? '')) {
    throw new DeliverableLocalError(EXIT_CONTEXT, 'This run has no confirmed local execution context. Resume/reconcile its runner before submitting; do not copy a claim from another run.')
  }
  const herdr = deps.detectHerdr()
  if (!herdr.ok || herdr.info.paneId !== local.paneId
    || (herdr.info.socketPath ?? herdr.info.sessionName ?? herdr.info.paneId) !== local.herdrSessionId) {
    throw new DeliverableLocalError(EXIT_CONTEXT, "Use this run's Herdr pane and paired directory; the current pane/session does not match the runner journal.")
  }
  const claim = agentDeliverableClaimSchema.parse({ sessionId: local.sessionId, claimEpoch: local.claimEpoch })
  const api = createVikanApiClient({ apiOrigin: binding.apiOrigin, credential: credential.credential, fetch: deps.fetch })
  return { binding, api, claim, store: new DeliverableStore(deps.configDir, binding) }
}
type Context = ReturnType<typeof localContext>
/** Findings are the issue-less sibling: only stage commands demand an issue. */
async function serverContext(context: Context, runId: string, options: { requiresIssue?: boolean; requiresProjectDocument?: boolean } = {}) {
  const { binding, api, claim } = context, run = await api.getRun(runId)
  if (run.runId !== runId || run.bindingId !== binding.bindingId || run.workspaceId !== binding.workspaceId
    || run.projectId !== binding.projectId || run.claimEpoch !== claim.claimEpoch
    || (options.requiresProjectDocument ? !run.projectDocumentId : options.requiresIssue !== false && !run.issueId)) {
    throw new DeliverableLocalError(EXIT_CONTEXT, 'Server run identity, target or claim differs from this runner. Reconcile the original run before submitting.')
  }
  return { runId, workspaceId: run.workspaceId, projectId: run.projectId, issueId: run.issueId, projectDocumentId: run.projectDocumentId ?? null, status: run.status }
}
function operations(store: DeliverableStore, runId: string) {
  return store.list(runId).map(record => ({ operationId: record.request.input.operationId, command: record.request.kind,
    state: record.state, receipt: record.receipt, lastError: record.lastError }))
}
function checkReadyFiles(context: Context, record: DeliverableRecord): void {
  if (record.request.kind !== 'publish-stage' && record.request.kind !== 'finish-stage') return
  const ready = new Set(context.store.list(record.runId).flatMap(saved => saved.receipt && 'file' in saved.receipt ? [saved.receipt.file.fileId] : []))
  for (const file of record.request.input.files) {
    if (!ready.has(file.fileId.toLowerCase()) || file.posterFileId && !ready.has(file.posterFileId.toLowerCase())) {
      throw new DeliverableLocalError(EXIT_CONFLICT, 'Evidence needs ready upload receipts for this run. Upload the explicit files, or retry unconfirmed upload operations, then use their fileIds.')
    }
  }
}
async function submit(context: Context, record: DeliverableRecord): Promise<DeliverableReceipt> {
  const { api, claim } = context, request = record.request
  switch (request.kind) {
    case 'publish-stage': return api.publishStage(record.runId, { ...request.input, ...claim })
    case 'finish-stage': return api.finishStage(record.runId, request.stageId, { ...request.input, ...claim })
    case 'publish-findings': return api.publishFindings(record.runId, { ...request.input, ...claim })
    case 'project-document': return api.submitProjectDocumentResult(record.runId, { ...request.input, ...claim })
    case 'upload': return api.uploadDeliverableFile(record.runId, { operationId: request.input.operationId, ...claim }, context.store.file(record))
  }
}
function classified(failure: ApiFailure): DeliverableLocalError {
  if (failure.kind !== 'problem') return new DeliverableLocalError(EXIT_UNCONFIRMED, 'No trustworthy server receipt (network, timeout or invalid response). Outcome is unconfirmed; retry the saved operation unchanged.')
  const code = failure.code
  if (failure.status === 401) return new DeliverableLocalError(EXIT_AUTH, `${code}: device credential expired or revoked. Restore pairing with link, retain saved input, and retry only under the original binding.`)
  if (['stale_version', 'run_invalidated'].includes(code) || [403, 404].includes(failure.status)) {
    return new DeliverableLocalError(EXIT_CONTEXT, `${code}: run/session/claim or issue access is no longer valid. Resume/reconcile the runner or restore access before retrying the same operation.`)
  }
  if (['deliverable_result_unconfirmed', 'file_upload_in_progress', 'storage_unavailable', 'rate_limited', 'request_cancelled'].includes(code) || failure.status >= 500) {
    return new DeliverableLocalError(EXIT_UNCONFIRMED, `${code}: completion is unconfirmed or retryable. Retry the saved operation unchanged; do not mint a new UUID.`)
  }
  return new DeliverableLocalError(EXIT_CONFLICT, `${code}: server refused this input. Inspect context/status and the expected stage/version or file references. Preserve the operation; changed input requires a new UUID.`)
}

export async function runDeliverablesCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  if (argv[0] === 'render-plan') return runRenderPlanCommand(argv.slice(1), deps)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) { deps.io.out(deliverablesHelp); return EXIT_OK }
  let saved: DeliverableRecord | undefined, context: Context | undefined
  let previouslyUnconfirmed = false
  let release: (() => void) | undefined
  try {
    const { command, values, runId } = parseArgs(argv)
    context = localContext(deps, runId)
    if (command === 'status') {
      deps.io.out(JSON.stringify({ runId, source: 'local-last-confirmed', operations: operations(context.store, runId) }) + '\n')
      return EXIT_OK
    }
    if (command === 'context') {
    const scope = await serverContext(context, runId)
    const issueId = scope.issueId
    if (!issueId) throw new DeliverableLocalError(EXIT_CONTEXT, 'The context summary needs an issue run; issue-less runs report through publish-findings.')
      const raw = await context.api.deliverablesSummary(runId, context.claim)
      let summary: ReturnType<typeof parseIssueDeliverablesSummary>
      try { summary = parseIssueDeliverablesSummary(raw, { ...scope, issueId, userId: context.binding.userId }) }
      catch { throw new ApiCallError({ kind: 'invalid-output' }) }
      deps.io.out(JSON.stringify({ ...scope, summary, operations: operations(context.store, runId) }) + '\n')
      return EXIT_OK
    }
    let request: DeliverableRequest | undefined, bytes: Buffer | undefined
    if (command !== 'retry') {
      if (command === 'upload') {
        const path = resolve(deps.cwd(), values.file!)
        bytes = readInput(path, FILE_MAX_BYTES)
        request = deliverableRequestSchema.parse({ kind: command, input: { operationId: values['operation-id'],
          filename: basename(path), mimeType: values.mime ?? normalizeFileMimeType(Bun.file(path).type), byteSize: bytes.length, sha256: bytesHash(bytes) } })
      } else {
        let input: unknown
        try { input = JSON.parse(readInput(resolve(deps.cwd(), values.manifest!), DELIVERABLE_BODY_MAX_BYTES).toString('utf8')) }
        catch (error) {
          if (error instanceof DeliverableLocalError) throw error
          throw new DeliverableLocalError(EXIT_USAGE, 'Manifest must contain a JSON object matching deliverables --help.')
        }
        request = deliverableRequestSchema.parse({ kind: command, input, ...(command === 'finish-stage' ? { stageId: values.stage } : {}) })
      }
    }
    const operationId = request?.input.operationId ?? values['operation-id']!
    const lock = acquireDirectoryLock(join(context.store.root, 'locks'), operationId.toLowerCase())
    if (!lock.ok) throw new DeliverableLocalError(EXIT_UNCONFIRMED, 'This operation is being submitted by another local process. Wait for it, then retry the same operationId.')
    release = () => lock.lock.release()
    const existing = context.store.load(operationId)
    if (existing?.runId === runId) {
      saved = existing
      previouslyUnconfirmed = existing.state === 'unconfirmed'
    }
    const record = request ? context.store.prepare(runId, request, bytes) : existing
    if (!record) throw new DeliverableLocalError(EXIT_USAGE, 'No saved operation for this UUID; use the original manifest/upload command first.')
    if (record.runId !== runId) throw new DeliverableLocalError(EXIT_CONTEXT, 'This operation belongs to a different run; return to its original pane and directory.')
    saved = record
    previouslyUnconfirmed = record.state === 'unconfirmed'
    const scope = await serverContext(context, runId, {
      requiresIssue: saved.request.kind !== 'publish-findings' && saved.request.kind !== 'project-document',
      requiresProjectDocument: saved.request.kind === 'project-document',
    })
    checkReadyFiles(context, saved)
    saved.state = saved.receipt ? 'committed' : 'unconfirmed'
    context.store.save(saved)
    const receipt = await submit(context, saved)
    if (saved.request.kind === 'publish-findings') {
      if (!('runId' in receipt) || receipt.operationId.toLowerCase() !== operationId.toLowerCase()
        || receipt.runId !== scope.runId || receipt.workspaceId !== scope.workspaceId
        || receipt.count !== saved.request.input.findings.length) {
        throw new ApiCallError({ kind: 'invalid-output' })
      }
    } else if (saved.request.kind === 'project-document') {
      if (!('documentId' in receipt) || !('format' in receipt)
        || receipt.operationId.toLowerCase() !== operationId.toLowerCase() || receipt.documentId !== scope.projectDocumentId
        || receipt.format !== saved.request.input.format) throw new ApiCallError({ kind: 'invalid-output' })
    } else {
      if (!('file' in receipt) && !('result' in receipt)) throw new ApiCallError({ kind: 'invalid-output' })
      const identity = 'file' in receipt ? receipt.file : receipt.result
      if (receipt.operationId.toLowerCase() !== operationId.toLowerCase() || identity.workspaceId !== scope.workspaceId
        || ('file' in receipt ? receipt.file.owner?.type !== 'issue' || receipt.file.owner.externalId !== scope.issueId || receipt.file.uploaderId !== context.binding.userId
          : receipt.result.issueId !== scope.issueId)
        || saved.request.kind === 'upload' && 'file' in receipt && (receipt.file.filename !== saved.request.input.filename || receipt.file.byteSize !== saved.request.input.byteSize)
        || saved.request.kind === 'publish-stage' && !('file' in receipt) && receipt.result.stage !== saved.request.input.stage
        || saved.request.kind === 'finish-stage' && !('file' in receipt) && receipt.result.stageId !== saved.request.stageId) {
        throw new ApiCallError({ kind: 'invalid-output' })
      }
    }
    const confirmed: DeliverableRecord = { ...saved, receipt, state: 'committed', lastError: null }
    try { context.store.save(confirmed) }
    catch { throw new DeliverableLocalError(EXIT_UNCONFIRMED, 'Server returned a receipt, but local receipt persistence failed. Retry the saved operation unchanged to recover that receipt.') }
    saved = confirmed
    deps.io.out(JSON.stringify(receipt) + '\n')
    return EXIT_OK
  } catch (error) {
    const failure = error instanceof DeliverableLocalError ? error : error instanceof z.ZodError
      ? new DeliverableLocalError(EXIT_USAGE, `Invalid contract input at ${error.issues.map(issue => issue.path.join('.') || 'manifest').join(', ')}; see deliverables --help.`)
      : error instanceof ApiCallError ? classified(apiFailure(error))
        : new DeliverableLocalError(EXIT_FAILURE, 'Local submission could not complete. Preserve the saved input and inspect local file permissions/state before retrying.')
    deps.io.err(`vikan deliverables: ${failure.message}\n`)
    if (saved && context) {
      // An expired claim on a later attempt cannot resolve an earlier lost
      // commit response. Keep uncertainty until the server returns a receipt.
      saved.state = saved.receipt ? 'committed' : previouslyUnconfirmed || failure.exitCode === EXIT_UNCONFIRMED ? 'unconfirmed' : 'refused'
      saved.lastError = failure.message
      try { context.store.save(saved) } catch { deps.io.err('Could not update local status; the previous input/receipt remains the recovery source.\n') }
      deps.io.err(`${saved.receipt ? 'A previous server receipt is retained.' : 'Input retained; no committed receipt confirmed locally.'}\nRetry: ${deliverablesCommand(deps.invocation, deps.configDir, context.binding.apiOrigin)} retry --run ${saved.runId} --operation-id ${saved.request.input.operationId}\nUse status --run ${saved.runId} to inspect successful uploads and receipts.\n`)
    }
    return failure.exitCode
  } finally { release?.() }
}
