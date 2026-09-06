import express from 'express';
import type { ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectorConfig } from './config.js';
import { MyListerOAuthProvider } from './oauth.js';
import { callPublicTool, operations } from './tools.js';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const userSchema = z.object({ userId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict();
const approveSchema = userSchema.extend({ keyId: z.string().regex(/^[a-fA-F0-9]{24}$/), apiKey: z.string().regex(/^lister_[A-Za-z0-9_-]+$/).max(200) }).strict();

export function createApp(provider: MyListerOAuthProvider, config: ConnectorConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mylister-connector', version: '0.1.0' }));
  app.use((req, res, next) => {
    if (!config.allowedHosts.includes(req.headers.host ?? '')) {
      console.warn('Rejected connector host', JSON.stringify({ received: (req.headers.host ?? '').slice(0, 300), allowed: config.allowedHosts }));
      res.status(421).json({ error: 'Invalid host' }); return;
    }
    next();
  });
  const authOptions = {
    provider, issuerUrl: config.issuer, resourceServerUrl: config.resource,
    scopesSupported: ['mylister'], resourceName: 'MyLister.dev',
  };
  // The SDK advertises confidential-client revocation by default; this provider uses public PKCE clients.
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.set('Access-Control-Allow-Origin', '*').json({
    ...createOAuthMetadata(authOptions), token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true,
  }));
  app.use('/authorize', (_req, res, next) => {
    const location = res.location.bind(res);
    res.location = address => {
      const target = new URL(address);
      // SDK-generated authorization errors must honor the advertised issuer identification too.
      if (target.searchParams.has('error')) target.searchParams.set('iss', config.issuer.href);
      return location(target.href);
    };
    next();
  });
  app.use(mcpAuthRouter(authOptions));

  const internal = express.Router();
  internal.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  internal.use((req, res, next) => {
    const received = Buffer.from(req.get('X-Connector-Secret') ?? '');
    const expected = Buffer.from(config.sharedSecret);
    if (req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(401).json({ error: 'Invalid connector credential' }); return;
    }
    next();
  });
  internal.use(express.json({ limit: '8kb' }));
  internal.get('/consent/:id', async (req, res) => res.json(await provider.consentDetails(idSchema.parse(req.params.id))));
  internal.post('/consent/:id/approve', async (req, res) => {
    const body = approveSchema.parse(req.body);
    res.json(await provider.approve(idSchema.parse(req.params.id), body.userId, body.keyId, body.apiKey));
  });
  internal.post('/consent/:id/deny', async (req, res) => res.json({ redirect: await provider.deny(idSchema.parse(req.params.id)) }));
  internal.post('/connections/list', async (req, res) => {
    const body = userSchema.parse(req.body);
    res.json(await provider.listConnections(body.userId));
  });
  internal.post('/connections/:id/disconnect', async (req, res) => {
    const body = userSchema.parse(req.body);
    res.json(await provider.disconnect(idSchema.parse(req.params.id), body.userId));
  });
  app.use('/internal', internal);

  app.use('/mcp', (req, res, next) => {
    if (req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) { res.status(403).json({ error: 'Origin not allowed' }); return; }
    next();
  }, requireBearerAuth({ verifier: provider, requiredScopes: ['mylister'], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resource) }),
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => req.auth!.clientId + ':' + String(req.auth!.extra?.userId) }));
  app.post('/mcp', express.json({ limit: '30mb' }), async (req, res) => {
    const server = new Server({ name: 'mylister', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...operations.values()].map(operation => operation.tool) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const key = await provider.upstreamCredential(req.auth!.token);
        return await callPublicTool(request.params.name, request.params.arguments ?? {}, key, config.apiBase);
      } catch (error) {
        if (error instanceof InvalidTokenError) {
          return { isError: true, content: [{ type: 'text', text: 'Reconnect MyLister to continue.' }],
            _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(config.resource)}", error="invalid_token"`] },
          };
        }
        return { isError: true, content: [{ type: 'text', text: 'MyLister could not complete the request. Check the tool arguments or reconnect if your authorization expired. Do not retry a write without checking whether it succeeded.' }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof OAuthError) { res.status(400).json(error.toResponseObject()); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid request' }); return; }
    res.status(500).json({ error: 'MyLister connector request failed' });
  };
  app.use(errors);
  return app;
}
