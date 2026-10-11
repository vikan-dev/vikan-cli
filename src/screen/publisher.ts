import { createHash, randomUUID } from 'node:crypto'
import { AGENT_PROTOCOL_VERSION, AGENT_RUN_TERMINAL_STATUSES, SCREEN_FRAME_MAX_BYTES, screenFrameSchema } from '@vikan/sdk/agent'
import type { ActiveSubscription, VikanApiClient } from '../api/client.ts'
import type { RunnerJournal, RunnerRunEntry } from '../state/journal.ts'
import { isS2AuthFailure, type S2Transport } from '../transport/s2.ts'
import type { AgentAdapter } from '../runner/adapter.ts'
import { targetOfRun } from '../runner/reconcile.ts'

interface ScreenPublisherOptions {
  api: VikanApiClient
  adapter: AgentAdapter
  transport: S2Transport
  journal: RunnerJournal
  sessionId: string
  sessionEpoch: number
  herdrSessionId: string
  canPublish: () => boolean
  onApiError: (error: unknown) => void
  log: (message: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const CAPTURE_INTERVAL_MS = 100

/** 独立采集与上传，只保留一个在途请求和一个最新快照。
 * 慢网不会阻塞采集，也不会让旧帧积压或延迟命令、心跳和回执。 */
export class ScreenPublisher {
  private readonly abort = new AbortController()
  private runId: string | undefined
  private grant: ActiveSubscription | undefined
  private epoch: string | null = null
  private sent = ''
  private pending: { run: RunnerRunEntry; signature: string; body: string } | undefined
  private upload: Promise<void> | undefined
  private lastNotice = ''

  constructor(private readonly options: ScreenPublisherOptions) {}
  stop(): void { this.abort.abort() }

  private notice(message: string): void {
    if (message === this.lastNotice) return
    this.lastNotice = message
    this.options.log(message)
  }

  private current(): RunnerRunEntry | undefined {
    if (this.abort.signal.aborted || !this.options.canPublish()) return undefined
    return [...this.options.journal.view().runs.values()].find(run =>
      run.sessionId === this.options.sessionId && run.claimEpoch === this.options.sessionEpoch &&
      run.paneId !== null && run.occupantId !== null &&
      !(AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(run.status))
  }

  private stillCurrent(run: RunnerRunEntry): boolean {
    const current = this.current()
    return current?.runId === run.runId && current.paneId === run.paneId && current.occupantId === run.occupantId
  }

  async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const startedAt = this.options.now()
      let delay: number
      try {
        await this.captureLatest()
        delay = Math.max(0, CAPTURE_INTERVAL_MS - (this.options.now() - startedAt))
      }
      catch (error) {
        if (this.abort.signal.aborted) break
        if (isS2AuthFailure(error)) this.grant = undefined
        this.notice(`Screen preview paused — retrying. ${error instanceof Error ? error.message : 'Capture or upload failed.'}`)
        delay = 2000
      }
      if (!this.abort.signal.aborted) await this.options.sleep(delay)
    }
    await this.upload
  }

  private async captureLatest(): Promise<void> {
    const run = this.current()
    if (!run) return
    if (run.runId !== this.runId) {
      this.runId = run.runId
      this.grant = undefined
      this.epoch = null
      this.sent = ''
      this.pending = undefined
    }
    if (!this.grant || Date.parse(this.grant.tokenExpiresAt) - 60_000 <= this.options.now()) {
      let subscriptions
      try {
        subscriptions = (await this.options.api.issueSubscriptions({ protocolVersion: AGENT_PROTOCOL_VERSION,
          sessionId: this.options.sessionId, scopes: [{ kind: 'run-screens', runId: run.runId }] })).subscriptions
      } catch (error) { this.options.onApiError(error); throw error }
      if (!this.stillCurrent(run)) return
      const grant = subscriptions.find(entry => entry.kind === 'run-screens')
      if (!grant || grant.status !== 'active' || !grant.captureEpoch || !grant.operations.includes('append')) {
        throw new Error('The API has not granted screen capture for this run.')
      }
      if (grant.captureEpoch !== this.epoch) {
        this.epoch = grant.captureEpoch
        this.sent = ''
        this.pending = undefined
      }
      this.grant = grant
    }
    const snapshot = await this.options.adapter.readScreen(targetOfRun(run, this.options.herdrSessionId))
    if (!this.stillCurrent(run)) return
    if (snapshot.paneId !== run.paneId) throw new Error('Screen capture returned a different pane.')
    // Herdr 0.9.0 can report revision 0 for changing pane.read output.
    // Include content and geometry so neither output nor resize is missed.
    const signature = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    if (this.pending?.signature !== signature) {
      const frame = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'screen.frame' as const,
        runId: run.runId, captureEpoch: this.epoch!, frameId: randomUUID(),
        capturedAt: new Date(this.options.now()).toISOString(), format: 'ansi' as const, ...snapshot }
      // Limit the entire UTF-8 wire record (including JSON escaping), not
      // just JS string length. Keep the limit visible in the browser.
      if (Buffer.byteLength(JSON.stringify(frame)) > SCREEN_FRAME_MAX_BYTES) {
        frame.content = 'Screen capture is too large to display. Reduce the terminal size to resume the preview.'
        frame.truncated = true
      }
      this.pending = { run, signature, body: JSON.stringify(screenFrameSchema.parse(frame)) }
    }
    if (!this.upload) this.upload = this.uploadLatest().finally(() => { this.upload = undefined })
  }

  private async uploadLatest(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const frame = this.pending, grant = this.grant, epoch = this.epoch
      if (!frame || !grant || frame.signature === this.sent || !this.stillCurrent(frame.run)) return
      try {
        // 相同快照重试保留 frameId；上传期间 pending 可以被更新为最新快照。
        await this.options.transport.append({ basin: grant.basin, stream: grant.stream,
          token: grant.token, body: frame.body, signal: this.abort.signal })
        if (this.runId === frame.run.runId && this.epoch === epoch) {
          this.sent = frame.signature
          this.notice(`Screen preview connected for run ${frame.run.runId}.`)
        }
      } catch (error) {
        if (this.abort.signal.aborted) return
        if (isS2AuthFailure(error) && this.grant === grant) this.grant = undefined
        this.notice(`Screen preview paused — retrying. ${error instanceof Error ? error.message : 'Upload failed.'}`)
        await this.options.sleep(2000)
        // 下次采集完成后重试，确保重连不会发送停顿前保留的旧快照。
        return
      }
    }
  }
}
