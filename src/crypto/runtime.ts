import { webcrypto } from 'node:crypto';

/** Node 22 and hosts such as Dot/OpenClaw share the WebCrypto algorithms. */
export function portableCrypto(): Crypto {
  return (globalThis.crypto?.subtle ? globalThis.crypto : webcrypto) as unknown as Crypto;
}
