/**
 * CLI configuration. This is the only module that reads `process.env`; the
 * rest of the CLI receives values as parameters. Validated with T3 Env
 * (https://env.t3.gg) via `@t3-oss/env-core`.
 *
 * Nothing is required: `--help` / `--version` / `doctor` must run before any
 * pairing or configuration exists. `HERDR_*` variables belong to Herdr's own
 * protocol and keep their external names.
 */
import { createEnv } from '@t3-oss/env-core'
import process from 'node:process'
import { z } from 'zod'

/** Preserve the user's executable path and agent configuration in child
 * processes; consumers receive this snapshot instead of reading env again. */
export const subprocessEnv = { ...process.env }

/** Renderer children receive only fixed configuration, never user AM_* or secrets. */
export const planRendererEnv = { CI: '1', LANG: 'C.UTF-8', TZ: 'UTC' } as const

export const env = createEnv({
  server: {
    /** vikan API origin; defaults to the hosted app when unset or empty. */
    VIKAN_API_URL: z.url().default('https://app.vikan.dev'),
    /** Override for the user-level directory that holds bindings and cursors. */
    VIKAN_CONFIG_DIR: z.string().min(1).optional(),
    /** Herdr sets this to `1` inside a Herdr session. */
    HERDR_ENV: z.string().optional(),
    /** The socket of the Herdr session this pane belongs to (read-only probe input). */
    HERDR_SOCKET_PATH: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
