/* Optional fixture maintenance only. The test suite never loads a UI checkout. */
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

// Explicit input: no developer-specific or sibling checkout path is assumed.
const uiRoot = process.argv[2] && path.resolve(process.argv[2]);
if (!uiRoot) throw new Error('Usage: node test-fixtures/generate-browser-vectors.cjs <UI checkout>');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = {};
const cache = new Map();
const blocked = () => { throw new Error('Network/passkey operations are forbidden in fixture generation'); };
const context = vm.createContext({
  crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
  Blob, CompressionStream, DecompressionStream, AbortController, atob, btoa,
  window: { isSecureContext: true },
});

function load(relative) {
  const absolute = path.resolve(uiRoot, relative);
  const name = path.relative(uiRoot, absolute).split(path.sep).join('/');
  if (!name.startsWith('src/lib/crypto/') && name !== 'src/lib/auth/privateSession.ts') {
    throw new Error(`Unexpected browser dependency: ${name}`);
  }
  if (cache.has(name)) return cache.get(name).exports;
  const source = fs.readFileSync(absolute, 'utf8');
  sourceSha256[name] = sha256(source);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
  }).outputText;
  const module = { exports: {} };
  cache.set(name, module);
  const localRequire = specifier => {
    // Only these unused service adapters are blocked; all crypto/session code is real UI source.
    if (specifier === '@/lib/api/client') return { apiClient: new Proxy({}, { get: () => blocked }) };
    if (specifier === '@/lib/passkeys') return { withPasskeyPrfCeremony: blocked };
    let dependency;
    if (specifier.startsWith('@/')) dependency = path.join(uiRoot, 'src', specifier.slice(2));
    else if (specifier.startsWith('.')) dependency = path.resolve(path.dirname(absolute), specifier);
    else throw new Error(`Unexpected browser import: ${specifier}`);
    return load(path.relative(uiRoot, dependency + (path.extname(dependency) ? '' : '.ts')));
  };
  vm.runInContext(`(function(require, module, exports) {\n${output}\n})`, context, { filename: name })(localRequire, module, module.exports);
  return module.exports;
}

function syntheticBytes(length) {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[i] = state & 255;
  }
  return bytes;
}

async function withNonces(runtime, work) {
  const original = runtime.getRandomValues;
  const nonces = [];
  runtime.getRandomValues = value => {
    assert.equal(value.byteLength, 12, 'Only AES-GCM nonce generation is deterministic');
    value.fill(0x31 + nonces.length);
    nonces.push(Buffer.from(value).toString('base64url'));
    return value;
  };
  try { return { result: await work(), nonces }; }
  finally { runtime.getRandomValues = original; }
}

async function main() {
  const browser = {
    account: load('src/lib/crypto/apiKeyEnvelope.ts'),
    content: load('src/lib/crypto/content.ts'),
    keys: load('src/lib/crypto/keyEnvelope.ts'),
    media: load('src/lib/crypto/media.ts'),
    session: load('src/lib/crypto/contentSession.ts'),
  };
  const skill = await import(pathToFileURL(path.join(__dirname, '../dist/encryption.js')).href);
  const { portableCrypto } = await import(pathToFileURL(path.join(__dirname, '../dist/crypto/runtime.js')).href);
  // Public P-256 test key d=1, never an installation identity from disk.
  const publicKey = {
    crv: 'P-256', kty: 'EC',
    x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
    y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
  };
  const identity = {
    publicKey, privateScalar: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
    installationId: sha256(JSON.stringify(publicKey)),
  };
  const pending = {
    status: 'pending', enrollmentId: 'synthetic-enrollment', ...identity,
    environment: 'interop-ä.example.invalid', userId: 'synthetic-user',
  };
  delete pending.privateScalar;
  const accountScope = { environment: pending.environment, userId: pending.userId, accountKeyId: 'account-key-v1' };
  const listScope = {
    accountId: 'synthetic-account', userId: pending.userId,
    listId: '507f1f77bcf86cd799439011', keyId: '507f1f77bcf86cd799439012',
  };
  const fieldScope = {
    ...listScope, environment: pending.environment, collection: 'items',
    recordId: '507f191e810c19729de860ea', path: ['metadata', 'caption-😀'],
  };
  const rootRaw = Uint8Array.from({ length: 32 }, (_, i) => i);
  const listRaw = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const approval = await browser.account.wrapApiKeyAccountRoot(rootRaw, pending);
  const nodeIdentity = {
    publicKey, installationId: identity.installationId,
    privateKey: await webcrypto.subtle.importKey('jwk', { ...publicKey, d: identity.privateScalar }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
  };
  const nodeRoot = await skill.unwrapAccountKey(approval.accountKeyEnvelope, nodeIdentity, accountScope);
  const browserRoot = await browser.content.importContentKey(rootRaw);
  const browserList = await browser.content.importContentKey(listRaw);
  const nodeList = await skill.importContentKey(listRaw);
  const listAad = browser.keys.keyEnvelopeAdditionalData('mylister-list-key-wrap-v1', Object.values(listScope));
  const wrapped = await withNonces(webcrypto, () => browser.keys.wrapKeyBytes(browserRoot, listRaw, listAad));
  const nodeWrapped = await withNonces(portableCrypto(), () => skill.wrapListKey(listRaw, nodeRoot, listScope));
  assert.equal(JSON.stringify(nodeWrapped.result), JSON.stringify(wrapped.result));
  const session = new browser.session.MemoryContentSession();
  await session.unlock(listScope, browserRoot);
  await session.installWrappedListKey(listScope.listId, listScope.keyId, nodeWrapped.result);

  const fields = [];
  const generation = '0123456789abcdef0123456789abcdef';
  for (const [name, schemaVersion, text] of [
    ['schema-v2', 2, 'Grüße 😀\nBrowser ↔ Node'],
    ['schema-v3', 3, 'Grüße 😀\nBrowser ↔ Node'],
    ['default-v3', undefined, 'Grüße 😀\nBrowser ↔ Node'],
    ['empty-v3', 3, ''],
    ['chunked-v3', 3, Buffer.from(syntheticBytes(700000)).toString('base64')],
  ]) {
    const scope = { ...fieldScope, ...(schemaVersion === undefined ? {} : { schemaVersion }) };
    const sealed = await withNonces(webcrypto, () => browser.content.sealContent(text, browserList, scope, { generation }));
    const nodeSealed = await withNonces(portableCrypto(), () => skill.sealContent(text, nodeList, scope, { generation }));
    assert.equal(JSON.stringify(nodeSealed.result), JSON.stringify(sealed.result));
    assert.equal(await session.open(nodeSealed.result, scope), text);
    assert.equal(await skill.openContent(sealed.result, nodeList, scope), text);
    fields.push({
      name, scope, generation, nonces: sealed.nonces,
      text: name === 'chunked-v3' ? undefined : text,
      syntheticByteLength: name === 'chunked-v3' ? 700000 : undefined,
      envelope: name === 'chunked-v3' ? undefined : sealed.result,
      envelopeSha256: sha256(JSON.stringify(sealed.result)),
      chunks: sealed.result.chunks.length, bytes: sealed.result.bytes,
    });
  }

  const media = [];
  for (const target of ['list_cover', 'item_image', 'item_voice', 'note_image', 'note_voice', 'item_attachment', 'note_attachment', 'comment_attachment']) {
    const scope = {
      ownerAccountId: listScope.accountId, ownerUserId: listScope.userId,
      environment: pending.environment, listId: listScope.listId, keyId: listScope.keyId,
      target, stableId: `synthetic-${target}`,
      ...(target === 'list_cover' ? {} : { itemId: 'synthetic-item' }),
      ...(target.startsWith('note_') || target === 'comment_attachment' ? { noteId: 'synthetic-note' } : {}),
      ...(target === 'comment_attachment' ? { commentId: 'synthetic-comment' } : {}),
    };
    const byteLength = target === 'item_attachment' ? 1024 * 1024 + 65 : 29;
    const input = { bytes: syntheticBytes(byteLength), name: 'Grüße-😀.bin', contentType: 'application/octet-stream' };
    const sealed = await withNonces(webcrypto, () => browser.media.sealContentMedia(browserList, scope, input));
    const nodeSealed = await withNonces(portableCrypto(), () => skill.sealContentMedia(nodeList, scope, input));
    assert.deepEqual(nodeSealed.result, sealed.result);
    const browserOpened = await session.openMedia(scope, nodeSealed.result);
    assert.deepEqual(browserOpened.bytes, input.bytes);
    assert.equal(browserOpened.name, input.name);
    assert.equal(browserOpened.contentType, input.contentType);
    const nodeOpened = await skill.openContentMedia(nodeList, scope, sealed.result);
    assert.deepEqual(nodeOpened.bytes, input.bytes);
    media.push({
      scope, byteLength, name: input.name, contentType: input.contentType,
      nonces: sealed.nonces, blobSha256: sha256(sealed.result),
      blob: byteLength < 100 ? Buffer.from(sealed.result).toString('base64url') : undefined,
      framedByteLength: sealed.result.byteLength,
    });
  }
  const fixture = {
    provenance: {
      generator: 'test-fixtures/generate-browser-vectors.cjs', runtime: process.version,
      sourceSha256, browserSchemaVersion: browser.content.CONTENT_SCHEMA_VERSION,
      verification: 'Actual UI account helper -> Node unwrap; Node list/field/media outputs -> actual UI memory session. All byte comparisons and cross-decryptions passed.',
      syntheticOnly: true,
    },
    identity, accountScope, accountRoot: Buffer.from(rootRaw).toString('base64url'),
    approval, listScope, listKey: Buffer.from(listRaw).toString('base64url'),
    listEnvelope: wrapped.result, listNonces: wrapped.nonces, fields, media,
  };
  fs.writeFileSync(path.join(__dirname, 'browser-crypto-v1.json'), JSON.stringify(fixture, null, 2) + '\n');
  rootRaw.fill(0); listRaw.fill(0); session.lock();
  console.log(`Wrote synthetic browser vectors from ${Object.keys(sourceSha256).length} UI source modules; all cross-codec checks passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
