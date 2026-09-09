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
| Shared-note comment / browser reload | Not exercised during this run. | PENDING |
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
