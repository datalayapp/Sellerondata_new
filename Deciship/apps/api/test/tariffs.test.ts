import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { getApp, multipart, registerCompany, SAMPLES } from './helpers.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function body(carrierId: string) {
  return {
    carrierId,
    name: 'FedEx Test 2026',
    service: 'International Economy',
    currency: 'TRY',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [
      { upto: 20, step: 0.5 },
      { upto: null, step: 1 },
    ],
    discountPct: 38,
    fuelPct: 25,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    active: true,
    isDefault: true,
    zones: [
      { country: 'DE', zone: 'A' },
      { country: 'GB', zone: 'B' },
    ],
    rates: [
      { zone: 'A', weightUpto: 5.5, price: 1400 },
      { zone: 'A', weightUpto: 6, price: 1527.75 },
      { zone: 'B', weightUpto: 6, price: 1800 },
    ],
    overflow: [{ zone: 'A', perUnit: 100 }],
    surcharges: [{ code: 'REMOTE_AREA', name: 'Uzak bölge', kind: 'PER_KG', amount: 18.5 }],
  };
}

describe('carriers and tariffs', () => {
  it('CRUD, duplicate, quote', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex' } });
    expect(c.statusCode).toBe(201);
    const carrierId = c.json().carrier.id;
    expect(c.json().carrier.name).toBe('FedEx');

    const created = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: body(carrierId) });
    expect(created.statusCode).toBe(201);
    const t = created.json().tariff;
    expect(t).toMatchObject({ discountPct: 38, zones: [{ country: 'DE', zone: 'A' }, { country: 'GB', zone: 'B' }] });
    expect(t.rates).toHaveLength(3);

    const quote = await app.inject({
      method: 'POST',
      url: `/api/deciship/tariffs/${t.id}/quote`,
      headers: auth,
      payload: { lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, destCountry: 'DE' },
    });
    expect(quote.json()).toMatchObject({ ok: true, zone: 'A', base: 1527.75, discount: 580.55, fuel: 236.8, total: 1184, chargeableKg: 6, basis: 'VOLUMETRIC' });
    const noZone = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/quote`, headers: auth, payload: { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1, destCountry: 'JP' } });
    expect(noZone.json().ok).toBe(false);

    const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${t.id}`, headers: auth, payload: { ...body(carrierId), name: 'Yeni ad', fuelPct: 20 } });
    expect(put.json().tariff).toMatchObject({ name: 'Yeni ad', fuelPct: 20 });

    const dup = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/duplicate`, headers: auth });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().tariff).toMatchObject({ name: 'Yeni ad (kopya)', isDefault: false });

    const list = await app.inject({ method: 'GET', url: `/api/deciship/tariffs?carrierId=${carrierId}`, headers: auth });
    expect(list.json().items).toHaveLength(2);
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/tariffs/${dup.json().tariff.id}`, headers: auth })).statusCode).toBe(204);

    const bad = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: { ...body(carrierId), divisor: 'x' } });
    expect(bad.statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', url: `/api/deciship/carriers/${carrierId}`, headers: auth });
    expect(del.statusCode).toBe(204);
  });

  it('template download, import preview and apply', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const carrierId = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: 'FedEx TR' } })).json().carrier.id;
    const t = (await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: body(carrierId) })).json().tariff;

    const tpl = await app.inject({ method: 'GET', url: '/api/deciship/tariffs/template.xlsx', headers: auth });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.headers['content-type']).toBe(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name).slice(0, 3)).toEqual(['Fiyatlar', 'Bölgeler', 'Ek ücretler']);
    expect(wb.getWorksheet('Fiyatlar')!.getCell('A1').value).toBe('Ağırlık (kg/desi) ≤');

    const filled = await app.inject({ method: 'GET', url: `/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`, headers: auth });
    const roundTrip = multipart([{ name: 'file', filename: 'tarife.xlsx', contentType: XLSX_MIME, data: filled.rawPayload }]);
    const rt = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/import`, headers: { ...auth, ...roundTrip.headers }, payload: roundTrip.payload });
    expect(rt.json()).toMatchObject({ canApply: true, aiAvailable: false });
    expect(rt.json().checks.filter((c: { severity: string }) => c.severity !== 'info')).toEqual([]);
    expect(rt.json().rates).toHaveLength(3);
    expect(rt.json().overflow).toEqual([{ zone: 'A', perUnit: 100 }]);

    const samplePath = path.join(SAMPLES, 'tariff-template-example.xlsx');
    if (fs.existsSync(samplePath)) {
      const form = multipart([{ name: 'file', filename: 'ornek.xlsx', contentType: XLSX_MIME, data: fs.readFileSync(samplePath) }]);
      const preview = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/import`, headers: { ...auth, ...form.headers }, payload: form.payload });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().rates.length).toBeGreaterThan(50);
      expect(preview.json().zones.length).toBeGreaterThan(5);
      expect(preview.json().surcharges.length).toBe(2);

      expect(preview.json().canApply).toBe(true);
      // dosyada aşım satırı yok → mevcut aşım korunur (uyarı); yapay zekâ kapalı → onay gerekir
      expect(preview.json().checks.map((c: { code: string }) => c.code)).toContain('OVERFLOW_KEPT');
      const noAck = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${preview.json().draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: false } });
      expect(noAck.statusCode).toBe(409);
      const applied = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${preview.json().draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: true } });
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json().versionId).toBeTypeOf('string');
      const full = await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${t.id}`, headers: auth });
      expect(full.json().tariff.rates.length).toBe(preview.json().rates.length);
      const quote = await app.inject({
        method: 'POST',
        url: `/api/deciship/tariffs/${t.id}/quote`,
        headers: auth,
        payload: { lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, destCountry: 'FR' },
      });
      expect(quote.json().total).toBe(1184);
    }
  });

  it('settings and box presets', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const patch = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { amountTol: 10, requiredBoxPhotos: 2 } });
    expect(patch.json()).toMatchObject({ name: 'Test Şirketi', amountTol: 10, requiredBoxPhotos: 2, desiDivisor: 3000 });
    const bad = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { desiDivisor: 5 } });
    expect(bad.statusCode).toBe(400);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/box-presets', headers: auth, payload: { name: 'K4', lengthCm: 60, widthCm: 40, heightCm: 40 } });
    expect(p.statusCode).toBe(201);
    expect(p.json().preset.sortOrder).toBe(4);
    const upd = await app.inject({ method: 'PATCH', url: `/api/deciship/box-presets/${p.json().preset.id}`, headers: auth, payload: { active: false } });
    expect(upd.json().preset.active).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/box-presets/${p.json().preset.id}`, headers: auth })).statusCode).toBe(204);
  });

  it('serves the reference card to people who measure', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/reference-card.pdf' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/api/deciship/reference-card.pdf', headers: auth });
    if (fs.existsSync(path.join(SAMPLES, 'reference-card.pdf'))) {
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
    } else {
      expect(r.statusCode).toBe(404);
    }
  });
});
