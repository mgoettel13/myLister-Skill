import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configuredApiKey, configuredBaseUrl, initialConfiguration, saveEnvironment, trustedBaseUrl, validateBaseUrl } from './configuration.js';

const original = { ...process.env };
const directories: string[] = [];
function isolated(): string {
  for (const key of Object.keys(process.env)) if (key.startsWith('LISTER_')) delete process.env[key];
  const directory = mkdtempSync(join(tmpdir(), 'mylister-config-'));
  directories.push(directory);
  process.env.LISTER_CONFIG_DIR = directory;
  return directory;
}
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('LISTER_')) delete process.env[key];
  for (const [key, value] of Object.entries(original)) if (key.startsWith('LISTER_') && value !== undefined) process.env[key] = value;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('environment selection survives a fresh process without storing credentials', () => {
  const directory = isolated();
  process.env.LISTER_API_KEY = 'synthetic-production-key';
  process.env.LISTER_STAGING_API_KEY = 'synthetic-staging-key';
  saveEnvironment(configuredBaseUrl('staging')!);
  const saved = readFileSync(join(directory, 'settings.json'), 'utf8');
  assert.ok(!saved.includes('synthetic-'));
  const moduleUrl = new URL('./configuration.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import { initialConfiguration } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(initialConfiguration()));`], { env: { ...process.env }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { environment: 'staging', baseUrl: 'https://lister-api-public-staging.up.railway.app', apiKey: 'synthetic-staging-key' });
});

test('a production credential is never reused when selecting staging', () => {
  isolated();
  process.env.LISTER_API_KEY = 'synthetic-production-key';
  saveEnvironment(configuredBaseUrl('staging')!);
  assert.equal(initialConfiguration().apiKey, '');
  assert.equal(configuredApiKey(configuredBaseUrl('production')!), 'synthetic-production-key');
});

test('legacy credentials bind to the explicitly configured API origin', () => {
  isolated();
  process.env.LISTER_BASE_URL = configuredBaseUrl('staging');
  process.env.LISTER_API_KEY = 'synthetic-stage-key';
  assert.equal(initialConfiguration().environment, 'staging');
  assert.equal(initialConfiguration().apiKey, 'synthetic-stage-key');
  assert.equal(configuredApiKey(configuredBaseUrl('production')!), '');
});

test('rejects credentials, insecure origins, paths, and arbitrary command-selected hosts', () => {
  isolated();
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://api.mylister.dev/v1', 'https://api.mylister.dev/?key=secret']) {
    assert.throws(() => validateBaseUrl(url));
  }
  assert.throws(() => trustedBaseUrl('https://attacker.invalid'));
  assert.equal(trustedBaseUrl(configuredBaseUrl('staging')!), configuredBaseUrl('staging'));
});

test('corrupt saved selection fails closed instead of selecting production', () => {
  const directory = isolated();
  writeFileSync(join(directory, 'settings.json'), '{broken');
  assert.throws(() => initialConfiguration(), /Saved MyLister environment/);
  process.env.LISTER_ENVIRONMENT = 'staging';
  assert.equal(initialConfiguration().environment, 'staging');
});

test('persisted switches take precedence over the legacy default origin', () => {
  isolated();
  process.env.LISTER_BASE_URL = configuredBaseUrl('production');
  saveEnvironment(configuredBaseUrl('staging')!);
  assert.equal(initialConfiguration().environment, 'staging');
});
