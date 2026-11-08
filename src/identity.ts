import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configurationDirectory, validateBaseUrl } from './configuration.js';
import { canonicalPublicKey, decodeBase64Url, encodeBase64Url, installationFingerprint, type P256Jwk } from './crypto/p256.js';
import { portableCrypto } from './crypto/runtime.js';

export type { P256Jwk } from './crypto/p256.js';

export interface InstallationIdentity {
  installationId: string;
  publicKey: P256Jwk;
  privateKey: CryptoKey;
}

export class IdentityStorageError extends Error {
  readonly code = 'identity-storage';
  constructor() {
    // Never propagate filesystem paths, URLs, JWKs, or provider error details.
    super('The installation identity could not be securely loaded or saved. Check the local identity configuration.');
    this.name = 'IdentityStorageError';
  }
}

interface IdentityLocation {
  baseUrl: string;
  apiKeyHash: string;
  directory: string;
  file: string;
}

interface StoredIdentity {
  version: 1;
  installationId: string;
  publicKey: P256Jwk;
  salt: string;
  iv: string;
  ciphertext: string;
}

const MAX_FILE_BYTES = 8192;
const MAX_PKCS8_BYTES = 1024;

function location(baseUrl: string, apiKey: string): IdentityLocation {
  if (typeof baseUrl !== 'string' || baseUrl.length > 2048
    || typeof apiKey !== 'string' || !apiKey || Buffer.byteLength(apiKey, 'utf8') > 8192
    || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new IdentityStorageError();
  const normalizedBase = validateBaseUrl(baseUrl);
  const apiKeyHash = createHash('sha256').update(apiKey, 'utf8').digest('hex');
  const scopeHash = createHash('sha256').update(JSON.stringify([normalizedBase, apiKeyHash]), 'utf8').digest('hex');
  const directory = join(resolve(configurationDirectory()), 'identities');
  return { baseUrl: normalizedBase, apiKeyHash, directory, file: join(directory, `${scopeHash}.json`) };
}

function additionalData(scope: IdentityLocation, installationId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([
    'mylister-skill-identity-v1', scope.baseUrl, scope.apiKeyHash, installationId,
  ]));
}

async function storageKey(scope: IdentityLocation, apiKey: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const runtime = portableCrypto();
  const input = new TextEncoder().encode(apiKey);
  try {
    const material = await runtime.subtle.importKey('raw', input, 'HKDF', false, ['deriveKey']);
    return await runtime.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt,
      info: new TextEncoder().encode(JSON.stringify(['mylister-skill-identity-key-v1', scope.baseUrl])),
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { input.fill(0); }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new IdentityStorageError();
  await chmod(directory, 0o700);
}

async function readStored(scope: IdentityLocation, apiKey: string): Promise<InstallationIdentity | undefined> {
  let handle;
  try {
    const directoryStatus = await lstat(scope.directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) throw new IdentityStorageError();
    const status = await lstat(scope.file);
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_FILE_BYTES || status.size < 1) throw new IdentityStorageError();
    handle = await open(scope.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > MAX_FILE_BYTES || status.size < 1) throw new IdentityStorageError();
    await chmod(scope.directory, 0o700);
    await handle.chmod(0o600);
    // Read a fixed bound, even if another local process grows the file after stat.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) throw new IdentityStorageError();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'ciphertext,installationId,iv,publicKey,salt,version') throw new IdentityStorageError();
    const stored = value as StoredIdentity;
    if (stored.version !== 1 || typeof stored.installationId !== 'string' || !/^[0-9a-f]{64}$/.test(stored.installationId)) throw new IdentityStorageError();
    const publicKey = canonicalPublicKey(stored.publicKey);
    if (await installationFingerprint(publicKey) !== stored.installationId) throw new IdentityStorageError();
    const salt = decodeBase64Url(stored.salt, 32);
    const iv = decodeBase64Url(stored.iv, 12);
    const ciphertext = decodeBase64Url(stored.ciphertext, 17, MAX_PKCS8_BYTES + 16);
    const wrappingKey = await storageKey(scope, apiKey, salt);
    const pkcs8 = new Uint8Array(await portableCrypto().subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(scope, stored.installationId), tagLength: 128 }, wrappingKey, ciphertext));
    try {
      // Check the encrypted private key really belongs to the public fingerprint.
      const publicJwk = createPublicKey(createPrivateKey({ key: Buffer.from(pkcs8.buffer, pkcs8.byteOffset, pkcs8.byteLength), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
      if (JSON.stringify(canonicalPublicKey(publicJwk)) !== JSON.stringify(publicKey)) throw new IdentityStorageError();
      const privateKey = await portableCrypto().subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      return { installationId: stored.installationId, publicKey, privateKey };
    } finally { pkcs8.fill(0); }
  } finally { await handle.close(); }
}

/** A missing installation is distinct from an invalid/corrupt installation. */
export async function loadIdentity(baseUrl: string, apiKey: string): Promise<InstallationIdentity | undefined> {
  try { return await readStored(location(baseUrl, apiKey), apiKey); } catch { throw new IdentityStorageError(); }
}

/** Publish a complete encrypted file with an atomic, no-replace hard link. */
export async function loadOrCreateIdentity(baseUrl: string, apiKey: string): Promise<InstallationIdentity> {
  let temporary: string | undefined;
  let pkcs8: Uint8Array<ArrayBuffer> | undefined;
  try {
    const scope = location(baseUrl, apiKey);
    const existing = await readStored(scope, apiKey);
    if (existing) return existing;
    await privateDirectory(scope.directory);
    const runtime = portableCrypto();
    const pair = await runtime.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const exported = await runtime.subtle.exportKey('jwk', pair.publicKey);
    const publicKey = canonicalPublicKey({ crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y });
    const installationId = await installationFingerprint(publicKey);
    pkcs8 = new Uint8Array(await runtime.subtle.exportKey('pkcs8', pair.privateKey));
    if (pkcs8.length > MAX_PKCS8_BYTES) throw new IdentityStorageError();
    const salt = runtime.getRandomValues(new Uint8Array(32));
    const iv = runtime.getRandomValues(new Uint8Array(12));
    const wrappingKey = await storageKey(scope, apiKey, salt);
    const ciphertext = new Uint8Array(await runtime.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(scope, installationId), tagLength: 128 }, wrappingKey, pkcs8));
    const stored: StoredIdentity = { version: 1, installationId, publicKey, salt: encodeBase64Url(salt), iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) };
    pkcs8.fill(0);
    temporary = join(scope.directory, `.identity-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(stored) + '\n', 'utf8');
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, scope.file); } catch (error) {
      // A concurrent winner owns the identity. Never overwrite or rotate it.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await unlink(temporary);
    temporary = undefined;
    if (process.platform !== 'win32') {
      const directory = await open(scope.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    const installed = await readStored(scope, apiKey);
    if (!installed) throw new IdentityStorageError();
    return installed;
  } catch { throw new IdentityStorageError(); } finally {
    pkcs8?.fill(0);
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}
