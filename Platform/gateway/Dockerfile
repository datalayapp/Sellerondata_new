# SellerOnData gateway: tek köken altında yol yönlendirme, güvenlik başlıkları, internal engeli.
FROM nginx:1.29-alpine
# envsubst şablonu (gerçek istemci IP'si için güvenilen vekil), açılışta conf.d/ altına yazılır
COPY templates/ /etc/nginx/templates/
# Erişim günlüğü biçimi (jeton maskesi): default.conf'tan önce yüklenir. hub-web ve deciship-web de aynı dosyayı alır.
COPY conf/access-log.conf /etc/nginx/conf.d/00-access-log.conf
# Metin yanıtları gzip (JSON, JS, CSS, SVG, HTML); Hesap API'si hariç (default.conf). http düzeyinde, default.conf'tan önce.
COPY conf/gzip.conf /etc/nginx/conf.d/05-gzip.conf
COPY conf/default.conf /etc/nginx/conf.d/default.conf
COPY conf/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY conf/proxy.conf /etc/nginx/snippets/proxy.conf
# Araç blokları kayıttan üretilir (Platform/scripts/products-gen.mjs); default.conf bunları include eder
COPY conf/products/ /etc/nginx/snippets/products/
# Sınır şablonları (20-limits.conf, api-limits.inc) açılışta bu değerlerle yazılır: IP başına hız sınırı.
# Kimlik kovası (giriş, kayıt, şifre sıfırlama, kod doğrulama, davet): dakikada 30, birikme 30. Depo Wi-Fi'ındaki telefonlar
# tek IP'den gelir; vardiya başında 30 kişi aynı anda girebilsin diye birikme geniş. Ölçüm gönderimi bu kovaya sayılmaz.
# Yükleme kovası (multipart: ölçüm, canlı tartı/işaret okuma, dosya): dakikada 600, birikme 300. Kaba katmandır: DeciShip API'nin
# kişi ve firma başına sınırının (yükleme 60/300, okuma 60/240 dk) üstünde durur; depodaki telefonların tek IP'si onu doldurmaz.
ENV GATEWAY_REAL_IP_FROM=127.0.0.1     GATEWAY_API_RATE=30r/s     GATEWAY_API_BURST=200     GATEWAY_UPLOAD_RATE=600r/m     GATEWAY_UPLOAD_BURST=300     GATEWAY_AUTH_RATE=30r/m     GATEWAY_AUTH_BURST=30     GATEWAY_CONN_PER_IP=100
# Bağlantı tavanı işçi başına 1024'ten 4096'ya: vekil isteği iki bağlantı tutar (istemci + yukarı akış). IP başına sınırla
# (conn-limit.inc) birlikte birkaç yavaş istemci tavanı dolduramaz. Satır imajda yoksa derleme durur (sessizce 1024 kalmasın).
RUN sed -i 's/^\(\s*\)worker_connections\s\+1024;/\1worker_connections 4096;/' /etc/nginx/nginx.conf \
  && grep -qE '^\s*worker_connections 4096;' /etc/nginx/nginx.conf
EXPOSE 80
# Açılışta 2 sn'de bir (ilk başarıda sağlıklı), sonra 15 sn; 3 ardışık hata sağlıksız (docker-compose.yml başındaki kural).
HEALTHCHECK --interval=15s --timeout=3s --retries=3 --start-period=30s --start-interval=2s \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
