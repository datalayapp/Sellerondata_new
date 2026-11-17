# Derleme bağlamı: SellerOnData kökü (ARCHITECTURE §2).
#   docker build -f Platform/apps/hub-web/Dockerfile .
# Bağımlılık katmanı yalnız package.json/lock değişince yeniden kurulur. VITE_MOCK burada verilmez: mock üretime girmez.
FROM node:24.22.1-alpine AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /repo/Platform
COPY Platform/packages/contracts/package.json packages/contracts/
COPY Platform/packages/format/package.json packages/format/
COPY Platform/packages/shell/package.json packages/shell/
COPY Platform/apps/hub-web/package.json Platform/apps/hub-web/package-lock.json apps/hub-web/
RUN --mount=type=cache,target=/root/.npm \
  cd apps/hub-web && npm ci
COPY Platform/packages/contracts/src packages/contracts/src
COPY Platform/packages/format/src packages/format/src
COPY Platform/packages/shell/src packages/shell/src
COPY Platform/apps/hub-web apps/hub-web
ARG VITE_ANDROID_APK_URL=
ENV VITE_ANDROID_APK_URL=$VITE_ANDROID_APK_URL
# Tanıtım sitesinin kökü: hesap alanının üst çubuğu ve altbilgisi buraya bağlanır.
ARG VITE_SITE_URL=http://localhost:8089
ENV VITE_SITE_URL=$VITE_SITE_URL
RUN cd apps/hub-web && npm run build

FROM nginx:1.29-alpine
# Erişim günlüğü biçimi gateway ile ortak (jetonlu yollar maskeli, Referer yok): default.conf'tan önce yüklenir.
COPY Platform/gateway/conf/access-log.conf /etc/nginx/conf.d/00-access-log.conf
COPY Platform/apps/hub-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/Platform/apps/hub-web/dist /usr/share/nginx/html
EXPOSE 80
