# Statik site: derle, nginx ile sun.
FROM node:24.22.1-alpine AS build
WORKDIR /app
ARG APP_URL=https://app.sellerondata.com
ARG SITE_URL=https://sellerondata.com
# Kapalı deneme (2026-11-12): invite iken "Hesap aç" yerine "Erken erişim isteyin" (destek postası). İmaj varsayılanı invite:
# argümansız üretim derlemesi yanlışlıkla açık kayıtlı site çıkarmasın. Yerel compose açıkça open verir (docker-compose.yml).
ARG SIGNUP_MODE=invite
ENV APP_URL=$APP_URL SITE_URL=$SITE_URL SIGNUP_MODE=$SIGNUP_MODE
COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY nginx.conf ./nginx.conf
# CSP connect-src uygulama kökenini içerir (site.js oturum yoklaması): nginx.conf derlemede APP_URL ile yazılır.
RUN SITE_NGINX_OUT=/app/nginx.default.conf node scripts/build.mjs

FROM nginx:1.27-alpine
COPY --from=build /app/nginx.default.conf /etc/nginx/conf.d/default.conf
# İmajın varsayılan sayfaları (index.html, 50x.html) kalmasın: yalnız bu sitenin derlemesi sunulur.
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
