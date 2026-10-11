import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, readFileSync } from 'node:fs'
import { RunnerWorld, waitFor } from '../test-support/runner-world.ts'
import { SimulatedCrashError } from './crash.ts'
import { agentNameForRun } from './adapter.ts'
import { journalPath, loadBindingRecord, loadCredentialRecord } from '../state/binding.ts'
import { RunnerJournal } from '../state/journal.ts'
import { runUnlinkCommand } from '../commands/unlink.ts'
import { fakeDeps } from '../test-support/harness.ts'
import { AGENT_PROTOCOL_VERSION, agentBindingCommandsStream } from '@vikan/sdk/agent'

let world: RunnerWorld | undefined
afterEach(async () => { await world?.destroy(); world = undefined })

async function running() {
  world = new RunnerWorld()
  const queued = world.runtime.queueRun({ prompt: 'Work' })
  await world.startRunner()
  await waitFor(() => world!.runtime.runs.find(r => r.runId === queued.runId)?.status === 'running')
  await waitFor(() => world!.journal.view().receipts.every(r => r.state === 'sent'))
  return { ...queued, name: agentNameForRun(queued.runId) }
}

describe('crash checkpoints with fake Herdr/S2 and a real durable journal', () => {
  for (const checkpoint of ['received', 'persisted', 'effect:pane-created', 'effect:agent-started', 'acknowledged', 'pre-receipt:status', 'receipt-accepted:status']) {
    it(`recovers ${checkpoint} without duplicate pane, agent or prompt`, async () => {
      let fired = false
      world = new RunnerWorld({ crashHook: point => {
        if (!fired && point.startsWith(`${checkpoint}:`)) { fired = true; throw new SimulatedCrashError(point) }
      } })
      const { runId, commandId } = world.runtime.queueRun()
      const runner = await world.startRunner()
      expect((await runner.whenStopped).reason).toContain('Simulated crash')
      expect(world.runtime.counters.offlines).toBe(0)
      world.crash()
      await world.startRunner()
      await waitFor(() => world!.runtime.runs.find(r => r.runId === runId)?.status === 'running')
      await waitFor(() => world!.journal.view().receipts.every(r => r.state === 'sent'))
      expect(world.adapter.paneCount()).toBe(1)
      expect(world.adapter.events.filter(e => e.kind === 'start-agent')).toHaveLength(1)
      expect(world.adapter.promptCountTotal()).toBe(1)
      expect([...world.journal.view().commands.keys()]).toEqual([commandId])
      expect(world.runtime.runs.find(r => r.runId === runId)?.claimEpoch).toBe(2)
    })
  }
  it('an uncertain initial prompt keeps the slot and is never automatically resent', async () => {
    let fired = false
    world = new RunnerWorld({ crashHook: point => {
      if (!fired && point.startsWith('effect:prompt-acked:')) { fired = true; throw new SimulatedCrashError(point) }
    } })
    const first = world.runtime.queueRun()
    const runner = await world.startRunner()
    await runner.whenStopped
    world.crash()
    const second = world.runtime.queueRun()
    await world.startRunner()
    await waitFor(() => world!.runtime.runs.find(r => r.runId === first.runId)?.status === 'needs_reconciliation')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(world.adapter.promptCountTotal()).toBe(1)
    expect(world.runtime.runs.find(r => r.runId === second.runId)?.status).toBe('queued')
    expect(world.journal.view().runs.get(first.runId)?.uncertain).toBe(true)
  })
  for (const boundary of ['effect:prompt-acked', 'acknowledged']) {
    it(`a supplement interrupted at ${boundary} is not resent after restart`, async () => {
      let selected = ''
      world = new RunnerWorld({ crashHook: point => {
        if (point === `${boundary}:${selected}`) { selected = ''; throw new SimulatedCrashError(point) }
      } })
      const { runId } = world.runtime.queueRun()
      const runner = await world.startRunner()
      await waitFor(() => world!.runtime.runs.find(r => r.runId === runId)?.status === 'running')
      selected = world.runtime.sendContinue(runId, { prompt: 'Second round', expectedRunVersion: 3 }).commandId
      await runner.whenStopped
      world.crash()
      await world.startRunner()
      await waitFor(() => world!.runtime.counters.reconciles >= 2)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(world.adapter.promptCountTotal()).toBe(2)
      expect(world.runtime.runs.find(r => r.runId === runId)?.status).toBe(boundary === 'acknowledged' ? 'running' : 'needs_reconciliation')
    })
  }
  it('a lost prompt acceptance is uncertainty, never failed or a second dispatch', async () => {
    world = new RunnerWorld()
    world.adapter.promptFailure = new Error('lost acknowledgement')
    const { runId } = world.runtime.queueRun()
    await world.startRunner()
    await waitFor(() => world!.runtime.runs.find(r => r.runId === runId)?.status === 'needs_reconciliation')
    expect(world.adapter.promptCountTotal()).toBe(1)
    expect(world.journal.view().runs.get(runId)?.uncertain).toBe(true)
  })
  it('HTTP receipt response loss retries the same evidence without repeating execution', async () => {
    let lost = false
    world = new RunnerWorld()
    world.fetchOverride = async (url, init) => {
      const response = await fetch(url, init)
      if (!lost && url.endsWith('/ack')) { lost = true; throw new Error('response lost after commit') }
      return response
    }
    const { commandId } = world.runtime.queueRun()
    await world.startRunner()
    await waitFor(() => world!.runtime.counters.commandAcks >= 2)
    await waitFor(() => world!.journal.view().receipts.every(r => r.state === 'sent'))
    expect(world.adapter.promptCountTotal()).toBe(1)
    expect(world.runtime.commands.find(c => c.commandId === commandId)?.receiptOutcome).toBe('accepted')
  })
  it('repairs a torn tail but refuses a complete unknown phase instead of losing dispatch evidence', () => {
    world = new RunnerWorld()
    const path = journalPath(world.configRoot, world.binding)
    const journal = world.journal
    appendFileSync(path, '{"type":"receipt","incomplete":')
    journal.appendReceipt({ kind: 'command-ack', commandId: 'proof', outcome: 'accepted' })
    expect(RunnerJournal.open(world.configRoot, world.binding).view().receipts).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).not.toContain('incomplete')
    appendFileSync(path, `${JSON.stringify({ type: 'phase', runId: 'run', commandId: 'command', phase: 'future-phase' })}\n`)
    expect(() => RunnerJournal.open(world!.configRoot, world!.binding)).toThrow('phase journal record')
  })
})

describe('ownership, control and recovery', () => {
  it('unavailable adapter receives durably but never claims or pretends to run', async () => {
    world = new RunnerWorld()
    world.adapter.setUnavailable('No Herdr execution backend in this build')
    const { commandId } = world.runtime.queueRun()
    await world.startRunner()
    await waitFor(() => world!.out.join('').includes('No Herdr execution'))
    expect(world.journal.view().commands.has(commandId)).toBe(true)
    expect(world.runtime.counters.runClaims).toBe(0)
    expect(world.adapter.promptCountTotal()).toBe(0)
  })
  it('running work parks supplements but does not block durable cancel control', async () => {
    const { runId, name } = await running()
    world!.adapter.working.add(name)
    world!.runtime.sendContinue(runId, { prompt: 'Wait until idle', expectedRunVersion: 3 })
    world!.runtime.requestCancel(runId)
    await waitFor(() => world!.adapter.interruptCount(name) === 1)
    await waitFor(() => world!.runtime.runs.find(r => r.runId === runId)?.status === 'stopping')
    expect(world!.adapter.promptCountTotal()).toBe(1)
    expect(world!.runtime.runs.find(r => r.runId === runId)?.status).not.toBe('cancelled')
  })
  it('a replaced occupant never receives a supplement or a revocation interrupt', async () => {
    const { runId, name } = await running()
    world!.adapter.occupants.set(name, 'another-codex')
    world!.runtime.sendContinue(runId, { prompt: 'Must not reach replacement', expectedRunVersion: 3 })
    await waitFor(() => world!.journal.view().runs.get(runId)?.uncertain === true)
    world!.fakeApi.state.credential = 'revoked'
    await waitFor(() => world!.err.join('').includes('revoked'))
    expect(world!.adapter.promptCountTotal()).toBe(1)
    expect(world!.adapter.interruptCount(name)).toBe(0)
  })
  it('ordinary API loss is offline, keeps the run and issues no interrupt', async () => {
    const { runId, name } = await running()
    world!.fetchOverride = async () => { throw new Error('network unavailable') }
    const second = world!.runtime.queueRun()
    await waitFor(() => world!.out.join('').includes('offline — API unreachable'))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(world!.runtime.runs.find(r => r.runId === runId)?.status).toBe('running')
    expect(world!.runtime.runs.find(r => r.runId === second.runId)?.status).toBe('queued')
    expect(world!.adapter.interruptCount(name)).toBe(0)
    world!.fetchOverride = undefined
    await waitFor(() => world!.out.filter(line => line.includes('connected —')).length >= 2)
  })
  it('a claimed supplement expires while waiting for a busy agent and is rejected without a prompt', async () => {
    const { runId, name } = await running()
    world!.adapter.working.add(name)
    const { commandId } = world!.runtime.sendContinue(runId, { prompt: 'Expires while waiting', expectedRunVersion: 3,
      expiresAt: new Date(Date.now() + 80).toISOString() })
    await waitFor(() => world!.runtime.commands.find(c => c.commandId === commandId)?.status === 'claimed')
    await new Promise(resolve => setTimeout(resolve, 100))
    world!.adapter.working.delete(name)
    await waitFor(() => world!.runtime.commands.find(c => c.commandId === commandId)?.status === 'rejected')
    expect(world!.adapter.promptCountTotal()).toBe(1)
  })
  it('a target round changed during command claim prevents a late supplement', async () => {
    const { runId } = await running()
    const { commandId } = world!.runtime.sendContinue(runId, { prompt: 'Old round', expectedRunVersion: 3 })
    let changed = false
    world!.fetchOverride = async (url, init) => {
      const response = await fetch(url, init)
      if (!changed && url.endsWith(`/commands/${commandId}/claim`)) {
        changed = true
        const run = world!.runtime.runs.find(r => r.runId === runId)!
        run.runVersion += 1
        run.status = 'awaiting_review'
      }
      return response
    }
    await waitFor(() => world!.runtime.commands.find(c => c.commandId === commandId)?.status === 'rejected')
    expect(changed).toBe(true)
    expect(world!.adapter.promptCountTotal()).toBe(1)
  })
  it('only an authoritative terminal confirmation releases a locally uncertain slot', async () => {
    world = new RunnerWorld()
    world.adapter.promptFailure = new Error('lost acceptance')
    const first = world.runtime.queueRun()
    await world.startRunner()
    await waitFor(() => world!.runtime.runs.find(r => r.runId === first.runId)?.status === 'needs_reconciliation')
    const second = world.runtime.queueRun()
    await waitFor(() => world!.journal.view().commands.has(second.commandId))
    expect(world.adapter.promptCountTotal()).toBe(1)
    world.runtime.confirmRun(first.runId)
    world.adapter.promptFailure = null
    await waitFor(() => world!.runtime.runs.find(r => r.runId === second.runId)?.status === 'running')
    expect(world.adapter.promptCountTotal()).toBe(2)
    expect(world.journal.view().runs.get(first.runId)?.uncertain).toBe(false)
  })
  it('explicit revocation interrupts only the saved owned target and retains unconfirmed facts', async () => {
    const { runId, name } = await running()
    world!.fakeApi.state.credential = 'revoked'
    await waitFor(() => world!.adapter.interruptCount(name) === 1)
    expect(world!.journal.view().runs.get(runId)).toMatchObject({ status: 'stopping', uncertain: true })
    expect(loadBindingRecord(world!.configRoot, world!.binding)).toBeDefined()
  })
  it('a newer session fences old-session controls without touching a replacement pane', async () => {
    const { runId, name } = await running()
    await world!.api().openRunnerSession({ bindingId: world!.binding.bindingId, protocolVersion: AGENT_PROTOCOL_VERSION, cliVersion: 'new',
      herdr: { version: 'fake', protocolVersion: 22, sessionId: 'different', workspaceId: 'w', tabId: 't', paneId: 'p' }, agentKinds: ['codex'] })
    world!.runtime.requestCancel(runId)
    await waitFor(() => world!.err.join('').includes('authority'))
    expect(world!.adapter.interruptCount(name)).toBe(0)
    expect(world!.adapter.promptCountTotal()).toBe(1)
  })
  it('retention gap recovers a trimmed cancel from authority and advances after the snapshot', async () => {
    const { runId, name } = await running()
    const stream = agentBindingCommandsStream(world!.binding.bindingId)
    world!.s2.setNetworkDown(true)
    await waitFor(() => world!.out.filter(s => s.includes('degraded')).length >= 2)
    const cancel = world!.runtime.requestCancel(runId)
    const queued = world!.runtime.queueRun()
    world!.s2.trim(stream, '2')
    world!.s2.setNetworkDown(false)
    await waitFor(() => world!.out.join('').includes('S2 gap'))
    await waitFor(() => world!.journal.cursor(stream) === '3')
    await waitFor(() => world!.adapter.interruptCount(name) === 1)
    expect(world!.journal.view().commands.has(cancel.commandId)).toBe(true)
    expect(world!.journal.view().commands.has(queued.commandId)).toBe(true)
  })
  it('unlink requests durable cancellation and retains state until the stop is confirmed', async () => {
    const { runId } = await running()
    const { deps, err } = fakeDeps(world!.configRoot, { cwd: () => world!.binding.path })
    // This fake checkout is a logical identity, so use a real temp directory
    // for the CLI command's normalization without changing the runner fixture.
    const actual = world!.configRoot
    const { saveBindingRecord } = await import('../state/binding.ts')
    saveBindingRecord(world!.configRoot, { ...world!.binding, path: actual })
    expect(await runUnlinkCommand({ ...deps, cwd: () => actual })).toBe(1)
    expect(err.join('')).toContain('unfinished')
    expect(world!.runtime.runs.find(r => r.runId === runId)?.cancelRequested).toBe(true)
    expect(loadBindingRecord(world!.configRoot, world!.binding)).toBeDefined()
    expect(loadCredentialRecord(world!.configRoot, world!.binding)).toBeDefined()
    expect(world!.journal.view().runs.has(runId)).toBe(true)
  })
  it('stable agent names distinguish nearby uuidv7 runs and fit Herdr limits', () => {
    const a = agentNameForRun('019941ef-1234-7000-8000-000000000001')
    const b = agentNameForRun('019941ef-1234-7000-8000-000000000002')
    expect(a).not.toBe(b)
    expect(a).toBe(agentNameForRun('019941ef-1234-7000-8000-000000000001'))
    expect(a.length).toBeLessThanOrEqual(32)
  })
})
