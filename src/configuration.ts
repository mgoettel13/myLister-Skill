import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ApiEnvironment = 'production' | 'staging' | 'custom';
export const PRODUCTION_BASE_URL = 'https://api.mylister.dev';
export const STAGING_BASE_URL = 'https://lister-api-public-staging.up.railway.app';

export function configurationDirectory(): string {
  if (process.env.LISTER_CONFIG_DIR) return process.env.LISTER_CONFIG_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MyListerSkill');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mylister-skill');
}

export function validateBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && process.env.LISTER_ALLOW_HTTP_LOOPBACK === '1')) {
    throw new Error('MyLister requires HTTPS. HTTP is permitted only for explicitly enabled local tests.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '')) {
    throw new Error('Configure a MyLister API origin without credentials, query, fragment, or path.');
  }
  return url.origin;
}

export function configuredBaseUrl(environment: ApiEnvironment): string | undefined {
  if (environment === 'production') return validateBaseUrl(process.env.LISTER_PRODUCTION_BASE_URL || PRODUCTION_BASE_URL);
  if (environment === 'staging') return validateBaseUrl(process.env.LISTER_STAGING_BASE_URL || process.env.LISTER_STAGING_URL || STAGING_BASE_URL);
  return process.env.LISTER_BASE_URL ? validateBaseUrl(process.env.LISTER_BASE_URL) : undefined;
}

export function environmentFor(baseUrl: string): ApiEnvironment {
  const origin = validateBaseUrl(baseUrl);
  if (origin === configuredBaseUrl('staging')) return 'staging';
  if (origin === configuredBaseUrl('production')) return 'production';
  return 'custom';
}

export function configuredApiKey(baseUrl: string): string {
  const origin = validateBaseUrl(baseUrl);
  const environment = environmentFor(origin);
  if (environment === 'staging' && process.env.LISTER_STAGING_API_KEY) return process.env.LISTER_STAGING_API_KEY;
  if (environment === 'production' && process.env.LISTER_PRODUCTION_API_KEY) return process.env.LISTER_PRODUCTION_API_KEY;
  // The legacy key belongs to the explicitly configured origin, or production.
  // An environment switch must never forward it to a different origin.
  const legacyOrigin = validateBaseUrl(process.env.LISTER_BASE_URL || configuredBaseUrl('production')!);
  return origin === legacyOrigin ? process.env.LISTER_API_KEY || '' : '';
}

export function trustedBaseUrl(value: string): string {
  const origin = validateBaseUrl(value);
  const configured = [configuredBaseUrl('production'), configuredBaseUrl('staging'), configuredBaseUrl('custom')];
  if (!configured.includes(origin)) {
    throw new Error('Configure this trusted origin with LISTER_BASE_URL in the host environment before selecting it.');
  }
  return origin;
}

export function saveEnvironment(baseUrl: string): void {
  const origin = trustedBaseUrl(baseUrl);
  const directory = configurationDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ version: 1, environment: environmentFor(origin), baseUrl: origin }) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, join(directory, 'settings.json'));
}

export function initialConfiguration(): { baseUrl: string; apiKey: string; environment: ApiEnvironment } {
  let baseUrl: string;
  if (process.env.LISTER_ENVIRONMENT) {
    const selected = process.env.LISTER_ENVIRONMENT.toLowerCase();
    if (!['production', 'staging', 'custom'].includes(selected)) throw new Error('LISTER_ENVIRONMENT must be production, staging, or custom.');
    const configured = configuredBaseUrl(selected as ApiEnvironment);
    if (!configured) throw new Error('Set LISTER_BASE_URL for the custom environment.');
    baseUrl = configured;
  } else {
    let saved: { version?: number; environment?: string; baseUrl?: string } | undefined;
    try {
      saved = JSON.parse(readFileSync(join(configurationDirectory(), 'settings.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Saved MyLister environment settings are invalid. Repair settings.json or set LISTER_ENVIRONMENT explicitly.');
      }
    }
    if (saved) {
      if (saved.version !== 1 || typeof saved.baseUrl !== 'string' || !['production', 'staging', 'custom'].includes(saved.environment || '')) {
        throw new Error('Saved MyLister environment settings are invalid. Set LISTER_ENVIRONMENT explicitly to recover.');
      }
      baseUrl = trustedBaseUrl(saved.baseUrl);
    } else baseUrl = validateBaseUrl(process.env.LISTER_BASE_URL || configuredBaseUrl('production')!);
  }
  return { baseUrl, apiKey: configuredApiKey(baseUrl), environment: environmentFor(baseUrl) };
}
