/**
 * Merkez → Abonelik → Yapay zekâ kullanımı, ayrıntılı döküm: `GET /platform/ai-usage/calls` (sayfa, süzgeç, kayıt adı ve
 * bağlantısı, para gizleme, firma ayrımı), Excel'i (`/calls/export`, TR/EN başlık) ve özetin yeni alanları (sonuç dağılımı,
 * geçen ayın aynı süresi, seçilebilir aylar). Satırlar doğrudan yazılır (sağlayıcı yok).
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { aiNextPeriod, aiPeriodOf, type HubAiCall, type HubAiCallPage, type HubAiUsage } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { findMoneyKeys, getApp, inCompany, issueIdentity } from './helpers.ts';

const API = '/api/deciship/platform/ai-usage';
const TZ = 'Europe/Istanbul';
const prevPeriodOf = (p: string) => {
  const [y, m] = p.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

let app: FastifyInstance;
let A: Fixture;
let B: Fixture;
let period: string;
let fileName: string;
let previewFileId: string;
/** En yeni (dosyalı) satırın anı. */
let firstAt: number;
/** Fiyat izni olmayan ama ayar ve dışa aktarma izni olan kişi (özel rol). */
let noPrice: { authorization: string };
/** Ayar izni olan ama fatura ve tarife görmeyen kişi: kayıt adı ve bağlantısı gitmez. */
let noRecords: { authorization: string };
let noExport: { authorization: string };

const get = async <T,>(url: string, auth: { authorization: string }, lang = 'tr') => {
  const r = await app.inject({ method: 'GET', url, headers: { ...auth, 'accept-language': lang } });
  return { status: r.statusCode, body: r.statusCode === 200 && String(r.headers['content-type']).includes('json') ? (r.json() as T) : undefined, raw: r };
};

beforeAll(async () => {
  app = await getApp();
  A = await companyFixture(app);
  B = await companyFixture(app);
  period = aiPeriodOf(new Date(), TZ);
  const base = Date.now();
  const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000);
  firstAt = at(1).getTime();
  const row = (over: Record<string, unknown>) => ({
    companyId: A.companyId,
    memberId: A.admin.userId,
    kind: 'INVOICE_PDF' as const,
    status: 'OK' as const,
    period,
    model: 'claude-sonnet-5-5',
    servedModel: 'claude-sonnet-5-5',
    inputTokens: 1000,
    outputTokens: 200,
    cost: '1.234567',
    priceVersion: 'r42.5:abcdef012345',
    durationMs: 4200,
    ...over,
  });
  await inCompany(A.companyId, async () => {
    fileName = (await prisma.file.findFirstOrThrow({ where: { id: A.invoiceFileId } })).originalName ?? '';
    // faturaya hiç bağlanmamış dosya (sütun eşleme önizlemesi): adıyla, bağlantısız
    const preview = await prisma.file.create({
      data: { companyId: A.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: 'yok/onizleme.csv', sha256: 'x', originalName: 'onizleme.csv', createdById: A.admin.userId },
    });
    previewFileId = preview.id;
    await prisma.aiUsage.createMany({
      data: [
        // en yeni önce: 1 (dosya, fatura bağlantısı), 2 (tarife belgesi), 3 (ret, silinmiş kişi), 4 (kopuk akış), 5 (silinmiş dosya)
        row({ refType: 'File', refId: A.invoiceFileId, createdAt: at(1), cacheReadTokens: 300, cacheWriteTokens: 50 }),
        row({ kind: 'TARIFF_PDF_EXTRACT', refType: 'TariffDocument', refId: A.documentId, createdAt: at(2), memberId: A.worker.userId }),
        row({ kind: 'SCALE_READ', status: 'FAILED', errorCode: 'AI_REFUSED', memberId: null, createdAt: at(3), cost: '0.010000', inputTokens: 10, outputTokens: 5, servedModel: 'claude-opus-5-5' }),
        row({ kind: 'INVOICE_PDF', status: 'FAILED', errorCode: 'AI_FAILED', estimated: true, createdAt: at(4), cost: '0.500000', refType: 'File', refId: crypto.randomUUID() }),
        row({ kind: 'TARIFF_REVIEW', refType: 'TariffImportDraft', refId: A.draftId, createdAt: at(5), priceVersion: 'fixture' }),
        row({ kind: 'INVOICE_MAPPING', refType: 'File', refId: preview.id, createdAt: at(6) }),
        // önceki sonuçtan (ücretsiz): listede yok, özetteki `cachedCalls`
        row({ status: 'CACHED', cost: '0', inputTokens: 0, outputTokens: 0, createdAt: at(0) }),
        // geçen ay: listede yok; geçen ayın tamamı ve "aynı süre" karşılaştırması
        row({ period: prevPeriodOf(period), createdAt: new Date(base - 40 * 86_400_000), cost: '2.000000' }),
      ],
    });
  });
  await inCompany(B.companyId, () => prisma.aiUsage.create({ data: { ...row({ companyId: B.companyId, memberId: B.admin.userId, createdAt: at(1) }) } }));
  const perms = (...p: string[]) => issueIdentity({ companyId: A.companyId, orgName: A.admin.orgName, role: 'OZEL', name: 'Özel Rol', perms: ['deciship.web.access', ...p] }).then((x) => x.auth);
  noPrice = await perms('deciship.settings.manage', 'deciship.data.export', 'deciship.invoices.view', 'deciship.tariffs.view');
  noRecords = await perms('deciship.settings.manage', 'deciship.prices.view');
  noExport = await perms('deciship.settings.manage', 'deciship.prices.view', 'deciship.invoices.view');
});

describe('GET /platform/ai-usage/calls', () => {
  it('en yeni önce, sayfalı; önceki sonuçtan gelen ve geçen ayın satırları yok; kayıt adı ve bağlantısı', async () => {
    const all = await get<HubAiCallPage>(`${API}/calls`, A.admin.auth);
    expect(all.status, all.raw.body).toBe(200);
    expect(all.body).toMatchObject({ product: 'deciship', period, currency: 'TRY', page: 1, pageSize: 50, total: 6 });
    const items = all.body!.items;
    expect(items.map((c) => [c.kind, c.status, c.estimated])).toEqual([
      ['INVOICE_PDF', 'ok', false],
      ['TARIFF_PDF_EXTRACT', 'ok', false],
      ['SCALE_READ', 'refused', false],
      ['INVOICE_PDF', 'truncated', true],
      ['TARIFF_REVIEW', 'ok', false],
      ['INVOICE_MAPPING', 'ok', false],
    ]);
    const [file, doc, refused, cut, draft, preview] = items as [HubAiCall, HubAiCall, HubAiCall, HubAiCall, HubAiCall, HubAiCall];
    expect(file).toMatchObject({
      memberId: A.admin.userId,
      person: 'Yönetici Test',
      label: 'PDF fatura okuma',
      record: fileName,
      href: `/deciship/invoices/${A.invoiceId}?tab=ALL`,
      errorCode: null,
      tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, total: 1550 },
      durationMs: 4200,
      model: 'claude-sonnet-5-5',
      servedModel: 'claude-sonnet-5-5',
      amount: 1.23,
      deducted: true,
      priceVersion: 'r42.5:abcdef012345',
      priceUsdRate: 42.5,
    });
    expect(doc).toMatchObject({ record: 'x.pdf', href: `/deciship/tariffs/${A.tariffId}`, label: 'Tarife PDF okuma' });
    expect(refused).toMatchObject({ memberId: null, person: 'Kişi bilinmiyor', errorCode: 'AI_REFUSED', amount: 0.01, deducted: false, servedModel: 'claude-opus-5-5' });
    expect(refused).not.toHaveProperty('record');
    // silinmiş (bulunamayan) dosyanın adı da bağlantısı da yok
    expect(cut).toMatchObject({ errorCode: 'AI_FAILED', deducted: false, amount: 0.5 });
    expect(cut).not.toHaveProperty('record');
    expect(cut).not.toHaveProperty('href');
    expect(draft).toMatchObject({ record: 'x.csv', href: `/deciship/tariffs/${A.tariffId}`, priceUsdRate: null });
    // faturaya bağlanmamış dosya: adıyla, bağlantısız
    expect(preview).toMatchObject({ record: 'onizleme.csv' });
    expect(preview).not.toHaveProperty('href');

    // sayfalar örtüşmez, toplam aynı
    const ids: string[] = [];
    for (const page of [1, 2, 3]) {
      const r = await get<HubAiCallPage>(`${API}/calls?page=${page}&pageSize=2`, A.admin.auth);
      expect(r.body).toMatchObject({ page, pageSize: 2, total: 6 });
      ids.push(...r.body!.items.map((c) => c.id));
    }
    expect(ids).toEqual(items.map((c) => c.id));
    expect((await get<HubAiCallPage>(`${API}/calls?page=4&pageSize=2`, A.admin.auth)).body!.items).toEqual([]);
    // sayfa boyu tavanı
    expect((await get<HubAiCallPage>(`${API}/calls?pageSize=100000`, A.admin.auth)).body!.pageSize).toBe(200);

    const en = await get<HubAiCallPage>(`${API}/calls`, A.admin.auth, 'en');
    expect(en.body!.items.map((c) => c.label)).toEqual(['PDF invoice reading', 'Tariff PDF extraction', 'Scale reading', 'PDF invoice reading', 'Tariff review', 'Column mapping']);
    expect(en.body!.items[2]!.person).toBe('Unknown person');
  });

  it('süzgeçler: tür, kişi, silinmiş kişi, geçen ay; bozuk değer 400', async () => {
    const ids = async (q: string) => (await get<HubAiCallPage>(`${API}/calls?${q}`, A.admin.auth)).body!.items.map((c) => [c.kind, c.memberId]);
    expect(await ids('kind=INVOICE_PDF')).toEqual([
      ['INVOICE_PDF', A.admin.userId],
      ['INVOICE_PDF', A.admin.userId],
    ]);
    expect(await ids(`member=${A.worker.userId}`)).toEqual([['TARIFF_PDF_EXTRACT', A.worker.userId]]);
    expect(await ids('member=none')).toEqual([['SCALE_READ', null]]);
    expect(await ids(`kind=SCALE_READ&member=${A.admin.userId}`)).toEqual([]);
    const prev = await get<HubAiCallPage>(`${API}/calls?period=${prevPeriodOf(period)}`, A.admin.auth);
    expect(prev.body).toMatchObject({ period: prevPeriodOf(period), total: 1 });
    for (const bad of ['kind=YOK', 'member=a%20b', 'period=2026-13', `period=${aiNextPeriod(period)}`, 'period=2020-01', 'page=0', 'pageSize=abc', 'kind=SCALE_READ&kind=INVOICE_PDF']) {
      const r = await get(`${API}/calls?${bad}`, A.admin.auth);
      expect(r.status, bad).toBe(400);
      expect(r.raw.json().error.code, bad).toBe('VALIDATION');
    }
  });

  it('silinen faturanın dosya adı yazılmaz; fatura geri gelince yine görünür', async () => {
    const setDeleted = (deletedAt: Date | null) => inCompany(A.companyId, () => prisma.invoice.update({ where: { id: A.invoiceId }, data: { deletedAt } }));
    await setDeleted(new Date());
    try {
      const r = await get<HubAiCallPage>(`${API}/calls?kind=INVOICE_PDF`, A.admin.auth);
      expect(r.body!.items[0]).not.toHaveProperty('record');
      expect(r.body!.items[0]).not.toHaveProperty('href');
      expect(r.raw.body).not.toContain(fileName);
    } finally {
      await setDeleted(null);
    }
    const back = await get<HubAiCallPage>(`${API}/calls?kind=INVOICE_PDF`, A.admin.auth);
    expect(back.body!.items[0]).toMatchObject({ record: fileName });
    // önizleme dosyası diskten silindiyse (`purgedAt`) adı da gitmez
    await inCompany(A.companyId, () => prisma.file.update({ where: { id: previewFileId }, data: { purgedAt: new Date() } }));
    try {
      const r = await get<HubAiCallPage>(`${API}/calls?kind=INVOICE_MAPPING`, A.admin.auth);
      expect(r.body!.items[0]).not.toHaveProperty('record');
    } finally {
      await inCompany(A.companyId, () => prisma.file.update({ where: { id: previewFileId }, data: { purgedAt: null } }));
    }
  });

  it('firma ayrımı: B yalnız kendi satırını görür; A kişisiyle süzmek boş döner', async () => {
    const b = await get<HubAiCallPage>(`${API}/calls`, B.admin.auth);
    expect(b.body!.total).toBe(1);
    expect(b.body!.items[0]!.memberId).toBe(B.admin.userId);
    expect(b.raw.body).not.toContain(A.invoiceFileId);
    expect((await get<HubAiCallPage>(`${API}/calls?member=${A.admin.userId}`, B.admin.auth)).body!.total).toBe(0);
  });

  it('izin: ölçüm rolü 403; fiyat izni yoksa tutar ve fiyat tablosu gitmez; fatura/tarife izni yoksa kayıt adı gitmez', async () => {
    expect((await get(`${API}/calls`, A.worker.auth)).status).toBe(403);
    expect((await get(`${API}/calls/export`, A.worker.auth)).status).toBe(403);

    const cheap = await get<HubAiCallPage>(`${API}/calls`, noPrice);
    expect(cheap.status, cheap.raw.body).toBe(200);
    expect(findMoneyKeys(cheap.body)).toEqual([]);
    expect(cheap.body!.items[0]).toMatchObject({ record: fileName, deducted: true, tokens: { total: 1550 } });
    expect(cheap.body!.items[0]).not.toHaveProperty('priceVersion');
    const summary = await get<HubAiUsage>(API, noPrice);
    expect(findMoneyKeys(summary.body)).toEqual([]);
    expect(summary.body!.previous).not.toHaveProperty('usedAmount');

    const blind = await get<HubAiCallPage>(`${API}/calls`, noRecords);
    expect(blind.status).toBe(200);
    for (const c of blind.body!.items) {
      expect(c).not.toHaveProperty('record');
      expect(c).not.toHaveProperty('href');
    }
    expect(blind.raw.body).not.toContain(fileName);
    expect(blind.raw.body).not.toContain('x.pdf');
    // tutar fiyat izniyle gelir
    expect(blind.body!.items[0]!.amount).toBe(1.23);

    // dışa aktarma izni olmadan Excel yok
    expect((await get(`${API}/calls/export`, noExport)).status).toBe(403);
  });
});

async function readSheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const rows: unknown[][] = [];
  ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
  return { name: ws.name, rows, fmt: ws.getCell('A2').numFmt };
}

describe('GET /platform/ai-usage/calls/export', () => {
  it('Excel: dosya adı, TR/EN başlıklar, süzgeç, satırlar; denetim kaydı', async () => {
    const tr = await app.inject({ method: 'GET', url: `${API}/calls/export`, headers: { ...A.admin.auth, 'accept-language': 'tr' } });
    expect(tr.statusCode, tr.body).toBe(200);
    expect(tr.headers['content-type']).toContain('spreadsheetml');
    expect(tr.headers['content-disposition']).toBe(`attachment; filename="deciship-yapay-zeka-${period}.xlsx"`);
    expect(tr.headers['cache-control']).toBe('private, no-store');
    const sheet = await readSheet(tr.rawPayload);
    expect(sheet.name).toBe('Yapay zekâ kullanımı');
    expect(sheet.rows[0]).toEqual([
      'Zaman', 'Kişi', 'İşlem', 'Kayıt', 'Sonuç', 'Giren token', 'Çıkan token', 'Önbellekten okunan', 'Önbelleğe yazılan', 'Süre (sn)',
      'Maliyet (TL, KDV hariç)', 'Aylık haktan düştü', 'İstenen model', 'Yanıt veren model', 'Fiyat tablosu',
    ]);
    expect(sheet.rows).toHaveLength(7);
    expect(sheet.rows[1]!.slice(1)).toEqual(['Yönetici Test', 'PDF fatura okuma', fileName, 'Başarılı', 1000, 200, 300, 50, 4.2, 1.23, 'Evet', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'r42.5:abcdef012345']);
    // tarih hücresi: firmanın duvar saati (Excel saat dilimi bilmez), TR biçimi
    expect(sheet.rows[1]![0]).toBeInstanceOf(Date);
    expect(sheet.fmt).toBe('dd.mm.yyyy hh:mm');
    const wall = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(firstAt));
    expect((sheet.rows[1]![0] as Date).toISOString().slice(0, 16).replace('T', ' ')).toBe(wall);
    expect(sheet.rows[3]!.slice(1, 5)).toEqual(['Kişi bilinmiyor', 'Tartı okuma', '', 'Okunamadı']);
    expect(sheet.rows[4]![4]).toBe('Yarıda kaldı · tahmini');

    const en = await app.inject({ method: 'GET', url: `${API}/calls/export?kind=SCALE_READ`, headers: { ...A.admin.auth, 'accept-language': 'en' } });
    expect(en.statusCode, en.body).toBe(200);
    expect(en.headers['content-disposition']).toBe(`attachment; filename="deciship-ai-usage-${period}.xlsx"`);
    const enSheet = await readSheet(en.rawPayload);
    expect(enSheet.name).toBe('AI usage');
    expect(enSheet.rows[0]!.slice(0, 5)).toEqual(['Time', 'Person', 'Operation', 'Record', 'Result']);
    expect(enSheet.rows).toHaveLength(2);
    expect(enSheet.rows[1]![0]).toBeInstanceOf(Date);
    expect(enSheet.fmt).toBe('yyyy-mm-dd hh:mm');
    expect(enSheet.rows[1]!.slice(1, 5)).toEqual(['Unknown person', 'Scale reading', '', 'Could not read']);

    const trail = await inCompany(A.companyId, () => prisma.auditLog.findFirst({ where: { companyId: A.companyId, action: 'data.export', entity: 'AiUsage' }, orderBy: { createdAt: 'desc' } }));
    expect(trail).toMatchObject({ entityId: period, userId: A.admin.userId });
  });

  it('fiyat izni yoksa tutar, haktan düşme ve fiyat tablosu sütunları yok; bozuk süzgeç 400', async () => {
    const r = await app.inject({ method: 'GET', url: `${API}/calls/export`, headers: { ...noPrice, 'accept-language': 'tr' } });
    expect(r.statusCode, r.body).toBe(200);
    const sheet = await readSheet(r.rawPayload);
    expect(sheet.rows[0]).toEqual(['Zaman', 'Kişi', 'İşlem', 'Kayıt', 'Sonuç', 'Giren token', 'Çıkan token', 'Önbellekten okunan', 'Önbelleğe yazılan', 'Süre (sn)', 'Aylık haktan düştü', 'İstenen model', 'Yanıt veren model']);
    expect(JSON.stringify(sheet.rows)).not.toContain('r42.5');
    expect((await app.inject({ method: 'GET', url: `${API}/calls/export?kind=YOK`, headers: A.admin.auth })).statusCode).toBe(400);
  });
});

describe('GET /platform/ai-usage: ayrıntılı dökümün özeti', () => {
  it('sonuç dağılımı, geçen ayın aynı süresi, seçilebilir aylar', async () => {
    const r = await get<HubAiUsage>(API, A.admin.auth);
    expect(r.status, r.raw.body).toBe(200);
    const u = r.body!;
    expect(u).toMatchObject({ calls: 6, cachedCalls: 1, estimatedCalls: 1, statusCounts: { ok: 4, refused: 1, truncated: 1, failed: 0 } });
    expect(Object.values(u.statusCounts!).reduce((a, b) => a + b, 0)).toBe(u.calls);
    // geçen ayın satırı 40 gün önce: bu ayın geçen süresi içinde değilse karşılaştırmaya girmez
    const prev = u.previous!;
    expect(prev.period).toBe(prevPeriodOf(period));
    expect(Date.parse(prev.to)).toBeLessThanOrEqual(Date.parse(u.periodStart));
    expect(Date.parse(prev.from)).toBeLessThan(Date.parse(prev.to));
    // firma bugün açıldı: seçilebilir tek ay bu ay
    expect(u.firstPeriod).toBe(period);
    expect(u.months).toEqual([{ period, calls: 6 }]);

    // geçmiş ay seçilince önceki ayın tamamı karşılaştırılır
    const past = await get<HubAiUsage>(`${API}?period=${prevPeriodOf(period)}`, A.admin.auth);
    expect(past.body).toMatchObject({ calls: 1, usedAmount: 2, statusCounts: { ok: 1, refused: 0, truncated: 0, failed: 0 } });
    expect(past.body!.previous!.to).toBe(past.body!.periodStart);
    // firma iki ay önce açıldıysa iki ay seçilebilir; 12 aydan eskisi asla
    await inCompany(A.companyId, () => prisma.company.update({ where: { id: A.companyId }, data: { createdAt: new Date(Date.now() - 45 * 86_400_000) } }));
    const older = await get<HubAiUsage>(API, A.admin.auth);
    expect(older.body!.months!.map((m) => m.period).slice(0, 2)).toEqual([period, prevPeriodOf(period)]);
    expect(older.body!.months!.find((m) => m.period === prevPeriodOf(period))!.calls).toBe(1);
    expect(older.body!.firstPeriod).toBe(older.body!.months!.at(-1)!.period);
    await inCompany(A.companyId, () => prisma.company.update({ where: { id: A.companyId }, data: { createdAt: new Date(Date.now() - 800 * 86_400_000) } }));
    const ancient = await get<HubAiUsage>(API, A.admin.auth);
    expect(ancient.body!.months).toHaveLength(13);
  });
});
