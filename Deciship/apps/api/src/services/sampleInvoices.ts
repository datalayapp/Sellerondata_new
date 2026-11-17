/**
 * Örnek faturaların gerçek içe aktarma yolundan yüklenmesi (`samples/expected.json` + `samples/invoices/*`). İki çağıran:
 * demo itiraz tohumu (`seedDemoDisputes.ts`) ve örnek veriyle deneme turu (`services/demoTour.ts`). Geliştirme tohumuna
 * bağlı değildir: uygulama içinden çağrılabilir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { disputeClaim, mappingDiagnostics, normalizeTracking, parseRows, readTable, type ColumnMapping, type ParsedInvoiceLine } from '@deciship/core';
import { prisma } from '../db.ts';
import { REPO_ROOT } from '../env.ts';
import { mappingSchema } from '../lib/mappingSchema.ts';
import { discardStored, extFor, storeBuffer } from '../lib/storage.ts';
import { num, numOrNull } from '../lib/util.ts';
import {
  buildContext,
  compareAll,
  computeTotals,
  defaultTariff,
  importRecheck,
  lockImportsExclusive,
  parsedToLineData,
  prefetchFx,
  recompareInvoice,
  resultToLineData,
} from './compare.ts';
import { atStoredPrecision, insertInvoiceLines } from './lineWrite.ts';
import { queueMeasurementRecompare } from './measurementQueue.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** `samples/expected.json` içindeki bir fatura. */
export type SampleInvoice = { id: string; file: string; carrierCode: string; invoiceNo: string; currency: string; suggestedMapping: unknown };

/** Örnek fatura tanımı (kimliğiyle). Yoksa hata: örnek dosyalar imajda olmalı (Dockerfile `COPY Deciship/samples`). */
export function sampleInvoice(id: string): SampleInvoice {
  const expected = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'samples', 'expected.json'), 'utf8')) as { invoices: SampleInvoice[] };
  const s = expected.invoices.find((x) => x.id === id);
  if (!s) throw new Error(`Örnek fatura yok: ${id}`);
  return s;
}

export type ImportedSample = { id: string; invoiceNo: string; invoiceDate: Date; lines: { id: string; rowIndex: number; claim: number }[] };

/**
 * POST /invoices ile aynı yol: dosya kaydı, okuma, okuma kontrolü, karşılaştırma, toplu satır yazımı, toplamlar. Fatura
 * hesabın dayanağını (tarife sürümü + o günkü ayar, `ctx.basis`), satırlar sonucun hesaplandığı sürümü taşır (§3.14).
 * `ownerId`: dosyayı yükleyen ve denetim kaydının sahibi (firmanın üyesi). Firma bağlamında çağrılır. Fatura taşıyıcının
 * varsayılan tarifesiyle hesaplanır; taşıyıcı (`sample.carrierCode`) firmada olmalı. `o.carrierId` (deneme turu): taşıyıcı
 * koda göre değil bu kimlikle bulunur, kodu örnekle aynı olmalı (aynı kodlu başka taşıyıcıya fatura yazılmaz).
 */
export async function importDemoInvoice(
  companyId: string,
  sample: SampleInvoice,
  invoiceDay: string,
  ownerId: string,
  o: { carrierId?: string } = {},
): Promise<ImportedSample> {
  const carrier = await prisma.carrier.findFirst({ where: { companyId, code: sample.carrierCode, ...(o.carrierId ? { id: o.carrierId } : {}) } });
  if (!carrier) throw new Error(`Örnek taşıyıcı yok: ${sample.carrierCode}`);
  const tariffs = await prisma.tariff.findMany({ where: { companyId, carrierId: carrier.id }, select: { id: true, active: true, isDefault: true, updatedAt: true, divisor: true } });
  const tariff = defaultTariff(tariffs);
  const fileName = path.basename(sample.file);
  const bytes = fs.readFileSync(path.join(REPO_ROOT, 'samples', sample.file));
  const mime = fileName.endsWith('.csv') ? 'text/csv' : XLSX_MIME;
  const mapping = mappingSchema.parse(sample.suggestedMapping) as ColumnMapping;

  const table = await readTable(fileName, new Uint8Array(bytes));
  const result = parseRows(table, mapping, 'tr');
  // 01-B8: satır para birimi faturanınkiyle denetlenir (içe aktarma ve "Yeniden karşılaştır" gibi)
  const diagnostics = mappingDiagnostics(table, mapping, { divisor: tariff?.divisor ?? 5000, parsed: result, locale: 'tr', invoiceCurrency: sample.currency });
  const rowFlags = new Map(diagnostics.verification.rowFlags.map((r) => [r.rowIndex, r.codes as string[]]));
  // dosya içinde tekrar eden satır bir kez (içe aktarmadaki gibi)
  const seen = new Set<string>();
  // 01-B7: veritabanı hassasiyetinde karşılaştırılır (içe aktarmadaki gibi; yeniden karşılaştırma aynı sayıyı okur)
  const parsed: ParsedInvoiceLine[] = result.lines.filter((l) => (seen.has(l.rawHash) ? false : (seen.add(l.rawHash), true))).map(atStoredPrecision);

  const invoiceDate = new Date(`${invoiceDay}T00:00:00.000Z`);
  const ctx = await buildContext(
    companyId,
    carrier.id,
    parsed.map((l) => normalizeTracking(l.trackingNo)),
    null,
    tariff?.id ?? null,
    false,
    undefined,
    parsed.map((l) => l.trackingNo),
  );
  // Örnek tarifeler ve faturalar TRY: kur istenmez, ağ olmadan çalışır.
  await prefetchFx(parsed, ctx, invoiceDate, sample.currency);
  const lineData = compareAll(parsed, ctx, invoiceDate).map(({ line, result: r, measurementId, tariffId, tariffRevisionId }) => ({
    companyId,
    ...parsedToLineData(line),
    ...resultToLineData(r, measurementId, tariffId, tariffRevisionId),
    parseFlags: rowFlags.get(line.rowIndex) ?? [],
    decision: 'OPEN' as const,
  }));

  const stored = await storeBuffer(companyId, bytes, extFor(mime, fileName));
  const { invoice, stalePriors, movedMarks } = await prisma.$transaction(
    async (tx) => {
      // 02-B1, 07-B1 (bağımsız inceleme): içe aktarmayla aynı kilit; kilitten önce okunan önceki satırlar ve ölçümler kilit
      // altında yeniden okunur, değiştiyse fatura yazıldıktan sonra yeniden karşılaştırılır.
      await lockImportsExclusive(tx, companyId);
      const recheck = await importRecheck(tx, companyId, ctx, parsed.map((l) => normalizeTracking(l.trackingNo)), parsed.map((l) => l.trackingNo), false);
      const file = await tx.file.create({
        data: { companyId, kind: 'INVOICE_SOURCE', mime, size: stored.size, path: stored.path, sha256: stored.sha256, originalName: fileName, createdById: ownerId },
      });
      const inv = await tx.invoice.create({
        data: {
          companyId,
          carrierId: carrier.id,
          tariffId: tariff?.id ?? null,
          // hesabın dayanağı: satırların hesaplandığı sürüm ve o günkü firma ayarı (içe aktarmayla aynı)
          tariffRevisionId: ctx.basis.tariffRevisionId,
          compareSettings: ctx.basis.compareSettings,
          invoiceNo: sample.invoiceNo,
          invoiceDate,
          currency: sample.currency,
          sourceFileId: file.id,
          mapping: mapping as object,
          status: 'PROCESSED',
          totals: computeTotals(lineData),
          // motorun bu faturayı koştuğu an (içe aktarmayla aynı: oluşturma bir hesaptır)
          calculatedAt: new Date(),
        },
      });
      await insertInvoiceLines(tx, inv.id, lineData);
      await tx.file.update({ where: { id: file.id }, data: { invoiceId: inv.id } });
      return { invoice: inv, ...recheck };
    },
    { timeout: 120_000, maxWait: 10_000 },
  ).catch(async (e: unknown) => {
    // 06-B4: işlem düştüyse saklanan dosya sahipsiz kalmasın
    await discardStored(stored.path);
    throw e;
  });
  if (stalePriors || movedMarks.length) {
    await recompareInvoice(invoice.id, { basis: 'pinned', scope: 'open', cause: movedMarks.length ? 'MEASUREMENT' : 'DUPLICATE' });
  }
  // işaretler kendi sırasında boşalır (düşerse tarama tamamlar)
  for (const m of movedMarks) await queueMeasurementRecompare(companyId, m.id, m.pendingAt).catch(() => undefined);
  await prisma.auditLog.create({ data: { companyId, userId: ownerId, action: 'invoice.import', entity: 'Invoice', entityId: invoice.id, data: { invoiceNo: invoice.invoiceNo, lines: lineData.length, demo: true } } });

  const rows = await prisma.invoiceLine.findMany({
    where: { invoiceId: invoice.id, status: 'DIFF' },
    select: { id: true, rowIndex: true, diffTypes: true, netAmount: true, diffAmount: true },
    orderBy: { rowIndex: 'asc' },
  });
  const lines = rows
    .map((l) => ({ id: l.id, rowIndex: l.rowIndex, claim: disputeClaim({ diffTypes: l.diffTypes, billedAmount: num(l.netAmount), diffAmount: numOrNull(l.diffAmount) }) }))
    .filter((l) => l.claim > 0);
  return { id: invoice.id, invoiceNo: invoice.invoiceNo, invoiceDate, lines };
}
