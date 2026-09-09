import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { annotationsFor } from './tool-annotations.js';

type Schema = Record<string, unknown>;
interface Operation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema: Schema }>;
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
}
interface Contract { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } }
interface ToolOperation { tool: Tool; method: string; path: string; multipart: boolean; validate: ValidateFunction }
const contract = JSON.parse(readFileSync(new URL('../contracts/public-openapi.json', import.meta.url), 'utf8')) as Contract;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
const fileSchema = {
  type: 'object', additionalProperties: false, required: ['filename', 'mimeType', 'base64'],
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\r\\n]+$' },
    mimeType: { type: 'string', minLength: 3, maxLength: 120, pattern: '^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$' },
    base64: { type: 'string', maxLength: 28_000_000, description: 'Base64 file bytes, without a data URL prefix.' },
  },
};

function expand(value: unknown, ancestry = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, ancestry));
  if (!value || typeof value !== 'object') return value;
  const schema = value as Schema;
  if (typeof schema.$ref === 'string') {
    const reference = schema.$ref;
    if (!reference.startsWith('#/components/schemas/') || ancestry.has(reference)) throw new Error(`Unsupported contract reference: ${reference}`);
    const target = contract.components.schemas[reference.slice('#/components/schemas/'.length)];
    if (!target) throw new Error(`Missing contract reference: ${reference}`);
    return expand(target, new Set([...ancestry, reference]));
  }
  if (schema.type === 'string' && (schema.format === 'binary' || schema.contentMediaType === 'application/octet-stream')) return fileSchema;
  return Object.fromEntries(Object.entries(schema).map(([key, item]) => [key, expand(item, ancestry)]));
}

function objectSchema(properties: Schema, required: string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const operations = new Map<string, ToolOperation>();
for (const [path, methods] of Object.entries(contract.paths)) {
  if (!path.startsWith('/v1/')) throw new Error('Only public API operations can become tools');
  for (const [method, operation] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    if (path === '/v1/') continue;
    const name = operation.operationId.split('_v1_')[0];
    if (operations.has(name)) throw new Error(`Duplicate tool name: ${name}`);
    const groups: Schema = {};
    const requiredGroups: string[] = [];
    for (const location of ['path', 'query']) {
      const parameters = (operation.parameters ?? []).filter(parameter => parameter.in === location);
      if (!parameters.length) continue;
      const required = parameters.filter(parameter => parameter.required).map(parameter => parameter.name);
      groups[location] = objectSchema(Object.fromEntries(parameters.map(parameter => [parameter.name, expand(parameter.schema)])), required);
      if (required.length) requiredGroups.push(location);
    }
    const content = operation.requestBody?.content;
    const multipart = Boolean(content?.['multipart/form-data']);
    if (content) {
      const body = content['application/json'] ?? content['multipart/form-data'];
      if (!body) throw new Error(`Unsupported request content for ${name}`);
      groups.body = expand(body.schema);
      if (operation.requestBody?.required) requiredGroups.push('body');
    }
    const inputSchema = objectSchema(groups, requiredGroups) as Tool['inputSchema'];
    const tool: Tool = {
      name, title: operation.summary,
      description: `${operation.description ?? operation.summary ?? name}\nUses ${method.toUpperCase()} ${path}.`,
      inputSchema,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mylister'] }] },
      annotations: annotationsFor(name),
    };
    operations.set(name, { tool, method: method.toUpperCase(), path, multipart, validate: ajv.compile(inputSchema) });
  }
}

const MAX_RESPONSE = 24 * 1024 * 1024;
async function boundedResponse(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('Response exceeds the connector transfer limit');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE) throw new Error('Response exceeds the connector transfer limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

function multipartBody(body: Schema): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) {
    if (value && typeof value === 'object' && 'base64' in value) {
      const file = value as { base64: string; mimeType: string; filename: string };
      const bytes = Buffer.from(file.base64, 'base64');
      if (bytes.toString('base64') !== file.base64 || bytes.length > 20 * 1024 * 1024) throw new Error('Invalid or oversized base64 file');
      form.append(name, new Blob([new Uint8Array(bytes)], { type: file.mimeType }), file.filename);
    } else if (value !== null && value !== undefined) {
      form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return form;
}

export async function callPublicTool(
  name: string, args: unknown, apiKey: string, baseUrl: URL, fetcher: typeof fetch = fetch,
): Promise<CallToolResult> {
  const operation = operations.get(name);
  if (!operation) throw new Error('Unknown MyLister tool');
  if (!operation.validate(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(operation.validate.errors)}`);
  const input = args as { path?: Record<string, string>; query?: Schema; body?: Schema };
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = String(input.path?.[key] ?? '');
    if (!value || /(^|[\\/])\.{1,2}([\\/]|$)|[\x00-\x1f\\]/.test(value)) throw new Error('Invalid path parameter');
    return encodeURIComponent(value);
  });
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/v1/')) throw new Error('Invalid public API target');
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { 'X-API-Key': apiKey };
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    if (operation.multipart) body = multipartBody(input.body);
    else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(input.body); }
  }
  const response = await fetcher(url, {
    method: operation.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(60_000),
  });
  // Never forward an API key to a redirected host. Signed download links can be returned as data.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    const target = location && new URL(location, url);
    if (operation.method !== 'GET' || !target || target.protocol !== 'https:' || target.username || target.password) throw new Error('Unexpected API redirect');
    return { content: [{ type: 'resource_link', name: 'MyLister file', uri: target.href }] };
  }
  const bytes = await boundedResponse(response);
  const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0];
  if (!response.ok) {
    // Error bodies can contain submitted content; never include request headers or credentials.
    return { isError: true,
      ...(response.status === 401 ? { _meta: { 'mcp/www_authenticate': ['Bearer error="invalid_token"'] } } : {}),
      content: [{ type: 'text', text: `MyLister API returned ${response.status}: ${bytes.toString('utf8').slice(0, 3000).replaceAll(apiKey, '[redacted]')}` }],
    };
  }
  if (mime === 'application/json' || mime.endsWith('+json') || mime.startsWith('text/')) {
    return { content: [{ type: 'text', text: bytes.toString('utf8') || 'Done.' }] };
  }
  if (mime.startsWith('image/')) return { content: [{ type: 'image', mimeType: mime, data: bytes.toString('base64') }] };
  return { content: [{ type: 'resource', resource: { uri: `mylister://download/${name}`, mimeType: mime, blob: bytes.toString('base64') } }] };
}
