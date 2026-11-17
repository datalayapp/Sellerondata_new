-- Özel roller (plan `SONRAKI-OTURUM/ARSIV/PLAN-ozel-roller.md`): firmanın uygulama rolleri ve hazır rollerin firma içi gölgesi.
-- Yalnız ileri. Mevcut üyelikler göç gerektirmez: hazır rol anahtarı (`MEASURE`) aynı kalır, `customRoleId` boş.
CREATE TABLE "platform"."ProductRole" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inheritPermissions" BOOLEAN NOT NULL DEFAULT false,
    "basedOn" TEXT,
    "builtinKey" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductRole_orgId_product_builtinKey_key" ON "platform"."ProductRole"("orgId", "product", "builtinKey");

CREATE INDEX "ProductRole_orgId_product_idx" ON "platform"."ProductRole"("orgId", "product");

ALTER TABLE "platform"."ProductRole" ADD CONSTRAINT "ProductRole_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "platform"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ad firma ve ürün içinde büyük/küçük harf duyarsız tekil; gizlenmiş hazır rolün adı yer tutmaz. Uygulama da denetler
-- (katalog adları dahil, `ROLE_NAME_TAKEN`); bu dizin eşzamanlı yazmada son güvencedir.
CREATE UNIQUE INDEX "ProductRole_orgId_product_name_key" ON "platform"."ProductRole"("orgId", "product", lower("name"))
  WHERE "name" IS NOT NULL AND "hidden" = false;

ALTER TABLE "platform"."ProductRole"
  ADD CONSTRAINT "ProductRole_permissions_not_null" CHECK ("permissions" IS NOT NULL),
  -- Özel rolün adı zorunlu; gölge satırda boş ad katalog adıdır.
  ADD CONSTRAINT "ProductRole_name_required" CHECK ("builtinKey" IS NOT NULL OR "name" IS NOT NULL),
  ADD CONSTRAINT "ProductRole_name_length" CHECK ("name" IS NULL OR (char_length("name") BETWEEN 1 AND 40 AND "name" = btrim("name"))),
  ADD CONSTRAINT "ProductRole_description_length" CHECK ("description" IS NULL OR char_length("description") <= 200),
  -- Gizleme ve katalog izni yalnız hazır rolün gölgesinde anlamlıdır.
  ADD CONSTRAINT "ProductRole_hidden_builtin" CHECK (NOT "hidden" OR "builtinKey" IS NOT NULL),
  ADD CONSTRAINT "ProductRole_inherit_builtin" CHECK (NOT "inheritPermissions" OR "builtinKey" IS NOT NULL),
  ADD CONSTRAINT "ProductRole_version_positive" CHECK ("version" >= 1);

-- Üyelikteki özel rol bağı. Silme engelli (NO ACTION: deyim sonunda denetlenir, firma silinirken zincirleme silme takılmaz).
ALTER TABLE "platform"."ProductAccess" ADD COLUMN "customRoleId" TEXT;

CREATE INDEX "ProductAccess_customRoleId_idx" ON "platform"."ProductAccess"("customRoleId");

ALTER TABLE "platform"."ProductAccess" ADD CONSTRAINT "ProductAccess_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "platform"."ProductRole"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- `customRoleId` boş ⇔ rol `custom:` ile başlamaz; doluysa rol anahtarı `custom:` + kimliktir.
ALTER TABLE "platform"."ProductAccess" ADD CONSTRAINT "ProductAccess_custom_role_key" CHECK (
  ("customRoleId" IS NULL AND "role" NOT LIKE 'custom:%')
  OR ("customRoleId" IS NOT NULL AND "role" = 'custom:' || "customRoleId")
);

-- Özel rol yalnız kendi firmasının ve kendi ürününün üyeliğine bağlanır; gölge satır (hazır rol) özel rol olarak bağlanamaz.
CREATE FUNCTION "platform"."product_access_custom_role_scope"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customRoleId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "platform"."ProductRole" r
    JOIN "platform"."Membership" m ON m."id" = NEW."membershipId"
    WHERE r."id" = NEW."customRoleId"
      AND r."orgId" = m."orgId"
      AND r."product" = NEW."product"
      AND r."builtinKey" IS NULL
  ) THEN
    RAISE EXCEPTION 'ozel rol baska firmanin ya da urunun: %', NEW."customRoleId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProductAccess_custom_role_scope"
  BEFORE INSERT OR UPDATE OF "customRoleId", "product", "membershipId" ON "platform"."ProductAccess"
  FOR EACH ROW EXECUTE FUNCTION "platform"."product_access_custom_role_scope"();
