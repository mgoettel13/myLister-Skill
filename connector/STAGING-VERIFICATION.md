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

## Remaining release gates

- Live shared-item and shared-note comments, sharing permissions and two-account isolation.
- File uploads/downloads, exports, sending, and the remaining tool families.
- Deployed token refresh/replay, expiry, restart persistence, and disconnect cleanup.
- Privacy review of expanded project user objects: live item responses include more
  profile/settings data than basic assignee display needs. Check cross-user exposure
  before production; this run only inspected its own newly created project item.
- Production secrets, restricted database credentials, policy/support details and
  the final submission checklist described in README.md.

These checks establish installed-plugin core functionality, not production readiness.
