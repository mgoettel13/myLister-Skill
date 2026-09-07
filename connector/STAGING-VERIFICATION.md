# Staging verification

Verified on 2026-09-06 using the locally installed `mylister@personal` plugin,
version `0.1.0-staging.1`. No production changes or production requests were made.

## Authentication

The existing signed-in MyLister staging user approved the displayed Codex consent.
Native `codex mcp login mylister --oauth-client-registration dcr --scopes mylister`
completed successfully; the CLI subsequently reported `auth_status: o_auth`.
An ephemeral Codex run called `version` and `get_lists_summary` through the installed
MCP server successfully. Settings displayed Codex under Connected Apps with an expiry
and Disconnect control. Disconnect itself was not exercised in this run.

The first approval attempt exposed a shared quota between personal and integration
keys. API commit `a79ff2f` separates those quotas and personal-key listings; 50 focused
tests passed. Private API deployment `1c7a511f-cd82-4297-b4df-a76b0136d13b` reached
SUCCESS, and the retry completed without deleting or replacing existing keys.

## Core write procedure

Use an authenticated Codex session with normal write approval available. A read-only
noninteractive session with approval policy `never` correctly refused the write calls
before sending them. The successful run used `codex exec --ephemeral --approve-for-me`,
which routes write approvals through the normal automatic reviewer.

1. Create three uniquely prefixed temporary lists of types standard, notebook, project.
2. Track only the IDs returned by successful creates; never reuse a matching existing list.
3. Create `Call Mama`, update only `isPriority: true`, and find its ID in priority results.
4. Create the journal content with its leading and trailing spaces intact:
   ` it's been a tough day. Lots of meetings and no time to get anything done `.
5. Create a project item with an initial note; add a second note and edit its content.
6. Retrieve lists and items to verify types, exact content, priority and notes.
7. Delete only the three newly created list IDs, even if an earlier check fails.
8. Verify that reads of all three deleted list IDs return 404.

All eight steps passed. The deleted QA list IDs were
`6a9dda215665e12bfacc3898`, `6a9dda2f5665e12bfacc3899`, and
`6a9dda345665e12bfacc389a`. The run did not send email, share content, or upload files.

## Two-account browser regression: 2026-09-07

The installed MCP plugin stayed connected to account A while the Codex internal
browser signed into the user-designated second staging account B. Tests used only
new, uniquely named QA projects. No production requests or outbound emails were made.
An additional offered account was not needed for these checks.

| Check | Observed result |
| --- | --- |
| B opens A's unshared project in the browser | List Not Found; no content displayed |
| A calls `get_list` on B's unshared project | 404 |
| B grants A View only using the browser | A can read; `create_item` returns 403 Requires edit permission |
| B changes A to Can Edit | A creates a project task with initial note, dates, duration and B as assignee |
| Shared item comments | Plugin comment appears in B's browser; B replies and A reads both comments |
| Shared note comments through MCP | Create and read succeed; B's browser reply is returned by MCP |
| Shared note comments after browser reload | FAIL: dialog says No comments yet although both comments remain in API responses |
| Shared author/assignee privacy | FAIL: expanded user objects disclose account settings and phone fields across accounts |
| Item attachment | Upload of a synthetic 37-byte text file succeeds; browser lists it; MCP download matches the original text |
| JSON list export | Contains the one QA task, with expected export structure |
| B removes A's access | User confirmed the browser prompt; A's list/item/file reads and note-comment write all return 404 |
| Unauthenticated boundary smoke | All eight checks pass again |

The attachment-link click alone did not establish a completed browser download;
byte-content verification above is through MCP. A successful JSON export does not
establish HTML export or email delivery.

### Reproduced defects (fixed and retested below)

1. **Excessive collaborator profile disclosure.** Create a shared project, assign
   a task to the other account, then call `create_item` / `get_item` and the item/note
   comment endpoints. `createdByUser` and `assignedToUser` contain `settings`,
   `phone`, `isAdmin`, `isActive`, `isDiscoverable` and `createdAt`, in addition to
   identity display fields. Settings can include shortcuts and unrelated pinned
   list IDs. This was verified on the other account, not merely the caller's own
   profile. `routers/public_handlers/items.py` uses `build_user_response_dict`
   for these summaries. Replace this with an explicit collaborator-display
   allowlist and add cross-account regression coverage for every population path.
   No actual private field values are retained in this report.
2. **Note-comment UI hydration loses saved comments.** Add a plugin note comment,
   reply from the browser owner, then reload the item detail page. The note comment
   count disappears and its dialog says No comments yet. MCP `get_item` still
   returns two embedded note comments and `get_note_comments` returns both authors.
   The item detail mapper in `src/app/lists/[id]/items/[itemId]/page.tsx` maps note
   fields but omits `comments`. Before reload, the original plugin note author was
   also rendered as Someone. Preserve note comments and author/date data, then
   retest initial load, reply and reload in both accounts.

### Test record cleanup

- A's project `6a9e48065665e12bfacc38a1` was deleted through MCP; readback returns 404.
- B's project `6a9e491dfcfdc32173f0f0e7` contains only the synthetic QA task, note,
  comments and attachment. A's sharing grant has been removed. Owner-side cleanup
  is awaiting confirmation; do not treat A's permission-denied 404 as deletion proof.
- B's existing-account onboarding created its normal Quick Takes starter list.
  It is not QA content and must not be deleted during cleanup.

## Bug fixes and deployed retest: 2026-09-07

Both reproduced defects are fixed on the existing feature branches:

- API `a5db306` on `codex/mylister-plugin-auth`: explicit collaborator-display
  serialization and database projections for creator, assignee and comment
  author responses; note-only authors are also populated on list reads.
- UI `95782d5` on `codex/mylister-plugin-consent`: shared, tested note mapper
  preserves comments, author identity and parsed dates on detail load/reload.
- Both branches were pushed and fetched; local/remote divergence is `0 0`.
- 68 focused API tests passed, including eight new privacy regressions. Three
  frontend mapper/wiring tests passed; TypeScript checking and the combined
  deployment-worktree Next.js build passed. The eight live boundary checks passed.

All three submitted Railway staging deployments reached SUCCESS:

| Service | Deployment |
| --- | --- |
| Public API | `bf3e9ad5-0531-4adc-b22c-ec04e08652ba` |
| Private API | `0c8ca057-b750-4ccf-a59e-035d69e591f2` |
| Web UI | `8addf5a7-1d32-429b-9feb-553d76536009` |

Live retest used a fresh project `6a9e4dbb2ec7b350b4300102`, shared from A to B
with edit access, and a task assigned to B. MCP create/get/list and comment
create/read responses contained only `id`, `name`, `email`, `initials`, and
`profilePictureKey` in user summaries, including B's assignee and comment identity.
No settings, phone, privileged flags or account timestamps were returned there.

In the internal browser signed into B, the plugin-created note comment displayed
the correct author. B posted a reply; MCP returned both named authors. After a
full page reload, the browser still showed `Comments (2)`, both exact texts, and
both correct author names. This verifies the original reload failure and the
previous Someone author rendering with an authenticated cross-account flow.

The fresh retest project was deleted through its owning MCP account and a subsequent
read returned 404. The earlier B-owned QA project remains unshared and awaits its
separate cleanup approval. No production service or credential was changed.

## OAuth lifecycle preparation: 2026-09-07

- Connector unit/HTTP tests: 21 passed. The optional Mongo test was then run
  separately against an isolated temporary database and passed; its database was
  deleted in the test's finally block.
- Live staging issuer discovery, temporary public-client registration, and normal
  browser consent routing passed. The new grant was not approved. Cancellation
  returned an issuer/state-bound access-denied callback; no tokens were issued.
  The local callback listener was stopped. This is not an authenticated lifecycle pass.
- `scripts/test-oauth-staging.mjs` is a staging-only, token-in-memory runner:
  `node connector/scripts/test-oauth-staging.mjs replay` exercises PKCE, code reuse,
  refresh rotation, restart persistence, natural ten-minute access expiry and
  refresh replay revocation after explicit consent. At `WAIT restart-complete`,
  restart only the staging connector, verify Railway success, then supply that
  exact command on stdin. The `disconnect` mode instead waits for the owner to
  disconnect the named QA app in Settings, then accepts `disconnect-complete`.
  Do not disconnect the user's pre-existing plugin connection.
  Run either mode in a persistent interactive terminal (`tty=true` with Codex
  exec_command); closed stdin aborts the operator step and revokes issued tokens.
- `scripts/inspect-oauth-qa.mjs` reads the exact QA client/owner's connector and
  integration-key records to verify revocation and encrypted-key removal. Supply
  `connectorMongoUrl`, `connectorDatabase`, `apiMongoUrl`, `apiDatabase`, `clientId`,
  and `userId` as one JSON line on stdin, using securely loaded staging config.
  It permits only the named staging databases and lifecycle-QA client names,
  does not fetch plaintext/encrypted credentials, and performs no writes.
- Both scripts pass Node syntax checks. Their authenticated lifecycle and cleanup
  verification paths still require a user-approved temporary staging connection.
  Natural 30-day connection expiry is not covered by a ten-minute access-token test.

## Remaining release gates

### Lifecycle retry evidence: 2026-09-07

- A user-approved temporary QA connection passed wrong-PKCE rejection, wrong-resource
  rejection, valid code exchange, authorization-code replay rejection, authenticated
  discovery of 58 tools, a real public-data read and initial refresh-token rotation.
- The staging connector was restarted and returned to SUCCESS with a new startup
  log at `2026-09-07T13:54:27Z`. The runner's noninteractive stdin was closed, so
  post-restart access/refresh assertions did not run. Restart persistence is **not**
  verified by the service restart alone.
- The owner-side Settings disconnect removed that QA connection. Read-only inspection
  of its exact staging records confirmed revoked connection state, acknowledged
  cleanup, removal of the encrypted key, and revocation of the dedicated upstream
  integration key. The stalled local runner was stopped.
- The runner now detects closed operator input and cleans up instead of waiting for
  its operator timeout. A fresh run with `tty=true` accepted terminal input, but no
  consent callback arrived during its nine-minute window. It exited with
  `Consent timed out`; no tokens were obtained in that run.
- Verification rerun: 21 connector tests passed, one optional Mongo test skipped;
  all eight live boundary checks and an existing installed-plugin data read passed.
  Node syntax checking and `git diff --check` passed. No production changes were made.

### Still Required

- Extend permission testing to
  admin operations, comment ownership, and revoked/readonly writes across tool families.
- Additional file types, note attachments, HTML exports, confirmed sending, and
  the remaining tool families. Generic item text attachment and JSON export passed.
- Complete deployed refresh replay, natural access expiry, post-restart token use,
  and immediate access/refresh rejection after UI disconnect. Initial refresh rotation
  and owner disconnect's durable upstream cleanup passed as recorded above.
- Finish the earlier QA cleanup and broader privacy review beyond item collaborators.
- Production secrets, restricted database credentials, policy/support details and
  the final submission checklist described in README.md.

These checks establish installed-plugin core functionality, not production readiness.
