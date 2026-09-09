import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotationsFor, reviewedAnnotations } from './tool-annotations.js';
import { operations } from './tools.js';

test('every exposed operation has a reviewed annotation and no obsolete entries remain', () => {
  assert.deepEqual(Object.keys(reviewedAnnotations).sort(), [...operations.keys()].sort());
  for (const [name, { tool }] of operations) {
    assert.deepEqual(tool.annotations, annotationsFor(name));
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${name}: ${hint}`);
    }
    if (tool.annotations?.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.throws(() => annotationsFor('new_unreviewed_tool'), /requires annotation review/);
  assert.throws(() => annotationsFor('constructor'), /requires annotation review/);
});

test('download exports are read-only while email exports are irreversible external writes', () => {
  for (const name of ['export_item', 'export_list', 'export_priority_items']) {
    assert.equal(operations.get(name)?.method, 'POST');
    assert.deepEqual(annotationsFor(name), {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    assert.deepEqual(annotationsFor(`${name}_email`), {
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    });
  }
});

test('additive private content does not inherit destructive or public-internet hints', () => {
  for (const name of ['create_list', 'add_item_note', 'add_item_comment', 'add_note_comment', 'upload_item_attachment', 'upload_note_attachment']) {
    assert.deepEqual(annotationsFor(name), {
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
  }
});

test('optional reminder, transcription, replacement and sharing effects are not hidden', () => {
  for (const name of ['create_item', 'update_item', 'upload_voice', 'share_list_with_user', 'update_user_permission']) {
    const a = annotationsFor(name);
    assert.equal(a.readOnlyHint, false);
    assert.equal(a.destructiveHint, true);
    assert.equal(a.openWorldHint, true);
    assert.equal(a.idempotentHint, false);
  }
  assert.equal(annotationsFor('upload_image').destructiveHint, true);
  assert.equal(annotationsFor('upload_image').idempotentHint, false);
  for (const name of ['delete_list', 'delete_item', 'remove_user_from_list', 'delete_note_comment']) {
    assert.equal(annotationsFor(name).destructiveHint, true);
    assert.equal(annotationsFor(name).idempotentHint, true);
  }
  const copy = annotationsFor('get_item');
  copy.readOnlyHint = false;
  assert.equal(annotationsFor('get_item').readOnlyHint, true);
});
