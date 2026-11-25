/**
 * Kullanıcı kararı 2026-11-12: tartı fotoğrafını ücretli yapay zekâ okuması firma ayarıdır (`scaleAiRead`), varsayılan
 * kapalı; kayıtlı değeri olmayan eski firma da kapalı. Kapalıyken `POST /vision/scale` sağlayıcıya ve sayaca gitmeden 409
 * `AI_DISABLED` döner, `details.reason: 'scale_ai_off'` (inceleme 4: eski mobil sürümler de bu kodu "Otomatik okuma kapalı"
 * diye gösterir; ücret, kota satırı, önbellek yok). Açıkken bugünkü davranış aynen. Ölçen rol ayarı görür
 * (telefon `/me` ya da `/settings` yanıtından okur), yazamaz.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { readSettings } from '../src/lib/settings.ts';
import { resetAiMeterState } from '../src/services/aiMeter.ts';
import { createWorker, getApp, inCompany, JPEG, multipart, registerCompany } from './helpers.ts';

const calls: unknown[] = [];

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: unknown) => {
          calls.push(params);
          return {
            currentMessage: undefined,
            finalMessage: async () => ({
              model: 'claude-sonnet-5-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 20 },
              content: [{ type: 'text', text: JSON.stringify({ weight: 4.02, unit: 'kg', rawText: '4.02 kg', confidence: 0.9 }) }],
            }),
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

const API = '/api/deciship';
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL'];
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  calls.length = 0;
  resetAiMeterState();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function sendScale(auth: { authorization: string }, lang = 'tr') {
  const form = multipart([{ name: 'image', filename: 't.jpg', contentType: 'image/jpeg', data: JPEG }]);
  return app.inject({ method: 'POST', url: `${API}/vision/scale`, headers: { ...auth, ...form.headers, 'accept-language': lang }, payload: form.payload });
}

const usageCount = (companyId: string) => inCompany(companyId, () => prisma.aiUsage.count({ where: { companyId } }));
const cacheCount = (companyId: string) => inCompany(companyId, () => prisma.aiResultCache.count({ where: { companyId } }));

describe('tartı okuması firma ayarı (scaleAiRead)', () => {
  it('kayıtlı değer yoksa ya da bozuksa kapalı; yalnız true açar', () => {
    expect(readSettings({}).scaleAiRead).toBe(false);
    expect(readSettings(null).scaleAiRead).toBe(false);
    expect(readSettings({ scaleAiRead: 'true' }).scaleAiRead).toBe(false);
    expect(readSettings({ scaleAiRead: 1 }).scaleAiRead).toBe(false);
    expect(readSettings({ scaleAiRead: false }).scaleAiRead).toBe(false);
    expect(readSettings({ scaleAiRead: true }).scaleAiRead).toBe(true);
  });

  it('yeni firmada kapalı: yönetici ve ölçen rol false görür (/settings, /me); ai alanı değişmez', async () => {
    const admin = await registerCompany(app, 'Tartı Varsayılan', { realDefaults: true });
    const worker = await createWorker(app, admin.auth);
    for (const auth of [admin.auth, worker.auth]) {
      const s = await app.inject({ method: 'GET', url: `${API}/settings`, headers: auth });
      expect(s.statusCode, s.body).toBe(200);
      expect(s.json().scaleAiRead).toBe(false);
      const me = await app.inject({ method: 'GET', url: `${API}/me`, headers: auth });
      expect(me.json().company.settings.scaleAiRead).toBe(false);
      expect(Object.keys(me.json().ai).sort()).toEqual(['available', 'quotaExhausted']);
    }
  });

  it('kapalıyken tartı okuma 409 AI_DISABLED + reason scale_ai_off (eski mobilin tanıdığı kod; TR ve EN), sağlayıcıya gidilmez, sayaç ve önbellek satırı yazılmaz', async () => {
    const admin = await registerCompany(app, 'Tartı Kapalı', { realDefaults: true });
    const worker = await createWorker(app, admin.auth);
    const tr = await sendScale(worker.auth, 'tr');
    expect(tr.statusCode, tr.body).toBe(409);
    expect(tr.json().error).toEqual({ code: 'AI_DISABLED', message: 'Tartı fotoğrafı okuması bu firmada kapalı; ağırlığı elle girin', details: { reason: 'scale_ai_off' } });
    const en = await sendScale(worker.auth, 'en');
    expect(en.statusCode).toBe(409);
    expect(en.json().error.message).toBe('Scale photo reading is turned off for this company. Enter the weight manually');
    expect(calls).toHaveLength(0);
    expect(await usageCount(admin.companyId)).toBe(0);
    expect(await cacheCount(admin.companyId)).toBe(0);
  });

  it('kayıtlı ayarında anahtar hiç olmayan eski firma da kapalı', async () => {
    const admin = await registerCompany(app, 'Tartı Eski', { realDefaults: true });
    await inCompany(admin.companyId, async () => {
      const c = await prisma.company.findFirstOrThrow({ where: { id: admin.companyId } });
      const { scaleAiRead: _drop, ...rest } = (c.settings ?? {}) as Record<string, unknown>;
      await prisma.company.update({ where: { id: admin.companyId }, data: { settings: { ...rest, desiDivisor: 4000 } } });
    });
    const r = await sendScale(admin.auth);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'AI_DISABLED', details: { reason: 'scale_ai_off' } });
    expect(calls).toHaveLength(0);
  });

  it('yönetici açınca bugünkü davranış: okunur, SCALE_READ satırı yazılır; yeniden kapatınca yine 409', async () => {
    const admin = await registerCompany(app, 'Tartı Açık', { realDefaults: true });
    const worker = await createWorker(app, admin.auth);
    const on = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload: { scaleAiRead: true } });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().scaleAiRead).toBe(true);
    const me = await app.inject({ method: 'GET', url: `${API}/me`, headers: worker.auth });
    expect(me.json().company.settings.scaleAiRead).toBe(true);

    const read = await sendScale(worker.auth);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ weightKg: 4.02 });
    expect(calls).toHaveLength(1);
    const rows = await inCompany(admin.companyId, () => prisma.aiUsage.findMany({ where: { companyId: admin.companyId } }));
    expect(rows.map((r) => r.kind)).toEqual(['SCALE_READ']);

    const off = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload: { scaleAiRead: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().scaleAiRead).toBe(false);
    const again = await sendScale(worker.auth);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'AI_DISABLED', details: { reason: 'scale_ai_off' } });
    expect(calls).toHaveLength(1);
    expect(await usageCount(admin.companyId)).toBe(1);
  });

  it('ölçen rol ayarı yazamaz; boolean olmayan değer 400 VALIDATION', async () => {
    const admin = await registerCompany(app, 'Tartı Yetki', { realDefaults: true });
    const worker = await createWorker(app, admin.auth);
    const denied = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: worker.auth, payload: { scaleAiRead: true } });
    expect(denied.statusCode).toBe(403);
    for (const scaleAiRead of ['true', 1, null]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload: { scaleAiRead } });
      expect(r.statusCode, JSON.stringify(scaleAiRead)).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
    }
    const s = await app.inject({ method: 'GET', url: `${API}/settings`, headers: admin.auth });
    expect(s.json().scaleAiRead).toBe(false);
  });
});
