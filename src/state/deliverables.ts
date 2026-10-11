import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { uuidSchema } from '@vikan/sdk/agent'
import { fileByteSizeSchema, fileMimeTypeSchema, fileNameSchema, fileUploadResultSchema } from '@vikan/sdk/agent'
import { publishIssueStageSubmissionSchema, finishIssueStageSubmissionSchema,
  publishIssueStageResultSchema, finishIssueStageResultSchema } from '@vikan/sdk/agent'
import { agentFindingsManifestSchema, agentFindingsPublishResultSchema } from '@vikan/sdk/agent'
import { projectDocumentResultManifestSchema, projectDocumentResultAckSchema } from '@vikan/sdk/agent'
import { originDir, type BindingRecord } from './binding.ts'
import { writeJsonFile } from './files.ts'
import { EXIT_CONFLICT, EXIT_FAILURE } from '../exit.ts'

export class DeliverableLocalError extends Error {
  constructor(readonly exitCode: number, message: string) { super(message) }
}

// Submission DTOs come directly from contract. Only disk bookkeeping is local.
export const deliverableRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('publish-stage'), input: publishIssueStageSubmissionSchema }),
  z.strictObject({ kind: z.literal('finish-stage'), stageId: uuidSchema, input: finishIssueStageSubmissionSchema }),
  z.strictObject({ kind: z.literal('publish-findings'), input: agentFindingsManifestSchema }),
  z.strictObject({ kind: z.literal('project-document'), input: projectDocumentResultManifestSchema }),
  z.strictObject({ kind: z.literal('upload'), input: z.strictObject({ operationId: uuidSchema,
    filename: fileNameSchema, mimeType: fileMimeTypeSchema, byteSize: fileByteSizeSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }),
])
export type DeliverableRequest = z.infer<typeof deliverableRequestSchema>
const receiptSchema = z.union([publishIssueStageResultSchema, finishIssueStageResultSchema, agentFindingsPublishResultSchema, projectDocumentResultAckSchema, fileUploadResultSchema])
export type DeliverableReceipt = z.infer<typeof receiptSchema>
const recordSchema = z.strictObject({
  version: z.literal(1), runId: uuidSchema, request: deliverableRequestSchema,
  state: z.enum(['prepared', 'unconfirmed', 'refused', 'committed']),
  receipt: receiptSchema.nullable(), lastError: z.string().nullable(),
})
export type DeliverableRecord = z.infer<typeof recordSchema>

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A separate ledger from the live runner journal: submission processes never
 * append stale run/session state. Inputs and copied bytes are fsync'd BEFORE
 * HTTP; kernel locks serialize competing processes for the same operation. */
export class DeliverableStore {
  readonly root: string
  constructor(configDir: string, binding: BindingRecord) {
    this.root = join(originDir(configDir, binding.apiOrigin), 'users', binding.userId, 'deliverables', binding.bindingId)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  private path(operationId: string): string { return join(this.root, `${uuidSchema.parse(operationId).toLowerCase()}.json`) }
  private bytesPath(operationId: string): string { return join(this.root, `${uuidSchema.parse(operationId).toLowerCase()}.bin`) }
  load(operationId: string): DeliverableRecord | undefined {
    const path = this.path(operationId)
    if (!existsSync(path)) return undefined
    try {
      const record = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (record.request.input.operationId.toLowerCase() !== operationId.toLowerCase()
        || record.receipt && record.receipt.operationId.toLowerCase() !== operationId.toLowerCase()) throw new Error('identity')
      return record
    } catch { throw new DeliverableLocalError(EXIT_FAILURE, 'Saved submission is damaged; preserve the deliverables directory and inspect it before retrying.') }
  }
  list(runId: string): DeliverableRecord[] {
    return readdirSync(this.root).filter(name => name.endsWith('.json')).map(name => this.load(name.slice(0, -5))!)
      .filter(record => record.runId === runId)
  }
  save(record: DeliverableRecord): void {
    writeJsonFile(this.path(record.request.input.operationId), recordSchema.parse(record), { mode: 0o600 })
  }
  prepare(runId: string, request: DeliverableRequest, bytes?: Uint8Array): DeliverableRecord {
    const existing = this.load(request.input.operationId)
    if (existing) {
      if (existing.runId !== runId || canonicalJson(existing.request) !== canonicalJson(request)) {
        throw new DeliverableLocalError(EXIT_CONFLICT, 'This operationId already has different input or a different run. Retry the saved operation, or use a new UUID for a genuinely new submission.')
      }
      return existing
    }
    if (request.kind === 'upload') {
      if (!bytes || bytesHash(bytes) !== request.input.sha256 || bytes.length !== request.input.byteSize) throw new Error('Invalid upload snapshot')
      const path = this.bytesPath(request.input.operationId), tmp = `${path}.${randomUUID()}.tmp`
      writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' })
      const fd = openSync(tmp, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, path)
      // save() fsyncs the same parent directory, persisting both renames.
    }
    const record: DeliverableRecord = { version: 1, runId, request, state: 'prepared', receipt: null, lastError: null }
    this.save(record)
    return record
  }
  file(record: DeliverableRecord): File {
    if (record.request.kind !== 'upload') throw new Error('Not an upload')
    const input = record.request.input
    let bytes: Buffer
    try { bytes = readFileSync(this.bytesPath(input.operationId)) }
    catch { throw new DeliverableLocalError(EXIT_FAILURE, 'Saved upload bytes are missing. Restore the saved bytes before retrying this operationId.') }
    if (bytes.length !== input.byteSize || bytesHash(bytes) !== input.sha256) {
      throw new DeliverableLocalError(EXIT_CONFLICT, 'Saved upload bytes changed; preserve the original input and do not reuse this operationId for different bytes.')
    }
    return new File([bytes], input.filename, { type: input.mimeType })
  }
}
