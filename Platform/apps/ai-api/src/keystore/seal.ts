import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Sağlayıcı anahtarlarının mührü: AES-256-GCM, her mühürde yeni 12 baytlık rastgele IV, 16 baytlık doğrulama etiketi.
 * - Ek doğrulanan veri (AAD) satırın kimliğidir (`keyAad`: kapsam, firma, sağlayıcı). Veritabanında başka satıra (ör. Gemini
 *   satırına) kopyalanan mühür açılmaz; sağlayıcılar arasında anahtar sessizce yer değiştiremez.
 * - Biçim: `v1.<ana anahtar kimliği>.<iv>.<etiket>.<şifreli metin>` (base64url). Kimlik ana anahtarın SHA-256 özetinin ilk 16
 *   hanesidir; anahtarın kendisini açığa vurmaz, döndürmede hangi ana anahtarla açılacağını söyler.
 * - Döndürme: yeni anahtar `AI_KEY_MASTER`, eskisi `AI_KEY_MASTER_PREVIOUS`; `ai-key rotate-master` her satırı yeni anahtarla yeniden
 *   mühürler. Eski anahtar ancak bundan sonra ortamdan çıkarılır.
 * Hata metinleri gizli değer, mühür ya da düz metin içermez.
 */

export type MasterKey = { kid: string; key: Buffer };
export type MasterKeyRing = { current: MasterKey; previous: readonly MasterKey[] };

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SEALED_RE = /^v1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/;

/** Mühür açılamadı ya da ana anahtar geçersiz. Metin sabittir: girdi yansıtılmaz. */
export class SealError extends Error {
  constructor(
    public reason: 'format' | 'unknown_key' | 'auth_failed' | 'master_key',
    message: string,
  ) {
    super(message);
    this.name = 'SealError';
  }
}

/** Ana anahtar kimliği: SHA-256 özetinin ilk 16 hanesi. */
export function masterKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** `AI_KEY_MASTER` değeri: base64 ya da base64url, çözülünce tam 32 bayt. */
export function parseMasterKey(value: string, name = 'AI_KEY_MASTER'): MasterKey {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) throw new SealError('master_key', `${name}: base64 değil`);
  const key = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== KEY_BYTES) throw new SealError('master_key', `${name}: 32 bayt olmalı (şu an ${key.length})`);
  return { kid: masterKeyId(key), key };
}

/** Halka: mühürleyen anahtar + yalnız açmak için eski anahtarlar (virgüllü). Aynı anahtar iki kez sayılmaz. */
export function masterKeyRing(current: string, previous = ''): MasterKeyRing {
  const cur = parseMasterKey(current);
  const prev: MasterKey[] = [];
  for (const part of previous.split(',').map((s) => s.trim()).filter(Boolean)) {
    const k = parseMasterKey(part, 'AI_KEY_MASTER_PREVIOUS');
    if (k.kid !== cur.kid && !prev.some((p) => p.kid === k.kid)) prev.push(k);
  }
  return { current: cur, previous: prev };
}

/** Satırın kimliği (AAD). Kapsam, firma ve sağlayıcı değişirse mühür açılmaz. */
export function keyAad(row: { scope: string; orgId: string | null; provider: string }): string {
  return `sod-ai-key:v1:${row.scope}:${row.orgId ?? ''}:${row.provider}`;
}

export function sealSecret(plain: string, aad: string, ring: MasterKeyRing): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ring.current.kid, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Mührün ana anahtar kimliği; biçim bozuksa null. */
export function sealedKeyId(sealed: string): string | null {
  return SEALED_RE.exec(sealed)?.[1] ?? null;
}

export function openSecret(sealed: string, aad: string, ring: MasterKeyRing): string {
  const m = SEALED_RE.exec(sealed);
  if (!m) throw new SealError('format', 'mühür biçimi bozuk');
  const [, kid, ivB64, tagB64, ctB64] = m as unknown as [string, string, string, string, string];
  const master = ring.current.kid === kid ? ring.current : ring.previous.find((k) => k.kid === kid);
  if (!master) throw new SealError('unknown_key', 'mührün ana anahtarı halkada yok (AI_KEY_MASTER / AI_KEY_MASTER_PREVIOUS)');
  try {
    const decipher = createDecipheriv('aes-256-gcm', master.key, Buffer.from(ivB64, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SealError('auth_failed', 'mühür doğrulanamadı (bozulmuş, başka satırdan ya da başka anahtarla)');
  }
}

/** Mühür eski ana anahtarla mı (döndürme gerekiyor). */
export function needsReseal(sealed: string, ring: MasterKeyRing): boolean {
  return sealedKeyId(sealed) !== ring.current.kid;
}
