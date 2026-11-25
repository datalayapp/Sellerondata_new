/**
 * KALANLAR 6.5: firmanın aylık yapay zekâ hakkının %80'ine ulaşılınca ayar yetkililerine (firma sahibi ve Yönetici;
 * `deciship.settings.manage`) bir kez posta. Postayı Hesap servisi gönderir (`/internal/notify`, testte `setNotifier`);
 * tekrar anahtarı `ai-quota-80:<dönem>` ve DeciShip'te kalıcı işaret (denetim kaydı): ay içinde, yeniden başlatmadan sonra da
 * ikinci kez gitmez. Sağlayıcı sahtedir.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AI_LIMIT_CREDIT_MONTHLY, NOTICE_LIMITS, isNoticePlainText, type ProductNoticeBody, type ProductNoticeResponse } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { aiAllowance, meteredCall, resetAiMeterState, type AiCallContext, type MeterLog } from '../src/services/aiMeter.ts';
import { AI_QUOTA_NOTICE_PCT, buildAiQuotaNotice, drainAiQuotaNotices, noticeAiQuota } from '../src/services/aiQuotaNotice.ts';
import { NotifyError, setNotifier } from '../src/services/notify.ts';
import { getApp, inCompany, registerCompany, uniq } from './helpers.ts';

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            model: 'claude-sonnet-5-5',
            stop_reason: 'end_turn',
            // sonnet 5.5 ($2 / $10 per 1M), 100 TL/USD: 1.000 + 1.000 token = 1,2 TL
            usage: { input_tokens: 1000, output_tokens: 1000 },
            content: [{ type: 'text', text: JSON.stringify({ value: 'ok' }) }],
          }),
        }),
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

const schema = z.object({ value: z.string() });
const silent: MeterLog = { warn: () => undefined, error: () => undefined };
/** Hak 20 TL: bir çağrı 1,2 TL (%6). */
const LIMITS = { [AI_LIMIT_CREDIT_MONTHLY]: 20 };

let A: Awaited<ReturnType<typeof registerCompany>>;
const sent: ProductNoticeBody[] = [];
let answer: () => Promise<ProductNoticeResponse> = async () => ({ status: 'queued', recipients: 2 });

const ctx = (over: Partial<AiCallContext> = {}): AiCallContext => ({
  companyId: A.companyId,
  memberId: A.userId,
  kind: 'TARIFF_REVIEW',
  limits: LIMITS,
  log: silent,
  ...over,
});
const call = async (tag = uniq('c')) => {
  const r = await meteredCall(ctx(), { schema, system: 'sys', maxTokens: 2000, effort: 'low', content: [{ type: 'text', text: tag }] });
  await drainAiQuotaNotices();
  return r;
};
/** Dönemde önceden harcanmış tutar (TL): sayaç satırı doğrudan. */
async function spent(tl: number) {
  const { period } = await aiAllowance(A.companyId, LIMITS);
  await inCompany(A.companyId, () =>
    prisma.aiUsage.create({
      data: { companyId: A.companyId, kind: 'TARIFF_REVIEW', status: 'OK', period, model: 'claude-sonnet-5-5', cost: tl, priceVersion: 'test', durationMs: 1 },
    }),
  );
}
const markers = () => inCompany(A.companyId, () => prisma.auditLog.findMany({ where: { companyId: A.companyId, action: 'ai.quotaNotice' } }));

const ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'AI_QUOTA_ENFORCED', 'AI_PRICE_TRY_PER_USD', 'AI_PRICE_TABLE'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  A = await registerCompany(await getApp(), uniq('Hak postası '));
});
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  process.env.AI_PRICE_TRY_PER_USD = '100';
  delete process.env.AI_PRICE_TABLE;
  delete process.env.AI_QUOTA_ENFORCED;
  resetAiMeterState();
  sent.length = 0;
  answer = async () => ({ status: 'queued', recipients: 2 });
  setNotifier(async (body) => {
    sent.push(body);
    return answer();
  });
  await inCompany(A.companyId, async () => {
    await prisma.aiUsage.deleteMany({ where: { companyId: A.companyId } });
    await prisma.auditLog.deleteMany({ where: { companyId: A.companyId, action: 'ai.quotaNotice' } });
  });
});
afterEach(() => {
  setNotifier(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => setNotifier(null));

describe('KALANLAR 6.5: hak %80 postası', () => {
  it('%80 altında posta yok; %80 eşiğini geçen çağrıdan sonra tek posta, ayar yetkililerine, tekrar anahtarı dönemle', async () => {
    await spent(13.4);
    await call(); // 13,4 + 1,2 = 14,6 TL: %73
    expect(sent).toHaveLength(0);
    await call(); // 15,8 TL: %79
    expect(sent).toHaveLength(0);
    await call(); // 17 TL: %85
    expect(sent).toHaveLength(1);
    const { period } = await aiAllowance(A.companyId, LIMITS);
    expect(sent[0]).toMatchObject({
      product: 'deciship',
      orgId: A.companyId,
      dedupeKey: `ai-quota-80:${period}`,
      audience: { permission: 'deciship.settings.manage' },
    });
    // iki dil; yüzde metinde, tutar yok
    expect(sent[0]!.message.tr.lines.join(' ')).toContain('%85');
    expect(sent[0]!.message.en.lines.join(' ')).toContain('85%');
    expect(JSON.stringify(sent[0])).not.toMatch(/17[.,]0|\bTL\b|₺/);
    expect(await markers()).toHaveLength(1);
    // aynı ay: ikinci posta yok (süreç belleği), yeniden başlatmadan sonra da yok (kalıcı işaret)
    await call(); // %91
    resetAiMeterState();
    await call(); // %97
    expect(sent).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
  });

  it('gönderilemezse (ağ, alıcı yok) işaret yazılmaz: sonraki çağrı yeniden dener; başarıda bir kez işaretlenir', async () => {
    await spent(15); // %81, %87, %93, %99
    answer = async () => {
      throw new NotifyError('TIMEOUT');
    };
    await call();
    expect(sent).toHaveLength(1);
    expect(await markers()).toHaveLength(0);
    // bekleme süresi içinde yeniden sorulmaz
    await call();
    expect(sent).toHaveLength(1);
    // bekleme bitti (süreç belleği boşaldı): alıcı yok da başarı sayılmaz
    resetAiMeterState();
    answer = async () => ({ status: 'no_recipients', recipients: 0 });
    await call();
    expect(sent).toHaveLength(2);
    expect(await markers()).toHaveLength(0);
    resetAiMeterState();
    answer = async () => ({ status: 'duplicate', recipients: 0 });
    await call();
    expect(sent).toHaveLength(3);
    expect(await markers()).toHaveLength(1);
  });

  it('hak uygulanmıyorsa (AI_QUOTA_ENFORCED=false) posta yok', async () => {
    process.env.AI_QUOTA_ENFORCED = 'false';
    await spent(17);
    await call();
    expect(sent).toHaveLength(0);
  });

  it('çağrının sonucu postayı beklemez: bildirim asılı kalsa da yanıt döner', async () => {
    await spent(16);
    let release!: () => void;
    answer = () => new Promise((res) => (release = () => res({ status: 'queued', recipients: 1 })));
    const r = await meteredCall(ctx(), { schema, system: 'sys', maxTokens: 2000, effort: 'low', content: [{ type: 'text', text: uniq('asılı') }] });
    expect(r.data).toEqual({ value: 'ok' });
    // posta arkada istenir; yanıt geldiğinde henüz cevaplanmadı
    for (const end = Date.now() + 5000; sent.length === 0 && Date.now() < end;) await new Promise((res) => setTimeout(res, 5));
    expect(sent).toHaveLength(1);
    expect(await markers()).toHaveLength(0);
    release();
    await drainAiQuotaNotices();
    expect(await markers()).toHaveLength(1);
  });
});

describe('KALANLAR 6.5: ay dönümü', () => {
  it('çağrı eski dönemde başlayıp yeni dönemde bittiyse (dönem artık geçerli değil) eski dönemin postası gitmez', async () => {
    const { timeZone } = await aiAllowance(A.companyId, LIMITS);
    noticeAiQuota({ companyId: A.companyId, period: '2020-01', pct: 95, resetsDay: '2020-02-01', timeZone, log: silent });
    await drainAiQuotaNotices();
    expect(sent).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
  });
});

describe('posta gövdesi', () => {
  it('Hesap servisinin kuralına uyar (düz metin, sınırlar), iki dilde, eylem yolu yok', () => {
    const body = buildAiQuotaNotice({ companyId: A?.companyId ?? '0190a1b2-0000-7000-8000-000000000000', period: '2026-11', pct: 83, resetsDay: '2026-12-01' });
    expect(AI_QUOTA_NOTICE_PCT).toBe(80);
    for (const l of ['tr', 'en'] as const) {
      const t = body.message[l];
      expect(isNoticePlainText(t.subject, NOTICE_LIMITS.subject)).toBe(true);
      expect(t.lines.length).toBeGreaterThanOrEqual(NOTICE_LIMITS.linesMin);
      expect(t.lines.length).toBeLessThanOrEqual(NOTICE_LIMITS.linesMax);
      for (const line of t.lines) expect(isNoticePlainText(line, NOTICE_LIMITS.line), line).toBe(true);
      if (t.footer) expect(isNoticePlainText(t.footer, NOTICE_LIMITS.footer)).toBe(true);
      expect(t.action).toBeUndefined();
    }
    expect(body.message.tr.subject).toContain('%83');
    expect(body.message.en.subject).toContain('83%');
    // yeni hak tarihi iki dilde de yazılı
    expect(body.message.tr.lines.join(' ')).toMatch(/Aralık 2026/);
    expect(body.message.en.lines.join(' ')).toMatch(/December 2026/);
    expect(body.dedupeKey).toBe('ai-quota-80:2026-11');
  });
});
