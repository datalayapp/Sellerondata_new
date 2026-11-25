import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { readSettings } from '../src/lib/settings.ts';
import { importDemoInvoice } from '../src/seedDemoDisputes.ts';
import { compareSettingsOf, readCompareSettings, sameCompareSettings } from '../src/services/compare.ts';
import { createWorker, getApp, inCompany, measurementPayload, registerCompany, SAMPLES, uniq } from './helpers.ts';

// GEÇİCİ (deneme dönemi) özellik: Ayarlar → Veriler. Özellik kaldırılınca bu test de silinir.
describe('Ayarlar → Veriler (deneme): sıfırla / örnek verileri yükle', () => {
  it('örnek verileri yükler, sonra yalnız bu şirketin verisini siler; hesaplar ve ayarlar kalır', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Veri Sıfırlama A');
    const b = await registerCompany(app, 'Veri Sıfırlama B');
    const worker = await createWorker(app, a.auth);
    const count = (companyId: string) =>
      inCompany(companyId, async () => ({
        carriers: await prisma.carrier.count({ where: { companyId } }),
        tariffs: await prisma.tariff.count({ where: { companyId } }),
        measurements: await prisma.measurement.count({ where: { companyId } }),
      }));
    const companyA = a.companyId;
    const companyB = b.companyId;

    // B şirketinde bir ölçüm: A'nın sıfırlaması ona dokunmamalı
    const wb = await createWorker(app, b.auth);
    const mp = measurementPayload();
    const mb = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...wb.auth, ...mp.headers }, payload: mp.payload });
    expect(mb.statusCode).toBe(201);

    // yalnız yönetici, onaysız istek reddedilir
    expect((await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: worker.auth, payload: { confirm: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: {} })).statusCode).toBe(400);

    const loaded = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true, samples: true } });
    expect(loaded.statusCode).toBe(200);
    const l = loaded.json().loaded;
    expect(l.carriers).toBeGreaterThan(0);
    expect(l.tariffs).toBeGreaterThan(0);
    expect(l.measurements).toBeGreaterThan(0);
    expect(await count(companyA)).toMatchObject({ carriers: l.carriers, tariffs: l.tariffs });
    // ölçümler firmanın ölçüm çalışanına yazılır
    const m = await inCompany(companyA, () => prisma.measurement.findFirstOrThrow({ where: { companyId: companyA } }));
    expect(m.measuredById).toBe(worker.userId);

    // ikinci kez yükleme: önce silinir, taşıyıcı kodu çakışmaz
    const again = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true, samples: true } });
    expect(again.statusCode).toBe(200);
    expect(again.json().removed.carriers).toBe(l.carriers);

    const cleared = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().loaded).toBeNull();
    expect(await count(companyA)).toEqual({ carriers: 0, tariffs: 0, measurements: 0 });
    // hesaplar ve ayarlar duruyor
    expect(await inCompany(companyA, () => prisma.member.count({ where: { companyId: companyA } }))).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: a.auth })).statusCode).toBe(200);
    // diğer şirket etkilenmedi
    expect((await count(companyB)).measurements).toBe(1);
  });
});

describe('demo itiraz tohumu dayanağıyla yazar (inceleme 6)', () => {
  it('importDemoInvoice: fatura tarife sürümü ve o günkü ayarla, satırlar sonucun sürümüyle; durum CURRENT', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Demo Tohum '));
    const loaded = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true, samples: true } });
    expect(loaded.statusCode, loaded.body).toBe(200);
    const expected = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8')) as { invoices: Parameters<typeof importDemoInvoice>[1][] };
    const sample = expected.invoices.find((s) => s.id === 'fedex-9-482-11735')!;
    expect(sample).toBeTruthy();

    const imported = await inCompany(a.auth, () => importDemoInvoice(a.companyId, sample, '2026-10-15', a.userId));
    const { inv, lines, company } = await inCompany(a.auth, async () => ({
      inv: await prisma.invoice.findFirstOrThrow({ where: { id: imported.id }, include: { tariff: true } }),
      lines: await prisma.invoiceLine.findMany({ where: { invoiceId: imported.id } }),
      company: await prisma.company.findFirstOrThrow({ where: { id: a.companyId } }),
    }));
    expect(inv.tariff).toBeTruthy();
    expect(inv.tariffRevisionId).toBe(inv.tariff!.currentRevisionId);
    expect(sameCompareSettings(readCompareSettings(inv.compareSettings), compareSettingsOf(readSettings(company.settings)))).toBe(true);
    const priced = lines.filter((l) => l.status !== 'NO_TARIFF');
    expect(priced.length).toBeGreaterThan(0);
    expect(new Set(priced.map((l) => l.tariffRevisionId))).toEqual(new Set([inv.tariffRevisionId]));
    const detail = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${imported.id}`, headers: a.auth });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().invoice.basis.state).toBe('CURRENT');
  });
});
