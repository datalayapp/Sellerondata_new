# TagPress web imajı (platform yapısı). Derleme bağlamı: SellerOnData/ kökü (Platform ARCHITECTURE §2).
#   docker build -f Tagpress/apps/web/Dockerfile .      Dosya listesi: Dockerfile.dockerignore
# Platform yapısı (VITE_TAGPRESS_PLATFORM=1, `build:platform`): taban /tagpress/, API /api/tagpress, ortak kabuk.
# Bağımlılık katmanı yalnız package.json/kilit değişince yeniden kurulur; pnpm deposu derlemeler arasında korunur.
FROM node:24.22.1-alpine AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable pnpm
WORKDIR /repo
# Ortak paketler `link:` ile kaynağından okunur (shell, contracts, format); React ve i18next kopyası TagPress'inkidir
# (apps/web/platform-peers.ts Vite eklentisi: platform paketlerinin react, i18next, contracts ve format içe aktarmalarını TagPress kopyalarına yönlendirir). Kurulumda klasörlerin var olması yeter.
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/format/package.json Platform/packages/format/
COPY Platform/packages/shell/package.json Platform/packages/shell/
COPY Platform/packages/auth-kit/package.json Platform/packages/auth-kit/
COPY Platform/packages/product-kit/package.json Platform/packages/product-kit/
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
RUN --mount=type=cache,target=/pnpm/store \
  cd Tagpress && pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY Platform/packages/contracts/src Platform/packages/contracts/src
COPY Platform/packages/format/src Platform/packages/format/src
COPY Platform/packages/shell/src Platform/packages/shell/src
COPY Tagpress Tagpress
RUN cd Tagpress && pnpm --filter @tagpress/web build:platform

FROM nginx:1.29-alpine
# Erişim günlüğü biçimi gateway ile ortak (jetonlu yollar maskeli, Referer yok): default.conf'tan önce yüklenir.
COPY Platform/gateway/conf/access-log.conf /etc/nginx/conf.d/00-access-log.conf
COPY Tagpress/apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# Vite çıktısı düzdür; adresler `/tagpress/` önekiyle üretilir, dosyalar da o altta durur.
COPY --from=build /repo/Tagpress/apps/web/dist /usr/share/nginx/html/tagpress
EXPOSE 80
