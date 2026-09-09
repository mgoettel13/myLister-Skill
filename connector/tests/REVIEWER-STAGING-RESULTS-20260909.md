# Staging Reviewer Workflow Results

Executed 2026-09-09, 10:33-10:38 UTC through the installed staging MCP plugin.
These are direct tool workflow tests, not a production reviewer-account run or
an independent natural-language agent evaluation. Production data was unchanged.

Environment: staging plugin `0.1.0-staging.1`, connector runtime `2e2afcf`.
Public API version reported deployment `bf3e9ad5-0531-4adc-b22c-ec04e08652ba`;
its commit metadata was `local`, so that response does not establish a Git SHA.

## Results

| Case | Evidence | Result |
| --- | --- | --- |
| Journal entry | Created in a disposable notebook; fresh get_item returned all 74 characters, including leading/trailing spaces, exactly unchanged. | PASS |
| Call Mama / priority | Created once in a disposable standard list, patched only isPriority, queried priorities, and read the list back. Exactly one item remained, with the exact content and isPriority true; its ID appeared in priority results. | PASS |
| Project with initial note | Created Prepare launch with notes containing Review checklist. Fresh get_item returned exactly that note. No project dates or assignee IDs were sent; the API defaulted the assignee to the creator. | PASS |
| Shared-note comment / browser reload | Follow-up at 10:43 UTC: comment created through MCP and read through get_note_comments; second account saw the exact text and author before and after full browser reload. Read-only note dialog offered no composer or edit controls. | PASS in staging |
| HTML export | Newly created list with description null returned HTTP 500. Adding a description to the same fixture made the HTML export return 12,401 characters including Call Mama. No browser/print rendering or email delivery was tested. | FAIL for nullable description |

The three negative reviewer cases remain separate gates. This run did not revoke
the installed account grant, change account settings, or send emails.

## HTML Export Finding And Fix

Live logs for the above public API deployment correlate the fixture export with
`AttributeError: 'NoneType' object has no attribute 'replace'` at
`services/export_service.py:981`, where the list description is passed to
`html.escape`. The explicit-null description is normal output of create_list
when the caller omits that optional field.

API fix: [PR #12](https://github.com/mgoettel13/lister-api/pull/12), commit
`3752ebd`, branch `codex/export-null-description`, based on staging `9168d68`.
Three render paths now normalize an absent/null description to an empty string
before escaping it. This also covers the equivalent email and priority paths.
No API branch was merged or deployed by this test run.

Regression command:

```text
python -m pytest tests/test_export_nullable_description.py tests/test_email_export_rendering.py tests/test_item_export.py -q
```

Before the fix, the new matrix had 16 failures and 48 passes; the failures matched
the live exception. After the fix, all 70 focused tests passed. The matrix covers
missing/null/empty/markup descriptions, standard/notebook/project types,
light/dark themes, and download/email rendering. Email rendering tests do not
send mail or demonstrate delivery. Production impact has not been reproduced.

After merge/deployment, repeat export on a newly created list with its description
omitted. Verify both themes and actual rendered output before closing the finding.
Do not silently edit users' descriptions as an export workaround.

## Cleanup

All three lists created by this run were deleted successfully:

- Notebook: `6aa135f42ec7b350b4300115`
- Standard: `6aa136042ec7b350b4300116`
- Project: `6aa136062ec7b350b4300117`

Fresh reads of the respective item IDs `6aa136082ec7b350b4300118`,
`6aa136162ec7b350b4300119`, and `6aa136182ec7b350b430011c` all returned safe 404
responses. Older fixtures, staging grants, and production content were untouched.

## Shared-Comment Follow-Up

Using the same installed staging MCP account, created project
`6aa138492ec7b350b430011d`, item `6aa1384c2ec7b350b4300120`, and embedded note
`6aa1384c2ec7b350b430011f`.
The authorized second account was verified in the normal browser and shared-list
user response before testing. Only this disposable list was shared with READ access.

MCP added comment `6aa138512ec7b350b4300122` containing `Review complete`.
Fresh get_note_comments returned the exact text and creator. The second account's
note-comments dialog showed the same text and actual creator name, both before and
after a full page reload and reopening the dialog. No `Someone` placeholder was
shown. There were no note-comment edit or composer controls for the READ account.
This is UI visibility/persistence evidence, not exhaustive API write-denial coverage.

Browser version metadata reported private API deployment
`0c8ca057-b750-4ccf-a59e-035d69e591f2` and local commit metadata; no source SHA is
inferred from that string. This does not resolve the separate cross-author editing
and failed-save-draft findings.

Cleanup removed the second account's access; get_list_users then contained only
the owner. Deleted the project and confirmed get_item returned 404. Both installed
grants were preserved. No message or email was sent.
