import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { CredentialVault, digest, opaque } from './vault.js';
import type { GrantStore, RecordEntry } from './store.js';
import { allowedRedirect } from './redirects.js';

const ACCESS_SECONDS = 600;
const CONNECTION_SECONDS = 30 * 24 * 60 * 60;

export interface OAuthConfig {
  issuer: URL;
  resource: URL;
  consentUrl: URL;
  allowedRedirects: string[];
  allowLoopback?: boolean;
}

export class MyListerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly store: GrantStore,
    private readonly vault: CredentialVault,
    private readonly config: OAuthConfig,
    private readonly now: () => number = Date.now,
    private readonly revokeUpstream?: (userId: string, keyId: string) => Promise<void>,
  ) {
    this.clientsStore = {
      getClient: async id => {
        const record = await this.active(id, 'client');
        return record?.data.client as OAuthClientInformationFull | undefined;
      },
      registerClient: async metadata => {
        if (metadata.token_endpoint_auth_method !== 'none' || !metadata.redirect_uris.length ||
          metadata.redirect_uris.some(uri => !allowedRedirect(uri, config.allowedRedirects, config.allowLoopback))) {
          throw new InvalidClientMetadataError('Public clients require an explicitly allowed redirect URI');
        }
        if (metadata.grant_types?.some(type => !['authorization_code', 'refresh_token'].includes(type)) ||
          metadata.response_types?.some(type => type !== 'code')) {
          throw new InvalidClientMetadataError('Only authorization code and refresh token grants are supported');
        }
        const client: OAuthClientInformationFull = {
          ...metadata, client_id: opaque(), client_id_issued_at: Math.floor(this.now() / 1000),
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          scope: 'mylister', token_endpoint_auth_method: 'none',
        };
        delete client.client_secret;
        await this.put(client.client_id, 'client', { client }, 365 * 24 * 60 * 60);
        return client;
      },
    };
  }

  private async put(id: string, kind: string, data: Record<string, unknown>, seconds: number): Promise<void> {
    const expiresAt = kind === 'client' ? new Date('9999-12-31T00:00:00Z') : new Date(this.now() + seconds * 1000);
    await this.store.insert({ _id: id, kind, state: 'active', expiresAt, data,
      ...(['connection', 'client'].includes(kind) ? {} : { deleteAfter: expiresAt }),
    });
  }

  private async active(id: string, kind: string): Promise<RecordEntry | null> {
    const record = await this.store.get(id, kind);
    return record && record.state === 'active' && record.expiresAt.getTime() > this.now() ? record : null;
  }

  private scopes(scopes?: string[]): void {
    if (scopes?.some(scope => scope !== 'mylister')) throw new InvalidScopeError('Use the mylister scope');
  }

  private resource(resource?: URL): void {
    if (!resource || resource.href !== this.config.resource.href) throw new InvalidTargetError('Invalid resource');
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.scopes(params.scopes);
    this.resource(params.resource);
    if (!client.redirect_uris.includes(params.redirectUri) || !allowedRedirect(params.redirectUri, this.config.allowedRedirects, this.config.allowLoopback)) {
      throw new InvalidRequestError('Invalid redirect URI');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('S256 PKCE is required');
    const requestId = opaque();
    await this.put(digest(requestId), 'pending', {
      clientId: client.client_id, clientName: client.client_name ?? 'MyLister integration',
      redirectUri: params.redirectUri, challenge: params.codeChallenge, state: params.state,
    }, 600);
    const consent = new URL(this.config.consentUrl);
    consent.searchParams.set('request', requestId);
    res.redirect(consent.href);
  }

  async consentDetails(requestId: string): Promise<{ clientName: string; expiresAt: string }> {
    const request = await this.active(digest(requestId), 'pending');
    if (!request) throw new InvalidGrantError('Consent request expired or already used');
    return { clientName: String(request.data.clientName), expiresAt: request.expiresAt.toISOString() };
  }

  // Only call from the authenticated server-to-server consent endpoint, never a browser route.
  async approve(requestId: string, userId: string, keyId: string, apiKey: string): Promise<{ redirect: string; connectionId: string }> {
    if (!userId || !keyId || !apiKey.startsWith('lister_')) throw new InvalidRequestError('Invalid integration credential');
    const request = await this.store.consume(digest(requestId), 'pending', new Date(this.now()));
    if (!request) throw new InvalidGrantError('Consent request expired or already used');
    const connectionId = opaque();
    const code = opaque();
    await this.put(connectionId, 'connection', {
      clientId: request.data.clientId, clientName: request.data.clientName, userId, keyId,
      encryptedKey: this.vault.seal(apiKey, connectionId),
    }, CONNECTION_SECONDS);
    await this.put(digest(code), 'code', { ...request.data, connectionId }, 120);
    const redirect = this.callback(request);
    redirect.searchParams.set('code', code);
    return { redirect: redirect.href, connectionId };
  }

  async deny(requestId: string): Promise<string> {
    const request = await this.store.consume(digest(requestId), 'pending', new Date(this.now()));
    if (!request) throw new InvalidGrantError('Consent request expired or already used');
    const redirect = this.callback(request);
    redirect.searchParams.set('error', 'access_denied');
    return redirect.href;
  }

  private callback(request: RecordEntry): URL {
    const redirect = new URL(String(request.data.redirectUri));
    if (typeof request.data.state === 'string') redirect.searchParams.set('state', request.data.state);
    redirect.searchParams.set('iss', this.config.issuer.href);
    return redirect;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = await this.active(digest(code), 'code');
    if (!record || record.data.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return String(record.data.challenge);
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.resource(resource);
    const record = await this.active(digest(code), 'code');
    if (!record || record.data.clientId !== client.client_id || record.data.redirectUri !== redirectUri) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    const consumed = await this.store.consume(record._id, 'code', new Date(this.now()));
    if (!consumed) throw new InvalidGrantError('Authorization code already used');
    return this.tokens(String(record.data.connectionId), client.client_id);
  }

  private async tokens(connectionId: string, clientId: string): Promise<OAuthTokens> {
    const connection = await this.active(connectionId, 'connection');
    if (!connection || connection.data.clientId !== clientId) throw new InvalidGrantError('Connection is inactive');
    const remaining = Math.floor((connection.expiresAt.getTime() - this.now()) / 1000);
    if (remaining <= 0) throw new InvalidGrantError('Connection expired');
    const access = opaque();
    const refresh = opaque();
    const data = { connectionId, clientId, resource: this.config.resource.href };
    const lifetime = Math.min(ACCESS_SECONDS, remaining);
    await this.put(digest(access), 'access', data, lifetime);
    // Consumed refresh records remain until the connection expires so replay is detectable.
    await this.put(digest(refresh), 'refresh', data, remaining);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: lifetime, scope: 'mylister' };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.scopes(scopes);
    this.resource(resource);
    const record = await this.store.get(digest(refresh), 'refresh');
    if (!record || record.data.clientId !== client.client_id || record.expiresAt.getTime() <= this.now()) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    const consumed = await this.store.consume(record._id, 'refresh', new Date(this.now()));
    if (!consumed) {
      await this.revokeConnection(String(record.data.connectionId));
      throw new InvalidGrantError('Refresh token reuse detected; reconnect MyLister');
    }
    return this.tokens(String(record.data.connectionId), client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.active(digest(token), 'access');
    const connection = record && await this.active(String(record.data.connectionId), 'connection');
    if (!record || !connection || connection.data.clientId !== record.data.clientId || record.data.resource !== this.config.resource.href) {
      throw new InvalidTokenError('Invalid or revoked access token');
    }
    return {
      token, clientId: String(record.data.clientId), scopes: ['mylister'],
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000), resource: this.config.resource,
      extra: { connectionId: connection._id, userId: connection.data.userId },
    };
  }

  async upstreamCredential(token: string): Promise<string> {
    const auth = await this.verifyAccessToken(token);
    const connection = await this.active(String(auth.extra?.connectionId), 'connection');
    if (!connection) throw new InvalidTokenError('Connection revoked');
    return this.vault.open(String(connection.data.encryptedKey), connection._id);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const id = digest(request.token);
    const record = await this.store.get(id, 'refresh') ?? await this.store.get(id, 'access');
    if (record?.data.clientId === client.client_id) await this.revokeConnection(String(record.data.connectionId));
  }

  async disconnect(connectionId: string, userId: string): Promise<{ keyId: string }> {
    const connection = await this.store.get(connectionId, 'connection');
    if (!connection || connection.data.userId !== userId) throw new InvalidGrantError('Unknown connection');
    await this.revokeConnection(connectionId);
    return { keyId: String(connection.data.keyId) };
  }

  async listConnections(userId: string): Promise<Array<{ id: string; name: string; expiresAt: string }>> {
    return (await this.store.connections(userId))
      .filter(record => record.expiresAt.getTime() > this.now())
      .map(record => ({ id: record._id, name: String(record.data.clientName), expiresAt: record.expiresAt.toISOString() }));
  }

  private async revokeConnection(id: string): Promise<void> {
    await this.store.revoke(id, 'connection');
    const record = await this.store.get(id, 'connection');
    if (record) await this.cleanup(record);
  }

  private async cleanup(record: RecordEntry): Promise<void> {
    if (!this.revokeUpstream || record.data.keyRevokedAt) return;
    try {
      await this.revokeUpstream(String(record.data.userId), String(record.data.keyId));
      await this.store.acknowledgeCleanup(record._id, new Date(this.now()));
    } catch {
      // Revocation is already durable. The worker retries without exposing credentials in logs.
    }
  }

  async retryKeyRevocations(): Promise<void> {
    for (const record of await this.store.pendingCleanup(new Date(this.now()))) await this.cleanup(record);
  }
}
