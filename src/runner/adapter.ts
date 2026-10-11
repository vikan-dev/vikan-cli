import { createHash } from 'node:crypto'
import type { ScreenFrame } from '@vikan/sdk/agent'

export type AgentScreenSnapshot = Pick<ScreenFrame, 'paneId' | 'revision' | 'rows' | 'cols' | 'content' | 'truncated'>

/** The recovery anchor. The adapter must verify session, pane AND occupant,
 * including immediately inside every effect call; names alone are unsafe.
 * Unknown discovery (e.g. a lost split response) must never return 'gone'. */
export interface AgentTarget {
  readonly runId: string
  readonly agentName: string
  readonly paneId: string | null
  readonly occupantId: string | null
  readonly herdrSessionId: string
}
export type AgentTargetStatus =
  | { readonly status: 'gone' }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'pane-only'; readonly paneId: string }
  | { readonly status: 'agent-ready' | 'agent-working' | 'blocked' | 'stopped'; readonly paneId: string; readonly occupantId: string }

/** No operation waits for a whole task.
 * Stopped means the owned task was observed stopped, not just Ctrl-C sent.
 * Backend effects must have bounded timeouts and refuse an occupant mismatch. */
export interface AgentAdapter {
  verifyTarget(input: AgentTarget): Promise<AgentTargetStatus>
  createPane(input: AgentTarget): Promise<{ readonly paneId: string }>
  startAgent(input: AgentTarget & { readonly paneId: string }): Promise<{ readonly occupantId: string }>
  sendPrompt(input: AgentTarget & { readonly prompt: string }): Promise<void>
  interrupt(input: AgentTarget): Promise<void>
  /** Full visible ANSI snapshot, with ownership checked before and after reading. */
  readScreen(input: AgentTarget): Promise<AgentScreenSnapshot>
}
export function agentNameForRun(runId: string): string {
  return `vikan-${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`
}
export class AgentAdapterUnavailableError extends Error {}
export function isAgentAdapterUnavailable(error: unknown): error is AgentAdapterUnavailableError {
  return error instanceof AgentAdapterUnavailableError
}
export function unavailableAgentAdapter(reason: string): AgentAdapter {
  const refuse = (): never => { throw new AgentAdapterUnavailableError(reason) }
  return { verifyTarget: refuse, createPane: refuse, startAgent: refuse, sendPrompt: refuse, interrupt: refuse, readScreen: refuse }
}
