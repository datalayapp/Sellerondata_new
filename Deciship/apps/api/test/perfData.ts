/**
 * KALANLAR 6.14: büyük firma verisi, doğrudan SQL ile (generate_series; Prisma ile tek tek ekleme değil). Süper kullanıcı
 * bağlantısıyla yazılır (RLS'yi atlar); uygulama aynı satırları kendi rolüyle, firma bağlamında okur. Kimlikler `md5` ile
 * belirlenimli, sayılar ve dağılım `PerfShape`'ten. Sonda `VACUUM ANALYZE`: planlayıcı istatistiği ve görünürlük haritası
 * kararlı durumdaki (otomatik temizliğin geçtiği) bir veritabanıyla aynı olsun.
 *
 * Dağılım (firma başına): fatura tarihi bugünden geriye `days` güne yayılır; her fatura `linesPerInvoice` satır, ilk fatura
 * ayrıca `bigInvoiceLines` satır (satır sayfalamasının en kötüsü). Satırların beşte biri bir ölçümle eşleşir (MATCH ya da
 * DIFF), kalanlar UNMATCHED / NO_TARIFF; %1 mükerrer takip no. Ölçümlerin yirmide birinin eski sürümü, yüzde biri silinmiş,
 * yarısının fotoğrafı var. Faturaların yirmi beşte birinde itiraz turu (fark satırları), yüzde biri silinmiş.
 */
import pg from 'pg';

export type PerfShape = {
  invoices: number;
  linesPerInvoice: number;
  bigInvoiceLines: number;
  measurements: number;
  workers: number;
  audit: number;
  days: number;
};

export type PerfCompany = { companyId: string; adminId: string; carrierIds: string[]; bigInvoiceId: string };

const CARRIERS = [
  { code: 'fedex', name: 'FedEx' },
  { code: 'ups', name: 'UPS' },
  { code: 'dhl', name: 'DHL' },
];

/** Takip no: `79` + 10 hane. Firmalar aynı numara uzayını kullanır (planlayıcı firmayı ayırmak zorunda kalsın). */
export const perfTracking = (n: number) => `79${String(n).padStart(10, '0')}`;
/** `md5` tabanlı belirlenimli kimlik (uuid biçiminde). */
export const perfIdSql = (prefix: string, expr: string) => `md5($1 || '${prefix}' || (${expr})::text)::uuid::text`;

async function step(client: pg.Client, log: (s: string) => void, label: string, sql: string, params: unknown[]) {
  const t0 = performance.now();
  const r = await client.query(sql, params);
  log(`[veri] ${label}: ${r.rowCount ?? 0} satır, ${Math.round(performance.now() - t0)} ms`);
}

/** Firmanın verisini yazar. Şirket ve yönetici kaydı (JIT) önceden açılmış olmalı. */
export async function generateCompanyData(client: pg.Client, companyId: string, adminId: string, s: PerfShape, log: (s: string) => void = () => {}): Promise<PerfCompany> {
  const c = companyId;
  const nLines = s.invoices * s.linesPerInvoice;
  // Taşıyıcılar: firmada aynı kodlu varsa o kullanılır.
  const carrierIds: string[] = [];
  for (const [i, car] of CARRIERS.entries()) {
    const found = await client.query<{ id: string }>(`SELECT "id" FROM "Carrier" WHERE "companyId" = $1 AND "code" = $2 LIMIT 1`, [c, car.code]);
    if (found.rows[0]) carrierIds.push(found.rows[0].id);
    else {
      const id = (await client.query<{ id: string }>(`SELECT md5($1 || 'car' || $2)::uuid::text AS id`, [c, i])).rows[0]!.id;
      await client.query(`INSERT INTO "Carrier" ("id", "companyId", "code", "name", "active", "updatedAt") VALUES ($2, $1, $3, $4, true, now())`, [c, id, car.code, car.name]);
      carrierIds.push(id);
    }
  }

  await step(client, log, 'çalışanlar', `
    INSERT INTO "Member" ("id", "companyId", "personId", "name", "role", "active", "epoch", "updatedAt")
    SELECT ${perfIdSql('mem', 'g')}, $1, ${perfIdSql('per', 'g')}, 'Çalışan ' || g, 'MEASURE', true, 0, now()
    FROM generate_series(1, $2::int) g`, [c, s.workers]);

  // Kaynak dosyalar: fatura başına bir (Invoice.sourceFileId RESTRICT).
  await step(client, log, 'fatura dosyaları', `
    INSERT INTO "File" ("id", "companyId", "kind", "mime", "size", "path", "sha256", "originalName", "invoiceId", "createdById", "createdAt", "updatedAt")
    SELECT ${perfIdSql('fil', 'g')}, $1, 'INVOICE_SOURCE', 'text/csv', 20000, 'perf/' || g, md5(g::text), 'fatura-' || g || '.csv',
      ${perfIdSql('inv', 'g')}, $2, now(), now()
    FROM generate_series(1, $3::int) g`, [c, adminId, s.invoices]);

  // Faturalar: 1. fatura en yeni; tarih bugünden geriye. Onda biri USD.
  await step(client, log, 'faturalar', `
    INSERT INTO "Invoice" ("id", "companyId", "carrierId", "invoiceNo", "invoiceDate", "currency", "sourceFileId", "mapping", "status", "totals",
      "calculatedAt", "isSample", "deletedAt", "createdAt", "updatedAt")
    SELECT ${perfIdSql('inv', 'g')}, $1, ($2::text[])[1 + g % 3], 'INV-' || lpad(g::text, 7, '0'),
      date_trunc('day', now() AT TIME ZONE 'UTC') - ((g - 1) * $4::int / $3::int) * interval '1 day',
      CASE WHEN g % 10 = 0 THEN 'USD' ELSE 'TRY' END, ${perfIdSql('fil', 'g')}, '{}'::jsonb, 'PROCESSED', '{}'::jsonb,
      now(), false, CASE WHEN g % 100 = 50 THEN now() ELSE NULL END,
      date_trunc('day', now() AT TIME ZONE 'UTC') - ((g - 1) * $4::int / $3::int) * interval '1 day' + interval '1 day', now()
    FROM generate_series(1, $3::int) g`, [c, carrierIds, s.invoices, s.days]);

  // Ölçümler (güncel sürümler): i. ölçüm 5i. satırın takip no'su. measuredAt satırın faturasından birkaç gün önce.
  const mExpr = (i: string) => `${i} * 5`;
  await step(client, log, 'ölçümler', `
    INSERT INTO "Measurement" ("id", "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg",
      "dimMethod", "weightMethod", "measuredById", "measuredAt", "version", "deletedAt", "createdAt", "updatedAt")
    SELECT ${perfIdSql('mea', 'i')}, $1, 'perf-' || i, '79' || lpad((${mExpr('i')})::text, 10, '0'), '79' || lpad((${mExpr('i')})::text, 10, '0'),
      20 + i % 40, 15 + i % 30, 10 + i % 20, 1 + (i % 200) / 10.0,
      (ARRAY['LIDAR','AR','REFERENCE','MANUAL','PRESET']::"DimMethod"[])[1 + i % 5], 'MANUAL',
      ${perfIdSql('mem', '1 + i % $3::int')},
      now() - (((${mExpr('i')} - 1) / $4::int) * $5::int / $6::int) * interval '1 day' - interval '3 days' - (i % 600) * interval '1 minute',
      CASE WHEN i % 20 = 0 THEN 2 ELSE 1 END, CASE WHEN i % 100 = 7 THEN now() ELSE NULL END, now(), now()
    FROM generate_series(1, $2::int) i`, [c, s.measurements, s.workers, s.linesPerInvoice, s.days, s.invoices]);
  // Eski sürümler: her 20. ölçümün bir önceki ölçüsü
  await step(client, log, 'ölçüm eski sürümleri', `
    INSERT INTO "Measurement" ("id", "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg",
      "dimMethod", "weightMethod", "measuredById", "measuredAt", "version", "supersededById", "createdAt", "updatedAt")
    SELECT ${perfIdSql('meo', 'i')}, $1, 'perf-old-' || i, m."trackingRaw", m."trackingNo", m."lengthCm" + 5, m."widthCm", m."heightCm", m."weightKg",
      m."dimMethod", m."weightMethod", m."measuredById", m."measuredAt" - interval '1 hour', 1, m."id", now(), now()
    FROM generate_series(20, $2::int, 20) i JOIN "Measurement" m ON m."id" = ${perfIdSql('mea', 'i')}`, [c, s.measurements]);
  await step(client, log, 'ölçüm fotoğrafları', `
    INSERT INTO "File" ("id", "companyId", "kind", "mime", "size", "path", "sha256", "measurementId", "createdById", "createdAt", "updatedAt")
    SELECT ${perfIdSql('pho', 'i')}, $1, 'PHOTO_BOX', 'image/jpeg', 150000, 'perf/p' || i, md5(i::text), ${perfIdSql('mea', 'i')}, $2, now(), now()
    FROM generate_series(2, $3::int, 2) i`, [c, adminId, s.measurements]);

  // Satırlar: g. satır (g-1)/lpi + 1. faturada. 5'e bölünen satırın (ölçümü varsa) eşleşmesi var.
  const lineSelect = (g: string, inv: string, row: string) => `
    SELECT ${perfIdSql('lin', g)}, ${perfIdSql('inv', inv)}, $1, ${row},
      '79' || lpad((CASE WHEN ${g} % 100 = 0 THEN ${g} - 50 ELSE ${g} END)::text, 10, '0'),
      now() - ((${inv} - 1) * $3::int / $4::int) * interval '1 day' - (${g} % 7) * interval '1 day',
      (ARRAY['EXPRESS','ECONOMY','PRIORITY'])[1 + ${g} % 3], (ARRAY['DE','FR','US','GB','NL','TR'])[1 + ${g} % 6],
      1 + (${g} % 50) / 10.0, 1 + (${g} % 60) / 10.0, 30, 20, 10, 5000,
      100 + ${g} % 400, 0, 10, '[]'::jsonb, 110 + ${g} % 400, md5('raw' || ${g}),
      CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int THEN ${perfIdSql('mea', `${g} / 5`)} ELSE NULL END,
      (CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int THEN (CASE WHEN ${g} % 15 = 0 THEN 'DIFF' ELSE 'MATCH' END)
            WHEN ${g} % 37 = 0 THEN 'NO_TARIFF' ELSE 'UNMATCHED' END)::"LineStatus",
      CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int AND ${g} % 15 = 0 THEN (CASE ${g} % 3 WHEN 0 THEN ARRAY['DIMENSION'] WHEN 1 THEN ARRAY['WEIGHT'] ELSE ARRAY['PRICE','SURCHARGE'] END) ELSE ARRAY[]::text[] END,
      CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int THEN 2 + (${g} % 60) / 10.0 ELSE NULL END,
      CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int THEN 100 + ${g} % 400 - (CASE WHEN ${g} % 15 = 0 THEN 25 ELSE 0 END) ELSE NULL END,
      CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int THEN (CASE WHEN ${g} % 15 = 0 THEN 35 ELSE 10 END) ELSE NULL END,
      '{}'::jsonb,
      CASE WHEN ${g} % 5 = 0 AND ${g} / 5 <= $5::int THEN jsonb_build_object('confidence', CASE WHEN ${g} % 45 = 0 THEN 'LOW' ELSE 'HIGH' END) ELSE NULL END,
      CASE WHEN ${g} % 53 = 0 THEN 'Pak/zarf' ELSE NULL END,
      (CASE WHEN ${g} % 15 = 0 AND ${g} % 4 = 0 THEN 'VERIFIED' WHEN ${g} % 15 = 0 AND ${g} % 4 = 1 THEN 'ACCEPTED' ELSE 'OPEN' END)::"Decision",
      now() - ((${inv} - 1) * $3::int / $4::int) * interval '1 day', now()`;
  const lineCols = `("id", "invoiceId", "companyId", "rowIndex", "trackingNo", "shipDate", "service", "destCountry", "actualKg", "billedKg", "dimL", "dimW", "dimH",
      "billedDivisor", "baseAmount", "discountAmount", "fuelAmount", "surcharges", "netAmount", "rawHash", "measurementId", "status", "diffTypes",
      "ourChargeableKg", "expectedAmount", "diffAmount", "breakdown", "pricing", "note", "decision", "createdAt", "updatedAt")`;
  // Büyük parçalar tek işlemde ağır: 250 binlik dilimler.
  const CHUNK = 250_000;
  for (let from = 1; from <= nLines; from += CHUNK) {
    const to = Math.min(nLines, from + CHUNK - 1);
    await step(client, log, `satırlar ${from}-${to}`, `
      INSERT INTO "InvoiceLine" ${lineCols}
      ${lineSelect('g', `((g - 1) / $2::int + 1)`, `((g - 1) % $2::int)`)}
      FROM generate_series($6::int, $7::int) g`, [c, s.linesPerInvoice, s.days, s.invoices, s.measurements, from, to]);
  }
  // İlk faturaya ek satırlar (çok satırlı fatura); takip numaraları ölçümsüz bir aralıktan.
  if (s.bigInvoiceLines > 0) {
    await step(client, log, 'büyük fatura satırları', `
      INSERT INTO "InvoiceLine" ${lineCols}
      ${lineSelect('(g + 500000000)', '1', `($2::int + g)`)}
      FROM generate_series(1, $6::int) g`, [c, s.linesPerInvoice, s.days, s.invoices, s.measurements, s.bigInvoiceLines]);
  }

  // Toplamlar satırlardan (Merkez ve liste `totals`'ı okur). Önce istatistik: yoksa planlayıcı iç içe döngü seçip dakikalarca sürer.
  await client.query('ANALYZE "deciship"."Invoice"');
  await client.query('ANALYZE "deciship"."InvoiceLine"');
  await step(client, log, 'fatura toplamları', `
    UPDATE "Invoice" i SET "totals" = t.totals FROM (
      SELECT l."invoiceId", jsonb_build_object(
        'lines', count(*), 'match', count(*) FILTER (WHERE l."status" = 'MATCH'), 'diff', count(*) FILTER (WHERE l."status" = 'DIFF'),
        'unmatched', count(*) FILTER (WHERE l."status" = 'UNMATCHED'), 'noTariff', count(*) FILTER (WHERE l."status" = 'NO_TARIFF'),
        'billedTotal', sum(l."netAmount"), 'comparedBilledTotal', sum(l."netAmount") FILTER (WHERE l."expectedAmount" IS NOT NULL),
        'pakUnmatched', 0, 'pakNoTariff', 0, 'expectedTotal', COALESCE(sum(l."expectedAmount"), 0),
        'overchargeTotal', COALESCE(sum(l."diffAmount") FILTER (WHERE l."status" = 'DIFF' AND l."pricing"->>'confidence' = 'HIGH'), 0),
        'estimatedOverchargeTotal', COALESCE(sum(l."diffAmount") FILTER (WHERE l."status" = 'DIFF' AND l."pricing"->>'confidence' = 'LOW'), 0),
        'estimatedLines', count(*) FILTER (WHERE l."status" = 'DIFF' AND l."pricing"->>'confidence' = 'LOW'),
        'verifiedTotal', COALESCE(sum(l."diffAmount") FILTER (WHERE l."decision" = 'VERIFIED'), 0),
        'uncheckedSurchargeTotal', 0, 'acceptedLines', count(*) FILTER (WHERE l."decision" = 'ACCEPTED'), 'flaggedLines', 0, 'fxMissing', 0,
        'pendingLines', 0) AS totals
      FROM "InvoiceLine" l WHERE l."companyId" = $1 GROUP BY l."invoiceId") t
    WHERE i."id" = t."invoiceId" AND i."companyId" = $1`, [c]);

  // İtiraz turları: her 25. faturada, o faturanın fark satırlarıyla; altıda biri sonuçlanmış (kurtarıldı).
  await step(client, log, 'itiraz turları', `
    INSERT INTO "Dispute" ("id", "companyId", "invoiceId", "round", "sentOn", "channel", "sentById", "currency", "claimedTotal", "createdAt", "updatedAt")
    SELECT ${perfIdSql('dis', 'g')}, $1, i."id", 1, i."invoiceDate" + interval '10 days', 'EMAIL', $2, i."currency",
      COALESCE((i."totals"->>'overchargeTotal')::numeric, 0), now(), now()
    FROM generate_series(25, $3::int, 25) g JOIN "Invoice" i ON i."id" = ${perfIdSql('inv', 'g')} AND i."deletedAt" IS NULL`, [c, adminId, s.invoices]);
  await step(client, log, 'itiraz satırları', `
    INSERT INTO "DisputeLine" ("id", "companyId", "disputeId", "invoiceLineId", "trackingNo", "measurementId", "claimedAmount", "outcome", "recoveredAmount", "createdAt", "updatedAt")
    SELECT md5($1 || 'dli' || l."id")::uuid::text, $1, d."id", l."id", l."trackingNo", l."measurementId", COALESCE(l."diffAmount", 0),
      (CASE WHEN l."rowIndex" % 6 = 0 THEN 'RECOVERED' ELSE 'PENDING' END)::"DisputeLineOutcome",
      CASE WHEN l."rowIndex" % 6 = 0 THEN COALESCE(l."diffAmount", 0) ELSE NULL END, now(), now()
    FROM "Dispute" d JOIN "InvoiceLine" l ON l."invoiceId" = d."invoiceId" AND l."companyId" = $1 AND l."status" = 'DIFF'
    WHERE d."companyId" = $1`, [c]);

  await step(client, log, 'denetim kayıtları', `
    INSERT INTO "AuditLog" ("id", "companyId", "userId", "action", "entity", "entityId", "data", "createdAt", "updatedAt")
    SELECT ${perfIdSql('aud', 'g')}, $1, $2, (ARRAY['invoice.upload','line.decide','measurement.create','dispute.send'])[1 + g % 4], 'Invoice',
      ${perfIdSql('inv', '1 + g % $4::int')}, '{}'::jsonb, now() - (g % ($5::int * 24)) * interval '1 hour', now()
    FROM generate_series(1, $3::int) g`, [c, adminId, s.audit, s.invoices, s.days]);

  const bigInvoiceId = (await client.query<{ id: string }>(`SELECT md5($1 || 'inv' || '1')::uuid::text AS id`, [c])).rows[0]!.id;
  return { companyId: c, adminId, carrierIds, bigInvoiceId };
}

/** Planlayıcı istatistiği ve görünürlük haritası (yalnız dizinden okuma). */
export async function analyzeAll(client: pg.Client, log: (s: string) => void = () => {}) {
  const t0 = performance.now();
  for (const t of ['Member', 'File', 'Carrier', 'Invoice', 'InvoiceLine', 'Measurement', 'Dispute', 'DisputeLine', 'AuditLog']) await client.query(`VACUUM (ANALYZE) "deciship"."${t}"`);
  log(`[veri] VACUUM ANALYZE: ${Math.round(performance.now() - t0)} ms`);
}
