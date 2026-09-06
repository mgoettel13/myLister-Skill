import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoGrantStore } from './store.js';
import { createApp } from './app.js';
import { MyListerOAuthProvider } from './oauth.js';
import { CredentialVault } from './vault.js';
import type { ConnectorConfig } from './config.js';

test('Mongo persistence is atomic, survives a new store instance, and retains key cleanup', { skip: !process.env.MONGODB_TEST_URL }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URL!, { serverSelectionTimeoutMS: 10_000 });
  const databaseName = `mlc_test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  await client.connect();
  const db = client.db(databaseName);
  try {
    const first = new MongoGrantStore(db);
    await first.initialize();
    await first.insert({ _id: 'code', kind: 'code', state: 'active', expiresAt: new Date(Date.now() + 60_000), data: {} });
    const attempts = await Promise.all(Array.from({ length: 10 }, () => first.consume('code', 'code', new Date())));
    assert.equal(attempts.filter(Boolean).length, 1);
    const second = new MongoGrantStore(db);
    assert.equal((await second.get('code', 'code'))?.state, 'consumed');
    await first.insert({ _id: 'connection', kind: 'connection', state: 'revoked', expiresAt: new Date(0), data: { userId: 'user', keyId: 'key', encryptedKey: 'ciphertext' } });
    assert.equal((await second.pendingCleanup(new Date())).length, 1);
    const indexes = await db.collection('oauth_records').listIndexes().toArray();
    assert.ok(indexes.some(index => index.key.deleteAfter === 1 && index.expireAfterSeconds === 0));
    assert.ok(!indexes.some(index => index.key.expiresAt === 1));
    await second.acknowledgeCleanup('connection', new Date());
    assert.equal((await first.pendingCleanup(new Date())).length, 0);
    assert.equal((await first.get('connection', 'connection'))?.data.encryptedKey, undefined);

    const config: ConnectorConfig = {
      issuer: new URL('https://connector.example'), resource: new URL('https://connector.example/mcp'),
      consentUrl: new URL('https://app.example/integrations/authorize'),
      apiBase: new URL('https://api.example'), privateApiBase: new URL('https://private.example'),
      allowedRedirects: ['https://client.example/callback'], allowLoopback: true,
      allowedHosts: [], allowedOrigins: [], sharedSecret: 'test-only-service-secret-with-32-characters',
      encryptionKey: randomBytes(32).toString('base64'), mongoUrl: '', mongoDatabase: databaseName, port: 0,
    };
    const provider = new MyListerOAuthProvider(second, new CredentialVault(config.encryptionKey), config);
    const appServer = createApp(provider, config).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => appServer.once('listening', resolve));
    const address = appServer.address();
    assert.ok(address && typeof address !== 'string');
    const host = `127.0.0.1:${address.port}`;
    config.allowedHosts.push(host);
    const origin = `http://${host}`;
    try {
      const unauthorized = await fetch(`${origin}/mcp`, { method: 'POST' });
      assert.equal(unauthorized.status, 401);
      assert.ok(unauthorized.headers.get('www-authenticate')?.includes('oauth-protected-resource/mcp'));
      const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then(response => response.json()) as { issuer: string };
      assert.equal(metadata.issuer, config.issuer.href);
      const register = await fetch(`${origin}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: config.allowedRedirects, token_endpoint_auth_method: 'none', client_name: 'Codex test' }),
      });
      assert.equal(register.status, 201);
      const clientInfo = await register.json() as { client_id: string };
      const verifier = randomBytes(32).toString('base64url');
      const params = new URLSearchParams({ response_type: 'code', client_id: clientInfo.client_id,
        redirect_uri: config.allowedRedirects[0], scope: 'mylister', state: 'state-bound',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: config.resource.href,
      });
      const authorize = await fetch(`${origin}/authorize?${params}`, { redirect: 'manual' });
      assert.equal(authorize.status, 302);
      const invalidScope = new URLSearchParams(params);
      invalidScope.set('scope', 'admin');
      const errorRedirect = await fetch(`${origin}/authorize?${invalidScope}`, { redirect: 'manual' });
      assert.equal(errorRedirect.status, 302);
      assert.equal(new URL(errorRedirect.headers.get('location')!).searchParams.get('iss'), config.issuer.href);
      const pendingId = new URL(authorize.headers.get('location')!).searchParams.get('request')!;
      const deniedInternal = await fetch(`${origin}/internal/consent/${pendingId}`);
      assert.equal(deniedInternal.status, 401);
      const approved = await fetch(`${origin}/internal/consent/${pendingId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Connector-Secret': config.sharedSecret },
        body: JSON.stringify({ userId: '507f1f77bcf86cd799439011', keyId: '507f1f77bcf86cd799439012', apiKey: 'lister_test_credential' }),
      });
      assert.equal(approved.status, 200);
      const approval = await approved.json() as { redirect: string; connectionId: string };
      const callback = new URL(approval.redirect);
      assert.equal(callback.searchParams.get('iss'), metadata.issuer);
      const exchanged = await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams({
        grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: verifier,
        client_id: clientInfo.client_id, redirect_uri: config.allowedRedirects[0], resource: config.resource.href,
      }) });
      assert.equal(exchanged.status, 200);
      const tokens = await exchanged.json() as { access_token: string };
      const mcp = (method: string, params?: unknown) => fetch(`${origin}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal((await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).status, 200);
      const listed = await mcp('tools/list');
      assert.equal(listed.status, 200);
      const toolResponse = await listed.json() as { result: { tools: unknown[] } };
      assert.equal(toolResponse.result.tools.length, 58);
      await provider.disconnect(approval.connectionId, '507f1f77bcf86cd799439011');
      assert.equal((await mcp('tools/list')).status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => appServer.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    try {
      if (!/^mlc_test_[a-f0-9]{24}$/.test(databaseName)) throw new Error('Unsafe test database cleanup target');
      await db.dropDatabase();
    } finally { await client.close(); }
  }
});
