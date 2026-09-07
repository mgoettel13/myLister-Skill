# MyLister plugin delivery

## Agreed requirements

- A public Codex plugin with all existing MyLister skill capabilities.
- A new staged OAuth/MCP connector service, reusable for a production release.
- Full app access; no feature-specific permission scopes or product tiers.
- Each connection owns a dedicated MyLister integration key.
- The public `/v1` data API stays API-key-only and rejects bearer tokens.
- Integration keys are rejected by private `/api` authentication, including key creation.
- OAuth login reuses the existing MyLister account, with explicit consent.
- API keys stay encrypted on the connector; disconnect revokes tokens and the key.
- Validate OAuth, account isolation, every tool family, and installed plugin behavior on staging.
- Document production configuration and submission steps; production deployment is not part of this staging goal.

## Work locations

- Plugin: `codex/mylister-plugin` in the MyLister-Skill repository.
- API: `codex/mylister-plugin-auth` in the lister-api repository, based on refreshed `origin/staging`.
- Railway: Lister-UI project, staging environment. Reuse staging public/private APIs.

## Evidence and remaining work

- API integration-key boundary and interactive consent endpoints implemented; 84 focused
  auth, key, consent, and surface tests pass locally. Integration keys have a 30-day lifetime.
- Connector encrypted credential vault, Mongo persistence, SDK OAuth provider, durable
  upstream-key revocation, and retry worker implemented. Twenty-one unit tests pass.
- A real Atlas test passed in a disposable database: atomic grants, persisted records,
  retained cleanup obligations, HTTP registration/consent/PKCE exchange, MCP initialize,
  58-tool discovery, and rejected access after revocation. The test database was removed.
- All 185 existing standalone skill tests pass unchanged.
- MyLister UI consent page and Settings connected-app controls implemented; production
  build and typecheck passed. Native Codex callbacks support strict loopback URLs.
- Plugin manifest and bundled skill validate. The package points only to staging.
- All four Railway staging services reached `SUCCESS`. Current deployment evidence:
  connector `fcdf53a5-b649-4b93-8c41-92bd8ce708cc`, private API
  `0c8ca057-b750-4ccf-a59e-035d69e591f2`, public API
  `bf3e9ad5-0531-4adc-b22c-ec04e08652ba`, UI
  `8addf5a7-1d32-429b-9feb-553d76536009`.
- Live health, OAuth discovery, unauthenticated MCP rejection, and API version routes
  were verified. The issuer includes its trailing slash; the resource is `/mcp`.
- The committed read-only `connector/scripts/smoke-staging.mjs` passes all eight
  deployed checks, including rejected OAuth bearer authentication on public data
  endpoints and rejected unauthenticated connector-internal requests.
- The staging plugin is installed locally as `mylister@personal`, version
  `0.1.0-staging.1`. `codex mcp login mylister --oauth-client-registration dcr
  --scopes mylister` registered successfully and reached the existing signed-in
  MyLister consent page through the deployed private API.
- The first live consent attempt received an internal HTTP 421. Redeploying the
  connector resolved it without relaxing Host or secret checks. Added secret-safe
  diagnostics and a regression test for the configured Railway Host, service secret,
  and rejection of browser Origin on internal consent routes. The original rejected
  Host was not logged, so its exact cause is not established.
- User-approved browser consent and the native Codex OAuth callback succeeded on
  2026-09-06. `codex mcp list` reports `o_auth`. An ephemeral Codex run using the
  installed plugin successfully called `version` and `get_lists_summary` on staging.
  The Connected Apps settings view displays Codex, its expiry, and Disconnect.
- Live consent exposed a quota collision with three existing personal keys. API
  commit `a79ff2f` gives personal keys and integration connections independent quotas
  using the existing per-user limit. Expired connections do not consume the active
  integration quota. Personal key listings exclude integration credentials; legacy
  keys still count as personal. Fifty focused auth/key/consent tests pass, and the
  deployed fix allowed authorization without deleting or replacing existing keys.
- Two-account browser/MCP testing on 2026-09-07 passed unshared isolation in both
  directions, read-only write rejection, edit sharing, shared comments, project
  assignment, text attachment download, JSON export and access removal. It exposed
  cross-account profile over-disclosure and note comments disappearing from the UI
  after reload. Both were fixed and live-retested on staging: API `a5db306`, UI
  `95782d5`; 68 focused API and three frontend regressions pass. Shared profiles
  now contain display identity only, and both authors/comments survive a browser
  reload. Full tool-family coverage, deployed OAuth revocation/replay, and
  restart tests remain in progress. No production readiness is claimed. See
  `connector/STAGING-VERIFICATION.md` for reproduction steps and cleanup status.
- Installed-plugin core write regression passed with temporary standard, notebook,
  and project lists: exact journal whitespace, item creation, priority-only update,
  priority query, initial notes, note creation, and note editing. All three test lists
  were deleted and each subsequent `get_list` returned 404. See
  `connector/STAGING-VERIFICATION.md` for the test procedure and evidence limits.
- Existing local staging commits `a152211` (API welcome email) and `0a5926b` (UI item
  editing) were previously deployed but are not published. Preserve them in deployment-only
  worktrees without including them in plugin feature-branch pushes.
- Staging API is reachable at `https://lister-api-public-staging.up.railway.app`.
  `api-beta.mylister.dev` currently fails certificate-name validation. Keep TLS verification
  enabled. Version suffixes in these local-upload deployments are Railway deployment
  ID prefixes, not Git commit hashes. Combined deployment builds preserve the existing
  local changes; 89 focused API tests and the combined UI production build passed.

## Connection design

The connector implements OAuth authorization-code + PKCE and a single full-access
`mylister` grant. It redirects consent to the signed-in MyLister app. The private API
verifies the interactive user session, provisions an integration key, and sends it
directly to the connector over an authenticated server-to-server connection.
Only an OAuth authorization code is returned to the client. Resource requests use
the dedicated key against `/v1`; OAuth credentials never reach `/v1`.

The connector must bind each request, code, token and encrypted key to its client,
user and resource. Authorization codes are short-lived and single-use. Refresh
tokens rotate with replay detection. Server-side connection revocation must be
checked on each call. Unknown/revoked keys and tokens fail closed.
