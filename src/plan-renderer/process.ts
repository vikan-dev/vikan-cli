import { spawn } from 'node:child_process'

export interface RendererProcessOptions {
  cwd: string
  env: Readonly<Record<string, string>>
  timeoutMs: number
  maxDiagnosticBytes: number
}
export interface RendererProcessResult { code: number; stdout: string; stderr: string }
export type RendererExec = (executable: string, args: readonly string[], options: RendererProcessOptions) => Promise<RendererProcessResult>

/** Unlike Herdr exec, this adapter never merges the parent environment. */
export const executeRenderer: RendererExec = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], { cwd: options.cwd, env: { ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let size = 0, failure: Error | undefined
  const stop = (message: string) => {
    failure ??= new Error(message)
    child.kill('SIGKILL')
  }
  const timer = setTimeout(() => stop('Renderer exceeded its time limit.'), options.timeoutMs)
  const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length
    if (size > options.maxDiagnosticBytes) stop('Renderer exceeded its diagnostic output limit.')
    else chunks.push(chunk)
  }
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  child.on('error', error => { failure ??= error })
  child.on('close', code => {
    clearTimeout(timer)
    if (failure) reject(failure)
    else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
  })
})
