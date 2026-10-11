import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { uuidSchema } from '@vikan/sdk/agent'
import { originDir, type BindingRef } from './binding.ts'
import { writeJsonFile } from './files.ts'

const id = z.string().min(1)
const ownerSchema = z.strictObject({
  version: z.literal(1), runId: uuidSchema, agentName: id, session: id,
  workspaceId: id, tabId: id, cwd: id,
  phase: z.enum(['creating', 'pane-created', 'starting', 'started']),
  paneId: id.nullable(), terminalId: id.nullable(), occupantId: id.nullable(),
  agentSession: id.nullable(),
})
export type HerdrOwner = z.infer<typeof ownerSchema>

/** The runner's directory lock serializes writers. Persist intent before
 * split/start, and identity before returning to the dispatcher. Missing
 * receipts are never recovered by adopting a similarly named live agent. */
export class HerdrOwnerStore {
  readonly root: string
  constructor(configDir: string, binding: BindingRef) {
    this.root = join(originDir(configDir, binding.apiOrigin), 'users', binding.userId, 'herdr', binding.bindingId)
  }
  private path(runId: string): string { return join(this.root, `${uuidSchema.parse(runId)}.json`) }
  load(runId: string): HerdrOwner | undefined {
    const path = this.path(runId)
    if (!existsSync(path)) return undefined
    const record = ownerSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (record.runId !== runId) throw new Error('Herdr ownership record does not match the run.')
    return record
  }
  save(record: HerdrOwner): void {
    writeJsonFile(this.path(record.runId), ownerSchema.parse(record), { mode: 0o600 })
  }
}
