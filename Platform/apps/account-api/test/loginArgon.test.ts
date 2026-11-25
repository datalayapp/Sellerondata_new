/**
 * Aşama 0.4: "kişi yokken de argon2 çalışır" denetiminin süreye bağlı olmayan eşi (kapıda). Kişi yoksa da, kimlik
 * biçimi tanınmasa da giriş tam bir kez argon2 doğrulaması yapar ve sabit özet gerçek şifre özetiyle aynı maliyet
 * ayarlarını taşır (`src/lib/crypto.ts` `verifyPassword`). Süre oranının kendisi kapı dışında: `timing.perf.test.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { getApp, login, randomEmail, randomTrPhone, registerOrg } from './helpers.ts';

/** argon2.verify çağrılarının ilk bağımsız değişkeni (doğrulanan özet). Gerçek doğrulama yine çalışır. */
const verified = vi.hoisted(() => [] as string[]);

vi.mock('argon2', async (importOriginal) => {
  const real = await importOriginal<typeof import('argon2') & { default?: typeof import('argon2') }>();
  const mod = real.default ?? real;
  const verify: typeof mod.verify = (hash, ...rest) => {
    verified.push(hash);
    return mod.verify(hash, ...rest);
  };
  return { ...real, verify, default: { ...mod, verify } };
});

/** `$argon2id$v=19$m=…,t=…,p=…$` : tür, sürüm ve maliyet ayarları (tuz ve özet hariç). */
const costOf = (hash: string) => hash.split('$').slice(1, 4).join('$');

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
beforeEach(() => {
  verified.length = 0;
});

describe('giriş: kişi yokken de argon2 çalışır', () => {
  it('bilinen kişi yanlış şifre, bilinmeyen e-posta, bilinmeyen telefon, tanınmayan kimlik: her biri tam bir doğrulama, aynı maliyet', async () => {
    const owner = await registerOrg(app);
    const person = await prisma.person.findUniqueOrThrow({ where: { email: owner.email as string } });
    expect(person.passwordHash).toBeTruthy();

    const attempt = async (identifier: string) => {
      verified.length = 0;
      const r = await login(app, identifier, 'YanlisSifre123');
      expect(r.statusCode, identifier).toBe(401);
      expect(verified, identifier).toHaveLength(1);
      return verified[0]!;
    };
    expect(await attempt(owner.email as string)).toBe(person.passwordHash);
    const dummy = await attempt(randomEmail('yok'));
    expect(dummy).not.toBe(person.passwordHash);
    expect(costOf(dummy)).toBe(costOf(person.passwordHash!));
    expect(costOf(dummy)).toMatch(/^argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+$/);
    expect(await attempt(randomTrPhone())).toBe(dummy);
    expect(await attempt('kimlik-degil')).toBe(dummy);
  });
});
