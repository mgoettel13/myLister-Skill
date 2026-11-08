import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { IdentityStorageError, loadIdentity, loadOrCreateIdentity } from './identity.js';
import { portableCrypto } from './crypto/runtime.js';

const execute = promisify(execFile);
const base = 'https://api.synthetic.example';
const apiKey = 'synthetic-api-key-ONLY-for-tests-0123456789abcdef';

async function withStorage(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'mylister-identity-test-'));
  const previous = process.env.LISTER_CONFIG_DIR;
  process.env.LISTER_CONFIG_DIR = directory;
  try { await run(directory); } finally {
    if (previous === undefined) delete process.env.LISTER_CONFIG_DIR;
    else process.env.LISTER_CONFIG_DIR = previous;
    const checked = resolve(directory);
    assert.ok(checked.startsWith(resolve(tmpdir()) + sep) && checked.includes('mylister-identity-test-'));
    await rm(checked, { recursive: true, force: true });
  }
}

async function identityFiles(directory: string): Promise<string[]> {
  return (await readdir(join(directory, 'identities'))).filter(name => name.endsWith('.json')).map(name => join(directory, 'identities', name));
}

const storageError = (error: unknown): boolean => error instanceof IdentityStorageError
  && !error.message.includes(apiKey) && !error.message.includes(base) && !error.message.includes('privateKey');

test('missing identity is read-only; persisted PKCS8 is encrypted using only the API key', async () => {
  await withStorage(async directory => {
    assert.equal(await loadIdentity(base, apiKey), undefined);
    assert.deepEqual(await readdir(directory), []);
    const identity = await loadOrCreateIdentity(`${base}/`, apiKey);
    assert.deepEqual(Object.keys(identity.publicKey), ['crv', 'kty', 'x', 'y']);
    assert.equal(identity.installationId, createHash('sha256').update(JSON.stringify(identity.publicKey)).digest('hex'));
    assert.equal(identity.privateKey.extractable, false);
    assert.equal(identity.privateKey.algorithm.name, 'ECDH');
    await assert.rejects(portableCrypto().subtle.exportKey('pkcs8', identity.privateKey));
    const files = await identityFiles(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /[0-9a-f]{64}\.json$/);
    const source = await readFile(files[0], 'utf8');
    const stored = JSON.parse(source);
    assert.equal(source.includes(apiKey), false);
    assert.equal(source.includes(base), false);
    assert.equal(source.includes('PRIVATE KEY'), false);
    assert.equal(source.includes('privateKey'), false);
    assert.equal('d' in stored.publicKey, false);
    assert.equal(Buffer.from(stored.salt, 'base64url').length, 32);
    assert.equal(Buffer.from(stored.iv, 'base64url').length, 12);
    assert.ok(Buffer.from(stored.ciphertext, 'base64url').length > 48);
    const loaded = await loadIdentity(base, apiKey);
    assert.equal(loaded!.installationId, identity.installationId);
    assert.deepEqual(loaded!.publicKey, identity.publicKey);
    const unchanged = await loadOrCreateIdentity(base, apiKey);
    assert.equal(unchanged.installationId, identity.installationId);
    assert.equal(await readFile(files[0], 'utf8'), source);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(join(directory, 'identities'))).mode & 0o777, 0o700);
      assert.equal((await lstat(files[0])).mode & 0o777, 0o600);
    }
  });
});

test('base URL and API key each scope the identity and copied ciphertext cannot cross scopes', async () => {
  await withStorage(async directory => {
    const first = await loadOrCreateIdentity(base, apiKey);
    const firstFile = (await identityFiles(directory))[0];
    const bytes = await readFile(firstFile);
    assert.equal(await loadIdentity('https://other.synthetic.example', apiKey), undefined);
    assert.equal(await loadIdentity(base, `${apiKey}-other`), undefined);
    const hostIdentity = await loadOrCreateIdentity('https://other.synthetic.example', apiKey);
    const keyIdentity = await loadOrCreateIdentity(base, `${apiKey}-other`);
    assert.notEqual(hostIdentity.installationId, first.installationId);
    assert.notEqual(keyIdentity.installationId, first.installationId);
    const files = (await identityFiles(directory)).filter(file => file !== firstFile);
    for (const file of files) await copyFile(firstFile, file);
    await assert.rejects(loadIdentity('https://other.synthetic.example', apiKey), storageError);
    await assert.rejects(loadIdentity(base, `${apiKey}-other`), storageError);
    assert.deepEqual(await readFile(firstFile), bytes);
  });
});

test('corrupt envelopes fail closed and are never replaced during load-or-create', async () => {
  await withStorage(async directory => {
    await loadOrCreateIdentity(base, apiKey);
    const file = (await identityFiles(directory))[0];
    const original = JSON.parse(await readFile(file, 'utf8'));
    const mutations = ['not json', JSON.stringify({ ...original, version: 2 }), JSON.stringify({ ...original, salt: 'A'.repeat(10000) }),
      JSON.stringify({ ...original, installationId: '0'.repeat(64) }), JSON.stringify({ ...original, publicKey: { ...original.publicKey, d: 'private' } }),
      JSON.stringify({ ...original, ciphertext: Buffer.alloc(154, 1).toString('base64url') }),
    ];
    for (const bytes of mutations) {
      await writeFile(file, bytes, 'utf8');
      await assert.rejects(loadIdentity(base, apiKey), storageError);
      await assert.rejects(loadOrCreateIdentity(base, apiKey), storageError);
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
    assert.equal((await readdir(join(directory, 'identities'))).some(file => file.endsWith('.tmp')), false);
  });
});

test('identity persists across independent Node processes and concurrent creators converge', async () => {
  await withStorage(async directory => {
    const moduleUrl = new URL('./identity.js', import.meta.url).href;
    const script = `import {loadOrCreateIdentity} from ${JSON.stringify(moduleUrl)}; const i=await loadOrCreateIdentity(${JSON.stringify(base)},process.env.SYNTHETIC_IDENTITY_KEY); console.log(JSON.stringify({id:i.installationId,publicKey:i.publicKey,extractable:i.privateKey.extractable}));`;
    const options = { env: { ...process.env, LISTER_CONFIG_DIR: directory, SYNTHETIC_IDENTITY_KEY: apiKey }, timeout: 20000 };
    const children = await Promise.all(Array.from({ length: 6 }, () => execute(process.execPath, ['--input-type=module', '--eval', script], options)));
    const installed = children.map(child => {
      assert.equal(child.stderr, '');
      assert.equal(child.stdout.includes(apiKey), false);
      return JSON.parse(child.stdout);
    });
    assert.equal(new Set(installed.map(i => i.id)).size, 1);
    assert.ok(installed.every(i => i.extractable === false));
    assert.equal((await identityFiles(directory)).length, 1);
    assert.equal((await readdir(join(directory, 'identities'))).some(file => file.endsWith('.tmp')), false);
    const later = await execute(process.execPath, ['--input-type=module', '--eval', script], options);
    assert.deepEqual(JSON.parse(later.stdout), installed[0]);
    assert.equal((await loadIdentity(base, apiKey))!.installationId, installed[0].id);
  });
});

test('POSIX file permissions are tightened when an existing identity is loaded', { skip: process.platform === 'win32' }, async () => {
  await withStorage(async directory => {
    await loadOrCreateIdentity(base, apiKey);
    const file = (await identityFiles(directory))[0];
    await chmod(join(directory, 'identities'), 0o755);
    await chmod(file, 0o644);
    await loadIdentity(base, apiKey);
    assert.equal((await lstat(join(directory, 'identities'))).mode & 0o777, 0o700);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  });
});

test('identity rejects malformed origins and missing secrets without exposing input values', async () => {
  await withStorage(async directory => {
    for (const value of ['invalid', `https://${apiKey}@example.com`, 'https://example.com/path', 'http://example.com']) {
      await assert.rejects(loadIdentity(value, apiKey), storageError);
    }
    await assert.rejects(loadOrCreateIdentity(base, ''), storageError);
    assert.deepEqual(await readdir(directory), []);
  });
});
