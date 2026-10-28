import { createHash } from 'node:crypto'

// sha256 hex of a UTF-8 string — matches the server's content hashing so the
// record_hash (which binds the content SHA, not raw text) stays verifiable
// whether or not raw content is retained.
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
