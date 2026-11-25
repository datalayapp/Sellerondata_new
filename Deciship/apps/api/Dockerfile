# Derleme bağlamı: SellerOnData/ kökü (Platform ARCHITECTURE §2). Dosya listesi: Dockerfile.dockerignore
#
# Aşamalar:
#   deps       tüm bağımlılıklar (derleme için)           - yalnız package.json/lock değişince yeniden kurulur
#   build      prisma generate + tsup -> dist/
#   prod-deps  yalnız üretim bağımlılıkları, budanmış       - yalnız package.json/lock değişince yeniden kurulur
#   runtime    çalışan imaj (node:24.22.1-alpine + dist + budanmış prod node_modules)
#
# Aynı imaj iki kapta çalışır:
#   deciship-api      node dist/main.js (sod_deciship). Migration parolası bu kapta yoktur.
#   deciship-migrate  npx prisma migrate deploy, tek seferlik (MIGRATE_DATABASE_URL, sod_deciship_admin).
# Üretim bağımlılıklarında prisma (migrate deploy) da var.
# Bağımlılıkların kurulum betikleri package.json "allowScripts" ile onaylı (@prisma/engines, prisma, esbuild).

FROM node:24.22.1-alpine AS base
# openssl: Prisma şema motoru (migrate) libssl'e bağlı ve sürümü buradan algılar
RUN apk add --no-cache openssl
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /app

# ---------- tüm bağımlılıklar ----------
FROM base AS deps
# "file:" bağımlılıkları: npm ci hedef klasörlerin package.json'unu okur
COPY Deciship/packages/core/package.json Deciship/packages/core/
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/format/package.json Platform/packages/format/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/
COPY Deciship/apps/api/package.json Deciship/apps/api/package-lock.json Deciship/apps/api/
# "postinstall: prisma generate" şema ister; bu katmanda kaldırılır ki bağımlılık katmanı şema/kod
# değişikliklerinden bağımsız kalsın (gerçek package.json sonraki COPY ile geri gelir, generate build'de çalışır).
# Bağımlılıkların kendi kurulum betikleri (package.json "allowScripts" ile onaylı) npm ci sırasında çalışır.
RUN --mount=type=cache,target=/root/.npm \
  cd Deciship/apps/api && npm pkg delete scripts.postinstall && npm ci

# ---------- derleme ----------
FROM deps AS build
COPY Deciship/packages/core Deciship/packages/core
COPY Platform/packages/contracts Platform/packages/contracts
COPY Platform/packages/format Platform/packages/format
COPY Platform/packages/auth-kit Platform/packages/auth-kit
# Paketlerin bağımlılıkları (exceljs, papaparse, jose, contracts, format) api'dekilerle aynı: ayrı kurulum yerine bağla
RUN ln -s ../../apps/api/node_modules Deciship/packages/core/node_modules \
  && rm -rf Platform/packages/auth-kit/node_modules Platform/packages/contracts/node_modules \
  && ln -s ../../../Deciship/apps/api/node_modules Platform/packages/auth-kit/node_modules \
  && ln -s ../../../Deciship/apps/api/node_modules Platform/packages/contracts/node_modules \
  && rm -rf Platform/packages/format/node_modules \
  && ln -s ../../../Deciship/apps/api/node_modules Platform/packages/format/node_modules
COPY Deciship/apps/api Deciship/apps/api
RUN cd Deciship/apps/api && npm run build && find dist -name '*.map' -delete

# ---------- yalnız üretim bağımlılıkları ----------
FROM base AS prod-deps
COPY Deciship/packages/core/package.json Deciship/packages/core/
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/format/package.json Platform/packages/format/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/
COPY Deciship/apps/api/package.json Deciship/apps/api/package-lock.json Deciship/apps/api/
RUN --mount=type=cache,target=/root/.npm \
  cd Deciship/apps/api && npm pkg delete scripts.postinstall && npm ci --omit=dev \
  # budama: çalışma zamanında kullanılmayan dosyalar (kaynak haritaları, tip tanımları, belgeler,
  # tarayıcı paketleri, PostgreSQL dışındaki Prisma sorgu derleyicileri)
  && cd node_modules \
  && find . -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
       -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \) -delete \
  && find @prisma/client/runtime prisma/build -type f \
       \( -name '*.cockroachdb.*' -o -name '*.mysql.*' -o -name '*.sqlite.*' -o -name '*.sqlserver.*' \) -delete \
  && rm -rf exceljs/dist pdf-lib/dist pdf-lib/src pdf-lib/ts3.4 \
       pdfjs-dist/build pdfjs-dist/web pdfjs-dist/types pdfjs-dist/image_decoders \
       @anthropic-ai/sdk/src effect/src \
  # prisma CLI'nin yalnız `migrate deploy` kullanılıyor: Studio arayüzü (React), `prisma dev`in gömülü
  # Postgres'i (pglite) ve isteğe bağlı typescript eşi gereksiz. @prisma/studio-core/data ve @prisma/dev
  # CLI açılışında yüklendiği için kalır (silinirse aşağıdaki duman testi derlemeyi durdurur).
  # pdfjs yalnız metin okuyor (getTextContent): çizim için gereken canvas gereksiz; yokluğunda
  # pdfjs günlüğe bir kez "Cannot load @napi-rs/canvas" uyarısı yazar, metin okuma etkilenmez.
  && rm -rf @electric-sql typescript @typescript @napi-rs/canvas @napi-rs/canvas-* \
       @prisma/studio-core/dist/ui @prisma/studio-core/dist/metafile-*.json \
       react react-dom elkjs @visx @radix-ui

# ---------- çalışan imaj ----------
FROM base AS runtime
# PRISMA_HIDE_UPDATE_MESSAGE: açılış kaydındaki "npm i prisma@latest" kutusu hata anında yanıltmasın
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 STORAGE_DIR=/data/storage PRISMA_HIDE_UPDATE_MESSAGE=1
# REPO_ROOT işareti (src/env.ts) + örnek veri, referans kartı
COPY Deciship/SPEC.md Deciship/
COPY Deciship/samples Deciship/samples
COPY --from=prod-deps /app/Deciship/apps/api/node_modules Deciship/apps/api/node_modules
COPY Deciship/apps/api/package.json Deciship/apps/api/prisma.config.ts Deciship/apps/api/tsconfig.json Deciship/apps/api/
COPY Deciship/apps/api/prisma Deciship/apps/api/prisma
COPY Deciship/apps/api/assets Deciship/apps/api/assets
COPY --from=build /app/Deciship/apps/api/src/generated Deciship/apps/api/src/generated
COPY --from=build /app/Deciship/apps/api/dist Deciship/apps/api/dist
COPY Deciship/apps/api/scripts/file-worker-smoke.mjs Deciship/apps/api/scripts/

WORKDIR /app/Deciship/apps/api
# Duman testi: budama bir şeyi kırdıysa derleme burada durur (patronun bilgisayarında açılışta değil).
# Son adım (Mesaj 6, Y151): dosya çalışanı (dist/fileWorker.js) havuzdaki gibi ayrı çocuk süreçte açılır; küçük bir CSV,
# örnek tarife Excel'i ve örnek PDF okur, PDF'ten sayfa keser (papaparse, exceljs, pdfjs-dist/legacy, pdf-lib çocukta yüklenir).
RUN npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /dev/null \
  && node -e "Promise.all(['pdfjs-dist/legacy/build/pdf.mjs','pdfmake','exceljs','pdf-lib','jose','@anthropic-ai/sdk'].map((m)=>import(m))).catch((e)=>{console.error(e);process.exit(1)})" \
  && node scripts/file-worker-smoke.mjs
# Süper kullanıcı değil. Adlı hacim bu sahipliği ilk açılışta devralır.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000
# Migration burada çalışmaz: ayrı kap, ayrı rol (deciship-migrate).
CMD ["node", "dist/main.js"]
