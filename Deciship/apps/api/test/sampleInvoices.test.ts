import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../src/env.ts';
import { getApp, multipart, registerCompany, uniq, writeTimeZone } from './helpers.ts';

/** Kurulum: örnek faturalar tek adımda yüklenir; listede, Pano'da ve gerçek faturaların mükerrer kontrolünde yok sayılır. */
describe('POST /invoices/samples (kurulum örnek faturası)', () => {
  it('eşlemesiz okunur, yalnız kurulumda görünür, gerçek faturayı mükerrer yapmaz', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app, 'Örnek Fatura');
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: uniq('FedEx') } });
    expect(c.statusCode, c.body).toBe(201);
    const carrierId = c.json().carrier.id as string;
    const csv = fs.readFileSync(path.join(REPO_ROOT, 'samples', 'invoices', 'fedex-9-482-11735.csv'));
    const upload = (url: string) => {
      const form = multipart([
        { name: 'carrierId', value: carrierId },
        { name: 'file', filename: 'fedex-9-482-11735.csv', contentType: 'text/csv', data: csv },
      ]);
      return app.inject({ method: 'POST', url, headers: { ...auth, ...form.headers }, payload: form.payload });
    };

    const s = await upload('/api/deciship/invoices/samples');
    expect(s.statusCode, s.body).toBe(201);
    expect(s.json().lines).toBeGreaterThan(10);
    expect(s.json().invoice).toMatchObject({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27' });
    const sampleId = s.json().invoice.id as string;

    // listede ve Pano'da yok; kurulumda var
    expect((await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth })).json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/dashboard', headers: auth })).json().invoices.count).toBe(0);
    const ob = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: auth })).json();
    expect(ob.invoices.map((i: { id: string }) => i.id)).toEqual([sampleId]);
    // tarife uyumu raporu örnek faturada da çalışır
    expect((await app.inject({ method: 'GET', url: `/api/deciship/invoices/${sampleId}/tariff-health`, headers: auth })).statusCode).toBe(200);

    // aynı faturanın gerçeği: numara çakışması ya da "satırlar zaten yüklenmiş" yok, satırlar mükerrer değil
    const pv = await upload('/api/deciship/invoices/preview');
    expect(pv.statusCode, pv.body).toBe(200);
    const real = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: {
        fileId: pv.json().fileId,
        carrierId,
        invoiceNo: '9-482-11735',
        invoiceDate: '2026-10-27',
        currency: 'TRY',
        mapping: pv.json().suggestedMapping,
        acknowledgeIssues: true,
      },
    });
    expect(real.statusCode, real.body).toBe(201);
    expect(real.json().skipped).toBeUndefined();
    const realId = real.json().invoice.id as string;
    // mükerrer satırlar yalnız dosyanın kendi içindeki tekrarlar (örnek faturadakiyle aynı sayı)
    const dups = async (id: string) =>
      ((await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?pageSize=100`, headers: auth })).json().items as { diffTypes: string[] }[]).filter((l) =>
        l.diffTypes.includes('DUPLICATE'),
      ).length;
    expect(await dups(realId)).toBe(await dups(sampleId));
    expect((await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth })).json().items.map((i: { id: string }) => i.id)).toEqual([realId]);

    // gerçek fatura varken de örnek yüklenebilir; kaldırılınca kurulum listesinden düşer
    expect((await upload('/api/deciship/invoices/samples')).statusCode).toBe(201);
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/invoices/${sampleId}`, headers: auth })).statusCode).toBeLessThan(300);
    const ob2 = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: auth })).json();
    expect(ob2.invoices).toHaveLength(1);
    expect(ob2.invoices[0].id).not.toBe(sampleId);
  });

  it('sütunları tanınamayan dosya anlaşılır hatayla reddedilir', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app, 'Örnek Fatura Hata');
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'aras', name: uniq('Aras') } });
    const form = multipart([
      { name: 'carrierId', value: c.json().carrier.id },
      { name: 'file', filename: 'x.csv', contentType: 'text/csv', data: Buffer.from('Renk;Boy\nmavi;3\nkırmızı;4\n') },
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/samples', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('otomatik tanınamadı');
  });
  it('dosyada fatura tarihi yoksa en geç gönderim tarihi kullanılır, bugün değil', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app, 'Örnek Fatura Tarihsiz');
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: uniq('FedEx') } });
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'samples', 'invoices', 'fedex-9-482-11735.csv'), 'utf8').replace('Invoice Date', 'Etiket');
    const form = multipart([
      { name: 'carrierId', value: c.json().carrier.id },
      { name: 'file', filename: 'fedex-9-482-11735.csv', contentType: 'text/csv', data: Buffer.from(raw) },
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/samples', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(201);

    expect(r.json().invoice.invoiceDate).toBe('2026-10-22');
  });

  // Y6: dosyada ne fatura ne gönderim tarihi varsa yedek tarih firmanın bugünüdür (saat dilimi ayarı), UTC'nin değil.
  // 2026-11-12T22:30Z İstanbul'da 13 Kasım 01:30'dur: eskiden 12 Kasım yazılıyordu (tarife ve kur günü bir gün geri).
  it('dosyada tarih yoksa yedek tarih firmanın saat dilimindeki bugün (gece 00–03 arası UTC günü değil)', async () => {
    const app = await getApp();
    const { auth, companyId } = await registerCompany(app, 'Örnek Fatura Gece');
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: uniq('FedEx') } });
    expect(c.statusCode, c.body).toBe(201);
    const raw = fs
      .readFileSync(path.join(REPO_ROOT, 'samples', 'invoices', 'fedex-9-482-11735.csv'), 'utf8')
      .replace('Invoice Date', 'Etiket')
      .replace('Shipment Date', 'Not');
    const upload = () => {
      const form = multipart([
        { name: 'carrierId', value: c.json().carrier.id },
        { name: 'file', filename: 'fedex-9-482-11735.csv', contentType: 'text/csv', data: Buffer.from(raw) },
      ]);
      return app.inject({ method: 'POST', url: '/api/deciship/invoices/samples', headers: { ...auth, ...form.headers }, payload: form.payload });
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-12T22:30:00.000Z'));
      const night = await upload();
      expect(night.statusCode, night.body).toBe(201);
      expect(night.json().invoice.invoiceDate).toBe('2026-11-13');
      // firmanın saat dilimi değişince onun günü: New York'ta aynı an 12 Kasım 17:30 (tek yazarı Merkez, Y131)
      await writeTimeZone(companyId, 'America/New_York');
      const ny = await upload();
      expect(ny.statusCode, ny.body).toBe(201);
      expect(ny.json().invoice.invoiceDate).toBe('2026-11-12');
    } finally {
      vi.useRealTimers();
    }
  });
});

