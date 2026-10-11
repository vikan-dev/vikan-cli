import { createHash, randomBytes } from 'node:crypto'

/**
 * Pairing cryptography (plan §6.1). The CLI generates two INDEPENDENT
 * high-entropy secrets: the pairing secret (proves the claim) and the device
 * credential (the long-lived bearer). Only SHA-256 hex digests ever cross the
 * wire — the server stores hashes, never plaintext.
 */

/**
 * 32 random bytes as 43-char base64url: unguessable, URL-safe, and exactly
 * the shape the server's device bearer pattern accepts.
 */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 hex digest — the same digest the server computes on its side. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
