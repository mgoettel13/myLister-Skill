import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// Deliberately fixed to staging. Never log callback codes, tokens or account data.
const issuer = 'https://mylister-connector-staging.up.railway.app/';
const resource = new URL('mcp', issuer).href;
const mode = process.argv[2] ?? 'replay';
if (!['replay', 'disconnect'].includes(mode)) throw new Error('Use replay or disconnect');
const check = (condition, label) => { if (!condition) throw new Error(label); console.log(`PASS ${label}`); };
const random = () => randomBytes(32).toString('base64url');
const verifier = random();
const state = random();
const callbackPath = `/callback/${random().slice(0, 16)}`;
const input = createInterface({ input: process.stdin });
const commands = [];
let inputClosed = false;
input.on('close', () => { inputClosed = true; });
input.on('line', line => commands.push(line.trim()));
async function command(expected) {
  console.log(`WAIT ${expected}`);
  const deadline = Date.now() + 20 * 60_000;
  while (!commands.includes(expected)) {
    if (inputClosed) throw new Error('Operator input closed; run this test with a persistent terminal (tty=true)');
    if (Date.now() > deadline) throw new Error('Operator step timed out');
    await delay(250);
  }
}
let client;
let tokens;
let finished = false;
let callbackResolve;
let callbackReject;
const callback = new Promise((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain');
  if (url.pathname !== callbackPath || req.method !== 'GET') { res.writeHead(404).end(); return; }
  if (url.searchParams.get('state') !== state || url.searchParams.get('iss') !== issuer) {
    res.writeHead(400).end('Invalid callback'); return;
  }
  if (url.searchParams.has('error')) {
    res.end('Test connection was not approved.'); callbackReject(new Error('Consent denied')); return;
  }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400).end('Missing code'); return; }
  res.end('MyLister staging test connected. You can return to Codex.');
  callbackResolve(code);
});
const fetchSafe = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(20_000), redirect: 'manual' });
async function tokenRequest(fields) {
  const response = await fetchSafe(new URL('token', issuer), {
    method: 'POST', body: new URLSearchParams({ client_id: client.client_id, resource, ...fields }),
  });
  return { status: response.status, body: await response.json() };
}
async function mcp(token, method = 'tools/list', params) {
  const response = await fetchSafe(resource, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}
async function revoke() {
  if (!client || !tokens) return;
  const response = await fetchSafe(new URL('revoke', issuer), {
    method: 'POST', body: new URLSearchParams({ client_id: client.client_id, token: tokens.refresh_token, token_type_hint: 'refresh_token' }),
  });
  if (response.status !== 200) throw new Error('Test connection cleanup failed');
}
async function cleanup() {
  if (finished) return;
  finished = true;
  try { await revoke(); } finally { server.close(); input.close(); process.stdin.pause(); }
}
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${server.address().port}${callbackPath}`;
  const metadata = await fetchSafe(new URL('.well-known/oauth-authorization-server', issuer)).then(r => r.json());
  check(metadata.issuer === issuer, 'issuer discovery matches staging');
  const registration = await fetchSafe(new URL('register', issuer), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', client_name: `MyLister lifecycle QA ${mode}` }),
  });
  check(registration.status === 201, 'temporary public client registered');
  client = await registration.json();
  console.log(`QA_CLIENT_ID ${client.client_id}`);
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
    scope: 'mylister', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
  const authorization = await fetchSafe(new URL(`authorize?${params}`, issuer));
  const consent = new URL(authorization.headers.get('location'));
  check(authorization.status === 302 && consent.origin === 'https://listerbeta.up.railway.app' && consent.pathname === '/integrations/authorize', 'normal staging consent required');
  console.log(`CONSENT_URL ${consent.href}`);
  const code = await Promise.race([callback, delay(9 * 60_000, undefined, { ref: false }).then(() => { throw new Error('Consent timed out'); })]);
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect };
  const badPkce = await tokenRequest({ ...exchange, code_verifier: random() });
  check(badPkce.status === 400 && badPkce.body.error === 'invalid_grant', 'wrong PKCE rejected without consuming valid code');
  const badTarget = await tokenRequest({ ...exchange, resource: `${resource}/other` });
  check(badTarget.status === 400, 'wrong token resource rejected');
  const result = await tokenRequest(exchange);
  check(result.status === 200 && result.body.refresh_token && result.body.expires_in === 600, 'PKCE exchange returns expected token lifetime');
  tokens = result.body;
  const issuedAt = Date.now();
  const reused = await tokenRequest(exchange);
  check(reused.status === 400 && reused.body.error === 'invalid_grant', 'authorization code replay rejected');
  const listed = await mcp(tokens.access_token);
  check(listed.status === 200 && listed.body.result?.tools?.length === 58, 'authenticated tool discovery');
  const data = await mcp(tokens.access_token, 'tools/call', { name: 'get_lists_summary', arguments: {} });
  check(data.status === 200 && data.body.result && !data.body.result.isError, 'dedicated integration key can read public data');

  if (mode === 'replay') {
    const original = tokens;
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: original.refresh_token });
    check(refreshed.status === 200 && refreshed.body.refresh_token !== original.refresh_token, 'refresh token rotates');
    tokens = refreshed.body;
    await command('restart-complete');
    check((await mcp(tokens.access_token)).status === 200, 'access token survives deployed connector restart');
    const afterRestart = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    check(afterRestart.status === 200, 'refresh token survives deployed connector restart');
    tokens = afterRestart.body;
    const remaining = Math.max(0, issuedAt + (original.expires_in + 2) * 1000 - Date.now());
    console.log(`WAIT real-access-expiry ${Math.ceil(remaining / 1000)} seconds`);
    await delay(remaining);
    check((await mcp(original.access_token)).status === 401, 'access token rejected after real ten-minute expiry');
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    check(fresh.status === 200, 'refresh recovers access after expiry');
    tokens = fresh.body;
    check((await mcp(tokens.access_token)).status === 200, 'new access token works after expiry');
    const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: original.refresh_token });
    check(replay.status === 400 && replay.body.error === 'invalid_grant', 'old refresh token replay rejected');
    check((await mcp(tokens.access_token)).status === 401, 'replay revokes current access token');
    const revoked = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    check(revoked.status === 400, 'replay revokes current refresh token');
  } else {
    await command('disconnect-complete');
    check((await mcp(tokens.access_token)).status === 401, 'UI disconnect invalidates access token');
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    check(refreshed.status === 400, 'UI disconnect invalidates refresh token');
  }
  console.log(`PASS ${mode} live lifecycle checks complete`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : 'Lifecycle check failed'}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch { console.error('FAIL cleanup needs operator verification'); process.exitCode = 1; }
}
