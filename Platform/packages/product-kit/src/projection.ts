import { MAINTENANCE_SCOPE, ORG_SETTING, SCOPE_SETTING, sqlIdent } from './db.ts';

/**
 * İşlenmiş olay kimliğinin saklama süresi (DeciShip `PROCESSED_EVENT_TTL_MS` ile aynı). Olay tekrarına karşı: auth-kit en az
 * 10 dakika ister; dağıtıcının yeniden denemelerinden çok daha uzun. Göçteki bakım ilkesi de bu süreyi kullanır.
 */
export const PROCESSED_EVENT_TTL_DAYS = 30;
export const PROCESSED_EVENT_TTL_MS = PROCESSED_EVENT_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Aracın ilk göçüne konan kimlik izdüşümü bloğu (ARCHITECTURE §6 "Alıcı sözleşmesi"). Çıktı sabittir: göçe yapıştırılır,
 * sonra değişmez; araç testi blokla göçün aynı kaldığını denetleyebilir (ör. `test/ornekarac/migration.sql`). Paket sonradan
 * sütun eklerse araç onu kendi yeni göçüyle ekler.
 *
 * Şemayı açmaz: şema ve aracın iki rolü (`sod_<araç>_admin` sahibi ve göçü çalıştırır, `sod_<araç>` uygulama) kayıttan üretilen
 * `infra/postgres/init.sql` / `upgrade.sql` ile gelir; göçte `CREATE SCHEMA` yasak (products-lists.mjs denetler). Blok göç
 * rolüyle çalışır. init.sql'in varsayılan hakları uygulama rolüne her yeni tabloda tam veri hakkı verir: blok bunları kendi
 * tablolarında önce geri alır, sonra yalnız gerekeni verir.
 *
 * - `Company`: Hesap'taki firmanın yerel kopyası. Ad, para birimi, ülke, saat dilimi ve Merkez onayı `org.updated` ile,
 *   `nameVersion` sırasıyla (alan olayda yoksa kayıtlı değer kalır).
 *   `timeZone`: `TIME_ZONES`'tan (contracts); null ise `DEFAULT_ORG_TIME_ZONE` (Hesap varsayılanı yeniden duyurmaz).
 *   `companyConfirmed`: firma bilgileri Merkez'de onaylı mı; yeni satır `false` açılır (olay sırası garantisiz: JIT ya da üye olayı
 *   `org.updated`'dan önce gelirse firma onaylı görünmesin), yalnız `org.updated` yazar. Aracın kurulumu buna bağlıdır.
 *   `closedAt`: firma kapatıldı (`org.closed`), geri açılınca (`org.reopened`) boşalır; `closedVersion` sırasıyla (eşit ya da küçük
 *   sürüm uygulanmaz). Kapalı firmada her uç 409 ORG_CLOSED; aracın arka plan işleri `isOrgClosed` ile atlar.
 * - Aracın firma tabloları `"orgId"` sütunu ve `Company`'ye yabancı anahtar taşır (RLS ilkesi ve kalıcı silme bu sütunla);
 *   `orgId`'siz çocuk tablo ebeveynine `ON DELETE CASCADE` ile bağlanır (`checkPurgeTables`).
 * - `Member`: üyeliğin yerel kopyası (`id` = Hesap `Membership.id`, jetonda `mid`). `epoch` sırası, `active` askı.
 *   `permissions`: rolün firmadaki geçerli izinleri (katalogla kesişmiş, özel ya da düzenlenmiş hazır rol); null ise rolden
 *   katalogla türetilir (eski biçim olay ya da jeton). Okuma: `loadMemberAccess` + `memberPermissions`.
 *   `UNIQUE ("id", "orgId")`: aracın tabloları üyeye bileşik anahtarla bağlanır (`FOREIGN KEY ("createdBy", "orgId")`): başka
 *   firmanın üyesine bağlanamaz.
 * - `ProcessedEvent`: işlenmiş olay kimlikleri (idempotent alıcı). `PROCESSED_EVENT_TTL_DAYS`'ten eskisi bakımda silinir
 *   (`cleanupProcessedEvents`, DeciShip bakımıyla aynı yol).
 * - `CompanyPurge`: kalıcı silinen firmanın kimliği (`org.purged`). Firmanın satırları parça parça silinir, bu kayıt kalır: gecikmiş
 *   olay ya da JIT firmayı yeniden kurmaz. `completedAt` boşsa silme bitmemiştir (veritabanı ya da dosyalar): bakım yeniden dener.
 * - `Company` ve `Member` ENABLE + FORCE RLS: satır yalnız `app.org_id` bağlamında görünür ve yazılır.
 *   `ProcessedEvent` olay kapsamında (`app.scope = 'events'`) okunur ve eklenir: bağlamsız işlem firma satırı göremez. Bakım
 *   kapsamında (`app.scope = 'maintenance'`) yalnız süresi dolmuş satırlar görünür ve silinir; olay kapsamında silme yok.
 *   `CompanyPurge` firma bağlamında okunur; yalnız olay alıcısı ve yalnız bitmemiş kayıt ekler (firma bağlamı +
 *   `app.scope = 'events'`); güncelleme yalnız
 *   bitmemiş kaydı bitmiş yapar (`completedAt` bir kez yazılır, geri alınamaz); bakım kapsamında (`app.scope = 'maintenance'`)
 *   yalnız bitmemiş kayıtlar okunur.
 * - Uygulama rolüne yalnız gereken haklar. Firma verisinde silme yalnız `Company` ve `Member`'da ve yalnız kalıcı firma silmesi
 *   içindir (`org.purged`); üye çıkarma pasif kayıttır, veri silinmez. `ProcessedEvent`'te silme yalnız bakımın süresi dolan
 *   kayıtlarında, güncelleme yok. `CompanyPurge`'te silme yok; yalnız `completedAt` güncellenir.
 */
export function memberProjectionSql(opts: { schema: string; appRole: string }): string {
  const s = sqlIdent(opts.schema, 'schema');
  const role = sqlIdent(opts.appRole, 'appRole');
  const org = `current_setting('${ORG_SETTING}', true)`;
  const scope = `current_setting('${SCOPE_SETTING}', true)`;
  return `-- product-kit memberProjectionSql (schema ${opts.schema}, rol ${opts.appRole})
GRANT USAGE ON SCHEMA ${s} TO ${role};

CREATE TABLE ${s}."Company" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL DEFAULT '',
  "nameVersion" integer,
  "currency" text,
  "country" text,
  "timeZone" text,
  "companyConfirmed" boolean NOT NULL DEFAULT false,
  "closedAt" timestamptz,
  "closedVersion" integer,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ${s}."Member" (
  "id" text PRIMARY KEY,
  "orgId" text NOT NULL REFERENCES ${s}."Company"("id"),
  "personId" text NOT NULL DEFAULT '',
  "name" text NOT NULL DEFAULT '',
  "role" text,
  "permissions" text[],
  "active" boolean NOT NULL DEFAULT true,
  "epoch" integer NOT NULL DEFAULT 0,
  "removedAt" timestamptz,
  "lastSeenAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Member_id_orgId_key" UNIQUE ("id", "orgId")
);
CREATE INDEX "Member_orgId_idx" ON ${s}."Member"("orgId");

CREATE TABLE ${s}."ProcessedEvent" (
  "eventId" text PRIMARY KEY,
  "processedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ${s}."CompanyPurge" (
  "orgId" text PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "completedAt" timestamptz
);

-- init.sql'in varsayılan hakları (tam veri hakkı) önce geri alınır: uygulama rolü yalnız aşağıdakileri alır.
REVOKE ALL ON ${s}."Company", ${s}."Member", ${s}."ProcessedEvent", ${s}."CompanyPurge" FROM ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ${s}."Company", ${s}."Member" TO ${role};
GRANT SELECT, INSERT, DELETE ON ${s}."ProcessedEvent" TO ${role};
GRANT SELECT, INSERT ON ${s}."CompanyPurge" TO ${role};
GRANT UPDATE ("completedAt") ON ${s}."CompanyPurge" TO ${role};

ALTER TABLE ${s}."Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${s}."Company" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ${s}."Company"
  USING ("id" = ${org})
  WITH CHECK ("id" = ${org});

ALTER TABLE ${s}."Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${s}."Member" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ${s}."Member"
  USING ("orgId" = ${org})
  WITH CHECK ("orgId" = ${org});

ALTER TABLE ${s}."CompanyPurge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${s}."CompanyPurge" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON ${s}."CompanyPurge" FOR SELECT
  USING ("orgId" = ${org});
CREATE POLICY event_insert ON ${s}."CompanyPurge" FOR INSERT
  WITH CHECK ("orgId" = ${org} AND ${scope} = 'events' AND "completedAt" IS NULL);
CREATE POLICY purge_complete ON ${s}."CompanyPurge" FOR UPDATE
  USING ("orgId" = ${org} AND "completedAt" IS NULL)
  WITH CHECK ("orgId" = ${org} AND "completedAt" IS NOT NULL);
CREATE POLICY maintenance_purge_read ON ${s}."CompanyPurge" FOR SELECT
  USING (${scope} = '${MAINTENANCE_SCOPE}' AND "completedAt" IS NULL);

ALTER TABLE ${s}."ProcessedEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${s}."ProcessedEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY event_read ON ${s}."ProcessedEvent" FOR SELECT
  USING (${scope} = 'events');
CREATE POLICY event_insert ON ${s}."ProcessedEvent" FOR INSERT
  WITH CHECK (${scope} = 'events');
CREATE POLICY maintenance_expired_read ON ${s}."ProcessedEvent" FOR SELECT
  USING (${scope} = '${MAINTENANCE_SCOPE}' AND "processedAt" < now() - interval '${PROCESSED_EVENT_TTL_DAYS} days');
CREATE POLICY maintenance_expired_delete ON ${s}."ProcessedEvent" FOR DELETE
  USING (${scope} = '${MAINTENANCE_SCOPE}' AND "processedAt" < now() - interval '${PROCESSED_EVENT_TTL_DAYS} days');
-- product-kit memberProjectionSql sonu
`;
}
