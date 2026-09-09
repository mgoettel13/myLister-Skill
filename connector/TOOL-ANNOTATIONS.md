# Tool Annotation Review

Reviewed 2026-09-09 against public API commit `da1498f` and the pinned OpenAPI
contract. Live production paths and component schemas match the pinned contract.
All 58 tools have explicit entries in `src/tool-annotations.ts`; additions fail
closed until reviewed. These are client hints, not authorization enforcement.

## Rationale

| Class | Tools / behavior | Hints |
| --- | --- | --- |
| Private reads | Search, list/item/note-comment reads, bootstrap, authorized file retrieval/signing, health/version | Read-only, non-destructive, bounded private account. |
| Download exports | export_item, export_list, export_priority_items | Read-only despite POST: assemble and format existing data into a response; no send or persisted export job. |
| Additive private writes | create_list, notes/comments, generic item/note attachments | Non-read-only, non-destructive, bounded private data. Retrying can duplicate content. |
| Default setup | create_default_lists_endpoint | Additive and idempotent: skips existing default lists. |
| Replacement / ordering | Updates, archive/pin/order/move and upload_image | Destructive means existing state can be overwritten, even when an edit is reversible. Image upload can delete a replaced image; moves can remove project metadata. |
| Delete / revoke | All delete tools and remove_user_from_list | Destructive. Repeating cannot remove additional entities with the same IDs; subsequent not-found errors do not make the operation non-idempotent. |
| Sharing grants | share_list_with_user, update_user_permission | External and destructive: can disclose data to another account or change/reduce access. An already-disclosed copy cannot be recalled. |
| Item creation/update | create_item, update_item | External and destructive because optional reminders schedule push/email delivery. Tool-wide hints must cover those arguments, not only plain-text task creation. Repeating a reminder update can re-arm delivery. |
| Voice upload | upload_voice | Can overwrite item voice metadata and transmit audio for external transcription. Not idempotent; repeated calls store another file and may repeat provider processing. |
| Email exports | All export_*_email tools | External, destructive, non-idempotent: sends cannot be recalled; retry can send duplicate emails. |

Ordinary shared comments remain bounded to existing authorized collaborators, not
public posts or arbitrary recipients. Generic private storage remains bounded even
though hosted externally. Incidental server telemetry is not the tool's user-facing
purpose. Mutation idempotence is conservative where handlers update timestamps,
record usage/change events, or depend on current state; it is not inferred from PUT.

## Evidence And Recheck

Source review: `routers/public_handlers/{lists,items,files,export}.py`, including
image replacement cleanup, voice transcription, reminder scheduling and email
delivery; `services/reminder_service.py` confirms push/email effects.
Connector annotation tests cover all tool names and key semantic distinctions.
They do not replace deployed metadata inspection or permission enforcement tests.

Before submission, scan the deployed server and compare annotations with this
table. Refresh this review after API handler changes, even when OpenAPI is unchanged.

References: [OpenAI submission annotations](https://developers.openai.com/plugins/deploy/submission),
[MCP ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).
