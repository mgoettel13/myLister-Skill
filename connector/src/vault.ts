import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const opaque = (): string => randomBytes(32).toString('base64url');
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export class CredentialVault {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== encodedKey) {
      throw new Error('Credential encryption requires a canonical base64-encoded 32-byte key');
    }
  }

  seal(secret: string, connectionId: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(connectionId));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  open(envelope: string, connectionId: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid credential envelope');
    const [, nonce, tag, payload] = parts;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(connectionId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
  }
}
