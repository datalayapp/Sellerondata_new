-- Şema init.sql ile açılır (sod_ai_admin sahibi). Göç rolünde CREATE ON DATABASE yoktur.
-- Tablolar `ai` şemasında: bağlantı adresi ?schema=ai, rolün search_path'i de `ai`.

-- CreateTable
CREATE TABLE "ProviderKey" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'platform',
    "orgId" TEXT,
    "provider" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "masterKeyId" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "setById" TEXT NOT NULL,
    "setByName" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestHttpStatus" INTEGER,
    "rejectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderKey_scope_check" CHECK ("scope" IN ('platform', 'org')),
    CONSTRAINT "ProviderKey_scope_org_check" CHECK (("scope" = 'platform') = ("orgId" IS NULL)),
    CONSTRAINT "ProviderKey_provider_check" CHECK ("provider" IN ('anthropic', 'gemini')),
    -- Mühür biçimi: v1.<kimlik>.<iv>.<etiket>.<şifreli metin>. Düz anahtar bu sütuna yanlışlıkla yazılamaz.
    CONSTRAINT "ProviderKey_sealed_check" CHECK ("sealed" ~ '^v1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'),
    CONSTRAINT "ProviderKey_last4_check" CHECK (char_length("last4") = 4)
);

-- Kapsam başına sağlayıcıda tek anahtar: platformda sağlayıcı başına bir, firmada firma × sağlayıcı başına bir.
CREATE UNIQUE INDEX "ProviderKey_platform_provider_key" ON "ProviderKey" ("provider") WHERE "scope" = 'platform';
CREATE UNIQUE INDEX "ProviderKey_org_provider_key" ON "ProviderKey" ("orgId", "provider") WHERE "scope" = 'org';

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "provider" TEXT,
    "orgId" TEXT,
    "detail" JSONB,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAudit_at_idx" ON "AdminAudit"("at");

-- CreateTable
CREATE TABLE "AiCall" (
    "id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "memberId" TEXT,
    "purpose" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "servedModel" TEXT,
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite5mTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite1hTokens" INTEGER NOT NULL DEFAULT 0,
    "inputImages" INTEGER NOT NULL DEFAULT 0,
    "outputImages" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "priceVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "httpStatus" INTEGER,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "keySource" TEXT NOT NULL DEFAULT 'platform',
    "toolRequestId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "upstreamRequestId" TEXT,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiCall_status_check" CHECK ("status" IN ('pending', 'ok', 'failed', 'cancelled', 'rejected', 'interrupted')),
    CONSTRAINT "AiCall_origin_check" CHECK ("origin" IN ('request', 'job')),
    CONSTRAINT "AiCall_provider_check" CHECK ("provider" IN ('anthropic', 'gemini')),
    CONSTRAINT "AiCall_keySource_check" CHECK ("keySource" IN ('platform', 'org')),
    CONSTRAINT "AiCall_amounts_check" CHECK ("costMicroUsd" >= 0 AND "reservedMicroUsd" >= 0),
    -- Pay yalnız açık satırda durur: kapanan satır tavanlarda pay olarak sayılmaz.
    CONSTRAINT "AiCall_reserved_pending_check" CHECK ("status" = 'pending' OR "reservedMicroUsd" = 0),
    CONSTRAINT "AiCall_attempt_check" CHECK ("attempt" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCall_product_toolRequestId_attempt_key" ON "AiCall"("product", "toolRequestId", "attempt");
CREATE INDEX "AiCall_orgId_startedAt_idx" ON "AiCall"("orgId", "startedAt");
CREATE INDEX "AiCall_startedAt_idx" ON "AiCall"("startedAt");
-- Açık satırlar (pay toplamı, açılış taraması) küçük bir kümedir.
CREATE INDEX "AiCall_pending_idx" ON "AiCall" ("orgId", "product") WHERE "status" = 'pending';

-- CreateTable
CREATE TABLE "AiSpendDaily" (
    "day" DATE NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "keySource" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWrite5mTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWrite1hTokens" BIGINT NOT NULL DEFAULT 0,
    "outputImages" BIGINT NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "AiSpendDaily_pkey" PRIMARY KEY ("day","orgId","product","purpose","model","status","keySource"),
    CONSTRAINT "AiSpendDaily_status_check" CHECK ("status" IN ('ok', 'failed', 'cancelled', 'rejected', 'interrupted')),
    CONSTRAINT "AiSpendDaily_keySource_check" CHECK ("keySource" IN ('platform', 'org'))
);

-- CreateIndex
CREATE INDEX "AiSpendDaily_orgId_day_idx" ON "AiSpendDaily"("orgId", "day");

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "timeZone" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "capOverrideMicroUsd" BIGINT,
    "capOverriddenBy" TEXT,
    "capOverriddenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Org_cap_check" CHECK ("capOverrideMicroUsd" IS NULL OR "capOverrideMicroUsd" >= 0),
    -- Silinen firmada ad tutulmaz.
    CONSTRAINT "Org_purged_name_check" CHECK ("purgedAt" IS NULL OR "name" IS NULL)
);

-- CreateTable
CREATE TABLE "OrgProductCap" (
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "capMicroUsd" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgProductCap_pkey" PRIMARY KEY ("orgId","product"),
    CONSTRAINT "OrgProductCap_cap_check" CHECK ("capMicroUsd" IS NULL OR "capMicroUsd" >= 0)
);

-- CreateTable
CREATE TABLE "PlatformLimits" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "dailyCapMicroUsd" BIGINT,
    "monthlyCapMicroUsd" BIGINT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "pausedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformLimits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformLimits_single_row" CHECK ("id" = 1),
    CONSTRAINT "PlatformLimits_caps_check" CHECK (("dailyCapMicroUsd" IS NULL OR "dailyCapMicroUsd" >= 0) AND ("monthlyCapMicroUsd" IS NULL OR "monthlyCapMicroUsd" >= 0))
);

-- Tek satır göçle açılır; uygulama yalnız günceller.
INSERT INTO "PlatformLimits" ("id") VALUES (1);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "ProcessedEvent_processedAt_idx" ON "ProcessedEvent"("processedAt");

-- Uygulama rolünün hakları daraltılır (init.sql'in varsayılan hakları her tabloya tam veri hakkı verir):
-- yönetici kaydı yalnız eklenir (geçmiş silinemez, değiştirilemez); tek satırlı tavan tablosu silinemez, eklenemez.
REVOKE UPDATE, DELETE ON TABLE "AdminAudit" FROM sod_ai;
REVOKE INSERT, DELETE ON TABLE "PlatformLimits" FROM sod_ai;

-- Uygulama rolü göç geçmişine yazamaz. Varsayılan haklar tabloyu da kapsıyordu.
REVOKE ALL ON TABLE "_prisma_migrations" FROM sod_ai;
