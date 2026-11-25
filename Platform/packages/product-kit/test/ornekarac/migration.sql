-- product-kit memberProjectionSql (schema ornekarac, rol sod_ornekarac)
GRANT USAGE ON SCHEMA "ornekarac" TO "sod_ornekarac";

CREATE TABLE "ornekarac"."Company" (
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

CREATE TABLE "ornekarac"."Member" (
  "id" text PRIMARY KEY,
  "orgId" text NOT NULL REFERENCES "ornekarac"."Company"("id"),
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
CREATE INDEX "Member_orgId_idx" ON "ornekarac"."Member"("orgId");

CREATE TABLE "ornekarac"."ProcessedEvent" (
  "eventId" text PRIMARY KEY,
  "processedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "ornekarac"."CompanyPurge" (
  "orgId" text PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "completedAt" timestamptz
);

-- init.sql'in varsayılan hakları (tam veri hakkı) önce geri alınır: uygulama rolü yalnız aşağıdakileri alır.
REVOKE ALL ON "ornekarac"."Company", "ornekarac"."Member", "ornekarac"."ProcessedEvent", "ornekarac"."CompanyPurge" FROM "sod_ornekarac";
GRANT SELECT, INSERT, UPDATE, DELETE ON "ornekarac"."Company", "ornekarac"."Member" TO "sod_ornekarac";
GRANT SELECT, INSERT, DELETE ON "ornekarac"."ProcessedEvent" TO "sod_ornekarac";
GRANT SELECT, INSERT ON "ornekarac"."CompanyPurge" TO "sod_ornekarac";
GRANT UPDATE ("completedAt") ON "ornekarac"."CompanyPurge" TO "sod_ornekarac";

ALTER TABLE "ornekarac"."Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ornekarac"."Company" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ornekarac"."Company"
  USING ("id" = current_setting('app.org_id', true))
  WITH CHECK ("id" = current_setting('app.org_id', true));

ALTER TABLE "ornekarac"."Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ornekarac"."Member" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ornekarac"."Member"
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "ornekarac"."CompanyPurge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ornekarac"."CompanyPurge" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON "ornekarac"."CompanyPurge" FOR SELECT
  USING ("orgId" = current_setting('app.org_id', true));
CREATE POLICY event_insert ON "ornekarac"."CompanyPurge" FOR INSERT
  WITH CHECK ("orgId" = current_setting('app.org_id', true) AND current_setting('app.scope', true) = 'events' AND "completedAt" IS NULL);
CREATE POLICY purge_complete ON "ornekarac"."CompanyPurge" FOR UPDATE
  USING ("orgId" = current_setting('app.org_id', true) AND "completedAt" IS NULL)
  WITH CHECK ("orgId" = current_setting('app.org_id', true) AND "completedAt" IS NOT NULL);
CREATE POLICY maintenance_purge_read ON "ornekarac"."CompanyPurge" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "completedAt" IS NULL);

ALTER TABLE "ornekarac"."ProcessedEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ornekarac"."ProcessedEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY event_read ON "ornekarac"."ProcessedEvent" FOR SELECT
  USING (current_setting('app.scope', true) = 'events');
CREATE POLICY event_insert ON "ornekarac"."ProcessedEvent" FOR INSERT
  WITH CHECK (current_setting('app.scope', true) = 'events');
CREATE POLICY maintenance_expired_read ON "ornekarac"."ProcessedEvent" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "processedAt" < now() - interval '30 days');
CREATE POLICY maintenance_expired_delete ON "ornekarac"."ProcessedEvent" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "processedAt" < now() - interval '30 days');
-- product-kit memberProjectionSql sonu

-- Örnek Araç'ın kendi tabloları. Üyeye bileşik anahtarla bağlanır (başka firmanın üyesine bağlanamaz); kalıcı silmede Item
-- üyeden önce gider (`purge.tables`). `attachment`: diskteki dosyanın yolu (silmede `onRowsDeleted`'a verilir).
CREATE TABLE "ornekarac"."Item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orgId" text NOT NULL REFERENCES "ornekarac"."Company"("id"),
  "title" text NOT NULL,
  "attachment" text,
  "createdBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Item_createdBy_orgId_fkey" FOREIGN KEY ("createdBy", "orgId") REFERENCES "ornekarac"."Member"("id", "orgId")
);
CREATE INDEX "Item_orgId_createdAt_idx" ON "ornekarac"."Item"("orgId", "createdAt");
-- init.sql'in varsayılan hakları geri alınır, yalnız gereken verilir (kayıt güncellenmez).
REVOKE ALL ON "ornekarac"."Item" FROM "sod_ornekarac";
GRANT SELECT, INSERT, DELETE ON "ornekarac"."Item" TO "sod_ornekarac";
ALTER TABLE "ornekarac"."Item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ornekarac"."Item" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ornekarac"."Item"
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
