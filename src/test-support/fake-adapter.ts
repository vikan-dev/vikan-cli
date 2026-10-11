import { AgentAdapterUnavailableError, type AgentAdapter, type AgentTargetStatus, type AgentTarget, type AgentScreenSnapshot } from '../runner/adapter.ts'

/**
 * The fake agent adapter (todo 09 test support): an in-memory pane/agent
 * world with an event tape, so tests assert EXACTLY which side effects
 * happened (no duplicate pane, no duplicate prompt, interrupts issued) and
 * can inject latency, refusals and crash points. It behaves like the real
 * Herdr boundary: verifyTarget never mutates, createPane returns a fresh
 * opaque pane id, sendPrompt resolves once the agent accepts.
 */

export interface AdapterEvent {
  readonly kind: 'verify' | 'create-pane' | 'start-agent' | 'prompt' | 'interrupt'
  readonly agentName: string
  readonly prompt?: string
  readonly paneId?: string
}

export interface FakeAdapterOptions {
  /** Per-call latency injected before every adapter effect resolves. */
  readonly latencyMs?: number
}

export class FakeAgentAdapter implements AgentAdapter {
  /** agentName → its pane id (set at pane creation or agent start). */
  readonly paneOf = new Map<string, string>()
  /** Which agents are actually running (started, not merely pane-created). */
  readonly agentLive = new Set<string>()
  readonly occupants = new Map<string, string>()
  readonly working = new Set<string>()
  readonly stopped = new Set<string>()
  screen = { revision: 1, rows: 24, cols: 80, content: '\u001b[32mExploring the checkout…\u001b[0m\r\n', truncated: false }
  beforeEffect?: (kind: AdapterEvent['kind'], target: AgentTarget) => Promise<void>
  readonly events: AdapterEvent[] = []
  private nextPane = 0
  /** When true, every method throws the unavailable error (the 10-seam). */
  private unavailableReason: string | null = null
  /** When set, sendPrompt throws this (a failed dispatch without a verdict). */
  promptFailure: Error | null = null
  /** When set, interrupt throws this. */
  interruptFailure: Error | null = null
  private readonly latencyMs: number

  constructor(options: FakeAdapterOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0
  }

  setUnavailable(reason: string | null): void {
    this.unavailableReason = reason
  }

  private guard(): void {
    if (this.unavailableReason !== null) throw new AgentAdapterUnavailableError(this.unavailableReason)
  }

  private async settle(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs))
  }

  private record(event: AdapterEvent): void {
    this.events.push(event)
  }

  async verifyTarget(input: AgentTarget): Promise<AgentTargetStatus> {
    this.guard()
    await this.settle()
    this.record({ kind: 'verify', agentName: input.agentName })
    const paneId = this.paneOf.get(input.agentName)
    if (input.herdrSessionId !== '/tmp/fake-herdr.sock') return { status: 'unknown', reason: 'Herdr session changed' }
    if (paneId === undefined) return { status: 'gone' }
    if ((input.paneId !== null && paneId !== input.paneId) || (input.occupantId !== null && input.occupantId !== this.occupants.get(input.agentName))) return { status: 'unknown', reason: 'Occupant replaced' }
    return this.agentLive.has(input.agentName)
      ? { status: this.stopped.has(input.agentName) ? 'stopped' : this.working.has(input.agentName) ? 'agent-working' : 'agent-ready', paneId, occupantId: this.occupants.get(input.agentName)! }
      : { status: 'pane-only', paneId }
  }

  async createPane(input: AgentTarget): Promise<{ paneId: string }> {
    this.guard()
    await this.settle()
    await this.beforeEffect?.('create-pane', input)
    const paneId = `fake-pane-${++this.nextPane}`
    this.paneOf.set(input.agentName, paneId)
    this.record({ kind: 'create-pane', agentName: input.agentName, paneId })
    return { paneId }
  }

  async startAgent(input: AgentTarget & { paneId: string }): Promise<{ occupantId: string }> {
    this.guard()
    await this.settle()
    this.paneOf.set(input.agentName, input.paneId)
    await this.beforeEffect?.('start-agent', input)
    this.agentLive.add(input.agentName)
    const occupantId = `occupant-${input.paneId}`
    this.occupants.set(input.agentName, occupantId)
    this.record({ kind: 'start-agent', agentName: input.agentName, paneId: input.paneId })
    return { occupantId }
  }

  async sendPrompt(input: AgentTarget & { prompt: string }): Promise<void> {
    this.guard()
    await this.settle()
    await this.beforeEffect?.('prompt', input)
    if ((await this.verifyTarget(input)).status !== 'agent-ready') throw new Error('Target not ready or occupant changed')
    this.record({ kind: 'prompt', agentName: input.agentName, prompt: input.prompt })
    if (this.promptFailure !== null) throw this.promptFailure
  }

  async interrupt(input: AgentTarget): Promise<void> {
    this.guard()
    await this.settle()
    await this.beforeEffect?.('interrupt', input)
    const verified = await this.verifyTarget(input)
    if (verified.status !== 'agent-ready' && verified.status !== 'agent-working' && verified.status !== 'blocked') throw new Error('Interrupt target changed')
    this.record({ kind: 'interrupt', agentName: input.agentName })
    if (this.interruptFailure !== null) throw this.interruptFailure
  }

  async readScreen(input: AgentTarget): Promise<AgentScreenSnapshot> {
    const observed = await this.verifyTarget(input)
    if (!('occupantId' in observed)) throw new Error('Screen target changed')
    return { paneId: observed.paneId, ...this.screen }
  }

  /** Test inspection helpers. */
  promptCount(agentName: string): number {
    return this.events.filter((event) => event.kind === 'prompt' && event.agentName === agentName).length
  }

  promptCountTotal(): number {
    return this.events.filter((event) => event.kind === 'prompt').length
  }

  interruptCount(agentName: string): number {
    return this.events.filter((event) => event.kind === 'interrupt' && event.agentName === agentName).length
  }

  paneCount(): number {
    return new Set(this.events.filter((event) => event.kind === 'create-pane').map((event) => event.paneId)).size
  }

  /** The pane-only crash window: a pane exists but no agent was started yet. */
  createPaneOnly(agentName: string): string {
    const paneId = `fake-pane-${++this.nextPane}`
    this.paneOf.set(agentName, paneId)
    return paneId
  }

  /** Adopt-an-agent crash window: agent running without the journal knowing. */
  createRunningAgent(agentName: string): string {
    const paneId = this.createPaneOnly(agentName)
    this.agentLive.add(agentName)
    this.occupants.set(agentName, `occupant-${paneId}`)
    return paneId
  }
}
