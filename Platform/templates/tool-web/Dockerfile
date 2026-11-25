# Araç şablonu (Platform/templates/tool-web/README.md). Karşılığı: Deciship/apps/web/Dockerfile.
# Derleme bağlamı: SellerOnData/ kökü (ARCHITECTURE §2). Platform compose: context "..", dockerfile "Ornekarac/apps/web/Dockerfile".
# Bağımlılık katmanları yalnız package.json/lock değişince yeniden kurulur; npm önbelleği derlemeler arasında korunur.
FROM node:24.22.1-alpine AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /repo
# Ortak paketler `file:` ile bağlanır; npm kurarken package.json dosyalarını okur.
COPY Platform/packages/contracts/package.json Platform/packages/contracts/
COPY Platform/packages/format/package.json Platform/packages/format/
COPY Platform/packages/shell/package.json Platform/packages/shell/
COPY Ornekarac/apps/web/package.json Ornekarac/apps/web/package-lock.json Ornekarac/apps/web/
RUN --mount=type=cache,target=/root/.npm \
  cd Ornekarac/apps/web && npm ci
COPY Platform/packages/contracts Platform/packages/contracts
COPY Platform/packages/format Platform/packages/format
COPY Platform/packages/shell Platform/packages/shell
COPY Ornekarac/apps/web Ornekarac/apps/web
RUN cd Ornekarac/apps/web && npm run build

FROM nginx:1.29-alpine
# Erişim günlüğü biçimi gateway ile ortak (jetonlu yollar maskeli, Referer yok): default.conf'tan önce yüklenir.
COPY Platform/gateway/conf/access-log.conf /etc/nginx/conf.d/00-access-log.conf
COPY Ornekarac/apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# Vite çıktısı düzdür; adresler `/ornekarac/` önekiyle üretilir, dosyalar da o altta durur.
COPY --from=build /repo/Ornekarac/apps/web/dist /usr/share/nginx/html/ornekarac
EXPOSE 80
