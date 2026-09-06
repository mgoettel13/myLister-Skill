import type { Collection, Db } from 'mongodb';

export interface RecordEntry {
  _id: string;
  kind: string;
  state: 'active' | 'consumed' | 'revoked';
  expiresAt: Date;
  deleteAfter?: Date;
  data: Record<string, unknown>;
}

export interface GrantStore {
  insert(entry: RecordEntry): Promise<void>;
  get(id: string, kind: string): Promise<RecordEntry | null>;
  consume(id: string, kind: string, now: Date): Promise<RecordEntry | null>;
  revoke(id: string, kind: string): Promise<void>;
  connections(userId: string): Promise<RecordEntry[]>;
  pendingCleanup(now: Date): Promise<RecordEntry[]>;
  acknowledgeCleanup(id: string, now: Date): Promise<void>;
}

export class MongoGrantStore implements GrantStore {
  private readonly records: Collection<RecordEntry>;

  constructor(db: Db) {
    this.records = db.collection<RecordEntry>('oauth_records');
  }

  async initialize(): Promise<void> {
    await this.records.createIndex({ deleteAfter: 1 }, { expireAfterSeconds: 0 });
    await this.records.createIndex({ kind: 1, 'data.userId': 1 });
  }

  async insert(entry: RecordEntry): Promise<void> {
    await this.records.insertOne(entry);
  }

  async get(id: string, kind: string): Promise<RecordEntry | null> {
    return this.records.findOne({ _id: id, kind });
  }

  async consume(id: string, kind: string, now: Date): Promise<RecordEntry | null> {
    return this.records.findOneAndUpdate(
      { _id: id, kind, state: 'active', expiresAt: { $gt: now } },
      { $set: { state: 'consumed' } },
      { returnDocument: 'before' },
    );
  }

  async revoke(id: string, kind: string): Promise<void> {
    await this.records.updateOne({ _id: id, kind }, { $set: { state: 'revoked' } });
  }

  async connections(userId: string): Promise<RecordEntry[]> {
    return this.records.find({ kind: 'connection', 'data.userId': userId, state: 'active' }).toArray();
  }

  async pendingCleanup(now: Date): Promise<RecordEntry[]> {
    return this.records.find({
      kind: 'connection', 'data.keyRevokedAt': { $exists: false },
      $or: [{ state: 'revoked' }, { expiresAt: { $lte: now } }],
    }).limit(100).toArray();
  }

  async acknowledgeCleanup(id: string, now: Date): Promise<void> {
    await this.records.updateOne({ _id: id, kind: 'connection' }, {
      $set: { state: 'revoked', 'data.keyRevokedAt': now, deleteAfter: new Date(now.getTime() + 7 * 86400_000) },
      $unset: { 'data.encryptedKey': '' },
    });
  }
}
