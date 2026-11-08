/**
 * Vendored from mylister-api-key-ui/src/lib/crypto/keyEnvelope.ts
 * Source SHA-256: 10a142962d9d2ed30c77177e22d70996fe966a4190395014bd76cf3ce8d4c72e
 * Portable adaptations: Node WebCrypto fallback, ESM .js imports, runtime wording.
 * Wire format and cryptographic operations are unchanged. No browser auth/session imports.
 */
import { portableCrypto } from './runtime.js'
import { ContentCryptoError, CONTENT_ALGORITHM } from './content.js'

export const KEY_ENVELOPE_VERSION = 1 as const

export interface KeyEnvelope {
  version: typeof KEY_ENVELOPE_VERSION
  algorithm: typeof CONTENT_ALGORITHM
  aad: string
  iv: string
  ciphertext: string
}

function cryptoRuntime(): Crypto {
  return portableCrypto()
}

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function encode(value: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) {
    const end = Math.min(index + 0x8000, value.length)
    for (let offset = index; offset < end; offset += 1) binary += String.fromCharCode(value[offset])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decode(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > maximum * 2) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key envelope.')
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key envelope.')
  }
  try {
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
    const result = Uint8Array.from(binary, character => character.charCodeAt(0))
    if (result.length > maximum) throw new Error('too large')
    return result
  } catch {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key envelope.')
  }
}

function aadJson(domain: string, values: readonly string[]): Uint8Array {
  if (typeof domain !== 'string' || !domain || values.length > 16
    || values.some(value => typeof value !== 'string' || !value || value.length > 256)) {
    throw new ContentCryptoError('invalid-scope', 'Invalid private key scope.')
  }
  return new TextEncoder().encode(JSON.stringify([domain, KEY_ENVELOPE_VERSION, ...values]))
}

export function keyEnvelopeAdditionalData(domain: string, values: readonly string[]): Uint8Array {
  return aadJson(domain, values)
}

function validateWrappingKey(key: CryptoKey, usage: KeyUsage): void {
  if (!key || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM'
    || (key.algorithm as AesKeyAlgorithm).length !== 256 || key.extractable
    || key.usages.indexOf(usage) < 0) {
    throw new ContentCryptoError('invalid-key', 'The private key envelope key is not usable.')
  }
}

export async function wrapKeyBytes(key: CryptoKey, raw: Uint8Array, additionalData: Uint8Array): Promise<KeyEnvelope> {
  if (raw.byteLength !== 32) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key material.')
  }
  return sealKeyBlob(key, raw, additionalData, 32)
}

/** Seal a bounded opaque key blob. The caller owns and must clear `raw`. */
export async function sealKeyBlob(
  key: CryptoKey,
  raw: Uint8Array,
  additionalData: Uint8Array,
  maximumPlaintextBytes = 1024,
): Promise<KeyEnvelope> {
  const crypto = cryptoRuntime()
  validateWrappingKey(key, 'encrypt')
  if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > maximumPlaintextBytes
    || maximumPlaintextBytes < 1 || maximumPlaintextBytes > 4096 || additionalData.byteLength > 4096) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key material.')
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(nonce), additionalData: bytes(additionalData), tagLength: 128 },
      key, bytes(raw),
    ))
    return {
      version: KEY_ENVELOPE_VERSION,
      algorithm: CONTENT_ALGORITHM,
      aad: encode(additionalData),
      iv: encode(nonce),
      ciphertext: encode(ciphertext),
    }
  } catch {
    throw new ContentCryptoError('authentication-failed', 'The private key envelope could not be created.')
  }
}

export async function unwrapKeyBytes(envelope: KeyEnvelope, key: CryptoKey, additionalData: Uint8Array): Promise<Uint8Array> {
  const raw = await openKeyBlob(envelope, key, additionalData, 32)
  if (raw.byteLength !== 32) {
    raw.fill(0)
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key envelope.')
  }
  return raw
}

/** Open a bounded opaque key blob. The caller must clear the returned bytes. */
export async function openKeyBlob(
  envelope: KeyEnvelope,
  key: CryptoKey,
  additionalData: Uint8Array,
  maximumPlaintextBytes = 1024,
): Promise<Uint8Array> {
  const crypto = cryptoRuntime()
  validateWrappingKey(key, 'decrypt')
  if (!envelope || envelope.version !== KEY_ENVELOPE_VERSION || envelope.algorithm !== CONTENT_ALGORITHM
    || additionalData.byteLength > 4096 || maximumPlaintextBytes < 1 || maximumPlaintextBytes > 4096) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key envelope.')
  }
  const expectedAad = encode(additionalData)
  if (envelope.aad !== expectedAad) {
    throw new ContentCryptoError('invalid-envelope', 'Private key envelope scope did not match.')
  }
  const nonce = decode(envelope.iv, 12)
  const ciphertext = decode(envelope.ciphertext, maximumPlaintextBytes + 16)
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > maximumPlaintextBytes + 16) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private key envelope.')
  }
  try {
    const raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(nonce), additionalData: bytes(additionalData), tagLength: 128 },
      key, bytes(ciphertext),
    ))
    if (raw.byteLength < 1 || raw.byteLength > maximumPlaintextBytes) throw new Error('invalid length')
    return raw
  } catch {
    throw new ContentCryptoError('authentication-failed', 'The private key envelope could not be opened.')
  }
}
