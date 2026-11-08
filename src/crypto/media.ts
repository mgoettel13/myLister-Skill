/**
 * Vendored from mylister-api-key-ui/src/lib/crypto/media.ts
 * Source SHA-256: f286a1f2808b2cd1c083c42aef61d9a9bdceb1cc6ad502c3dcc217d586a56e98
 * Portable adaptations: Node WebCrypto fallback, ESM .js imports, runtime wording.
 * Wire format and cryptographic operations are unchanged. No browser auth/session imports.
 */
import { portableCrypto } from './runtime.js'
import { ContentCryptoError } from './content.js'

export const CONTENT_MEDIA_VERSION = 1 as const
export const CONTENT_MEDIA_MAX_BYTES = 50 * 1024 * 1024
export const CONTENT_MEDIA_CHUNK_BYTES = 1024 * 1024
const MEDIA_MAGIC = Uint8Array.of(0x4d, 0x4c, 0x4d, CONTENT_MEDIA_VERSION) // MLM + version
const OUTER_HEADER_BYTES = 12
const NONCE_BYTES = 12
const LENGTH_BYTES = 4
const TAG_BYTES = 16
const FRAME_OVERHEAD_BYTES = NONCE_BYTES + LENGTH_BYTES + TAG_BYTES
const MAX_HEADER_BYTES = 4096
const MAX_CHUNKS = Math.ceil((CONTENT_MEDIA_MAX_BYTES + LENGTH_BYTES + MAX_HEADER_BYTES) / CONTENT_MEDIA_CHUNK_BYTES)

export type ContentMediaTarget =
  | 'list_cover'
  | 'item_image'
  | 'item_voice'
  | 'note_image'
  | 'note_voice'
  | 'item_attachment'
  | 'note_attachment'
  | 'comment_attachment'

/** The owner scope stays stable when an authorized collaborator opens the same blob. */
export interface ContentMediaScope {
  ownerAccountId: string
  ownerUserId: string
  environment: string
  listId: string
  keyId: string
  target: ContentMediaTarget
  stableId: string
  /** Parent records are authenticated with the media so a blob cannot be
   * substituted between items, notes, or comments in the same list. */
  itemId?: string
  noteId?: string
  commentId?: string
}

const MEDIA_TARGETS = new Set<ContentMediaTarget>([
  'list_cover', 'item_image', 'item_voice', 'note_image', 'note_voice',
  'item_attachment', 'note_attachment', 'comment_attachment',
])

export interface ContentMediaInput {
  bytes: Uint8Array
  name: string
  contentType: string
}

export interface OpenedContentMedia extends ContentMediaInput {
  version: typeof CONTENT_MEDIA_VERSION
}

function cryptoRuntime(): Crypto {
  return portableCrypto()
}

function bufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value.buffer instanceof ArrayBuffer)) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file buffer.')
  }
  // WebCrypto respects the view's byteOffset/byteLength. Keeping the view
  // avoids cloning an entire photo or attachment before every crypto call.
  return value as Uint8Array<ArrayBuffer>
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
}

function validateKey(key: CryptoKey, usage: KeyUsage): void {
  if (!key || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM'
    || (key.algorithm as AesKeyAlgorithm).length !== 256 || key.extractable
    || !key.usages.includes(usage)) {
    throw new ContentCryptoError('invalid-key', 'The private file key is unavailable.')
  }
}

export function mediaAdditionalData(scope: ContentMediaScope): Uint8Array {
  if (!scope || !validText(scope.ownerAccountId, 256) || !validText(scope.ownerUserId, 256)
    || !validText(scope.environment, 255)
    || !/^[0-9a-fA-F]{24}$/.test(scope.listId)
    || !/^[0-9a-fA-F]{24}$/.test(scope.keyId)
    || !MEDIA_TARGETS.has(scope.target)
    || !validText(scope.stableId, 128)
    || (scope.itemId !== undefined && !validText(scope.itemId, 128))
    || (scope.noteId !== undefined && !validText(scope.noteId, 128))
    || (scope.commentId !== undefined && !validText(scope.commentId, 128))) {
    throw new ContentCryptoError('invalid-scope', 'Invalid private file scope.')
  }
  const hasItem = scope.itemId !== undefined
  const hasNote = scope.noteId !== undefined
  const hasComment = scope.commentId !== undefined
  const validTargetScope = scope.target === 'list_cover'
    ? !hasItem && !hasNote && !hasComment
    : scope.target === 'comment_attachment'
      // Comments may belong directly to an item or be nested under a note.
      // Keep noteId in the AAD whenever supplied so the same ciphertext cannot
      // be substituted between comment locations.
      ? hasItem && hasComment
      : scope.target.startsWith('note_')
        ? hasItem && hasNote && !hasComment
        : hasItem && !hasNote && !hasComment
  if (!validTargetScope) {
    throw new ContentCryptoError('invalid-scope', 'Invalid private file parent scope.')
  }
  return new TextEncoder().encode(JSON.stringify([
    'mylister-content-media-v1', CONTENT_MEDIA_VERSION,
    scope.ownerAccountId, scope.ownerUserId, scope.environment, scope.listId,
    scope.keyId, scope.target, scope.stableId,
    scope.itemId ?? null, scope.noteId ?? null, scope.commentId ?? null,
  ]))
}

function chunkAdditionalData(scope: ContentMediaScope, index: number,
                             count: number, fileSize: number): Uint8Array {
  const base = new TextDecoder().decode(mediaAdditionalData(scope))
  return new TextEncoder().encode(JSON.stringify([base, index, count, fileSize]))
}

function encodeHeader(input: ContentMediaInput): Uint8Array {
  if (!(input?.bytes instanceof Uint8Array) || !(input.bytes.buffer instanceof ArrayBuffer)
    || input.bytes.byteLength < 1 || input.bytes.byteLength > CONTENT_MEDIA_MAX_BYTES
    || !validText(input.name, 255) || !validText(input.contentType, 255)) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file.')
  }
  const header = new TextEncoder().encode(JSON.stringify({
    v: CONTENT_MEDIA_VERSION,
    name: input.name,
    contentType: input.contentType,
    size: input.bytes.byteLength,
  }))
  if (header.byteLength > MAX_HEADER_BYTES) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file metadata.')
  }
  const prefix = new Uint8Array(LENGTH_BYTES + header.byteLength)
  new DataView(prefix.buffer).setUint32(0, header.byteLength, false)
  prefix.set(header, LENGTH_BYTES)
  return prefix
}

function decodeHeader(value: Uint8Array, expectedSize: number): {
  name: string
  contentType: string
  prefixBytes: number
} {
  if (value.byteLength < LENGTH_BYTES + 1) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file.')
  }
  const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, false)
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES
    || LENGTH_BYTES + headerLength >= value.byteLength) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file.')
  }
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      value.subarray(LENGTH_BYTES, LENGTH_BYTES + headerLength),
    ))
  } catch {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file metadata.')
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file metadata.')
  }
  const record = header as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'contentType,name,size,v'
    || record.v !== CONTENT_MEDIA_VERSION
    || !validText(record.name, 255) || !validText(record.contentType, 255)
    || record.size !== expectedSize) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file metadata.')
  }
  return {
    name: record.name,
    contentType: record.contentType,
    prefixBytes: LENGTH_BYTES + headerLength,
  }
}

export async function sealContentMedia(
  key: CryptoKey,
  scope: ContentMediaScope,
  input: ContentMediaInput,
): Promise<Uint8Array> {
  const runtime = cryptoRuntime()
  validateKey(key, 'encrypt')
  const prefix = encodeHeader(input)
  const logicalSize = prefix.byteLength + input.bytes.byteLength
  const chunkCount = Math.ceil(logicalSize / CONTENT_MEDIA_CHUNK_BYTES)
  const output = new Uint8Array(OUTER_HEADER_BYTES + logicalSize + chunkCount * FRAME_OVERHEAD_BYTES)
  output.set(MEDIA_MAGIC, 0)
  const outer = new DataView(output.buffer)
  outer.setUint32(4, chunkCount, false)
  outer.setUint32(8, input.bytes.byteLength, false)
  let outputOffset = OUTER_HEADER_BYTES
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const logicalOffset = index * CONTENT_MEDIA_CHUNK_BYTES
      const plaintextLength = Math.min(CONTENT_MEDIA_CHUNK_BYTES, logicalSize - logicalOffset)
      let plaintext: Uint8Array
      let temporary: Uint8Array | undefined
      if (index === 0) {
        temporary = new Uint8Array(plaintextLength)
        temporary.set(prefix, 0)
        temporary.set(input.bytes.subarray(0, plaintextLength - prefix.byteLength), prefix.byteLength)
        plaintext = temporary
      } else {
        const sourceOffset = logicalOffset - prefix.byteLength
        plaintext = input.bytes.subarray(sourceOffset, sourceOffset + plaintextLength)
      }
      const nonce = output.subarray(outputOffset, outputOffset + NONCE_BYTES)
      runtime.getRandomValues(nonce)
      const aad = chunkAdditionalData(scope, index, chunkCount, input.bytes.byteLength)
      try {
        const ciphertext = new Uint8Array(await runtime.subtle.encrypt(
          { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: bufferSource(aad), tagLength: 128 },
          key,
          bufferSource(plaintext),
        ))
        new DataView(output.buffer).setUint32(outputOffset + NONCE_BYTES, ciphertext.byteLength, false)
        output.set(ciphertext, outputOffset + NONCE_BYTES + LENGTH_BYTES)
        outputOffset += NONCE_BYTES + LENGTH_BYTES + ciphertext.byteLength
      } finally {
        temporary?.fill(0)
      }
    }
    if (outputOffset !== output.byteLength) {
      throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
    }
    return output
  } catch (error) {
    output.fill(0)
    if (error instanceof ContentCryptoError) throw error
    throw new ContentCryptoError('authentication-failed', 'The private file could not be protected.')
  } finally {
    prefix.fill(0)
  }
}

export async function openContentMedia(
  key: CryptoKey,
  scope: ContentMediaScope,
  blob: Uint8Array,
): Promise<OpenedContentMedia> {
  const runtime = cryptoRuntime()
  validateKey(key, 'decrypt')
  if (!(blob instanceof Uint8Array) || !(blob.buffer instanceof ArrayBuffer)
    || blob.byteLength < OUTER_HEADER_BYTES + FRAME_OVERHEAD_BYTES + LENGTH_BYTES + 1
    || MEDIA_MAGIC.some((byte, index) => blob[index] !== byte)) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file.')
  }
  const outer = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const chunkCount = outer.getUint32(4, false)
  const fileSize = outer.getUint32(8, false)
  if (chunkCount < 1 || chunkCount > MAX_CHUNKS
    || fileSize < 1 || fileSize > CONTENT_MEDIA_MAX_BYTES) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file.')
  }
  const logicalSize = blob.byteLength - OUTER_HEADER_BYTES - chunkCount * FRAME_OVERHEAD_BYTES
  if (logicalSize <= fileSize || logicalSize > fileSize + LENGTH_BYTES + MAX_HEADER_BYTES
    || chunkCount !== Math.ceil(logicalSize / CONTENT_MEDIA_CHUNK_BYTES)) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
  }

  const frames: Array<{ nonce: Uint8Array; ciphertext: Uint8Array; plaintextLength: number }> = []
  let frameOffset = OUTER_HEADER_BYTES
  for (let index = 0; index < chunkCount; index += 1) {
    const plaintextLength = Math.min(CONTENT_MEDIA_CHUNK_BYTES, logicalSize - index * CONTENT_MEDIA_CHUNK_BYTES)
    if (frameOffset + NONCE_BYTES + LENGTH_BYTES > blob.byteLength) {
      throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
    }
    const ciphertextLength = outer.getUint32(frameOffset + NONCE_BYTES, false)
    if (ciphertextLength !== plaintextLength + TAG_BYTES
      || frameOffset + NONCE_BYTES + LENGTH_BYTES + ciphertextLength > blob.byteLength) {
      throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
    }
    frames.push({
      nonce: blob.subarray(frameOffset, frameOffset + NONCE_BYTES),
      ciphertext: blob.subarray(
        frameOffset + NONCE_BYTES + LENGTH_BYTES,
        frameOffset + NONCE_BYTES + LENGTH_BYTES + ciphertextLength,
      ),
      plaintextLength,
    })
    frameOffset += NONCE_BYTES + LENGTH_BYTES + ciphertextLength
  }
  if (frameOffset !== blob.byteLength) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
  }

  const bytes = new Uint8Array(fileSize)
  let written = 0
  let metadata: { name: string; contentType: string } | undefined
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      const aad = chunkAdditionalData(scope, index, chunkCount, fileSize)
      const plaintext = new Uint8Array(await runtime.subtle.decrypt(
        { name: 'AES-GCM', iv: bufferSource(frame.nonce), additionalData: bufferSource(aad), tagLength: 128 },
        key,
        bufferSource(frame.ciphertext),
      ))
      try {
        if (plaintext.byteLength !== frame.plaintextLength) {
          throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
        }
        if (index === 0) {
          const header = decodeHeader(plaintext, fileSize)
          metadata = { name: header.name, contentType: header.contentType }
          const firstBytes = plaintext.subarray(header.prefixBytes)
          bytes.set(firstBytes, 0)
          written = firstBytes.byteLength
        } else {
          bytes.set(plaintext, written)
          written += plaintext.byteLength
        }
      } finally {
        plaintext.fill(0)
      }
    }
    if (!metadata || written !== fileSize) {
      throw new ContentCryptoError('invalid-envelope', 'Invalid private file framing.')
    }
    return { version: CONTENT_MEDIA_VERSION, bytes, ...metadata }
  } catch (error) {
    bytes.fill(0)
    if (error instanceof ContentCryptoError) throw error
    throw new ContentCryptoError('authentication-failed', 'The private file could not be opened.')
  }
}
