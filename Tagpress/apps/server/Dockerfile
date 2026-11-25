# TagPress API imajı. Derleme bağlamı: SellerOnData/ kökü (Platform ARCHITECTURE §2). Dosya listesi: Dockerfile.dockerignore
#   docker build -f Tagpress/apps/server/Dockerfile .
#
# Aynı imaj üç kapta çalışır (Platform/docker-compose.yml):
#   tagpress-api      node --import tsx src/main.ts            (sod_tagpress, platform kipi). Göç parolası bu kapta yoktur.
#   tagpress-migrate  node --import tsx src/bin/migrate-pg.ts  tek seferlik (MIGRATE_DATABASE_URL, sod_tagpress_admin).
#   tagpress-aktar    node --import tsx src/bin/aktar-pg.ts    yalnız elle (profil tools), yerel veriyi bir firmaya aktarır.
# Sunucu TypeScript kaynağından tsx ile koşar: derleme adımı yok, kaynak ağacı (göç .sql dosyaları, assets/varsayilan,
# typeset/fonts, baskı ön ayarları) imajda bugünkü yerinde durur ve dosyalar kendi konumlarına göre bulunur.
#
# Katmanlar: Platform paketlerinin bağımlılıkları ve TagPress çalışma alanının kilidi yalnız package.json/kilit değişince yeniden
# kurulur. Platform paketleri `link:` ile bağlıdır (plan §2.4): kaynakları yerinde okunur, kendi bağımlılıkları (auth-kit: jose)
# kendi node_modules'larından (npm ci) gelir; pg ve fastify yalnız tip olarak alınır, çalışma anında TagPress'inkiler kullanılır.
FROM node:24.22.1-alpine AS base
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
# pnpm sürümü Tagpress/package.json "packageManager" alanından (corepack).
RUN corepack enable pnpm
WORKDIR /app

# ---------- bağımlılıklar ----------
FROM base AS deps
COPY Platform/packages/contracts/package.json Platform/packages/contracts/package-lock.json Platform/packages/contracts/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/package-lock.json Platform/packages/auth-kit/
COPY Platform/packages/product-kit/package.json Platform/packages/product-kit/package-lock.json Platform/packages/product-kit/
RUN --mount=type=cache,target=/root/.npm \
  cd Platform/packages/auth-kit && npm ci --omit=dev \
  && cd ../product-kit && npm ci --omit=dev
# Çalışma alanının bütün paketlerinin package.json'u: kilit (--frozen-lockfile) hepsini bekler.
COPY Tagpress/package.json Tagpress/pnpm-lock.yaml Tagpress/pnpm-workspace.yaml Tagpress/
COPY Tagpress/apps/server/package.json Tagpress/apps/server/
COPY Tagpress/apps/web/package.json Tagpress/apps/web/
COPY Tagpress/apps/mcp/package.json Tagpress/apps/mcp/
COPY Tagpress/packages/ai/package.json Tagpress/packages/ai/
COPY Tagpress/packages/domain/package.json Tagpress/packages/domain/
COPY Tagpress/packages/engine/package.json Tagpress/packages/engine/
COPY Tagpress/packages/learn/package.json Tagpress/packages/learn/
COPY Tagpress/packages/print/package.json Tagpress/packages/print/
COPY Tagpress/packages/templates/package.json Tagpress/packages/templates/
COPY Tagpress/packages/typeset/package.json Tagpress/packages/typeset/
# Bütün bağımlılıklar: tsx (kök geliştirme bağımlılığı) çalışma anında gerekir. Kurulum betikleri pnpm-workspace.yaml
# "allowBuilds" ile onaylı (sharp, esbuild).
RUN --mount=type=cache,target=/pnpm/store \
  cd Tagpress && pnpm install --frozen-lockfile --store-dir /pnpm/store

# ---------- çalışan imaj ----------
FROM deps AS runtime
COPY Platform/packages/contracts Platform/packages/contracts
COPY Platform/packages/auth-kit Platform/packages/auth-kit
COPY Platform/packages/product-kit Platform/packages/product-kit
COPY Tagpress Tagpress
ENV NODE_ENV=production TAGPRESS_AUTH=platform PORT=4200 TAGPRESS_DATA_DIR=/data/tagpress
WORKDIR /app/Tagpress/apps/server
# Duman testi: tsx, platform paketleri, yerel modüller (sharp, node:sqlite) ve göç klasörü yükleniyor mu; kırık imaj derlemede durur.
RUN node --import tsx -e "Promise.all(['@sellerondata/auth-kit','@sellerondata/product-kit','@sellerondata/contracts','pg','sharp','fastify','node:sqlite'].map((m)=>import(m))).catch((e)=>{console.error(e);process.exit(1)})" \
  && node --import tsx -e "import('./src/db/pg/migrate.ts').then((m)=>{if(!m.readPgMigrations().length)throw new Error('göç yok')}).catch((e)=>{console.error(e);process.exit(1)})"
# Süper kullanıcı değil. Adlı hacim bu sahipliği ilk açılışta devralır. tsx dönüşüm önbelleği /tmp altında.
RUN mkdir -p /data/tagpress && chown -R node:node /data
USER node
EXPOSE 4200
# Göç burada çalışmaz: ayrı kap, ayrı rol (tagpress-migrate).
CMD ["node", "--import", "tsx", "src/main.ts"]
