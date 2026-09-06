import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import type { Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { MyListerOAuthProvider } from './oauth.js';
import { CredentialVault, digest } from './vault.js';
import type { GrantStore, RecordEntry } from './store.js';

class MemoryStore implements GrantStore {
  readonly records = new Map<string, RecordEntry>();
  async insert(record: RecordEntry): Promise<void> {
    assert.ok(!this.records.has(record._id));
    this.records.set(record._id, structuredClone(record));
  }
  async get(id: string, kind: string): Promise<RecordEntry | null> {
    const entry = this.records.get(id);
    return entry?.kind === kind ? structuredClone(entry) : null;
  }
  async consume(id: string, kind: string, now: Date): Promise<RecordEntry | null> {
    const record = this.records.get(id);
    if (!record || record.kind !== kind || record.state !== 'active' || record.expiresAt <= now) return null;
    const previous = structuredClone(record);
    record.state = 'consumed';
    return previous;
  }
  async revoke(id: string, kind: string): Promise<void> {
    const record = this.records.get(id);
    if (record?.kind === kind) record.state = 'revoked';
  }
  async connections(userId: string): Promise<RecordEntry[]> {
    return [...this.records.values()].filter(record => record.kind === 'connection' && record.state === 'active' && record.data.userId === userId).map(record => structuredClone(record));
  }
  async pendingCleanup(now: Date): Promise<RecordEntry[]> {
    return [...this.records.values()].filter(record => record.kind === 'connection' && !record.data.keyRevokedAt && (record.state === 'revoked' || record.expiresAt <= now)).map(record => structuredClone(record));
  }
  async acknowledgeCleanup(id: string, now: Date): Promise<void> {
    const record = this.records.get(id)!;
    record.state = 'revoked';
    record.data.keyRevokedAt = now;
    delete record.data.encryptedKey;
    record.deleteAfter = new Date(now.getTime() + 7 * 86400_000);
  }
}

const resource = new URL('https://connector.example/mcp');
const redirectUri = 'https://client.example/callback';
const verifier = 'x'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function fixture(revokeUpstream?: (userId: string, keyId: string) => Promise<void>) {
  let now = Date.now();
  const store = new MemoryStore();
  const vault = new CredentialVault(randomBytes(32).toString('base64'));
  const provider = new MyListerOAuthProvider(store, vault, {
    issuer: new URL('https://connector.example'), resource,
    consentUrl: new URL('https://app.example/integrations/authorize'),
    allowedRedirects: [redirectUri],
  }, () => now, revokeUpstream);
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', client_name: 'Test client',
  });
  const begin = async () => {
    let consent = '';
    await provider.authorize(client, {
      redirectUri, codeChallenge: challenge, resource, scopes: ['mylister'], state: 'bound-state',
    }, { redirect: (value: string) => { consent = value; } } as Response);
    return new URL(consent).searchParams.get('request')!;
  };
  const approve = async (userId = 'user-one') => {
    const request = await begin();
    const approval = await provider.approve(request, userId, `key-${userId}`, `lister_test-${userId}`);
    return { ...approval, request, code: new URL(approval.redirect).searchParams.get('code')! };
  };
  return { provider, store, client, begin, approve, advance: (seconds: number) => { now += seconds * 1000; } };
}

test('credential vault authenticates ciphertext and connection identity', () => {
  const vault = new CredentialVault(randomBytes(32).toString('base64'));
  const encrypted = vault.seal('lister_test-secret', 'connection-one');
  assert.equal(vault.open(encrypted, 'connection-one'), 'lister_test-secret');
  assert.ok(!encrypted.includes('lister_test-secret'));
  assert.throws(() => vault.open(encrypted, 'connection-two'));
  const parts = encrypted.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => vault.open(parts.join('.'), 'connection-one'));
  assert.throws(() => new CredentialVault('weak-key'));
});

test('consent exposes no key; code is bound to client, redirect, resource, and single use', async () => {
  const f = await fixture();
  const approval = await f.approve();
  assert.ok(!approval.redirect.includes('lister_test'));
  assert.equal(new URL(approval.redirect).searchParams.get('state'), 'bound-state');
  await assert.rejects(f.provider.approve(approval.request, 'attacker', 'key', 'lister_test'));
  await assert.rejects(f.provider.exchangeAuthorizationCode({ ...f.client, client_id: 'other' }, approval.code, undefined, redirectUri, resource));
  await assert.rejects(f.provider.exchangeAuthorizationCode(f.client, approval.code, undefined, 'https://evil.example', resource));
  await assert.rejects(f.provider.exchangeAuthorizationCode(f.client, approval.code, undefined, redirectUri, new URL('https://wrong.example/mcp')));
  const tokens = await f.provider.exchangeAuthorizationCode(f.client, approval.code, undefined, redirectUri, resource);
  assert.equal(await f.provider.upstreamCredential(tokens.access_token), 'lister_test-user-one');
  await assert.rejects(f.provider.exchangeAuthorizationCode(f.client, approval.code, undefined, redirectUri, resource));
  const persisted = JSON.stringify([...f.store.records.values()]);
  assert.ok(!persisted.includes(tokens.access_token));
  assert.ok(!persisted.includes(tokens.refresh_token!));
  assert.ok(!persisted.includes('lister_test-user-one'));
  assert.ok(f.store.records.has(digest(tokens.access_token)));
});

test('refresh rotation detects replay and revokes the whole connection', async () => {
  const f = await fixture();
  const { code } = await f.approve();
  const first = await f.provider.exchangeAuthorizationCode(f.client, code, undefined, redirectUri, resource);
  const second = await f.provider.exchangeRefreshToken(f.client, first.refresh_token!, undefined, resource);
  assert.notEqual(first.refresh_token, second.refresh_token);
  await f.provider.verifyAccessToken(second.access_token);
  await assert.rejects(f.provider.exchangeRefreshToken(f.client, first.refresh_token!, undefined, resource));
  await assert.rejects(f.provider.verifyAccessToken(first.access_token));
  await assert.rejects(f.provider.verifyAccessToken(second.access_token));
  await assert.rejects(f.provider.exchangeRefreshToken(f.client, second.refresh_token!, undefined, resource));
});

test('concurrent authorization-code exchanges produce at most one token pair', async () => {
  const f = await fixture();
  const { code } = await f.approve();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    f.provider.exchangeAuthorizationCode(f.client, code, undefined, redirectUri, resource)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('disconnect is owner-scoped and does not affect another account', async () => {
  const f = await fixture();
  const one = await f.approve();
  const two = await f.approve('user-two');
  const tokenOne = await f.provider.exchangeAuthorizationCode(f.client, one.code, undefined, redirectUri, resource);
  const tokenTwo = await f.provider.exchangeAuthorizationCode(f.client, two.code, undefined, redirectUri, resource);
  await assert.rejects(f.provider.disconnect(one.connectionId, 'user-two'));
  assert.equal((await f.provider.disconnect(one.connectionId, 'user-one')).keyId, 'key-user-one');
  await assert.rejects(f.provider.verifyAccessToken(tokenOne.access_token));
  assert.equal(await f.provider.upstreamCredential(tokenTwo.access_token), 'lister_test-user-two');
});

test('access, consent, and authorization codes expire without relying on Mongo TTL cleanup', async () => {
  const f = await fixture();
  const request = await f.begin();
  const approval = await f.approve();
  f.advance(121);
  await assert.rejects(f.provider.challengeForAuthorizationCode(f.client, approval.code));
  const next = await f.approve();
  const tokens = await f.provider.exchangeAuthorizationCode(f.client, next.code, undefined, redirectUri, resource);
  f.advance(601);
  await assert.rejects(f.provider.verifyAccessToken(tokens.access_token));
  await assert.rejects(f.provider.consentDetails(request));
  await f.provider.exchangeRefreshToken(f.client, tokens.refresh_token!, undefined, resource);
});

test('registration rejects arbitrary callbacks and confidential-client metadata', async () => {
  const f = await fixture();
  await assert.rejects(async () => f.provider.clientsStore.registerClient!({ redirect_uris: ['https://evil.example'], token_endpoint_auth_method: 'none' }));
  await assert.rejects(async () => f.provider.clientsStore.registerClient!({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_post' }));
});

test('upstream revocation failures retain a durable cleanup obligation and retry safely', async () => {
  let unavailable = true;
  const calls: string[] = [];
  const f = await fixture(async (userId, keyId) => {
    if (unavailable) throw new Error('upstream unavailable');
    calls.push(`${userId}:${keyId}`);
  });
  const { code, connectionId } = await f.approve();
  const tokens = await f.provider.exchangeAuthorizationCode(f.client, code, undefined, redirectUri, resource);
  await f.provider.disconnect(connectionId, 'user-one');
  await assert.rejects(f.provider.verifyAccessToken(tokens.access_token));
  assert.equal((await f.store.get(connectionId, 'connection'))?.deleteAfter, undefined);
  unavailable = false;
  await f.provider.retryKeyRevocations();
  assert.deepEqual(calls, ['user-one:key-user-one']);
  const cleaned = await f.store.get(connectionId, 'connection');
  assert.ok(cleaned?.deleteAfter);
  assert.equal(cleaned?.data.encryptedKey, undefined);
  await f.provider.retryKeyRevocations();
  assert.equal(calls.length, 1);
});

test('expired connections also revoke their upstream keys', async () => {
  const keys: string[] = [];
  const f = await fixture(async (_userId, keyId) => { keys.push(keyId); });
  await f.approve();
  f.advance(31 * 86400);
  await f.provider.retryKeyRevocations();
  assert.deepEqual(keys, ['key-user-one']);
});

test('SDK token endpoint enforces PKCE before consuming authorization code', async t => {
  const f = await fixture();
  const app = express();
  app.use(mcpAuthRouter({ provider: f.provider, issuerUrl: new URL('https://connector.example'), resourceServerUrl: resource }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { code } = await f.approve();
  const exchange = (codeVerifier: string) => fetch(`http://127.0.0.1:${address.port}/token`, {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: f.client.client_id, code,
      code_verifier: codeVerifier, redirect_uri: redirectUri, resource: resource.href,
    }),
  });
  const denied = await exchange('y'.repeat(64));
  assert.equal(denied.status, 400);
  assert.equal((await denied.json() as { error: string }).error, 'invalid_grant');
  const accepted = await exchange(verifier);
  assert.equal(accepted.status, 200);
  const tokens = await accepted.json() as { access_token: string };
  assert.equal(await f.provider.upstreamCredential(tokens.access_token), 'lister_test-user-one');
});
