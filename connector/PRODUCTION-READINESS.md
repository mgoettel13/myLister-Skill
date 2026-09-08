# Production Plugin Preparation

Status: connector deployed; HTTPS ownership verification pending. The installed
plugin and its manifest still target staging. Production consent is not enabled yet.

## Reserved Infrastructure (2026-09-08)

- Railway project: d14fd246-18fd-4e89-a70c-ba014ee0b4fc.
- Production environment: ce88d1a0-6757-4716-ad8f-24ccbafb79d8.
- Service: mylister-connector-prod, f137cdb7-c42b-4739-bf47-7dd048030d55.
- Owner-approved hostname: mcp.mylister.dev, target container port 8080.
- Required DNS: CNAME mcp.mylister.dev -> pea5lhnk.up.railway.app.
- Railway confirms the CNAME has propagated and domain routing is ACTIVE.
- Ownership remains unverified; certificate is VALIDATING_OWNERSHIP. Add the TXT
  record returned by `railway domain status mcp.mylister.dev` at `_railway-verify.mcp`.
- Atlas reconnection succeeded. The new user `mylister_connector_prod` has only
  readWrite on `mylister_connector_prod`, scoped to the Lister cluster; roles read back.
- Independent production shared/encryption secrets and the restricted database URI
  are stored in the connector's Railway variables, not this repository.
- Connector deployment `2f350ebd-0888-4d51-a829-77f4e8d1299f` reached SUCCESS.
- 21 local connector tests passed; the optional Mongo test was skipped.
- Public HTTPS smoke checks have NOT passed: local lookup failed, and direct routing
  with normal TLS validation reported a certificate mismatch. No TLS checks bypassed.
- Production private API variables remain unchanged until connector HTTPS is valid.

## Verified Baseline

- Production public API /v1/version returned da1498f on 2026-09-08.
- Last verified successful production UI deployment used cc49a6c.
- These releases include the earlier privacy and note-comment hydration fixes.
- The later findings in FIX-HANDOFF.md remain a separate agent's repair scope.

## Configuration Decisions

- Public REST origin remains https://api.mylister.dev, using X-API-Key only.
- Approved connector origin: https://mcp.mylister.dev, pending certificate verification.
- Verified private origin: http://lister-api-private-prod.railway.internal:80.
- Verified production UI domain: app.mylister.dev; consent uses /integrations/authorize.
- Configure the private API's connector URL/shared secret together with the connector.
- Configure exact approved callbacks and origins, with explicit native-loopback policy.
- Preserve staging service, database, credentials and existing installed connection.

## Release Checks

1. Resolve hostname and infrastructure, deploy connector, verify SUCCESS and health.
2. Verify issuer/resource metadata and API-key-only/private endpoint boundaries.
3. Approve a fresh production OAuth connection in the browser; never reuse staging tokens.
4. Exercise controlled production fixtures only after approval. Confirm outbound email
   recipients before any sending test. Avoid restarting shared production services for QA.
5. Complete isolated outage/retry and expiry tests plus feature/permission gaps from
   STAGING-VERIFICATION.md. Recheck both comment fixes after the other agent delivers them.
6. Create production plugin packaging without changing the installed staging package
   or advertising an endpoint before it works. Validate tool annotations and contract.
7. Assemble verified publisher identity, listing/policy/support details, starter prompts,
   five positive and three negative reviewer cases, and reviewer account access.

Production deployment, authenticated verification and submission are separate milestones.

Run `node connector/scripts/smoke-staging.mjs --production` from the repository root
after HTTPS is ready. Without the explicit flag the script still checks staging.
