import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { TOKEN_ALG } from '@sellerondata/contracts';
import { env } from '../env.ts';

/**
 * İmza anahtarları.
 * - Etkin anahtar: ACCOUNT_SIGNING_KEY (özel JWK). Üretimde yoksa servis başlamaz.
 * - Geliştirmede yoksa `keys/signing-key.jwk.json` üretilir.
 * - Eski anahtarlar: ACCOUNT_PREVIOUS_PUBLIC_KEYS veya `keys/previous-public-keys.json`. JWKS yayınlar, imzada kullanılmaz.
 *
 * Döndürme: yeni anahtarı etkinleştir, eskisinin açık halini en az jeton ömrü (10 dk) + olay jetonu ömrü (5 dk) yayında tut.
 */

export type KeyStore = {
  kid: string;
  privateKey: CryptoKey;
  /** JWKS'te yayınlanan açık anahtarlar. Özel alan (`d`) taşımaz. */
  publicJwks: JWK[];
  verifierKeySet: ReturnType<typeof createLocalJWKSet>;
};

const SIGNING_FILE = 'signing-key.jwk.json';
const PREVIOUS_FILE = 'previous-public-keys.json';

function toPublicJwk(jwk: JWK): JWK {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.kid) {
    throw new Error('Anahtar Ed25519 JWK olmalı ve kid taşımalı');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid, alg: TOKEN_ALG, use: 'sig' };
}

function parseJwk(raw: string, source: string): JWK {
  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    // Anahtar içeriği hata metnine girmez.
    throw new Error(`${source} geçerli JSON değil`);
  }
  if (!jwk.d) throw new Error(`${source} özel anahtar içermiyor (d alanı yok)`);
  toPublicJwk(jwk);
  return jwk;
}

/** JWK'daki `x` özel anahtarla uyuşuyor mu? Yanlış `x`, tüm jetonları sessizce geçersiz kılardı. */
async function assertKeyPairMatches(jwk: JWK) {
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({ key: jwk as never, format: 'jwk' });
  } catch {
    // Node 24.22+ x/d uyuşmazlığını içe aktarmada kendisi reddeder; anahtar içeriği hata metnine girmez.
    throw new Error('İmza anahtarı geçersiz: x ve d uyuşmuyor ya da d bozuk');
  }
  const derived = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  if (derived.x !== jwk.x) throw new Error('İmza anahtarında x ve d uyuşmuyor');
}

export async function generateSigningJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair(TOKEN_ALG, { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  const date = new Date().toISOString().slice(0, 10);
  return { ...jwk, kid: `sod-${date}-${crypto.randomBytes(4).toString('hex')}`, alg: TOKEN_ALG, use: 'sig' };
}

/** Geliştirme: dosyadan oku, yoksa üret. Aynı anda iki süreç başlarsa kazanan yazar, diğeri onu okur. */
async function loadOrCreateDevKey(dir: string): Promise<JWK> {
  const file = path.join(dir, SIGNING_FILE);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const jwk = await generateSigningJwk();
    try {
      fs.writeFileSync(file, `${JSON.stringify(jwk, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return parseJwk(fs.readFileSync(file, 'utf8'), file);
}

function parsePreviousKeys(raw: string | undefined, source: string): JWK[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} geçerli JSON değil`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${source} JSON dizisi olmalı`);
  return (parsed as JWK[]).map(toPublicJwk);
}

export type KeyEnv = { isProduction: boolean; signingKey?: string; previousPublicKeys?: string; keysDir: string };

export async function loadKeyStore(input: KeyEnv): Promise<KeyStore> {
  let jwk: JWK;
  let previous: JWK[];
  if (input.signingKey) {
    jwk = parseJwk(input.signingKey, 'ACCOUNT_SIGNING_KEY');
    previous = parsePreviousKeys(input.previousPublicKeys, 'ACCOUNT_PREVIOUS_PUBLIC_KEYS');
  } else {
    if (input.isProduction) {
      throw new Error('ACCOUNT_SIGNING_KEY tanımlı değil. Üretimde imza anahtarı zorunludur (npm run keys:generate).');
    }
    jwk = await loadOrCreateDevKey(input.keysDir);
    const previousFile = path.join(input.keysDir, PREVIOUS_FILE);
    previous = input.previousPublicKeys
      ? parsePreviousKeys(input.previousPublicKeys, 'ACCOUNT_PREVIOUS_PUBLIC_KEYS')
      : parsePreviousKeys(fs.existsSync(previousFile) ? fs.readFileSync(previousFile, 'utf8') : undefined, previousFile);
  }
  await assertKeyPairMatches(jwk);

  const privateKey = (await importJWK(jwk, TOKEN_ALG)) as CryptoKey;
  const active = toPublicJwk(jwk);
  const publicJwks = [active, ...previous.filter((k) => k.kid !== active.kid)];
  return {
    kid: jwk.kid as string,
    privateKey,
    publicJwks,
    verifierKeySet: createLocalJWKSet({ keys: publicJwks }),
  };
}

/** Geliştirme döndürmesi: etkin anahtar eskilere geçer, yenisi üretilir. */
export async function rotateDevKey(dir: string): Promise<{ kid: string; previousKid: string }> {
  const file = path.join(dir, SIGNING_FILE);
  const current = await loadOrCreateDevKey(dir);
  const previousFile = path.join(dir, PREVIOUS_FILE);
  const previous = parsePreviousKeys(fs.existsSync(previousFile) ? fs.readFileSync(previousFile, 'utf8') : undefined, previousFile);
  const next = await generateSigningJwk();
  fs.writeFileSync(previousFile, `${JSON.stringify([toPublicJwk(current), ...previous], null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { kid: next.kid as string, previousKid: current.kid as string };
}

let store: KeyStore | undefined;

export async function initKeys(): Promise<KeyStore> {
  store ??= await loadKeyStore({
    isProduction: env.isProduction,
    signingKey: env.signingKey,
    previousPublicKeys: env.previousPublicKeys,
    keysDir: env.keysDir,
  });
  return store;
}

export function keys(): KeyStore {
  if (!store) throw new Error('Anahtarlar yüklenmedi: önce initKeys()');
  return store;
}

/** Yalnız test. */
export function setKeyStoreForTest(next: KeyStore | undefined) {
  store = next;
}
