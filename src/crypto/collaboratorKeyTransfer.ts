/**
 * Extracted from mylister-api-key-ui/src/lib/crypto/collaboratorKeyTransfer.ts.
 * Source SHA-256: a8416482426dc914b8616d120ff9a94468c34c59ca2607b9bda9ab1fed63f8fc
 * Portable adaptations: pure creation only, shared base64/Node WebCrypto helpers,
 * ESM imports and bounded inputs. Browser session/auth/network operations omitted.
 * The ECDH/HKDF/AES-GCM wire protocol and request body remain unchanged.
 */
import { ContentCryptoError } from './content.js'
import { encodeBase64Url as encode, scopeText, type P256Jwk } from './p256.js'
import { portableCrypto as runtime } from './runtime.js'

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

export const COLLABORATOR_TRANSFER_PROTOCOL_VERSION = 1 as const
export const COLLABORATOR_TRANSFER_DOMAIN = 'mylister-collaborator-list-dek-transfer-v1'
export const COLLABORATOR_TRANSFER_PAYLOAD_BYTES = 64
export const COLLABORATOR_TRANSFER_TTL_SECONDS = 7 * 24 * 60 * 60

export interface CollaboratorTransferInput {
  listId: string
  keyId: string
  ownerUserId: string
  recipientUserId: string
  membershipGrantId: string
  recipientExchangeKeyId: string
  recipientExchangeKeyVersion: number
  recipientExchangeKeyFingerprint: string
  recipientPublicKey: P256Jwk
  ttlSeconds?: number
}

export interface CollaboratorTransferCiphertext {
  version: 1
  algorithm: 'AES-256-GCM'
  aad: string
  iv: string
  salt: string
  ciphertext: string
}

export interface CollaboratorTransferRequest extends Omit<CollaboratorTransferInput, 'recipientPublicKey' | 'ttlSeconds'> {
  transferId: string
  ephemeralPublicKey: P256Jwk
  transfer: CollaboratorTransferCiphertext
  acceptanceSecretHash: string
  expectedVersion: number
  idempotencyKey: string
  ttlSeconds: number
}

function validateInput(input: CollaboratorTransferInput): void {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(input.recipientExchangeKeyVersion)
    || input.recipientExchangeKeyVersion < 1) {
    throw new ContentCryptoError('invalid-scope', 'The list-key transfer scope was invalid.')
  }
  for (const value of [input.listId, input.keyId, input.ownerUserId, input.recipientUserId,
    input.membershipGrantId, input.recipientExchangeKeyId, input.recipientExchangeKeyFingerprint]) scopeText(value)
  if (!/^[0-9a-f]{64}$/.test(input.recipientExchangeKeyFingerprint)) {
    throw new ContentCryptoError('invalid-scope', 'The collaborator exchange key fingerprint was invalid.')
  }
}

function aad(input: Omit<CollaboratorTransferInput, 'recipientPublicKey' | 'ttlSeconds'>, transferId: string): Uint8Array {
  if (!input || !transferId || input.recipientExchangeKeyVersion < 1) throw new ContentCryptoError('invalid-scope', 'The list-key transfer scope was invalid.')
  return new TextEncoder().encode(JSON.stringify([
    COLLABORATOR_TRANSFER_DOMAIN, COLLABORATOR_TRANSFER_PROTOCOL_VERSION,
    transferId, input.listId, input.keyId, input.ownerUserId, input.recipientUserId,
    input.membershipGrantId, input.recipientExchangeKeyId,
    input.recipientExchangeKeyVersion, input.recipientExchangeKeyFingerprint,
  ]))
}

async function fingerprintSecret(secret: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await runtime().subtle.digest('SHA-256', bytes(secret)))
  try { return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') } finally { digest.fill(0) }
}

async function deriveTransferKey(shared: ArrayBuffer, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const crypto = runtime()
  let material = new Uint8Array(shared)
  try {
    const base = await crypto.subtle.importKey('raw', bytes(material), 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally { material.fill(0) }
}

async function importPublicKey(jwk: P256Jwk): Promise<CryptoKey> {
  try { return await runtime().subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }
  catch { throw new ContentCryptoError('invalid-key', 'The collaborator exchange key was invalid.') }
}

function canonicalPublicKey(value: JsonWebKey): P256Jwk {
  if (value?.kty !== 'EC' || value.crv !== 'P-256'
    || typeof value.x !== 'string' || typeof value.y !== 'string') {
    throw new ContentCryptoError('invalid-key', 'The collaborator exchange key was invalid.')
  }
  return { crv: 'P-256', kty: 'EC', x: value.x, y: value.y }
}

/** Encrypt a 32-byte list DEK and random acceptance secret for one grant. */
export async function createCollaboratorKeyTransfer(rawDek: Uint8Array, input: CollaboratorTransferInput): Promise<CollaboratorTransferRequest> {
  if (!(rawDek instanceof Uint8Array) || rawDek.byteLength !== 32) throw new ContentCryptoError('invalid-key', 'The list content key is invalid.')
  validateInput(input)
  let payload: Uint8Array | undefined
  let secret: Uint8Array | undefined
  let shared: ArrayBuffer | undefined
  try {
    const crypto = runtime()
    const ttlSeconds = input.ttlSeconds ?? COLLABORATOR_TRANSFER_TTL_SECONDS
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > COLLABORATOR_TRANSFER_TTL_SECONDS) {
      throw new ContentCryptoError('invalid-scope', 'The list-key transfer lifetime was invalid.')
    }
    const transferIdBytes = crypto.getRandomValues(new Uint8Array(32))
    const transferId = encode(transferIdBytes)
    transferIdBytes.fill(0)
    const generated = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    const ephemeralPublicKey = canonicalPublicKey(await crypto.subtle.exportKey('jwk', generated.publicKey))
    const recipientPublic = await importPublicKey(input.recipientPublicKey)
    shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientPublic }, generated.privateKey, 256)
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const transferAad = aad(input, transferId)
    const key = await deriveTransferKey(shared, salt, transferAad)
    payload = new Uint8Array(COLLABORATOR_TRANSFER_PAYLOAD_BYTES)
    payload.set(rawDek, 0)
    secret = crypto.getRandomValues(new Uint8Array(32))
    payload.set(secret, 32)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(transferAad), tagLength: 128 }, key, bytes(payload)))
    return {
      listId: input.listId, keyId: input.keyId, ownerUserId: input.ownerUserId,
      recipientUserId: input.recipientUserId, membershipGrantId: input.membershipGrantId,
      recipientExchangeKeyId: input.recipientExchangeKeyId,
      recipientExchangeKeyVersion: input.recipientExchangeKeyVersion,
      recipientExchangeKeyFingerprint: input.recipientExchangeKeyFingerprint,
      transferId, ephemeralPublicKey,
      transfer: { version: 1, algorithm: 'AES-256-GCM', aad: encode(transferAad), iv: encode(iv), salt: encode(salt), ciphertext: encode(ciphertext) },
      acceptanceSecretHash: await fingerprintSecret(secret), expectedVersion: 0,
      idempotencyKey: `collaborator-transfer-${transferId}`,
      ttlSeconds,
    }
  } catch (error) {
    if (error instanceof ContentCryptoError) throw error
    throw new ContentCryptoError('authentication-failed', 'The list-key transfer could not be created.')
  } finally {
    payload?.fill(0); secret?.fill(0); if (shared) new Uint8Array(shared).fill(0)
  }
}

