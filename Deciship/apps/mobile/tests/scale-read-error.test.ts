import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scaleReadErrorKey } from '../src/lib/scaleReadError';

const dict = (lang: 'tr' | 'en') =>
  JSON.parse(readFileSync(new URL(`../src/locales/${lang}/measure.json`, import.meta.url), 'utf8')) as { weight: Record<string, string> };

describe('tartı okuma hatası metni (Y62-E4)', () => {
  it('bu ayki yapay zekâ hakkı doldu: "okunamadı" değil, kendi metni', () => {
    expect(scaleReadErrorKey({ code: 'AI_QUOTA_EXCEEDED' })).toBe('weight.aiQuota');
  });

  it('mevcut durumlar aynı kalır', () => {
    expect(scaleReadErrorKey({ code: 'AI_DISABLED' })).toBe('weight.aiDisabled');
    expect(scaleReadErrorKey({ code: 'NETWORK', isNetwork: true })).toBe('weight.unreachable');
    expect(scaleReadErrorKey({ code: 'TIMEOUT' })).toBe('weight.unreachable');
    expect(scaleReadErrorKey({ code: 'AI_FAILED' })).toBe('weight.unreadable');
    expect(scaleReadErrorKey(null)).toBe('weight.unreadable');
  });

  it('firma okumayı kapattı (409 AI_DISABLED, telefon eski ayarla çektiyse; eski sürümler de aynı kodu tanır): "okunamadı" değil, "otomatik okuma kapalı, elle girin"', () => {
    expect(scaleReadErrorKey({ code: 'AI_DISABLED' })).toBe('weight.aiDisabled');
    expect(dict('tr').weight.aiDisabled).toMatch(/elle girin/);
    expect(dict('en').weight.aiDisabled).toMatch(/manually/);
  });

  it('05-B14: yuva ya da dakika sınırı dolu (429) ve servis yoğun (503 AI_BUSY): "okunamadı" değil, "yoğun, yeniden çekin"', () => {
    expect(scaleReadErrorKey({ code: 'TOO_MANY_REQUESTS' })).toBe('weight.aiBusy');
    expect(scaleReadErrorKey({ code: 'AI_BUSY' })).toBe('weight.aiBusy');
    expect(dict('tr').weight.aiBusy).toMatch(/birkaç saniye/i);
    expect(dict('en').weight.aiBusy).toMatch(/few seconds/);
  });

  it('sistemin günlük yapay zekâ tavanı doldu (429 AI_DAILY_BUDGET): "okunamadı" ya da "aylık hak" değil, "bugün için durduruldu, elle girin"', () => {
    expect(scaleReadErrorKey({ code: 'AI_DAILY_BUDGET' })).toBe('weight.aiDailyBudget');
    expect(dict('tr').weight.aiDailyBudget).toMatch(/bugün için durduruldu/);
    expect(dict('tr').weight.aiDailyBudget).toMatch(/elle girin/);
    expect(dict('en').weight.aiDailyBudget).toMatch(/paused for today/);
    expect(dict('en').weight.aiDailyBudget).toMatch(/manually/);
  });

  it('her anahtarın TR ve EN metni var; kota metni elle girmeyi söyler', () => {
    for (const k of ['weight.aiDisabled', 'weight.aiQuota', 'weight.aiDailyBudget', 'weight.aiBusy', 'weight.unreachable', 'weight.unreadable'] as const) {
      const leaf = k.slice('weight.'.length);
      expect(dict('tr').weight[leaf], k).toBeTruthy();
      expect(dict('en').weight[leaf], k).toBeTruthy();
    }
    expect(dict('tr').weight.aiQuota).toMatch(/elle/);
    expect(dict('en').weight.aiQuota).toMatch(/manually/);
  });
});
