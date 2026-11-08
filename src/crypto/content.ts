/**
 * Vendored from mylister-api-key-ui/src/lib/crypto/content.ts
 * Source SHA-256: 0192734f45681c66870f0f9719d826c51903bf3f88570a5f0a0c8717b3b8993f
 * Portable adaptations: Node WebCrypto fallback, ESM .js imports, runtime wording.
 * Wire format and cryptographic operations are unchanged. No browser auth/session imports.
 */
/**
 * Portable implementation of the staging core-content field codec.
 *
 * The wire format intentionally mirrors the API codec: a field is UTF-8
 * encoded, zlib/deflate compressed, split into 512 KiB pieces, and each piece
 * is authenticated with AES-256-GCM. The account and user are checked by the
 * memory-only session; they are not put into the wire AAD so existing server
 * ciphertext can be opened by an authorized client.
 */

import { portableCrypto } from './runtime.js'

export const CONTENT_ENVELOPE_VERSION = 1 as const
export const CONTENT_SCHEMA_VERSION = 3 as const
export const CONTENT_ALGORITHM = 'AES-256-GCM' as const
export const CONTENT_CHUNK_BYTES = 512 * 1024
export const CONTENT_MAX_BYTES = 16 * 1024 * 1024
export const CONTENT_MAX_CHUNKS = 33
const AES_NONCE_BYTES = 12
const AES_TAG_BYTES = 16

export type ContentSchemaVersion = 1 | 2 | 3
export type ContentCollection = 'lists' | 'items' | 'shared_list_changes' | (string & {})

/** Account/user are authorization scope, while the remaining fields bind the ciphertext. */
export interface ContentScope {
  accountId: string
  userId: string
  environment: string
  listId: string
  collection: ContentCollection
  recordId: string
  keyId: string
  path: readonly string[]
  schemaVersion?: ContentSchemaVersion
}

/** JSON transport form. Chunks are base64url, but the decoder also accepts API/BSON forms. */
export interface ContentEnvelope {
  v: typeof CONTENT_ENVELOPE_VERSION
  generation: string
  bytes: number
  chunks: string[]
}

export type ContentCryptoErrorCode =
  | 'unsupported'
  | 'compression-unavailable'
  | 'invalid-scope'
  | 'invalid-key'
  | 'locked'
  | 'scope-mismatch'
  | 'list-key-missing'
  | 'device-envelope-missing'
  | 'invalid-envelope'
  | 'authentication-failed'

export class ContentCryptoError extends Error {
  readonly code: ContentCryptoErrorCode

  constructor(code: ContentCryptoErrorCode, message: string) {
    super(message)
    this.name = 'ContentCryptoError'
    this.code = code
  }
}

export interface ContentCryptoCapabilities {
  webCrypto: boolean
  compression: boolean
  secureContext: boolean
  supported: boolean
  reason?: ContentCryptoErrorCode
}

function runtimeCrypto(): Crypto | undefined {
  return portableCrypto()
}

export function getContentCryptoCapabilities(): ContentCryptoCapabilities {
  const webCrypto = Boolean(runtimeCrypto()?.subtle && runtimeCrypto()?.getRandomValues)
  const compression = typeof globalThis.CompressionStream === 'function'
    && typeof globalThis.DecompressionStream === 'function'
  const secureContext = true
  const supported = webCrypto && compression && secureContext
  return {
    webCrypto,
    compression,
    secureContext,
    supported,
    reason: supported ? undefined : !webCrypto ? 'unsupported' : !secureContext ? 'unsupported' : 'compression-unavailable',
  }
}

function requireCapability(): Crypto {
  const capabilities = getContentCryptoCapabilities()
  if (!capabilities.webCrypto || !capabilities.secureContext) {
    throw new ContentCryptoError('unsupported', 'This runtime cannot unlock private content here.')
  }
  if (!capabilities.compression) {
    throw new ContentCryptoError('compression-unavailable', 'This runtime cannot process protected content here.')
  }
  return runtimeCrypto()!
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function validIdentity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || byteLength(value) > 256) {
    throw new ContentCryptoError('invalid-scope', `Invalid content ${name}.`)
  }
}

function validateScope(scope: ContentScope): ContentSchemaVersion {
  if (!scope || typeof scope !== 'object') throw new ContentCryptoError('invalid-scope', 'Invalid content scope.')
  validIdentity(scope.accountId, 'account')
  validIdentity(scope.userId, 'user')
  validIdentity(scope.environment, 'environment')
  validIdentity(scope.listId, 'list')
  validIdentity(scope.collection, 'collection')
  validIdentity(scope.recordId, 'record')
  validIdentity(scope.keyId, 'key')
  if (!Array.isArray(scope.path) || scope.path.length === 0 || scope.path.length > 16
    || scope.path.some(part => typeof part !== 'string' || part.length === 0 || byteLength(part) > 256)) {
    throw new ContentCryptoError('invalid-scope', 'Invalid content path.')
  }
  const schemaVersion = scope.schemaVersion ?? CONTENT_SCHEMA_VERSION
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
    throw new ContentCryptoError('invalid-scope', 'Unsupported content schema.')
  }
  return schemaVersion
}

function canonicalJson(value: unknown): string {
  // The API uses ensure_ascii=True. All normal IDs are ASCII, but escaping
  // non-ASCII here keeps the bytes identical for international environments.
  return JSON.stringify(value).replace(/[^\x00-\x7F]/g, character => {
    let escaped = ''
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`
    }
    return escaped
  })
}

/** Exact AAD layout used by services/content_encryption.py. */
export function contentAdditionalData(scope: ContentScope, generation: string, bytes: number, count: number, index: number): Uint8Array {
  const schemaVersion = validateScope(scope)
  if (!/^[0-9a-f]{32}$/.test(generation) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > CONTENT_MAX_BYTES
    || !Number.isSafeInteger(count) || count < 1 || count > CONTENT_MAX_CHUNKS
    || !Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid protected content metadata.')
  }
  const value = ['mylister-core-content', schemaVersion, scope.environment, scope.listId,
    scope.collection, scope.recordId, scope.keyId, [...scope.path], generation, bytes, count, index]
  return new TextEncoder().encode(canonicalJson(value))
}

function asBytes(value: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}

function asBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) {
    const end = Math.min(index + 0x8000, value.length)
    for (let offset = index; offset < end; offset += 1) binary += String.fromCharCode(value[offset])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64(value: unknown, maximum: number): Uint8Array {
  let encoded: unknown = value
  if (value && typeof value === 'object' && '$binary' in value) {
    const binary = (value as { $binary?: { base64?: unknown } }).$binary
    encoded = binary?.base64
  }
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(maximum / 3) * 4 + 4) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid protected content.')
  }
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid protected content.')
  }
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  let decoded: Uint8Array
  try {
    const binary = atob(padded)
    decoded = Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new ContentCryptoError('invalid-envelope', 'Invalid protected content.')
  }
  if (decoded.length > maximum) throw new ContentCryptoError('invalid-envelope', 'Protected content is too large.')
  return decoded
}

function validateKey(key: CryptoKey, usage: KeyUsage): void {
  if (!key || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM'
    || (key.algorithm as AesKeyAlgorithm).length !== 256 || key.extractable || key.usages.indexOf(usage) < 0) {
    throw new ContentCryptoError('invalid-key', 'The private content key is not usable.')
  }
}

export async function generateContentKey(): Promise<CryptoKey> {
  const crypto = requireCapability()
  return await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey
}

/** Import a key into a non-extractable WebCrypto handle; callers should clear their raw input. */
export async function importContentKey(raw: string | ArrayBuffer | ArrayBufferView): Promise<CryptoKey> {
  const crypto = requireCapability()
  const bytes = asBytes(raw)
  if (bytes.byteLength !== 32) throw new ContentCryptoError('invalid-key', 'The private content key is not usable.')
  const material = asBuffer(bytes)
  try {
    return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } catch {
    throw new ContentCryptoError('invalid-key', 'The private content key is not usable.')
  } finally {
    bytes.fill(0)
    new Uint8Array(material).fill(0)
  }
}

async function streamTransform(input: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  requireCapability()
  const stream = new Blob([asBuffer(input)]).stream().pipeThrough(
    mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate'),
  )
  const reader = stream.getReader()
  const output: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = new Uint8Array(next.value)
      total += chunk.byteLength
      if (total > CONTENT_MAX_BYTES + 1) throw new ContentCryptoError('invalid-envelope', 'Protected content is too large.')
      output.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (let index = 0; index < output.length; index += 1) {
    const chunk = output[index]
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function randomGeneration(crypto: Crypto): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function randomNonce(crypto: Crypto): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES))
}

/** Encode one protected text field using the existing core-content envelope. */
export async function sealContent(value: string | null, key: CryptoKey, scope: ContentScope, options?: { generation?: string; nonce?: Uint8Array }): Promise<ContentEnvelope | null> {
  if (value === null) return null
  if (typeof value !== 'string' || byteLength(value) > CONTENT_MAX_BYTES) throw new ContentCryptoError('invalid-envelope', 'Protected content is too large.')
  const crypto = requireCapability()
  validateKey(key, 'encrypt')
  validateScope(scope)
  const raw = asBytes(value)
  const packed = await streamTransform(raw, 'compress')
  const count = Math.ceil(packed.byteLength / CONTENT_CHUNK_BYTES)
  if (count < 1 || count > CONTENT_MAX_CHUNKS) throw new ContentCryptoError('invalid-envelope', 'Protected content is too large.')
  const generation = options?.generation ?? randomGeneration(crypto)
  if (!/^[0-9a-f]{32}$/.test(generation)) throw new ContentCryptoError('invalid-envelope', 'Invalid protected content metadata.')
  const chunks: string[] = []
  for (let index = 0; index < count; index += 1) {
    const piece = packed.subarray(index * CONTENT_CHUNK_BYTES, Math.min((index + 1) * CONTENT_CHUNK_BYTES, packed.byteLength))
    const nonce = options?.nonce && index === 0 ? options.nonce : randomNonce(crypto)
    if (nonce.byteLength !== AES_NONCE_BYTES) throw new ContentCryptoError('invalid-envelope', 'Invalid protected content nonce.')
    try {
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(contentAdditionalData(scope, generation, raw.byteLength, count, index)), tagLength: 128 },
        key, asBuffer(piece),
      ))
      const combined = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
      combined.set(nonce, 0)
      combined.set(ciphertext, nonce.byteLength)
      chunks.push(encodeBase64Url(combined))
    } catch {
      throw new ContentCryptoError('authentication-failed', 'Protected content could not be encrypted.')
    }
  }
  return { v: CONTENT_ENVELOPE_VERSION, generation, bytes: raw.byteLength, chunks }
}

function envelopeChunks(value: unknown): { generation: string; bytes: number; chunks: unknown[] } {
  if (!value || typeof value !== 'object') throw new ContentCryptoError('invalid-envelope', 'Invalid protected content.')
  const envelope = value as Partial<ContentEnvelope>
  const bytes = envelope.bytes
  if (envelope.v !== CONTENT_ENVELOPE_VERSION || typeof envelope.generation !== 'string'
    || !/^[0-9a-f]{32}$/.test(envelope.generation) || typeof bytes !== 'number' || !Number.isSafeInteger(bytes)
    || bytes < 0 || bytes > CONTENT_MAX_BYTES || !Array.isArray(envelope.chunks)
    || envelope.chunks.length < 1 || envelope.chunks.length > CONTENT_MAX_CHUNKS) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid protected content.')
  }
  return { generation: envelope.generation, bytes: bytes as number, chunks: envelope.chunks }
}

/** Decode the API/BSON-compatible envelope and return the authenticated UTF-8 text. */
export async function openContent(value: ContentEnvelope, key: CryptoKey, scope: ContentScope): Promise<string> {
  const crypto = requireCapability()
  validateKey(key, 'decrypt')
  validateScope(scope)
  const envelope = envelopeChunks(value)
  const packedPieces: Uint8Array[] = []
  let packedBytes = 0
  for (let index = 0; index < envelope.chunks.length; index += 1) {
    const chunk = decodeBase64(envelope.chunks[index], CONTENT_CHUNK_BYTES + AES_NONCE_BYTES + AES_TAG_BYTES)
    if (chunk.byteLength < AES_NONCE_BYTES + AES_TAG_BYTES) throw new ContentCryptoError('invalid-envelope', 'Invalid protected content.')
    const nonce = chunk.subarray(0, AES_NONCE_BYTES)
    const ciphertext = chunk.subarray(AES_NONCE_BYTES)
    try {
      const clear = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(contentAdditionalData(scope, envelope.generation, envelope.bytes, envelope.chunks.length, index)), tagLength: 128 },
        key, asBuffer(ciphertext),
      ))
      packedPieces.push(clear)
      packedBytes += clear.byteLength
      if (packedBytes > CONTENT_MAX_BYTES) throw new ContentCryptoError('invalid-envelope', 'Protected content is too large.')
    } catch (error) {
      if (error instanceof ContentCryptoError) throw error
      throw new ContentCryptoError('authentication-failed', 'Protected content could not be opened.')
    }
  }
  const packed = new Uint8Array(packedBytes)
  let offset = 0
  for (let index = 0; index < packedPieces.length; index += 1) {
    const piece = packedPieces[index]
    packed.set(piece, offset)
    offset += piece.byteLength
  }
  let raw: Uint8Array
  try { raw = await streamTransform(packed, 'decompress') } catch (error) {
    if (error instanceof ContentCryptoError && error.code === 'invalid-envelope') throw error
    throw new ContentCryptoError('invalid-envelope', 'Protected content could not be decompressed.')
  }
  if (raw.byteLength !== envelope.bytes) throw new ContentCryptoError('invalid-envelope', 'Protected content length did not match.')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch {
    throw new ContentCryptoError('invalid-envelope', 'Protected content was not valid text.')
  }
}
