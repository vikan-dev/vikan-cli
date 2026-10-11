import { S2TransportError, type S2TailRecord, type S2TailSession, type S2Transport } from '../transport/s2.ts'

/**
 * In-process fake of the S2 stream store (todo 09 test support): the CLI's
 * transport code runs against this instead of the real `@s2-dev/streamstore`
 * — no network, no basin, no credentials. Tokens minted by the fake API's
 * subscription endpoint are registered here, so token expiry/revocation and
 * stream routing behave like the real grant matrix (evidence/08: 401 is
 * definitive, everything else is 'network').
 */

interface FakeStream {
  readonly records: { readonly seqNum: bigint; readonly body: string }[]
}

export class FakeS2 {
  private readonly streams = new Map<string, FakeStream>()
  /** Last assigned sequence per stream — survives trims (S2 seqs never rewind). */
  private readonly lastSeq = new Map<string, bigint>()
  private readonly grants = new Map<string, { stream: string; revoked: boolean }>()
  private networkDown = false
  private tokenCounter = 0

  /** Register a freshly minted grant token (the fake API's subscription answer). */
  grantToken(stream: string): string {
    const token = `fake-s2-token-${++this.tokenCounter}`
    this.grants.set(token, { stream, revoked: false })
    return token
  }

  /** Simulate the TTL/revocation path: every issued token becomes definitively dead. */
  revokeAllGrants(): void {
    for (const grant of this.grants.values()) grant.revoked = true
  }

  setNetworkDown(down: boolean): void {
    this.networkDown = down
  }

  append(stream: string, body: string): string {
    const existing = this.streams.get(stream)
    const seqNum = (this.lastSeq.get(stream) ?? -1n) + 1n
    this.lastSeq.set(stream, seqNum)
    const record = { seqNum, body }
    if (existing === undefined) this.streams.set(stream, { records: [record] })
    else existing.records.push(record)
    return String(seqNum)
  }

  /** Simulate retention trimming: drop records strictly below `fromSeq` (inclusive start kept). */
  trim(stream: string, fromSeq: string): void {
    const existing = this.streams.get(stream)
    if (existing === undefined) return
    const from = BigInt(fromSeq)
    existing.records.splice(0, existing.records.filter((record) => record.seqNum < from).length)
  }

  /** The next sequence number to be assigned ('0' for an empty/missing stream). */
  tail(stream: string): string {
    return String((this.lastSeq.get(stream) ?? -1n) + 1n)
  }

  bodiesOf(stream: string): string[] {
    return (this.streams.get(stream)?.records ?? []).map((record) => record.body)
  }

  transport(): S2Transport {
    const store = this
    return {
      async append({ stream, token, body, signal }) {
        signal.throwIfAborted()
        if (store.networkDown) throw new S2TransportError('network', 'S2 is unreachable.')
        const grant = store.grants.get(token)
        if (!grant || grant.revoked || grant.stream !== stream) throw new S2TransportError('auth', 'S2 refused the screen grant.')
        store.append(stream, body)
      },
      async tail({ stream, token, fromSeq }) {
        if (store.networkDown) throw new S2TransportError('network', `S2 stream ${stream} is unreachable.`)
        const grant = store.grants.get(token)
        if (grant === undefined || grant.revoked || grant.stream !== stream) {
          throw new S2TransportError('auth', `S2 refused the grant for ${stream}; re-subscribe for a fresh token.`)
        }
        let from = BigInt(fromSeq)
        let closed = false
        const session: S2TailSession = {
          async *[Symbol.asyncIterator](): AsyncIterator<S2TailRecord> {
            while (!closed) {
              // Mid-session failures behave like the real transport: the
              // network dropping or the grant dying ends the session with a
              // classified error (401 is definitive; the rest is network).
              if (store.networkDown) throw new S2TransportError('network', `S2 stream ${stream} is unreachable.`)
              const grant = store.grants.get(token)
              if (grant === undefined || grant.revoked) {
                throw new S2TransportError('auth', `S2 refused the grant for ${stream}; re-subscribe for a fresh token.`)
              }
              const records = (store.streams.get(stream)?.records ?? []).filter((record) => record.seqNum >= from)
              if (records.length > 0) {
                for (const record of records) {
                  from = record.seqNum + 1n
                  yield { seqNum: String(record.seqNum), body: record.body }
                }
                continue
              }
              // Caught up: poll for new records (tests drive appends directly).
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          },
          close: async () => {
            closed = true
          },
        }
        return session
      },
    }
  }
}
