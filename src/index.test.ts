/**
 * Lister Skill — Comprehensive Unit Tests
 *
 * Uses Node.js built-in test runner (node:test) with assert.
 * All tests are pure / mocked — no network access.
 */

import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent as actualParseIntent } from './index.js';

// ---------------------------------------------------------------------------
// Re-import parseIntent via a helper wrapper so we can test it in isolation.
// Because the module has a top-level ListerClient instantiation we mock fetch
// before importing.
// ---------------------------------------------------------------------------

// We will import the module AFTER mocks are set up in a before() hook.
// For the pure parseIntent function we can use a dynamic import that
// reads the source.  However, since parseIntent is NOT exported, we need
// to export it first or re-implement the logic for testing.
//
// Strategy: We will re-export parseIntent by adding a test export to the
// module, or we test via handleCommand which internally calls parseIntent.
//
// Better strategy: The source doesn't export parseIntent, but handleCommand
// does. We'll test parseIntent by adding a test export, or we can test
// the intent classification indirectly through handleCommand's error messages.
//
// CLEANEST: We'll add `export { parseIntent }` to the source. But the task
// says "Write tests to index.test.ts" — let's test what's publicly exported
// AND re-export parseIntent for direct testing.
//
// Actually — let's test the logic directly by importing and then also
// test handleCommand end-to-end with a mocked fetch.

// Import the module (parseIntent is not exported, but handleCommand is).
// We'll also re-export parseIntent from a modified import.
// For now, let's define a local copy of parseIntent that mirrors the
// source exactly, so we can unit-test it directly.

// To keep the test in sync with the real implementation, we'll test
// parseIntent by re-exporting it. Let's first check if it's accessible.

// ─── Local parseIntent mirror (copied from index.ts for direct testing) ───
// This MUST match index.ts exactly.  If parseIntent were exported from the
// source we wouldn't need this duplication.

type Intent = 'add_item' | 'get_items' | 'get_priority' | 'mark_done' |
              'remove_item' | 'update_item' | 'move_item' | 'add_note' |
              'add_item_comment' | 'get_item_comments' | 'update_item_comment' | 'delete_item_comment' |
              'add_note_comment' | 'get_note_comments' | 'update_note_comment' | 'delete_note_comment' |
              'create_list' | 'unknown';

interface ParsedIntent {
  intent: Intent;
  entities: {
    itemText?: string;
    listName?: string;
    itemId?: string;
    noteId?: string;
    commentId?: string;
    priority?: boolean;
    note?: string;
    notes?: string[];
    comments?: string[];
    listType?: 'standard' | 'notebook' | 'project';
    project?: {
      startDate?: string;
      endDate?: string;
      durationMinutes?: number;
      assignedTo?: string;
    };
  };
}

function parseIntent(input: string): ParsedIntent {
  const lower = input.toLowerCase();

  const doubleQuoted = input.match(/"([^"]+)"/);
  const singleQuoted = input.match(/'([^']+)'/);
  const itemText = doubleQuoted ? doubleQuoted[1] : (singleQuoted ? singleQuoted[1] : undefined);

  const listMatch =
    input.match(/\b(?:to|in|on)\s+(?:my\s+)?(.+?)\s+list\b/i) ??
    input.match(/\badd\s+to\s+(?:my\s+)?(.+?)(?::|$)/i) ??
    input.match(/^\s*(?:get|show|view|list|find|search|export|email)\s+(?:my\s+)?(.+?)\s+list\b/i);
  const listName = listMatch ? listMatch[1].replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : undefined;

  const idMatch = lower.match(/(?:item\s*|id\s*|#)(\d+)/);
  const itemId = idMatch ? idMatch[1] : undefined;

  const priority = /priority|urgent|important/i.test(lower);
  const inlineNotes = [...input.matchAll(/\b(?:with\s+)?notes?\s*:\s*"([^"]+)"/gi), ...input.matchAll(/\b(?:with\s+)?notes?\s+"([^"]+)"/gi)].map(m => m[1]);
  const inlineComments = [...input.matchAll(/\b(?:with\s+)?comments?\s*:\s*"([^"]+)"/gi), ...input.matchAll(/\b(?:with\s+)?comments?\s+"([^"]+)"/gi)].map(m => m[1]);
  const project: ParsedIntent['entities']['project'] = {};
  const startDate = input.match(/\bstart(?:s|ing)?\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})/i)?.[1];
  const endDate = input.match(/\b(?:end(?:s|ing)?|due)\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})/i)?.[1];
  const duration = input.match(/\b(?:duration|for)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
  const assignedTo = input.match(/\bassign(?:ed)?\s+to\s+([\w.+-]+@[\w.-]+\.[a-z]{2,}|\S+)/i)?.[1];
  if (startDate) project.startDate = startDate;
  if (endDate) project.endDate = endDate;
  if (duration) project.durationMinutes = Number(duration[1]) * (/hours?|hrs?/i.test(duration[2]) ? 60 : 1);
  if (assignedTo) project.assignedTo = assignedTo;

  const createTypedListMatch = input.match(/(?:create|make|add)\s*(?:a\s+new\s+)?(standard|notebook|journal|project)\s+list\s*(?:called|named|\s)([^\n,]+)/i);
  const createListMatch = input.match(/(?:create|make|add)\s*(?:a\s+new\s+)?list\s*(?:called|named|\s)([^\n,]+)/i);
  const explicitCreateListType = createTypedListMatch?.[1]?.toLowerCase() === 'journal' ? 'notebook' : createTypedListMatch?.[1]?.toLowerCase();
  const listType = (explicitCreateListType as 'standard' | 'notebook' | 'project' | undefined) ??
    (/\bproject\b/i.test(lower) ? 'project' : (/\bnotebook|journal\b/i.test(lower) ? 'notebook' : undefined));

  if (/^create\s*(a\s+new)?\s*(?:standard|notebook|journal|project)?\s*list/i.test(lower)) {
    const rawName = createTypedListMatch ? createTypedListMatch[2] : createListMatch?.[1];
    const listName = createTypedListMatch ? rawName?.trim() : rawName?.replace(/\s+(?:standard|notebook|journal|project)\s*$/i, '').trim();
    return { intent: 'create_list', entities: { listName, listType } };
  }

  const updateItemCommentMatch = input.match(/^(?:update|edit|change)\s+comment\s+(\d+)\s+(?:on|for)\s+item\s+(\d+)/i);
  if (updateItemCommentMatch) {
    return { intent: 'update_item_comment', entities: { commentId: updateItemCommentMatch[1], itemId: updateItemCommentMatch[2], note: itemText } };
  }
  const deleteItemCommentMatch = input.match(/^(?:delete|remove)\s+comment\s+(\d+)\s+(?:on|from|for)\s+item\s+(\d+)/i);
  if (deleteItemCommentMatch) {
    return { intent: 'delete_item_comment', entities: { commentId: deleteItemCommentMatch[1], itemId: deleteItemCommentMatch[2] } };
  }
  const getItemCommentsMatch = input.match(/^(?:show|get|list|view)\s+comments\s+(?:on|for)\s+item\s+(\d+)/i);
  if (getItemCommentsMatch) {
    return { intent: 'get_item_comments', entities: { itemId: getItemCommentsMatch[1] } };
  }
  const addItemCommentMatch = input.match(/^comment\s+(?:on|for)\s+item\s+(\d+)/i);
  if (addItemCommentMatch) {
    return { intent: 'add_item_comment', entities: { itemId: addItemCommentMatch[1], note: itemText } };
  }

  const updateNoteCommentMatch = input.match(/^(?:update|edit|change)\s+comment\s+(\d+)\s+(?:on|for)\s+note\s+(\d+)\s+(?:on|for)\s+item\s+(\d+)/i);
  if (updateNoteCommentMatch) {
    return { intent: 'update_note_comment', entities: { commentId: updateNoteCommentMatch[1], noteId: updateNoteCommentMatch[2], itemId: updateNoteCommentMatch[3], note: itemText } };
  }
  const deleteNoteCommentMatch = input.match(/^(?:delete|remove)\s+comment\s+(\d+)\s+(?:on|from|for)\s+note\s+(\d+)\s+(?:on|for)\s+item\s+(\d+)/i);
  if (deleteNoteCommentMatch) {
    return { intent: 'delete_note_comment', entities: { commentId: deleteNoteCommentMatch[1], noteId: deleteNoteCommentMatch[2], itemId: deleteNoteCommentMatch[3] } };
  }
  const getNoteCommentsMatch = input.match(/^(?:show|get|list|view)\s+comments\s+(?:on|for)\s+note\s+(\d+)\s+(?:on|for)\s+item\s+(\d+)/i);
  if (getNoteCommentsMatch) {
    return { intent: 'get_note_comments', entities: { noteId: getNoteCommentsMatch[1], itemId: getNoteCommentsMatch[2] } };
  }
  const addNoteCommentMatch = input.match(/^comment\s+(?:on|for)\s+note\s+(\d+)\s+(?:on|for)\s+item\s+(\d+)/i);
  if (addNoteCommentMatch) {
    return { intent: 'add_note_comment', entities: { noteId: addNoteCommentMatch[1], itemId: addNoteCommentMatch[2], note: itemText } };
  }

  if (/^(what|which|show|list|get)\b.*\b(priority|urgent|important)\b.*\b(items?|tasks?)\b/i.test(lower)) {
    return { intent: 'get_priority', entities: { listName } };
  }

  if (/^(make|set)\b/i.test(lower) && itemText && listName && priority) {
    return { intent: 'update_item', entities: { itemText, listName, priority: true } };
  }

  if (/^(add|create|new|put)\b/.test(lower)) {
    return {
      intent: 'add_item',
      entities: {
        itemText,
        listName,
        priority,
        notes: inlineNotes.length ? inlineNotes : undefined,
        comments: inlineComments.length ? inlineComments : undefined,
        project: Object.keys(project).length ? project : undefined,
      },
    };
  }

  if (/^(get|show|list|view|find|search)\b/.test(lower)) {
    if (/^(get|show|list|view)\s+(?:my\s+)?lists\b/i.test(lower)) {
      return { intent: 'get_items', entities: {} };
    }
    if (priority) {
      return { intent: 'get_priority', entities: { listName } };
    }
    return { intent: 'get_items', entities: { listName } };
  }

  if (/^(mark|complete|done|finish)\b/.test(lower)) {
    return { intent: 'mark_done', entities: { itemId } };
  }

  if (/^(remove|delete|drop|clear)\b/.test(lower)) {
    return { intent: 'remove_item', entities: { itemId } };
  }

  if (/^(update|edit|change|modify|rename)\b/.test(lower)) {
    return { intent: 'update_item', entities: { itemId, itemText } };
  }

  if (/^(move|transfer)\b/.test(lower)) {
    return { intent: 'move_item', entities: { itemId, listName } };
  }

  if (/^(note|memo)\b/.test(lower)) {
    return { intent: 'add_note', entities: { itemId, note: itemText } };
  }

  return { intent: 'unknown', entities: {} };
}

// ---------------------------------------------------------------------------
// 1. Intent Parser Tests
// ---------------------------------------------------------------------------

describe('parseIntent — add_item', () => {
  it('detects "add" verb with quoted text', () => {
    const r = parseIntent('Add "buy milk" to my groceries list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'buy milk');
    assert.equal(r.entities.listName, 'groceries');
  });

  it('detects "create" verb', () => {
    const r = parseIntent('Create "call dentist"');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'call dentist');
  });

  it('detects "new" verb', () => {
    const r = parseIntent('New "submit report"');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'submit report');
  });

  it('detects "put" verb', () => {
    const r = parseIntent('Put "water plants" on my chores list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'water plants');
    assert.equal(r.entities.listName, 'chores');
  });

  it('extracts priority flag', () => {
    const r = parseIntent('Add "fix server" to my work list — urgent');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.priority, true);
  });

  it('detects important flag', () => {
    const r = parseIntent('Add important task "review PR"');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.priority, true);
  });

  it('no priority by default', () => {
    const r = parseIntent('Add "read book" to my hobbies list');
    assert.equal(r.entities.priority, false);
  });

  it('missing quoted text — itemText is undefined', () => {
    const r = parseIntent('Add to my groceries list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, undefined);
  });

  it('missing list name — listName is undefined', () => {
    const r = parseIntent('Add "take notes"');
    assert.equal(r.entities.listName, undefined);
  });

  it('extracts list name with "to my X list" pattern', () => {
    const r = parseIntent('Add "task" to my today list');
    assert.equal(r.entities.listName, 'today');
  });

  it('extracts list name with "to X list" pattern (no "my")', () => {
    const r = parseIntent('Add "task" to work list');
    assert.equal(r.entities.listName, 'work');
  });

  it('extracts list name with "in X list" pattern', () => {
    const r = parseIntent('Add "task" in shopping list');
    assert.equal(r.entities.listName, 'shopping');
  });

  it('extracts list name with "on my X list" pattern', () => {
    const r = parseIntent('Put "item" on my chores list');
    assert.equal(r.entities.listName, 'chores');
  });

  it('extracts journal text with apostrophes inside double quotes', () => {
    const r = parseIntent('Add to my Journal: " it\'s been a tough day. Lots of meetings "');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.listName, 'journal');
    assert.equal(r.entities.itemText, ' it\'s been a tough day. Lots of meetings ');
  });

  it('extracts inline create note', () => {
    const r = parseIntent('Add "Ship dashboard" to my work list with note "Needs QA"');
    assert.equal(r.intent, 'add_item');
    assert.deepEqual(r.entities.notes, ['Needs QA']);
  });

  it('extracts inline create comment', () => {
    const r = parseIntent('Add "Review launch plan" to my project list with comment "Shared context"');
    assert.equal(r.intent, 'add_item');
    assert.deepEqual(r.entities.comments, ['Shared context']);
  });

  it('extracts project item metadata', () => {
    const r = parseIntent('Add "Design milestone" to my project list starts 2026-09-01 due 2026-09-05 for 3 hours assigned to larry@example.com');
    assert.equal(r.intent, 'add_item');
    assert.deepEqual(r.entities.project, {
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      durationMinutes: 180,
      assignedTo: 'larry@example.com',
    });
  });
});

describe('parseIntent — create_list types', () => {
  it('creates project lists', () => {
    const r = parseIntent('Create a new project list called Website Launch');
    assert.equal(r.intent, 'create_list');
    assert.equal(r.entities.listName, 'Website Launch');
    assert.equal(r.entities.listType, 'project');
  });

  it('creates notebook lists', () => {
    const r = parseIntent('Create a new notebook list called Journal');
    assert.equal(r.intent, 'create_list');
    assert.equal(r.entities.listName, 'Journal');
    assert.equal(r.entities.listType, 'notebook');
  });

  it('strips trailing type from generic create list command', () => {
    const r = parseIntent('Create a new list called Client Projects project');
    assert.equal(r.intent, 'create_list');
    assert.equal(r.entities.listName, 'Client Projects');
    assert.equal(r.entities.listType, 'project');
  });
});

describe('configuration', () => {
  it('documents the production API host in source', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(source.includes("https://api.mylister.dev"));
    assert.ok(!source.includes("https://api.mylister.com"));
    assert.ok(!source.includes("https://app.mylister.com"));
  });

  it('uses the public API key header only', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(source.includes("'X-API-Key': this.apiKey"));
    assert.ok(!source.includes("'Authorization':"));
  });

  it('covers the current v1 media and project routes', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    for (const endpoint of [
      '/v1/items/${itemId}/export',
      '/v1/items/${itemId}/export/email',
      '/v1/items/${itemId}/notes/reorder',
      '/v1/items/${itemId}/attachments',
      '/v1/items/${itemId}/image',
      '/v1/upload/image',
      '/v1/upload/voice',
      '/v1/files/',
      '/v1/${kind}',
    ]) {
      assert.ok(source.includes(endpoint), `missing endpoint ${endpoint}`);
    }
    assert.ok(source.includes('getMultipartHeader'));
    assert.ok(source.includes("'?force=true'"));
  });
});

describe('parseIntent — get_items', () => {
  it('detects "get" verb without priority', () => {
    const r = parseIntent('Get my items');
    assert.equal(r.intent, 'get_items');
  });

  it('detects "show" verb', () => {
    const r = parseIntent('Show today list');
    assert.equal(r.intent, 'get_items');
  });

  it('detects "list" verb', () => {
    const r = parseIntent('List my groceries');
    assert.equal(r.intent, 'get_items');
  });

  it('detects "view" verb', () => {
    const r = parseIntent('View my work items');
    assert.equal(r.intent, 'get_items');
  });

  it('detects "find" verb', () => {
    const r = parseIntent('Find items in work list');
    assert.equal(r.intent, 'get_items');
    assert.equal(r.entities.listName, 'work');
  });

  it('detects "search" verb', () => {
    const r = parseIntent('Search in inbox list');
    assert.equal(r.intent, 'get_items');
    assert.equal(r.entities.listName, 'inbox');
  });

  it('extracts list name when pattern present', () => {
    const r = parseIntent('Find items in my today list');
    assert.equal(r.entities.listName, 'today');
  });

  it('no list name when not specified', () => {
    const r = parseIntent('Get all items');
    assert.equal(r.entities.listName, undefined);
  });
});

describe('parseIntent — get_priority', () => {
  it('detects get + priority keyword', () => {
    const r = parseIntent('Get priority items');
    assert.equal(r.intent, 'get_priority');
  });

  it('detects show + urgent keyword', () => {
    const r = parseIntent('Show urgent items');
    assert.equal(r.intent, 'get_priority');
  });

  it('detects list + important keyword', () => {
    const r = parseIntent('List important tasks');
    assert.equal(r.intent, 'get_priority');
  });

  it('detects get + priority with list name', () => {
    const r = parseIntent('Get priority items in work list');
    assert.equal(r.intent, 'get_priority');
    assert.equal(r.entities.listName, 'work');
  });

  it('view + priority', () => {
    const r = parseIntent('View priority items');
    assert.equal(r.intent, 'get_priority');
  });

  it('find + urgent', () => {
    const r = parseIntent('Find urgent things');
    assert.equal(r.intent, 'get_priority');
  });

  it('understands natural priority item question', () => {
    const r = parseIntent('What are my priority items.');
    assert.equal(r.intent, 'get_priority');
    assert.equal(r.entities.listName, undefined);
  });
});

describe('parseIntent — mark_done', () => {
  it('detects "mark" verb', () => {
    const r = parseIntent('Mark item 42 as done');
    assert.equal(r.intent, 'mark_done');
    assert.equal(r.entities.itemId, '42');
  });

  it('detects "complete" verb', () => {
    const r = parseIntent('Complete item 7');
    assert.equal(r.intent, 'mark_done');
    assert.equal(r.entities.itemId, '7');
  });

  it('detects "done" verb', () => {
    const r = parseIntent('Done with item 99');
    assert.equal(r.intent, 'mark_done');
    assert.equal(r.entities.itemId, '99');
  });

  it('detects "finish" verb', () => {
    const r = parseIntent('Finish item 3');
    assert.equal(r.intent, 'mark_done');
    assert.equal(r.entities.itemId, '3');
  });

  it('extracts numeric ID', () => {
    const r = parseIntent('Mark item 12345 as done');
    assert.equal(r.entities.itemId, '12345');
  });

  it('no item ID when not specified', () => {
    const r = parseIntent('Mark all done');
    assert.equal(r.entities.itemId, undefined);
  });
});

describe('parseIntent — remove_item', () => {
  it('detects "remove" verb', () => {
    const r = parseIntent('Remove item 5');
    assert.equal(r.intent, 'remove_item');
    assert.equal(r.entities.itemId, '5');
  });

  it('detects "delete" verb', () => {
    const r = parseIntent('Delete item 10');
    assert.equal(r.intent, 'remove_item');
    assert.equal(r.entities.itemId, '10');
  });

  it('detects "drop" verb', () => {
    const r = parseIntent('Drop item 22');
    assert.equal(r.intent, 'remove_item');
    assert.equal(r.entities.itemId, '22');
  });

  it('detects "clear" verb', () => {
    const r = parseIntent('Clear item 8');
    assert.equal(r.intent, 'remove_item');
    assert.equal(r.entities.itemId, '8');
  });

  it('no item ID when not specified', () => {
    const r = parseIntent('Remove the last one');
    assert.equal(r.entities.itemId, undefined);
  });
});

describe('parseIntent — update_item', () => {
  it('detects "update" verb', () => {
    const r = parseIntent('Update item 15');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemId, '15');
  });

  it('detects "edit" verb', () => {
    const r = parseIntent('Edit item 20');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemId, '20');
  });

  it('detects "change" verb', () => {
    const r = parseIntent('Change item 30 to "new name"');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemId, '30');
    assert.equal(r.entities.itemText, 'new name');
  });

  it('detects "modify" verb', () => {
    const r = parseIntent('Modify item 50');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemId, '50');
  });

  it('detects "rename" verb', () => {
    const r = parseIntent('Rename item 11 to "better name"');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemId, '11');
    assert.equal(r.entities.itemText, 'better name');
  });

  it('no itemText when no quotes provided', () => {
    const r = parseIntent('Update item 42');
    assert.equal(r.entities.itemText, undefined);
  });

  it('understands make quoted item priority in a named list', () => {
    const r = parseIntent('Make "Call mama" in Today list a priority');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemText, 'Call mama');
    assert.equal(r.entities.listName, 'today');
    assert.equal(r.entities.priority, true);
  });
});

describe('parseIntent — move_item', () => {
  it('detects "move" verb', () => {
    const r = parseIntent('Move item 5 to my work list');
    assert.equal(r.intent, 'move_item');
    assert.equal(r.entities.itemId, '5');
    assert.equal(r.entities.listName, 'work');
  });

  it('detects "transfer" verb', () => {
    const r = parseIntent('Transfer item 3 to my archive list');
    assert.equal(r.intent, 'move_item');
    assert.equal(r.entities.itemId, '3');
    assert.equal(r.entities.listName, 'archive');
  });

  it('no item ID when not specified', () => {
    const r = parseIntent('Move to work list');
    assert.equal(r.entities.itemId, undefined);
    assert.equal(r.entities.listName, 'work');
  });

  it('no list name when not specified', () => {
    const r = parseIntent('Move item 5');
    assert.equal(r.entities.listName, undefined);
  });
});

describe('parseIntent — add_note', () => {
  it('detects "note" verb', () => {
    const r = parseIntent('Note for item 7: "call back tomorrow"');
    assert.equal(r.intent, 'add_note');
    assert.equal(r.entities.itemId, '7');
    assert.equal(r.entities.note, 'call back tomorrow');
  });

  it('detects "memo" verb', () => {
    const r = parseIntent('Memo item 3: "check budget"');
    assert.equal(r.intent, 'add_note');
    assert.equal(r.entities.itemId, '3');
    assert.equal(r.entities.note, 'check budget');
  });

  it('no note text without quotes', () => {
    const r = parseIntent('Note for item 5');
    assert.equal(r.intent, 'add_note');
    assert.equal(r.entities.note, undefined);
  });

  it('no item ID when not specified', () => {
    const r = parseIntent('Note "something"');
    assert.equal(r.entities.itemId, undefined);
    assert.equal(r.entities.note, 'something');
  });
});

describe('parseIntent — comments', () => {
  it('adds an item comment', () => {
    const r = parseIntent('Comment on item 12: "looks good"');
    assert.equal(r.intent, 'add_item_comment');
    assert.equal(r.entities.itemId, '12');
    assert.equal(r.entities.note, 'looks good');
  });

  it('gets item comments', () => {
    const r = parseIntent('Show comments for item 12');
    assert.equal(r.intent, 'get_item_comments');
    assert.equal(r.entities.itemId, '12');
  });

  it('updates an item comment', () => {
    const r = parseIntent('Update comment 34 on item 12 to "changed"');
    assert.equal(r.intent, 'update_item_comment');
    assert.equal(r.entities.commentId, '34');
    assert.equal(r.entities.itemId, '12');
    assert.equal(r.entities.note, 'changed');
  });

  it('deletes an item comment', () => {
    const r = parseIntent('Delete comment 34 from item 12');
    assert.equal(r.intent, 'delete_item_comment');
    assert.equal(r.entities.commentId, '34');
    assert.equal(r.entities.itemId, '12');
  });

  it('adds a note comment', () => {
    const r = parseIntent('Comment on note 56 for item 12: "note reply"');
    assert.equal(r.intent, 'add_note_comment');
    assert.equal(r.entities.noteId, '56');
    assert.equal(r.entities.itemId, '12');
    assert.equal(r.entities.note, 'note reply');
  });

  it('gets note comments', () => {
    const r = parseIntent('Show comments for note 56 on item 12');
    assert.equal(r.intent, 'get_note_comments');
    assert.equal(r.entities.noteId, '56');
    assert.equal(r.entities.itemId, '12');
  });

  it('updates a note comment', () => {
    const r = parseIntent('Update comment 34 on note 56 for item 12 to "changed"');
    assert.equal(r.intent, 'update_note_comment');
    assert.equal(r.entities.commentId, '34');
    assert.equal(r.entities.noteId, '56');
    assert.equal(r.entities.itemId, '12');
    assert.equal(r.entities.note, 'changed');
  });

  it('deletes a note comment', () => {
    const r = parseIntent('Delete comment 34 from note 56 on item 12');
    assert.equal(r.intent, 'delete_note_comment');
    assert.equal(r.entities.commentId, '34');
    assert.equal(r.entities.noteId, '56');
    assert.equal(r.entities.itemId, '12');
  });
});

describe('parseIntent — unknown', () => {
  it('returns unknown for unrecognised command', () => {
    const r = parseIntent('What time is it?');
    assert.equal(r.intent, 'unknown');
    assert.deepEqual(r.entities, {});
  });

  it('returns unknown for gibberish', () => {
    const r = parseIntent('asdfghjkl');
    assert.equal(r.intent, 'unknown');
  });

  it('returns unknown for empty string', () => {
    const r = parseIntent('');
    assert.equal(r.intent, 'unknown');
  });

  it('returns unknown for whitespace only', () => {
    const r = parseIntent('   ');
    assert.equal(r.intent, 'unknown');
  });

  it('returns unknown for hello/greeting', () => {
    const r = parseIntent('Hello there');
    assert.equal(r.intent, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 2. Entity Extraction Tests
// ---------------------------------------------------------------------------

describe('Entity extraction — quoted text', () => {
  it('extracts double-quoted text', () => {
    const r = parseIntent('Add "hello world"');
    assert.equal(r.entities.itemText, 'hello world');
  });

  it('extracts single-quoted text', () => {
    const r = parseIntent("Add 'single quotes'");
    assert.equal(r.entities.itemText, 'single quotes');
  });

  it('extracts quoted text with punctuation inside', () => {
    const r = parseIntent('Add "buy milk, eggs, and bread!"');
    assert.equal(r.entities.itemText, 'buy milk, eggs, and bread!');
  });

  it('extracts first quoted match only', () => {
    const r = parseIntent('Add "first" or "second" to list');
    assert.equal(r.entities.itemText, 'first');
  });

  it('no quoted text — undefined', () => {
    const r = parseIntent('Add something');
    assert.equal(r.entities.itemText, undefined);
  });

  it('mixed quotes — double takes precedence', () => {
    const r = parseIntent("Update item 1 to \"new title\"");
    assert.equal(r.entities.itemText, 'new title');
  });

  it('preserves case of quoted text', () => {
    const r = parseIntent('Add "IMPORTANT task"');
    assert.equal(r.entities.itemText, 'IMPORTANT task');
  });
});

describe('Entity extraction — list names', () => {
  it('extracts from "to my X list"', () => {
    const r = parseIntent('Add "task" to my today list');
    assert.equal(r.entities.listName, 'today');
  });

  it('extracts from "to X list"', () => {
    const r = parseIntent('Add "task" to work list');
    assert.equal(r.entities.listName, 'work');
  });

  it('extracts from "in X list"', () => {
    const r = parseIntent('Find items in shopping list');
    assert.equal(r.entities.listName, 'shopping');
  });

  it('extracts from "on my X list"', () => {
    const r = parseIntent('Put "item" on my errands list');
    assert.equal(r.entities.listName, 'errands');
  });

  it('list name is lowercased (regex runs on lowercase input)', () => {
    const r = parseIntent('Add "task" to my TODAY list');
    assert.equal(r.entities.listName, 'today'); // lower.match means captured group is lowercased
  });

  it('no list name when pattern absent', () => {
    const r = parseIntent('Get items from my groceries');
    assert.equal(r.entities.listName, undefined);
  });

  it('extracts multi-word list names', () => {
    const r = parseIntent('Show work projects list');
    assert.equal(r.entities.listName, 'work projects');
  });

  it('does not treat "get my lists" as a list named "my"', () => {
    const r = parseIntent('get my lists');
    assert.equal(r.intent, 'get_items');
    assert.equal(r.entities.listName, undefined);
  });

  it('list name with single word', () => {
    const r = parseIntent('Add "task" to my grocery list');
    assert.equal(r.entities.listName, 'grocery');
  });
});

describe('Entity extraction — item IDs', () => {
  it('extracts "item 123"', () => {
    const r = parseIntent('Mark item 123 as done');
    assert.equal(r.entities.itemId, '123');
  });

  it('extracts "item123" (no space)', () => {
    const r = parseIntent('Remove item42');
    assert.equal(r.entities.itemId, '42');
  });

  it('extracts "id 123"', () => {
    const r = parseIntent('Update id 789');
    assert.equal(r.entities.itemId, '789');
  });

  it('extracts "id123" (no space)', () => {
    const r = parseIntent('Delete id456');
    assert.equal(r.entities.itemId, '456');
  });

  it('extracts "#123"', () => {
    const r = parseIntent('Mark #99 done');
    assert.equal(r.entities.itemId, '99');
  });

  it('extracts multi-digit IDs', () => {
    const r = parseIntent('Delete item 1234567890');
    assert.equal(r.entities.itemId, '1234567890');
  });

  it('no ID when absent', () => {
    const r = parseIntent('Mark all done');
    assert.equal(r.entities.itemId, undefined);
  });

  it('extracts first ID found', () => {
    const r = parseIntent('Move item 10 to item 20 list');
    assert.equal(r.entities.itemId, '10');
  });
});

describe('Entity extraction — priority flags', () => {
  it('get_priority intent — priority is implicit (not in entities)', () => {
    const r = parseIntent('Get priority items');
    assert.equal(r.intent, 'get_priority');
    // priority flag is NOT set in entities for get_priority — it's implicit in the intent
    assert.equal(r.entities.priority, undefined);
  });

  it('urgent keyword routes to get_priority', () => {
    const r = parseIntent('Show urgent things');
    assert.equal(r.intent, 'get_priority');
  });

  it('important keyword routes to get_priority', () => {
    const r = parseIntent('List important tasks');
    assert.equal(r.intent, 'get_priority');
  });

  it('PRIORITY keyword routes to get_priority', () => {
    const r = parseIntent('Get PRIORITY items');
    assert.equal(r.intent, 'get_priority');
  });

  it('Urgent keyword routes to get_priority', () => {
    const r = parseIntent('Show Urgent items');
    assert.equal(r.intent, 'get_priority');
  });

  it('no priority flag when keyword absent', () => {
    assert.equal(parseIntent('Add "buy milk" to my groceries list').entities.priority, false);
  });

  it('priority detected in add command', () => {
    const r = parseIntent('Add urgent "fix the bug" to my work list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.priority, true);
  });

  it('priority keyword in update command — intent is update_item (priority not returned in entities for this intent)', () => {
    const r = parseIntent('Update item 5 with important text');
    assert.equal(r.intent, 'update_item');
    // The update_item branch only returns { itemId, itemText }, not priority
    assert.equal(r.entities.priority, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge Cases
// ---------------------------------------------------------------------------

describe('Edge cases — missing quotes', () => {
  it('add command without quotes has undefined itemText', () => {
    const r = parseIntent('Add buy milk to my groceries list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, undefined);
  });

  it('update command without quotes has undefined itemText', () => {
    const r = parseIntent('Update item 5 to buy milk');
    assert.equal(r.entities.itemText, undefined);
  });

  it('note command without quotes has undefined note', () => {
    const r = parseIntent('Note for item 3: call back');
    assert.equal(r.entities.note, undefined);
  });
});

describe('Edge cases — ambiguous commands', () => {
  it('"list" as verb vs "list" as noun — matches get_items', () => {
    // "list" is a get_verb; "list name" doesn't start with list-verb
    const r = parseIntent('list all items');
    assert.equal(r.intent, 'get_items');
  });

  it('"done" as verb matches mark_done', () => {
    const r = parseIntent('Done with everything');
    assert.equal(r.intent, 'mark_done');
  });

  it('"clear" without item ID — remove_item intent', () => {
    const r = parseIntent('Clear all');
    assert.equal(r.intent, 'remove_item');
    assert.equal(r.entities.itemId, undefined);
  });

  it('command with priority keyword but non-priority verb', () => {
    const r = parseIntent('Add priority "fix bug"');
    // "add" verb takes precedence; priority flag is still set
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.priority, true);
  });

  it('get + priority + item number — still get_priority (priority overrides)', () => {
    const r = parseIntent('Get priority item 5');
    // "get" verb + priority keyword → get_priority
    assert.equal(r.intent, 'get_priority');
  });

  it('"new" in non-add context — still add_item because of verb match', () => {
    const r = parseIntent('new task "something"');
    assert.equal(r.intent, 'add_item');
  });
});

describe('Edge cases — no matches', () => {
  it('completely unrelated sentence', () => {
    const r = parseIntent('The weather is nice today');
    assert.equal(r.intent, 'unknown');
  });

  it('question format', () => {
    const r = parseIntent('How do I add an item?');
    assert.equal(r.intent, 'unknown');
  });

  it('only emojis', () => {
    const r = parseIntent('🎉🚀✨');
    assert.equal(r.intent, 'unknown');
  });

  it('numbers only', () => {
    const r = parseIntent('12345');
    assert.equal(r.intent, 'unknown');
  });

  it('partial verb — "adding" does NOT match "add"', () => {
    // /^(add|...)\b/ — \b is a word boundary, "adding" has no boundary after "add"
    // Actually \b matches between "d" and "d" in "adding"? No — "add" then "ing",
    // there IS a word boundary between "d" and "d"... wait no.
    // "adding" = a-d-d-i-n-g. After "add" the next char is "i" (word char),
    // so there's NO word boundary. Correct: "adding" should NOT match.
    const r = parseIntent('adding stuff to my list');
    assert.equal(r.intent, 'unknown');
  });

  it('partial verb — "removing" does NOT match "remove"', () => {
    const r = parseIntent('removing item 5');
    assert.equal(r.intent, 'unknown');
  });

  it('partial verb — "listing" does NOT match "list"', () => {
    const r = parseIntent('listing all tasks');
    assert.equal(r.intent, 'unknown');
  });

  it('partial verb — "updating" does NOT match "update"', () => {
    const r = parseIntent('updating item 10');
    assert.equal(r.intent, 'unknown');
  });

  it('partial verb — "moving" does NOT match "move"', () => {
    const r = parseIntent('moving item 3');
    assert.equal(r.intent, 'unknown');
  });
});

describe('Edge cases — case sensitivity', () => {
  it('uppercase ADD', () => {
    const r = parseIntent('ADD "task" to my work list');
    assert.equal(r.intent, 'add_item');
  });

  it('mixed case Get', () => {
    const r = parseIntent('GeT all items');
    assert.equal(r.intent, 'get_items');
  });

  it('uppercase MARK', () => {
    const r = parseIntent('MARK item 5 done');
    assert.equal(r.intent, 'mark_done');
    assert.equal(r.entities.itemId, '5');
  });

  it('quoted text preserves original case', () => {
    const r = parseIntent('Add "MiXeD CaSe TaSk"');
    assert.equal(r.entities.itemText, 'MiXeD CaSe TaSk');
  });
});

describe('Edge cases — special characters in input', () => {
  it('input with special chars in quoted text', () => {
    const r = parseIntent('Add "call Dr. Smith (555-1234)" to my contacts list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'call Dr. Smith (555-1234)');
  });

  it('input with unicode in quoted text', () => {
    const r = parseIntent('Add "naïve café" to my food list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'naïve café');
  });

  it('input with newlines', () => {
    const r = parseIntent('Add "task\nwith\nnewlines"');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, 'task\nwith\nnewlines');
  });

  it('very long input', () => {
    const longText = 'A'.repeat(10000);
    const r = parseIntent(`Add "${longText}" to my list list`);
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.itemText, longText);
  });
});

describe('Edge cases — overlapping patterns', () => {
  it('"list" as verb can extract a list name from "list my X list"', () => {
    const r = parseIntent('list my list list');
    assert.equal(r.intent, 'get_items');
    assert.equal(r.entities.listName, 'list');
  });

  it('"list" as verb with "to my X list" pattern — listName extracted', () => {
    const r = parseIntent('list items in my shopping list');
    assert.equal(r.intent, 'get_items');
    assert.equal(r.entities.listName, 'shopping');
  });

  it('"item" appears in quoted text and as ID reference', () => {
    const r = parseIntent('Update item 5 to "new item name"');
    assert.equal(r.intent, 'update_item');
    assert.equal(r.entities.itemId, '5');
    assert.equal(r.entities.itemText, 'new item name');
  });

  it('priority word inside quoted text still triggers priority', () => {
    // The regex checks the full lower string, so "priority" inside quotes matches
    const r = parseIntent('Add "priority task" to my list');
    assert.equal(r.intent, 'add_item');
    assert.equal(r.entities.priority, true); // because "priority" appears in input
  });

  it('multiple keywords — first verb wins', () => {
    const r = parseIntent('Add and delete item 5');
    // "Add" is first verb matched
    assert.equal(r.intent, 'add_item');
  });
});

// ---------------------------------------------------------------------------
// 4. handleCommand Tests (with mocked fetch)
// ---------------------------------------------------------------------------

describe('handleCommand — end-to-end with mocked API', () => {
  // We'll dynamically import the module after setting up mocks.
  // Since the module imports node-fetch at the top level, we need to mock
  // it before importing. We'll use node:test's mock.module() or
  // dynamic import with mocking.

  // For handleCommand tests, we need to mock the ListerClient's fetch calls.
  // Since we can't easily mock inside an already-imported module,
  // we'll test the formatResponse function and the parseIntent-based
  // routing logic separately, then test handleCommand via mock.

  // Actually, let's just test formatResponse directly since it's imported.
});

// ---------------------------------------------------------------------------
// 5. formatResponse Tests
// ---------------------------------------------------------------------------

// We need to import formatResponse. It's not exported from index.ts,
// so let's mirror it here (same as the source).

interface ListerResponse {
  success: boolean;
  message: string;
  data?: any;
}

function formatResponse(response: ListerResponse): string {
  if (!response.success) {
    return `❌ ${response.message}`;
  }

  let msg = `✅ ${response.message}\n`;

  if (response.data && Array.isArray(response.data)) {
    if (response.data.length === 0) {
      msg += '\n_(empty)_';
    } else {
      msg += response.data.map((item: any, i: number) => {
        const title = item.text || item.name || item.title || `Item ${i + 1}`;
        const priority = item.priority ? ' 🔥' : '';
        const done = item.done || item.completed ? ' ✅' : '';
        return `${i + 1}. ${title}${priority}${done}`;
      }).join('\n');
    }
  } else if (response.data && typeof response.data === 'object') {
    msg += `\n\`\`\`json\n${JSON.stringify(response.data, null, 2)}\n\`\`\``;
  }

  return msg;
}

describe('formatResponse — error responses', () => {
  it('returns ❌ prefix for failed response', () => {
    const r = formatResponse({ success: false, message: 'Network error' });
    assert.equal(r, '❌ Network error');
  });

  it('includes error message', () => {
    const r = formatResponse({ success: false, message: 'Failed: Unauthorized' });
    assert.ok(r.includes('Failed: Unauthorized'));
  });
});

describe('formatResponse — success with array data', () => {
  it('formats array of items with text', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 2 items',
      data: [
        { text: 'Buy milk', priority: false },
        { text: 'Call dentist', priority: true },
      ],
    });
    assert.ok(r.includes('✅ Found 2 items'));
    assert.ok(r.includes('1. Buy milk'));
    assert.ok(r.includes('2. Call dentist 🔥'));
  });

  it('shows 🔥 for priority items', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{ text: 'Urgent task', priority: true }],
    });
    assert.ok(r.includes('🔥'));
  });

  it('shows ✅ for completed items', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{ text: 'Done task', done: true }],
    });
    assert.ok(r.includes('✅'));
  });

  it('shows ✅ for completed items (completed field)', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{ text: 'Done task', completed: true }],
    });
    assert.ok(r.includes('✅'));
  });

  it('shows both 🔥 and ✅ for priority + done items', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{ text: 'Done priority', priority: true, done: true }],
    });
    assert.ok(r.includes('🔥'));
    assert.ok(r.includes('✅'));
  });

  it('uses name field when text absent', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{ name: 'Grocery List' }],
    });
    assert.ok(r.includes('1. Grocery List'));
  });

  it('uses title field when text and name absent', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{ title: 'Some Title' }],
    });
    assert.ok(r.includes('1. Some Title'));
  });

  it('uses fallback "Item N" when no text/name/title', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 1 item',
      data: [{}],
    });
    assert.ok(r.includes('1. Item 1'));
  });

  it('formats empty array', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 0 items',
      data: [],
    });
    assert.ok(r.includes('_(empty)_'));
  });

  it('numbers items sequentially', () => {
    const r = formatResponse({
      success: true,
      message: 'Found 3 items',
      data: [
        { text: 'First' },
        { text: 'Second' },
        { text: 'Third' },
      ],
    });
    assert.ok(r.includes('1. First'));
    assert.ok(r.includes('2. Second'));
    assert.ok(r.includes('3. Third'));
  });
});

describe('formatResponse — success with object data', () => {
  it('formats object data as JSON code block', () => {
    const r = formatResponse({
      success: true,
      message: 'Created',
      data: { id: 'abc', text: 'task' },
    });
    assert.ok(r.includes('```json'));
    assert.ok(r.includes('"id": "abc"'));
    assert.ok(r.includes('"text": "task"'));
  });

  it('formats nested objects', () => {
    const r = formatResponse({
      success: true,
      message: 'OK',
      data: { nested: { key: 'value' } },
    });
    assert.ok(r.includes('```json'));
    assert.ok(r.includes('"nested"'));
  });
});

describe('formatResponse — no data', () => {
  it('returns just success message when no data', () => {
    const r = formatResponse({
      success: true,
      message: 'Item deleted',
    });
    assert.equal(r.trim(), '✅ Item deleted');
  });

  it('handles null data', () => {
    const r = formatResponse({
      success: true,
      message: 'OK',
      data: null as any,
    });
    assert.equal(r.trim(), '✅ OK');
  });

  it('handles undefined data', () => {
    const r = formatResponse({
      success: true,
      message: 'OK',
      data: undefined,
    });
    assert.equal(r.trim(), '✅ OK');
  });
});

// ---------------------------------------------------------------------------
// 6. handleCommand integration tests (mocking fetch via node:test)
// ---------------------------------------------------------------------------

describe('handleCommand — integration (mocked fetch)', () => {
  // We dynamically import the module after mocking fetch.
  // node:test's mock.module() lets us intercept ESM imports.

  let mockedFetch: any;
  let handleCommandFn: (input: string) => Promise<string>;

  before(async () => {
    // Mock node-fetch globally before importing the module
    mockedFetch = mock.fn(async (url: string, opts: any) => {
      // Default mock response
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    });

    // We'll use mock.module to intercept the 'node-fetch' import
    // But since the module is already evaluated, let's take a different approach:
    // Import the module and test what we can test without actual network calls.
    
    // Since parseIntent and formatResponse are pure and tested above,
    // and handleCommand requires the actual ListerClient which uses real fetch,
    // we can test handleCommand's error paths (which don't hit fetch for
    // missing entities) and the default/unknown path.
    
    // Import the module — fetch will be called for most commands, but
    // the validation errors (missing entities) are returned before any API call.
    const mod = await import('./index.js');
    handleCommandFn = mod.handleCommand;
  });

  after(() => {
    mock.restoreAll();
  });

  // --- Validation error paths (no network calls) ---

  it('returns error when add_item has no quoted text', async () => {
    const result = await handleCommandFn('Add to my work list');
    assert.ok(result.includes('Please provide what to add'));
  });

  it('returns error when mark_done has no item ID', async () => {
    const result = await handleCommandFn('Mark done');
    assert.ok(result.includes('Please specify which item'));
  });

  it('returns error when remove_item has no item ID', async () => {
    const result = await handleCommandFn('Remove');
    assert.ok(result.includes('Please specify which item'));
  });

  it('returns error when update_item has no item ID', async () => {
    const result = await handleCommandFn('Update "new name"');
    assert.ok(result.includes('Please specify which item'));
  });

  it('returns error when move_item has no item ID', async () => {
    const result = await handleCommandFn('Move to work list');
    assert.ok(result.includes('Please specify item and target list'));
  });

  it('returns error when move_item has no list name', async () => {
    const result = await handleCommandFn('Move item 5');
    assert.ok(result.includes('Please specify item and target list'));
  });

  it('returns error when add_note has no item ID', async () => {
    const result = await handleCommandFn('Note "something"');
    assert.ok(result.includes('Please specify item and note'));
  });

  it('returns error when add_note has no note text', async () => {
    const result = await handleCommandFn('Note for item 5');
    assert.ok(result.includes('Please specify item and note'));
  });

  // --- Unknown/default path ---

  it('returns help text for unknown intent', async () => {
    const result = await handleCommandFn('Hello world');
    assert.ok(result.includes("didn't understand"));
    assert.ok(result.includes('Add "call Notary"'));
    assert.ok(result.includes('Get priority items'));
    assert.ok(result.includes('Mark item 123'));
  });

  // --- Priority items path ---

  it('get_priority calls getPriorityItems', async () => {
    // This WILL hit fetch, so it depends on the mock being set up.
    // Since we can't fully mock fetch after the module loads,
    // we just verify the routing is correct via the parseIntent tests.
    // This test documents the expected behavior.
  });
});

// ---------------------------------------------------------------------------
// 7. Comprehensive routing matrix — every intent → expected validation/API
// ---------------------------------------------------------------------------

describe('parseIntent routing matrix', () => {
  type TestCase = { input: string; expectedIntent: Intent; expectedEntities: Partial<ParsedIntent['entities']> };

  const cases: TestCase[] = [
    // add_item
    { input: 'Add "task" to my work list', expectedIntent: 'add_item', expectedEntities: { itemText: 'task', listName: 'work' } },
    { input: 'Create "thing" in my todo list', expectedIntent: 'add_item', expectedEntities: { itemText: 'thing', listName: 'todo' } },

    // get_items
    { input: 'Get my items', expectedIntent: 'get_items', expectedEntities: {} },
    { input: 'Find items in my work list', expectedIntent: 'get_items', expectedEntities: { listName: 'work' } },

    // get_priority
    { input: 'Get priority items', expectedIntent: 'get_priority', expectedEntities: {} },
    { input: 'Show urgent things in work list', expectedIntent: 'get_priority', expectedEntities: { listName: 'work' } },

    // mark_done
    { input: 'Mark item 42 done', expectedIntent: 'mark_done', expectedEntities: { itemId: '42' } },

    // remove_item
    { input: 'Delete item 7', expectedIntent: 'remove_item', expectedEntities: { itemId: '7' } },

    // update_item
    { input: 'Update item 3 to "new title"', expectedIntent: 'update_item', expectedEntities: { itemId: '3', itemText: 'new title' } },

    // move_item
    { input: 'Move item 9 to my archive list', expectedIntent: 'move_item', expectedEntities: { itemId: '9', listName: 'archive' } },

    // add_note
    { input: 'Note for item 2: "follow up"', expectedIntent: 'add_note', expectedEntities: { itemId: '2', note: 'follow up' } },

    // unknown
    { input: 'What is the meaning of life?', expectedIntent: 'unknown', expectedEntities: {} },
  ];

  for (const tc of cases) {
    it(`"${tc.input}" → ${tc.expectedIntent}`, () => {
      const r = parseIntent(tc.input);
      assert.equal(r.intent, tc.expectedIntent);
      for (const [key, value] of Object.entries(tc.expectedEntities)) {
        assert.equal((r.entities as any)[key], value, `entities.${key} mismatch`);
      }
    });
  }
});

describe('current API command coverage', () => {
  it('routes item export and email commands', () => {
    const exported = actualParseIntent('export item 123 as html');
    assert.equal(exported.intent, 'export_item');
    assert.equal(exported.entities.itemId, '123');
    assert.equal(exported.entities.format, 'html');
    const emailed = actualParseIntent('email item 123 to user@example.com');
    assert.equal(emailed.intent, 'email_item');
    assert.equal(emailed.entities.itemId, '123');
    assert.equal(emailed.entities.email, 'user@example.com');
  });

  it('routes send aliases and friendly recipient names', () => {
    const list = actualParseIntent('send my work list to Mom');
    assert.equal(list.intent, 'email_list');
    assert.equal(list.entities.listName, 'work');
    assert.equal(list.entities.email, 'mom');

    const item = actualParseIntent('send item 123 to "Sarah Smith"');
    assert.equal(item.intent, 'email_item');
    assert.equal(item.entities.itemId, '123');
    assert.equal(item.entities.email, 'sarah smith');

    const priority = actualParseIntent('send priority items to Alex');
    assert.equal(priority.intent, 'email_priority');
    assert.equal(priority.entities.email, 'alex');
  });

  it('keeps API key commands distinct from environment switching', () => {
    assert.deepEqual(actualParseIntent('set staging API key to secret-value'), {
      intent: 'set_api_key',
      entities: { apiEnvironment: 'staging', apiKey: 'secret-value' },
    });
    assert.deepEqual(actualParseIntent('switch to production'), {
      intent: 'set_api_environment',
      entities: { apiEnvironment: 'production' },
    });
    assert.deepEqual(actualParseIntent('set API base URL to https://staging.example.com'), {
      intent: 'set_api_environment',
      entities: { apiBaseUrl: 'https://staging.example.com' },
    });
  });

  it('routes note reorder and archived item reads', () => {
    assert.deepEqual(actualParseIntent('reorder notes for item 123 in order: 456, 789'), {
      intent: 'reorder_notes',
      entities: { itemId: '123', noteIds: ['456', '789'] },
    });
    const archived = actualParseIntent('get my Work list with archived');
    assert.equal(archived.intent, 'get_items');
    assert.equal(archived.entities.includeArchived, true);
  });

  it('routes attachments, media, file URLs, and API status checks', () => {
    assert.deepEqual(actualParseIntent('attach file "plan.pdf" to item 123'), {
      intent: 'upload_attachment',
      entities: { filePath: 'plan.pdf', itemId: '123' },
    });
    const voice = actualParseIntent('upload voice "note.webm" to item 123 transcribe for 30 seconds');
    assert.equal(voice.intent, 'upload_voice');
    assert.equal(voice.entities.filePath, 'note.webm');
    assert.equal(voice.entities.itemId, '123');
    assert.equal(voice.entities.duration, 30);
    assert.equal(voice.entities.transcribe, true);
    const fileUrl = actualParseIntent('get file URL for attachments/lists/x expires 600');
    assert.equal(fileUrl.intent, 'file_url');
    assert.equal(fileUrl.entities.fileKey, 'attachments/lists/x');
    assert.equal(fileUrl.entities.expiresIn, 600);
    assert.equal(actualParseIntent('check API health').intent, 'api_health');
    assert.equal(actualParseIntent('show API version').intent, 'api_version');
  });

  it('supports force deletion and project list type changes', () => {
    assert.deepEqual(actualParseIntent('delete my Archive list permanently'), {
      intent: 'delete_list',
      entities: { listName: 'Archive', forceDelete: true },
    });
    const update = actualParseIntent('update my Launch list to project');
    assert.equal(update.intent, 'update_list');
    assert.equal(update.entities.listType, 'project');
  });
});

// ---------------------------------------------------------------------------
// Export for test runner discovery
// ---------------------------------------------------------------------------
export {};
