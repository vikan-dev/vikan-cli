import { afterEach, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runCli } from './cli.ts'
import { RunnerWorld, waitFor } from './test-support/runner-world.ts'
import { fakeDeps, tempConfigRoot } from './test-support/harness.ts'
import { SimulatedCrashError } from './runner/crash.ts'
import { deliverablesCommand } from './runner/deliverables.ts'
import { ApiCallError, createVikanApiClient } from './api/client.ts'

let world: RunnerWorld | undefined
const roots: string[] = []
afterEach(async () => { await world?.destroy(); world = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('deliverables help and malformed arguments need no pairing, network or credentials', async () => {
  const root = tempConfigRoot(); roots.push(root)
  let called = false
  const h = fakeDeps(root, { fetch: async () => { called = true; throw new Error('No request permitted') } }); roots.push(h.cwdDir)
  expect(await runCli(['deliverables', '--help'], h.deps)).toBe(0)
  expect(h.out.join('')).toContain('finish-stage')
  for (const args of [['unknown'], ['upload', '--run', randomUUID()], ['context', '--run', 'invalid'],
    ['context', '--run', randomUUID(), '--credential', 'must-not-be-echoed'],
    ['context', '--run', randomUUID(), '--run', randomUUID()]]) {
    expect(await runCli(['deliverables', ...args], h.deps)).toBe(2)
  }
  expect(called).toBe(false)
  expect(h.err.join('')).not.toContain('must-not-be-echoed')
})

it('issue guidance is delivered once, survives acknowledged restart, and never decorates supplements', async () => {
  let fired = false
  world = new RunnerWorld({ crashHook: point => {
    if (!fired && point.startsWith('acknowledged:')) { fired = true; throw new SimulatedCrashError(point) }
  } })
  const issueId = randomUUID(), { runId } = world.runtime.queueRun({ issueId, prompt: 'Implement the issue' })
  const runner = await world.startRunner()
  await runner.whenStopped
  const prompt = world.adapter.events.find(e => e.kind === 'prompt')!.prompt!
  expect(prompt).toContain(`# vikan issue deliverables`)
  expect(prompt).toContain(issueId); expect(prompt).toContain(runId)
  const prefix = deliverablesCommand([process.execPath, '--no-env-file', new URL('./index.ts', import.meta.url).pathname], world.configRoot, world.fakeApi.origin)
  expect(prompt).toContain(`${prefix} context --run ${runId}`)
  const render = `${prefix} render-plan --source ./plan.md --output ./plan.html`
  const upload = `${prefix} upload --run ${runId} --file ./plan.html`
  const publish = `${prefix} publish-stage --run ${runId} --manifest ./plan.json`
  expect(prompt).toContain(render)
  expect(prompt.indexOf(render)).toBeLessThan(prompt.indexOf(upload))
  expect(prompt.indexOf(upload)).toBeLessThan(prompt.indexOf(publish))
  expect(prompt).toContain('document copied unchanged from plan-render.json')
  expect(prompt).toContain('retry at most twice')
  expect(prompt).not.toContain(world.fakeApi.state.credential!)
  expect(prompt).not.toContain('Bearer ')
  expect(prompt).not.toContain(world.runtime.sessions[0]!.sessionId)
  world.crash(); await world.startRunner()
  await waitFor(() => world!.runtime.runs[0]?.status === 'running')
  world.runtime.sendContinue(runId, { prompt: 'Also validate mobile', expectedRunVersion: world.runtime.runs[0]!.runVersion })
  await waitFor(() => world!.adapter.promptCountTotal() === 2)
  expect(world.adapter.events.filter(e => e.kind === 'prompt').map(e => e.prompt)).toEqual([prompt, 'Also validate mobile'])
})

it('issue-less explore runs preserve the topic when appending findings instructions', async () => {
  world = new RunnerWorld()
  const { runId } = world.runtime.queueRun({ prompt: 'Explore search performance' })
  await world.startRunner(); await waitFor(() => world!.adapter.promptCountTotal() === 1)
  const prompt = world.adapter.events.find(e => e.kind === 'prompt')!.prompt!
  expect(prompt.startsWith('Explore search performance')).toBe(true)
  expect(prompt).toContain('# vikan run findings')
  expect(prompt).toContain('If it specifies a topic, investigate and report findings relevant to that topic; explore freely only when no topic was specified.')
  expect(prompt).toContain(`publish-findings --run ${runId}`)
  expect(prompt).not.toContain('# vikan issue deliverables')
  expect(prompt).not.toContain('render-plan')
  expect(prompt).not.toContain(world.fakeApi.state.credential!)
})

it('project-document starts keep their document publisher without visual Plan guidance', async () => {
  world = new RunnerWorld()
  const documentId = randomUUID()
  world.fetchOverride = async (url, init) => {
    const response = await fetch(url, init)
    if (!url.endsWith('/context') || !response.ok) return response
    return Response.json({ ...await response.json() as object, projectDocument: {
      id: documentId, title: 'Existing document', version: 2,
      format: 'markdown', source: '# Existing document', content: null, annotations: [],
    } })
  }
  const { runId } = world.runtime.queueRun({ prompt: 'Revise the document' })
  await world.startRunner(); await waitFor(() => world!.adapter.promptCountTotal() === 1)
  const prompt = world.adapter.events.find(e => e.kind === 'prompt')!.prompt!
  expect(prompt).toContain('# vikan project document')
  expect(prompt).toContain(documentId)
  expect(prompt).toContain(`project-document --run ${runId}`)
  expect(prompt).not.toContain('render-plan')
  expect(prompt).not.toContain('# vikan run findings')
})

it('untrusted proxy/auth-looking responses never establish a domain refusal', async () => {
  for (const response of [new Response('Proxy rejected request', { status: 401 }),
    Response.json({ type: 'https://errors.zebra.dev/unauthenticated', title: 'Unauthorized', status: 401, instance: '/' }, { status: 502 })]) {
    const api = createVikanApiClient({ apiOrigin: 'https://api.example.test', fetch: async () => response })
    try { await api.getRun(randomUUID()); throw new Error('Expected rejection') }
    catch (error) {
      expect(error).toBeInstanceOf(ApiCallError)
      expect((error as ApiCallError).failure.kind).toBe('invalid-output')
    }
  }
})
