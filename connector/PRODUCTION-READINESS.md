# Production Plugin Preparation

Status: infrastructure reservation only. The installed plugin and its manifest still
target staging. An empty production service is reserved; no connector is deployed yet.

## Reserved Infrastructure (2026-09-08)

- Railway project: d14fd246-18fd-4e89-a70c-ba014ee0b4fc.
- Production environment: ce88d1a0-6757-4716-ad8f-24ccbafb79d8.
- Service: mylister-connector-prod, f137cdb7-c42b-4739-bf47-7dd048030d55.
- Owner-approved hostname: mcp.mylister.dev, target container port 8080.
- Required DNS: CNAME mcp.mylister.dev -> pea5lhnk.up.railway.app.
- Railway domain verification is pending DNS; certificate is validating ownership.
- Atlas integration returned reauthentication required. No database credential was
  created; never substitute the staging or unrestricted application credential.

## Verified Baseline

- Production public API /v1/version returned da1498f on 2026-09-08.
- Last verified successful production UI deployment used cc49a6c.
- These releases include the earlier privacy and note-comment hydration fixes.
- The later findings in FIX-HANDOFF.md remain a separate agent's repair scope.

## Configuration Decisions

- Public REST origin remains https://api.mylister.dev, using X-API-Key only.
- Approved connector origin: https://mcp.mylister.dev, pending DNS and deployment.
- Resolve production private API service and normal app consent URL from live service
  configuration; do not copy staging origins or assume the internal hostname.
- Provision a separate connector database and a credential restricted to that database.
- Generate independent production shared/encryption secrets through secret management.
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
