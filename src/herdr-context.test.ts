import { describe, expect, it } from 'bun:test'
import { detectHerdrContext, herdrFailureMessage } from './herdr/context.ts'
import type { Exec, ExecResult } from './exec.ts'

/**
 * Read-only Herdr context detection with a fake exec: `HERDR_ENV=1` alone is
 * never enough — the pane/workspace/tab identity must come from
 * `herdr pane current --current`, and the session name from the socket match
 * in `herdr session list`.
 */

const run = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: '' })

const paneCurrentJson = JSON.stringify({
  id: 'cli:pane:current',
  result: {
    type: 'pane_current',
    pane: {
      pane_id: 'w3G:p1',
      workspace_id: 'w3G',
      tab_id: 'w3G:t1',
      terminal_id: 'term_test',
      cwd: '/home/tester/repo',
      agent: 'opencode',
      revision: 4,
    },
  },
})

const sessionList = [
  'name                 status   directory                                        socket',
  'default              running  /home/tester/.config/herdr                       /home/tester/.config/herdr/herdr.sock',
  'deploy               stopped  /home/tester/.config/herdr/sessions/deploy       /home/tester/.config/herdr/sessions/deploy/herdr.sock',
  '',
].join('\n')

const execFor = (table: Record<string, ExecResult>): Exec => (command, args) => table[`${command} ${args.join(' ')}`] ?? { code: 127, stdout: '', stderr: 'not found' }

const ENV = { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/home/tester/.config/herdr/herdr.sock' }

describe('herdr context detection', () => {
  it('fails fast outside Herdr without spawning anything', () => {
    const exec = execFor({})
    expect(detectHerdrContext(exec, {})).toEqual({ ok: false, reason: 'no-herdr-env' })
    expect(detectHerdrContext(exec, { HERDR_ENV: '0' })).toEqual({ ok: false, reason: 'no-herdr-env' })
  })

  it('fails when the herdr CLI is missing', () => {
    const detection = detectHerdrContext(execFor({}), ENV)
    expect(detection).toEqual({ ok: false, reason: 'herdr-unavailable' })
    expect(herdrFailureMessage('herdr-unavailable')).toContain('herdr CLI')
  })

  it('fails when the current pane cannot be identified (or the output is malformed)', () => {
    for (const stdout of ['', 'not json', JSON.stringify({ result: { type: 'other' } })]) {
      const detection = detectHerdrContext(execFor({ 'herdr --version': run('herdr 0.9.0'), 'herdr pane current --current': run(stdout) }), ENV)
      expect(detection).toEqual({ ok: false, reason: 'no-current-pane' })
    }
    const failed = detectHerdrContext(execFor({ 'herdr --version': run('herdr 0.9.0'), 'herdr pane current --current': run('x', 1) }), ENV)
    expect(failed).toEqual({ ok: false, reason: 'no-current-pane' })
  })

  it('proves the real pane, workspace, tab and session identities', () => {
    const detection = detectHerdrContext(
      execFor({
        'herdr --version': run('herdr 0.9.0'),
        'herdr pane current --current': run(paneCurrentJson),
        'herdr session list': run(sessionList),
      }),
      ENV,
    )
    expect(detection).toEqual({
      ok: true,
      info: {
        herdrVersion: '0.9.0',
        paneId: 'w3G:p1',
        workspaceId: 'w3G',
        tabId: 'w3G:t1',
        terminalId: 'term_test',
        paneCwd: '/home/tester/repo',
        sessionName: 'default',
        socketPath: '/home/tester/.config/herdr/herdr.sock',
      },
    })
  })

  it('falls back to a null session name when no session row matches the socket', () => {
    const detection = detectHerdrContext(
      execFor({
        'herdr --version': run('herdr 0.9.0'),
        'herdr pane current --current': run(paneCurrentJson),
        'herdr session list': run(sessionList),
      }),
      { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/somewhere/else.sock' },
    )
    expect(detection.ok).toBe(true)
    expect(detection.ok && detection.info.sessionName).toBeNull()
  })
})
