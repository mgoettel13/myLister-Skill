import { ContentCryptoError, importContentKey } from './crypto/content.js';
import { keyEnvelopeAdditionalData, unwrapKeyBytes, wrapKeyBytes, type KeyEnvelope } from './crypto/keyEnvelope.js';
import { canonicalPublicKey, decodeBase64Url, installationFingerprint, scopeText, type P256Jwk } from './crypto/p256.js';
import { portableCrypto } from './crypto/runtime.js';
import type { InstallationIdentity } from './identity.js';

export * from './crypto/content.js';
export * from './crypto/media.js';
export * from './crypto/collaboratorKeyTransfer.js';
export { keyEnvelopeAdditionalData } from './crypto/keyEnvelope.js';
export type { KeyEnvelope } from './crypto/keyEnvelope.js';
export type { P256Jwk } from './crypto/p256.js';

export interface AccountKeyEnvelope {
  ephemeralPublicKey: P256Jwk;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface AccountKeyScope {
  environment: string;
  userId: string;
  accountKeyId: 'account-key-v1';
}

export interface ListKeyScope {
  accountId: string;
  userId: string;
  listId: string;
  keyId: string;
}

/** Account grant uses the flat protocol array, without the list-envelope version. */
export function accountKeyAdditionalData(scope: AccountKeyScope, installationId: string): Uint8Array<ArrayBuffer> {
  if (!scope || typeof scope !== 'object' || scope.accountKeyId !== 'account-key-v1'
    || typeof installationId !== 'string' || !/^[0-9a-f]{64}$/.test(installationId)) {
    throw new ContentCryptoError('invalid-scope', 'Invalid account key scope.');
  }
  scopeText(scope.environment);
  scopeText(scope.userId);
  return new TextEncoder().encode(JSON.stringify([
    'mylister-api-key-account-wrap-v1', scope.environment, scope.userId, installationId, 'account-key-v1',
  ]));
}

/** ECDH(P-256) -> HKDF-SHA256 -> AES-256-GCM. Returned root cannot be exported. */
export async function unwrapAccountKey(
  envelope: AccountKeyEnvelope,
  identity: InstallationIdentity,
  scope: AccountKeyScope,
): Promise<CryptoKey> {
  const runtime = portableCrypto();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'ciphertext,ephemeralPublicKey,iv,salt') {
    throw new ContentCryptoError('invalid-envelope', 'Invalid account key envelope.');
  }
  const ephemeralPublicKey = canonicalPublicKey(envelope.ephemeralPublicKey);
  const salt = decodeBase64Url(envelope.salt, 32);
  const iv = decodeBase64Url(envelope.iv, 12);
  const ciphertext = decodeBase64Url(envelope.ciphertext, 48);
  if (!identity || !identity.privateKey || identity.privateKey.type !== 'private'
    || identity.privateKey.algorithm.name !== 'ECDH'
    || (identity.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256'
    || identity.privateKey.extractable || !identity.privateKey.usages.includes('deriveBits')
    || await installationFingerprint(identity.publicKey) !== identity.installationId) {
    throw new ContentCryptoError('invalid-key', 'The installation key is not usable.');
  }
  const aad = accountKeyAdditionalData(scope, identity.installationId);
  let shared: Uint8Array<ArrayBuffer> | undefined;
  let raw: Uint8Array | undefined;
  try {
    const ephemeral = await runtime.subtle.importKey('jwk', { ...ephemeralPublicKey }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    shared = new Uint8Array(await runtime.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, identity.privateKey, 256));
    const material = await runtime.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const wrappingKey = await runtime.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: aad }, material,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    raw = new Uint8Array(await runtime.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, wrappingKey, ciphertext));
    return await importContentKey(raw);
  } catch {
    throw new ContentCryptoError('authentication-failed', 'The account key envelope could not be opened.');
  } finally {
    shared?.fill(0);
    raw?.fill(0);
  }
}

function listKeyAdditionalData(scope: ListKeyScope): Uint8Array {
  if (!scope || typeof scope !== 'object') throw new ContentCryptoError('invalid-scope', 'Invalid list key scope.');
  for (const value of [scope.accountId, scope.userId, scope.listId, scope.keyId]) scopeText(value);
  // UI keyEnvelopeAdditionalData is JSON.stringify([domain, 1, ...values]), not nested.
  return keyEnvelopeAdditionalData('mylister-list-key-wrap-v1', [scope.accountId, scope.userId, scope.listId, scope.keyId]);
}

export async function unwrapListKey(envelope: KeyEnvelope, accountKey: CryptoKey, scope: ListKeyScope): Promise<CryptoKey> {
  const raw = await unwrapKeyBytes(envelope, accountKey, listKeyAdditionalData(scope));
  try { return await importContentKey(raw); } finally { raw.fill(0); }
}

/** Caller owns raw32 and should clear it after all required envelopes are created. */
export async function wrapListKey(raw32: Uint8Array, accountKey: CryptoKey, scope: ListKeyScope): Promise<KeyEnvelope> {
  if (!(raw32 instanceof Uint8Array) || raw32.byteLength !== 32) {
    throw new ContentCryptoError('invalid-key', 'Invalid list key material.');
  }
  return await wrapKeyBytes(accountKey, raw32, listKeyAdditionalData(scope));
}

/** Keep the raw material only long enough to wrap it, then raw.fill(0). */
export async function generateListKey(): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const raw = portableCrypto().getRandomValues(new Uint8Array(32));
  try { return { raw, key: await importContentKey(raw) }; } catch (error) { raw.fill(0); throw error; }
}
