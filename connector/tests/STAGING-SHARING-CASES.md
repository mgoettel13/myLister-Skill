# Staging Sharing Regression Cases

Run only against staging using two existing authorized accounts. A owns the
disposable project through MCP; B uses the normal authenticated browser.
Do not obtain browser tokens or bypass consent. Do not send emails.

## Fixture

Create a uniquely named `Plugin Unattended QA <timestamp>` project with one text
item containing `QA export literal <b>not markup</b> & quotes "safe"`, one initial
note, and an A-authored note comment. Use `fixtures/qa-note.csv` for note upload.
Record returned IDs. Never reuse unrelated account content as a test fixture.

## Cases

| Case | Steps | Expected / 2026-09-07 result |
| --- | --- | --- |
| Read-only UI | A shares with B as read; B opens item detail. | No item/note/file-edit controls. Comment dialog has no composer. Passed. |
| Editable UI | A changes B to edit; B reloads detail. | Item/note/file-edit controls appear. Passed. |
| Note attachment | A uploads the CSV to the note; B reloads. | API reports filename, text/csv and 28 bytes; note displays file link. Passed for metadata/display, not downloaded-byte integrity. |
| HTML escaping | Export light and dark HTML through MCP. | Item markup, ampersand and quotes are escaped; note text is present. Passed for response content, not rendered/printed output. |
| Cross-author comment | B edits A's note comment through its dialog; A reads comments through MCP. | Current behavior permits the edit but still attributes the changed text to A. Policy/attribution risk; not a passing author-isolation test. |
| Stale downgraded write | While B's edit form is open, A changes B to read. B saves a unique marker. A reads comments. | Marker must not persist. Passed. UI closes editor without showing an error: failed-save UX defect. |
| Stale revoked write | A removes B while B's existing dialog is open. B edits and saves a second unique marker. A reads comments. | Marker must not persist. Passed. Same silent failed-save behavior. |
| Revoked read | B reloads item detail after removal. | Item Not Found; no fixture content rendered. Passed. |
| Attachment removal | A deletes the uploaded note attachment; reads item. | Note attachment array is empty. Passed. |
| Fixture cleanup | A deletes the disposable project; reads its item. | API returns 404. Passed. |

These browser rejection checks prove that writes did not persist. They do not
assert an HTTP status that was not captured. They do not cover every public MCP
write family using a second OAuth connection.

## Findings To Resolve

1. Decide whether editors may rewrite other authors' comments. If yes, show who
   edited the comment; if no, enforce author ownership server-side and hide controls.
   Public `routers/public_handlers/items.py:update_note_comment` checks EDIT list
   permission but not comment authorship. A live UI edit confirmed the behavior.
2. Preserve the draft and show permission/network errors after a failed save.
   `src/lib/stores/useItemStore.ts:updateNoteComment` catches errors without
   propagating failure; `CommentsThreadModal.tsx:handleSaveEdit` consequently clears
   edit state after the resolved callback. Verify retry and draft preservation.

Sending, disruptive outage tests, and new OAuth grants remain approval-dependent.
