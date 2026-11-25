import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  carrierLimits,
  EMPTY_PACKAGING_SETTINGS,
  limitView,
  normalizePackagingSettings,
  packagingCarrier,
  packagingCheckKey,
  packagingOf,
  packagingWarning,
  remeasurePackaging,
  type PackagingLimits,
} from '../src/lib/packaging';

const FEDEX: PackagingLimits = carrierLimits('fedex', EMPTY_PACKAGING_SETTINGS);
const dims = (l: number, w: number, h: number) => ({ l, w, h });
const NO_DIMS = { l: null, w: null, h: null };

describe('ambalajın taşıyıcısı', () => {
  it('takip no tek taşıyıcıya uyuyorsa o taşıyıcı', () => {
    expect(packagingCarrier('1Z999AA10123456784', { primaryCarrier: 'fedex' })).toBe('ups');
    // FedEx Ground 15 hane yalnız FedEx'e uyar.
    expect(packagingCarrier('123456789012345', { primaryCarrier: 'dhl' })).toBe('fedex');
    expect(packagingCarrier('9612019123456789012345', null)).toBe('fedex');
  });

  it('birden çok taşıyıcıya uyan ya da tanınmayan takip no → firmanın ana taşıyıcısı', () => {
    // 12 hane FedEx Express'e de yurt içi taşıyıcılara da uyar.
    expect(packagingCarrier('771234567890', { primaryCarrier: 'fedex' })).toBe('fedex');
    expect(packagingCarrier('771234567890', { primaryCarrier: 'dhl' })).toBe('dhl');
    expect(packagingCarrier('ABCDEFGH', { primaryCarrier: 'ups' })).toBe('ups');
    expect(packagingCarrier('', { primaryCarrier: 'ups' })).toBe('ups');
  });

  it('ana taşıyıcı da yoksa null (genel ad, sınır bilinmez)', () => {
    expect(packagingCarrier('771234567890', { primaryCarrier: null })).toBeNull();
    expect(packagingCarrier('ABCDEFGH', null)).toBeNull();
    expect(carrierLimits(null, EMPTY_PACKAGING_SETTINGS)).toEqual({});
  });
});

describe('firma ayarındaki sınırlar', () => {
  it('firma ayarı varsayılanı geçer; yoksa core varsayılanı', () => {
    expect(FEDEX).toEqual({ PAK: { maxKg: 2.5, maxVolumeCm3: 15400 }, ENVELOPE: { maxKg: 0.5, maxEdgesCm: [31.7, 24.1, 2] } });
    const s = normalizePackagingSettings({ primaryCarrier: 'fedex', carriers: { fedex: { PAK: { maxKg: 3, maxVolumeCm3: null }, ENVELOPE: null } } });
    expect(carrierLimits('fedex', s)).toEqual({ PAK: { maxKg: 3, maxVolumeCm3: null }, ENVELOPE: null });
    // Sınırı bilinmeyen taşıyıcı.
    expect(carrierLimits('aras', s)).toEqual({ PAK: null, ENVELOPE: null });
  });

  it('bozuk ya da eski yanıt boş sayılır; tanınmayan taşıyıcı atılır', () => {
    expect(normalizePackagingSettings(undefined)).toEqual({ primaryCarrier: null, carriers: {} });
    expect(normalizePackagingSettings('x')).toEqual({ primaryCarrier: null, carriers: {} });
    expect(normalizePackagingSettings({ primaryCarrier: 'acme', carriers: { acme: {}, ups: { PAK: 'x' }, dhl: 5 } })).toEqual({
      primaryCarrier: null,
      carriers: { ups: { PAK: null } },
    });
  });
});

describe('kaydetmeden önceki ambalaj uyarısı', () => {
  it('kendi ambalajı ama Pak sınırı içinde → Pak önerilir', () => {
    expect(packagingWarning('OWN', 1.8, dims(30, 25, 8), FEDEX)).toEqual({ kind: 'suggest', to: 'PAK' });
  });

  it('zarfa da sığıyorsa en ucuz olan zarf önerilir', () => {
    expect(packagingWarning('OWN', 0.3, dims(30, 20, 2), FEDEX)).toEqual({ kind: 'suggest', to: 'ENVELOPE' });
  });

  it('hafif ama zarfın kenarlarına sığmayan koli zarf önerisi almaz', () => {
    expect(packagingWarning('OWN', 0.3, dims(40, 30, 20), FEDEX)).toBeNull();
    // Kenar sınırı bilinmeyen zarf önerilmez (ağırlığa sığsa da).
    expect(packagingWarning('OWN', 0.3, dims(30, 20, 2), { ENVELOPE: { maxKg: 0.5, maxEdgesCm: null }, PAK: null })).toBeNull();
  });

  it('zarf seçili ama kenar sınırı aşılıyor → DIMENSION, Pak gibi fiyatlanır', () => {
    expect(packagingWarning('ENVELOPE', 0.3, dims(35, 25, 2), FEDEX)).toEqual({ kind: 'over', from: 'ENVELOPE', reasons: ['DIMENSION'], priced: 'PAK' });
  });

  it('kendi ambalajı ve hiçbir özel ambalaja sığmıyor → uyarı yok', () => {
    expect(packagingWarning('OWN', 3.1, dims(30, 25, 8), FEDEX)).toBeNull();
    expect(packagingWarning('OWN', 2, dims(40, 30, 20), FEDEX)).toBeNull();
  });

  it('sınırı bilinmeyen ambalaj önerilmez ve uyarı vermez', () => {
    const ups = carrierLimits('ups', EMPTY_PACKAGING_SETTINGS);
    expect(packagingWarning('OWN', 1.8, dims(30, 25, 8), ups)).toBeNull();
    expect(packagingWarning('PAK', 9, dims(60, 40, 40), ups)).toBeNull();
    expect(packagingWarning('PAK', 9, dims(60, 40, 40), {})).toBeNull();
  });

  it('Pak seçili ama ağırlık ya da hacim sınırı aşıyor → aşım uyarısı, kendi ambalajı gibi fiyatlanır', () => {
    expect(packagingWarning('PAK', 3.1, dims(39, 30, 9), FEDEX)).toEqual({ kind: 'over', from: 'PAK', reasons: ['WEIGHT'], priced: 'OWN' });
    expect(packagingWarning('PAK', 2, dims(40, 30, 20), FEDEX)).toEqual({ kind: 'over', from: 'PAK', reasons: ['VOLUME'], priced: 'OWN' });
    expect(packagingWarning('PAK', 1.8, dims(39, 30, 6), FEDEX)).toBeNull();
  });

  it('zarf ağırlığı aşıyor ama Pak sınırı içinde → Pak gibi fiyatlanır', () => {
    expect(packagingWarning('ENVELOPE', 1, dims(30, 20, 2), FEDEX)).toEqual({ kind: 'over', from: 'ENVELOPE', reasons: ['WEIGHT'], priced: 'PAK' });
  });

  it('ağırlık ya da ölçü eksikse uyarı yok', () => {
    expect(packagingWarning('OWN', null, dims(30, 25, 8), FEDEX)).toBeNull();
    expect(packagingWarning('PAK', 3.1, NO_DIMS, FEDEX)).toBeNull();
  });

  it('onay anahtarı ambalaj, ağırlık, ölçü ya da sınır değişince değişir (onay düşer)', () => {
    const base = packagingCheckKey('OWN', 1.8, dims(30, 25, 8), FEDEX);
    expect(packagingCheckKey('OWN', 1.8, dims(30, 25, 8), FEDEX)).toBe(base);
    const changed = [
      packagingCheckKey('PAK', 1.8, dims(30, 25, 8), FEDEX),
      packagingCheckKey('OWN', 1.9, dims(30, 25, 8), FEDEX),
      packagingCheckKey('OWN', 1.8, dims(30, 25, 9), FEDEX),
      packagingCheckKey('OWN', 1.8, dims(30, 25, 8), { ...FEDEX, PAK: { maxKg: 3, maxVolumeCm3: 15400 } }),
    ];
    for (const k of changed) expect(k).not.toBe(base);
  });
});

describe('ölçü ekranındaki sınır kartı', () => {
  it('Pak sınırı içinde: ücretli ağırlık gerçek kg, basamağa yukarı (desi yok)', () => {
    expect(limitView('PAK', 1.8, dims(39, 30, 6), FEDEX)).toEqual({
      packaging: 'PAK',
      known: true,
      maxKg: 2.5,
      maxVolumeCm3: 15400,
      maxEdgesCm: null,
      volumeCm3: 7020,
      ok: true,
      reasons: [],
      chargeableKg: 2,
    });
  });

  it('aşım nedenleri; ölçü eksikken sonuç yok', () => {
    expect(limitView('PAK', 3.1, dims(39, 30, 9), FEDEX)).toMatchObject({ ok: false, reasons: ['WEIGHT'], chargeableKg: null });
    expect(limitView('PAK', 1.8, NO_DIMS, FEDEX)).toMatchObject({ ok: null, volumeCm3: null });
    // Bilinen ağırlık aşımı ölçü girilmeden de görünür.
    expect(limitView('PAK', 3.1, NO_DIMS, FEDEX)).toMatchObject({ ok: false, reasons: ['WEIGHT'] });
    // Zarfta hacim sınırı yok, kenar sınırı var: ölçü girilmeden sonuç yok.
    expect(limitView('ENVELOPE', 0.4, NO_DIMS, FEDEX)).toMatchObject({ ok: null, maxVolumeCm3: null, maxEdgesCm: [31.7, 24.1, 2] });
    expect(limitView('ENVELOPE', 0.4, dims(30, 20, 1), FEDEX)).toMatchObject({ ok: true, chargeableKg: 0.5 });
    expect(limitView('ENVELOPE', 0.4, dims(35, 20, 1), FEDEX)).toMatchObject({ ok: false, reasons: ['DIMENSION'] });
  });

  it('sınırı bilinmiyor → known false; kendi ambalajında kart yok', () => {
    expect(limitView('PAK', 1, dims(10, 10, 10), carrierLimits('dhl', EMPTY_PACKAGING_SETTINGS))).toMatchObject({ known: false, ok: null });
    expect(limitView('OWN', 1, dims(10, 10, 10), FEDEX)).toBeNull();
  });
});

describe('kayıttaki ambalaj', () => {
  it('alan yoksa ya da tanınmıyorsa kendi ambalajı', () => {
    expect(packagingOf({})).toBe('OWN');
    expect(packagingOf(null)).toBe('OWN');
    expect(packagingOf({ packaging: 'BOX' })).toBe('OWN');
    expect(packagingOf({ packaging: 'PAK' })).toBe('PAK');
    expect(packagingOf({ packaging: 'ENVELOPE' })).toBe('ENVELOPE');
  });
});

describe('ekran bağlantıları', () => {
  const src = (p: string) => readFileSync(p, 'utf8');
  it('ölçü ekranında ambalaj seçimi; özet ve düzeltmede yanıtlanmamış ambalaj uyarısı kaydı kapatır', () => {
    expect(src('app/(tabs)/deciship/dims.tsx')).toContain('<PackagingPicker value={packaging} onChange={(p) => update({ packaging: p })}');
    const summary = src('app/(tabs)/deciship/summary.tsx');
    expect(summary).toContain('const needsConfirm = check.needsConfirm || packCheck.needsConfirm;');
    expect(summary).toContain('const blocked = problems.length > 0 || needsConfirm;');
    const edit = src('app/(tabs)/deciship/measurement/edit.tsx');
    expect(edit).toContain('disabled={!dirty || problems.length > 0 || needsNet || saving || confirmPending}');
    expect(edit).toContain('if (changes.packaging) patch.packaging = packaging;');
  });
});

describe('yeniden ölçmede ambalajın ön değeri', () => {
  it('önceki ölçümün ambalajı; alan yoksa (başkasının kaydı, eski sunucu) kendi ambalajı; önceki ölçüm yoksa dokunulmaz', () => {
    expect(remeasurePackaging({ packaging: 'PAK' })).toEqual({ packaging: 'PAK' });
    expect(remeasurePackaging({ packaging: 'ENVELOPE' })).toEqual({ packaging: 'ENVELOPE' });
    expect(remeasurePackaging({})).toEqual({ packaging: 'OWN' });
    expect(remeasurePackaging(null)).toEqual({});
    expect(remeasurePackaging(undefined)).toEqual({});
  });

  it('barkod ekranı sunucu ve kuyruk kaydının ambalajını yeni taslağa geçirir', () => {
    const scan = readFileSync('app/(tabs)/deciship/scan.tsx', 'utf8');
    expect(scan).toContain('update({ trackingRaw: code, replacesId, ...remeasurePackaging(previous) });');
    expect(scan).toContain('l.id ?? null, l);');
    expect(scan).toContain('d.weightKg, null, d);');
  });
});
