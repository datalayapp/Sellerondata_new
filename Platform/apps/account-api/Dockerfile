# Hesap servisi. Derleme bağlamı SellerOnData/ köküdür (ARCHITECTURE §2). Dosya listesi: Dockerfile.dockerignore
#
#   deps       tüm bağımlılıklar (derleme için)
#   build      prisma generate + tsup -> dist/
#   prod-deps  yalnız üretim bağımlılıkları, budanmış
#   runtime    node:24.22.1-alpine + dist + budanmış node_modules. Süper kullanıcı değil.
#
# Aynı imaj iki iş yapar: `account-migrate` (prisma migrate deploy, sod_platform_admin) ve `account-api` (sod_platform).

FROM node:24.22.1-alpine AS base
# openssl: Prisma şema motoru sürümü buradan algılar
RUN apk add --no-cache openssl
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /app

# ---------- tüm bağımlılıklar ----------
FROM base AS deps
# file: bağımlılıklar için npm ci hedefin package.json'unu okur
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/
COPY Platform/apps/account-api/package.json Platform/apps/account-api/package-lock.json Platform/apps/account-api/
# postinstall şema ister; bu katmanda kalkar ki bağımlılık katmanı kod değişikliklerinden bağımsız kalsın.
RUN --mount=type=cache,target=/root/.npm \
  cd Platform/apps/account-api && npm pkg delete scripts.postinstall && npm ci

# ---------- derleme ----------
FROM deps AS build
COPY Platform/packages/contracts Platform/packages/contracts
COPY Platform/apps/account-api Platform/apps/account-api
RUN cd Platform/apps/account-api && npm run build && find dist -name '*.map' -delete

# ---------- yalnız üretim bağımlılıkları ----------
FROM base AS prod-deps
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/
COPY Platform/apps/account-api/package.json Platform/apps/account-api/package-lock.json Platform/apps/account-api/
RUN --mount=type=cache,target=/root/.npm \
  cd Platform/apps/account-api && npm pkg delete scripts.postinstall && npm ci --omit=dev \
  # contracts pakete gömülü; bağlantı imajda boşa düşerdi.
  && rm -rf node_modules/@sellerondata \
  # budama: tip tanımı, belge, Postgres dışı Prisma derleyicileri, Studio arayüzü, gömülü Postgres
  && cd node_modules \
  && find . -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
       -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \) -delete \
  && find @prisma/client/runtime prisma/build -type f \
       \( -name '*.cockroachdb.*' -o -name '*.mysql.*' -o -name '*.sqlite.*' -o -name '*.sqlserver.*' \) -delete \
  && rm -rf @electric-sql typescript @typescript \
       @prisma/studio-core/dist/ui @prisma/studio-core/dist/metafile-*.json \
       react react-dom elkjs @visx @radix-ui

# ---------- çalışan imaj ----------
FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 ACCOUNT_KEYS_DIR=/data/keys PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=prod-deps /app/Platform/apps/account-api/node_modules Platform/apps/account-api/node_modules
COPY Platform/apps/account-api/package.json Platform/apps/account-api/prisma.config.ts Platform/apps/account-api/
COPY Platform/apps/account-api/prisma Platform/apps/account-api/prisma
COPY --from=build /app/Platform/apps/account-api/src/generated Platform/apps/account-api/src/generated
COPY --from=build /app/Platform/apps/account-api/dist Platform/apps/account-api/dist

WORKDIR /app/Platform/apps/account-api
# Duman testi: budama bir şeyi kırdıysa derleme burada durur.
RUN npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /dev/null \
  && node -e "Promise.all(['argon2','jose','libphonenumber-js','nodemailer','pg','@prisma/adapter-pg'].map((m)=>import(m))).then(([a])=>a.default.hash('duman')).catch((e)=>{console.error(e);process.exit(1)})" \
  # Komut girişi gerçekten çalışıyor mu: tohum üretim kipinde (bu imajın varsayılanı) reddedip 1 ile bitmeli. Boş geçip 0 ile
  # biterse (bölmede gövde ortak parçaya taşınmış) derleme durur. Ayrıntı: test/cli-entries.test.mjs.
  && { node dist/seed.js > /tmp/seed.out 2>&1; test $? -eq 1 && grep -q 'tohumu' /tmp/seed.out || { cat /tmp/seed.out; exit 1; }; } \
  && rm -f /tmp/seed.out
RUN mkdir -p /data/keys && chown -R node:node /data /app
USER node
EXPOSE 4100
CMD ["node", "dist/main.js"]
