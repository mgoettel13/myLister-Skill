import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

const read: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const append: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const change: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const remove: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const external: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// Reviewed against public API da1498f. Optional arguments count: item reminders can
// send notifications, voice can use external transcription, and image upload replaces media.
// See TOOL-ANNOTATIONS.md for the review rationale. New tools require explicit review.
export const reviewedAnnotations: Readonly<Record<string, ToolAnnotations>> = {
  search: read,
  upload_image: change,
  upload_item_attachment: append,
  delete_item_attachment: remove,
  upload_note_attachment: append,
  delete_note_attachment: remove,
  get_file_url_query: read,
  get_file: read,
  stream_file: read,
  get_file_url: read,
  upload_voice: external,
  create_list: append,
  get_user_lists: read,
  create_default_lists_endpoint: { ...append, idempotentHint: true },
  get_lists_summary: read,
  get_home_bootstrap: read,
  get_mobile_home_bootstrap: read,
  reorder_lists: change,
  get_list: read,
  update_list: change,
  delete_list: remove,
  set_list_pin: change,
  share_list_with_user: external,
  get_list_users: read,
  update_user_permission: external,
  remove_user_from_list: remove,
  archive_list: change,
  create_item: external,
  get_list_items: read,
  reorder_items: change,
  move_completed_items: change,
  get_priority_items: read,
  get_item: read,
  update_item: external,
  delete_item: remove,
  move_item: change,
  delete_item_image: remove,
  add_item_note: append,
  update_item_note: change,
  delete_item_note: remove,
  reorder_notes: change,
  update_note_status: change,
  add_item_comment: append,
  get_item_comments: read,
  update_item_comment: change,
  delete_item_comment: remove,
  add_note_comment: append,
  get_note_comments: read,
  update_note_comment: change,
  delete_note_comment: remove,
  export_list: read,
  export_list_email: external,
  export_priority_items: read,
  export_priority_items_email: external,
  export_item: read,
  export_item_email: external,
  health_check: read,
  version: read,
};

export function annotationsFor(name: string): ToolAnnotations {
  if (!Object.hasOwn(reviewedAnnotations, name)) {
    throw new Error(`Tool requires annotation review: ${name}`);
  }
  return { ...reviewedAnnotations[name] };
}
