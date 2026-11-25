# Yapay zekâ geçidi (ai-api). Derleme bağlamı SellerOnData/ köküdür (ARCHITECTURE §2). Dosya listesi: Dockerfile.dockerignore
#
#   deps       tüm bağımlılıklar (derleme için)
#   build      prisma generate + tsup -> dist/
#   prod-deps  yalnız üretim bağımlılıkları, budanmış
#   runtime    node:24.22.1-alpine + dist + budanmış node_modules. Süper kullanıcı değil.
#
# Aynı imaj üç iş yapar: `ai-migrate` (prisma migrate deploy, sod_ai_admin), `ai-api` (sod_ai) ve acil durum komutu
# (`docker compose exec ai-api node dist/ai-key.js …`; anahtar standart girdiden).

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
COPY Platform/apps/ai-api/package.json Platform/apps/ai-api/package-lock.json Platform/apps/ai-api/
# postinstall şema ister; bu katmanda kalkar ki bağımlılık katmanı kod değişikliklerinden bağımsız kalsın.
RUN --mount=type=cache,target=/root/.npm \
  cd Platform/apps/ai-api && npm pkg delete scripts.postinstall && npm ci

# ---------- derleme ----------
FROM deps AS build
COPY Platform/packages/contracts Platform/packages/contracts
COPY Platform/packages/auth-kit Platform/packages/auth-kit
COPY Platform/apps/ai-api Platform/apps/ai-api
# Paketlerin bağımlılıkları (jose, @sellerondata/contracts) ai-api'dekilerle aynı: ayrı kurulum yerine bağla (DeciShip API deseni).
RUN rm -rf Platform/packages/auth-kit/node_modules Platform/packages/contracts/node_modules \
  && ln -s ../../apps/ai-api/node_modules Platform/packages/auth-kit/node_modules \
  && ln -s ../../apps/ai-api/node_modules Platform/packages/contracts/node_modules
RUN cd Platform/apps/ai-api && npm run build && find dist -name '*.map' -delete

# ---------- yalnız üretim bağımlılıkları ----------
FROM base AS prod-deps
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/
COPY Platform/apps/ai-api/package.json Platform/apps/ai-api/package-lock.json Platform/apps/ai-api/
RUN --mount=type=cache,target=/root/.npm \
  cd Platform/apps/ai-api && npm pkg delete scripts.postinstall && npm ci --omit=dev \
  # contracts ve auth-kit pakete gömülü; bağlantı imajda boşa düşerdi.
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
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4300 PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=prod-deps /app/Platform/apps/ai-api/node_modules Platform/apps/ai-api/node_modules
COPY Platform/apps/ai-api/package.json Platform/apps/ai-api/prisma.config.ts Platform/apps/ai-api/
COPY Platform/apps/ai-api/prisma Platform/apps/ai-api/prisma
COPY --from=build /app/Platform/apps/ai-api/src/generated Platform/apps/ai-api/src/generated
COPY --from=build /app/Platform/apps/ai-api/dist Platform/apps/ai-api/dist

WORKDIR /app/Platform/apps/ai-api
# Duman testi: budama bir şeyi kırdıysa derleme burada durur.
RUN npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /dev/null \
  && node -e "Promise.all(['jose','pg','@prisma/adapter-pg','fastify','zod'].map((m)=>import(m))).catch((e)=>{console.error(e);process.exit(1)})" \
  # Komut girişi gerçekten çalışıyor mu: üretim kipinde ortam eksik, açılış denetimi reddedip 1 ile bitmeli. Boş geçip 0 ile
  # biterse (bölmede gövde ortak parçaya taşınmış) derleme durur.
  && { node dist/ai-key.js status > /tmp/ai-key.out 2>&1; test $? -eq 1 && grep -q 'ai-api açılamadı' /tmp/ai-key.out || { cat /tmp/ai-key.out; exit 1; }; } \
  && rm -f /tmp/ai-key.out
RUN chown -R node:node /app
USER node
EXPOSE 4300
CMD ["node", "dist/main.js"]
