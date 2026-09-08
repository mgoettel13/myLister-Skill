# Two Remaining Comment Findings

These are distinct from the previously fixed collaborator-profile disclosure and
note-comment reload defects. Those fixes were promoted in API da1498f and UI cc49a6c.

## 1. Cross-author edits retain misleading authorship

Reproduced with two staging accounts: A owns a project and writes a note comment;
B has EDIT access. In B's item detail, open the note's Comments dialog, select
Edit comment on A's comment, change the text and Save. Read it back as A through
GET /v1/items/{item_id}/notes/{note_id}/comments. B's text persists, but createdBy
and the displayed author remain A. This permits misattribution within a shared list,
not access to an unrelated private list.

API: routers/public_handlers/items.py, update_note_comment. It requires list EDIT
permission but does not check comment authorship. UI: CommentsThreadModal.tsx
exposes edit controls to editors for other people's comments.

Recommended policy, subject to owner decision: only the author can edit a comment.
Decide administrator deletion/moderation separately; do not silently prohibit it.
Alternatively, retain collaborative edits but record/display last editor and edited
status. Preserve the original author rather than rewriting createdBy.

Acceptance coverage: author edit succeeds; unrelated editor cannot edit under an
author-only policy; read-only and removed members cannot edit; no forbidden mutation
persists; controls match the policy. Audit item-comment update/delete endpoints too,
but do not claim their behavior was established by this note-comment reproduction.

## 2. Failed saves silently discard the comment edit form

As B with EDIT permission, open a note-comment edit form. A downgrades B to READ
without B reloading. B changes the draft and saves. The update does not persist,
but the modal exits edit mode without a visible error. Repeated after complete
sharing removal with the same result.

UI: src/lib/stores/useItemStore.ts, updateNoteComment catches/logs failures without
rethrowing; unsuccessful responses can also resolve normally. In
src/components/items/CommentsThreadModal.tsx, handleSaveEdit awaits this callback
and then clears editingId/editingContent as though it succeeded.

Required fix: propagate failed updates, catch them in the modal, display an actionable
error and preserve the draft. Clear the draft only after confirmed success. Ensure
the saving state resets and retry works. Handle permissions, network errors and
unsuccessful API response envelopes. Check other comment mutations for the same
pattern without changing unrelated state behavior.

Acceptance tests: 403/404, network failure and success:false preserve draft/show error;
success exits editing; retry succeeds; reload/readback confirms no forbidden write.

Use fresh synthetic staging fixtures. Do not modify production user comments.
Previous reproduction fixture was deleted. Full steps: tests/STAGING-SHARING-CASES.md.
