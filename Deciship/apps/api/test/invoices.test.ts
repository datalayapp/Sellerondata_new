import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { invoiceSummaryAmounts, overchargeNote } from '@deciship/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { findMoneyKeys, getApp, measurementPayload, multipart, SAMPLES, samplesExist, seedIdentity, inCompany } from './helpers.ts';
import { recalculate } from './recalcHelpers.ts';

type ExpectedLine = { row: number; trackingNo: string; status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null; confidence?: 'LOW'; reviewCode?: string };
type ExpectedInvoice = {
  id: string;
  file: string;
  carrierCode: string;
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
  suggestedMapping: Record<string, unknown>;
  lines: ExpectedLine[];
  totals: Record<string, number>;
  reviewTotals: { estimatedOverchargeTotal: number; estimatedLines: number };
};
type Expected = { uploadOrder: string[]; invoices: ExpectedInvoice[] };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('invoice import → compare (samples/)', () => {
  // Örnek klasörü depoda izlenir; yoksa takım sessizce atlanmaz, kırılır.
  it('samples/ klasörü yerinde', () => {
    expect(samplesExist, 'Deciship/samples/expected.json yok').toBe(true);
  });

  const expected: Expected = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8'));
  let auth: { authorization: string };
  let workerAuth: { authorization: string };
  const carriers = new Map<string, string>();
  const imported = new Map<string, string>();

  beforeAll(async () => {
    const app = await getApp();
    await seed({ reset: true, samples: true, log: () => {} });
    auth = (await seedIdentity('ADMIN')).auth;
    workerAuth = (await seedIdentity('MEASURE')).auth;
    const list = await app.inject({ method: 'GET', url: '/api/deciship/carriers', headers: auth });
    for (const c of list.json().items) carriers.set(c.code, c.id);
    // Altın sonuçlar katı kuralla yazıldı: tarifede olmayan ek ücretler fark sayılır.
    const def = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: auth });
    expect(def.json().unknownSurchargesAsDiff).toBe(false);
    const strict = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { unknownSurchargesAsDiff: true } });
    expect(strict.json().unknownSurchargesAsDiff).toBe(true);
  });

  it('seeds all sample measurements and tariffs', async () => {
    const app = await getApp();
    const m = await app.inject({ method: 'GET', url: '/api/deciship/measurements?pageSize=500', headers: auth });
    const seedCount = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'seed-measurements.json'), 'utf8')).length;
    expect(m.json().total).toBeGreaterThan(0);
    expect(m.json().total).toBeLessThanOrEqual(seedCount);
    const t = await app.inject({ method: 'GET', url: '/api/deciship/tariffs', headers: auth });
    expect(t.json().items.length).toBeGreaterThanOrEqual(2);
    const fedex = t.json().items.find((x: { name: string }) => x.name === 'FedEx International Economy 2026');
    const quote = await app.inject({
      method: 'POST',
      url: `/api/deciship/tariffs/${fedex.id}/quote`,
      headers: auth,
      payload: { lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, destCountry: 'DE' },
    });
    expect(quote.json()).toMatchObject({ ok: true, zone: 'A', base: 1527.75, total: 1184, chargeableKg: 6 });
  });

  it('imports every sample invoice in upload order and matches the golden results', async () => {
    const app = await getApp();
    for (const id of expected.uploadOrder) {
      const inv = expected.invoices.find((i) => i.id === id)!;
      const fileName = path.basename(inv.file);
      const data = fs.readFileSync(path.join(SAMPLES, inv.file));
      const form = multipart([
        { name: 'carrierId', value: carriers.get(inv.carrierCode)! },
        { name: 'file', filename: fileName, contentType: fileName.endsWith('.csv') ? 'text/csv' : XLSX_MIME, data },
      ]);
      const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
      expect(preview.statusCode, `${id} preview ${preview.body}`).toBe(200);
      const p = preview.json();
      expect(p.missing, id).toEqual([]);
      for (const key of ['trackingNo', 'netAmount', 'billedKg']) {
        expect(p.suggestedMapping[key], `${id} ${key}`).toBe(inv.suggestedMapping[key]);
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/deciship/invoices',
        headers: auth,
        payload: {
          fileId: p.fileId,
          carrierId: carriers.get(inv.carrierCode),
          invoiceNo: inv.invoiceNo,
          invoiceDate: inv.invoiceDate,
          currency: inv.currency,
          mapping: p.suggestedMapping,
          saveMapping: true,
        },
      });
      expect(res.statusCode, `${id} import ${res.body}`).toBe(201);
      const invoice = res.json().invoice;
      imported.set(id, invoice.id);

      const linesRes = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoice.id}/lines?pageSize=500`, headers: auth });
      const lines = linesRes.json().items as {
        trackingNo: string;
        status: string;
        diffTypes: string[];
        expectedAmount: number | null;
        diffAmount: number | null;
        confidence?: string;
        reviewCode?: string;
      }[];
      expect(lines.length, id).toBe(inv.lines.length);
      inv.lines.forEach((exp, i) => {
        const got = lines[i]!;
        const label = `${id} row ${exp.row} ${exp.trackingNo}`;
        expect(got.status, label).toBe(exp.status);
        expect(got.diffTypes, label).toEqual(exp.diffTypes);
        expect(got.diffAmount, label).toBe(exp.diffAmount);
        if (!exp.diffTypes.includes('DUPLICATE')) expect(got.expectedAmount, label).toBe(exp.expectedAmount);
        // KALANLAR 1.8: aynı dosyada tekrarlanan takip no'nun mükerreri "İncele"
        expect({ confidence: got.confidence === 'LOW' ? 'LOW' : undefined, reviewCode: got.confidence === 'LOW' ? got.reviewCode : undefined }, label).toEqual({
          confidence: exp.confidence,
          reviewCode: exp.reviewCode,
        });
      });
      // Mesaj 4: toplamda yeni `pendingLines` (donmuş satırlardan yeniden hesap bekleyenler); yeni faturada hiç yoktur.
      const { acceptedLines, flaggedLines, uncheckedSurchargeTotal, comparedBilledTotal, fxMissing, pakUnmatched, pakNoTariff, estimatedOverchargeTotal, estimatedLines, pendingLines, reconciliation, overchargeByType, ...totals } = invoice.totals;
      expect(pendingLines, id).toBe(0);
      // içe aktarılan fatura dayanağını (tarife sürümü + o günkü ayar) taşır
      expect((await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoice.id}`, headers: auth })).json().invoice.basis, id).toMatchObject({ state: 'CURRENT' });
      // SPEC §3.8: Fazla ödeme kesin satırlardan; örnek faturalarda tahmini (LOW, "İncele") fark satırı yalnız aynı dosyada
      // tekrarlanan takip no'nun mükerreri (KALANLAR 1.8, samples/EXPECTED.md `reviewTotals`)
      expect(estimatedOverchargeTotal, id).toBe(inv.reviewTotals.estimatedOverchargeTotal);
      expect(estimatedLines, id).toBe(inv.reviewTotals.estimatedLines);
      expect(acceptedLines, id).toBe(0);
      expect(totals, id).toEqual(inv.totals);
      // Mesaj 5: döküm altın toplamla kuruşu kuruşuna aynı olmalı.
      expect(reconciliation.overchargeTotal, id).toBe(inv.totals.overchargeTotal);
      expect(Math.round(overchargeByType.reduce((s: number, x: { amount: number }) => s + x.amount, 0) * 100), id).toBe(Math.round(inv.totals.overchargeTotal * 100));
      expect(fxMissing, id).toBe(0);
      // Faturalanan (karşılaştırılan satırlar) ≤ fatura toplamı; Beklenen ile aynı satırlar
      expect(comparedBilledTotal, id).toBeLessThanOrEqual(inv.totals.billedTotal + 0.001);
      expect(uncheckedSurchargeTotal, id).toBe(0); // katı kural: tarifede olmayan ek ücretler fark içinde
      expect(flaggedLines, id).toBe(0);
      expect(pakUnmatched + pakNoTariff, id).toBe(0); // örneklerde pak/zarf hizmeti yok
    }
  });

  it('rejects a second import of the same invoice number', async () => {
    const app = await getApp();
    // the last FedEx import (11736) saved its mapping, so re-uploading it uses the saved mapping
    const inv = expected.invoices.find((i) => i.id === 'fedex-9-482-11736')!;
    const data = fs.readFileSync(path.join(SAMPLES, inv.file));
    const form = multipart([
      { name: 'carrierId', value: carriers.get(inv.carrierCode)! },
      { name: 'file', filename: path.basename(inv.file), contentType: XLSX_MIME, data },
    ]);
    const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(preview.json().mappingSource).toBe('saved');
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: preview.json().fileId, carrierId: carriers.get(inv.carrierCode), invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, currency: 'TRY', mapping: preview.json().suggestedMapping },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVOICE_EXISTS');
  });

  it('decisions update totals, dispute text lists VERIFIED lines, reports render', async () => {
    const app = await getApp();
    const id = imported.get(expected.uploadOrder[0]!)!;
    const noVerified = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/dispute`, headers: auth });
    expect(noVerified.statusCode).toBe(400);
    expect(noVerified.json().error.code).toBe('NO_VERIFIED_LINES');

    const diffs = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?status=DIFF`, headers: auth })).json().items;
    expect(diffs.length).toBeGreaterThan(0);
    const target = diffs.find((l: { trackingNo: string }) => l.trackingNo === '794812345305') ?? diffs[0];
    const needsReason = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${diffs[1].id}`, headers: auth, payload: { decision: 'ACCEPTED' } });
    expect(needsReason.statusCode).toBe(400);
    const verify = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${target.id}`, headers: auth, payload: { decision: 'VERIFIED' } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().totals.verifiedTotal).toBe(target.diffAmount);

    const baseOvercharge = verify.json().totals.overchargeTotal;
    const other = diffs.find((l: { id: string }) => l.id !== target.id);
    const accept = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${other.id}`, headers: auth, payload: { decision: 'ACCEPTED', reason: 'Sözleşme ek maddesi' } });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().totals.overchargeTotal).toBeCloseTo(baseOvercharge - other.diffAmount, 2);
    const monthOf = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}`, headers: auth })).json().invoice.invoiceDate.slice(0, 7);
    const dashAccepted = (await app.inject({ method: 'GET', url: `/api/deciship/dashboard?month=${monthOf}`, headers: auth })).json().overchargeTotal;
    const reopen = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${other.id}`, headers: auth, payload: { decision: 'OPEN' } });
    expect(reopen.json().totals.overchargeTotal).toBe(baseOvercharge);
    const dashOpen = (await app.inject({ method: 'GET', url: `/api/deciship/dashboard?month=${monthOf}`, headers: auth })).json().overchargeTotal;
    expect(dashOpen - dashAccepted).toBeCloseTo(other.diffAmount, 2);

    const tr = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/dispute?lang=tr`, headers: auth });
    expect(tr.statusCode).toBe(200);
    expect(tr.json()).toMatchObject({ lineCount: 1, total: target.diffAmount });
    expect(tr.json().body).toContain(target.trackingNo);
    const en = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/dispute?lang=en`, headers: auth });
    expect(en.json().subject.length).toBeGreaterThan(0);

    const recompare = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: auth });
    expect(recompare.statusCode).toBe(200);
    expect(recompare.json().invoice.totals.verifiedTotal).toBe(target.diffAmount);
    expect(recompare.json().invoice.totals.overchargeTotal).toBe(expected.invoices.find((i) => i.id === expected.uploadOrder[0])!.totals.overchargeTotal);

    const xlsx = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.xlsx`, headers: auth });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toBe(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Özet', 'Farklar', 'Tüm satırlar', 'Eşleşmeyenler']);

    const pdf = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.pdf`, headers: auth });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.rawPayload.length).toBeGreaterThan(3000);
  });

  it('a new measurement for an unmatched tracking number triggers recomparison', async () => {
    const app = await getApp();
    const id = imported.get(expected.uploadOrder[0]!)!;
    const before = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?status=UNMATCHED`, headers: auth })).json().items;
    expect(before.length).toBeGreaterThan(0);
    const line = before[0];
    const m = measurementPayload({ trackingRaw: line.trackingNo, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 }, 1);
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...workerAuth, ...m.headers }, payload: m.payload });
    expect(created.statusCode).toBe(201);
    const after = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?q=${line.trackingNo}`, headers: auth })).json().items[0];
    expect(after.status).not.toBe('UNMATCHED');
    expect(after.measurement.id).toBe(created.json().measurement.id);
    const inv = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}`, headers: auth })).json().invoice;
    expect(inv.totals.unmatched).toBe(before.length - 1);

    // the worker still never sees invoice money through measurement endpoints
    const detail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${created.json().measurement.id}`, headers: workerAuth });
    expect(findMoneyKeys(detail.json())).toEqual([]);
    const adminDetail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${created.json().measurement.id}`, headers: auth });
    expect(adminDetail.json().measurement.invoiceLines).toHaveLength(1);
  });

  // Mesaj 4: ayar değişince eski fatura eski ayarla kalır ("Yeniden karşılaştır" da değiştirmez); yeni ayara kullanıcı önizleme + onayla geçirir.
  it('unknownSurchargesAsDiff kapalıyken tarifede olmayan ek ücret satırı uyumlu, Fazla ödeme dışında; fatura yeni ayara önizleme + onayla geçer', async () => {
    const app = await getApp();
    const id = imported.get(expected.uploadOrder[0]!)!;
    const lineOf = async () => (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?q=794812345293`, headers: auth })).json().items[0];
    const strictLine = await lineOf();
    expect(strictLine).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], diffAmount: 412 });
    const strictTotals = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}`, headers: auth })).json().invoice.totals;

    const bad = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { unknownSurchargesAsDiff: 'evet' } });
    expect(bad.statusCode).toBe(400);
    const off = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { unknownSurchargesAsDiff: false } });
    expect(off.json().unknownSurchargesAsDiff).toBe(false);
    // ayar değişti ama fatura hesaplandığı günkü ayarla duruyor: "Yeniden karşılaştır" rakamı değiştirmez, durum bunu söyler
    const re = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: auth });
    expect(re.statusCode).toBe(200);
    expect(re.json().invoice.totals).toEqual(strictTotals);
    expect(re.json().invoice.basis.state).toBe('RULES_CHANGED');
    expect(await lineOf()).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], diffAmount: 412 });
    // "Yeni ayarla hesapla": önizleme farkı gösterir, onay faturayı bugünkü ayara bağlar
    const moved = await recalculate(app, auth, id, { basis: 'rules' });
    expect(moved.preview.basis.rulesChanged).toBe(true);
    expect(moved.preview.basis.to.revisionId).toBe(moved.preview.basis.from.revisionId);
    expect(moved.preview.totals.before.overchargeTotal).toBe(strictTotals.overchargeTotal);
    expect(moved.preview.changedLines).toBeGreaterThan(0);
    expect(moved.invoice.basis.state).toBe('CURRENT');
    const lenient = moved.invoice.totals;
    expect(moved.preview.totals.after.overchargeTotal).toBe(lenient.overchargeTotal);
    const l = await lineOf();
    // eski rakam bir adım geride durur
    expect(l.prevResult).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], diffAmount: 412, cause: 'RULES' });
    expect(l).toMatchObject({ status: 'MATCH', diffTypes: [], diffAmount: 0 });
    expect(l.note).toContain("Tarifede olmayan ek ücretler faturadaki tutarıyla Beklenen'e eklendi: Address Correction 412,00");
    // Beklenen faturadaki 412'yi içerir → Faturalanan ile aynı kalemler, fark 0
    expect(l.expectedAmount).toBeCloseTo(l.netAmount, 2);
    expect(l.breakdown.at(-1)).toMatchObject({ amount: 412, unchecked: true });
    expect(lenient.uncheckedSurchargeTotal).toBeGreaterThanOrEqual(412);
    expect(lenient.overchargeTotal).toBeLessThanOrEqual(strictTotals.overchargeTotal - 412 + 0.001);
    expect(lenient.match).toBeGreaterThan(strictTotals.match);

    // Özet kutusu: Faturalanan ile Beklenen aynı kalemleri kapsar (tarifede olmayan ek ücretler Beklenen'e faturadan).
    // Karar 2026-11-12: mükerrer satır Faturalanan'a tam tutarıyla girer (beklenen 0); Faturalanan − Beklenen = satır
    // farkları toplamı + mükerrerler. Kayıtlı `comparedBilledTotal` değişmez (karşılaştırılan satırlar).
    // Faturalanan taşıyıcının kestiğidir: "İncele" (LOW, KALANLAR 1.8) mükerrer de Fazla ödeme'ye girmese de kutuya tam
    // tutarıyla girer; Fazla ödeme'ye "İncele" adımında geri çıkar (core `overchargeReconciliation`). Bu örnekte tek mükerrer
    // aynı dosyada → İncele.
    const all = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?pageSize=500`, headers: auth })).json().items as {
      status: string;
      decision: string;
      diffTypes: string[];
      expectedAmount: number | null;
      diffAmount: number | null;
      confidence?: string;
    }[];
    expect(all).toHaveLength(lenient.lines);
    const comparedDiffSum = all.filter((x) => x.expectedAmount != null).reduce((s, x) => s + Math.round((x.diffAmount ?? 0) * 100), 0) / 100;
    const dups = all.filter((x) => x.expectedAmount == null && x.status === 'DIFF' && x.decision !== 'ACCEPTED' && x.diffTypes.includes('DUPLICATE'));
    const sumOf = (xs: typeof all) => xs.reduce((s, x) => s + Math.round((x.diffAmount ?? 0) * 100), 0) / 100;
    const dupSum = sumOf(dups);
    expect(sumOf(dups.filter((x) => x.confidence === 'LOW')), 'örnek faturada aynı dosyada tekrarlanan (İncele) mükerrer var').toBe(1120);
    expect(dupSum).toBe(1120);
    const amounts = invoiceSummaryAmounts(lenient);
    expect(amounts.duplicates).toBeCloseTo(dupSum, 2);
    expect(amounts.billed).toBeCloseTo(lenient.comparedBilledTotal + dupSum, 2);
    expect(amounts.billed - amounts.expected).toBeCloseTo(comparedDiffSum + dupSum, 2);
    // Fazla ödeme değişmez: İncele mükerrer "İncele" adımında çıkar
    expect(lenient.reconciliation.steps.find((s: { key: string }) => s.key === 'review')).toMatchObject({ amount: -1120, lines: 1 });
    // bu faturada her satır karşılaştırıldı ya da mükerrer: Faturalanan = fatura toplamı, ayrı "Fatura toplamı" satırı yok
    expect(amounts.billed).toBeCloseTo(lenient.billedTotal, 2);
    expect(amounts.showInvoiceTotal).toBe(false);

    const xlsx = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.xlsx`, headers: auth });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const summary = wb.getWorksheet('Özet')!;
    const cell = (k: string) => {
      const row = summary.getColumn(1).values.findIndex((v) => v === k);
      expect(row, k).toBeGreaterThan(0);
      return summary.getRow(row).getCell(2).value;
    };
    expect(cell("Beklenen'e faturadan eklenen ek ücretler (tarifede yok)")).toBe(lenient.uncheckedSurchargeTotal);
    // rapor ekranla aynı tabanda
    expect(cell('Faturalanan toplam (karşılaştırılan satırlar)')).toBe(amounts.billed);
    expect(cell('Beklenen toplam (karşılaştırılan satırlar)')).toBe(lenient.expectedTotal);
    // ekrandaki gibi: Faturalanan fatura toplamına eşitse "Fatura toplamı (tüm satırlar)" satırı yok
    expect(summary.getColumn(1).values.includes('Fatura toplamı (tüm satırlar)')).toBe(false);
    // fazla ödeme açıklaması ekrandakiyle aynı koşulda (overchargeNote) ve aynı metinle
    const note = overchargeNote(lenient, lenient.overchargeTotal);
    expect(summary.getColumn(1).values.includes('Not')).toBe(note != null);
    if (note) expect(cell('Not')).toBe(note);

    await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { unknownSurchargesAsDiff: true } });
    const back = await recalculate(app, auth, id, { basis: 'rules' });
    expect(back.invoice.totals).toMatchObject({ overchargeTotal: strictTotals.overchargeTotal, uncheckedSurchargeTotal: 0 });
    expect(await lineOf()).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'] });
  });

  it('dashboard aggregates the month', async () => {
    const app = await getApp();
    const d = await app.inject({ method: 'GET', url: '/api/deciship/dashboard?month=2026-10', headers: auth });
    expect(d.statusCode).toBe(200);
    const body = d.json();
    expect(body.invoices.count).toBeGreaterThan(0);
    expect(body.measurements.count).toBeGreaterThan(0);
    expect(body.recentInvoices.length).toBeLessThanOrEqual(5);
    expect(body.currency).toBe('TRY');
    expect(body.coveragePct).toBeGreaterThan(0);
    expect(body.topDiffTypes.length).toBeGreaterThan(0);
  });

  it('lists and soft-deletes invoices', async () => {
    const app = await getApp();
    const list = await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth });
    expect(list.json().total).toBe(expected.uploadOrder.length);
    const id = imported.get(expected.uploadOrder.at(-1)!)!;
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/invoices/${id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}`, headers: auth })).statusCode).toBe(404);
  });

  it('PDF invoices return AI_DISABLED without a key', async () => {
    const app = await getApp();
    const form = multipart([
      { name: 'carrierId', value: carriers.get('fedex')! },
      { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF') },
    ]);
    const filesBefore = await inCompany(auth, () => prisma.file.count());
    const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toEqual({ code: 'AI_DISABLED', message: 'Yapay zekâ şu an kullanılamıyor; PDF faturalar okunamaz, CSV/XLSX yükleyin' });
    // okunamayacak PDF saklanmaz (sahipsiz dosya kalmaz)
    expect(await inCompany(auth, () => prisma.file.count())).toBe(filesBefore);
  });
});
