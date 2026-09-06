import { mkdir, writeFile } from 'node:fs/promises';

const source = process.argv[2] ?? 'https://lister-api-public-staging.up.railway.app/openapi.json';
const url = new URL(source);
if (url.protocol !== 'https:' || url.pathname !== '/openapi.json' || url.username || url.password) {
  throw new Error('An HTTPS OpenAPI document is required');
}
const response = await fetch(url, { redirect: 'error' });
if (!response.ok) throw new Error(`OpenAPI fetch failed (${response.status})`);
const contract = await response.json();
if (!contract.openapi?.startsWith('3.') || !Object.keys(contract.paths ?? {}).every(path => path.startsWith('/v1/'))) {
  throw new Error('Expected the API-key-only public MyLister contract');
}
await mkdir(new URL('../contracts/', import.meta.url), { recursive: true });
await writeFile(new URL('../contracts/public-openapi.json', import.meta.url), JSON.stringify(contract, null, 2) + '\n');
console.log(`Pinned ${Object.keys(contract.paths).length} public paths from ${url.origin}`);
