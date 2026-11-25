# Derleme bağlamı: SellerOnData/ kökü (ARCHITECTURE §2). Platform compose: context "..", dockerfile "Deciship/apps/web/Dockerfile".
# Bağımlılık katmanları yalnız package.json/lock değişince yeniden kurulur; npm önbelleği derlemeler arasında korunur.
FROM node:24.22.1-alpine AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /repo
COPY Platform/packages/format/package.json Platform/packages/format/
COPY Deciship/packages/core/package.json Deciship/packages/core/package-lock.json Deciship/packages/core/
RUN --mount=type=cache,target=/root/.npm \
  cd Deciship/packages/core && npm ci --omit=dev
# Ortak paketler `file:` ile bağlanır; npm kurarken package.json dosyalarını okur.
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/shell/package.json Platform/packages/shell/
COPY Deciship/apps/web/package.json Deciship/apps/web/package-lock.json Deciship/apps/web/
RUN --mount=type=cache,target=/root/.npm \
  cd Deciship/apps/web && npm ci
COPY Platform/packages/contracts Platform/packages/contracts
COPY Platform/packages/format Platform/packages/format
COPY Platform/packages/shell Platform/packages/shell
COPY Deciship/packages/core Deciship/packages/core
COPY Deciship/apps/web Deciship/apps/web
RUN cd Deciship/apps/web && npm run build

FROM nginx:1.29-alpine
# Erişim günlüğü biçimi gateway ile ortak (jetonlu yollar maskeli, Referer yok): default.conf'tan önce yüklenir.
COPY Platform/gateway/conf/access-log.conf /etc/nginx/conf.d/00-access-log.conf
COPY Deciship/apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# Vite çıktısı düzdür; adresler `/deciship/` önekiyle üretilir, dosyalar da o altta durur.
COPY --from=build /repo/Deciship/apps/web/dist /usr/share/nginx/html/deciship
EXPOSE 80
