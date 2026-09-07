import { createInterface } from 'node:readline';
import { MongoClient, ObjectId } from 'mongodb';

// Read-only verification of explicitly identified staging QA grants. Credentials
// arrive through stdin, never process arguments; no key material is fetched.
const input = createInterface({ input: process.stdin });
input.once('line', async line => {
  input.close();
  process.stdin.pause();
  let connector;
  let api;
  try {
    const config = JSON.parse(line);
    if (config.connectorDatabase !== 'mylister_connector_staging' || config.apiDatabase !== 'listmaster_staging' ||
      !/^[A-Za-z0-9_-]{43}$/.test(config.clientId) || !ObjectId.isValid(config.userId)) {
      throw new Error('Invalid staging QA audit target');
    }
    connector = new MongoClient(config.connectorMongoUrl, { serverSelectionTimeoutMS: 10_000 });
    api = new MongoClient(config.apiMongoUrl, { serverSelectionTimeoutMS: 10_000 });
    await connector.connect();
    await api.connect();
    const records = connector.db(config.connectorDatabase).collection('oauth_records');
    const client = await records.findOne({ _id: config.clientId, kind: 'client' }, {
      projection: { 'data.client.client_name': 1 },
    });
    if (!/^MyLister lifecycle QA (replay|disconnect)$/.test(client?.data?.client?.client_name ?? '')) {
      throw new Error('Client is not a lifecycle QA fixture');
    }
    const connections = await records.aggregate([
      { $match: { kind: 'connection', 'data.clientId': config.clientId, 'data.userId': config.userId } },
      { $project: {
        state: 1, expiresAt: 1, 'data.userId': 1, 'data.keyId': 1, 'data.keyRevokedAt': 1,
        encryptedKeyStored: { $ne: [{ $type: '$data.encryptedKey' }, 'missing'] },
      } },
    ]).toArray();
    if (connections.length !== 1) throw new Error('Expected exactly one approved QA connection');
    const connection = connections[0];
    const key = await api.db(config.apiDatabase).collection('apikeys').findOne({
      _id: new ObjectId(connection.data.keyId), userId: new ObjectId(config.userId), purpose: 'integration',
    }, { projection: { purpose: 1, revokedAt: 1, expiresAt: 1 } });
    if (!key) throw new Error('Expected the matching dedicated integration key');
    console.log(JSON.stringify({
      clientName: client.data.client.client_name, connectionState: connection.state,
      connectorCleanupAcknowledged: Boolean(connection.data.keyRevokedAt),
      encryptedKeyStored: connection.encryptedKeyStored,
      keyPurpose: key.purpose, upstreamKeyRevoked: Boolean(key.revokedAt),
    }));
  } catch {
    console.error('QA cleanup inspection failed; verify the specified staging fixture and database access.');
    process.exitCode = 1;
  } finally {
    await connector?.close();
    await api?.close();
  }
});
