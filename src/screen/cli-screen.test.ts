import { afterEach, expect, it } from 'bun:test'
import { AGENT_PROTOCOL_VERSION, SCREEN_FRAME_MAX_BYTES, agentRunScreensStream, screenFrameSchema } from '@vikan/sdk/agent'
import { agentNameForRun } from '../runner/adapter.ts'
import { RunnerWorld, waitFor } from '../test-support/runner-world.ts'
import { S2TransportError } from '../transport/s2.ts'

let world: RunnerWorld | undefined
afterEach(async () => { await world?.destroy(); world = undefined })
const settle = () => new Promise(resolve => setTimeout(resolve, 80))

async function startExplore() {
  const w = world ??= new RunnerWorld()
  const { runId } = w.runtime.queueRun({ prompt: 'Explore the UI', issueId: null })
  await w.startRunner()
  await waitFor(() => w.runtime.runs.find(run => run.runId === runId)?.status === 'running')
  const run = w.runtime.runs.find(run => run.runId === runId)!
  const stream = agentRunScreensStream(runId, run.captureEpoch!)
  return { w, run, stream, frames: () => w.s2.bodiesOf(stream).map(body => screenFrameSchema.parse(JSON.parse(body))) }
}

it('publishes Explore frames through the runner, dedupes idle screens, and captures output and resize changes', async () => {
  const { w, run, frames } = await startExplore()
  await waitFor(() => frames().length === 1)
  expect(frames()[0]).toMatchObject({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'screen.frame',
    runId: run.runId, captureEpoch: run.captureEpoch, ...w.adapter.screen })
  await settle()
  expect(frames()).toHaveLength(1)
  // Herdr's pane.read revision can stay at zero; content must still update.
  w.adapter.screen.content = '\u001b[36mFound a UI issue 中文\u001b[0m\r\n'
  await waitFor(() => frames().length === 2)
  w.adapter.screen.cols = 103
  await waitFor(() => frames().length === 3)
  expect(frames()[2]?.cols).toBe(103)
  expect(new Set(frames().map(frame => frame.frameId)).size).toBe(3)

  w.adapter.occupants.set(agentNameForRun(run.runId), 'foreign-occupant')
  w.adapter.screen.content = 'private output from a different occupant'
  await settle()
  expect(frames()).toHaveLength(3)
})

it('recovers a fresh frame after runner restart and renews a refused grant using the API capture epoch', async () => {
  const { w, run, frames } = await startExplore()
  await waitFor(() => frames().length === 1)
  await w.stopRunner()
  await w.startRunner()
  await waitFor(() => frames().length === 2)
  expect(frames()[0]?.frameId).not.toBe(frames()[1]?.frameId)
  run.captureEpoch = 'capture-rebuilt-epoch'
  w.s2.revokeAllGrants()
  w.adapter.screen.revision++
  const stream = agentRunScreensStream(run.runId, run.captureEpoch)
  await waitFor(() => w.s2.bodiesOf(stream).length === 1)
  expect(screenFrameSchema.parse(JSON.parse(w.s2.bodiesOf(stream)[0]!)).captureEpoch).toBe(run.captureEpoch)
})

it('keeps sampling during a slow upload, sends only the latest pending frame, and aborts on shutdown without starving control', async () => {
  const w = world = new RunnerWorld(), transport = w.s2.transport()
  let captures = 0
  const readScreen = w.adapter.readScreen.bind(w.adapter)
  w.adapter.readScreen = async input => { captures++; return readScreen(input) }
  let release: (() => void) | undefined, uploads = 0, aborted = false
  w.transportOverride = { ...transport, append: async input => {
    uploads++
    await new Promise<void>((resolve, reject) => {
      release = resolve
      input.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    })
    await transport.append(input)
  } }
  const { run, frames } = await startExplore()
  await waitFor(() => uploads === 1)
  const capturesBeforeUpload = captures
  w.adapter.screen.content = 'intermediate screen'
  await settle()
  w.adapter.screen.content = 'latest screen'
  await settle()
  expect(captures).toBeGreaterThan(capturesBeforeUpload + 1)
  expect(uploads).toBe(1)
  const heartbeats = w.runtime.counters.heartbeats
  const cancel = w.runtime.requestCancel(run.runId)
  await waitFor(() => w.runtime.counters.heartbeats > heartbeats && w.adapter.interruptCount(agentNameForRun(run.runId)) === 1)
  await waitFor(() => w.runtime.commands.find(command => command.commandId === cancel.commandId)?.status === 'acked')
  release!()
  await waitFor(() => uploads === 2)
  release!()
  await waitFor(() => frames().length === 2)
  expect(frames().map(frame => frame.content)).toEqual([expect.stringContaining('Exploring'), 'latest screen'])
  w.adapter.screen.revision++
  await waitFor(() => uploads === 3)
  await w.stopRunner()
  expect(aborted).toBe(true)
  expect(frames()).toHaveLength(2)
})

it('keeps an oversized UTF-8 record bounded and shows the capture limitation in the preview', async () => {
  const w = world = new RunnerWorld()
  w.adapter.screen.content = '🎉\u001b[32m'.repeat(40_000)
  const { frames, stream } = await startExplore()
  await waitFor(() => frames().length === 1)
  expect(Buffer.byteLength(w.s2.bodiesOf(stream)[0]!)).toBeLessThanOrEqual(SCREEN_FRAME_MAX_BYTES)
  expect(frames()[0]).toMatchObject({ truncated: true, content: expect.stringContaining('Reduce the terminal size') })
})

it('reuses frame identity after a lost append receipt so the browser can dedupe the retry', async () => {
  const w = world = new RunnerWorld(), transport = w.s2.transport()
  let loseReceipt = true
  w.transportOverride = { ...transport, append: async input => {
    await transport.append(input)
    if (loseReceipt) { loseReceipt = false; throw new S2TransportError('network', 'Lost append receipt') }
  } }
  const { frames } = await startExplore()
  await waitFor(() => frames().length === 2)
  expect(frames()[0]).toEqual(frames()[1])
  await settle()
  expect(frames()).toHaveLength(2)
})
