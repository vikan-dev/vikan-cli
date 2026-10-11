import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAsyncExec, type AsyncExec, type AsyncExecOptions } from '../exec.ts'
import { HerdrOwnerStore } from '../state/herdr.ts'
import { agentNameForRun, type AgentTarget } from '../runner/adapter.ts'
import { HerdrAgentAdapter } from './adapter.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vikan-herdr-'))); roots.push(root)
  const store = new HerdrOwnerStore(root, { apiOrigin: 'https://example.test', userId: randomUUID(), bindingId: randomUUID() })
  const context = { herdrVersion: '0.9.0', paneId: 'caller', terminalId: 'term-caller', workspaceId: 'w', tabId: 'tab',
    paneCwd: root, socketPath: '/verified/herdr.sock', sessionName: null }
  const runId = randomUUID()
  const target: AgentTarget = { runId, agentName: agentNameForRun(runId), paneId: null, occupantId: null, herdrSessionId: context.socketPath }
  const state = { pane: 'owned', terminal: 'term-owned', name: target.agentName, status: 'idle', agent: false,
    birth: 'boot:pid:start', session: null as null | { source: string; agent: string; kind: string; value: string },
    splitLost: false, startLost: false, promptLost: false, composer: true, composerDecoration: '', identityUnavailable: false,
    tty: '/dev/pts/42' as string | null, dimensions: '24 80', replaceDuringRead: false, screenReads: 0 }
  const calls: { command: string; args: readonly string[]; options: AsyncExecOptions | undefined }[] = []
  const pane = () => ({ pane_id: state.pane, terminal_id: state.terminal, workspace_id: 'w', tab_id: 'tab', cwd: root,
    agent: state.agent ? 'codex' : null })
  const agent = () => ({ ...pane(), name: state.name, agent: 'codex', agent_status: state.status,
    interactive_ready: true, agent_session: state.session })
  const exec: AsyncExec = async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'stty') return { code: 0, stdout: state.dimensions, stderr: '' }
    if (command === 'ps') return { code: 0, stdout: 'ttys003\n', stderr: '' }
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: '' })
    const lost = () => ({ code: 124, stdout: '', stderr: 'unknown effect' })
    if (args[0] === 'agent' && args[1] === 'get') return state.agent
      ? ok({ type: 'agent_info', agent: agent() })
      : { code: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'agent_not_found' } }) }
    if (args[1] === 'get') return ok({ type: 'pane_info', pane: args[2] === 'caller'
      ? { ...pane(), pane_id: 'caller', terminal_id: 'term-caller', agent: null } : pane() })
    if (args[1] === 'layout') return ok({ type: 'pane_layout', layout: { workspace_id: 'w', tab_id: 'tab',
      panes: [{ pane_id: 'caller', rect: { width: 156, height: 42 } }] } })
    if (args[1] === 'split') return state.splitLost ? lost() : ok({ type: 'pane_info', pane: pane() })
    if (args[1] === 'start') { state.agent = true; return state.startLost ? lost() : ok({ type: 'agent_started', agent: agent(), argv: ['codex'] }) }
    if (args[1] === 'process-info') return ok({ type: 'pane_process_info', process_info: { pane_id: state.pane,
      shell_pid: 1233, tty: state.tty, foreground_processes: [{ name: 'codex', pid: 1234 }] } })
    if (args[1] === 'read') return { code: 0, stdout: state.composer ? `› Ask Codex to do anything ${state.composerDecoration}\n` : 'Trust this directory?', stderr: '' }
    if (args[1] === 'prompt') { state.status = 'working'; return state.promptLost ? lost() : ok({ type: 'agent_prompted', agent: agent() }) }
    if (args[1] === 'send-keys') { state.status = 'idle'; return ok({ type: 'ok' }) }
    throw new Error(`Unexpected fixture command: ${args[0]} ${args[1]}`)
  }
  const adapter = (platform: NodeJS.Platform = process.platform) => new HerdrAgentAdapter({ context, cwd: root, exec, store, platform,
    readPaneScreen: async (socket, paneId) => {
      expect(socket).toBe(context.socketPath)
      expect(paneId).toBe('owned')
      state.screenReads++
      if (state.replaceDuringRead) state.birth = 'another-process'
      return { pane_id: state.pane, workspace_id: 'w', tab_id: 'tab', source: 'visible', format: 'ansi',
        revision: 7, text: '\u001b[32m你好 🎉\u001b[0m\r\n', truncated: false }
    }, processIdentity: () => {
    if (state.identityUnavailable) throw new Error('Process identity unavailable')
    return state.birth
  } })
  const start = async (platform?: NodeJS.Platform) => {
    const a = adapter(platform), created = await a.createPane(target), started = await a.startAgent({ ...target, ...created })
    return { a, input: { ...target, ...created, ...started } }
  }
  return { state, calls, target, adapter, start, store }
}

describe('real Herdr adapter contract and ownership', () => {
  it.each(['linux', 'darwin'] as const)('captures owned ANSI screens with exact PTY geometry on %s', async platform => {
    const f = fixture(), { a, input } = await f.start(platform)
    if (platform === 'darwin') f.state.tty = null // discover controlling tty with ps
    expect(await a.readScreen(input)).toEqual({ paneId: 'owned', revision: 7, rows: 24, cols: 80,
      content: '\u001b[32m你好 🎉\u001b[0m\r\n', truncated: false })
    expect(f.calls.find(c => c.command === 'stty')!.args).toEqual([platform === 'darwin' ? '-f' : '-F',
      platform === 'darwin' ? '/dev/ttys003' : '/dev/pts/42', 'size'])
    f.state.dimensions = '33 119'
    expect(await a.readScreen(input)).toMatchObject({ rows: 33, cols: 119 })
  })

  it('refuses screen reads for a foreign target and discards frames if the occupant changes during capture', async () => {
    const f = fixture(), { a, input } = await f.start()
    await expect(a.readScreen({ ...input, paneId: 'foreign' })).rejects.toThrow()
    expect(f.state.screenReads).toBe(0)
    f.state.replaceDuringRead = true
    await expect(a.readScreen(input)).rejects.toThrow('occupant_changed')
    expect(f.state.screenReads).toBe(1)
    await expect(a.readScreen(input)).rejects.toThrow('occupant_changed')
    expect(f.state.screenReads).toBe(1)
  })

  it('rejects unsupported hosts before discovery, split/start or changing saved ownership', async () => {
    const f = fixture()
    for (const platform of ['win32', 'freebsd'] as const) {
      expect(() => f.adapter(platform)).toThrow(`Linux and macOS only (detected ${platform})`)
    }
    expect(f.calls).toEqual([])
    expect(f.store.load(f.target.runId)).toBeUndefined()

    // A saved pane from a supported runner must not allow starting Codex on
    // an unsupported host before discovering that its identity is unreadable.
    await f.adapter().createPane(f.target)
    const owner = f.store.load(f.target.runId), calls = f.calls.length
    expect(() => f.adapter('win32')).toThrow('No pane or agent will be started')
    expect(f.calls).toHaveLength(calls)
    expect(f.calls.filter(call => call.args[1] === 'start')).toEqual([])
    expect(f.store.load(f.target.runId)).toEqual(owner)
  })

  it.each(['linux', 'darwin'] as const)('on %s pins the socket, starts Codex with local model, reasoning, sandbox and approval settings, and uses argv for bounded activation', async (platform) => {
    const f = fixture()
    f.state.composerDecoration = '⠈ ⡀'
    const { a, input } = await f.start(platform)
    const prompt = 'literal $(touch never) `false` "quoted"\nsecond line'
    await a.sendPrompt({ ...input, prompt })
    expect(f.calls.find(c => c.args[1] === 'split')!.args).toEqual(['pane', 'split', '--pane', 'caller', '--direction', 'right', '--cwd', f.store.load(input.runId)!.cwd, '--no-focus'])
    expect(f.calls.find(c => c.args[1] === 'start')!.args).toEqual(['agent', 'start', input.agentName, '--kind', 'codex', '--pane', 'owned', '--timeout', '15000'])
    expect(f.calls.find(c => c.args[1] === 'prompt')!.args).toEqual(['agent', 'prompt', input.agentName, prompt, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '7000'])
    expect(f.calls.every(c => c.options?.env?.HERDR_SOCKET_PATH === input.herdrSessionId)).toBe(true)
    expect(await f.adapter().verifyTarget(input)).toMatchObject({ status: 'agent-working', ...{ paneId: input.paneId, occupantId: input.occupantId } })
    await a.interrupt(input)
    expect(f.calls.filter(c => c.args[1] === 'send-keys').map(c => c.args)).toEqual([['agent', 'send-keys', input.agentName, 'ctrl+c']])
    expect((await a.verifyTarget(input)).status).toBe('agent-ready') // never fabricated stopped
  })

  it('refuses foreign session, pane, terminal, name and reused process IDs inside each effect', async () => {
    const f = fixture(), { a, input } = await f.start()
    for (const changed of [{ ...input, herdrSessionId: '/other.sock' }, { ...input, paneId: 'foreign' }, { ...input, occupantId: 'replaced' }]) {
      await expect(a.sendPrompt({ ...changed, prompt: 'never sent' })).rejects.toThrow('prompt_not_authorized')
      await expect(a.interrupt(changed)).rejects.toThrow('interrupt_not_authorized')
    }
    for (const field of ['pane', 'terminal', 'name', 'birth'] as const) {
      const before = f.state[field]; f.state[field] = 'replacement'
      await expect(a.sendPrompt({ ...input, prompt: 'never sent' })).rejects.toThrow()
      await expect(a.interrupt(input)).rejects.toThrow()
      f.state[field] = before
    }
    f.state.identityUnavailable = true
    expect((await a.verifyTarget(input)).status).toBe('unknown')
    await expect(a.sendPrompt({ ...input, prompt: 'never sent' })).rejects.toThrow('prompt_not_authorized')
    await expect(a.interrupt(input)).rejects.toThrow('interrupt_not_authorized')
    expect(f.calls.filter(c => ['prompt', 'send-keys'].includes(c.args[1]!))).toEqual([])
  })

  it('persists newly observed Codex session identity and refuses a new conversation in the same process', async () => {
    const f = fixture(), { a, input } = await f.start()
    f.state.session = { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'conversation-1' }
    expect((await a.verifyTarget(input)).status).toBe('agent-ready')
    f.state.session.value = 'conversation-2'
    expect((await f.adapter().verifyTarget(input)).status).toBe('unknown')
    await expect(a.interrupt(input)).rejects.toThrow()
  })

  it('keeps lost split/start receipts uncertain across restart without adopting an existing name', async () => {
    for (const effect of ['splitLost', 'startLost'] as const) {
      const f = fixture(); f.state[effect] = true
      if (effect === 'splitLost') await expect(f.adapter().createPane(f.target)).rejects.toThrow()
      else {
        const created = await f.adapter().createPane(f.target)
        await expect(f.adapter().startAgent({ ...f.target, ...created })).rejects.toThrow()
      }
      expect((await f.adapter().verifyTarget(f.target)).status).toBe('unknown')
      await expect(f.adapter().createPane(f.target)).rejects.toThrow()
      expect(f.calls.filter(c => c.args[1] === 'split')).toHaveLength(1)
      expect(f.calls.filter(c => c.args[1] === 'start')).toHaveLength(effect === 'startLost' ? 1 : 0)
    }
    const f = fixture(); f.state.agent = true
    expect((await f.adapter().verifyTarget(f.target)).status).toBe('unknown')
  })

  it('does not send through a startup dialog, and never retries an unconfirmed prompt', async () => {
    const blocked = fixture(); blocked.state.composer = false
    await expect(blocked.start()).rejects.toThrow('composer_not_confirmed')
    expect((await blocked.adapter().verifyTarget(blocked.target)).status).toBe('unknown')
    const f = fixture(), { a, input } = await f.start(); f.state.promptLost = true
    await expect(a.sendPrompt({ ...input, prompt: 'once' })).rejects.toThrow('response_unconfirmed')
    expect(f.calls.filter(c => c.args[1] === 'prompt')).toHaveLength(1)
  })

  it('executes asynchronously without shell expansion and treats subprocess timeout as unknown', async () => {
    const exec = createAsyncExec({})
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 5)
    try {
      const literal = '$(touch should-never-run) `false`\nnew line'
      const result = await exec(process.execPath, ['-e', 'await Bun.sleep(60); console.log(JSON.stringify(process.argv[1]))', literal])
      expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toBe(literal); expect(ticks).toBeGreaterThan(0)
      expect((await exec(process.execPath, ['-e', 'await Bun.sleep(10000)'], { timeoutMs: 20 })).code).toBe(124)
    } finally { clearInterval(timer) }
  })
})
