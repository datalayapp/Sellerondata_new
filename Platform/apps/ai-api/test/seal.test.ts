import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyAad, masterKeyId, masterKeyRing, needsReseal, openSecret, parseMasterKey, sealedKeyId, sealSecret, SealError } from '../src/keystore/seal.ts';

const b64 = () => randomBytes(32).toString('base64');
const aad = keyAad({ scope: 'platform', orgId: null, provider: 'anthropic' });
const SECRET = 'sk-ant-api03-gizli-deger-0123456789abcdef';

function sealErr(fn: () => unknown): SealError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SealError);
    return e as SealError;
  }
  throw new Error('hata beklenirdi');
}

describe('AES-256-GCM mühür', () => {
  it('mühürler ve açar; mühürde düz metin yok, biçim v1.<kimlik>.<iv>.<etiket>.<metin>', () => {
    const ring = masterKeyRing(b64());
    const sealed = sealSecret(SECRET, aad, ring);
    expect(sealed).toMatch(/^v1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain(Buffer.from(SECRET).toString('base64url'));
    expect(sealedKeyId(sealed)).toBe(ring.current.kid);
    expect(openSecret(sealed, aad, ring)).toBe(SECRET);
  });

  it('her mühürde yeni IV: aynı metin iki kez aynı mühürü vermez', () => {
    const ring = masterKeyRing(b64());
    const a = sealSecret(SECRET, aad, ring);
    const b = sealSecret(SECRET, aad, ring);
    expect(a).not.toBe(b);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });

  it('başka satırın kimliğiyle (AAD) açılmaz: sağlayıcı ya da kapsam değişirse doğrulama düşer', () => {
    const ring = masterKeyRing(b64());
    const sealed = sealSecret(SECRET, aad, ring);
    for (const other of [
      keyAad({ scope: 'platform', orgId: null, provider: 'gemini' }),
      keyAad({ scope: 'org', orgId: 'org-a', provider: 'anthropic' }),
    ]) {
      expect(sealErr(() => openSecret(sealed, other, ring)).reason).toBe('auth_failed');
    }
  });

  it('bozulmuş etiket, metin ya da IV açılmaz; hata metni gizli değeri ve mührü içermez', () => {
    const ring = masterKeyRing(b64());
    const sealed = sealSecret(SECRET, aad, ring);
    const parts = sealed.split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const i of [2, 3, 4]) {
      const bad = parts.map((p, j) => (j === i ? flip(p) : p)).join('.');
      const e = sealErr(() => openSecret(bad, aad, ring));
      expect(e.reason).toBe('auth_failed');
      expect(e.message).not.toContain(SECRET);
      expect(e.message).not.toContain(parts[4]!);
    }
    expect(sealErr(() => openSecret('düz-anahtar', aad, ring)).reason).toBe('format');
    expect(sealErr(() => openSecret(`v2.${parts.slice(1).join('.')}`, aad, ring)).reason).toBe('format');
  });

  it('başka ana anahtarla açılmaz (halkada yoksa unknown_key)', () => {
    const sealed = sealSecret(SECRET, aad, masterKeyRing(b64()));
    expect(sealErr(() => openSecret(sealed, aad, masterKeyRing(b64()))).reason).toBe('unknown_key');
  });

  it('kimliği tutan sahte anahtar (aynı kimlik, farklı bayt) doğrulamayı geçemez', () => {
    const ring = masterKeyRing(b64());
    const sealed = sealSecret(SECRET, aad, ring);
    const forged = { current: { kid: ring.current.kid, key: randomBytes(32) }, previous: [] };
    expect(sealErr(() => openSecret(sealed, aad, forged)).reason).toBe('auth_failed');
  });

  it('döndürme: eski anahtar AI_KEY_MASTER_PREVIOUS iken eski mühür açılır, yeniden mühür yeni anahtarla', () => {
    const oldKey = b64();
    const newKey = b64();
    const oldRing = masterKeyRing(oldKey);
    const sealed = sealSecret(SECRET, aad, oldRing);
    const ring = masterKeyRing(newKey, ` ${oldKey} , ${newKey}`);
    expect(ring.previous.map((k) => k.kid)).toEqual([oldRing.current.kid]);
    expect(needsReseal(sealed, ring)).toBe(true);
    expect(openSecret(sealed, aad, ring)).toBe(SECRET);
    const resealed = sealSecret(openSecret(sealed, aad, ring), aad, ring);
    expect(needsReseal(resealed, ring)).toBe(false);
    expect(sealedKeyId(resealed)).toBe(ring.current.kid);
    // Eski anahtar ortamdan çıkınca yeni mühür açılır, eskisi açılmaz.
    const onlyNew = masterKeyRing(newKey);
    expect(openSecret(resealed, aad, onlyNew)).toBe(SECRET);
    expect(sealErr(() => openSecret(sealed, aad, onlyNew)).reason).toBe('unknown_key');
  });

  it('ana anahtar: tam 32 bayt base64 (ya da base64url); kısa, uzun ve bozuk değer reddedilir, metin değeri yansıtmaz', () => {
    const raw = randomBytes(32);
    expect(parseMasterKey(raw.toString('base64')).key.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('base64url')).key.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('base64')).kid).toBe(masterKeyId(raw));
    for (const bad of [randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), 'bu bir anahtar değil!', '']) {
      const e = sealErr(() => parseMasterKey(bad));
      expect(e.reason).toBe('master_key');
      if (bad) expect(e.message).not.toContain(bad);
    }
  });

  it('kimlik özetten türer, anahtarın kendisini içermez', () => {
    const raw = randomBytes(32);
    const kid = masterKeyId(raw);
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
    expect(raw.toString('hex')).not.toContain(kid);
  });
});
