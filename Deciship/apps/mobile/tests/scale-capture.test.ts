import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCALE_CAPTURE_RESET, scaleAfterCapture, scaleCameraDisabled, scaleHintKey, weightMethodOf } from '../src/lib/scaleCapture';

const dict = (lang: 'tr' | 'en') =>
  JSON.parse(readFileSync(new URL(`../src/locales/${lang}/measure.json`, import.meta.url), 'utf8')) as { weight: Record<string, string> };

describe('tartı fotoğrafı çevrimdışı (11-B12)', () => {
  it('çevrimdışıyken fotoğraf düğmesi açık; yalnız okuma sürerken kapalı', () => {
    expect(scaleCameraDisabled({ reading: false, online: false })).toBe(false);
    expect(scaleCameraDisabled({ reading: false, online: true })).toBe(false);
    expect(scaleCameraDisabled({ reading: true, online: true })).toBe(true);
  });

  it('çevrimdışı çekimde okuma yapılmaz, ağırlık elle girilir', () => {
    expect(scaleAfterCapture(false, true)).toBe('manual');
    expect(scaleAfterCapture(true, true)).toBe('read');
  });
});

describe('tartı okuması firma ayarı (kullanıcı kararı 2026-11-12, varsayılan kapalı)', () => {
  it('kapalıyken çekilen fotoğraf yalnız saklanır: çevrimiçi de olsa okutulmaz, ileti yok', () => {
    expect(scaleAfterCapture(true, false)).toBe('keep');
    expect(scaleAfterCapture(false, false)).toBe('keep');
  });

  it('kapalıyken alt satırda "otomatik okuma" sözü geçmez; fotoğraftan sonra "değeri aşağıya girin"', () => {
    for (const online of [true, false]) {
      expect(scaleHintKey({ online, aiRead: false, read: false, hasPhoto: false })).toBe('weight.evidenceHint');
      expect(scaleHintKey({ online, aiRead: false, read: false, hasPhoto: true })).toBe('weight.photoSaved');
    }
    for (const lang of ['tr', 'en'] as const) {
      const w = dict(lang).weight;
      for (const k of ['evidenceHint', 'photoSaved'] as const) {
        expect(w[k], `${lang} ${k}`).toBeTruthy();
        expect(w[k]).not.toMatch(/otomatik|yapay zekâ|auto|AI\b/i);
      }
    }
  });

  it('inceleme 7: yeniden çekimde önceki okuma silinir; yeni fotoğrafta "Yapay zekâ okudu" kalmaz, yöntem elle', () => {
    // önceki fotoğraf 4,02 okundu; aynı değer okumayla eşleşirse OCR
    expect(weightMethodOf(4.02, 4.02)).toBe('OCR');
    expect(weightMethodOf(4.5, 4.02)).toBe('MANUAL');
    // yeniden çekim: okuma ve taslaktaki ocrWeightKg silinir
    expect(SCALE_CAPTURE_RESET).toEqual({ ocr: null, draft: { ocrWeightKg: null } });
    const ocrAfter = SCALE_CAPTURE_RESET.ocr as { value: number | null } | null;
    expect(weightMethodOf(4.02, ocrAfter?.value)).toBe('MANUAL');
    for (const aiRead of [true, false]) {
      expect(scaleHintKey({ online: true, aiRead, read: !!ocrAfter && ocrAfter.value !== null, hasPhoto: true })).toBe('weight.photoSaved');
    }
  });

  it('açıkken bugünkü satırlar aynen', () => {
    expect(scaleHintKey({ online: false, aiRead: true, read: false, hasPhoto: false })).toBe('weight.offlineAuto');
    expect(scaleHintKey({ online: false, aiRead: true, read: true, hasPhoto: true })).toBe('weight.offlineAuto');
    expect(scaleHintKey({ online: true, aiRead: true, read: true, hasPhoto: true })).toBe('weight.aiRead');
    expect(scaleHintKey({ online: true, aiRead: true, read: false, hasPhoto: true })).toBe('weight.photoSaved');
    expect(scaleHintKey({ online: true, aiRead: true, read: false, hasPhoto: false })).toBe('weight.autoHint');
  });
});
