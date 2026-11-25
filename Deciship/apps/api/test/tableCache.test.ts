/**
 * 06-B1, 19-B7: önizleme tablolarının önbelleği bayt, süre ve sayıyla sınırlı; tek başına sınırı aşan tablo tutulmaz,
 * içe aktarma ve vazgeçme girdiyi siler. Önbellek kapalıyken (her doğrulama dosyadan yeniden okur) önizleme, eşleme
 * değişikliği ve içe aktarma sonuçları birebir aynıdır.
 */
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Table } from '@deciship/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { absolutePath } from '../src/lib/storage.ts';
import { estimateTableBytes, TableCache } from '../src/lib/tableCache.ts';
import { tableCache } from '../src/routes/invoices.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany, multipart } from './helpers.ts';

const API = '/api/deciship';

function table(rows: number, cols: number, cell = 'Değer-12345'): Table {
  return { headers: Array.from({ length: cols }, (_, i) => `S${i}`), rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `${cell}-${r}-${c}`)) };
}

describe('tablo önbelleği (birim)', () => {
  it('boyut tahmini satır ve sütunla büyür, örneklemeyle hesaplanır', () => {
    const small = estimateTableBytes(table(1_000, 10));
    const big = estimateTableBytes(table(10_000, 10));
    expect(big / small).toBeGreaterThan(9);
    expect(big / small).toBeLessThan(11);
    // hücre başına en az dizge başlığı + gösterge
    expect(small).toBeGreaterThan(1_000 * 10 * 24);
  });

  it('bağımsız inceleme: uzun metinler örneklenmeyen satırlarda toplansa da tahmin karakter baytlarının altına düşmez', () => {
    // 100.000 kısa satırın başında 300 satırlık açıklama bloğu (her biri 100.000 karakter): eski tahmin yalnız örnek
    // satırlara bakıyordu (100.000 / 256 satırda bir), bloğun hiçbirini görmeyip ~10 MB diyordu; gerçek 30 MB'ın üstü.
    const rows: string[][] = Array.from({ length: 100_000 }, (_, r) => [`77${r}`, '1']);
    for (let r = 1; r <= 300; r++) rows[r] = [`77${r}`, 'a'.repeat(100_000)];
    const t: Table = { headers: ['Takip', 'Açıklama'], rows };
    const chars = rows.reduce((n, row) => n + row[0]!.length + row[1]!.length, 0);
    expect(estimateTableBytes(t)).toBeGreaterThan(chars);
    // Latin-1 dışı karakterli tabloda iki baytlık pay eklenir
    const tr = estimateTableBytes({ headers: ['A'], rows: Array.from({ length: 1_000 }, () => ['ş'.repeat(64)]) });
    const en = estimateTableBytes({ headers: ['A'], rows: Array.from({ length: 1_000 }, () => ['s'.repeat(64)]) });
    expect(tr - en).toBeGreaterThanOrEqual(1_000 * 64);
  });

  it('bayt sınırı aşılınca en uzun süredir kullanılmayan bırakılır; kullanılan sona geçer', () => {
    const one = estimateTableBytes(table(1_000, 10));
    const c = new TableCache(() => ({ maxBytes: one * 2.5, ttlMs: 60_000, maxEntries: 8 }));
    expect(c.set('a', table(1_000, 10))).toBe(true);
    expect(c.set('b', table(1_000, 10))).toBe(true);
    expect(c.get('a')).toBeDefined(); // a artık en yeni
    expect(c.set('c', table(1_000, 10))).toBe(true);
    expect(c.stats().ids).toEqual(['a', 'c']);
    expect(c.stats().bytes).toBeLessThanOrEqual(one * 2.5);
  });

  it('tek başına sınırı aşan tablo tutulmaz, ötekileri de düşürmez; sınır 0: kapalı', () => {
    const one = estimateTableBytes(table(1_000, 10));
    const c = new TableCache(() => ({ maxBytes: one * 2.5, ttlMs: 60_000, maxEntries: 8 }));
    c.set('a', table(1_000, 10));
    expect(c.set('huge', table(10_000, 10))).toBe(false);
    expect(c.get('huge')).toBeUndefined();
    expect(c.stats().ids).toEqual(['a']);
    const off = new TableCache(() => ({ maxBytes: 0, ttlMs: 60_000, maxEntries: 8 }));
    expect(off.set('a', table(10, 2))).toBe(false);
    expect(off.stats().entries).toBe(0);
  });

  it('sayı sınırı (8) korunur; süresi dolan girdi düşer; silme', () => {
    let now = 0;
    const c = new TableCache(() => ({ maxBytes: 1e12, ttlMs: 1_000, maxEntries: 8 }), () => now);
    for (let i = 0; i < 10; i++) c.set(`t${i}`, table(5, 2));
    expect(c.stats().ids).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
    now = 500;
    expect(c.get('t9')).toBeDefined();
    now = 1_200;
    expect(c.get('t2')).toBeUndefined(); // 1.200 ms kullanılmadı
    expect(c.get('t9')).toBeDefined(); // 700 ms önce kullanıldı
    c.set('yeni', table(5, 2)); // eklemede süresi dolanlar temizlenir
    expect(c.stats().ids).toEqual(['t9', 'yeni']);
    c.delete('t9');
    expect(c.stats().ids).toEqual(['yeni']);
    c.clear();
  });
});

describe('tablo önbelleği (uçlar)', () => {
  let app: FastifyInstance;
  const saved = process.env.INVOICE_TABLE_CACHE_MB;

  beforeAll(async () => {
    app = await getApp();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INVOICE_TABLE_CACHE_MB;
    else process.env.INVOICE_TABLE_CACHE_MB = saved;
    tableCache.clear();
  });

  const CSV = Buffer.from(
    ['Takip No;Gönderi Tarihi;Desi;Tutar', ...Array.from({ length: 40 }, (_, i) => `${String(7_700_000_000 + i * 7)};2026-10-${String((i % 28) + 1).padStart(2, '0')};${(i % 9) + 1};${50 + i}`)].join('\n'),
  );

  /** Önizleme → iki eşleme değişikliği (doğrulama) → içe aktarma; kimlik ve zaman alanları dışında sonuçlar. */
  async function flow(f: Fixture) {
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: CSV },
    ]);
    const p = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    const { fileId, ...preview } = p.json();
    const cachedAfterPreview = tableCache.stats().ids.includes(fileId);
    const mapping = preview.suggestedMapping;
    const verify = async (m: unknown) => {
      const r = await app.inject({ method: 'POST', url: `${API}/invoices/preview/verify`, headers: f.admin.auth, payload: { fileId, carrierId: f.carrierId, mapping: m } });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    const v1 = await verify(mapping);
    const v2 = await verify({ ...mapping, shipDate: undefined });
    const imp = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: f.admin.auth,
      payload: { fileId, carrierId: f.carrierId, invoiceNo: 'ONB-1', invoiceDate: '2026-10-31', currency: 'TRY', mapping, acknowledgeIssues: true },
    });
    expect(imp.statusCode, imp.body).toBe(201);
    const inv = imp.json().invoice;
    const lines = (await app.inject({ method: 'GET', url: `${API}/invoices/${inv.id}/lines?pageSize=100`, headers: f.admin.auth })).json().items;
    return {
      cachedAfterPreview,
      cachedAfterImport: tableCache.stats().ids.includes(fileId),
      result: {
        preview,
        v1,
        v2,
        totals: inv.totals,
        importReport: imp.json().importReport ?? inv.importReport ?? null,
        lines: lines.map((l: Record<string, unknown>) => [l.rowIndex, l.trackingNo, l.status, l.diffTypes, l.expectedAmount, l.diffAmount, l.parseFlags, l.note]),
      },
    };
  }

  it('önbellek kapalıyken (her doğrulama dosyadan okur) önizleme, eşleme değişikliği ve içe aktarma aynı; içe aktarma girdiyi siler', async () => {
    const withCache = await flow(await companyFixture(app));
    expect(withCache.cachedAfterPreview).toBe(true);
    expect(withCache.cachedAfterImport).toBe(false);

    process.env.INVOICE_TABLE_CACHE_MB = '0';
    const without = await flow(await companyFixture(app));
    expect(without.cachedAfterPreview).toBe(false);
    expect(without.result).toEqual(withCache.result);
  });

  it('bağımsız inceleme: tablo bellekte değilken dosya diskten silinmişse doğrulama ve içe aktarma anlaşılır 404 döner', async () => {
    process.env.INVOICE_TABLE_CACHE_MB = '0';
    const f = await companyFixture(app);
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: CSV },
    ]);
    const p = (await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload })).json();
    const row = await inCompany(f.companyId, () => prisma.file.findFirstOrThrow({ where: { id: p.fileId }, select: { path: true } }));
    await fs.unlink(absolutePath(row.path));
    const verify = await app.inject({ method: 'POST', url: `${API}/invoices/preview/verify`, headers: f.admin.auth, payload: { fileId: p.fileId, carrierId: f.carrierId, mapping: p.suggestedMapping } });
    expect(verify.statusCode, verify.body).toBe(404);
    expect(verify.json().error).toEqual({ code: 'NOT_FOUND', message: 'Dosya bulunamadı; silinmiş olabilir' });
    const imp = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: f.admin.auth,
      payload: { fileId: p.fileId, carrierId: f.carrierId, invoiceNo: 'ONB-404', invoiceDate: '2026-10-31', currency: 'TRY', mapping: p.suggestedMapping, acknowledgeIssues: true },
    });
    expect(imp.statusCode, imp.body).toBe(404);
    expect(imp.json().error.code).toBe('NOT_FOUND');
  });

  it('önizlemeden vazgeçince tablo bellekten düşer', async () => {
    const f = await companyFixture(app);
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: CSV },
    ]);
    const { fileId } = (await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload })).json();
    expect(tableCache.stats().ids).toContain(fileId);
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/preview/${fileId}`, headers: f.admin.auth });
    expect(del.statusCode).toBe(204);
    expect(tableCache.stats().ids).not.toContain(fileId);
  });
});
