-- Kayıt daveti (kullanıcı kararı 2026-11-12): SIGNUP_MODE=invite iken yeni firma kaydı yalnız bu davetle. Yalnız ileri; geri almak
-- için tabloyu silmek gerekmez, SIGNUP_MODE=open yeter.
CREATE TABLE "platform"."SignupInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByPersonId" TEXT,
    "orgId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupInvite_tokenHash_key" ON "platform"."SignupInvite"("tokenHash");

CREATE INDEX "SignupInvite_email_idx" ON "platform"."SignupInvite"("email");

-- Adres küçük harf yazılır (Person.email ile aynı kural); büyük harfli adres eşleşmeyip daveti boşa harcatmasın.
ALTER TABLE "platform"."SignupInvite" ADD CONSTRAINT "SignupInvite_email_lower" CHECK ("email" = lower("email"));
