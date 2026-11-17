-- Mesaj 4, geçmiş sonuçlar donsun: fatura hesabının dayanağı artık canlı tarife değil, tarifenin değişmez sürümüdür.
--  - "TariffRevision": tarifenin fiyat içeriğinin anlık görüntüsü (tariffBody biçimi). Güncellenmez, silinmez.
--  - "Tariff"."currentRevisionId": tarifenin bugünkü sürümü.
--  - "Invoice"."tariffRevisionId" + "compareSettings": faturanın hesaplandığı sürüm ve o günkü firma ayarı.
--  - "InvoiceLine"."tariffRevisionId", "prevResult", "recalcPending", "recalcPendingAt": satırın sürümü, bir önceki sonucu
--    ve donmuş satırda bekleyen değişiklik.
-- Mevcut veri aynı göçte doldurulur (aşağıda "Backfill"): göçten sonra her fatura bugünkü rakamıyla aynı dayanağa bağlıdır.
-- Yabancı anahtarlar init göçündeki gibi bileşiktir (x, companyId) -> (id, companyId); Prisma bunları göremez (check-drift).

-- CreateTable
CREATE TABLE "deciship"."TariffRevision" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tariffId" TEXT,
    "tariffName" TEXT NOT NULL,
    "contentHash" TEXT,
    "snapshot" JSONB NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TariffRevision_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "deciship"."Tariff" ADD COLUMN "currentRevisionId" TEXT;

-- AlterTable
ALTER TABLE "deciship"."Invoice" ADD COLUMN "tariffRevisionId" TEXT,
ADD COLUMN "compareSettings" JSONB;

-- AlterTable
ALTER TABLE "deciship"."InvoiceLine" ADD COLUMN "tariffRevisionId" TEXT,
ADD COLUMN "prevResult" JSONB,
ADD COLUMN "recalcPending" TEXT,
ADD COLUMN "recalcPendingAt" TIMESTAMP(3);

-- ---------- Backfill ----------
-- Sahip de FORCE RLS'ye tabidir ve göçte firma bağlamı yoktur: okunan ve yazılan tablolarda bu işlem boyunca kapatılır
-- (20261107120000 ile aynı yol), göçün sonunda geri açılır. Yeni tabloda RLS de en sonda açılır. Hiçbir satırın "updatedAt"i değişmez: yeniden
-- karşılaştırmanın bayatlık denetimi ve varsayılan tarife seçimi bu sütuna bakar.
ALTER TABLE "deciship"."Company" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."Tariff" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffZone" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffRate" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffOverflow" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffSurcharge" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."Invoice" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."InvoiceLine" NO FORCE ROW LEVEL SECURITY;

-- 1) Her tarife için bugünkü hâlinden bir sürüm. "snapshot" src/services/tariffs.ts içindeki tariffSnapshot çıktısıyla
--    aynıdır (serializeTariffFull -> tariffBody.parse): aynı alan adları, sayılar sayı olarak ve sondaki sıfırlar atılmış
--    (15.50 -> 15.5), günler 'YYYY-MM-DD' (sütun UTC saklar), bölgeler ülkeye göre, fiyatlar bölge + ağırlığa göre sıralı.
--    Taşma ve ek ücretlerde uygulama sıralama yapmaz, tablodaki sırayla okur: burada da fiziksel sıra (ctid) korunur.
--    Ülke istisnalarında readAdjustments gibi bozuk kayıt atlanır. "contentHash" boş kalır: ilk ensureTariffRevision
--    özeti doldurur, yeni sürüm açmaz.
INSERT INTO "deciship"."TariffRevision" ("id", "companyId", "tariffId", "tariffName", "contentHash", "snapshot", "currency", "createdAt")
SELECT gen_random_uuid()::text, t."companyId", t."id", t."name", NULL,
  jsonb_build_object(
    'carrierId', t."carrierId",
    'name', t."name",
    'service', t."service",
    'currency', upper(t."currency" COLLATE "C"),
    'divisor', t."divisor",
    'edgeRounding', t."edgeRounding"::text,
    'weightSteps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('upto', w.v -> 'upto', 'step', w.v -> 'step') ORDER BY w.ord)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t."weightSteps") = 'array' THEN t."weightSteps" ELSE '[]'::jsonb END) WITH ORDINALITY AS w(v, ord)
    ), '[]'::jsonb),
    'discountPct', trim_scale(t."discountPct"),
    'fuelPct', trim_scale(t."fuelPct"),
    'fuelVariable', t."fuelVariable",
    'validFrom', to_char(t."validFrom", 'YYYY-MM-DD'),
    'validTo', to_char(t."validTo", 'YYYY-MM-DD'),
    'active', t."active",
    'isDefault', t."isDefault",
    'zones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('country', upper(z."country" COLLATE "C"), 'zone', z."zone") ORDER BY z."country", z.ctid)
      FROM "deciship"."TariffZone" z WHERE z."tariffId" = t."id"
    ), '[]'::jsonb),
    'rates', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('zone', r."zone", 'weightUpto', trim_scale(r."weightUpto"), 'price', trim_scale(r."price"), 'perKg', r."perKg")
        ORDER BY r."zone", r."weightUpto", r.ctid)
      FROM "deciship"."TariffRate" r WHERE r."tariffId" = t."id"
    ), '[]'::jsonb),
    'overflow', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('zone', o."zone", 'perUnit', trim_scale(o."perUnit")) ORDER BY o.ctid)
      FROM "deciship"."TariffOverflow" o WHERE o."tariffId" = t."id"
    ), '[]'::jsonb),
    'surcharges', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', s."code", 'name', s."name", 'kind', s."kind"::text, 'amount', trim_scale(s."amount")) ORDER BY s.ctid)
      FROM "deciship"."TariffSurcharge" s WHERE s."tariffId" = t."id"
    ), '[]'::jsonb),
    'countryAdjustments', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'country', upper(btrim(a.v ->> 'country') COLLATE "C"),
          'pct', a.v -> 'pct',
          'source', COALESCE(a.v ->> 'source', 'manual'))
        || CASE WHEN a.v ? 'note' THEN jsonb_build_object('note', btrim(a.v ->> 'note')) ELSE '{}'::jsonb END
        || CASE WHEN a.v ? 'invoiceId' THEN jsonb_build_object('invoiceId', a.v ->> 'invoiceId') ELSE '{}'::jsonb END
        ORDER BY a.ord)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t."countryAdjustments") = 'array' THEN t."countryAdjustments" ELSE '[]'::jsonb END) WITH ORDINALITY AS a(v, ord)
      WHERE jsonb_typeof(a.v) = 'object'
        AND jsonb_typeof(a.v -> 'country') = 'string'
        AND upper(btrim(a.v ->> 'country') COLLATE "C") ~ '^[A-Z]{2}$'
        AND CASE WHEN jsonb_typeof(a.v -> 'pct') = 'number' THEN (a.v ->> 'pct')::numeric BETWEEN -90 AND 200 ELSE false END
        AND (NOT a.v ? 'note' OR jsonb_typeof(a.v -> 'note') = 'null' OR (jsonb_typeof(a.v -> 'note') = 'string' AND char_length(btrim(a.v ->> 'note')) <= 300))
        AND (NOT a.v ? 'source' OR (jsonb_typeof(a.v -> 'source') = 'string' AND a.v ->> 'source' IN ('manual', 'invoice')))
        AND (NOT a.v ? 'invoiceId' OR jsonb_typeof(a.v -> 'invoiceId') = 'null' OR (jsonb_typeof(a.v -> 'invoiceId') = 'string' AND char_length(a.v ->> 'invoiceId') <= 100))
    ), '[]'::jsonb)
  ),
  upper(t."currency" COLLATE "C"),
  now() AT TIME ZONE 'UTC'
FROM "deciship"."Tariff" t;

UPDATE "deciship"."Tariff" t SET "currentRevisionId" = r."id"
FROM "deciship"."TariffRevision" r
WHERE r."tariffId" = t."id";

-- 2) Faturanın dayanağı, bugünkü hesabın kullandığı tarife (src/services/compare.ts invoiceTariff + defaultTariff):
--    faturada seçilen tarife (aynı taşıyıcının tarifesiyse, etkin olmasa da); yoksa taşıyıcının varsayılanı = etkin ve
--    "isDefault" olan, o da yoksa en son güncellenen etkin tarife. Etkin tarifesi olmayan taşıyıcının faturası
--    dayanaksız kalır (null). Silinmiş ve örnek faturalar da doldurulur.
--    "compareSettings": firmanın bugünkü ayarı = src/lib/settings.ts DEFAULT_SETTINGS + "Company"."settings"
--    (buildContext'teki gibi: unknownSurchargesAsDiff yalnız true ise true, para birimi büyük harf).
UPDATE "deciship"."Invoice" i
SET "tariffRevisionId" = COALESCE(
      (SELECT t."currentRevisionId" FROM "deciship"."Tariff" t
       WHERE t."id" = i."tariffId" AND t."companyId" = i."companyId" AND t."carrierId" = i."carrierId"),
      (SELECT t."currentRevisionId" FROM "deciship"."Tariff" t
       WHERE t."companyId" = i."companyId" AND t."carrierId" = i."carrierId" AND t."active"
       ORDER BY t."isDefault" DESC, (CASE WHEN t."isDefault" THEN NULL ELSE t."updatedAt" END) DESC NULLS LAST, t.ctid
       LIMIT 1)),
    "compareSettings" = jsonb_build_object(
      'edgeTolCm', CASE WHEN jsonb_typeof(c."settings" -> 'edgeTolCm') = 'number' THEN c."settings" -> 'edgeTolCm' ELSE '1'::jsonb END,
      'weightTolKg', CASE WHEN jsonb_typeof(c."settings" -> 'weightTolKg') = 'number' THEN c."settings" -> 'weightTolKg' ELSE '0.1'::jsonb END,
      'amountTol', CASE WHEN jsonb_typeof(c."settings" -> 'amountTol') = 'number' THEN c."settings" -> 'amountTol' ELSE '5'::jsonb END,
      'fxTolerancePct', CASE WHEN jsonb_typeof(c."settings" -> 'fxTolerancePct') = 'number' THEN c."settings" -> 'fxTolerancePct' ELSE '1.5'::jsonb END,
      'unknownSurchargesAsDiff', COALESCE(c."settings" -> 'unknownSurchargesAsDiff' = 'true'::jsonb, false),
      'companyCurrency', upper((CASE WHEN jsonb_typeof(c."settings" -> 'currency') = 'string' THEN c."settings" ->> 'currency' ELSE 'TRY' END) COLLATE "C"))
FROM "deciship"."Company" c
WHERE c."id" = i."companyId";

-- 3) Satırın sürümü: kayıtlı sonucun hesaplandığı tarifenin ("InvoiceLine"."tariffId") sürümü. Olağan durumda faturanın
--    sürümüyle aynıdır; varsayılan tarife sonradan değiştiyse satır hâlâ eski tarifeyle hesaplıdır ve onu gösterir.
--    Tarifesiz sonuç (NO_TARIFF) ve tarifesi silinmiş satır boş kalır.
UPDATE "deciship"."InvoiceLine" l SET "tariffRevisionId" = t."currentRevisionId"
FROM "deciship"."Tariff" t
WHERE t."id" = l."tariffId" AND t."companyId" = l."companyId" AND l."status" <> 'NO_TARIFF';

-- ---------- Dizinler ve yabancı anahtarlar ----------
-- Backfill'den sonra (dolu tabloda tek geçiş) ve FORCE geri açılmadan önce: anahtar kurulurken mevcut satırların
-- denetimi sahibin eliyle çalışır, FORCE açıkken bağlamsız sahip karşı tabloyu boş görür ve anahtar kurulamaz.

-- CreateIndex
CREATE INDEX "TariffRevision_tariffId_createdAt_idx" ON "deciship"."TariffRevision"("tariffId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TariffRevision_id_companyId_key" ON "deciship"."TariffRevision"("id", "companyId");

-- CreateIndex
CREATE INDEX "Invoice_tariffRevisionId_idx" ON "deciship"."Invoice"("tariffRevisionId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tariffRevisionId_idx" ON "deciship"."InvoiceLine"("tariffRevisionId");

-- AddForeignKey: firma
ALTER TABLE "deciship"."TariffRevision" ADD CONSTRAINT "TariffRevision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: bileşik (4 anahtar; src/lib/schemaCheck.ts MIN_COMPANY_SCOPED_FKS)
-- Tarife silinince sürüm durur, yalnız "tariffId" boşalır ("companyId" NOT NULL: sütun listesi şart).
ALTER TABLE "deciship"."TariffRevision" ADD CONSTRAINT "TariffRevision_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE SET NULL ("tariffId") ON UPDATE CASCADE;
-- Sürüm silinmez. NO ACTION: bir faturanın, satırın ya da tarifenin gösterdiği sürüm silinemez. RESTRICT değil: firma
-- silinirken (cascade) tarife, fatura ve satırlar sürümden önce gider (firma anahtarları bu tablolarda daha eskidir,
-- tetikleyiciler kuruluş sırasıyla çalışır) ve denetim sürüm silinirken boş bulur.
ALTER TABLE "deciship"."Tariff" ADD CONSTRAINT "Tariff_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId", "companyId") REFERENCES "deciship"."TariffRevision"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "deciship"."Invoice" ADD CONSTRAINT "Invoice_tariffRevisionId_fkey" FOREIGN KEY ("tariffRevisionId", "companyId") REFERENCES "deciship"."TariffRevision"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "deciship"."InvoiceLine" ADD CONSTRAINT "InvoiceLine_tariffRevisionId_fkey" FOREIGN KEY ("tariffRevisionId", "companyId") REFERENCES "deciship"."TariffRevision"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------- Satır düzeyinde güvenlik ----------
-- Backfill için kapatılan zorunluluk geri açılır.
ALTER TABLE "deciship"."Company" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."Tariff" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffZone" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffRate" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffOverflow" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffSurcharge" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."Invoice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."InvoiceLine" FORCE ROW LEVEL SECURITY;

-- Yeni tablo: init göçüyle aynı ilke.
-- Bakım kapsamı (app.scope = 'maintenance') ilkesi yok: bakım işi yalnız bekleyen ölçümü dar yoldan okur, yeniden
-- karşılaştırmanın kendisi firma bağlamında çalışır ve sürümü o bağlamda görür.

ALTER TABLE "deciship"."TariffRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."TariffRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "deciship"."TariffRevision"
  USING ("companyId" = current_setting('app.company_id', true))
  WITH CHECK ("companyId" = current_setting('app.company_id', true));
