import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import {
  accountKeyAdditionalData, ContentCryptoError, contentAdditionalData, createCollaboratorKeyTransfer, generateListKey, importContentKey,
  keyEnvelopeAdditionalData, mediaAdditionalData, openContent, openContentMedia, sealContent, sealContentMedia,
  unwrapAccountKey, unwrapListKey, wrapListKey,
  type AccountKeyEnvelope, type CollaboratorTransferInput, type ContentEnvelope, type ContentMediaScope, type ContentScope, type KeyEnvelope,
} from './encryption.js';
import type { InstallationIdentity, P256Jwk } from './identity.js';
import { portableCrypto } from './crypto/runtime.js';

const publicKey: P256Jwk = {
  crv: 'P-256', kty: 'EC',
  x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
  y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
};
const installationId = 'c71d01700fb0328870f1ab580c939eea9786328764946db04470655c732f9743';
const accountScope = { environment: 'staging', userId: 'user-a', accountKeyId: 'account-key-v1' as const };
// Static independent OpenSSL vector: recipient d=1, ephemeral d=2, root=00..1f.
const accountEnvelope: AccountKeyEnvelope = {
  ephemeralPublicKey: {
    crv: 'P-256', kty: 'EC',
    x: 'fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg',
    y: 'B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E',
  },
  salt: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
  iv: 'BAQEBAQEBAQEBAQE',
  ciphertext: '0zewGeOgjIwIu_Y9Q9PHFo0Dwrd4PghCEwPY01S-X2cP02OxEisodVvo1lvGf2RF',
};
const listScope = {
  accountId: 'account-a', userId: 'user-a', listId: '507f1f77bcf86cd799439011', keyId: '507f1f77bcf86cd799439012',
};
const listEnvelope: KeyEnvelope = {
  version: 1, algorithm: 'AES-256-GCM',
  aad: 'WyJteWxpc3Rlci1saXN0LWtleS13cmFwLXYxIiwxLCJhY2NvdW50LWEiLCJ1c2VyLWEiLCI1MDdmMWY3N2JjZjg2Y2Q3OTk0MzkwMTEiLCI1MDdmMWY3N2JjZjg2Y2Q3OTk0MzkwMTIiXQ',
  iv: 'BQUFBQUFBQUFBQUF',
  ciphertext: 'RT_ReKk0k-M2hwLpABoP3Fx-ndbt05yCOyjbKtc2GVQgY6U3vrgSong7ieGyqcUS',
};
const contentScope: ContentScope = {
  ...listScope, environment: 'staging', collection: 'items', recordId: '507f191e810c19729de860ea',
  path: ['metadata', 'transcription'], schemaVersion: 2,
};
const generation = '0123456789abcdef0123456789abcdef';
const mediaScope: ContentMediaScope = {
  ownerAccountId: 'account-a', ownerUserId: 'user-a', environment: 'staging',
  listId: listScope.listId, keyId: listScope.keyId, target: 'item_attachment', stableId: 'attachment-a', itemId: 'item-a',
};
const cryptoError = (error: unknown): boolean => error instanceof ContentCryptoError;

async function vectorIdentity(d = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE'): Promise<InstallationIdentity> {
  return {
    installationId, publicKey,
    privateKey: await portableCrypto().subtle.importKey('jwk', { ...publicKey, d }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
  };
}

function decryptGcm(raw: Uint8Array, iv: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Buffer {
  const cipher = createDecipheriv('aes-256-gcm', raw, iv);
  cipher.setAAD(aad);
  cipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
}

test('account grant opens the fixed P-256/HKDF/GCM wire vector as a nonextractable root', async () => {
  const identity = await vectorIdentity();
  const accountKey = await unwrapAccountKey(accountEnvelope, identity, accountScope);
  assert.equal(accountKey.extractable, false);
  await assert.rejects(portableCrypto().subtle.exportKey('raw', accountKey));
  assert.equal(new TextDecoder().decode(accountKeyAdditionalData(accountScope, installationId)),
    JSON.stringify(['mylister-api-key-account-wrap-v1', 'staging', 'user-a', installationId, 'account-key-v1']));
  const listKey = await unwrapListKey(listEnvelope, accountKey, listScope);
  assert.equal(listKey.extractable, false);
  const sealed = await sealContent('verified root and list key', listKey, contentScope);
  assert.ok(sealed);
  assert.equal(await openContent(sealed, await importContentKey(new Uint8Array(32).fill(9)), contentScope), 'verified root and list key');
});

test('account grant rejects changed environment, user, installation, private key, and ciphertext', async () => {
  const identity = await vectorIdentity();
  await assert.rejects(unwrapAccountKey(accountEnvelope, identity, { ...accountScope, environment: 'https://other-host.example' }), cryptoError);
  await assert.rejects(unwrapAccountKey(accountEnvelope, identity, { ...accountScope, userId: 'user-b' }), cryptoError);
  await assert.rejects(unwrapAccountKey(accountEnvelope, { ...identity, installationId: '0'.repeat(64) }, accountScope), cryptoError);
  const otherPair = await portableCrypto().subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  await assert.rejects(unwrapAccountKey(accountEnvelope, { ...identity, privateKey: otherPair.privateKey }, accountScope), cryptoError);
  const tampered = Buffer.from(accountEnvelope.ciphertext, 'base64url');
  tampered[0] ^= 1;
  await assert.rejects(unwrapAccountKey({ ...accountEnvelope, ciphertext: tampered.toString('base64url') }, identity, accountScope), cryptoError);
});

test('account grant enforces exact key type, fields, canonical base64url, and bounded byte sizes', async () => {
  const identity = await vectorIdentity();
  const malformed: unknown[] = [null, [], {}, { ...accountEnvelope, extra: true },
    { ...accountEnvelope, salt: 'A'.repeat(100000) }, { ...accountEnvelope, salt: 'A'.repeat(42) },
    { ...accountEnvelope, iv: `${accountEnvelope.iv}=` }, { ...accountEnvelope, ciphertext: 'AQ' },
    { ...accountEnvelope, ciphertext: Buffer.alloc(49).toString('base64url') },
    { ...accountEnvelope, ephemeralPublicKey: { ...accountEnvelope.ephemeralPublicKey, d: 'private' } },
    { ...accountEnvelope, ephemeralPublicKey: { ...accountEnvelope.ephemeralPublicKey, crv: 'P-384' } },
    { ...accountEnvelope, ephemeralPublicKey: { ...accountEnvelope.ephemeralPublicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) } },
  ];
  for (const envelope of malformed) await assert.rejects(unwrapAccountKey(envelope as AccountKeyEnvelope, identity, accountScope), cryptoError);
  await assert.rejects(unwrapAccountKey(accountEnvelope, identity, { ...accountScope, accountKeyId: 'other' } as never), cryptoError);
});

test('list wrapping uses exact UI flat versioned AAD and opens the independent fixture', async () => {
  const accountRaw = Uint8Array.from({ length: 32 }, (_, i) => i);
  const accountKey = await importContentKey(accountRaw);
  const expectedAad = '["mylister-list-key-wrap-v1",1,"account-a","user-a","507f1f77bcf86cd799439011","507f1f77bcf86cd799439012"]';
  assert.equal(Buffer.from(listEnvelope.aad, 'base64url').toString(), expectedAad);
  assert.equal(new TextDecoder().decode(keyEnvelopeAdditionalData('mylister-list-key-wrap-v1', Object.values(listScope))), expectedAad);
  const generated = await generateListKey();
  assert.equal(generated.raw.length, 32);
  assert.equal(generated.key.extractable, false);
  const wrapped = await wrapListKey(generated.raw, accountKey, listScope);
  assert.equal(Buffer.from(wrapped.aad, 'base64url').toString(), expectedAad);
  assert.deepEqual(decryptGcm(accountRaw, Buffer.from(wrapped.iv, 'base64url'), Buffer.from(expectedAad), Buffer.from(wrapped.ciphertext, 'base64url')), Buffer.from(generated.raw));
  const key = await unwrapListKey(wrapped, accountKey, listScope);
  const sealed = await sealContent('list wrap', generated.key, contentScope);
  assert.equal(await openContent(sealed!, key, contentScope), 'list wrap');
  for (const field of ['accountId', 'userId', 'listId', 'keyId'] as const) {
    await assert.rejects(unwrapListKey(wrapped, accountKey, { ...listScope, [field]: 'other' }), cryptoError);
  }
  await assert.rejects(unwrapListKey(wrapped, await importContentKey(new Uint8Array(32)), listScope), cryptoError);
  await assert.rejects(wrapListKey(new Uint8Array(31), accountKey, listScope), cryptoError);
  generated.raw.fill(0);
});

test('opens exact UI/server schema-v2/v3 text vectors including BSON transport chunks', async () => {
  // Copied from mylister-api-key-ui/tests/content-crypto.test.cjs; zlib level 1.
  const key = await importContentKey(new Uint8Array(32));
  const v2: ContentEnvelope = { v: 1, generation, bytes: 8, chunks: ['AQEBAQEBAQEBAQEBDUEwIrdAsapqQ+CGt5F+2mi5ajk8Y3VXGsRqQKenJhA='] };
  const v3: ContentEnvelope = { ...v2, chunks: ['AQEBAQEBAQEBAQEBDUEwIrdAsapqQ+CGt5F+2j+Pdx/XnrK7iScQ3TmJS8I='] };
  assert.equal(await openContent(v2, key, contentScope), 'Hello UI');
  assert.equal(await openContent(v3, key, { ...contentScope, schemaVersion: 3 }), 'Hello UI');
  const bson = { ...v2, chunks: [{ $binary: { base64: v2.chunks[0] } }] } as unknown as ContentEnvelope;
  assert.equal(await openContent(bson, key, contentScope), 'Hello UI');
  await assert.rejects(openContent(v2, key, { ...contentScope, schemaVersion: 3 }), cryptoError);
});

test('text seal matches independent zlib/AES wire bytes and ASCII-escaped international AAD', async () => {
  const raw = new Uint8Array(32);
  const key = await importContentKey(raw);
  const scope = { ...contentScope, environment: 'staging-ä', path: ['text', '😀'], schemaVersion: 3 as const };
  const value = 'Grüße 😀';
  const nonce = new Uint8Array(12).fill(7);
  const aadText = JSON.stringify(['mylister-core-content', 3, scope.environment, scope.listId, scope.collection,
    scope.recordId, scope.keyId, scope.path, generation, Buffer.byteLength(value), 1, 0])
    .replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const aad = Buffer.from(aadText);
  assert.deepEqual(Buffer.from(contentAdditionalData(scope, generation, Buffer.byteLength(value), 1, 0)), aad);
  const cipher = createCipheriv('aes-256-gcm', raw, nonce);
  cipher.setAAD(aad);
  const expected = Buffer.concat([nonce, cipher.update(deflateSync(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  const sealed = await sealContent(value, key, scope, { generation, nonce });
  assert.equal(sealed!.chunks[0], expected);
  assert.equal(await openContent(sealed!, key, scope), value);
  assert.equal(await sealContent(null, key, scope), null);
});

test('text chunking authenticates count, order, key, path, length, and compressed output limits', async () => {
  const key = await importContentKey(new Uint8Array(32));
  const value = randomBytes(700000).toString('base64');
  const sealed = (await sealContent(value, key, contentScope))!;
  assert.ok(sealed.chunks.length > 1);
  assert.equal(await openContent(sealed, key, contentScope), value);
  await assert.rejects(openContent({ ...sealed, chunks: [...sealed.chunks].reverse() }, key, contentScope), cryptoError);
  await assert.rejects(openContent({ ...sealed, bytes: sealed.bytes - 1 }, key, contentScope), cryptoError);
  await assert.rejects(openContent(sealed, key, { ...contentScope, path: ['other'] }), cryptoError);
  await assert.rejects(openContent(sealed, await importContentKey(new Uint8Array(32).fill(1)), contentScope), cryptoError);
  for (const envelope of [{ ...sealed, v: 2 }, { ...sealed, chunks: [] }, { ...sealed, chunks: ['!'] }, { ...sealed, bytes: 16777217 }]) {
    await assert.rejects(openContent(envelope as ContentEnvelope, key, contentScope), cryptoError);
  }
  // An authenticated compressed payload must still obey the output bound.
  const nonce = Buffer.alloc(12, 2);
  const aad = contentAdditionalData(contentScope, generation, 0, 1, 0);
  const cipher = createCipheriv('aes-256-gcm', new Uint8Array(32), nonce);
  cipher.setAAD(aad);
  const oversized = Buffer.concat([
    nonce, cipher.update(deflateSync(Buffer.alloc(16 * 1024 * 1024 + 2))), cipher.final(), cipher.getAuthTag(),
  ]);
  await assert.rejects(openContent({ v: 1, generation, bytes: 0, chunks: [oversized.toString('base64url')] }, key, contentScope), cryptoError);
});

test('binary media interoperates with exact UI framing/AAD and independent AES decryption', async () => {
  const raw = new Uint8Array(32).fill(8);
  const key = await importContentKey(raw);
  const input = { bytes: new TextEncoder().encode('private file bytes'), name: 'private.txt', contentType: 'text/plain' };
  const aadString = '["mylister-content-media-v1",1,"account-a","user-a","staging","507f1f77bcf86cd799439011","507f1f77bcf86cd799439012","item_attachment","attachment-a","item-a",null,null]';
  assert.equal(Buffer.from(mediaAdditionalData(mediaScope)).toString(), aadString);
  const blob = await sealContentMedia(key, mediaScope, input);
  assert.deepEqual([...blob.subarray(0, 4)], [0x4d, 0x4c, 0x4d, 1]);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  assert.equal(view.getUint32(4), 1);
  assert.equal(view.getUint32(8), input.bytes.length);
  const aad = Buffer.from(JSON.stringify([aadString, 0, 1, input.bytes.length]));
  const plaintext = decryptGcm(raw, blob.subarray(12, 24), aad, blob.subarray(28));
  const headerLength = plaintext.readUInt32BE(0);
  assert.deepEqual(JSON.parse(plaintext.subarray(4, 4 + headerLength).toString()), { v: 1, name: input.name, contentType: input.contentType, size: input.bytes.length });
  assert.deepEqual(plaintext.subarray(4 + headerLength), Buffer.from(input.bytes));
  assert.deepEqual((await openContentMedia(key, mediaScope, blob)).bytes, input.bytes);
  // Reverse direction: a fixed, independently framed UI-compatible binary blob.
  const nonce = Buffer.alloc(12, 6);
  const cipher = createCipheriv('aes-256-gcm', raw, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const fixture = Buffer.alloc(28 + ciphertext.length);
  fixture.set([0x4d, 0x4c, 0x4d, 1]);
  fixture.writeUInt32BE(1, 4); fixture.writeUInt32BE(input.bytes.length, 8);
  fixture.set(nonce, 12); fixture.writeUInt32BE(ciphertext.length, 24); fixture.set(ciphertext, 28);
  assert.equal((await openContentMedia(key, mediaScope, fixture)).name, input.name);
  await assert.rejects(openContentMedia(key, { ...mediaScope, environment: 'other-host' }, blob), cryptoError);
  await assert.rejects(openContentMedia(key, { ...mediaScope, itemId: 'item-b' }, blob), cryptoError);
  const tampered = blob.slice(); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(openContentMedia(key, mediaScope, tampered), cryptoError);
  await assert.rejects(openContentMedia(key, mediaScope, blob.subarray(0, -1)), cryptoError);
});

test('media spans chunks, rejects wrong keys and unsafe declared sizes', async () => {
  const key = await importContentKey(new Uint8Array(32));
  const input = { bytes: new Uint8Array(1048583).fill(19), name: 'large.bin', contentType: 'application/octet-stream' };
  const blob = await sealContentMedia(key, mediaScope, input);
  assert.equal(new DataView(blob.buffer).getUint32(4), 2);
  assert.deepEqual((await openContentMedia(key, mediaScope, blob)).bytes, input.bytes);
  await assert.rejects(openContentMedia(await importContentKey(new Uint8Array(32).fill(1)), mediaScope, blob), cryptoError);
  const invalid = blob.slice(); new DataView(invalid.buffer).setUint32(8, 0xffffffff);
  await assert.rejects(openContentMedia(key, mediaScope, invalid), cryptoError);
});

test('portable codec supports Node WebCrypto when the host omits global crypto', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const generated = await generateListKey();
    const sealed = await sealContent('Node fallback', generated.key, contentScope);
    assert.equal(await openContent(sealed!, generated.key, contentScope), 'Node fallback');
    generated.raw.fill(0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('collaborator transfer matches the UI request, 16-byte HKDF salt, AAD, and acceptance proof', async () => {
  const input: CollaboratorTransferInput = {
    listId: listScope.listId, keyId: listScope.keyId, ownerUserId: 'owner-a', recipientUserId: 'recipient-a',
    membershipGrantId: Buffer.alloc(32, 1).toString('base64url'), recipientExchangeKeyId: Buffer.alloc(32, 2).toString('base64url'),
    recipientExchangeKeyVersion: 1, recipientExchangeKeyFingerprint: installationId, recipientPublicKey: publicKey,
    ttlSeconds: 90,
  };
  const raw = new Uint8Array(32).fill(9);
  const request = await createCollaboratorKeyTransfer(raw, input);
  assert.deepEqual(raw, new Uint8Array(32).fill(9)); // The caller owns this buffer.
  assert.equal(request.ttlSeconds, 90);
  assert.equal(request.expectedVersion, 0);
  assert.equal(request.idempotencyKey, `collaborator-transfer-${request.transferId}`);
  assert.equal(Buffer.from(request.transferId, 'base64url').length, 32);
  assert.equal('recipientPublicKey' in request, false);
  assert.equal('acceptanceSecret' in request, false);
  assert.deepEqual(Object.keys(request.ephemeralPublicKey), ['crv', 'kty', 'x', 'y']);
  const expectedAad = Buffer.from(JSON.stringify([
    'mylister-collaborator-list-dek-transfer-v1', 1, request.transferId,
    input.listId, input.keyId, input.ownerUserId, input.recipientUserId, input.membershipGrantId,
    input.recipientExchangeKeyId, input.recipientExchangeKeyVersion, input.recipientExchangeKeyFingerprint,
  ]));
  assert.deepEqual(Buffer.from(request.transfer.aad, 'base64url'), expectedAad);
  assert.equal(request.transfer.version, 1);
  assert.equal(request.transfer.algorithm, 'AES-256-GCM');
  const salt = Buffer.from(request.transfer.salt, 'base64url');
  assert.equal(salt.length, 16);
  const iv = Buffer.from(request.transfer.iv, 'base64url');
  assert.equal(iv.length, 12);
  const ciphertext = Buffer.from(request.transfer.ciphertext, 'base64url');
  assert.equal(ciphertext.length, 80);
  // Independent OpenSSL ECDH+HKDF+GCM decoder of the exact browser wire form.
  const recipient = createECDH('prime256v1');
  const recipientD = Buffer.alloc(32); recipientD[31] = 1;
  recipient.setPrivateKey(recipientD);
  const ephemeral = Buffer.concat([Buffer.from([4]), Buffer.from(request.ephemeralPublicKey.x, 'base64url'), Buffer.from(request.ephemeralPublicKey.y, 'base64url')]);
  const shared = recipient.computeSecret(ephemeral);
  const wrapping = new Uint8Array(hkdfSync('sha256', shared, salt, expectedAad, 32));
  const payload = decryptGcm(wrapping, iv, expectedAad, ciphertext);
  assert.equal(payload.length, 64);
  assert.deepEqual(payload.subarray(0, 32), Buffer.from(raw));
  assert.equal(createHash('sha256').update(payload.subarray(32)).digest('hex'), request.acceptanceSecretHash);
  const wrongAad = Buffer.from(expectedAad); wrongAad[wrongAad.length - 3] ^= 1;
  assert.throws(() => decryptGcm(wrapping, iv, wrongAad, ciphertext));
  const next = await createCollaboratorKeyTransfer(raw, { ...input, ttlSeconds: undefined });
  assert.equal(next.ttlSeconds, 7 * 24 * 60 * 60);
  assert.notEqual(next.transferId, request.transferId);
  assert.notEqual(next.transfer.ciphertext, request.transfer.ciphertext);
  payload.fill(0); wrapping.fill(0); shared.fill(0); raw.fill(0); recipientD.fill(0);
});

test('collaborator transfer rejects invalid keys, scope, key version, and lifetime before transport', async () => {
  const input: CollaboratorTransferInput = {
    listId: 'list-a', keyId: 'key-a', ownerUserId: 'owner-a', recipientUserId: 'recipient-a',
    membershipGrantId: 'grant-a', recipientExchangeKeyId: 'exchange-a', recipientExchangeKeyVersion: 1,
    recipientExchangeKeyFingerprint: installationId, recipientPublicKey: publicKey,
  };
  const raw = new Uint8Array(32);
  await assert.rejects(createCollaboratorKeyTransfer(new Uint8Array(31), input), cryptoError);
  for (const ttlSeconds of [0, 29, 604801, NaN, 30.5]) {
    await assert.rejects(createCollaboratorKeyTransfer(raw, { ...input, ttlSeconds }), cryptoError);
  }
  for (const recipientExchangeKeyVersion of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(createCollaboratorKeyTransfer(raw, { ...input, recipientExchangeKeyVersion }), cryptoError);
  }
  await assert.rejects(createCollaboratorKeyTransfer(raw, { ...input, ownerUserId: 'A'.repeat(100000) }), cryptoError);
  await assert.rejects(createCollaboratorKeyTransfer(raw, { ...input, recipientExchangeKeyFingerprint: 'malformed' }), cryptoError);
  await assert.rejects(createCollaboratorKeyTransfer(raw, { ...input, recipientPublicKey: { ...publicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) } }), cryptoError);
});
