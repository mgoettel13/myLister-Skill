import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { MyListerOAuthProvider } from './oauth.js';
import { MongoGrantStore } from './store.js';
import { CredentialVault } from './vault.js';

const config = loadConfig();
const mongo = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 10_000 });
await mongo.connect();
const store = new MongoGrantStore(mongo.db(config.mongoDatabase));
await store.initialize();
const provider = new MyListerOAuthProvider(store, new CredentialVault(config.encryptionKey), config, Date.now,
  async (userId, keyId) => {
    const response = await fetch(new URL('/api/integrations/internal/revoke-key', config.privateApiBase), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Connector-Secret': config.sharedSecret },
      body: JSON.stringify({ userId, keyId }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Upstream key revocation failed');
  });
let cleaning = false;
const clean = async () => {
  if (cleaning) return;
  cleaning = true;
  try { await provider.retryKeyRevocations(); }
  catch { console.error('Integration-key cleanup will retry'); }
  finally { cleaning = false; }
};
await clean();
const worker = setInterval(() => { void clean(); }, 30_000);
const server = createApp(provider, config).listen(config.port, '::', () => console.log('MyLister connector is listening'));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    clearInterval(worker);
    server.close(() => { void mongo.close().then(() => process.exit(0)); });
  });
}
