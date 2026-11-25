// Testlerde `expo-crypto` yerine (yerli modül Node'da yok): kullanılan işlevler Node'un kriptosuyla.
import { createHash, randomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';

export enum CryptoDigestAlgorithm {
  SHA256 = 'SHA-256',
}

export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount));
}

export function randomUUID(): string {
  return nodeRandomUUID();
}

/** Gerçek modülün varsayılanı gibi onaltılık. Yalnız SHA-256. */
export async function digestStringAsync(algorithm: CryptoDigestAlgorithm, data: string): Promise<string> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) throw new Error(`stub: ${algorithm}`);
  return createHash('sha256').update(data).digest('hex');
}
