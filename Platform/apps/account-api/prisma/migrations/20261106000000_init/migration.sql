-- Şema init.sql ile açılır. Migration rolünde CREATE ON DATABASE yoktur.

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('tr', 'en');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('TRY', 'USD');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'READ_ONLY', 'CANCELED');

-- CreateEnum
CREATE TYPE "InvitationKind" AS ENUM ('EMAIL', 'PHONE_CODE', 'PHONE_RESET');

-- CreateEnum
CREATE TYPE "SessionClient" AS ENUM ('web', 'mobile');

-- CreateEnum
CREATE TYPE "OneTimeTokenKind" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFY');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'DEAD');

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'tr',
    "emailVerifiedAt" TIMESTAMP(3),
    "lastOrgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'TR',
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "locale" "Locale" NOT NULL DEFAULT 'tr',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orgRole" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAccess" (
    "membershipId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "ProductAccess_pkey" PRIMARY KEY ("membershipId","product")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" TEXT NOT NULL,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "currentPeriodEnd" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "deleteAfter" TIMESTAMP(3),
    "provider" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "InvitationKind" NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "name" TEXT,
    "orgRole" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "productRoles" JSONB NOT NULL DEFAULT '{}',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT NOT NULL,
    "targetPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "activeOrgId" TEXT,
    "client" "SessionClient" NOT NULL,
    "familyId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneTimeToken" (
    "id" TEXT NOT NULL,
    "kind" "OneTimeTokenKind" NOT NULL,
    "personId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OneTimeToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "actorMembershipId" TEXT,
    "actorPersonId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orgId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxDelivery" (
    "id" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailLog" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Person_email_key" ON "Person"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Person_phone_key" ON "Person"("phone");

-- CreateIndex
CREATE INDEX "Membership_orgId_idx" ON "Membership"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_personId_orgId_key" ON "Membership"("personId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_orgId_product_key" ON "Subscription"("orgId", "product");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_orgId_idx" ON "Invitation"("orgId");

-- CreateIndex
CREATE INDEX "Invitation_phone_idx" ON "Invitation"("phone");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Invitation_invitedById_idx" ON "Invitation"("invitedById");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");

-- CreateIndex
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- CreateIndex
CREATE INDEX "Session_personId_idx" ON "Session"("personId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OneTimeToken_tokenHash_key" ON "OneTimeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OneTimeToken_personId_kind_idx" ON "OneTimeToken"("personId", "kind");

-- CreateIndex
CREATE INDEX "RateBucket_windowEnd_idx" ON "RateBucket"("windowEnd");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Outbox_createdAt_idx" ON "Outbox"("createdAt");

-- CreateIndex
CREATE INDEX "OutboxDelivery_status_nextAttemptAt_idx" ON "OutboxDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxDelivery_outboxId_target_key" ON "OutboxDelivery"("outboxId", "target");

-- CreateIndex
CREATE INDEX "MailLog_to_createdAt_idx" ON "MailLog"("to", "createdAt");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAccess" ADD CONSTRAINT "ProductAccess_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneTimeToken" ADD CONSTRAINT "OneTimeToken_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "Outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Prisma'nın ifade edemediği kurallar. Uygulama kodu atlasa bile veritabanı reddeder.
-- ---------------------------------------------------------------------------

-- Kişinin en az bir kimliği olur; e-posta küçük harftir, telefon E.164'tür.
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_identity_required" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL),
  ADD CONSTRAINT "Person_email_lowercase" CHECK ("email" IS NULL OR "email" = lower("email")),
  ADD CONSTRAINT "Person_phone_e164" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');

-- Firmada en fazla bir OWNER; OWNER askıda olamaz.
CREATE UNIQUE INDEX "Membership_single_owner" ON "Membership" ("orgId") WHERE "orgRole" = 'OWNER';
ALTER TABLE "Membership"
  ADD CONSTRAINT "Membership_owner_active" CHECK ("orgRole" <> 'OWNER' OR "status" = 'ACTIVE');

-- Firmada en az bir OWNER. İşlem sonunda denetlenir: sahiplik devri ve firma açılışı aynı işlemde ara durumdan geçer.
CREATE FUNCTION "membership_require_owner"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = platform, pg_temp
AS $$
DECLARE
  affected_org text := OLD."orgId";
BEGIN
  IF EXISTS (SELECT 1 FROM "Organization" WHERE "id" = affected_org)
     AND NOT EXISTS (SELECT 1 FROM "Membership" WHERE "orgId" = affected_org AND "orgRole" = 'OWNER') THEN
    RAISE EXCEPTION 'firmanin sahibi kalmaz: %', affected_org USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Membership_require_owner"
  AFTER UPDATE OR DELETE ON "Membership"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "membership_require_owner"();

-- Davetin hedefi türüyle uyumlu olur; bir firmada aynı kişiye tek bekleyen davet.
ALTER TABLE "Invitation"
  ADD CONSTRAINT "Invitation_kind_target" CHECK (
    ("kind" = 'EMAIL' AND "email" IS NOT NULL AND "phone" IS NULL)
    OR ("kind" = 'PHONE_CODE' AND "phone" IS NOT NULL AND "email" IS NULL)
    OR ("kind" = 'PHONE_RESET' AND "phone" IS NOT NULL AND "email" IS NULL AND "targetPersonId" IS NOT NULL)
  ),
  ADD CONSTRAINT "Invitation_not_owner" CHECK ("orgRole" <> 'OWNER');
CREATE UNIQUE INDEX "Invitation_pending_email" ON "Invitation" ("orgId", "email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "email" IS NOT NULL;
CREATE UNIQUE INDEX "Invitation_pending_phone" ON "Invitation" ("orgId", "phone")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "phone" IS NOT NULL;

-- Bir ailede tek etkin baş: eşzamanlı yenileme iki baş üretemez.
CREATE UNIQUE INDEX "Session_single_head" ON "Session" ("familyId")
  WHERE "rotatedAt" IS NULL AND "revokedAt" IS NULL;

-- Teslim tablosu büyür, dağıtıcı her saniye yalnız bekleyenlere bakar.
CREATE INDEX "OutboxDelivery_pending" ON "OutboxDelivery" ("nextAttemptAt") WHERE "status" = 'PENDING';

-- Uygulama rolü migration geçmişine yazamaz. Default privileges tabloyu da kapsıyordu.
REVOKE ALL ON TABLE "_prisma_migrations" FROM sod_platform;
