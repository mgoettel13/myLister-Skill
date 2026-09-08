import assert from 'node:assert/strict';

// No accounts, grants, or API keys are created. Production requires an explicit flag.
assert.ok(process.argv.slice(2).every(arg => arg === '--production'), 'Unknown argument');
const production = process.argv.includes('--production');
const connector = production ? 'https://mcp.mylister.dev' : 'https://mylister-connector-staging.up.railway.app';
const publicApi = production ? 'https://api.mylister.dev' : 'https://lister-api-public-staging.up.railway.app';
const resource = `${connector}/mcp`;
let checks = 0;
async function check(name, url, status, init = {}, validate) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, status, `${name}: unexpected HTTP status`);
  if (validate) await validate(response);
  else await response.body?.cancel();
  checks++;
  console.log(`PASS ${name}`);
}

await check('connector health', `${connector}/health`, 200, {}, async response => {
  assert.equal((await response.json()).service, 'mylister-connector');
});
await check('OAuth discovery and PKCE', `${connector}/.well-known/oauth-authorization-server`, 200, {}, async response => {
  const metadata = await response.json();
  assert.equal(metadata.issuer, `${connector}/`);
  assert.equal(metadata.authorization_endpoint, `${connector}/authorize`);
  assert.equal(metadata.token_endpoint, `${connector}/token`);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.scopes_supported, ['mylister']);
});
await check('MCP authentication challenge', resource, 401, { method: 'POST' }, async response => {
  const challenge = response.headers.get('www-authenticate');
  assert.ok(challenge?.includes('resource_metadata='));
  const metadataUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.ok(metadataUrl);
  assert.equal(new URL(metadataUrl).origin, connector);
  const metadataResponse = await fetch(metadataUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [`${connector}/`]);
  await response.body?.cancel();
});
await check('invalid OAuth token rejected', resource, 401, {
  method: 'POST', headers: { Authorization: 'Bearer smoke-test-invalid-token' },
});
await check('unapproved browser origin rejected', resource, 403, {
  method: 'POST', headers: { Origin: 'https://untrusted.example' },
});
await check('internal route requires service credential', `${connector}/internal/connections/list`, 401, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
await check('public data requires API key', `${publicApi}/v1/lists`, 401);
await check('public data rejects OAuth bearer', `${publicApi}/v1/lists`, 401, {
  headers: { Authorization: 'Bearer smoke-test-invalid-token' },
});
console.log(`${checks} ${production ? 'production' : 'staging'} boundary checks passed. Authenticated behavior is not covered.`);
