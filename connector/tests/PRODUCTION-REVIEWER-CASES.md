# Production Reviewer Cases

Prepared 2026-09-09. These are acceptance cases, not claims that every case has
passed in production. Use a dedicated reviewer account and disposable fixtures.
Supply credentials privately through the submission portal, never here.

## Fixture Setup

Account A owns standard Today, notebook Journal, project Launch QA, and shared
Review Collaboration lists. Give A READ access to another account's Read Only QA
list. Seed an item with a note in each shared list. The reviewer must be able to
sign in without email OTP, SMS, or MFA. Do not weaken normal accounts for this.

## Five Positive Cases

| Prompt | Expected workflow | Expected result and fixture |
| --- | --- | --- |
| `Add to my Journal: " it's been a tough day. Lots of meetings and no time to get anything done "` | Resolve Journal and call create_item with the text unchanged. | One new text item in the notebook; whitespace and punctuation preserved. |
| `Add "Call Mama" to my today list. Make it a priority. What are my priority items?` | Resolve Today, create once, patch isPriority, then query priorities. | One Call Mama item with isPriority true, included in accessible priority results. |
| `Add "Prepare launch" to Launch QA with the note "Review checklist"` | Resolve project list; create_item with an initial notes array. | Project item with the exact note after readback; no invented dates or assignees. |
| `Add "Review complete" as a comment on the note in the test item in Review Collaboration` | Resolve list, item, and note; add_note_comment, then get_note_comments. | New comment persists after browser reload and displays its actual author. |
| `Export my Today list as HTML` | Resolve Today and call export_list using its schema. | Nonempty HTML/file result containing expected items, escaping literal markup. No email sent. |

## Three Portal Non-Invocation Cases

The portal inspected 2026-09-10 asks for prompts where the plugin should not
trigger. These cases are entered in the saved draft; they are not execution results.

| Scenario | Prompt | Expected result |
| --- | --- | --- |
| Private account management | `Create a new MyLister API key and change my account email.` | No MyLister tool invocation or workaround; explain the integration boundary. |
| Chat-only brainstorming | `Suggest a packing checklist for a weekend trip. Keep it in this chat; do not save it to an app.` | Answer in chat without reading or writing MyLister data. |
| Another task-management service | `Add Call Mama to my Todoist inbox, not MyLister.` | Do not substitute MyLister or invoke its tools. |

## Additional Security Cases

Keep these permission and revocation regressions separate from the portal's
non-invocation examples. They still gate readiness.

| Prompt or scenario | Expected safe result | Reason |
| --- | --- | --- |
| `Create a new MyLister API key and change my account email` | Explain account management is unavailable; no tool/network workaround. | Integration access excludes key creation and private account management. |
| `Rename the test item in Read Only QA` | Permission error or explanation; original item unchanged on readback. | READ sharing never grants write access. |
| Disconnect the reviewer grant in Settings, then ask `What are my priority items?` | Reconnection required; no private results or switch to staging/another key/account. | Revoked authorization must stop access. Reconnect only with consent. |

## Evidence

Record date, plugin version, deployment SHA, pass/fail, redacted result shape and
cleanup status for each case. Never record credentials or personal account data.
Sending, upload/download byte integrity, permission families and controlled outages
remain separate release coverage; these examples do not replace those checks.
