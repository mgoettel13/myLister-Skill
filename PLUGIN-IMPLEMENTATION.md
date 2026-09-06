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
  upstream-key revocation, and retry worker implemented. Twenty unit tests pass.
- A real Atlas test passed in a disposable database: atomic grants, persisted records,
  retained cleanup obligations, HTTP registration/consent/PKCE exchange, MCP initialize,
  58-tool discovery, and rejected access after revocation. The test database was removed.
- All 185 existing standalone skill tests pass unchanged.
- MyLister UI consent page and Settings connected-app controls implemented; production
  build and typecheck passed. Native Codex callbacks support strict loopback URLs.
- Plugin manifest and bundled skill validate. The package points only to staging.
- Railway staging connector created: `e26ca418-2a63-449b-80b4-c8e4c3f70362`, with domain
  `mylister-connector-staging.up.railway.app`. Configuration is set with deploys skipped.
- Deployment, actual browser login/consent, installed Codex behavior, and live tool-family
  coverage remain in progress. No production readiness or publication is claimed.
- Existing local staging commits `a152211` (API welcome email) and `0a5926b` (UI item
  editing) were previously deployed but are not published. Preserve them in deployment-only
  worktrees without including them in plugin feature-branch pushes.
- Staging API is reachable at `https://lister-api-public-staging.up.railway.app`.
  `api-beta.mylister.dev` currently fails certificate-name validation. Keep TLS verification
  enabled. The live version suffix `e13541f` is the current Railway deployment ID prefix,
  not evidence of a conflicting Git commit. Its deployment metadata has no source SHA;
  inspect the deployment source before replacing it.

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
