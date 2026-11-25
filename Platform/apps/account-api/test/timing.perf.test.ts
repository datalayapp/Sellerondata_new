/**
 * Başarım katmanı (Aşama 0.4; `npm run test:perf`, kapı değil; Postgres ister). Yanıt süresinin kimliğin varlığını ele
 * vermediği iki ölçüm. Duvar saatine bağlıdır, yoğun makinede oynar; kapıdaki süreye bağlı olmayan eşleri:
 * - giriş, kişi yokken de argon2: `loginArgon.test.ts` (tam bir doğrulama, aynı maliyet ayarları),
 * - şifre sıfırlama SMTP'yi beklemez: `mailDelivery.test.ts` › "yanıt SMTP'yi beklemez" (kapılı sahte posta sunucusu).
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureMailer, flushMail } from '../src/lib/mailer.ts';
import { API, getApp, login, randomEmail, randomIp, registerOrg } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

afterEach(async () => {
  await flushMail();
  configureMailer();
});

describe('giriş', () => {
  it('kişi yokken de argon2 çalışır: süre farkı kimliği ele vermez', async () => {
    const owner = await registerOrg(app);
    const time = async (identifier: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await login(app, identifier, 'YanlisSifre123');
        samples.push(performance.now() - t0);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };
    const known = await time(owner.email as string);
    const unknown = await time(randomEmail('yok'));
    console.info(`[süre] giriş ortanca: bilinen ${Math.round(known)} ms, bilinmeyen ${Math.round(unknown)} ms`);
    // argon2 (onlarca ms) atlansaydı oran 0.1'in altına düşerdi.
    expect(unknown / known).toBeGreaterThan(0.5);
    expect(unknown / known).toBeLessThan(2);
  });
});

describe('şifre sıfırlama', () => {
  const FAST = { retryDelaysMs: [5, 10], sendTimeoutMs: 200 };
  const forgot = (identifier: string) =>
    app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier } });

  it('süre: SMTP yavaşken bilinen adresin yanıtı bilinmeyenden belirgin uzun sürmez', async () => {
    const owner = await registerOrg(app);
    await flushMail();
    const delay = 800;
    configureMailer({ ...FAST, sendTimeoutMs: 5000, mailer: { send: () => new Promise((r) => setTimeout(r, delay)) } });
    const time = async (identifier: string) => {
      const started = performance.now();
      await forgot(identifier);
      return performance.now() - started;
    };
    // İki tarafta da en küçük değer: makine yoğunluğu ölçümü bozmasın.
    const known = Math.min(await time(owner.email as string), await time(owner.email as string), await time(owner.email as string));
    const unknown = Math.min(await time(randomEmail('yok')), await time(randomEmail('yok')), await time(randomEmail('yok')));
    console.info(`[süre] şifre sıfırlama en kısa: bilinen ${Math.round(known)} ms, bilinmeyen ${Math.round(unknown)} ms`);
    expect(known).toBeLessThan(delay);
    expect(Math.abs(known - unknown)).toBeLessThan(delay / 2);
  });
});
