import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import 'server-only'

// AES-256-GCM for provider credentials at rest. The key lives ONLY in
// CONNECTOR_ENC_KEY (base64, 32 bytes) in server env - never in the database,
// never in the client bundle. So a Postgres read of provider_connection without
// this env key yields opaque ciphertext; RLS firm-scoping is the second layer.
function key(): Buffer {
  const b64 = process.env.CONNECTOR_ENC_KEY
  if (!b64) throw new Error('CONNECTOR_ENC_KEY is not set')
  const k = Buffer.from(b64, 'base64')
  if (k.length !== 32) throw new Error('CONNECTOR_ENC_KEY must be 32 bytes (base64)')
  return k
}

export type Sealed = { ciphertext: string; iv: string; tag: string } // all base64

export function sealSecret(plaintext: string): Sealed {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

export function openSecret(s: Sealed): string {
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(s.iv, 'base64'))
  d.setAuthTag(Buffer.from(s.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(s.ciphertext, 'base64')), d.final()]).toString('utf8')
}
