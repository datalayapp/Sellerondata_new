// Taşıyıcı ayarındaki poşet / zarf sınırı formu (lib/packagingLimits.ts): boş alan taşıyıcının varsayılanıdır, dolu alanın
// yanındaki boş alan varsayılandan tamamlanır, hiçbiri yoksa ayar silinir (null).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const L = await import('../src/lib/packagingLimits.ts');
const empty = { pakKg: '', pakVolume: '', envKg: '', envEdges: ['', '', ''] as [string, string, string] };

describe('poşet / zarf sınırı formu', () => {
  it('hepsi boş: ayar yok (null), varsayılan geçerli', () => {
    assert.deepEqual(L.limitsFromForm(empty, 'fedex'), { limits: null, error: null });
  });
  it("FedEx'te yalnız Pak kg: hacim varsayılandan kalır, zarf yazılmaz", () => {
    const r = L.limitsFromForm({ ...empty, pakKg: '3' }, 'fedex');
    assert.equal(r.error, null);
    assert.deepEqual(r.limits, { PAK: { maxKg: 3, maxVolumeCm3: L.defaultLimits('fedex').PAK!.maxVolumeCm3 } });
  });
  it('sınırı bilinmeyen taşıyıcıda kg olmadan hacim girilemez', () => {
    assert.equal(L.limitsFromForm({ ...empty, pakVolume: '20000' }, 'aras').error, 'pakKgRequired');
  });
  it('zarf kenarları üçü birlikte, büyükten küçüğe', () => {
    assert.equal(L.limitsFromForm({ ...empty, envEdges: ['30', '', ''] }, 'fedex').error, 'edgesPartial');
    const r = L.limitsFromForm({ ...empty, envKg: '0,4', envEdges: ['2', '30', '25'] }, 'aras');
    assert.deepEqual(r.limits, { ENVELOPE: { maxKg: 0.4, maxEdgesCm: [30, 25, 2] } });
  });
  it('sıfır ya da okunamayan değer hata', () => {
    assert.equal(L.limitsFromForm({ ...empty, envKg: '0' }, 'fedex').error, 'number');
    assert.equal(L.limitsFromForm({ ...empty, pakKg: 'abc' }, 'fedex').error, 'number');
  });
  it('kayıtlı ayar forma geri okunur ve aynı gövdeyi verir', () => {
    const saved = { PAK: { maxKg: 3, maxVolumeCm3: 20000 }, ENVELOPE: { maxKg: 0.4, maxEdgesCm: [30, 25, 2] as [number, number, number] } };
    assert.deepEqual(L.limitsFromForm(L.limitsForm(saved), 'fedex').limits, saved);
  });
});
