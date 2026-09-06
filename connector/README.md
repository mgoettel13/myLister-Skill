# MyLister OAuth/MCP connector

Staging implementation for the Codex plugin in `../plugins/mylister`.
The standalone API-key skill at the repository root remains independent.

## Architecture

The connector terminates OAuth authorization-code + PKCE (S256) and Streamable HTTP
MCP. It stores opaque token hashes and AES-256-GCM-encrypted, per-connection API keys
in MongoDB. It uses only `X-API-Key` against the fixed public MyLister `/v1` origin.
OAuth bearer tokens are never forwarded to the public API.

The private MyLister API authenticates the existing interactive user for consent,
creates a purpose-tagged integration key, and delivers it to the connector over an
authenticated internal request. Browsers see the OAuth code, not the MyLister key.
One `mylister` grant covers all app operations; list ownership and sharing permissions
remain authoritative. Integration keys cannot authenticate private `/api` requests.

Access tokens expire after 10 minutes. Refresh tokens rotate and are bound to a
30-day connection. Reuse revokes that connection. Registered clients do not expire.
Integration keys also expire after 30 days in the API. Disconnect, replay detection,
and expiry revoke the underlying key; failed revocations remain durably queued and
retry every 30 seconds. Connection records are not TTL-deleted before cleanup succeeds.

## Configuration

Set secrets through Railway variables or an equivalent secret manager, not files in
this repository. Never paste them into prompts, logs, or plugin metadata.

| Variable | Meaning |
| --- | --- |
| `CONNECTOR_PUBLIC_URL` | HTTPS connector origin, the exact OAuth issuer. |
| `MYLISTER_PUBLIC_API_URL` | Fixed HTTPS public API origin, without `/v1`. |
| `MYLISTER_PRIVATE_API_URL` | Private API origin; HTTPS or explicitly configured Railway internal HTTP. |
| `MYLISTER_CONSENT_URL` | Existing MyLister app's `/integrations/authorize` URL. |
| `MYLISTER_CONNECTOR_SECRET` | Random shared secret, at least 32 bytes; private API uses the same value. |
| `CREDENTIAL_ENCRYPTION_KEY` | Independent random 32-byte key encoded as canonical base64. |
| `MONGODB_URL` | Mongo connection string. |
| `MONGODB_DATABASE` | Dedicated connector database; do not use the application's data database. |
| `OAUTH_ALLOWED_REDIRECT_URIS` | JSON array of exact allowed HTTPS callbacks from the client's registration UI. |
| `OAUTH_ALLOW_LOOPBACK_CALLBACKS` | `true` enables native Codex HTTP callbacks on explicit loopback ports at `/callback` or `/callback/<id>`. Registration and redemption still bind the exact URI. |
| `MCP_ALLOWED_ORIGINS` | JSON array of browser origins allowed to call `/mcp`. Native clients without Origin are supported. |
| `PORT` | Listening port, defaults to 8080. |

The private API additionally needs `MYLISTER_CONNECTOR_URL` (the connector origin)
and matching `MYLISTER_CONNECTOR_ALLOW_LOOPBACK_CALLBACKS` when testing native Codex.
These settings are disabled by default when the shared secret or URL is absent.

## Run And Test

```sh
npm ci
npm test
npm start
```

`npm start` requires the environment above. Unit tests do not need credentials.
The optional real-Mongo test runs when `MONGODB_TEST_URL` is set. Alternatively,
`node scripts/test-mongo.mjs` accepts one JSON line containing `mongoUrl` on stdin.
It creates and removes only a randomized `mlc_test_*` database, tests atomic grants,
then exercises HTTP registration, consent handoff, PKCE token exchange, MCP initialize,
tool discovery, and revocation against the real SDK and Mongo store.

The deployment Dockerfile is rooted in this directory. `/health` is the healthcheck;
the authenticated Streamable HTTP endpoint is `/mcp`.

## Public API Contract

`contracts/public-openapi.json` is a pinned snapshot of the public `/v1` contract.
It generates 58 named tools: every public operation except the informational root.
Each tool uses validated `path`, `query`, and `body` arguments. No arbitrary host,
HTTP method, private endpoint, authorization header, or API key can be supplied.
Multipart uploads accept actual file bytes as base64 with a filename and MIME type.
The connector allows up to 20 MiB per upload; MyLister's configured upstream limit
still applies (currently 10 MiB in staging). Authenticated redirects are never followed.

Refresh the contract deliberately and review the diff:

```sh
node scripts/update-contract.mjs https://lister-api-public-staging.up.railway.app/openapi.json
npm test
```

## Production Release Gates

- Complete real staging user login/consent and installed Codex plugin tests, including
  two-account isolation, shared permissions, notes/comments, sending, and file uploads.
- Test restart persistence, revoked/expired keys, refresh replay, upstream outages,
  and disconnect cleanup in the deployed environment, not only mocks.
- Review API/UI changes alongside the connector. Existing unpublished staging changes
  must not be overwritten or silently published with this work.
- Provision a production connector database credential restricted to that database,
  independent production encryption/shared secrets, and an HTTPS connector domain.
- Register the exact production callbacks and update issuer, resource, API and consent
  URLs together. Do not reuse staging tokens or its database.
- Arrange backups and encryption-key recovery. Key rotation currently requires
  reconnecting affected accounts; do not replace the encryption key while active
  connections remain unless deliberately revoking them first.
- Review retained metadata, policy/support URLs, provider identity, screenshots, and
  reviewer test accounts. Complete the OpenAI submission checklist before publication.
- Publish a production plugin version only after these gates pass. This prerelease
  manifest is explicitly staging-only and is not yet a submitted/public production plugin.

References: [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth),
[plugin packaging](https://developers.openai.com/plugins/build/plugins), and
[security and privacy](https://developers.openai.com/plugins/guides/security-privacy).
