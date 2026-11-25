#!/usr/bin/env bash
# Gateway yönlendirme testi: gateway imajını derler, sahte yukarı akışlarla ağ kurar, curl ile her satırı sınar.
# Kullanım: bash gateway/test/run.sh   (Docker gerekir)
set -u
cd "$(dirname "$0")/.."
HERE=$(pwd -W 2>/dev/null || pwd)
T=test/.tmp; mkdir -p $T
NET=sod-gw-test
PASS=0; FAIL=0
cleanup() { docker rm -f gw-under-test gw-trusted gw-limited gw-upload gw-auth gw-conn gw-fake-account-api gw-fake-deciship-api gw-fake-deciship-web gw-fake-hub-web gw-fake-tagpress-api gw-fake-tagpress-web gw-fake-ai-api >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
docker network create $NET >/dev/null
docker build -q -t sod-gateway-test . >/dev/null || { echo "gateway derlenemedi"; exit 1; }
for n in account-api deciship-api deciship-web hub-web tagpress-api tagpress-web ai-api; do
  docker run -d --name gw-fake-$n --network $NET --network-alias $n \
    -e BACKEND_NAME=$n -v "$HERE/test/fake-backend.conf:/etc/nginx/templates/default.conf.template:ro" nginx:1.29-alpine >/dev/null
done
docker run -d --name gw-under-test --network $NET -p 18088:80 sod-gateway-test >/dev/null
# Güvenilen vekil senaryosu: tüm eşler güvenilir sayılır (X-Forwarded-For ve X-Forwarded-Proto okunur). Kimlik kovası dar:
# istemci başına sayıldığı sınanır ("gerçek IP").
docker run -d --name gw-trusted --network $NET -e GATEWAY_REAL_IP_FROM=0.0.0.0/0 -e GATEWAY_AUTH_RATE=1r/m -e GATEWAY_AUTH_BURST=1 -p 18089:80 sod-gateway-test >/dev/null
# Hız sınırı senaryoları: düşük oranlı iki kap. gw-limited genel /api/ kovasını, gw-upload yükleme kovasını sınar.
# Oran dakikada 1: kova bölüm boyunca dolu kalır (saniyede 2 iken yavaş makinede arada yer açılıp 429 denetimleri rastgele düşüyordu).
docker run -d --name gw-limited --network $NET -e GATEWAY_API_RATE=1r/m -e GATEWAY_API_BURST=2 -p 18090:80 sod-gateway-test >/dev/null
docker run -d --name gw-upload --network $NET -e GATEWAY_API_RATE=100r/s -e GATEWAY_API_BURST=1000 -e GATEWAY_UPLOAD_RATE=1r/m -e GATEWAY_UPLOAD_BURST=1 -p 18091:80 sod-gateway-test >/dev/null
# Kimlik kovası: 1r/m, burst 2; genel ve yükleme kovaları geniş (yalnız kimlik kovası dolsun).
docker run -d --name gw-auth --network $NET -e GATEWAY_API_RATE=100r/s -e GATEWAY_API_BURST=1000 -e GATEWAY_UPLOAD_RATE=600r/m -e GATEWAY_UPLOAD_BURST=600 -e GATEWAY_AUTH_RATE=1r/m -e GATEWAY_AUTH_BURST=2 -p 18092:80 sod-gateway-test >/dev/null
# Bağlantı sınırı: IP başına aynı anda 2 istek (yavaş gövde web yollarında da sayılır).
docker run -d --name gw-conn --network $NET -e GATEWAY_CONN_PER_IP=2 -p 18093:80 sod-gateway-test >/dev/null
for i in $(seq 1 30); do curl -sf http://localhost:18088/healthz >/dev/null && curl -sf http://localhost:18089/healthz >/dev/null && curl -sf http://localhost:18090/healthz >/dev/null && curl -sf http://localhost:18091/healthz >/dev/null && curl -sf http://localhost:18092/healthz >/dev/null && curl -sf http://localhost:18093/healthz >/dev/null && break; sleep 1; done

B=http://localhost:18088
check() { # ad, beklenen kod, beklenen gövde parçası (boş olabilir), curl argümanları...
  local name=$1 code=$2 body=$3; shift 3
  local out; out=$(curl -s -o $T/gw-body -w '%{http_code}' "$@")
  if [ "$out" = "$code" ] && grep -qF -- "$body" $T/gw-body; then PASS=$((PASS+1)); echo "ok   $name -> $out"
  else FAIL=$((FAIL+1)); echo "FAIL $name -> $out (beklenen $code '$body'): $(head -c 160 $T/gw-body)"; fi
}
hdr() { # ad, url, başlık (regex), curl argümanları...
  local name=$1 url=$2 re=$3; shift 3
  if curl -s -D - -o /dev/null "$@" "$url" | tr -d '\r' | grep -qiE -- "$re"; then PASS=$((PASS+1)); echo "ok   $name"
  else FAIL=$((FAIL+1)); echo "FAIL $name (yok: $re)"; fi
}
nohdr() {
  local name=$1 url=$2 re=$3; shift 3
  if curl -s -D - -o /dev/null "$@" "$url" | tr -d '\r' | grep -qiE -- "$re"; then FAIL=$((FAIL+1)); echo "FAIL $name (var: $re)"
  else PASS=$((PASS+1)); echo "ok   $name"; fi
}

echo "== yönlendirme =="
out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/); [ "$out" = "302 " ] || [ "${out%% *}" = 302 ] && { PASS=$((PASS+1)); echo "ok   / -> $out"; } || { FAIL=$((FAIL+1)); echo "FAIL / -> $out"; }
hdr "/ Location /home" $B/ '^location: /home'
for p in /home /analytics /analytics/deciship /analytics/tagpress /data /data/deciship/invoices /data/tagpress/jobs /activity /account/profile /account/team /account/tool-access/tagpress /login /register /join /invite/abc /forgot-password /reset-password/abc /verify-email/abc /orderloom /orderloom/x /tagpressx /favicon.svg /assets/index-abc.js /bilinmeyen; do
  check "hub-web $p" 200 "hub-web uri=$p" $B$p
done
check "deciship /deciship/ önek korunur" 200 "deciship-web uri=/deciship/ " $B/deciship/
check "deciship /deciship/measurements" 200 "deciship-web uri=/deciship/measurements" $B/deciship/measurements
check "deciship /deciship/invoices?x=1 sorgu korunur" 200 "deciship-web uri=/deciship/invoices?x=1" "$B/deciship/invoices?x=1"
check "deciship /deciship/tariffs" 200 "deciship-web uri=/deciship/tariffs" $B/deciship/tariffs
check "deciship /deciship/settings" 200 "deciship-web uri=/deciship/settings" $B/deciship/settings
check "deciship /deciship/setup" 200 "deciship-web uri=/deciship/setup" $B/deciship/setup
check "deciship /deciship/assets/a.js" 200 "deciship-web uri=/deciship/assets/a.js" $B/deciship/assets/a.js
out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/deciship); echo "     /deciship -> $out"; [ "${out%% *}" = 301 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
# TagPress: web /tagpress/ önekiyle (hash rotaları istemcide), API /api/tagpress/ önekiyle; önek olduğu gibi geçer
# (API iç yola kendisi çevirir: rewriteUrl).
check "tagpress /tagpress/ önek korunur" 200 "tagpress-web uri=/tagpress/ " $B/tagpress/
check "tagpress /tagpress/index.html" 200 "tagpress-web uri=/tagpress/index.html" $B/tagpress/index.html
check "tagpress /tagpress/assets/a.js" 200 "tagpress-web uri=/tagpress/assets/a.js" $B/tagpress/assets/a.js
out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/tagpress); echo "     /tagpress -> $out"; [ "${out%% *}" = 301 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
hdr "/tagpress Location /tagpress/" $B/tagpress '^location: (http://[^/]+)?/tagpress/$'
check "tagpress api /api/tagpress/health" 200 "tagpress-api uri=/api/tagpress/health" $B/api/tagpress/health
check "tagpress api sorgu korunur" 200 "tagpress-api uri=/api/tagpress/jobs?durum=bekliyor" "$B/api/tagpress/jobs?durum=bekliyor"
check "tagpress Merkez ucu" 200 "tagpress-api uri=/api/tagpress/platform/overview" $B/api/tagpress/platform/overview
# Yapay zekâ geçidi: yalnız Merkez uçları (harcama, yönetici) ve sağlık; önek olduğu gibi geçer.
check "ai /api/ai/health" 200 "ai-api uri=/api/ai/health" $B/api/ai/health
check "ai harcama özeti" 200 "ai-api uri=/api/ai/spend/summary?days=30" "$B/api/ai/spend/summary?days=30"
check "ai harcama dışa aktarımı" 200 "ai-api uri=/api/ai/spend/calls/export" $B/api/ai/spend/calls/export
check "ai yönetici anahtarları" 200 "ai-api uri=/api/ai/admin/keys" -X POST -H 'Content-Type: application/json' -d '{}' $B/api/ai/admin/keys
check "ai öneki: /api/aix başka yer" 404 NOT_FOUND $B/api/aix
check "account /api/account/health" 200 "account-api uri=/api/account/health" $B/api/account/health
check "account jwks" 200 "account-api uri=/api/account/.well-known/jwks.json" $B/api/account/.well-known/jwks.json
check "deciship api /api/deciship/health" 200 "deciship-api uri=/api/deciship/health" $B/api/deciship/health
check "tanımsız /api/x" 404 NOT_FOUND $B/api/x

echo "== internal her zaman 404 =="
for p in /api/deciship/internal/events /api/account/internal/x /api/account/internal/notify /api/deciship/internal /INTERNAL/x /api/deciship/Internal/events /api/deciship/%69nternal/events /api/deciship/%2e/internal/events /api//deciship/internal/events /deciship/internal/x /internal/x /home/internal/ /api/deciship/a/../internal/events /api/deciship/internal%2Fevents /api/tagpress/internal/events /api/tagpress/Internal/events /api/tagpress/%69nternal/events /tagpress/internal/x /api/ai/internal/events /api/ai/internal/anthropic/v1/messages /api/ai/internal/status /api/ai/INTERNAL/status /api/ai/%69nternal/status /api/ai/spend/../internal/status /api//ai/internal/status /api/ai/internal%2Fstatus; do
  check "404 $p" 404 NOT_FOUND --path-as-is "$B$p"
done
check "POST internal" 404 NOT_FOUND -X POST -d '{}' $B/api/deciship/internal/events
check "POST ai vekil dışarıdan kapalı" 404 NOT_FOUND -X POST -H 'x-api-key: x' -d '{}' $B/api/ai/internal/anthropic/v1/messages
check "POST ai olay alıcısı dışarıdan kapalı" 404 NOT_FOUND -X POST -d '{}' $B/api/ai/internal/events
check "internal yine de aranabilir 'internals' geçer mi (kelime sınırı)" 200 "deciship-api" $B/api/deciship/internals

echo "== başlıklar =="
for u in /home /api/deciship/health /deciship/measurements /assets/a.js /api/x /tagpress/ /api/tagpress/health /api/ai/health /api/ai/spend/summary; do
  hdr "CSP $u" $B$u "^content-security-policy: default-src 'self'; .*frame-ancestors 'none'"
  hdr "nosniff $u" $B$u '^x-content-type-options: nosniff'
  hdr "referrer $u" $B$u '^referrer-policy: strict-origin-when-cross-origin'
  hdr "xfo $u" $B$u '^x-frame-options: DENY'
  nohdr "yukarı akış CSP sızmadı $u" $B$u "default-src \*"
  nohdr "HSTS yok (http) $u" $B$u '^strict-transport-security'
done
nohdr "HSTS güvenilmeyen istemcinin X-Forwarded-Proto'su ile açılmaz" $B/home '^strict-transport-security' -H 'X-Forwarded-Proto: https'
hdr "HSTS güvenilen vekil arkasında" http://localhost:18089/home '^strict-transport-security: max-age=86400; includeSubDomains$' -H 'X-Forwarded-Proto: https'
n=$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' http://localhost:18089/api/deciship/health | tr -d '\r' | grep -ciE '^strict-transport-security:'); [ "$n" = 1 ] && { PASS=$((PASS+1)); echo "ok   tek HSTS başlığı"; } || { FAIL=$((FAIL+1)); echo "FAIL $n HSTS başlığı"; }
nohdr "HSTS güvenilen vekil http bildirirse yok" http://localhost:18089/home '^strict-transport-security' -H 'X-Forwarded-Proto: http'
hdr "HTML no-cache /home" $B/home '^cache-control: no-cache$'
nohdr "HTML max-age yok" $B/home 'max-age'
hdr "hub varlık immutable" $B/assets/a.js '^cache-control: public, max-age=31536000, immutable'
hdr "deciship varlık immutable" $B/deciship/assets/a.js '^cache-control: public, max-age=31536000, immutable'
hdr "deciship HTML no-cache" $B/deciship/ '^cache-control: no-cache$'
hdr "tagpress varlık immutable" $B/tagpress/assets/a.js '^cache-control: public, max-age=31536000, immutable'
hdr "tagpress HTML no-cache" $B/tagpress/ '^cache-control: no-cache$'
# Olay akışı: yukarı akışın X-Accel-Buffering: no başlığını gateway işler (tamponsuz aktarım), istemciye geçirmez; akış sıkıştırılmaz.
check "tagpress SSE yukarı akışa gider" 200 "tagpress-api data: sse" -H 'Accept: text/event-stream' $B/api/tagpress/events
hdr "tagpress SSE türü" $B/api/tagpress/events '^content-type: text/event-stream'
nohdr "tagpress SSE X-Accel-Buffering istemciye geçmez" $B/api/tagpress/events '^x-accel-buffering:'
nohdr "tagpress SSE sıkıştırılmaz" $B/api/tagpress/events '^content-encoding:' -H 'Accept-Encoding: gzip'
nohdr "server sürümü gizli" $B/home '^server: nginx/'
# Jetonlu sayfa hiç Referer göndermez (jeton üçüncü tarafa ya da sonraki isteklerin günlüğüne geçmesin); tek başlık.
for p in /reset-password/abc /invite/abc /verify-email/abc /Reset-Password/abc; do
  hdr "referrer no-referrer $p" $B$p '^referrer-policy: no-referrer$'
  n=$(curl -s -D - -o /dev/null "$B$p" | tr -d '\r' | grep -ciE '^referrer-policy:'); [ "$n" = 1 ] && { PASS=$((PASS+1)); echo "ok   tek referrer-policy $p"; } || { FAIL=$((FAIL+1)); echo "FAIL $p: $n referrer-policy başlığı"; }
done
hdr "yukarı akışın daha sıkı politikası geçer" "$B/api/deciship/files/x?rp=no-referrer" '^referrer-policy: no-referrer$'
hdr "yukarı akışın gevşek politikası geçmez" "$B/home?rp=unsafe-url" '^referrer-policy: strict-origin-when-cross-origin$'

echo "== X-Forwarded / gerçek IP =="
check "sahte XFF ezilir" 200 "xff=" -H 'X-Forwarded-For: 6.6.6.6' $B/api/account/health
if curl -s -H 'X-Forwarded-For: 6.6.6.6' $B/api/account/health | grep -q 'xff=6.6.6.6'; then FAIL=$((FAIL+1)); echo "FAIL sahte XFF aktarıldı"; else PASS=$((PASS+1)); echo "ok   sahte XFF aktarılmadı"; fi
check "X-Forwarded-Proto" 200 "xfp=http" $B/api/account/health
check "sahte X-Forwarded-Proto ezilir (güvenilmeyen)" 200 "xfp=http" -H 'X-Forwarded-Proto: https' $B/api/account/health
check "X-Forwarded-Proto güvenilen vekilden aktarılır" 200 "xfp=https" -H 'X-Forwarded-Proto: https' http://localhost:18089/api/account/health
check "Host korunur" 200 "host=localhost:18088" $B/api/account/health
# Güvenilen vekil (üretimde Caddy) arkasında: vekilin yazdığı istemci adresi yukarı akışa, günlüğe ve hız sınırına geçer.
TR=http://localhost:18089
check "güvenilen vekilin X-Forwarded-For'u istemci adresi olur" 200 "xff=203.0.113.7 xri=203.0.113.7 " -H 'X-Forwarded-For: 203.0.113.7' $TR/api/account/health
check "Host vekil arkasında da korunur (dosya bağlantısının adresi)" 200 "host=app.example.test " -H 'Host: app.example.test' -H 'X-Forwarded-Proto: https' $TR/api/deciship/health
sleep 1
if docker logs gw-trusted 2>/dev/null | grep -q '^203\.0\.113\.7 '; then PASS=$((PASS+1)); echo "ok   günlükte istemci adresi"; else FAIL=$((FAIL+1)); echo "FAIL günlükte istemci adresi yok: $(docker logs gw-trusted 2>/dev/null | tail -1 | cut -c1-120)"; fi
# gw-trusted kimlik kovası 1r/m, birikme 1: aynı istemci üçüncü denemede 429, başka istemci (başka X-Forwarded-For) etkilenmez.
c=""; for i in 1 2 3; do c="$c $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Forwarded-For: 198.51.100.1' -d '{}' $TR/api/account/auth/login)"; done
[ "$c" = " 200 200 429" ] && { PASS=$((PASS+1)); echo "ok   kova istemci başına (A):$c"; } || { FAIL=$((FAIL+1)); echo "FAIL kova istemci başına (A):$c (beklenen 200 200 429)"; }
check "başka istemci aynı vekilden geçer (B)" 200 account-api -X POST -H 'X-Forwarded-For: 198.51.100.2' -d '{}' $TR/api/account/auth/login

echo "== gövde sınırı =="
head -c $((10*1024*1024)) /dev/zero > $T/gw-10m; head -c $((60*1024*1024)) /dev/zero > $T/gw-60m; head -c $((2*1024*1024)) /dev/zero > $T/gw-2m
check "deciship 10 MB" 200 deciship-api -X POST --data-binary @$T/gw-10m $B/api/deciship/invoices
check "deciship 60 MB reddedilir" 413 "" -X POST --data-binary @$T/gw-60m $B/api/deciship/invoices
check "tagpress 10 MB (referans, şablon görseli)" 200 tagpress-api -X POST --data-binary @$T/gw-10m $B/api/tagpress/references
check "tagpress 60 MB reddedilir (sınır 50 MB)" 413 "" -X POST --data-binary @$T/gw-60m $B/api/tagpress/references
check "account 2 MB reddedilir" 413 "" -X POST --data-binary @$T/gw-2m $B/api/account/auth/login

echo "== günlükte jeton yok =="
logcheck() { # ad: gateway günlüğünde GIZLIJETON geçmemeli
  sleep 1
  if docker logs gw-under-test 2>&1 | grep -q GIZLIJETON; then FAIL=$((FAIL+1)); echo "FAIL $1: $(docker logs gw-under-test 2>&1 | grep GIZLIJETON | head -1 | cut -c1-160)"
  else PASS=$((PASS+1)); echo "ok   $1"; fi
}
curl -s -o /dev/null $B/reset-password/GIZLIJETON1
curl -s -o /dev/null $B/invite/GIZLIJETON2
curl -s -o /dev/null $B/verify-email/GIZLIJETON3
curl -s -o /dev/null $B/api/account/invites/GIZLIJETON4
curl -s -o /dev/null -X POST $B/api/account/invites/GIZLIJETON5/accept
curl -s -o /dev/null -H 'Referer: http://localhost:18088/invite/GIZLIJETON6' $B/home
curl -s -o /dev/null $B/RESET-PASSWORD/GIZLIJETON8
curl -s -o /dev/null --path-as-is $B//verify-email/GIZLIJETON9
logcheck "erişim günlüğünde bağlantı jetonu yok"
if docker logs gw-under-test 2>&1 | grep -qF '/invite/[gizli]'; then PASS=$((PASS+1)); echo "ok   istek yine günlükte, jeton gizli"; else FAIL=$((FAIL+1)); echo "FAIL gizlenmiş istek günlükte yok"; fi

echo "== sıkıştırma =="
# Sahte yukarı akış /gz/ altında uzantıya göre türü verilmiş uzun gövde döner (fake-backend.conf).
GZ='Accept-Encoding: gzip'
for u in /gz/a.js /gz/a.css /gz/a.svg /gz/a.html /assets/gz/a.js /deciship/gz/a.html /deciship/assets/gz/a.css /api/deciship/gz/a.json /api/deciship/gz/a.csv /api/deciship/gz/a.txt; do
  hdr "gzip $u" $B$u '^content-encoding: gzip' -H "$GZ"
done
hdr "gzip Vary: Accept-Encoding" $B/api/deciship/gz/a.json '^vary: accept-encoding' -H "$GZ"
hdr "gzip yanıtta güvenlik başlığı" $B/api/deciship/gz/a.json "^content-security-policy: default-src 'self'" -H "$GZ"
if curl -s --compressed $B/api/deciship/gz/a.json | grep -q '^deciship-api sikistirma-denemesi-'; then PASS=$((PASS+1)); echo "ok   gzip gövde açılır"; else FAIL=$((FAIL+1)); echo "FAIL gzip gövde açılmadı"; fi
# Zaten sıkıştırılmış ya da akış türleri, istemci gzip istemezse ve kısa yanıt: sıkıştırılmaz.
for u in /api/deciship/gz/a.jpg /api/deciship/gz/a.pdf /api/deciship/gz/a.xlsx /api/deciship/gz/a.sse /api/deciship/health; do
  nohdr "gzip yok $u" $B$u '^content-encoding:' -H "$GZ"
done
nohdr "gzip yok: istemci istemedi" $B/api/deciship/gz/a.json '^content-encoding:'
# BREACH: Hesap API'si (oturum, yenileme, davet jetonu gövdede) hiç sıkıştırılmaz.
for u in /api/account/gz/a.json /api/account/auth/gz/a.json /api/account/invites/gz/a.json /api/account/health; do
  nohdr "Hesap sıkıştırılmaz $u" $B$u '^content-encoding:' -H "$GZ"
done

echo "== depo NAT'ı: varsayılan yükleme kovası =="
# Varsayılan sınırlar (Dockerfile ENV): tek IP'den art arda 150 multipart ölçüm (10 telefonun kuyruğu açıldı) 429 almaz.
echo x > $T/gw-part
NAT_ARGS=(); for i in $(seq 1 150); do NAT_ARGS+=(-o /dev/null "$B/api/deciship/measurements"); done
codes=$(curl -s -w '%{http_code}\n' -F f=@$T/gw-part "${NAT_ARGS[@]}" 2>/dev/null | tr -d '\r' | sort | uniq -c | tr -s ' ' | tr '\n' ',')
case "$codes" in " 150 200,") PASS=$((PASS+1)); echo "ok   150 multipart tek IP'den: $codes";; *) FAIL=$((FAIL+1)); echo "FAIL 150 multipart tek IP'den: $codes (beklenen 150 × 200)";; esac

echo "== yukarı akış yokken =="
docker stop gw-fake-hub-web >/dev/null
check "hub-web kapalı -> 503 JSON" 503 SERVICE_UNAVAILABLE $B/home
check "gateway ayakta" 200 ok $B/healthz
check "jetonlu yol da 503 JSON" 503 SERVICE_UNAVAILABLE $B/invite/GIZLIJETON7
logcheck "hata günlüğünde bağlantı jetonu yok"

echo "== hız sınırı =="
L=http://localhost:18090
# Art arda 15 istek: 1r/m ve burst 2 ile ilk üçü geçer, gerisi 429 olmalı.
codes=""; for i in $(seq 1 15); do codes="$codes $(curl -s -o /dev/null -w '%{http_code}' $L/api/account/me)"; done
case "$codes" in *429*) PASS=$((PASS+1)); echo "ok   /api/ art arda istekte 429 ($codes )";; *) FAIL=$((FAIL+1)); echo "FAIL /api/ 429 vermedi:$codes";; esac
check "429 JSON gövde" 429 '{"error":{"code":"TOO_MANY_REQUESTS"}}' $L/api/account/me
hdr "429 Retry-After: 5" $L/api/account/me '^retry-after: 5' 
hdr "429 güvenlik başlığı" $L/api/account/me '^x-frame-options: DENY'
# healthz ve API sağlık uçları sınırın dışında: aynı kap doluyken bile hep 200.
bad=0; for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' $L/healthz)" = 200 ] || bad=1
  [ "$(curl -s -o /dev/null -w '%{http_code}' $L/api/account/health)" = 200 ] || bad=1
  [ "$(curl -s -o /dev/null -w '%{http_code}' $L/api/deciship/health)" = 200 ] || bad=1
  [ "$(curl -s -o /dev/null -w '%{http_code}' $L/api/ai/health)" = 200 ] || bad=1
done
check "ai uçları da genel kovada (dolu kova 429)" 429 TOO_MANY_REQUESTS $L/api/ai/spend/summary
[ $bad = 0 ] && { PASS=$((PASS+1)); echo "ok   healthz ve sağlık uçları sınırsız"; } || { FAIL=$((FAIL+1)); echo "FAIL sağlık uçları kısıldı"; }
# Yükleme kovası: 1r/m, burst 1 -> ilk iki multipart geçer, üçüncüsü 429.
U=http://localhost:18091
echo x > $T/gw-part
c1=$(curl -s -o /dev/null -w '%{http_code}' -F f=@$T/gw-part $U/api/deciship/invoices)
c2=$(curl -s -o /dev/null -w '%{http_code}' -F f=@$T/gw-part $U/api/deciship/invoices)
c3=$(curl -s -o /dev/null -w '%{http_code}' -F f=@$T/gw-part $U/api/deciship/invoices)
[ "$c1 $c2 $c3" = "200 200 429" ] && { PASS=$((PASS+1)); echo "ok   multipart kovası: $c1 $c2 $c3"; } || { FAIL=$((FAIL+1)); echo "FAIL multipart kovası: $c1 $c2 $c3 (beklenen 200 200 429)"; }
check "yükleme kovası doluyken multipart olmayan istek geçer" 200 deciship-api $U/api/deciship/invoices
check "yükleme kovası doluyken JSON POST geçer" 200 deciship-api -X POST -H 'Content-Type: application/json' -d '{}' $U/api/deciship/invoices
check "multipart kovası doluyken 429 JSON" 429 TOO_MANY_REQUESTS -F f=@$T/gw-part $U/api/deciship/invoices

echo "== kimlik uçları =="
A=http://localhost:18092
# "yukarı akış yokken" hub-web taklidini durdurdu: sayfa ve varlık denetimleri için geri aç (DNS önbelleği 10 sn).
docker start gw-fake-hub-web >/dev/null
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' $A/home)" = 200 ] && break; sleep 1; done
# 1r/m, burst 2 -> üç giriş denemesi geçer, dördüncüsü 429.
c=""; for i in 1 2 3 4; do c="$c $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' $A/api/account/auth/login)"; done
[ "$c" = " 200 200 200 429" ] && { PASS=$((PASS+1)); echo "ok   kimlik kovası:$c"; } || { FAIL=$((FAIL+1)); echo "FAIL kimlik kovası:$c (beklenen 200 200 200 429)"; }
check "kimlik 429 JSON TOO_MANY_ATTEMPTS" 429 '{"error":{"code":"TOO_MANY_ATTEMPTS"}}' -X POST -d '{}' $A/api/account/auth/login
hdr "kimlik 429 Retry-After: 5" $A/api/account/auth/login '^retry-after: 5$' -X POST -d '{}'
hdr "kimlik 429 JSON türü" $A/api/account/auth/login '^content-type: application/json' -X POST -d '{}'
hdr "kimlik 429 no-store" $A/api/account/auth/login '^cache-control: no-store' -X POST -d '{}'
hdr "kimlik 429 güvenlik başlığı" $A/api/account/auth/login '^x-frame-options: DENY' -X POST -d '{}'
# Bütün kimlik uçları aynı kovayı sayar; yazım oyunu (harf, sonda eğik çizgi, çift eğik çizgi, %xx) kovayı atlatmaz.
for p in /api/account/auth/register /api/account/auth/forgot-password /api/account/auth/reset-password /api/account/auth/verify-email /api/account/auth/resend-verification /api/account/auth/join/preview /api/account/auth/join/accept /api/account/invites/abc/accept /api/account/auth/LOGIN /api/account/auth/login/ //api/account/auth/login /api/account/auth/%6Cogin; do
  check "kimlik kovası dolu: POST $p" 429 TOO_MANY_ATTEMPTS --path-as-is -X POST -d '{}' "$A$p"
done
check "kimlik kovası dolu: davet önizleme GET" 429 TOO_MANY_ATTEMPTS $A/api/account/invites/abc
# Sık çağrılan oturum uçları, genel API, ölçüm gönderimi, sağlık ve statik dosyalar kimlik kovasından etkilenmez.
for p in /api/account/auth/refresh /api/account/auth/logout /api/account/auth/switch-org /api/account/me; do
  check "kimlik kovası doluyken POST $p geçer" 200 account-api -X POST -d '{}' "$A$p"
done
check "kimlik kovası doluyken site-session geçer" 200 account-api $A/api/account/auth/site-session
check "kimlik kovası doluyken /api/account/health geçer" 200 account-api $A/api/account/health
check "kimlik kovası doluyken ölçüm (JSON) geçer" 200 deciship-api -X POST -H 'Content-Type: application/json' -d '{}' $A/api/deciship/measurements
check "kimlik kovası doluyken ölçüm (multipart) geçer" 200 deciship-api -F f=@$T/gw-part $A/api/deciship/measurements
check "DeciShip'te aynı adlı yol kimlik kovasında değil" 200 deciship-api -X POST -d '{}' $A/api/deciship/auth/login
check "kimlik kovası doluyken giriş sayfası geçer" 200 hub-web $A/login
check "kimlik kovası doluyken varlık geçer" 200 hub-web $A/assets/a.js

echo "== bağlantı sınırı (yavaş gövde) =="
C=http://localhost:18093
# İki yavaş yükleme (saniyede 1 KB, ~30 sn) web yolunda iki yeri tutar; üçüncü istek web sayfasında, varlıkta ve API'de 429 alır.
head -c 30000 /dev/zero > $T/gw-30k
curl -s -o /dev/null -H 'Expect:' --limit-rate 1k -X POST --data-binary @$T/gw-30k $C/home & SLOW1=$!
curl -s -o /dev/null -H 'Expect:' --limit-rate 1k -X POST --data-binary @$T/gw-30k $C/assets/x.js & SLOW2=$!
sleep 2
check "yavaş gövdeler doluyken sayfa 429" 429 TOO_MANY_REQUESTS $C/home
check "yavaş gövdeler doluyken varlık 429" 429 TOO_MANY_REQUESTS $C/assets/a.js
check "yavaş gövdeler doluyken API 429" 429 TOO_MANY_REQUESTS $C/api/deciship/measurements
kill $SLOW1 $SLOW2 2>/dev/null; wait $SLOW1 $SLOW2 2>/dev/null
ok=0; for i in $(seq 1 20); do [ "$(curl -s -o /dev/null -w '%{http_code}' $C/home)" = 200 ] && { ok=1; break; }; sleep 1; done
[ $ok = 1 ] && { PASS=$((PASS+1)); echo "ok   yavaş istemci gidince sayfa yine açılır"; } || { FAIL=$((FAIL+1)); echo "FAIL yavaş istemci gittikten sonra da 429"; }

echo; echo "GEÇEN: $PASS  KALAN: $FAIL"
[ "$FAIL" -eq 0 ]
