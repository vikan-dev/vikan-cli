import { AppendInput, AppendRecord, S2, S2Error } from '@s2-dev/streamstore'

/**
 * S2 command reads and screen appends (plan §9.2/§9.3). The
 * runner codes against `S2Transport`; only this module touches the real SDK
 * (`@s2-dev/streamstore` 0.27.0), and tests inject the in-process fake.
 *
 * The grant is a short-lived per-stream token minted by the API's
 * subscription endpoint — basin exact + stream exact + read/check-tail (08
 * T2); screens additionally receive append. `fromSeq` is the persisted next-UNPROCESSED position (decimal string
 * on the wire; numeric SDK positions must be exactly representable; otherwise
 * the consumer pauses instead of silently rounding a u64).
 *
 * Failure classification (evidence/08): a 401 from S2 is DEFINITIVE — the
 * token expired or the revocation took effect — so the consumer re-subscribes
 * and re-authorization decides; everything else is 'network', an unknown
 * outcome that only means "not connected right now".
 */

export interface S2TailRecord {
  /** Assigned sequence number, decimal string (the contract's u64 rule). */
  readonly seqNum: string
  readonly body: string
}

export interface S2TailSession {
  /** Records from `fromSeq` (inclusive) onward, in order, then waits for more. */
  [Symbol.asyncIterator](): AsyncIterator<S2TailRecord>
  close(): Promise<void>
}

export type S2FailureKind = 'auth' | 'network' | 'protocol'

export class S2TransportError extends Error {
  readonly failure: { readonly kind: S2FailureKind }

  constructor(kind: S2FailureKind, message: string) {
    super(message)
    this.name = 'S2TransportError'
    this.failure = { kind }
  }
}

export interface S2Transport {
  /** Append one full frame. Bounded and abortable independently of commands. */
  append(input: { readonly basin: string; readonly stream: string; readonly token: string; readonly body: string; readonly signal: AbortSignal }): Promise<void>
  /**
   * Open a tailing read session on `stream` from `fromSeq` using the grant
   * token. Throws `S2TransportError` (classified) when the session cannot be
   * established or fails mid-stream.
   */
  tail(input: { readonly basin: string; readonly stream: string; readonly token: string; readonly fromSeq: string }): Promise<S2TailSession>
}

export function isS2AuthFailure(error: unknown): boolean {
  return error instanceof S2TransportError && error.failure.kind === 'auth'
}

/** The production transport: SDK reads/appends over the granted token. */
export function createS2Transport(): S2Transport {
  return {
    async append({ basin, stream, token, body, signal }) {
      try {
        const account = new S2({ accessToken: token, requestTimeoutMillis: 5000, retry: { maxAttempts: 1 } })
        await account.basin(basin).stream(stream).append(AppendInput.create([AppendRecord.string({ body })]), { signal })
      } catch (error) { throw classify(error, stream) }
    },
    async tail({ basin, stream, token, fromSeq }) {
      let fromSeqNum: number
      try {
        const exact = BigInt(fromSeq)
        if (exact < 0n || exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SDK position exceeds exact numeric range')
        fromSeqNum = Number(exact)
      } catch {
        throw new S2TransportError('protocol', `The SDK cannot exactly represent read position ${fromSeq} for ${stream}; upgrade before reading.`)
      }
      const account = new S2({ accessToken: token })
      let session
      try {
        session = await account.basin(basin).stream(stream).readSession({
          start: { from: { seqNum: fromSeqNum } },
        })
      } catch (error) {
        throw classify(error, stream)
      }
      let closed = false
      const close = async (): Promise<void> => {
        if (closed) return
        closed = true
        await session.cancel().catch(() => undefined)
      }
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<S2TailRecord> {
          try {
            for await (const record of session) {
              if (!Number.isSafeInteger(record.seqNum)) throw new S2TransportError('protocol', 'S2 SDK returned an inexact sequence; consumption paused.')
              yield { seqNum: String(record.seqNum), body: record.body }
            }
          } catch (error) {
            throw classify(error, stream)
          } finally {
            await close()
          }
        },
        close,
      }
    },
  }
}

function classify(error: unknown, stream: string): Error {
  if (error instanceof S2TransportError) return error
  if (error instanceof S2Error && (error.status === 401 || error.status === 403)) {
    return new S2TransportError('auth', `S2 refused the grant for ${stream} (HTTP ${error.status}); re-subscribe for a fresh token.`)
  }
  return new S2TransportError('network', `S2 stream ${stream} is unreachable.`)
}
