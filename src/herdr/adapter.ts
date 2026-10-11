import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import type { AsyncExec } from '../exec.ts'
import type { HerdrContextInfo } from './context.ts'
import { AgentAdapterUnavailableError, agentNameForRun, type AgentAdapter, type AgentTarget, type AgentTargetStatus, type AgentScreenSnapshot } from '../runner/adapter.ts'
import { HerdrOwnerStore, type HerdrOwner } from '../state/herdr.ts'
import { processBirthIdentity } from './process-identity.ts'
import { readPaneScreen, terminalSize } from './screen.ts'

// Herdr's installed `api schema` (protocol 22), not vikan wire DTOs.
const id = z.string().min(1)
const paneSchema = z.object({ pane_id: id, terminal_id: id, workspace_id: id, tab_id: id,
  cwd: id, agent: z.string().nullish() })
const agentSchema = paneSchema.extend({ name: id, agent: z.literal('codex'),
  interactive_ready: z.boolean(), agent_status: z.enum(['idle', 'done', 'working', 'blocked', 'unknown']),
  agent_session: z.object({ source: id, agent: z.literal('codex'), kind: z.enum(['id', 'path']), value: id }).nullish(),
})
type AgentInfo = z.infer<typeof agentSchema>
const processSchema = z.object({ pane_id: id, shell_pid: z.number().int().positive().nullish(), tty: z.string().nullish(), foreground_processes: z.array(z.object({
  pid: z.number().int().positive(), name: id,
})) })
const layoutSchema = z.object({ workspace_id: id, tab_id: id,
  panes: z.array(z.object({ pane_id: id, rect: z.object({ width: z.number().positive(), height: z.number().positive() }) })) })

class HerdrError extends Error {
  constructor(readonly code: string) { super(`Herdr ${code}; inspect the owned pane and reconcile before retrying.`) }
}

/** Reject before pairing/claiming or any Herdr effect. A directory-lock
 * implementation on another OS does not establish safe occupant identity. */
export function assertHerdrExecutionPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux' && platform !== 'darwin') throw new AgentAdapterUnavailableError(
    `Herdr execution supports Linux and macOS only (detected ${platform}). No pane or agent will be started.`,
  )
}

export interface HerdrAdapterOptions {
  readonly context: HerdrContextInfo
  readonly cwd: string
  readonly exec: AsyncExec
  readonly store: HerdrOwnerStore
  /** Test injection; production uses the host platform, never an env override. */
  readonly platform?: NodeJS.Platform
  readonly processIdentity?: (pid: number) => string
  readonly readPaneScreen?: typeof readPaneScreen
}

/** Only this adapter's durable split/start receipts confer pane ownership.
 * Effects target the unique run name AFTER exact pane/terminal/process checks:
 * Herdr clears names when occupants exit. No focus, auto-approval,
 * terminal-output delivery inference, or automatic prompt retry. */
export class HerdrAgentAdapter implements AgentAdapter {
  constructor(private readonly options: HerdrAdapterOptions) {
    assertHerdrExecutionPlatform(options.platform)
  }

  private async exec(args: readonly string[], timeoutMs = 5000) {
    const socket = this.options.context.socketPath
    if (!socket) throw new HerdrError('session_socket_missing')
    return this.options.exec('herdr', args, { timeoutMs, env: { HERDR_SOCKET_PATH: socket } })
  }
  private async json(args: readonly string[], type: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    const output = await this.exec(args, timeoutMs)
    if (output.code !== 0) {
      let code = 'response_unconfirmed'
      try {
        const error = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]+$/) }) }).parse(JSON.parse(output.stderr))
        code = error.error.code
      } catch { /* Never echo raw stderr: it can contain prompt content. */ }
      throw new HerdrError(code)
    }
    const envelope = z.object({ result: z.object({ type: z.literal(type) }).catchall(z.unknown()) }).parse(JSON.parse(output.stdout))
    return envelope.result
  }
  private assertTarget(input: AgentTarget): void {
    if (!this.options.context.socketPath || input.herdrSessionId !== this.options.context.socketPath ||
      input.agentName !== agentNameForRun(input.runId)) throw new HerdrError('target_mismatch')
  }
  private owner(input: AgentTarget): HerdrOwner | undefined {
    this.assertTarget(input)
    const owner = this.options.store.load(input.runId)
    if (owner && (owner.agentName !== input.agentName || owner.session !== input.herdrSessionId ||
      owner.workspaceId !== this.options.context.workspaceId || owner.tabId !== this.options.context.tabId ||
      owner.cwd !== this.options.cwd || input.paneId !== null && owner.paneId !== input.paneId ||
      input.occupantId !== null && owner.occupantId !== input.occupantId)) throw new HerdrError('ownership_mismatch')
    return owner
  }
  private async pane(owner: HerdrOwner) {
    const pane = paneSchema.parse((await this.json(['pane', 'get', owner.paneId!], 'pane_info')).pane)
    if (pane.pane_id !== owner.paneId || pane.terminal_id !== owner.terminalId ||
      pane.workspace_id !== owner.workspaceId || pane.tab_id !== owner.tabId || realpathSync(pane.cwd) !== owner.cwd) {
      throw new HerdrError('pane_replaced_or_moved')
    }
    return pane
  }
  private async agent(owner: HerdrOwner): Promise<AgentInfo> {
    const agent = agentSchema.parse((await this.json(['agent', 'get', owner.agentName], 'agent_info')).agent)
    if (agent.name !== owner.agentName || agent.pane_id !== owner.paneId || agent.terminal_id !== owner.terminalId ||
      agent.workspace_id !== owner.workspaceId || agent.tab_id !== owner.tabId || realpathSync(agent.cwd) !== owner.cwd) {
      throw new HerdrError('agent_replaced_or_moved')
    }
    return agent
  }
  private async occupant(owner: HerdrOwner): Promise<string> {
    const processes = processSchema.parse((await this.json(['pane', 'process-info', '--pane', owner.paneId!], 'pane_process_info')).process_info)
    const codex = processes.foreground_processes.filter(p => p.name === 'codex')
    if (processes.pane_id !== owner.paneId || codex.length !== 1) throw new HerdrError('process_identity_unknown')
    const birth = (this.options.processIdentity ?? processBirthIdentity)(codex[0]!.pid)
    return `herdr-v1:${createHash('sha256').update(JSON.stringify([owner.terminalId, birth])).digest('hex')}`
  }
  private async observed(owner: HerdrOwner): Promise<AgentTargetStatus> {
    await this.pane(owner)
    const agent = await this.agent(owner)
    if (!owner.occupantId || await this.occupant(owner) !== owner.occupantId) throw new HerdrError('occupant_changed')
    const session = agent.agent_session ? JSON.stringify(agent.agent_session) : null
    if (owner.agentSession !== null && owner.agentSession !== session) throw new HerdrError('agent_session_changed')
    if (session && !owner.agentSession) this.options.store.save({ ...owner, agentSession: session })
    if (!agent.interactive_ready || agent.agent_status === 'unknown') throw new HerdrError('agent_not_ready')
    return { status: agent.agent_status === 'blocked' ? 'blocked' : agent.agent_status === 'working' ? 'agent-working' : 'agent-ready',
      paneId: owner.paneId!, occupantId: owner.occupantId }
  }

  async verifyTarget(input: AgentTarget): Promise<AgentTargetStatus> {
    try {
      const owner = this.owner(input)
      if (!owner) {
        if (input.paneId || input.occupantId) throw new HerdrError('ownership_missing')
        try { await this.json(['agent', 'get', input.agentName], 'agent_info') }
        catch (error) { if (error instanceof HerdrError && error.code === 'agent_not_found') return { status: 'gone' }; throw error }
        throw new HerdrError('unowned_name_exists')
      }
      if (owner.phase === 'creating' || owner.phase === 'starting') throw new HerdrError('effect_unconfirmed')
      const pane = await this.pane(owner)
      if (owner.phase === 'pane-created') {
        if (pane.agent || input.occupantId) throw new HerdrError('unowned_occupant')
        return { status: 'pane-only', paneId: owner.paneId! }
      }
      return await this.observed(owner)
    } catch (error) {
      return { status: 'unknown', reason: error instanceof HerdrError ? error.message : 'Herdr identity cannot be verified; inspect the owned pane and reconcile.' }
    }
  }

  async createPane(input: AgentTarget): Promise<{ paneId: string }> {
    if ((await this.verifyTarget(input)).status !== 'gone') throw new HerdrError('split_not_authorized')
    const context = this.options.context
    const caller = paneSchema.parse((await this.json(['pane', 'get', context.paneId], 'pane_info')).pane)
    const layout = layoutSchema.parse((await this.json(['pane', 'layout', '--pane', context.paneId], 'pane_layout')).layout)
    const rect = layout.panes.find(p => p.pane_id === context.paneId)?.rect
    if (caller.pane_id !== context.paneId || caller.terminal_id !== context.terminalId || caller.workspace_id !== context.workspaceId ||
      caller.tab_id !== context.tabId || layout.workspace_id !== context.workspaceId || layout.tab_id !== context.tabId || !rect) {
      throw new HerdrError('caller_changed')
    }
    const owner: HerdrOwner = { version: 1, runId: input.runId, agentName: input.agentName, session: input.herdrSessionId,
      workspaceId: context.workspaceId, tabId: context.tabId, cwd: this.options.cwd,
      phase: 'creating', paneId: null, terminalId: null, occupantId: null, agentSession: null }
    this.options.store.save(owner)
    const pane = paneSchema.parse((await this.json(['pane', 'split', '--pane', context.paneId, '--direction',
      rect.width >= 120 && rect.width >= rect.height * 2 ? 'right' : 'down', '--cwd', owner.cwd, '--no-focus'], 'pane_info')).pane)
    if (pane.pane_id === context.paneId || pane.terminal_id === context.terminalId || pane.workspace_id !== owner.workspaceId ||
      pane.tab_id !== owner.tabId || realpathSync(pane.cwd) !== owner.cwd || pane.agent) throw new HerdrError('split_identity_unconfirmed')
    this.options.store.save({ ...owner, phase: 'pane-created', paneId: pane.pane_id, terminalId: pane.terminal_id })
    return { paneId: pane.pane_id }
  }
  async startAgent(input: AgentTarget & { paneId: string }): Promise<{ occupantId: string }> {
    if ((await this.verifyTarget(input)).status !== 'pane-only') throw new HerdrError('start_not_authorized')
    const owner = this.owner(input)!
    this.options.store.save({ ...owner, phase: 'starting' })
    // Inherit the user's Codex model, reasoning, sandbox and approval settings.
    const result = await this.json(['agent', 'start', owner.agentName, '--kind', 'codex', '--pane', input.paneId,
      '--timeout', '15000'], 'agent_started', 18000)
    const returned = agentSchema.parse(result.agent)
    const observed = await this.agent(owner)
    if (returned.pane_id !== observed.pane_id || returned.terminal_id !== observed.terminal_id || returned.name !== owner.agentName ||
      !observed.interactive_ready || !['idle', 'done'].includes(observed.agent_status)) throw new HerdrError('startup_not_ready')
    // 0.9.0 may label the trust dialog idle. Confirm the actual Codex composer,
    // never answer a startup/approval dialog or interpret transcript as delivery.
    const screen = await this.exec(['pane', 'read', input.paneId, '--source', 'visible', '--format', 'text'])
    // Codex's decorative braille particles can overlay the composer line.
    const visible = screen.stdout.replace(/[\u2800-\u28ff]/g, '')
    if (screen.code !== 0 || !/^\s*› Ask Codex to do anything\s*$/m.test(visible)) throw new HerdrError('composer_not_confirmed')
    const occupantId = await this.occupant(owner)
    this.options.store.save({ ...owner, phase: 'started', occupantId,
      agentSession: observed.agent_session ? JSON.stringify(observed.agent_session) : null })
    if ((await this.verifyTarget({ ...input, occupantId })).status !== 'agent-ready') throw new HerdrError('startup_identity_unconfirmed')
    return { occupantId }
  }
  async sendPrompt(input: AgentTarget & { prompt: string }): Promise<void> {
    if ((await this.verifyTarget(input)).status !== 'agent-ready') throw new HerdrError('prompt_not_authorized')
    const result = await this.json(['agent', 'prompt', input.agentName, input.prompt,
      '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '7000'], 'agent_prompted', 9000)
    const agent = agentSchema.parse(result.agent), owner = this.owner(input)!
    if (agent.pane_id !== owner.paneId || agent.terminal_id !== owner.terminalId || agent.name !== owner.agentName ||
      !['working', 'blocked'].includes(agent.agent_status)) throw new HerdrError('prompt_activation_unconfirmed')
    if ((await this.verifyTarget(input)).status === 'unknown') throw new HerdrError('prompt_occupant_unconfirmed')
  }
  async interrupt(input: AgentTarget): Promise<void> {
    if (!['agent-ready', 'agent-working', 'blocked'].includes((await this.verifyTarget(input)).status)) throw new HerdrError('interrupt_not_authorized')
    await this.json(['agent', 'send-keys', input.agentName, 'ctrl+c'], 'ok')
    // Acceptance does not prove the task stopped. The runner reports stopping.
    if ((await this.verifyTarget(input)).status === 'unknown') throw new HerdrError('interrupt_occupant_unconfirmed')
  }

  async readScreen(input: AgentTarget): Promise<AgentScreenSnapshot> {
    const owner = this.owner(input)
    if (!owner || owner.phase !== 'started' || !input.paneId || !input.occupantId) throw new HerdrError('screen_not_owned')
    await this.observed(owner)
    const info = processSchema.parse((await this.json(['pane', 'process-info', '--pane', owner.paneId!], 'pane_process_info')).process_info)
    if (info.pane_id !== owner.paneId) throw new HerdrError('screen_pane_changed')
    const size = await terminalSize(this.options.exec, info, this.options.platform ?? process.platform)
    const screen = await (this.options.readPaneScreen ?? readPaneScreen)(owner.session, owner.paneId!)
    if (screen.pane_id !== owner.paneId || screen.workspace_id !== owner.workspaceId || screen.tab_id !== owner.tabId) {
      throw new HerdrError('screen_pane_changed')
    }
    const after = await terminalSize(this.options.exec, info, this.options.platform ?? process.platform)
    if (after.rows !== size.rows || after.cols !== size.cols) throw new HerdrError('screen_resized_during_capture')
    // A replaced pane/occupant must never leak its output to this run.
    const currentOwner = this.owner(input)
    if (!currentOwner) throw new HerdrError('screen_not_owned')
    await this.observed(currentOwner)
    return { paneId: screen.pane_id, revision: screen.revision, ...size, content: screen.text, truncated: screen.truncated }
  }
}
