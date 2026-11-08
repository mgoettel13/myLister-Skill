import { ContentCryptoError } from './content.js';
import { portableCrypto } from './runtime.js';

/** Property order is part of the installation fingerprint protocol. */
export interface P256Jwk {
  crv: 'P-256';
  kty: 'EC';
  x: string;
  y: string;
}

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

/** Only canonical, unpadded base64url is accepted for new grant/storage formats. */
export function decodeBase64Url(value: unknown, minimum: number, maximum = minimum): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid encrypted key material.');
  }
  const result = Buffer.from(value, 'base64url');
  if (result.length < minimum || result.length > maximum || result.toString('base64url') !== value) {
    throw new ContentCryptoError('invalid-envelope', 'Invalid encrypted key material.');
  }
  return new Uint8Array(result);
}

export function canonicalPublicKey(value: unknown): P256Jwk {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'crv,kty,x,y') {
    throw new ContentCryptoError('invalid-envelope', 'Invalid installation public key.');
  }
  const key = value as Record<string, unknown>;
  if (key.crv !== 'P-256' || key.kty !== 'EC') {
    throw new ContentCryptoError('invalid-envelope', 'Invalid installation public key.');
  }
  decodeBase64Url(key.x, 32);
  decodeBase64Url(key.y, 32);
  return { crv: 'P-256', kty: 'EC', x: key.x as string, y: key.y as string };
}

export async function installationFingerprint(publicKey: P256Jwk): Promise<string> {
  const canonical = canonicalPublicKey(publicKey);
  const digest = await portableCrypto().subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return Buffer.from(digest).toString('hex');
}

export function scopeText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256
    || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ContentCryptoError('invalid-scope', 'Invalid encrypted key scope.');
  }
}
