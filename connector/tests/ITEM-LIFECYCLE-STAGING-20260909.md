# Staging Item Lifecycle Verification

Executed 2026-09-09 at approximately 10:47-10:49 UTC using the installed staging
MCP plugin, version 0.1.0-staging.1. The API version check identifies public
deployment bf3e9ad5-0531-4adc-b22c-ec04e08652ba (commit metadata is local).
These are owner-account tool workflows, not all-role permission tests or
production acceptance. No reminder was scheduled or email sent.

## Readback Results

Every passing operation was checked through a fresh get_item, get_list_items,
get_item_comments, or get_list call rather than its mutation response alone.

| Check | Result |
| --- | --- |
| priority on creation | FAIL: requested true, stored field absent |
| add and update note | PASS |
| reorder notes | PASS |
| complete note promotes parent | PASS |
| own item comment create and edit | PASS |
| delete own item comment | PASS |
| move item | PASS |
| reorder items | PASS |
| archive item and includeArchived | PASS |
| priority on update | PASS |
| restore item and delete note | PASS |
| archive list | PASS |
| restore list | PASS |

The note status change promoted the parent from new to in-progress, as documented.
Moving the task removed it from the source and retained its two notes in the
destination. Archived items disappeared from the default list response and remained
visible with includeArchived=true. Priority PATCH persisted successfully.

## Priority Creation Finding

Creating the first task with isPriority=true returned success but omitted that
field from both the creation response and fresh get_item. This is distinct from
the working create-then-priority-PATCH workflow tested previously.

The API create_item handler accepts ItemCreate.isPriority but omitted it from the
document it inserts. Fix [PR #13](https://github.com/mgoettel13/lister-api/pull/13),
commit 66b6fac, copies the requested value before existing reminder handling.
Standard/notebook reminder auto-priority and project non-auto-priority remain
unchanged. Explicit priority is preserved for all three list types.

The new route-level regression matrix initially had 4 failures and 14 passes.
After the fix, 37 focused tests passed across project/list creation, item export,
and assistant actions. Both inserted state and the returned readback are asserted,
with exactly one insert. Dummy non-production S3/AWS settings were required solely
for local imports. No production secrets or API deployment was used for these tests.

PR #13 targets staging and is independent of export PR #12 and the other agent's
two shared-comment fixes. Neither PR was merged or deployed by this run. Following
deployment, repeat create with isPriority=true, get_item, and get_priority_items
on a disposable fixture before marking the live defect fixed.

## Cleanup And Limits

Deleted source list 6aa1392f2ec7b350b4300123 and destination list
6aa139312ec7b350b4300124. Fresh reads of both tasks,
6aa139342ec7b350b4300127 and 6aa139872ec7b350b430012a, returned 404.

No unrelated content, sharing grants, or account settings changed. These checks
do not establish production behavior, outbound delivery, all permission families,
natural-language agent selection, or every optional creation field. Publisher
identity verification and approved reviewer access remain separate submission gates.

