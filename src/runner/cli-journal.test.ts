import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MAX_PENDING_RECEIPTS } from '../runner/receipts.ts'
import { RunnerJournal, receiptIdOf, type RunnerReceipt } from '../state/journal.ts'
import { journalPath, activeRunIds, bindingJournal } from '../state/binding.ts'
import { RunnerWorld, waitFor } from '../test-support/runner-world.ts'
import { FAKE_API_IDS } from '../test-support/fake-api.ts'

/**
 * T2: the durable receive/execution ledger — journal replay, the
 * persist-before-cursor order, commandId dedup and the receipt backlog cap.
 * All against temp config roots; the world-level tests run the real runner.
 */

const STREAM = `bindings/${FAKE_API_IDS.bindingId}/commands`

const command = (overrides: Partial<Parameters<RunnerJournal['appendCommand']>[0]> = {}) => ({
  commandId: '00000000-0000-7000-8000-0000000000c1',
  runId: '00000000-0000-7000-8000-0000000000r1',
  kind: 'start' as const,
  commandSeq: 1,
  prompt: null,
  expectedRunVersion: null,
  expiresAt: null,
  receivedAt: '2026-09-19T00:00:00.000Z',
  ...overrides,
})

const worldBinding = () => ({
  apiOrigin: 'https://api.example.test',
  userId: FAKE_API_IDS.userId,
  bindingId: FAKE_API_IDS.bindingId,
})

describe('runner journal — replay and ordering', () => {
  it('rebuilds cursors, commands, phases, runs and receipts from the append-only file', () => {
    const world = new RunnerWorld()
    try {
      const journal = RunnerJournal.open(world.configRoot, worldBinding())
      journal.advanceCursor(STREAM, '5')
      journal.appendCommand(command())
      journal.recordRun({ runId: command().runId, status: 'starting', claimEpoch: 3, runVersion: 2 })
      journal.recordRun({ runId: command().runId, paneId: 'pane-9', agentName: 'vikan-abc' })
      journal.recordPhase(command().commandId, command().runId, 'prepared')
      journal.recordPhase(command().commandId, command().runId, 'pane_created')
      journal.appendReceipt({ kind: 'command-ack', commandId: command().commandId, outcome: 'accepted' })
      journal.markReceipt(`ack:${command().commandId}`, 'sent')

      const replayed = RunnerJournal.open(world.configRoot, worldBinding())
      const view = replayed.view()
      expect(view.cursors.get(STREAM)).toBe('5')
      expect(view.commands.get(command().commandId)?.commandSeq).toBe(1)
      expect(view.phases.get(command().commandId)).toBe('pane_created')
      expect(view.runPhases.get(command().runId)).toBe('pane_created')
      expect(view.runs.get(command().runId)).toMatchObject({ status: 'starting', claimEpoch: 3, runVersion: 2, paneId: 'pane-9', agentName: 'vikan-abc' })
      expect(view.receipts).toHaveLength(1)
      expect(view.receipts[0]!.state).toBe('sent')
    } finally {
      world.destroy()
    }
  })

  it('the command record is appended BEFORE the cursor moves — the crash window replays safely', () => {
    const world = new RunnerWorld()
    try {
      const journal = RunnerJournal.open(world.configRoot, worldBinding())
      journal.advanceCursor(STREAM, '0') // the subscription-time position
      // Crash between the command append and the cursor advance.
      journal.appendCommand(command({ commandId: '00000000-0000-7000-8000-0000000000c2' }))
      const replayed = RunnerJournal.open(world.configRoot, worldBinding())
      expect(replayed.view().commands.has('00000000-0000-7000-8000-0000000000c2')).toBe(true)
      expect(replayed.view().cursors.get(STREAM)).toBe('0')
      // The redelivery of the same record dedupes and only moves the cursor.
      expect(journal.appendCommand(command({ commandId: '00000000-0000-7000-8000-0000000000c2' }))).toBe(false)
      journal.advanceCursor(STREAM, '1')
      expect(journal.view().cursors.get(STREAM)).toBe('1')
    } finally {
      world.destroy()
    }
  })

  it('dedupes by stable commandId whatever the delivery says (duplicates, reorderings)', () => {
    const world = new RunnerWorld()
    try {
      const journal = RunnerJournal.open(world.configRoot, worldBinding())
      journal.appendCommand(command())
      expect(journal.appendCommand(command())).toBe(false)
      // A second record with a new seq but the same commandId is the
      // append-retry duplicate (evidence/01 D5): one ledger entry.
      journal.advanceCursor(STREAM, '1')
      expect(journal.appendCommand(command())).toBe(false)
      expect(journal.view().commands.size).toBe(1)
      // Cursor writes are idempotent too.
      journal.advanceCursor(STREAM, '1')
      journal.advanceCursor(STREAM, '1')
      expect(journal.view().cursors.get(STREAM)).toBe('1')
    } finally {
      world.destroy()
    }
  })

  it('run records keep 05’s {type:"run"} shape so unlink’s activity check still works', () => {
    const world = new RunnerWorld()
    try {
      const journal = RunnerJournal.open(world.configRoot, worldBinding())
      journal.recordRun({ runId: 'run-a', status: 'starting', runVersion: 1 })
      journal.recordRun({ runId: 'run-a', status: 'running', runVersion: 2 })
      journal.recordRun({ runId: 'run-b', status: 'succeeded', runVersion: 3 })
      expect(activeRunIds(bindingJournal(world.configRoot, worldBinding()))).toEqual(['run-a'])
      // Every record line is a run record with the fields unlink reads.
      for (const line of readFileSync(journalPath(world.configRoot, worldBinding()), 'utf8').split('\n')) {
        if (line === '') continue
        expect(['metadata', 'run']).toContain((JSON.parse(line) as { type: string }).type)
      }
    } finally {
      world.destroy()
    }
  })

  it('receipt ids are stable intents: same target+outcome never double-records', () => {
    const receipt: RunnerReceipt = { kind: 'run-status', runId: 'run-a', status: 'running' }
    expect(receiptIdOf(receipt)).toBe('status:run-a:running')
    const world = new RunnerWorld()
    try {
      const journal = RunnerJournal.open(world.configRoot, worldBinding())
      expect(journal.appendReceipt(receipt)).toBe(true)
      expect(journal.appendReceipt({ ...receipt, reason: 're-derived after a restart' })).toBe(false)
      expect(journal.view().receipts).toHaveLength(1)
    } finally {
      world.destroy()
    }
  })
})

describe('receipt backlog cap', () => {
  let world: RunnerWorld | undefined

  afterEach(async () => {
    await world?.destroy()
    world = undefined
  })

  it('pauses new work at the cap and retains every receipt after HTTP settles the backlog', async () => {
    world = new RunnerWorld()
    // A server outage makes receipts unconfirmable: they pile up pending.
    world.runtime.receiptsDown = true
    const journal = RunnerJournal.open(world.configRoot, world.binding)
    for (let index = 0; index < MAX_PENDING_RECEIPTS; index++) {
      journal.appendReceipt({ kind: 'command-ack', commandId: `backlog-command-${index}`, outcome: 'accepted' })
    }
    expect(journal.view().receipts.filter((record) => record.state === 'pending')).toHaveLength(MAX_PENDING_RECEIPTS)

    const { runId } = world.runtime.queueRun({ prompt: 'Must not start yet' })
    await world.startRunner()
    await waitFor(() => world!.out.join('').includes('receipt backlog reached its cap'), 5_000, 'the cap reason')
    // New work is PAUSED: no claim, no pane, no prompt.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(world.runtime.counters.runClaims).toBe(0)
    expect(world.adapter.events.length).toBe(0)
    expect(world.runtime.runs.find((run) => run.runId === runId)!.status).toBe('queued')
    // Nothing was dropped: the backlog is intact.
    expect(world.journal.view().receipts.filter((record) => record.state === 'pending').length).toBeGreaterThanOrEqual(MAX_PENDING_RECEIPTS)

    // Synthetic unknown command IDs settle as explicit refusals after the
    // outage. Refusal is retained evidence, not a successful execution ack.
    world.runtime.receiptsDown = false
    await waitFor(() => world!.adapter.promptCountTotal() === 1, 5_000, 'the held dispatch')
    await waitFor(() => world!.journal.view().receipts.filter(r => r.receiptId.startsWith('ack:backlog-command-')).every(r => r.state !== 'pending'))
    const backlog = world.journal.view().receipts.filter(r => r.receiptId.startsWith('ack:backlog-command-'))
    expect(backlog).toHaveLength(MAX_PENDING_RECEIPTS)
    expect(backlog.every(r => r.state === 'refused')).toBe(true)
    expect(world.runtime.runs.find((run) => run.runId === runId)!.status === 'running' || world.runtime.runs.find((run) => run.runId === runId)!.status === 'starting').toBe(true)
  })
})
