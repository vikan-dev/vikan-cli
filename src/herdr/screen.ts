import { randomUUID } from 'node:crypto'
import { readlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { z } from 'zod'
import type { AsyncExec } from '../exec.ts'

const paneReadSchema = z.object({
  pane_id: z.string(), workspace_id: z.string(), tab_id: z.string(),
  source: z.literal('visible'), format: z.literal('ansi'), text: z.string(),
  revision: z.number().int().nonnegative(), truncated: z.boolean(),
})

/** Public Herdr protocol 22. The CLI prints only text; the socket also
 * supplies revision and truncation. Bound time and bytes, including errors. */
export function readPaneScreen(socketPath: string, paneId: string): Promise<z.infer<typeof paneReadSchema>> {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), socket = connect(socketPath)
    let buffer = '', bytes = 0
    const finish = (error?: Error, value?: z.infer<typeof paneReadSchema>) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else if (value) resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Herdr screen read timed out.')), 5000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method: 'pane.read',
      params: { pane_id: paneId, source: 'visible', format: 'ansi' } })}\n`))
    socket.on('error', () => finish(new Error('Herdr screen socket is unavailable.')))
    socket.on('end', () => finish(new Error('Herdr closed the screen response before completing it.')))
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 2 * 1024 * 1024) { finish(new Error('Herdr screen response exceeds 2 MiB; reduce the terminal size.')); return }
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        const envelope = z.object({ id: z.literal(id), result: z.object({ type: z.literal('pane_read'), read: paneReadSchema }) })
          .parse(JSON.parse(buffer.slice(0, end)))
        finish(undefined, envelope.result.read)
      } catch { finish(new Error('Herdr screen response is invalid or was refused.')) }
    })
  })
}

/** Read PTY geometry without sending input or inferring widths from text or
 * layout chrome. Herdr 0.9.0 doesn't expose viewport columns. */
export async function terminalSize(exec: AsyncExec, info: {
  shell_pid?: number | null; tty?: string | null; foreground_processes: readonly { pid: number }[]
}, platform: NodeJS.Platform): Promise<{ rows: number; cols: number }> {
  let tty = info.tty
  const pids = [info.shell_pid, ...info.foreground_processes.map(p => p.pid)].filter((pid): pid is number => pid != null)
  if (!tty) {
    for (const pid of pids) {
      if (platform === 'linux') {
        try { tty = readlinkSync(`/proc/${pid}/fd/0`) } catch { continue }
      } else if (platform === 'darwin') {
        const result = await exec('ps', ['-p', String(pid), '-o', 'tty='], { timeoutMs: 2000 })
        const name = result.stdout.trim()
        if (result.code === 0 && /^ttys?\w+$/.test(name)) tty = `/dev/${name}`
      }
      if (tty && /^\/dev\/(?:pts\/\d+|tty[\w.-]+)$/.test(tty)) break
      tty = null
    }
  }
  if (!tty || !/^\/dev\/(?:pts\/\d+|tty[\w.-]+)$/.test(tty)) throw new Error('Screen capture cannot locate the owned terminal device.')
  const size = await exec('stty', [platform === 'darwin' ? '-f' : '-F', tty, 'size'], { timeoutMs: 2000 })
  const match = /^(\d+)\s+(\d+)$/.exec(size.stdout.trim())
  const rows = Number(match?.[1]), cols = Number(match?.[2])
  if (size.code !== 0 || !Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 1000 || cols > 1000) {
    throw new Error('Screen capture cannot read valid terminal dimensions (1–1000 rows/columns).')
  }
  return { rows, cols }
}
