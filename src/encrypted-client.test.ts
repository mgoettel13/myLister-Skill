import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import nodeFetch, { File, FormData, Request, Response, type RequestInit } from 'node-fetch';
import { createSkillFetch, clearSkillFetchCache } from './encrypted-client.js';
import { loadOrCreateIdentity } from './identity.js';
import { importContentKey, openContentMedia, sealContent, sealContentMedia, wrapListKey, type ContentScope } from './encryption.js';

type Obj = Record<string, any>;
const base = 'https://transport-synthetic.example';
const userId = '000000000000000000000001';
const listId = '000000000000000000000002';
const keyId = '000000000000000000000003';
const itemId = '000000000000000000000004';
const environment = 'app.synthetic.example';
const headers = { 'X-API-Key': 'synthetic-enrolled-api-key', 'Content-Type': 'application/json' };
const saved = { config: process.env.LISTER_CONFIG_DIR, base: process.env.LISTER_BASE_URL };
let directory: string;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mylister-transport-'));
  process.env.LISTER_CONFIG_DIR = directory;
  process.env.LISTER_BASE_URL = base;
});
test.after(async () => {
  clearSkillFetchCache();
  for (const [key, value] of Object.entries({ LISTER_CONFIG_DIR: saved.config, LISTER_BASE_URL: saved.base })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

function ok(data: any, status = 200): Response { return new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } }); }
function grant(publicKey: Obj, installationId: string, raw: Buffer): Obj {
  const pair = createECDH('prime256v1'); pair.generateKeys();
  const uncompressed = Buffer.concat([Buffer.from([4]), Buffer.from(publicKey.x, 'base64url'), Buffer.from(publicKey.y, 'base64url')]);
  const shared = pair.computeSecret(uncompressed), salt = randomBytes(32), iv = randomBytes(12);
  const aad = Buffer.from(JSON.stringify(['mylister-api-key-account-wrap-v1', environment, userId, installationId, 'account-key-v1']));
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hkdfSync('sha256', shared, salt, aad, 32)), iv); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
  const pub = pair.getPublicKey(); shared.fill(0);
  return { ephemeralPublicKey: { crv: 'P-256', kty: 'EC', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, salt: salt.toString('base64url'), iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}
function gcm(raw: Buffer, iv: Buffer, aad: Buffer, encrypted: Buffer): Buffer {
  const cipher = createDecipheriv('aes-256-gcm', raw, iv); cipher.setAAD(aad); cipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]);
}
/** Independent Node/OpenSSL decoder verifies the actual UI wire AAD and deflate format. */
function openField(value: Obj, raw: Buffer, list: string, record: string, path: string[], collection = 'items'): string {
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'chunks', 'generation', 'v']);
  const chunks = value.chunks.map((encoded: string, index: number) => {
    const wire = Buffer.from(encoded, 'base64url');
    const aad = Buffer.from(JSON.stringify(['mylister-core-content', 3, environment, list, collection, record, keyId, path, value.generation, value.bytes, value.chunks.length, index]));
    return gcm(raw, wire.subarray(0, 12), aad, wire.subarray(12));
  });
  const opened = inflateSync(Buffer.concat(chunks)); assert.equal(opened.length, value.bytes); return opened.toString('utf8');
}

async function fixture(options: { items?: number; permission?: string; schema?: number } = {}) {
  clearSkillFetchCache();
  const identity = await loadOrCreateIdentity(base, headers['X-API-Key']);
  const rootBytes = randomBytes(32), listBytes = randomBytes(32);
  const root = await importContentKey(rootBytes), key = await importContentKey(listBytes);
  const envelope = await wrapListKey(listBytes, root, { accountId: userId, userId, listId, keyId });
  const route: Obj = { listId, ownerAccountId: userId, ownerUserId: userId, activationVersion: 1, ownerManifestEpoch: 5,
    authoritativeRevision: 'revision-5', route: 'client', reason: 'ready', schemaVersion: options.schema ?? 3, keyId,
    membershipGrantId: options.permission ? 'member-grant' : 'owner', viewerUserId: userId, viewerEnvelopeVersion: 1, viewerEnvelopeFingerprint: createHash('sha256').update(JSON.stringify({ aad: envelope.aad, algorithm: envelope.algorithm, ciphertext: envelope.ciphertext, iv: envelope.iv, version: envelope.version })).digest('hex') };
  const scope = (recordId: string, path: string[], collection = 'items'): ContentScope => ({ accountId: userId, userId, environment, listId, keyId, recordId, collection, path, schemaVersion: 3 });
  const now = '2026-11-08T12:00:00.000Z';
  const marker = { v: options.schema ?? 3, keyId };
  const list: Obj = { id: listId, name: await sealContent('Private <Work>', key, scope(listId, ['name'], 'lists')), description: await sealContent('Description', key, scope(listId, ['description'], 'lists')), _contentEncryption: marker, contentRevision: 1, updatedAt: now };
  const items: Obj[] = [];
  for (let i = 0; i < (options.items ?? 1); i++) {
    const iid = i ? (i + 10).toString(16).padStart(24, '0') : itemId;
    items.push({ id: iid, listId, content: await sealContent(i ? `Private task ${i}` : '<script>alert("x")</script> Private task', key, scope(iid, ['content'])), type: 'text', status: 'new', isPriority: i === 0,
      notes: [], comments: [], attachments: [], updatedAt: now, contentRevision: 1, _contentEncryption: marker });
  }
  const context: Obj = { apiKeyId: 'synthetic', accountId: userId, userId, environment,
    encryption: { status: 'active', installationId: identity.installationId, publicKey: identity.publicKey, environment, userId, accountKeyId: 'account-key-v1', accountKeyEnvelope: grant(identity.publicKey, identity.installationId, rootBytes) } };
  const calls: Array<{ path: string; method: string; body: any; init: RequestInit }> = [];
  const rawLists = new Map<string, Obj>([[listId, list]]), rawItems = new Map<string, Obj>(items.map(item => [item.id, item]));
  const listKeys = new Map<string, Obj>([[listId, { key: listBytes, envelope, keyId }]]);
  const reservations = new Map<string, Obj>();
  let count = 1000, failPath = '', emailAmbiguous = false, rejectSourceDelete = false, envelopeMismatch = false, ambiguousDelete = false;
  let mediaBytes: Uint8Array | undefined;
  const mediaStore = new Map<string, Uint8Array>();
  const receipts = new Map<string, Obj>();
  const result = (row: Obj) => ({ id: row.id, listId: row.listId ?? row.id, updatedAt: row.updatedAt, contentRevision: row.contentRevision, _contentEncryption: row._contentEncryption });
  const mutate = (row: Obj, body: Obj) => {
    assert.equal(body.expectedRevision, row.contentRevision); assert.equal(body.expectedUpdatedAt, row.updatedAt);
    assert.deepEqual(body._contentEncryption ?? row._contentEncryption, row._contentEncryption);
    row.contentRevision++; row.updatedAt = new Date(Date.parse(row.updatedAt) + 1).toISOString();
  };
  const fetch = (async (input: any, init: RequestInit = {}) => {
    assert.equal(init.redirect, 'error', 'redirect rejection must be set before every credential transmission');
    assert.equal(new Headers(init.headers as any).get('x-api-key'), headers['X-API-Key']);
    const url = new URL(String(input)); assert.equal(url.origin, base);
    const path = url.pathname, method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: `${path}${url.search}`, method, body, init });
    if (path === failPath) return new Response(JSON.stringify({ detail: 'synthetic failure' }), { status: 503 });
    if (path === '/v1/skill/context') return ok(context);
    if (path === '/v1/crypto/v1/content-route-manifest') {
      const e = listKeys.get(body.listIds[0])!.envelope;
      return ok({ routeManifestVersion: 1, requestedCount: 1, decisionCount: 1, decisions: [{ ...route, listId: body.listIds[0], viewerEnvelopeFingerprint: createHash('sha256').update(JSON.stringify({ aad: e.aad, algorithm: e.algorithm, ciphertext: e.ciphertext, iv: e.iv, version: e.version })).digest('hex') }] });
    }
    if (path === '/v1/crypto/v1/raw-content/list-key-envelopes') return ok({ routeManifestVersion: 1, envelopes: body.routeManifest.decisions.map((r: Obj) => ({ listId: r.listId, keyId, envelopeVersion: 1, transportVersion: 1, version: 1, envelope: envelopeMismatch ? { ...envelope, iv: 'bad' } : listKeys.get(r.listId)?.envelope })) });
    if (path === '/v1/crypto/v1/raw-content/reservations') {
      const recordId = (++count).toString(16).padStart(24, '0'), reservationId = randomBytes(32).toString('base64url');
      const row = { reservationId, recordId, keyId, purpose: body.purpose, expiresAt: '2099-01-01T00:00:00Z' };
      reservations.set(reservationId, row); return ok(row);
    }
    if (path === '/v1/crypto/v1/raw-content/lists' && method === 'GET') {
      return ok({ lists: [...rawLists.values()].map(row => ({ id: row.id, isOwner: !options.permission, permission: options.permission ?? 'admin', _contentEncryption: marker, archived: false })), listCount: rawLists.size, hasMore: false, nextCursor: null });
    }
    if (path === '/v1/crypto/v1/raw-content/lists' && method === 'POST') {
      const r = reservations.get(body.reservationId)!;
      assert.deepEqual(body._contentEncryption, { v: 3, keyId }); assert.equal(body.accountKeyId, 'account-key-v1');
      const wire = body.ownerEnvelope.envelope;
      const aad = Buffer.from(JSON.stringify(['mylister-list-key-wrap-v1', 1, userId, userId, r.recordId, keyId]));
      const raw = gcm(rootBytes, Buffer.from(wire.iv, 'base64url'), aad, Buffer.from(wire.ciphertext, 'base64url'));
      assert.equal(openField(body.ciphertext.name, raw, r.recordId, r.recordId, ['name'], 'lists'), 'Brand new private list');
      listKeys.set(r.recordId, { key: raw, envelope: wire, keyId });
      const row = { id: r.recordId, ...body.ciphertext, type: body.type, contentRevision: 1, updatedAt: now, _contentEncryption: marker };
      rawLists.set(row.id, row); return ok({ ...result(row), keyId });
    }
    if (path === '/v1/crypto/v1/raw-content/items' && method === 'POST') {
      const r = reservations.get(body.reservationId)!;
      assert.equal(body.routeDecision.listId, body.listId); assert.equal(body._contentEncryption.v, 3);
      const row = { id: r.recordId, listId: body.listId, ...body.ciphertext, ...Object.fromEntries(['type', 'status', 'isPriority', 'project'].filter(k => k in body).map(k => [k, body[k]])), updatedAt: now, contentRevision: 1, _contentEncryption: marker };
      rawItems.set(row.id, row); return ok(result(row));
    }
    const match = path.match(/^\/v1\/crypto\/v1\/raw-content\/(lists|items)\/([a-f0-9]{24})(.*)$/);
    if (match) {
      const [, kind, rid, tail] = match, row = (kind === 'lists' ? rawLists : rawItems).get(rid)!;
      if (method === 'GET') {
        for (const key of ['routeManifestVersion', 'authoritativeRevision', 'route', 'schemaVersion', 'keyId', 'activationVersion', 'ownerManifestEpoch', 'membershipGrantId', 'viewerUserId', 'viewerEnvelopeVersion', 'viewerEnvelopeFingerprint']) assert.ok(url.searchParams.has(key), `missing route field ${key}`);
        if (kind === 'items') { assert.equal(url.searchParams.get('listId'), row.listId); return ok({ routeManifestVersion: 1, route: { ...route, listId: row.listId }, item: row }); }
        const offset = Number(url.searchParams.get('itemOffset'));
        assert.equal(url.searchParams.get('itemLimit'), '100');
        return ok({ routeManifestVersion: 1, route: { ...route, listId: rid }, list: row, items: [...rawItems.values()].filter(i => i.listId === rid).slice(offset, offset + 100), sharedChanges: [], itemLimit: 100, itemOffset: offset });
      }
      if (method === 'DELETE') {
        if (ambiguousDelete && rid === itemId) { rawItems.delete(rid); throw new Error('source deletion committed, response lost'); }
        if (rejectSourceDelete && rid === itemId) return new Response('{}', { status: 409 });
        mutate(row, body); (kind === 'lists' ? rawLists : rawItems).delete(rid); return ok({ id: rid, deleted: true });
      }
      // Mirror raw_content_writes._require_stable_children: a protected PUT
      // can change child ciphertext but may never create/delete a child ID.
      if (method === 'PUT' && kind === 'items') {
        const stable = (current: Obj, incoming: Obj) => {
          for (const field of ['notes', 'comments', 'attachments']) if (incoming[field] !== undefined) {
            const old = current[field] ?? [], replacement = incoming[field];
            assert.deepEqual(replacement.map((c: Obj) => c.id).sort(), old.map((c: Obj) => c.id).sort(), 'raw PUT cannot add or remove child IDs');
            for (const child of replacement) stable(old.find((c: Obj) => c.id === child.id), child);
          }
        };
        stable(row, body.ciphertext);
      }
      mutate(row, body);
      if (tail === '/structural') row[body.operation] = body.value;
      else if (tail === '/embedded') {
        const values = body.target === 'itemAttachments' ? row.attachments ??= [] : body.target === 'noteComments' ? (row.notes.find((n: Obj) => n.id === body.noteId).comments ??= []) : (row[body.target] ??= []);
        if (body.operation === 'add') values.push(body.child);
        if (body.operation === 'delete') values.splice(values.findIndex((c: Obj) => c.id === body.childId), 1);
        if (body.operation === 'status') values.find((n: Obj) => n.id === body.childId).status = body.status;
      } else Object.assign(row, body.ciphertext, body.metadata);
      return ok(result(row));
    }
    if (path === '/v1/crypto/v1/raw-media/upload') {
      mediaBytes = new Uint8Array(Buffer.from(body.ciphertext, 'base64url'));
      const receiptId = randomBytes(32).toString('base64url'), mediaId = (++count).toString(16).padStart(24, '0');
      mediaStore.set(mediaId, mediaBytes); receipts.set(receiptId, { ...body, mediaId });
      return ok({ receiptId, mediaId, target: body.target, size: body.size, contentType: 'application/octet-stream', expiresAt: '2099-01-01T00:00:00Z' });
    }
    if (path === '/v1/crypto/v1/raw-media/link') {
      const receipt = receipts.get(body.receiptId)!, row = rawItems.get(receipt.itemId)!;
      mutate(row, body);
      if (receipt.target === 'item_attachment') {
        const attachment = row.attachments.find((a: Obj) => a.id === receipt.stableId); assert.ok(attachment, 'receipt requires an existing attachment child'); attachment.fileKey = receipt.mediaId;
      } else { row.metadata ??= {}; row.metadata[receipt.target === 'item_image' ? 'imageFileId' : 'voiceFileId'] = receipt.mediaId; }
      return ok({ mediaId: receipt.mediaId, contentRevision: row.contentRevision, updatedAt: row.updatedAt });
    }
    if (path === '/v1/crypto/v1/raw-media/read') {
      const bytes = mediaStore.get(body.mediaId); assert.ok(bytes); return new Response(Buffer.from(bytes), { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (path.endsWith('/export/email')) { if (emailAmbiguous) throw new Error('lost reply'); return ok({ sent: true }); }
    if (path === `/v1/lists/${listId}/share`) {
      const pair = createECDH('prime256v1'); pair.generateKeys(); const publicBytes = pair.getPublicKey();
      return ok({ clientOwned: true, membershipGrantId: 'g'.repeat(43), recipientExchangeKey: { exchangeKeyId: 'e'.repeat(43), version: 1,
        publicKeyFingerprint: 'a'.repeat(64), publicKey: { crv: 'P-256', kty: 'EC', x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url') } } });
    }
    if (path === '/v1/crypto/v1/collaborator-key-transfers') {
      assert.equal(body.ownerUserId, userId); assert.equal(body.listId, listId); assert.equal(body.expectedVersion, 0);
      assert.equal(Buffer.from(body.transfer.ciphertext, 'base64url').length, 80);
      assert.equal(Buffer.from(body.transfer.salt, 'base64url').length, 16);
      assert.equal(body.transfer.version, 1); return ok({ transferId: body.transferId, state: 'pending' });
    }
    assert.fail(`Unexpected plaintext/unsupported request: ${method} ${path}`);
  }) as typeof nodeFetch;
  return { wrapped: createSkillFetch(fetch), calls, context, listBytes, rootBytes, rawLists, rawItems, listKeys, route, key, mediaStore,
    setFail: (path: string) => { failPath = path; }, setAmbiguousEmail: () => { emailAmbiguous = true; }, rejectDelete: () => { rejectSourceDelete = true; }, setAmbiguousDelete: () => { ambiguousDelete = true; }, corruptEnvelope: () => { envelopeMismatch = true; }, mediaBytes: () => mediaBytes,
    addList: async (target: string) => {
      rawLists.set(target, { ...list, id: target, name: await sealContent('Destination', key, { ...scope(target, ['name'], 'lists'), listId: target }), description: null });
      listKeys.set(target, { key: listBytes, keyId, envelope: await wrapListKey(listBytes, root, { accountId: userId, userId, listId: target, keyId }) });
    } };
}
async function call(f: Awaited<ReturnType<typeof fixture>>, path: string, method = 'GET', body?: any) {
  const response = await f.wrapped(`${base}${path}`, { headers, method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { response, data: await response.json() as Obj };
}

test('missing installation identity blocks reads, text writes and multipart uploads without any network call', async () => {
  const calls: any[] = [];
  const wrapped = createSkillFetch((async (_input, init) => { calls.push(init); return new Response('{}', { status: 423 }); }) as typeof nodeFetch);
  const unconfigured = { 'X-API-Key': 'unenrolled-synthetic-key' };
  const form = new FormData(); form.append('file', new File(['private data'], 'private.txt'));
  for (const [path, init] of [
    ['/v1/lists', { headers: unconfigured }],
    [`/v1/lists/${listId}/items`, { method: 'POST', headers: unconfigured, body: JSON.stringify({ content: 'private task' }) }],
    ['/v1/upload/image', { method: 'POST', headers: unconfigured, body: form }],
    [`/v1/items/${itemId}/attachments`, { method: 'POST', headers: unconfigured, body: form }],
    ['/v1/contacts', { headers: unconfigured }],
  ] as Array<[string, RequestInit]>) {
    const response = await wrapped(`${base}${path}`, init);
    assert.equal(response.status, 423); assert.match(JSON.stringify(await response.json()), /Set up encryption/);
  }
  assert.equal(calls.length, 0);
  await wrapped(`${base}/v1/health`, { headers: unconfigured });
  assert.equal(calls.length, 1); assert.equal(calls[0].redirect, 'error');
});

test('app-compatible encrypted list and task creation never transmits protected plaintext', async () => {
  const f = await fixture();
  const list = await call(f, '/v1/lists', 'POST', { name: 'Brand new private list', type: 'project' });
  assert.equal(list.response.status, 200); assert.equal(list.data.data.type, 'project');
  const response = await call(f, `/v1/lists/${listId}/items`, 'POST', { content: 'New private task', type: 'text', status: 'new', isPriority: true,
    notes: [{ content: 'Private note' }], comments: [{ content: 'Private comment' }], reminder: { title: 'Private reminder', remindAt: '2027-01-01T00:00:00Z', timezone: 'UTC' } });
  assert.equal(response.response.status, 200);
  const create = f.calls.find(c => c.path === '/v1/crypto/v1/raw-content/items' && c.method === 'POST')!;
  const iid = response.data.data.id;
  assert.equal(openField(create.body.ciphertext.content, f.listBytes, listId, iid, ['content']), 'New private task');
  const note = create.body.ciphertext.notes[0], comment = create.body.ciphertext.comments[0];
  assert.equal(openField(note.content, f.listBytes, listId, iid, ['notes', note.id, 'content']), 'Private note');
  assert.equal(openField(comment.content, f.listBytes, listId, iid, ['comments', comment.id, 'content']), 'Private comment');
  const reminder = f.calls.find(c => c.path.endsWith('/structural') && c.body.operation === 'reminder')!;
  assert.equal(openField(reminder.body.value.title, f.listBytes, listId, iid, ['reminder', 'title']), 'Private reminder');
  const traffic = JSON.stringify(f.calls);
  for (const secret of ['New private task', 'Private note', 'Private comment', 'Private reminder', 'Brand new private list']) assert.ok(!traffic.includes(secret));
});

test('paged reads, direct item parent lookup and sequential commands open all ciphertext', async () => {
  const f = await fixture({ items: 101 });
  const first = await call(f, `/v1/lists/${listId}/items`);
  assert.equal(first.response.status, 200); assert.equal(first.data.data.length, 101);
  assert.ok(f.calls.some(c => c.path.includes('itemOffset=100')));
  const item = await call(f, `/v1/items/${itemId}`);
  assert.match(item.data.data.content, /Private task/);
  const again = await call(f, '/v1/lists'); assert.equal(again.data.data[0].name, 'Private <Work>');
  assert.equal(f.calls.filter(c => c.path === '/v1/skill/context').length, 3);
});

test('pending, wrong installation, corrupt key and read-only/schema states fail closed', async () => {
  const f = await fixture(); f.context.encryption.status = 'pending';
  assert.equal((await call(f, `/v1/items/${itemId}`, 'PATCH', { content: 'never send me' })).response.status, 423);
  assert.equal(f.calls.length, 1);
  f.context.encryption.status = 'active'; f.context.encryption.installationId = '0'.repeat(64);
  assert.equal((await call(f, '/v1/lists')).response.status, 423);
  const bad = await fixture(); bad.corruptEnvelope(); assert.equal((await call(bad, '/v1/lists')).response.status, 423);
  const readonly = await fixture({ permission: 'read' });
  assert.equal((await call(readonly, `/v1/lists/${listId}/items`, 'POST', { content: 'blocked' })).response.status, 403);
  assert.ok(!readonly.calls.some(c => c.path.endsWith('/reservations')));
  const old = await fixture({ schema: 2 });
  assert.equal((await call(old, `/v1/lists/${listId}/items`, 'POST', { content: 'blocked' })).response.status, 423);
});

test('notes, note comments, structural priority and local search use only raw content', async () => {
  const f = await fixture();
  const note = await call(f, `/v1/items/${itemId}/notes`, 'POST', { content: 'secret child note' });
  assert.equal(note.response.status, 200); const nid = note.data.data.id;
  const comment = await call(f, `/v1/items/${itemId}/notes/${nid}/comments`, 'POST', { content: 'secret nested comment' });
  assert.equal(comment.response.status, 200);
  const update = await call(f, `/v1/items/${itemId}/notes/${nid}`, 'PUT', { content: 'edited secret note' }); assert.equal(update.response.status, 200);
  const notes = await call(f, `/v1/items/${itemId}/notes/${nid}/comments`); assert.equal(notes.data.data[0].content, 'secret nested comment');
  assert.equal((await call(f, `/v1/items/${itemId}`, 'PATCH', { isPriority: false, status: 'complete' })).response.status, 200);
  assert.equal((await call(f, '/v1/items/priority')).data.data.length, 0);
  assert.equal((await call(f, '/v1/search?q=edited%20secret&include_notes=true')).data.totalResults, 1);
  assert.ok(!JSON.stringify(f.calls).includes('edited secret note'));
});

test('exports escape text, render locally and never retry ambiguous email sends', async () => {
  const f = await fixture();
  const htmlResponse = await f.wrapped(`${base}/v1/lists/${listId}/export`, { method: 'POST', headers, body: JSON.stringify({ format: 'html' }) });
  const html = await htmlResponse.text(); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  const jsonExport = await call(f, `/v1/items/${itemId}/export`, 'POST', { format: 'json' });
  assert.match(jsonExport.data.data.lists[0].items[0].content, /Private task/);
  assert.ok(!f.calls.some(c => c.path.includes('/export')));
  f.setAmbiguousEmail();
  const emailed = await call(f, `/v1/items/${itemId}/export/email`, 'POST', { toEmail: 'synthetic@example.test' });
  assert.equal(emailed.response.status, 503); assert.equal(emailed.data.outcome, 'unknown'); assert.equal(emailed.data.retrySafe, false);
  const emailCalls = f.calls.filter(c => c.path.endsWith('/export/email')); assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].body.listId, listId); assert.ok(emailCalls[0].body.clientHtml.includes('&lt;script&gt;'));
});

test('partial compound writes tell the caller what succeeded instead of claiming success', async () => {
  const f = await fixture(); f.setFail(`/v1/crypto/v1/raw-content/items/${itemId}/structural`);
  const updated = await call(f, `/v1/items/${itemId}`, 'PATCH', { content: 'saved content', isPriority: true });
  assert.equal(updated.response.status, 503); assert.equal(updated.data.partial, true); assert.equal(updated.data.completedOperations, 1);
  assert.equal(openField(f.rawItems.get(itemId)!.content, f.listBytes, listId, itemId, ['content']), 'saved content');
});

test('attachments upload encrypted bytes and original names using raw media receipts', async () => {
  const f = await fixture();
  const fileBytes = Buffer.from('private synthetic attachment body');
  const form = new FormData(); form.append('file', new File([fileBytes], 'secret filename.txt', { type: 'text/plain' }));
  const response = await f.wrapped(`${base}/v1/items/${itemId}/attachments`, { method: 'POST', headers: { 'X-API-Key': headers['X-API-Key'] }, body: form });
  assert.equal(response.status, 200);
  const embedded = f.calls.find(c => c.path.endsWith('/embedded'))!;
  assert.equal(embedded.body.target, 'itemAttachments');
  assert.equal(openField(embedded.body.child.originalName, f.listBytes, listId, itemId, ['attachments', embedded.body.child.id, 'originalName']), 'secret filename.txt');
  const media = await openContentMedia(f.key, { ownerAccountId: userId, ownerUserId: userId, environment, listId, keyId, target: 'item_attachment', stableId: embedded.body.child.id, itemId }, f.mediaBytes()!);
  assert.equal(Buffer.from(media.bytes).toString(), fileBytes.toString()); assert.equal(media.name, 'secret filename.txt'); media.bytes.fill(0);
  assert.ok(!JSON.stringify(f.calls).includes('secret filename.txt')); assert.ok(!JSON.stringify(f.calls).includes(fileBytes.toString()));
});

test('untrusted hosts and insecure endpoints cannot receive an API key', async () => {
  let sent = 0;
  const wrapped = createSkillFetch((async () => { sent++; return ok({}); }) as typeof nodeFetch);
  assert.equal((await wrapped('https://attacker.invalid/v1/lists', { headers })).status, 400);
  assert.equal((await wrapped('http://api.mylister.dev/v1/lists', { headers })).status, 400);
  assert.equal(sent, 0);
});

test('invalid persisted private identity never triggers a legacy fallback', async () => {
  const corruptedBase = 'https://corrupt-identity.example';
  const previous = process.env.LISTER_BASE_URL; process.env.LISTER_BASE_URL = corruptedBase;
  try {
    await loadOrCreateIdentity(corruptedBase, 'corrupt-key');
    const scope = createHash('sha256').update(JSON.stringify([corruptedBase, createHash('sha256').update('corrupt-key').digest('hex')])).digest('hex');
    assert.ok((await readdir(join(directory, 'identities'))).includes(`${scope}.json`));
    await writeFile(join(directory, 'identities', `${scope}.json`), '{}');
    let sent = 0; const wrapped = createSkillFetch((async () => { sent++; return ok({}); }) as typeof nodeFetch);
    assert.equal((await wrapped(`${corruptedBase}/v1/lists`, { headers: { 'X-API-Key': 'corrupt-key' } })).status, 423); assert.equal(sent, 0);
  } finally { process.env.LISTER_BASE_URL = previous; }
});

test('moves reseal content and children for the destination and preserve completed note status', async () => {
  const f = await fixture(); const target = '000000000000000000000099'; await f.addList(target);
  const note = await call(f, `/v1/items/${itemId}/notes`, 'POST', { content: 'Completed private note' });
  await call(f, `/v1/items/${itemId}/notes/${note.data.data.id}/status`, 'PATCH', { status: 'complete' });
  const moved = await call(f, `/v1/items/${itemId}/move`, 'POST', { targetListId: target });
  assert.equal(moved.response.status, 200); assert.ok(!f.rawItems.has(itemId));
  const iid = moved.data.data.id, destination = f.rawItems.get(iid)!;
  assert.equal(destination.listId, target);
  assert.match(openField(destination.content, f.listBytes, target, iid, ['content']), /Private task/);
  const n = destination.notes[0];
  assert.equal(openField(n.content, f.listBytes, target, iid, ['notes', n.id, 'content']), 'Completed private note');
  assert.equal(n.status, 'complete');
  const createIndex = f.calls.findIndex(c => c.path.endsWith('/raw-content/items') && c.method === 'POST');
  const deleteIndex = f.calls.findIndex(c => c.path.endsWith(`/items/${itemId}`) && c.method === 'DELETE');
  assert.ok(deleteIndex > createIndex);
});

test('failed source deletion rolls back only the newly created destination', async () => {
  const f = await fixture(); const target = '000000000000000000000099'; await f.addList(target); f.rejectDelete();
  const moved = await call(f, `/v1/items/${itemId}/move`, 'POST', { targetListId: target });
  assert.equal(moved.response.status, 409); assert.ok(f.rawItems.has(itemId));
  assert.equal([...f.rawItems.values()].filter(i => i.listId === target).length, 0);
});

test('a lost source-delete reply retains destination and reports review required', async () => {
  const f = await fixture(); const target = '000000000000000000000099'; await f.addList(target); f.setAmbiguousDelete();
  const moved = await call(f, `/v1/items/${itemId}/move`, 'POST', { targetListId: target });
  assert.equal(moved.response.status, 409); assert.equal(moved.data.partial, true);
  assert.ok(!f.rawItems.has(itemId)); assert.ok(f.rawItems.has(moved.data.destinationItemId));
});

test('encrypted sharing issues only an opaque recipient key transfer and reports recipient acceptance', async () => {
  const f = await fixture();
  const shared = await call(f, `/v1/lists/${listId}/share`, 'POST', { userId: '000000000000000000000077', permission: 'read' });
  assert.equal(shared.response.status, 200); assert.equal(shared.data.data.recipientAcceptanceRequired, true);
  assert.ok(f.calls.some(c => c.path === '/v1/crypto/v1/collaborator-key-transfers'));
  assert.ok(!JSON.stringify(f.calls).includes(f.listBytes.toString('base64url')));
});

test('an existing list type change and legacy file URL return explicit unsupported errors', async () => {
  const f = await fixture();
  const updated = await call(f, `/v1/lists/${listId}`, 'PUT', { type: 'project' });
  assert.equal(updated.response.status, 501); assert.match(updated.data.detail, /creation/);
  assert.ok(!f.calls.some(c => c.method === 'PUT'));
  const file = await call(f, '/v1/files/synthetic-private-key/url'); assert.equal(file.response.status, 501);
  assert.ok(!f.calls.some(c => c.path.includes('/v1/files/')));
});

test('the API offset ceiling fails explicitly without returning or exporting a truncated list', async () => {
  const f = await fixture({ items: 1100 });
  const response = await call(f, `/v1/lists/${listId}/items`);
  assert.equal(response.response.status, 413); assert.match(response.data.detail, /paging limit/); assert.equal(response.data.data, undefined);
  assert.ok(!f.calls.some(c => /itemOffset=(?:1100|1200)/.test(c.path)));
});

test('moving an attachment opens and reseals its media under the new item and list scope', async () => {
  const f = await fixture(); const target = '000000000000000000000099'; await f.addList(target);
  const stable = 'c'.repeat(24), mediaId = 'd'.repeat(24), privateBytes = new Uint8Array(Buffer.from('private move media'));
  const name = await sealContent('Private moved attachment.txt', f.key, { accountId: userId, userId, environment, listId, keyId, collection: 'items', recordId: itemId, path: ['attachments', stable, 'originalName'], schemaVersion: 3 });
  f.rawItems.get(itemId)!.attachments = [{ id: stable, originalName: name, fileKey: mediaId }];
  const encrypted = await sealContentMedia(f.key, { ownerAccountId: userId, ownerUserId: userId, environment, listId, keyId, target: 'item_attachment', stableId: stable, itemId }, { bytes: privateBytes, name: 'Private moved attachment.txt', contentType: 'text/plain' });
  f.mediaStore.set(mediaId, encrypted);
  const moved = await call(f, `/v1/items/${itemId}/move`, 'POST', { targetListId: target });
  assert.equal(moved.response.status, 200);
  const iid = moved.data.data.id, attachment = f.rawItems.get(iid)!.attachments[0];
  assert.notEqual(attachment.fileKey, mediaId);
  const opened = await openContentMedia(f.key, { ownerAccountId: userId, ownerUserId: userId, environment, listId: target, keyId, target: 'item_attachment', stableId: stable, itemId: iid }, f.mediaStore.get(attachment.fileKey)!);
  assert.equal(Buffer.from(opened.bytes).toString(), 'private move media');
  assert.equal(moved.data.data.attachments[0].fileKey, attachment.fileKey);
  assert.ok(!JSON.stringify(f.calls).includes('private move media')); assert.ok(!JSON.stringify(f.calls).includes('Private moved attachment.txt'));
  opened.bytes.fill(0); privateBytes.fill(0);
});

test('new text expands UI shortcuts once without re-expanding saved sibling notes', async () => {
  const f = await fixture(); f.context.settings = { timezone: 'UTC', shortcuts: [{ key: 'sig', value: 'literal $& @other' }] };
  const first = await call(f, `/v1/items/${itemId}/notes`, 'POST', { content: '@sig @time 104' });
  assert.equal(first.response.status, 200); assert.match(first.data.data.content, /^literal \$& @other \d\d:\d\d 104$/);
  const second = await call(f, `/v1/items/${itemId}/notes`, 'POST', { content: 'sibling' });
  f.context.settings.shortcuts = [{ key: 'other', value: 'must not expand stored sibling' }];
  await call(f, `/v1/items/${itemId}/notes/${second.data.data.id}`, 'PUT', { content: 'edited sibling' });
  const note = (await call(f, `/v1/items/${itemId}/notes`)).data.data.find((n: Obj) => n.id === first.data.data.id);
  assert.match(note.content, /^literal \$& @other /); assert.ok(!note.content.includes('must not expand'));
});

test('node-fetch Request input preserves method, headers and body and returns a node-fetch Response', async () => {
  const f = await fixture();
  const request = new Request(`${base}/v1/lists/${listId}/items`, { method: 'POST', headers, body: JSON.stringify({ content: 'Request object private task', type: 'text' }) });
  const response = await f.wrapped(request);
  assert.ok(response instanceof Response); assert.equal(response.status, 200);
  const data = await response.json() as Obj; assert.equal(data.data.content, 'Request object private task');
  assert.ok(!JSON.stringify(f.calls).includes('Request object private task'));
});

test('nested projections never forward text belonging to another protected child kind', async () => {
  const f = await fixture();
  const response = await call(f, `/v1/lists/${listId}/items`, 'POST', { content: 'safe task', notes: [{ content: 'safe note', originalName: 'never transmit note extra text' }],
    attachments: [{ id: 'safe-attachment', originalName: 'private name', content: 'never transmit attachment extra text' }] });
  assert.equal(response.response.status, 200);
  const create = f.calls.find(c => c.path === '/v1/crypto/v1/raw-content/items' && c.method === 'POST')!;
  assert.equal(create.body.ciphertext.notes[0].originalName, undefined); assert.equal(create.body.ciphertext.attachments[0].content, undefined);
  assert.ok(!JSON.stringify(f.calls).includes('never transmit')); assert.ok(!JSON.stringify(f.calls).includes('private name'));
});
