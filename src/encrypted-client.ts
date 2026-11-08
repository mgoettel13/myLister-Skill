import { createHash, randomUUID } from 'node:crypto';
import nodeFetch, { Headers, Request, Response, type RequestInit } from 'node-fetch';
import { loadIdentity } from './identity.js';
import { trustedBaseUrl } from './configuration.js';
import { unwrapKeyBytes, keyEnvelopeAdditionalData } from './crypto/keyEnvelope.js';
import { createCollaboratorKeyTransfer } from './crypto/collaboratorKeyTransfer.js';
import {
  generateListKey, openContent, sealContent, unwrapAccountKey, unwrapListKey, wrapListKey,
  sealContentMedia, openContentMedia,
  type ContentScope, type ContentMediaScope, type KeyEnvelope,
} from './encryption.js';

type Fetch = typeof nodeFetch;
type Obj = Record<string, any>;
const CRYPTO = '/v1/crypto/v1';
const RAW = `${CRYPTO}/raw-content`;
const SETUP = 'Set up encryption for this API key on this installation, approve it in MyLister Settings > API keys, then retry. Private content was not sent.';
const MAX_PAGES = 1000;
const MAX_CHILDREN = 500;
const roots = new Map<string, { binding: string; key: CryptoKey }>();

/** Drop in-memory root handles after changing account or installation configuration. */
export function clearSkillFetchCache(): void { roots.clear(); }

class ClientError extends Error {
  constructor(public status: number, message: string, public details?: Obj) { super(message); }
}
function fail(message: string, status = 400): never { throw new ClientError(status, message); }
function object(value: any): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid content response.', 502);
  return value;
}
function id(value: any): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail('A valid record ID is required.');
  return value;
}
function childId(value: any): string {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) fail('A valid child ID is required.');
  return value;
}
function pick(value: Obj, keys: readonly string[]): Obj {
  return Object.fromEntries(keys.filter(k => Object.hasOwn(value, k) && value[k] !== undefined).map(k => [k, value[k]]));
}
function only(value: Obj, keys: readonly string[]): void {
  if (Object.keys(value).some(k => !keys.includes(k))) fail('This private operation contains unsupported fields; nothing was sent.');
}
function json(value: any, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function unwrap(value: any): any { return value?.data ?? value; }
function escaped(value: any): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function envelopeFingerprint(envelope: KeyEnvelope): string {
  return createHash('sha256').update(JSON.stringify({ aad: envelope.aad, algorithm: envelope.algorithm, ciphertext: envelope.ciphertext, iv: envelope.iv, version: envelope.version })).digest('hex');
}
/** Portable reuse of UI utils/contentVariables.ts; expand submitted text only. */
function replaceContentVariables(text: string, settings: Obj = {}, now = new Date()): string {
  const boundary = '(?![\\p{L}\\p{N}_-])';
  const custom = new Map<string, string>();
  for (const shortcut of Array.isArray(settings.shortcuts) ? settings.shortcuts : []) {
    if (typeof shortcut?.key === 'string' && shortcut.key && typeof shortcut.value === 'string') custom.set(shortcut.key.toLowerCase(), shortcut.value);
  }
  let resolved = text;
  if (custom.size) {
    const keys = [...custom.keys()].sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    resolved = resolved.replace(new RegExp(`@(${keys.join('|')})${boundary}`, 'giu'), (_match, key: string) => custom.get(key.toLowerCase())!);
  }
  const builtins = new RegExp(`@(date|today|time|now|d|t)${boundary}`, 'giu');
  if (!new RegExp(builtins.source, 'iu').test(resolved)) return resolved;
  const options: Intl.DateTimeFormatOptions = { timeZone: typeof settings.timezone === 'string' && settings.timezone ? settings.timezone : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', options); }
  catch { formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { ...options, timeZone: 'UTC' }); }
  const parts = formatter.formatToParts(now), part = (type: string) => parts.find(p => p.type === type)!.value;
  const date = `${part('day')}.${part('month')}.${part('year')}`, time = `${part('hour')}:${part('minute')}`;
  return resolved.replace(builtins, (_match, variable: string) => ['t', 'time'].includes(variable.toLowerCase()) ? time : variable.toLowerCase() === 'now' ? `${date} ${time}` : date);
}
function safeBase(input: string): { base: string; url: URL; path: string } {
  const url = new URL(input);
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:'))) fail('API credentials require HTTPS.');
  const match = url.pathname.match(/^(.*?)\/v1(?:\/|$)/);
  if (!match) fail('Only MyLister API routes are supported.');
  const base = `${url.origin}${match[1]}`;
  try { trustedBaseUrl(base); } catch { fail('Untrusted API endpoint. Configure LISTER_BASE_URL before transmitting credentials.'); }
  return { base, url, path: url.pathname.slice(match[1].length) };
}

/** All network calls retain node-fetch bodies/responses and reject redirects before credentials leave. */
export function createSkillFetch(baseFetch: Fetch): Fetch {
  const keyOrigins = new Map<string, string>();
  return (async (input: any, init: RequestInit = {}) => {
    try {
      if (input instanceof Request) {
        const request = new Request(input, init);
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.headers.get('content-type')?.startsWith('multipart/form-data') ? await request.formData() : await request.text();
        init = { ...init, method: request.method, headers: request.headers, signal: request.signal, body };
        input = request.url;
      }
      const source = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const { base, url, path } = safeBase(source);
      const headers = new Headers(init.headers ?? input?.headers);
      const apiKey = headers.get('x-api-key') ?? '';
      const scope = createHash('sha256').update(`${base}\0${apiKey}`).digest('hex');
      if (apiKey) {
        const digest = createHash('sha256').update(apiKey).digest('hex');
        const pinned = keyOrigins.get(digest);
        if (pinned && pinned !== base) fail('This API key is already bound to another endpoint.');
        keyOrigins.set(digest, base);
      }
      const secured = { ...init, headers, redirect: 'error' as const };
      const identity = apiKey ? await loadIdentity(base, apiKey) : undefined;
      if (!identity) {
        if (['/v1/health', '/v1/version'].includes(path) && (init.method ?? input?.method ?? 'GET').toUpperCase() === 'GET') return baseFetch(input, secured);
        return json({ detail: SETUP }, 423);
      }
      const transport = new EncryptedTransport(baseFetch, base, apiKey, scope, init.signal ?? undefined);
      await transport.unlock(identity);
      return await transport.dispatch(path, url.searchParams, (init.method ?? input?.method ?? 'GET').toUpperCase(), init.body);
    } catch (error) {
      if (error instanceof ClientError) return json({ detail: error.message, ...error.details }, error.status);
      // Crypto/storage errors must never fall through into a plaintext request.
      return json({ detail: `Private content could not be processed. Check this installation's encryption setup and retry. ${SETUP}` }, 423);
    }
  }) as Fetch;
}

class EncryptedTransport {
  private context!: Obj;
  private root!: CryptoKey;
  private routes = new Map<string, Obj>();
  private keys = new Map<string, CryptoKey>();
  private envelopes = new Map<string, KeyEnvelope>();
  private discovery?: Obj[];
  constructor(private fetch: Fetch, private base: string, private apiKey: string, private cacheScope: string, private signal?: RequestInit['signal']) {}

  private async response(path: string, method = 'GET', body?: any): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(`${this.base}${path}`, {
        method, redirect: 'error', signal: this.signal,
        size: path === `${CRYPTO}/raw-media/read` ? 52 * 1024 * 1024 : 32 * 1024 * 1024,
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ClientError(503, method === 'GET' ? 'Private API unavailable; retry the read.' : 'The operation outcome is unknown. Read the current state before retrying; the request may have succeeded.', { outcome: 'unknown', retrySafe: method === 'GET' });
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(this.base).origin)) fail('The API attempted to redirect credentials.', 502);
    return response;
  }
  private async request(path: string, method = 'GET', body?: any): Promise<any> {
    const response = await this.response(path, method, body);
    const text = await response.text();
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) fail('Private API response exceeded the size limit.', 502);
    let value: any;
    try { value = JSON.parse(text); } catch { fail('Private API returned an invalid response.', 502); }
    if (!response.ok || value?.success === false) {
      const message = response.status === 423 ? SETUP : response.status === 409 ? 'The content changed. Read it again before retrying.' : `Private API request failed (${response.status}).`;
      throw new ClientError(response.status >= 400 ? response.status : 502, message,
        method !== 'GET' && response.status >= 500 ? { outcome: 'unknown', retrySafe: false } : undefined);
    }
    return unwrap(value);
  }
  async unlock(identity: Awaited<ReturnType<typeof loadIdentity>>): Promise<void> {
    const context = object(await this.request('/v1/skill/context'));
    const encryption = object(context.encryption);
    if (!identity || encryption.status !== 'active' || encryption.installationId !== identity.installationId
      || encryption.userId !== context.userId || encryption.environment !== context.environment
      || context.accountId !== context.userId || encryption.accountKeyId !== 'account-key-v1') fail(SETUP, 423);
    if (['crv', 'kty', 'x', 'y'].some(k => encryption.publicKey?.[k] !== (identity.publicKey as any)[k])) fail(SETUP, 423);
    const binding = JSON.stringify([context.userId, context.environment, encryption]);
    const previous = roots.get(this.cacheScope);
    this.root = previous?.binding === binding ? previous.key : await unwrapAccountKey(encryption.accountKeyEnvelope, identity, {
      environment: context.environment, userId: context.userId, accountKeyId: 'account-key-v1',
    });
    if (roots.size > 32) roots.clear();
    roots.set(this.cacheScope, { binding, key: this.root });
    this.context = context;
  }
  private async lists(): Promise<Obj[]> {
    if (this.discovery) return this.discovery;
    const lists: Obj[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = object(await this.request(`${RAW}/lists?includeArchived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      if (!Array.isArray(result.lists)) fail('Invalid private list index.', 502);
      for (const row of result.lists) {
        id(row.id);
        if (ids.has(row.id)) fail('The list index repeated a record.', 502);
        ids.add(row.id); lists.push(row);
      }
      if (!result.hasMore) { this.discovery = lists; return lists; }
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) fail('The list index did not finish paging.', 502);
      cursor = result.nextCursor; cursors.add(cursor);
    }
    fail('The list index exceeded the paging limit.', 502);
  }
  private async route(listId: string): Promise<Obj> {
    id(listId);
    if (this.routes.has(listId)) return this.routes.get(listId)!;
    const manifest = object(await this.request(`${CRYPTO}/content-route-manifest`, 'POST', { listIds: [listId] }));
    const route = manifest.decisions?.[0];
    if (manifest.routeManifestVersion !== 1 || manifest.requestedCount !== 1 || manifest.decisionCount !== 1
      || manifest.decisions.length !== 1 || route?.listId !== listId || route.route !== 'client' || route.reason !== 'ready'
      || ![1, 2, 3].includes(route.schemaVersion) || route.viewerUserId !== this.context.userId) fail('The private list route is unavailable. No plaintext fallback was attempted.', 423);
    id(route.keyId); id(route.ownerAccountId); id(route.ownerUserId);
    if (typeof route.authoritativeRevision !== 'string' || typeof route.membershipGrantId !== 'string'
      || !Number.isSafeInteger(route.activationVersion) || !Number.isSafeInteger(route.ownerManifestEpoch)
      || !Number.isSafeInteger(route.viewerEnvelopeVersion) || !/^[0-9a-f]{64}$/.test(route.viewerEnvelopeFingerprint)) fail('Invalid private route binding.', 502);
    const batch = object(await this.request(`${RAW}/list-key-envelopes`, 'POST', { routeManifest: manifest }));
    const envelope = batch.envelopes?.find((e: Obj) => e.listId === listId);
    if (!envelope || envelope.keyId !== route.keyId || envelope.envelopeVersion !== 1 || envelope.transportVersion !== 1
      || envelope.version !== route.viewerEnvelopeVersion || envelopeFingerprint(envelope.envelope) !== route.viewerEnvelopeFingerprint) fail('The private list key is unavailable or changed. Read the list again.', 423);
    const key = await unwrapListKey(envelope.envelope, this.root, { accountId: this.context.userId, userId: this.context.userId, listId, keyId: route.keyId });
    this.envelopes.set(listId, envelope.envelope);
    this.routes.set(listId, route); this.keys.set(listId, key);
    return route;
  }
  private query(route: Obj): string {
    const values = { routeManifestVersion: 1, ...pick(route, ['authoritativeRevision', 'route', 'schemaVersion', 'keyId', 'activationVersion', 'ownerManifestEpoch', 'membershipGrantId', 'viewerUserId', 'viewerEnvelopeVersion', 'viewerEnvelopeFingerprint']) };
    return new URLSearchParams(Object.entries(values).map(([k, v]) => [k, String(v)])).toString();
  }
  private scope(route: Obj, collection: string, recordId: string, path: string[]): ContentScope {
    return { accountId: route.ownerAccountId, userId: route.ownerUserId, environment: this.context.environment, listId: route.listId, keyId: route.keyId, collection, recordId, path, schemaVersion: route.schemaVersion };
  }
  private marker(route: Obj): Obj { return { v: route.schemaVersion, keyId: route.keyId }; }
  private validateRecord(row: Obj, route: Obj): void {
    if (row._contentEncryption?.v !== route.schemaVersion || row._contentEncryption?.keyId !== route.keyId
      || (row.listId !== undefined && row.listId !== route.listId)) fail('The private record does not match its list.', 502);
    if (typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)) || !Number.isSafeInteger(row.contentRevision) || row.contentRevision < 0) fail('Invalid private revision.', 502);
  }
  private async text(value: any, route: Obj, collection: string, recordId: string, path: string[], mode: 'open' | 'seal'): Promise<any> {
    if (value === undefined || value === null) return value;
    const key = this.keys.get(route.listId)!;
    const scope = this.scope(route, collection, recordId, path);
    if (mode === 'seal') {
      if (typeof value !== 'string') fail('Protected text must be a string.');
      if (Buffer.byteLength(value) > 16 * 1024 * 1024) fail('Protected text exceeds the size limit.');
      return sealContent(value, key, scope);
    }
    if (typeof value !== 'object' || value.v !== 1) fail('Private content contains an unencrypted field.', 502);
    return openContent(value, key, scope);
  }
  private async fields(row: Obj, route: Obj, collection: 'lists' | 'items', mode: 'open' | 'seal'): Promise<Obj> {
    if (mode === 'open' && (collection === 'lists' ? typeof row.name !== 'object' || row.name === null : row.content === undefined)) fail('The private record is missing required ciphertext.', 502);
    const result = { ...row };
    const recordId = row.id;
    const convert = (v: any, path: string[]) => this.text(v, route, collection, recordId, path, mode);
    if (collection === 'lists') {
      for (const field of ['name', 'description', 'imageDescription']) if (field in row) result[field] = await convert(row[field], [field]);
      return result;
    }
    if ('content' in row) result.content = await convert(row.content, ['content']);
    if (row.metadata) {
      result.metadata = mode === 'seal' ? pick(row.metadata, ['imageDescription', 'aiDescription', 'transcription', 'originalVoiceUrl']) : { ...row.metadata };
      for (const field of ['imageDescription', 'aiDescription', 'transcription', 'originalVoiceUrl']) if (field in row.metadata) result.metadata[field] = await convert(row.metadata[field], ['metadata', field]);
    }
    if (row.reminder) {
      result.reminder = { ...row.reminder };
      if ('title' in row.reminder) result.reminder.title = await convert(row.reminder.title, ['reminder', 'title']);
    }
    const children = async (values: any, prefix: string[], kind: 'notes' | 'comments' | 'attachments'): Promise<any> => {
      if (!Array.isArray(values) || values.length > MAX_CHILDREN) fail('Invalid private child collection.');
      const seen = new Set<string>();
      return Promise.all(values.map(async (child: Obj) => {
        const cid = childId(child.id);
        if (seen.has(cid)) fail('Duplicate private child ID.'); seen.add(cid);
        const permitted = kind === 'attachments' ? ['id', 'originalName'] : kind === 'notes' ? ['id', 'content', 'comments', 'attachments'] : ['id', 'content', 'attachments'];
        const item = mode === 'seal' ? pick(child, permitted) : { ...child }, path = [...prefix, cid];
        const field = kind === 'attachments' ? 'originalName' : 'content';
        if (field in child) item[field] = await convert(child[field], [...path, field]);
        if (kind !== 'attachments' && child.attachments !== undefined) item.attachments = await children(child.attachments, [...path, 'attachments'], 'attachments');
        if (kind === 'notes' && child.comments !== undefined) item.comments = await children(child.comments, [...path, 'comments'], 'comments');
        return item;
      }));
    };
    for (const field of ['notes', 'comments', 'attachments'] as const) if (row[field] !== undefined) result[field] = await children(row[field], [field], field);
    if (row.latestComment) result.latestComment = (await children([row.latestComment], ['comments'], 'comments'))[0];
    return result;
  }
  private async list(listId: string): Promise<{ list: Obj; items: Obj[]; route: Obj }> {
    const route = await this.route(listId), items: Obj[] = [], seen = new Set<string>();
    let list!: Obj;
    for (let page = 0; page <= 10; page++) {
      const payload = object(await this.request(`${RAW}/lists/${listId}?itemLimit=100&itemOffset=${page * 100}&${this.query(route)}`));
      if (payload.route?.authoritativeRevision !== route.authoritativeRevision || payload.list?.id !== listId || !Array.isArray(payload.items)) fail('Invalid private list response.', 502);
      this.validateRecord(payload.list, route);
      list = await this.fields(payload.list, route, 'lists', 'open');
      for (const row of payload.items) {
        id(row.id); this.validateRecord(row, route);
        if (row.listId !== listId || seen.has(row.id)) fail('Private pagination repeated a record.', 502);
        seen.add(row.id); items.push(await this.fields(row, route, 'items', 'open'));
      }
      if (payload.items.length < 100) return { list, items, route };
    }
    fail('This list reaches the raw API paging limit (itemOffset 1000). The result is incomplete and was not returned; use MyLister to narrow the list.', 413);
  }
  private async item(itemId: string): Promise<Obj> {
    id(itemId);
    // Item IDs have no trusted parent in the legacy command surface. Resolve by
    // authorized raw discovery rather than asking a plaintext endpoint.
    for (const row of await this.lists()) {
      const detail = await this.list(row.id);
      if (detail.items.some(item => item.id === itemId)) {
        const route = detail.route;
        const payload = object(await this.request(`${RAW}/items/${itemId}?listId=${route.listId}&${this.query(route)}`));
        if (payload.item?.id !== itemId || payload.item?.listId !== route.listId) fail('The private item has the wrong parent.', 502);
        this.validateRecord(payload.item, route);
        return this.fields(payload.item, route, 'items', 'open');
      }
    }
    fail('Item not found.', 404);
  }
  private async editable(listId: string, admin = false): Promise<Obj> {
    const route = await this.route(listId);
    const row = (await this.lists()).find(row => row.id === listId);
    if (!row || (!row.isOwner && (admin ? row.permission !== 'admin' : !['edit', 'admin'].includes(row.permission)))) fail('This list is read-only for this API key.', 403);
    if (route.schemaVersion !== 3) fail('This list requires the current encryption schema before editing.', 423);
    return route;
  }
  private cas(row: Obj, route: Obj): Obj {
    this.validateRecord(row, route);
    return { routeDecision: route, expectedUpdatedAt: row.updatedAt, expectedRevision: row.contentRevision, _contentEncryption: this.marker(route) };
  }
  private async writeItem(row: Obj, patch: Obj): Promise<Obj> {
    const route = await this.editable(row.listId);
    const sealed = await this.fields({ ...patch, id: row.id }, route, 'items', 'seal');
    const result = object(await this.request(`${RAW}/items/${id(row.id)}`, 'PUT', { ...this.cas(row, route), ciphertext: pick(sealed, ['content', 'metadata', 'reminder', 'notes', 'comments', 'attachments']) }));
    return { ...row, ...patch, ...(patch.metadata ? { metadata: { ...row.metadata, ...patch.metadata } } : {}), ...result };
  }
  private async structural(row: Obj, operation: string, value: any): Promise<Obj> {
    const route = await this.editable(row.listId);
    const result = object(await this.request(`${RAW}/items/${id(row.id)}/structural`, 'PATCH', { ...this.cas(row, route), operation, value }));
    return { ...row, [operation]: value, ...result };
  }
  private async embedded(row: Obj, operation: string, target: string, options: Obj): Promise<Obj> {
    const route = await this.editable(row.listId);
    let child = options.child;
    if (child) {
      const patch = target === 'itemAttachments' ? { attachments: [child] } : target === 'notes' ? { notes: [child] } : target === 'comments' ? { comments: [child] } : { notes: [{ id: options.noteId, comments: [child] }] };
      const sealed = await this.fields({ id: row.id, ...patch }, route, 'items', 'seal');
      child = target === 'itemAttachments' ? sealed.attachments[0] : target === 'notes' ? sealed.notes[0] : target === 'comments' ? sealed.comments[0] : sealed.notes[0].comments[0];
    }
    const result = object(await this.request(`${RAW}/items/${id(row.id)}/embedded`, 'PATCH', { ...this.cas(row, route), operation, target, ...options, ...(child ? { child } : {}) }));
    return { ...row, ...result };
  }
  private async createList(body: Obj): Promise<Obj> {
    only(body, ['name', 'description', 'imageDescription', 'type', 'color', 'icon', 'permanent']);
    if (typeof body.name !== 'string' || !body.name.trim()) fail('A list name is required.');
    const idempotencyKey = randomUUID();
    const reservation = object(await this.request(`${RAW}/reservations`, 'POST', { purpose: 'list', idempotencyKey }));
    const listId = id(reservation.recordId), keyId = id(reservation.keyId);
    const route = { listId, keyId, ownerAccountId: this.context.userId, ownerUserId: this.context.userId, schemaVersion: 3 };
    const generated = await generateListKey();
    this.keys.set(listId, generated.key);
    try {
      const envelope = await wrapListKey(generated.raw, this.root, { accountId: this.context.userId, userId: this.context.userId, listId, keyId });
      const sealed = await this.fields({ ...body, id: listId }, route, 'lists', 'seal');
      const result = object(await this.request(`${RAW}/lists`, 'POST', {
        reservationId: reservation.reservationId, idempotencyKey, _contentEncryption: { v: 3, keyId },
        ciphertext: pick(sealed, ['name', 'description', 'imageDescription']), ownerEnvelope: { keyId, envelopeVersion: 1, envelope },
        accountKeyId: 'account-key-v1', ...pick(body, ['type', 'color', 'icon', 'permanent']),
      }));
      this.discovery = undefined;
      return { ...body, ...result, id: listId };
    } finally { generated.raw.fill(0); }
  }
  private async createItem(listId: string, body: Obj): Promise<Obj> {
    only(body, ['content', 'type', 'status', 'isPriority', 'project', 'reminder', 'notes', 'comments', 'metadata', 'attachments']);
    this.validateItemValues(body);
    const route = await this.editable(listId);
    if (typeof body.content !== 'string') fail('Item content is required.');
    const idempotencyKey = randomUUID();
    const reservation = object(await this.request(`${RAW}/reservations`, 'POST', { purpose: 'item', idempotencyKey }));
    const itemId = id(reservation.recordId);
    const plain: Obj = { ...body, id: itemId, listId };
    for (const field of ['notes', 'comments']) if (body[field]) plain[field] = body[field].map((child: any) => ({ ...(typeof child === 'string' ? { content: child } : child), id: child.id ?? randomUUID() }));
    // Child creation must use the server's supported structural defaults.
    const sealed = await this.fields(plain, route, 'items', 'seal');
    const result = object(await this.request(`${RAW}/items`, 'POST', {
      reservationId: reservation.reservationId, idempotencyKey, listId, routeDecision: route, _contentEncryption: this.marker(route),
      ciphertext: pick(sealed, ['content', 'metadata', 'notes', 'comments', 'attachments']), ...pick(body, ['type', 'status', 'isPriority', 'project']),
    }));
    let created: Obj = { ...plain, ...result };
    if (body.reminder) {
      try { created = await this.updateItem(created, { reminder: body.reminder }); }
      catch (error) { throw new ClientError(error instanceof ClientError ? error.status : 500, 'Item was created, but its reminder was not confirmed. Read the item before retrying.', { partial: true, itemId, listId }); }
    }
    return created;
  }
  private async updateItem(row: Obj, body: Obj): Promise<Obj> {
    only(body, ['content', 'metadata', 'reminder', 'notes', 'comments', 'attachments', 'status', 'archived', 'isPriority', 'order', 'type', 'project', 'recurrence']);
    this.validateItemValues(body);
    let updated = row, completed = 0;
    try {
      const ciphertext = pick(body, ['content', 'metadata', 'notes', 'comments', 'attachments']);
      if (Object.keys(ciphertext).length) { updated = await this.writeItem(updated, ciphertext); completed++; }
      for (const operation of ['status', 'archived', 'isPriority', 'order', 'type', 'project', 'reminder', 'recurrence']) if (operation in body) {
        let value = body[operation];
        if (operation === 'reminder' && value) {
          const route = await this.route(row.listId);
          const sealed = await this.fields({ id: row.id, reminder: value }, route, 'items', 'seal');
          value = sealed.reminder;
        }
        updated = await this.structural(updated, operation, value); completed++;
        updated[operation] = body[operation];
      }
      return updated;
    } catch (error) {
      if (completed) throw new ClientError(error instanceof ClientError ? error.status : 500, 'Some item changes were saved. Read the item before retrying the remaining changes.', { partial: true, itemId: row.id, completedOperations: completed });
      throw error;
    }
  }
  private async writeList(list: Obj, body: Obj): Promise<Obj> {
    if ('type' in body) fail('The encrypted API supports standard, notebook and project types at list creation. Changing an existing list type is not supported.', 501);
    only(body, ['name', 'description', 'imageDescription', 'color', 'icon', 'archived', 'order']);
    const route = await this.editable(list.id);
    const sealed = await this.fields({ ...body, id: list.id }, route, 'lists', 'seal');
    const result = object(await this.request(`${RAW}/lists/${id(list.id)}`, 'PUT', { ...this.cas(list, route), ciphertext: pick(sealed, ['name', 'description', 'imageDescription']), metadata: pick(body, ['color', 'icon', 'archived', 'order']) }));
    return { ...list, ...body, ...result };
  }
  private async all(includeArchived = false): Promise<Array<{ list: Obj; items: Obj[] }>> {
    const data = [];
    for (const row of await this.lists()) if (includeArchived || !row.archived) {
      const detail = await this.list(row.id);
      data.push({ list: detail.list, items: detail.items.filter(item => includeArchived || !item.archived) });
    }
    return data;
  }
  private exportHtml(name: string, groups: Array<{ list: Obj; items: Obj[] }>): string {
    const comments = (values: Obj[] = []) => values.map(c => `<p>${escaped(c.content)}</p>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escaped(name)}</title></head><body><h1>${escaped(name)}</h1>${groups.map(g => `<section><h2>${escaped(g.list.name)}</h2><p>${escaped(g.list.description)}</p>${g.items.map(item => `<article><h3>${escaped(item.content)}</h3>${comments(item.comments)}${(item.notes ?? []).map((note: Obj) => `<div><p>${escaped(note.content)}</p>${comments(note.comments)}</div>`).join('')}</article>`).join('')}</section>`).join('')}</body></html>`;
    if (Buffer.byteLength(html) > 1024 * 1024) fail('The export exceeds the 1 MiB HTML limit.');
    return html;
  }
  private async export(path: string, body: Obj, groups: Array<{ list: Obj; items: Obj[] }>, name: string, parent?: string): Promise<Response> {
    if (!path.endsWith('/email')) return body.format === 'html' ? new Response(this.exportHtml(name, groups), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }) : json({ success: true, data: { name, lists: groups, exportedAt: new Date().toISOString() } });
    only(body, ['toEmail', 'contactId', 'recipientUserId', 'theme', 'includeArchived']);
    const recipients = ['toEmail', 'contactId', 'recipientUserId'].filter(k => body[k] !== undefined);
    if (recipients.length > 1) fail('Select one email recipient.');
    const payload = { ...body, clientHtml: this.exportHtml(name, groups), exportName: name, ...(parent ? { listId: parent } : { listIds: groups.map(g => g.list.id) }) };
    // Sending email is deliberately never retried after an ambiguous response.
    return await this.response(path, 'POST', payload);
  }

  async dispatch(path: string, query: URLSearchParams, method: string, rawBody: RequestInit['body']): Promise<Response> {
    if (/^\/v1\/(?:contacts(?:\/|$)|health$|version$|members(?:\/|$))/.test(path)) {
      return this.response(`${path}${query.size ? `?${query}` : ''}`, method, rawBody ? JSON.parse(String(rawBody)) : undefined);
    }
    if (rawBody && typeof rawBody !== 'string') return this.media(path, method, rawBody as any);
    if (typeof rawBody === 'string' && Buffer.byteLength(rawBody) > 16 * 1024 * 1024) fail('The private request exceeds the 16 MiB limit.', 413);
    const body = rawBody ? object(JSON.parse(String(rawBody))) : {};
    if (/^\/v1\/(?:items\/[a-f0-9]{24}(?:\/|$)|lists\/[a-f0-9]{24}\/items$)/i.test(path) && ['POST', 'PUT', 'PATCH'].includes(method)) {
      if (typeof body.content === 'string') body.content = replaceContentVariables(body.content, this.context.settings);
      if (/^\/v1\/lists\/[^/]+\/items$/.test(path)) for (const field of ['notes', 'comments']) {
        if (Array.isArray(body[field])) body[field] = body[field].map((child: any) => typeof child === 'string' ? replaceContentVariables(child, this.context.settings) : { ...child, ...(typeof child.content === 'string' ? { content: replaceContentVariables(child.content, this.context.settings) } : {}) });
      }
    }
    const includeArchived = query.get('includeArchived') === 'true' || query.get('include_archived') === 'true' || body.includeArchived === true;
    if (path === '/v1/lists' && method === 'POST') return json({ success: true, data: await this.createList(body) });
    if (path === '/v1/lists' && method === 'GET') return json({ success: true, data: (await this.all(includeArchived)).map(g => g.list) });
    if (path === '/v1/lists/summary' && method === 'GET') return json({ success: true, data: (await this.all(includeArchived)).map(g => ({ ...g.list, itemCount: g.items.length, completedCount: g.items.filter(i => i.status === 'complete').length })) });
    if (/^\/v1\/items\/priority(?:\/export(?:\/email)?)?$/.test(path) || path === '/v1/search') {
      let groups = await this.all(includeArchived);
      if (path.startsWith('/v1/items/priority')) groups = groups.map(g => ({ ...g, items: g.items.filter(i => i.isPriority) }));
      if (path.includes('/export')) return this.export(path, body, groups, 'Priority Items');
      if (path === '/v1/search') {
        const q = (query.get('q') ?? '').normalize('NFC').toLocaleLowerCase();
        if (!q || q.length > 512) fail('Search requires 1 to 512 characters.');
        const notes = query.get('include_notes') !== 'false';
        const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50)));
        const contains = (text: any) => typeof text === 'string' && text.normalize('NFC').toLocaleLowerCase().includes(q);
        const results = groups.flatMap(g => [
          ...(contains(g.list.name) || contains(g.list.description) ? [{ ...g.list, resultType: 'list' }] : []),
          ...g.items.filter(i => contains(i.content) || contains(i.metadata?.transcription) || (notes && i.notes?.some((n: Obj) => contains(n.content)))).map(i => ({ ...i, listName: g.list.name, resultType: 'item' })),
        ]).slice(0, limit);
        return json({ success: true, data: results, totalResults: results.length });
      }
      if (method !== 'GET') fail('Unsupported priority operation.', 405);
      return json({ success: true, data: groups.flatMap(g => g.items.map(i => ({ ...i, listName: g.list.name }))) });
    }
    if (path === '/v1/lists/reorder' && method === 'PUT') {
      const order = this.order(body.order);
      const done: string[] = [];
      try { for (let n = 0; n < order.length; n++) { const g = await this.list(order[n]); await this.writeList(g.list, { order: n }); done.push(order[n]); } }
      catch (error) { if (done.length) throw new ClientError(409, 'Some lists were reordered. Read their current order before retrying.', { partial: true, completedIds: done }); throw error; }
      return json({ success: true });
    }
    const listMatch = path.match(/^\/v1\/lists\/([a-f0-9]{24})(.*)$/i);
    if (listMatch) {
      const [, listId, tail] = listMatch;
      if (tail === '/items' && method === 'POST') return json({ success: true, data: await this.createItem(listId, body) });
      if (tail === '/users' || /^\/users\/[^/]+$/.test(tail)) {
        if (method !== 'GET') await this.editable(listId, true);
        return this.response(path, method, method === 'GET' ? undefined : body);
      }
      if (tail === '/share' && method === 'POST') return this.share(listId, body);
      const detail = await this.list(listId);
      if (!tail && method === 'GET') return json({ success: true, data: detail.list });
      if (tail === '/items' && method === 'GET') return json({ success: true, data: detail.items.filter(i => includeArchived || !i.archived) });
      if (tail.startsWith('/export')) return this.export(path, body, [{ list: detail.list, items: detail.items.filter(i => includeArchived || !i.archived) }], detail.list.name);
      if ((!tail || tail === '/archive') && ['PUT', 'PATCH'].includes(method)) return json({ success: true, data: await this.writeList(detail.list, body) });
      if (!tail && method === 'DELETE') {
        const route = await this.editable(listId, true);
        return json({ success: true, data: await this.request(`${RAW}/lists/${listId}`, 'DELETE', { ...this.cas(detail.list, route), force: query.get('force') === 'true' }) });
      }
      if (tail === '/items/reorder' || tail === '/items/move-completed') {
        const order = tail.endsWith('move-completed') ? [...detail.items.filter(i => i.status !== 'complete'), ...detail.items.filter(i => i.status === 'complete')].map(i => i.id) : this.order(body.order);
        let done = 0;
        try { for (const itemId of order) { const row = detail.items.find(i => i.id === itemId); if (!row) fail('Reorder contains an item from another list.'); await this.structural(row, 'order', done++); } }
        catch (error) { if (done > 1) throw new ClientError(409, 'Item reorder was partially applied. Read the list before retrying.', { partial: true }); throw error; }
        return json({ success: true });
      }
      fail('Unsupported private list operation.', 501);
    }
    const itemMatch = path.match(/^\/v1\/items\/([a-f0-9]{24})(.*)$/i);
    if (itemMatch) {
      const [, itemId, tail] = itemMatch;
      const row = await this.item(itemId);
      if (!tail && method === 'GET') return json({ success: true, data: row });
      if (!tail && ['PATCH', 'PUT'].includes(method)) return json({ success: true, data: await this.updateItem(row, body) });
      if (!tail && method === 'DELETE') {
        const route = await this.editable(row.listId);
        return json({ success: true, data: await this.request(`${RAW}/items/${itemId}`, 'DELETE', this.cas(row, route)) });
      }
      if (tail.startsWith('/export')) return this.export(path, body, [{ list: (await this.list(row.listId)).list, items: [row] }], row.content, row.listId);
      if (tail === '/move' && method === 'POST') return json({ success: true, data: await this.move(row, id(body.targetListId)) });
      if (tail === '/image' || tail.startsWith('/attachments/')) return this.deleteMedia(row, tail, method);
      return this.child(row, tail, method, body);
    }
    fail('This route is not supported for encrypted accounts. No plaintext fallback was attempted.', 501);
  }
  private order(value: any): string[] {
    if (!Array.isArray(value) || value.length > 10000 || value.some(v => typeof v !== 'string') || new Set(value).size !== value.length) fail('Invalid reorder IDs.');
    return value;
  }
  private validateItemValues(body: Obj): void {
    if ('status' in body && !['new', 'in-progress', 'complete'].includes(body.status)) fail('Invalid item status.');
    if ('type' in body && !['text', 'voice', 'image'].includes(body.type)) fail('Invalid item type.');
    for (const field of ['isPriority', 'archived']) if (field in body && typeof body[field] !== 'boolean') fail(`Invalid ${field} value.`);
    if ('order' in body && !Number.isSafeInteger(body.order)) fail('Invalid item order.');
    if (body.project) only(object(body.project), ['startDate', 'endDate', 'assignedTo', 'assignedToContactId', 'durationMinutes']);
    if (body.reminder) {
      only(object(body.reminder), ['title', 'remindAt', 'timezone', 'sent', 'sentAt', 'recurrence', 'countRemaining', 'deliveredVia', 'createdAt']);
      if (body.reminder.recurrence) only(object(body.reminder.recurrence), ['frequency', 'interval', 'countRemaining', 'endTime', 'weekdays']);
    }
    if (body.recurrence) only(object(body.recurrence), ['frequency', 'interval', 'countRemaining', 'endTime', 'weekdays']);
  }
  private async child(row: Obj, tail: string, method: string, body: Obj): Promise<Response> {
    const segments = tail.split('/').filter(Boolean);
    const noteMode = segments[0] === 'notes';
    if (!noteMode && segments[0] !== 'comments') fail('Unsupported private item operation.', 501);
    const note = noteMode && segments[1] && segments[1] !== 'reorder' ? (row.notes ?? []).find((n: Obj) => n.id === segments[1]) : undefined;
    const noteComments = noteMode && segments[2] === 'comments';
    const target = noteComments ? 'noteComments' : noteMode ? 'notes' : 'comments';
    if (noteMode && segments[1] && segments[1] !== 'reorder' && !note) fail('Note not found.', 404);
    const values: Obj[] = noteComments ? note.comments ?? [] : row[noteMode ? 'notes' : 'comments'] ?? [];
    const entryId = noteComments ? segments[3] : segments[1];
    if (method === 'GET') {
      const value = entryId && entryId !== 'reorder' ? values.find(c => c.id === entryId) : values;
      if (value === undefined) fail('Comment or note not found.', 404);
      return json({ success: true, data: value });
    }
    if (segments.at(-1) === 'reorder') {
      const order = this.order(body.order);
      if (order.length !== values.length || order.some(cid => !values.some(c => c.id === cid))) fail('Reorder must contain every current child ID exactly once.');
      await this.embedded(row, 'reorder', target, { order, ...(noteComments ? { noteId: note.id } : {}) });
      return json({ success: true });
    }
    if (segments.at(-1) === 'status' && note) {
      if (!['new', 'complete'].includes(body.status)) fail('Invalid note status.');
      await this.embedded(row, 'status', 'notes', { childId: note.id, status: body.status });
      return json({ success: true, data: { ...note, status: body.status } });
    }
    if (method === 'POST' && !entryId) {
      only(body, ['content']);
      if (typeof body.content !== 'string') fail('Comment or note text is required.');
      const child = { id: randomUUID(), content: body.content };
      await this.embedded(row, 'add', target, { child, ...(noteComments ? { noteId: note.id } : {}) });
      return json({ success: true, data: child });
    }
    const existing = values.find(c => c.id === entryId);
    if (!existing) fail('Comment or note not found.', 404);
    if (method === 'DELETE') {
      await this.embedded(row, 'delete', target, { childId: childId(entryId), ...(noteComments ? { noteId: note.id } : {}) });
      return json({ success: true });
    }
    if (method === 'PUT' || method === 'PATCH') {
      only(body, ['content']);
      if (typeof body.content !== 'string') fail('Comment or note text is required.');
      const updated = values.map(c => c.id === entryId ? { ...c, content: body.content } : c);
      const patch = noteComments ? { notes: row.notes.map((n: Obj) => n.id === note.id ? { ...n, comments: updated } : n) } : { [noteMode ? 'notes' : 'comments']: updated };
      await this.writeItem(row, patch);
      return json({ success: true, data: { ...existing, content: body.content } });
    }
    fail('Unsupported child operation.', 405);
  }

  private mediaScope(route: Obj, binding: Obj): ContentMediaScope {
    return { ownerAccountId: route.ownerAccountId, ownerUserId: route.ownerUserId, environment: this.context.environment,
      listId: route.listId, keyId: route.keyId, ...binding } as ContentMediaScope;
  }
  private async uploadAndLink(row: Obj, binding: Obj, input: { bytes: Uint8Array; name: string; contentType: string }): Promise<Obj> {
    const route = await this.editable(row.listId);
    let ciphertext: Uint8Array | undefined;
    try {
      ciphertext = await sealContentMedia(this.keys.get(row.listId)!, this.mediaScope(route, binding), input);
      const receipt = object(await this.request(`${CRYPTO}/raw-media/upload`, 'POST', {
        routeDecision: route, ...binding, ciphertext: Buffer.from(ciphertext).toString('base64url'),
        size: ciphertext.byteLength, contentType: 'application/octet-stream', idempotencyKey: randomUUID(),
      }));
      if (receipt.target !== binding.target || receipt.size !== ciphertext.byteLength || receipt.contentType !== 'application/octet-stream') fail('Invalid encrypted media receipt.', 502);
      return object(await this.request(`${CRYPTO}/raw-media/link`, 'POST', { receiptId: receipt.receiptId,
        routeDecision: route, expectedUpdatedAt: row.updatedAt, expectedRevision: row.contentRevision }));
    } finally { ciphertext?.fill(0); }
  }
  private async media(path: string, method: string, form: any): Promise<Response> {
    if (method !== 'POST' || typeof form?.get !== 'function') fail('Invalid private file request.');
    const attachment = path.match(/^\/v1\/items\/([a-f0-9]{24})\/attachments$/i);
    const kind = path === '/v1/upload/image' ? 'image' : path === '/v1/upload/voice' ? 'voice' : attachment ? 'attachment' : undefined;
    if (!kind) fail('Unsupported private upload target.', 501);
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1 || file.size > 50 * 1024 * 1024) fail('Private files must contain 1 byte to 50 MiB.');
    if (kind === 'voice' && String(form.get('transcribe')) === 'true') fail('Automatic voice transcription is unavailable for encrypted skill uploads. No audio was uploaded.', 501);
    if (kind === 'voice' && form.get('duration') !== null) fail('Voice duration metadata is not supported by the encrypted media API. No audio was uploaded.', 501);
    const itemId = attachment?.[1] ?? form.get('item_id');
    const listId = form.get('list_id');
    if (!itemId && !listId) fail('Encrypted uploads require a target list or item.');
    let created = false;
    let row: Obj = itemId ? await this.item(id(itemId)) : await this.createItem(id(listId), { content: String(form.get('description') || file.name || kind), type: kind, status: 'new' });
    created = !itemId;
    if (listId && row.listId !== listId) fail('The upload item belongs to a different list.');
    const binding = { target: kind === 'attachment' ? 'item_attachment' : `item_${kind}`, stableId: kind === 'attachment' ? createHash('sha256').update(randomUUID()).digest('hex').slice(0, 24) : kind, itemId: row.id };
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (kind === 'attachment') row = await this.embedded(row, 'add', 'itemAttachments', { child: { id: binding.stableId, originalName: file.name || 'file' } });
      else if (kind === 'image' && form.get('description') !== null) row = await this.writeItem(row, { metadata: { imageDescription: String(form.get('description')) } });
      const result = await this.uploadAndLink(row, binding, { bytes, name: file.name || 'file', contentType: file.type || 'application/octet-stream' });
      return json({ success: true, data: { ...result, itemId: row.id, listId: row.listId, ...(kind === 'attachment' ? { attachmentId: binding.stableId } : {}) } });
    } catch (error) {
      if (created) throw new ClientError(error instanceof ClientError ? error.status : 500, 'The item was created, but its media upload was not confirmed. Read it before retrying.', { partial: true, itemId: row.id, listId: row.listId });
      throw error;
    } finally { bytes.fill(0); }
  }
  private async deleteMedia(row: Obj, tail: string, method: string): Promise<Response> {
    if (method !== 'DELETE') fail('Unsupported private media operation.', 405);
    const route = await this.editable(row.listId);
    const mediaId = tail === '/image' ? row.metadata?.imageFileId : row.attachments?.find((a: Obj) => a.id === tail.slice('/attachments/'.length))?.fileKey;
    if (!mediaId) fail('Media attachment not found.', 404);
    const result = await this.request(`${CRYPTO}/raw-media/delete`, 'POST', { mediaId: id(mediaId), routeDecision: route, expectedUpdatedAt: row.updatedAt, expectedRevision: row.contentRevision });
    return json({ success: true, data: result });
  }
  private transferMedia(row: Obj): Array<{ mediaId: string; binding: Obj }> {
    const values: Array<{ mediaId: string; binding: Obj }> = [];
    const add = (mediaId: any, target: string, stableId: string, extra: Obj = {}) => {
      if (mediaId) values.push({ mediaId: id(mediaId), binding: { target, stableId: childId(stableId), itemId: row.id, ...extra } });
    };
    if ((!row.metadata?.imageFileId && row.metadata?.imageUrl) || (!row.metadata?.voiceFileId && (row.metadata?.voiceUrl || row.metadata?.originalVoiceUrl))) fail('This item has an older media reference that cannot be moved safely.', 501);
    add(row.metadata?.imageFileId, 'item_image', 'image'); add(row.metadata?.voiceFileId, 'item_voice', 'voice');
    for (const a of row.attachments ?? []) add(id(a.fileKey), 'item_attachment', a.id);
    for (const c of row.comments ?? []) for (const a of c.attachments ?? []) add(id(a.fileKey), 'comment_attachment', a.id, { commentId: c.id });
    for (const note of row.notes ?? []) {
      const imageIds = note.imageFileIds ?? [], stableIds = note.imageStableIds ?? [];
      if (imageIds.length !== stableIds.length || (!note.voiceFileId && (note.voiceUrl || note.originalVoiceUrl))) fail('This note has an older media reference that cannot be moved safely.', 501);
      imageIds.forEach((mediaId: string, i: number) => add(mediaId, 'note_image', stableIds[i], { noteId: note.id }));
      add(note.voiceFileId, 'note_voice', 'voice', { noteId: note.id });
      for (const a of note.attachments ?? []) add(id(a.fileKey), 'note_attachment', a.id, { noteId: note.id });
      for (const c of note.comments ?? []) for (const a of c.attachments ?? []) add(id(a.fileKey), 'comment_attachment', a.id, { noteId: note.id, commentId: c.id });
    }
    return values;
  }
  private async move(row: Obj, target: string): Promise<Obj> {
    if (row.listId === target) fail('Choose a different destination list.');
    const sourceRoute = await this.editable(row.listId);
    await this.editable(target);
    const media = this.transferMedia(row);
    for (const note of row.notes ?? []) if (note.status !== undefined && !['new', 'complete'].includes(note.status)) fail('This note has an unsupported status; it cannot be moved safely.', 501);
    let destination: Obj | undefined;
    let sourceDeleteStarted = false;
    try {
      destination = await this.createItem(target, pick(row, ['content', 'type', 'status', 'isPriority', 'project', 'metadata', 'notes', 'comments', 'attachments']));
      for (const entry of media) {
        const response = await this.response(`${CRYPTO}/raw-media/read`, 'POST', { mediaId: entry.mediaId, routeDecision: sourceRoute });
        if (!response.ok) throw new ClientError(response.status, 'Source media could not be read; the source item is preserved.');
        const encrypted = new Uint8Array(await response.arrayBuffer());
        let opened: Awaited<ReturnType<typeof openContentMedia>> | undefined;
        try {
          if (encrypted.byteLength > 52 * 1024 * 1024) fail('Encrypted media exceeded the size limit.', 502);
          opened = await openContentMedia(this.keys.get(row.listId)!, this.mediaScope(sourceRoute, entry.binding), encrypted);
          const linked = await this.uploadAndLink(destination, { ...entry.binding, itemId: destination.id }, opened);
          destination = { ...destination, ...linked };
          this.applyLinkedMedia(destination, entry.binding, linked.mediaId);
        } finally { encrypted.fill(0); opened?.bytes.fill(0); }
      }
      for (const note of row.notes ?? []) {
        if (note.status === 'complete') {
          destination = await this.embedded(destination, 'status', 'notes', { childId: note.id, status: 'complete' });
          const localNote = destination.notes?.find((n: Obj) => n.id === note.id); if (localNote) localNote.status = 'complete';
        }
      }
      destination = await this.updateItem(destination, pick(row, ['reminder', 'archived', 'project']));
      sourceDeleteStarted = true;
      await this.request(`${RAW}/items/${id(row.id)}`, 'DELETE', this.cas(row, sourceRoute));
      return destination;
    } catch (error) {
      // Once delete is in flight, a lost reply may mean the source was deleted.
      // Preserve the destination in that case so cleanup cannot lose both copies.
      const ambiguousDelete = sourceDeleteStarted && (!(error instanceof ClientError)
        || error.details?.outcome === 'unknown' || error.status >= 500);
      let cleanupFailed = false;
      if (destination && !ambiguousDelete) {
        try { const route = await this.route(target); await this.request(`${RAW}/items/${id(destination.id)}`, 'DELETE', this.cas(destination, route)); }
        catch { cleanupFailed = true; }
      }
      if (ambiguousDelete || cleanupFailed) throw new ClientError(409, 'Move outcome needs review. Read both lists before retrying; a destination copy was preserved.', { partial: true, sourceItemId: row.id, destinationItemId: destination?.id });
      throw error;
    }
  }
  private applyLinkedMedia(row: Obj, binding: Obj, mediaId: string): void {
    const parent = binding.noteId ? row.notes?.find((n: Obj) => n.id === binding.noteId) : row;
    if (binding.target === 'item_image' || binding.target === 'item_voice') {
      row.metadata ??= {}; row.metadata[binding.target === 'item_image' ? 'imageFileId' : 'voiceFileId'] = mediaId;
    } else if (binding.target === 'note_image') {
      parent.imageFileIds ??= []; parent.imageStableIds ??= [];
      const index = parent.imageStableIds.indexOf(binding.stableId);
      if (index >= 0) parent.imageFileIds[index] = mediaId;
      else { parent.imageStableIds.push(binding.stableId); parent.imageFileIds.push(mediaId); }
    } else if (binding.target === 'note_voice') parent.voiceFileId = mediaId;
    else {
      const attachmentParent = binding.commentId ? parent?.comments?.find((c: Obj) => c.id === binding.commentId) : parent;
      const attachment = attachmentParent?.attachments?.find((a: Obj) => a.id === binding.stableId);
      if (attachment) attachment.fileKey = mediaId;
    }
  }
  private async share(listId: string, body: Obj): Promise<Response> {
    only(body, ['userId', 'permission']);
    const recipientId = id(body.userId);
    if (!['read', 'edit', 'admin'].includes(body.permission)) fail('Invalid sharing permission.');
    const route = await this.editable(listId, true);
    if (route.ownerUserId !== this.context.userId) fail('Only the list owner can issue an encrypted list key.', 403);
    const grant = object(await this.request(`/v1/lists/${listId}/share`, 'POST', body));
    try {
      if (grant.clientOwned !== true || typeof grant.membershipGrantId !== 'string') fail('The protected share response was incomplete.', 502);
      const exchange = grant.recipientExchangeKey ?? await this.request(`${CRYPTO}/account-exchange-key/public/${recipientId}?listId=${listId}`);
      const raw = await unwrapKeyBytes(this.envelopes.get(listId)!, this.root, keyEnvelopeAdditionalData('mylister-list-key-wrap-v1', [this.context.userId, this.context.userId, listId, route.keyId]));
      try {
        const payload = await createCollaboratorKeyTransfer(raw, {
          listId, keyId: route.keyId, ownerUserId: this.context.userId, recipientUserId: recipientId,
          membershipGrantId: grant.membershipGrantId, recipientExchangeKeyId: exchange.exchangeKeyId,
          recipientExchangeKeyVersion: exchange.version, recipientExchangeKeyFingerprint: exchange.publicKeyFingerprint,
          recipientPublicKey: exchange.publicKey,
        });
        const transfer = await this.request(`${CRYPTO}/collaborator-key-transfers`, 'POST', payload);
        return json({ success: true, data: { ...grant, keyTransfer: transfer, recipientAcceptanceRequired: true } });
      } finally { raw.fill(0); }
    } catch (error) {
      throw new ClientError(error instanceof ClientError ? error.status : 500, 'Membership was updated, but encrypted key delivery was not confirmed. Review the share before retrying.', { partial: true, listId, recipientUserId: recipientId });
    }
  }
}
