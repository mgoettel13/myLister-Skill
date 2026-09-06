import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { callPublicTool, operations } from './tools.js';

const base = new URL('https://api.example');
const key = 'lister_test-key';
const capture = () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init: init! });
    return new Response('{"success":true}', { headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
};

test('every public app operation is represented, with no private/auth tool', () => {
  const spec = JSON.parse(readFileSync(new URL('../contracts/public-openapi.json', import.meta.url), 'utf8'));
  let count = 0;
  for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, { operationId: string }>>)) {
    if (path === '/v1/') continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      count++;
      const tool = operations.get(operation.operationId.split('_v1_')[0]);
      assert.ok(tool);
      assert.equal(tool.path, path);
      assert.ok(!/api-keys|\/auth\//.test(tool.path));
    }
  }
  assert.equal(operations.size, count);
  assert.equal(count, 58);
});

test('standard, notebook, and project lists use the same complete create capability', async () => {
  const { calls, fetcher } = capture();
  for (const type of ['standard', 'notebook', 'project']) {
    await callPublicTool('create_list', { body: { name: `Test ${type}`, type } }, key, base, fetcher);
  }
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body)).type), ['standard', 'notebook', 'project']);
});

test('item creation preserves initial notes, project data, priority, and content exactly', async () => {
  const { calls, fetcher } = capture();
  const body = { content: " it's been a tough day. Lots of meetings and no time to get anything done ",
    type: 'text', status: 'new', notes: [{ content: 'Follow up tomorrow' }], isPriority: true,
    project: { startDate: '2026-09-07', durationMinutes: 30 },
  };
  await callPublicTool('create_item', { path: { list_id: 'journal-id' }, body }, key, base, fetcher);
  assert.equal(calls[0].url.pathname, '/v1/lists/journal-id/items');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
  assert.deepEqual(calls[0].init.headers, { 'X-API-Key': key, 'Content-Type': 'application/json' });
  assert.equal(calls[0].init.redirect, 'manual');
});

test('Call Mama create, priority update, and priority query are available', async () => {
  const { calls, fetcher } = capture();
  await callPublicTool('create_item', { path: { list_id: 'today-id' }, body: { content: 'Call Mama', type: 'text', status: 'new' } }, key, base, fetcher);
  await callPublicTool('update_item', { path: { item_id: 'mama-id' }, body: { isPriority: true } }, key, base, fetcher);
  await callPublicTool('get_priority_items', {}, key, base, fetcher);
  assert.deepEqual(calls.map(call => call.init.method), ['POST', 'PATCH', 'GET']);
  assert.equal(calls[2].url.pathname, '/v1/items/priority');
});

test('shared-item and shared-note comments, sharing, and sending retain their endpoints', async () => {
  const { calls, fetcher } = capture();
  await callPublicTool('add_item_comment', { path: { item_id: 'item' }, body: { content: 'Shared comment' } }, key, base, fetcher);
  await callPublicTool('add_note_comment', { path: { item_id: 'item', note_id: 'note' }, body: { content: 'Note comment' } }, key, base, fetcher);
  await callPublicTool('export_list_email', { path: { list_id: 'today' }, body: { toEmail: 'test@example.com' } }, key, base, fetcher);
  assert.equal(calls[1].url.pathname, '/v1/items/item/notes/note/comments');
  assert.equal(calls[2].url.pathname, '/v1/lists/today/export/email');
  assert.ok(operations.has('share_list_with_user'));
  assert.ok(operations.has('update_user_permission'));
});

test('multipart attachments include decoded bytes, filename, and media type', async () => {
  const { calls, fetcher } = capture();
  await callPublicTool('upload_note_attachment', {
    path: { item_id: 'item', note_id: 'note' }, body: { file: { filename: 'test.txt', mimeType: 'text/plain', base64: Buffer.from('test note').toString('base64') } },
  }, key, base, fetcher);
  const form = calls[0].init.body as FormData;
  const file = form.get('file') as File;
  assert.equal(file.name, 'test.txt');
  assert.equal(file.type, 'text/plain');
  assert.equal(await file.text(), 'test note');
  assert.deepEqual(calls[0].init.headers, { 'X-API-Key': key });
});

test('unknown tools, arbitrary targets, traversal, and invalid fields never reach the network', async () => {
  const { calls, fetcher } = capture();
  await assert.rejects(callPublicTool('create_api_key', {}, key, base, fetcher));
  await assert.rejects(callPublicTool('get_priority_items', { url: 'https://evil.example' }, key, base, fetcher));
  await assert.rejects(callPublicTool('get_item', { path: { item_id: '../auth/api-keys' } }, key, base, fetcher));
  await assert.rejects(callPublicTool('create_list', { body: { name: 'Test', type: 'admin' } }, key, base, fetcher));
  assert.equal(calls.length, 0);
});

test('redirected downloads return a link without a second authenticated request', async () => {
  let count = 0;
  const fetcher: typeof fetch = async () => { count++; return new Response(null, { status: 307, headers: { Location: 'https://storage.example/test?signature=opaque' } }); };
  const result = await callPublicTool('get_file', { path: { file_key: 'file' } }, key, base, fetcher);
  assert.equal(count, 1);
  assert.equal(result.content[0].type, 'resource_link');
  assert.ok(!JSON.stringify(result).includes(key));
});

test('upstream revoked keys request reauthorization without exposing the key', async () => {
  const fetcher: typeof fetch = async () => new Response(`Invalid ${key}`, { status: 401 });
  const result = await callPublicTool('get_priority_items', {}, key, base, fetcher);
  assert.equal(result.isError, true);
  assert.ok(result._meta?.['mcp/www_authenticate']);
  assert.ok(!JSON.stringify(result).includes(key));
});
