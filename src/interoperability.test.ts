import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import {
  ContentCryptoError, importContentKey, openContent, openContentMedia,
  sealContent, sealContentMedia, unwrapAccountKey, unwrapListKey, wrapListKey,
  type AccountKeyEnvelope, type AccountKeyScope, type ContentEnvelope,
  type ContentMediaScope, type ContentScope, type KeyEnvelope, type ListKeyScope,
} from './encryption.js';
import type { InstallationIdentity, P256Jwk } from './identity.js';
import { portableCrypto } from './crypto/runtime.js';

interface FieldVector {
  name: string;
  scope: ContentScope;
  generation: string;
  nonces: string[];
  text?: string;
  syntheticByteLength?: number;
  envelope?: ContentEnvelope;
  envelopeSha256: string;
  chunks: number;
  bytes: number;
}

interface MediaVector {
  scope: ContentMediaScope;
  byteLength: number;
  name: string;
  contentType: string;
  nonces: string[];
  blobSha256: string;
  blob?: string;
  framedByteLength: number;
}

// Frozen outputs of the actual browser helpers, not outputs of the skill codec.
// No UI checkout, network, credentials, or persistent installation is required.
const vectors = JSON.parse(readFileSync(new URL('../test-fixtures/browser-crypto-v1.json', import.meta.url), 'utf8')) as {
  provenance: { browserSchemaVersion: number; syntheticOnly: boolean };
  identity: { publicKey: P256Jwk; privateScalar: string; installationId: string };
  accountScope: AccountKeyScope;
  accountRoot: string;
  approval: { accountKeyId: string; installationId: string; accountKeyEnvelope: AccountKeyEnvelope };
  listScope: ListKeyScope;
  listKey: string;
  listEnvelope: KeyEnvelope;
  listNonces: string[];
  fields: FieldVector[];
  media: MediaVector[];
};

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const cryptoFailure = (error: unknown): boolean => error instanceof ContentCryptoError;

// Reproducible input only; this is not a key/nonce generator or a codec.
function syntheticBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[i] = state & 255;
  }
  return bytes;
}

async function withBrowserNonces<T>(t: TestContext, nonces: string[], work: () => Promise<T>): Promise<T> {
  let index = 0;
  const random = t.mock.method(portableCrypto(), 'getRandomValues', (value: Uint8Array) => {
    assert.ok(value instanceof Uint8Array);
    assert.equal(value.byteLength, 12, 'Only synthetic AES-GCM nonces may be overridden');
    assert.ok(index < nonces.length, 'Unexpected additional nonce request');
    const nonce = Buffer.from(nonces[index++], 'base64url');
    assert.equal(nonce.byteLength, 12);
    value.set(nonce);
    return value;
  });
  try {
    const result = await work();
    assert.equal(index, nonces.length, 'Use the exact browser nonce sequence');
    return result;
  } finally { random.mock.restore(); }
}

async function browserIdentity(): Promise<InstallationIdentity> {
  const { publicKey, installationId, privateScalar } = vectors.identity;
  return {
    publicKey, installationId,
    privateKey: await portableCrypto().subtle.importKey(
      'jwk', { ...publicKey, d: privateScalar }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
    ),
  };
}

test('actual UI account-root approval opens in Node and reproduces the browser list envelope', async t => {
  assert.equal(vectors.provenance.syntheticOnly, true);
  assert.equal(vectors.approval.installationId, vectors.identity.installationId);
  assert.equal(vectors.approval.accountKeyId, 'account-key-v1');
  const root = await unwrapAccountKey(vectors.approval.accountKeyEnvelope, await browserIdentity(), vectors.accountScope);
  assert.equal(root.extractable, false);
  await assert.rejects(portableCrypto().subtle.exportKey('raw', root));
  // Exact UI ciphertext proves the root bytes without exporting the unwrapped root.
  const wrapped = await withBrowserNonces(t, vectors.listNonces, () =>
    wrapListKey(Buffer.from(vectors.listKey, 'base64url'), root, vectors.listScope));
  assert.deepEqual(wrapped, vectors.listEnvelope);
});

test('UI account approval fails closed for changed environment, user, installation, or ciphertext', async () => {
  const identity = await browserIdentity();
  const envelope = vectors.approval.accountKeyEnvelope;
  for (const field of ['environment', 'userId'] as const) {
    await assert.rejects(unwrapAccountKey(envelope, identity, { ...vectors.accountScope, [field]: 'different' }), cryptoFailure);
  }
  const pair = await portableCrypto().subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const jwk = await portableCrypto().subtle.exportKey('jwk', pair.publicKey);
  const publicKey: P256Jwk = { crv: 'P-256', kty: 'EC', x: jwk.x!, y: jwk.y! };
  const other = { publicKey, privateKey: pair.privateKey, installationId: sha256(JSON.stringify(publicKey)) };
  await assert.rejects(unwrapAccountKey(envelope, other, vectors.accountScope), cryptoFailure);
  const changed = Buffer.from(envelope.ciphertext, 'base64url');
  changed[changed.length - 1] ^= 1;
  await assert.rejects(unwrapAccountKey({ ...envelope, ciphertext: changed.toString('base64url') }, identity, vectors.accountScope), cryptoFailure);
});

test('browser list envelope opens in Node with the exact owner/list/key binding', async t => {
  const root = await importContentKey(Buffer.from(vectors.accountRoot, 'base64url'));
  const key = await unwrapListKey(vectors.listEnvelope, root, vectors.listScope);
  assert.equal(key.extractable, false);
  const field = vectors.fields.find(vector => vector.name === 'schema-v3')!;
  const sealed = await withBrowserNonces(t, field.nonces, () => sealContent(field.text!, key, field.scope, { generation: field.generation }));
  assert.deepEqual(sealed, field.envelope);
  for (const name of ['accountId', 'userId', 'listId', 'keyId'] as const) {
    await assert.rejects(unwrapListKey(vectors.listEnvelope, root, { ...vectors.listScope, [name]: 'different' }), cryptoFailure);
  }
});

for (const field of vectors.fields) {
  test(`Node field output equals the actual browser vector: ${field.name}`, async t => {
    const text = field.text ?? Buffer.from(syntheticBytes(field.syntheticByteLength!)).toString('base64');
    const key = await importContentKey(Buffer.from(vectors.listKey, 'base64url'));
    const sealed = await withBrowserNonces(t, field.nonces, () => sealContent(text, key, field.scope, { generation: field.generation }));
    assert.ok(sealed);
    assert.equal(sealed.bytes, field.bytes);
    assert.equal(sealed.chunks.length, field.chunks);
    assert.equal(sha256(JSON.stringify(sealed)), field.envelopeSha256, 'Browser compressed bytes, framing, AAD and GCM tag must all match');
    if (field.envelope) {
      assert.deepEqual(sealed, field.envelope);
      assert.equal(await openContent(field.envelope, key, field.scope), text);
    } else {
      assert.ok(sealed.chunks.length > 1, 'Exercise the compressed-field chunk boundary');
      await assert.rejects(openContent({ ...sealed, chunks: [...sealed.chunks].reverse() }, key, field.scope), cryptoFailure);
    }
    if (field.scope.schemaVersion === undefined) assert.equal(vectors.provenance.browserSchemaVersion, 3);
  });
}

test('browser field fixture rejects another path, schema, record, environment, length, or tag', async () => {
  const field = vectors.fields.find(vector => vector.name === 'schema-v3')!;
  const key = await importContentKey(Buffer.from(vectors.listKey, 'base64url'));
  for (const scope of [
    { ...field.scope, path: ['metadata', 'different'] },
    { ...field.scope, schemaVersion: 2 as const },
    { ...field.scope, recordId: '507f191e810c19729de860eb' },
    { ...field.scope, environment: 'different' },
  ]) await assert.rejects(openContent(field.envelope!, key, scope), cryptoFailure);
  await assert.rejects(openContent({ ...field.envelope!, bytes: field.bytes + 1 }, key, field.scope), cryptoFailure);
  const changed = Buffer.from(field.envelope!.chunks[0], 'base64url');
  changed[changed.length - 1] ^= 1;
  await assert.rejects(openContent({ ...field.envelope!, chunks: [changed.toString('base64url')] }, key, field.scope), cryptoFailure);
});

for (const media of vectors.media) {
  test(`Node media output equals the actual browser vector: ${media.scope.target}`, async t => {
    const key = await importContentKey(Buffer.from(vectors.listKey, 'base64url'));
    const input = syntheticBytes(media.byteLength);
    // A view with nonzero offset must encode the same bytes as the browser fixture.
    const backing = new Uint8Array(input.length + 12).fill(0xff);
    backing.set(input, 5);
    const sealed = await withBrowserNonces(t, media.nonces, () => sealContentMedia(key, media.scope, {
      bytes: backing.subarray(5, 5 + input.length), name: media.name, contentType: media.contentType,
    }));
    assert.equal(sealed.byteLength, media.framedByteLength);
    assert.equal(sha256(sealed), media.blobSha256, 'Browser metadata, parent scope, frame boundaries and GCM tags must all match');
    if (media.blob) assert.equal(Buffer.from(sealed).toString('base64url'), media.blob);
    else assert.ok(media.nonces.length > 1, 'Exercise the binary-media chunk boundary');
    const browserBlob = media.blob ? Buffer.from(media.blob, 'base64url') : sealed;
    const opened = await openContentMedia(key, media.scope, browserBlob);
    assert.deepEqual(opened.bytes, input);
    assert.equal(opened.name, media.name);
    assert.equal(opened.contentType, media.contentType);
    assert.equal(opened.version, 1);
  });
}

test('browser comment-media fixture rejects owner/parent substitution, truncation, and tampering', async () => {
  const media = vectors.media.find(vector => vector.scope.target === 'comment_attachment')!;
  const key = await importContentKey(Buffer.from(vectors.listKey, 'base64url'));
  const blob = Buffer.from(media.blob!, 'base64url');
  for (const field of ['ownerAccountId', 'ownerUserId', 'itemId', 'noteId', 'commentId', 'stableId'] as const) {
    await assert.rejects(openContentMedia(key, { ...media.scope, [field]: 'different' }, blob), cryptoFailure);
  }
  await assert.rejects(openContentMedia(key, media.scope, blob.subarray(0, -1)), cryptoFailure);
  const changed = Buffer.from(blob);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(openContentMedia(key, media.scope, changed), cryptoFailure);
});
