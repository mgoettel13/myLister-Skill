# Production Plugin Readiness

Updated 2026-09-09: production connector and consent are working. The production
release candidate is installed locally alongside staging and authenticated reads
passed. It is not yet submitted, approved, or publicly published.

## Verified Infrastructure

- Railway project: d14fd246-18fd-4e89-a70c-ba014ee0b4fc.
- Production environment: ce88d1a0-6757-4716-ad8f-24ccbafb79d8.
- Service: mylister-connector-prod, f137cdb7-c42b-4739-bf47-7dd048030d55.
- Owner-approved hostname: mcp.mylister.dev, target container port 8080.
- Required DNS: CNAME mcp.mylister.dev -> pea5lhnk.up.railway.app.
- Railway confirms the CNAME has propagated and domain routing is ACTIVE.
- DNS ownership and TLS certificate verification succeeded; normal HTTPS works.
- Atlas reconnection succeeded. The new user `mylister_connector_prod` has only
  readWrite on `mylister_connector_prod`, scoped to the Lister cluster; roles read back.
- Independent production shared/encryption secrets and the restricted database URI
  are stored in the connector's Railway variables, not this repository.
- Connector deployment `2f350ebd-0888-4d51-a829-77f4e8d1299f` reached SUCCESS.
- Eight production boundary smoke checks passed after consent configuration rollout.
- Local connector suite: 23 passed, zero failed, one optional Mongo test skipped;
  includes both staging and production packaging isolation checks.
- Private API configuration deployment `0202dd9b-455d-4c13-8fa9-e93a48322a30`
  reached SUCCESS using existing code `da1498f`. No older checkout was uploaded.
- Private API URL and resolved secret were read back. Its shared secret references
  the connector's existing Railway variable; no secrets were written to this repo.

## Installed And Authenticated

- Production package: `plugins/mylister-production`, version `0.1.0-rc.1`.
- Plugin and skill validators passed; installed as `mylister-production@personal`.
- The production browser consent page displayed the actual account and permissions.
  The user approved; `codex mcp login mylister-production` completed successfully.
- A fresh Codex acceptance run used the installed production server, not staging:
  `get_lists_summary` passed (31 lists); `get_priority_items` passed (5 items).
  Both returned without tool errors. Account content was omitted from the report.
- No production content was created, edited, deleted, shared, or emailed in this round.
- Staging installation and account connection remain separate and unchanged.

## Verified Baseline

- Production public API /v1/version returned da1498f on 2026-09-08.
- Last verified successful production UI deployment used cc49a6c.
- These releases include the earlier privacy and note-comment hydration fixes.
- The later findings in FIX-HANDOFF.md remain a separate agent's repair scope.

## Configuration Decisions

- Public REST origin remains https://api.mylister.dev, using X-API-Key only.
- Verified connector origin: https://mcp.mylister.dev.
- Verified private origin: http://lister-api-private-prod.railway.internal:80.
- Verified production UI domain: app.mylister.dev; consent uses /integrations/authorize.
- Private API connector URL/shared secret configured, with native-loopback callbacks enabled.
- Exact approved HTTPS callback and browser origins remain restricted.
- Preserve staging service, database, credentials and existing installed connection.

## Release Gates

1. Exercise controlled production write fixtures only after approval. Confirm outbound
   recipients before sending tests. Do not restart shared production services for QA.
2. Complete isolated outage/retry and expiry tests plus feature/permission gaps from
   STAGING-VERIFICATION.md. Recheck both comment fixes after the other agent delivers them.
   The nullable-description HTML export regression also requires merge, deployment,
   and live recheck: [API PR #12](https://github.com/mgoettel13/lister-api/pull/12).
   Explicit priority at item creation also requires deployment and recheck:
   [API PR #13](https://github.com/mgoettel13/lister-api/pull/13).
3. Per-tool annotation review is complete in [TOOL-ANNOTATIONS.md](TOOL-ANNOTATIONS.md).
   Staging deployment `e631756a-2703-4dd5-ab34-81458473183a` reached SUCCESS;
   all 58 live tool schemas/annotations match the reviewed build through Codex.
   Production deployment `67f41b66-8ba4-4ded-8120-22a51d8b27cd` also reached SUCCESS
   from `9de37da`. All 58 deployed schemas/annotations and eight boundary checks pass.
   The verifier detected old production metadata before the rollout and passed afterward.
   Post-rollout authenticated list-summary and priority reads passed with no tool errors.
   Scan final metadata in the submission portal when publisher access is available.
4. Confirm verified publisher identity, Apps Management write access, public policy,
   terms/support URLs, country availability, and backup/encryption-key recovery procedure.
5. Prepare reviewer access without MFA, SMS or email OTP. Run the committed
   [five positive and three negative cases](tests/PRODUCTION-REVIEWER-CASES.md) on
   disposable fixtures and record results; the test plan alone is not passing evidence.
6. Complete any OpenAI portal-issued domain challenge. Railway DNS verification does
   not replace OpenAI ownership verification; use only the exact issued challenge token.
7. Upload the production skill with the MCP endpoint after owner sign-off. Submission
   and publication after review approval are separate actions, neither performed here.

## Submission Audit (2026-09-09)

- Updated connector suite: 27 passed, zero failed, one optional Mongo test skipped.
- Live production OpenAPI paths and component schemas match the pinned snapshot.
- Refreshed remote staging refs: API `9168d68`, UI `e79374d`. The newer comment
  author/edit and swallowed-save-error findings remain present in those sources.
  Their fixes cannot be marked deployed or verified yet.
- OpenAI submission portal redirects to login; publisher identity, role and domain
  challenge are not yet inspectable. Owner sign-in is needed, not credentials in chat.
  Follow-up: sign-in is now available, but Create plugin > With MCP is blocked by
  missing developer identity verification in the selected organization. Individual
  and Business verification await owner action; no draft or challenge was created.
- The rendered production marketing homepage has no privacy, terms or support links.
  Public approved URLs must be provided or published; absence of homepage links alone
  does not prove those documents do not exist elsewhere.
- Submission copy and byte-verified bundle hashes are in
  [SUBMISSION-PACKET.md](SUBMISSION-PACKET.md). Packaging is complete; reviewer
  test execution and publisher/legal attestations are not implied by those artifacts.
- Connector error privacy hardening: `2e2afcf` removes upstream error bodies from
  tool responses. Regression evidence and scope limits are documented in
  [FAILURE-PATH-VERIFICATION.md](FAILURE-PATH-VERIFICATION.md): 31 tests pass,
  one optional Mongo test skipped; no production outage was induced.
  Production deployment `66dabc5f-dbbf-4684-b10b-bdd8ff003b96` reached SUCCESS;
  safe 404 guidance and an authenticated priority read passed after rollout.
  All eight boundary checks and 58-tool metadata/schema comparison also passed.
- Staging authenticated CSV upload/download now matches all 28 fixture bytes;
  attachment/project cleanup and safe 404 error guidance passed. See the dated
  [staging file round trip](STAGING-VERIFICATION.md).
- Further [staging reviewer workflows](tests/REVIEWER-STAGING-RESULTS-20260909.md)
  passed Journal text preservation, Call Mama priority/create-once, and project
  initial-note readback. HTML export failed for a normal null list description.
  API fix `3752ebd` is pushed in PR #12 with 70 focused tests passing; it is not
  merged or deployed. All fixtures from that run were deleted and read back as 404.
- The shared-note reviewer follow-up also passed: the authorized second account
  saw the exact comment text and actual author after a full browser reload. READ
  note-comment controls were absent. Test sharing was removed, the fixture deleted,
  and item readback returned 404. This does not close the separate two comment bugs.
- Additional [item lifecycle checks](tests/ITEM-LIFECYCLE-STAGING-20260909.md)
  passed 12 readback assertions for notes, own comments, ordering, moves, priority
  updates, and item/list archiving. Explicit priority during creation failed.
  API fix `66b6fac` is in PR #13 with 37 focused tests passing, not deployed.
  Both temporary lists and tasks were deleted; final task readbacks returned 404.

Workspace domain restrictions additionally require the documented UserInfo/email
claims and scopes. This connector currently uses only the `mylister` scope; do not
advertise workspace-domain restriction support without implementing and testing it.

References checked 2026-09-09:
[submission requirements](https://developers.openai.com/plugins/deploy/submission),
[remote server review](https://developers.openai.com/plugins/deploy/app-review).

Production deployment, authenticated verification and submission are separate milestones.

## Submission Draft Progress (2026-09-10)

Publisher identity verification is complete and the actual OpenAI submission draft
now exists. See [SUBMISSION-PACKET.md](SUBMISSION-PACKET.md) for its link and saved
fields. The uploaded skill passed the portal safety scan. Listing metadata, icons,
prompts, release notes and test-case expectations are populated.

The OAuth tool scan still requires owner authorization; domain verification,
reviewer account execution, approved privacy/terms/support links, demo recording,
country review and legal attestations remain unfinished. No production deployment,
submission or publication occurred during draft preparation. Earlier API PR and
regression statuses above have not been reverified by this documentation update.

Run `node connector/scripts/smoke-staging.mjs --production` from the repository root
for read-only boundary checks. Without the explicit flag the script still checks staging.
Start a new Codex task to load the installed production skill and tools.
