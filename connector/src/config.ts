export interface ConnectorConfig {
  issuer: URL;
  resource: URL;
  consentUrl: URL;
  apiBase: URL;
  privateApiBase: URL;
  allowedRedirects: string[];
  allowLoopback: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  sharedSecret: string;
  encryptionKey: string;
  mongoUrl: string;
  mongoDatabase: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const url = (name: string, internal = false): URL => {
    const value = new URL(required(name));
    const privateNetwork = internal && value.protocol === 'http:' && value.hostname.endsWith('.railway.internal');
    if ((value.protocol !== 'https:' && !privateNetwork) || value.username || value.password || value.search || value.hash) {
      throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
    }
    return value;
  };
  const strings = (name: string): string[] => {
    const values: unknown = JSON.parse(required(name));
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) throw new Error(`Invalid ${name}`);
    return values;
  };
  const issuer = url('CONNECTOR_PUBLIC_URL');
  if (issuer.pathname !== '/') throw new Error('CONNECTOR_PUBLIC_URL must be an origin');
  const apiBase = url('MYLISTER_PUBLIC_API_URL');
  if (apiBase.pathname !== '/') throw new Error('MYLISTER_PUBLIC_API_URL must be an origin');
  const privateApiBase = url('MYLISTER_PRIVATE_API_URL', true);
  if (privateApiBase.pathname !== '/') throw new Error('MYLISTER_PRIVATE_API_URL must be an origin');
  const allowedRedirects = strings('OAUTH_ALLOWED_REDIRECT_URIS');
  if (!allowedRedirects.length) throw new Error('At least one OAuth callback must be registered');
  for (const redirect of allowedRedirects) {
    const parsed = new URL(redirect);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('OAuth callbacks must be HTTPS without credentials or fragments');
  }
  const sharedSecret = required('MYLISTER_CONNECTOR_SECRET');
  if (Buffer.byteLength(sharedSecret) < 32) throw new Error('Connector shared secret must have at least 32 bytes');
  const allowedHosts = [issuer.host];
  if (env.RAILWAY_PRIVATE_DOMAIN) allowedHosts.push(`${env.RAILWAY_PRIVATE_DOMAIN}:${env.PORT ?? '8080'}`);
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    issuer, resource: new URL('/mcp', issuer), consentUrl: url('MYLISTER_CONSENT_URL'),
    apiBase, privateApiBase, allowedRedirects, allowedHosts, allowLoopback: env.OAUTH_ALLOW_LOOPBACK_CALLBACKS === 'true',
    allowedOrigins: env.MCP_ALLOWED_ORIGINS ? strings('MCP_ALLOWED_ORIGINS') : [],
    sharedSecret, encryptionKey: required('CREDENTIAL_ENCRYPTION_KEY'), mongoUrl: required('MONGODB_URL'),
    mongoDatabase: required('MONGODB_DATABASE'), port,
  };
}
