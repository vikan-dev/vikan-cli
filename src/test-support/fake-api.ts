import { createHash, randomUUID } from 'node:crypto'
import type { FakeS2 } from './fake-s2.ts'
import { FakeRuntimeApi } from './fake-runtime.ts'

/**
 * In-process fake of the vikan API surface the CLI consumes: 04/05's link +
 * bindings subset AND 09's agent-runtime mount (sessions, runs, commands,
 * subscriptions — 07/08's endpoint semantics in memory). Speaks the exact
 * wire format — Zebra client calls, Problem JSON errors, contract DTO
 * shapes — so the CLI under test exercises its real client, output
 * validation and error classification. No real server, no database; command
 * delivery is simulated by appending to the fake S2 store, like 08's outbox.
 */

export interface FakeLinkRequest {
  readonly requestId: string
  readonly pairingSecretHash: string
  readonly deviceCredentialHash: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'claimed'
  readonly input: {
    directoryKey: string
    directoryLabel: string
    deviceName: string
    cliVersion: string
    protocolVersion: number
  }
}

export interface FakeApiState {
  /** Requests created on this server (idempotent create hits excluded). */
  readonly requests: FakeLinkRequest[]
  createCalls: number
  claims: number
  listings: number
  readonly revocations: { bindingId: string; authorization: string | null }[]
  /** The bearer accepted by the bindings endpoints; null accepts any bearer. */
  credential: string | null
  bindingStatus: 'active' | 'revoked'
  bindingConnectionState: 'online' | 'degraded' | 'offline'
  healthDown: boolean
  /** 09's agent runtime: sessions, runs, commands, subscriptions (in memory). */
  readonly runtime: FakeRuntimeApi
}

export interface FakeApi {
  readonly origin: string
  readonly state: FakeApiState
  /** Flip the (only) pending request to approved — the browser's decision. */
  approve(): void
  setClaimOverride(override: ((request: FakeLinkRequest | undefined, body: { pairingSecret: string }) => Response | undefined) | null): void
  setCreateOverride(override: ((body: Record<string, unknown>) => Response | undefined) | null): void
  stop(): void
}

const IDS = {
  bindingId: '00000000-0000-7000-8000-00000000000b',
  deviceId: '00000000-0000-7000-8000-00000000000d',
  userId: '00000000-0000-7000-8000-000000000001',
  workspaceId: '00000000-0000-7000-8000-00000000000a',
  projectId: '00000000-0000-7000-8000-00000000000c',
} as const

export const FAKE_API_IDS = IDS

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const problem = (status: number, code: string, title: string): Response =>
  json({ type: `https://errors.zebra.dev/${code}`, status, title, instance: '/' }, status)

export interface FakeApiOptions {
  /** Approve the pending request once the CLI's Nth claim arrives (the browser decision, timed). */
  readonly autoApproveAfter?: number
  /** Mark the created request rejected immediately (user rejected in the browser). */
  readonly rejectAfterCreate?: boolean
  /** The fake S2 store that simulates delivery (outbox appends + grant tails). */
  readonly s2?: FakeS2
  /** Agent runtime tuning for the runner tests. */
  readonly heartbeatSeconds?: number
  readonly leaseSeconds?: number
  /** False answers `agent_unconfigured` (503) on subscriptions and 'degraded' online. */
  readonly s2Configured?: boolean
}

export function startFakeApi(now: () => number, options: FakeApiOptions = {}): FakeApi {
  const runtime = new FakeRuntimeApi({
    now,
    s2: options.s2,
    heartbeatSeconds: options.heartbeatSeconds ?? 5,
    leaseSeconds: options.leaseSeconds ?? 45,
    s2Configured: options.s2Configured ?? true,
    credential: () => state.credential,
  })
  const state: FakeApiState = {
    requests: [],
    createCalls: 0,
    claims: 0,
    listings: 0,
    revocations: [],
    credential: null,
    bindingStatus: 'active',
    bindingConnectionState: 'offline',
    healthDown: false,
    runtime,
  }
  let claimOverride: ((request: FakeLinkRequest | undefined, body: { pairingSecret: string }) => Response | undefined) | null = null
  let createOverride: ((body: Record<string, unknown>) => Response | undefined) | null = null
  const autoApproveAfter = options.autoApproveAfter

  const findByHash = (hash: string): FakeLinkRequest | undefined =>
    state.requests.find((request) => request.pairingSecretHash === hash)

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      const path = url.pathname

      // 09's agent runtime mount: sessions, runs, commands, subscriptions.
      if (/^\/api\/agent\/(sessions|runs|commands|subscriptions)/.test(path)) {
        const handled = await runtime.route(request, path)
        if (handled !== undefined) return handled
        return problem(404, 'not_found', `No fake route for ${request.method} ${path}`)
      }

      if (request.method === 'POST' && path === '/api/agent/link-requests') {
        state.createCalls += 1
        const body = (await request.json()) as Record<string, unknown>
        const overridden = createOverride?.(body)
        if (overridden !== undefined) return overridden
        const existing = findByHash(String(body.pairingSecretHash))
        if (existing !== undefined) return json(requestDto(existing, now), 201) // idempotent replay
        const created: FakeLinkRequest = {
          requestId: randomUUID(),
          pairingSecretHash: String(body.pairingSecretHash),
          deviceCredentialHash: String(body.deviceCredentialHash),
          status: 'pending',
          input: {
            directoryKey: String(body.directoryKey),
            directoryLabel: String(body.directoryLabel),
            deviceName: String(body.deviceName),
            cliVersion: String(body.cliVersion),
            protocolVersion: Number(body.protocolVersion),
          },
        }
        state.requests.push(created)
        if (options.rejectAfterCreate === true) created.status = 'rejected'
        return json(requestDto(created, now), 201)
      }

      const claimMatch = /^\/api\/agent\/link-requests\/([^/]+)\/claim$/.exec(path)
      if (request.method === 'POST' && claimMatch !== null) {
        state.claims += 1
        const id = claimMatch[1]!
        const request_ = state.requests.find((candidate) => candidate.requestId === id)
        const body = (await request.json()) as { pairingSecret: string }
        const overridden = claimOverride?.(request_, body)
        if (overridden !== undefined) return overridden
        if (request_ === undefined) return problem(404, 'link_not_found', 'This pairing request does not exist.')
        if (sha256Hex(body.pairingSecret) !== request_.pairingSecretHash) {
          // No oracle: a mismatched secret looks exactly like a dead request.
          return problem(410, 'link_gone', 'This pairing request is invalid or no longer available.')
        }
        if (autoApproveAfter !== undefined && state.claims >= autoApproveAfter && request_.status === 'pending') {
          request_.status = 'approved'
        }
        switch (request_.status) {
          case 'pending':
            return problem(425, 'link_pending', 'This pairing request is not approved yet; keep polling.')
          case 'rejected':
            return problem(410, 'link_gone', 'This pairing request was rejected; start the pairing again.')
          case 'expired':
            return problem(410, 'link_gone', 'This pairing request expired; start the pairing again.')
          case 'approved':
          case 'claimed':
            request_.status = 'claimed'
            return json({
              requestId: request_.requestId,
              bindingId: IDS.bindingId,
              deviceId: IDS.deviceId,
              userId: IDS.userId,
              workspaceId: IDS.workspaceId,
              projectId: IDS.projectId,
              directoryKey: request_.input.directoryKey,
              claimedAt: new Date(now()).toISOString(),
              agentPageUrl: 'https://app.example.test/workspace/fake-workspace/agent',
            })
        }
      }

      if (request.method === 'GET' && path === '/api/agent/bindings') {
        const authorization = request.headers.get('authorization')
        if (authorization === null) return problem(401, 'unauthenticated', 'Sign in first.')
        if (state.credential !== null && authorization !== `Bearer ${state.credential}`) {
          return problem(401, 'unauthenticated', 'This device credential is missing, revoked, or no longer has access to its project. Run vikan link to pair again.')
        }
        state.listings += 1
        return json({
          bindings: [
            {
              bindingId: IDS.bindingId,
              deviceId: IDS.deviceId,
              userId: IDS.userId,
              workspaceId: IDS.workspaceId,
              projectId: IDS.projectId,
              directoryKey: state.requests[0]?.input.directoryKey ?? '/fake/dir',
              directoryLabel: state.requests[0]?.input.directoryLabel ?? 'fake',
              status: state.bindingStatus,
              connectionState: state.bindingConnectionState,
              createdAt: new Date(now()).toISOString(),
              revokedAt: state.bindingStatus === 'revoked' ? new Date(now()).toISOString() : null,
            },
          ],
        })
      }

      const revokeMatch = /^\/api\/agent\/bindings\/([^/]+)\/revoke$/.exec(path)
      if (request.method === 'POST' && revokeMatch !== null) {
        const authorization = request.headers.get('authorization')
        if (authorization === null) return problem(401, 'unauthenticated', 'Sign in first.')
        if (state.credential !== null && authorization !== `Bearer ${state.credential}`) {
          return problem(401, 'unauthenticated', 'This device credential is missing, revoked, or no longer has access to its project. Run vikan link to pair again.')
        }
        if (revokeMatch[1] !== IDS.bindingId) return problem(404, 'not_found', 'Binding not found.')
        state.revocations.push({ bindingId: revokeMatch[1]!, authorization })
        return json({ revoked: true })
      }

      if (request.method === 'GET' && path === '/api/health') {
        if (state.healthDown) return problem(503, 'database_unavailable', 'The database is unavailable.')
        return json({ status: 'ok', database: 'up' })
      }

      return problem(404, 'not_found', `No fake route for ${request.method} ${path}`)
    },
  })

  return {
    origin: `http://127.0.0.1:${server.port}`,
    state,
    approve: () => {
      const pending = state.requests.find((candidate) => candidate.status === 'pending')
      if (pending !== undefined) pending.status = 'approved'
    },
    setClaimOverride: (override) => {
      claimOverride = override
    },
    setCreateOverride: (override) => {
      createOverride = override
    },
    stop: () => {
      server.stop(true)
    },
  }
}

function requestDto(request: FakeLinkRequest, now: () => number): Record<string, unknown> {
  return {
    requestId: request.requestId,
    userCode: 'WX3K9PBQ',
    verificationUrl: 'https://app.example.test/agent/link/' + request.requestId,
    expiresAt: new Date(now() + 600_000).toISOString(),
    pollIntervalSeconds: 5,
  }
}
