#!/usr/bin/env bash
# SellerOnData "ayakta mı" denetimi (sunucu; Linux). cron ya da systemd zamanlayıcısı çağırır, elle de çalışır.
# Ayrıntı ve kurulum: docs/KURULUM.md "Ayakta mı denetimi". Windows'taki yedek durumu: scripts/yedek-zamanla.ps1 durum.
#
# Denetler (biri tutmazsa çıkış 1):
#   1. sağlık uçları   gateway /healthz, /api/account/health ve her /api/<x>/health ucu (gateway/conf/default.conf ve products/*.conf'tan; ai geçidi default.conf'ta),
#                      ayrıca tanıtım sitesi; hepsi 200 dönmeli
#   2. kaplar          compose projesindeki kaplar: sağlıksız, yeniden başlayıp duran ya da durmuş kap sorun; tek seferlik
#                      kaplar (göç, yükseltme) yalnız 0 ile çıktıysa tamam. docker yoksa ya da erişilemiyorsa bu adım atlanır.
#   3. disk            her yolun bulunduğu diskte doluluk sınırın altında ve boş yer en az SOD_DISK_MIN_FREE_MB
#   4. yedek           son başarılı yedek SOD_BACKUP_MAX_AGE_HOURS saatten yeni; son yedek denemesi hatalıysa da sorun
#
# Çıkış: 0 sorun yok, 1 en az bir sorun, 2 kullanım/ortam hatası (curl yok, ayar geçersiz).
# Çıktı: her denetim bir satır "<zaman> TAMAM|SORUN|ATLANDI <ne>: <ayrıntı>", sonda özet. SOD_CHECK_LOG verilirse satırlar
# o dosyaya da eklenir. Gerçek uyarı kanalı (e-posta, bildirim) henüz yok: çıkış koduna bağlanır (KURULUM).
#
# Ayarlar (ortam değişkeni; hepsinin varsayılanı var):
#   SOD_CHECK_URL             gateway adresi                         http://127.0.0.1:8088
#   SOD_CHECK_SITE_URL        tanıtım sitesi; off: denetlenmez       http://127.0.0.1:8089/
#   SOD_CHECK_EXTRA_PATHS     ek sağlık yolları (boşlukla)           boş
#   SOD_CHECK_TIMEOUT         istek başına saniye                    10
#   SOD_COMPOSE_PROJECT       compose proje adı; off: kaplar atlanır sellerondata
#   SOD_DISK_PATHS            denetlenen yollar (boşlukla; olmayan atlanır)  / /var/lib/docker <Platform>/yedekler
#   SOD_DISK_MAX_PCT          en yüksek doluluk, yüzde               85
#   SOD_DISK_MIN_FREE_MB      en az boş yer, MB                      5120
#   SOD_BACKUP_DIR            yedek klasörü                          <Platform>/yedekler
#   SOD_BACKUP_MAX_AGE_HOURS  son başarılı yedeğin en çok yaşı; 0: denetlenmez  36
#   SOD_CHECK_LOG             satırların ekleneceği günlük dosyası   boş
#
# Yedek sözleşmesi (bugün yedekle.ps1 böyle yazar; sunucu yedeği, KALANLAR 3.3, aynısını yazmalı):
#   - her başarılı yedek SOD_BACKUP_DIR/<YYYY-AA-GG_SSDD>[-n]/yedek.json bırakır (yarım kalan klasörün adı .yaziliyor ile biter)
#   - her çalıştırma SOD_BACKUP_DIR/son-yedek.json yazar: "kod": 0 başarı, başka değer hata ya da uyarı
set -uo pipefail

PLATFORM=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

URL=${SOD_CHECK_URL:-http://127.0.0.1:8088}
URL=${URL%/}
SITE_URL=${SOD_CHECK_SITE_URL:-http://127.0.0.1:8089/}
EXTRA_PATHS=${SOD_CHECK_EXTRA_PATHS:-}
TIMEOUT=${SOD_CHECK_TIMEOUT:-10}
PROJECT=${SOD_COMPOSE_PROJECT:-sellerondata}
BACKUP_DIR=${SOD_BACKUP_DIR:-$PLATFORM/yedekler}
DISK_PATHS=${SOD_DISK_PATHS:-/ /var/lib/docker $BACKUP_DIR}
DISK_MAX_PCT=${SOD_DISK_MAX_PCT:-85}
DISK_MIN_FREE_MB=${SOD_DISK_MIN_FREE_MB:-5120}
BACKUP_MAX_AGE_HOURS=${SOD_BACKUP_MAX_AGE_HOURS:-36}
LOG=${SOD_CHECK_LOG:-}

PROBLEMS=0
OKS=0
SKIPS=0

line() { # durum, metin
  local l
  l="$(date '+%Y-%m-%dT%H:%M:%S%z') $1 $2"
  printf '%s\n' "$l"
  if [ -n "$LOG" ]; then printf '%s\n' "$l" >>"$LOG" 2>/dev/null || { LOG=; echo "uyarı: günlük dosyasına yazılamadı" >&2; }; fi
}
ok() { OKS=$((OKS + 1)); line TAMAM "$1"; }
bad() { PROBLEMS=$((PROBLEMS + 1)); line SORUN "$1"; }
skip() { SKIPS=$((SKIPS + 1)); line ATLANDI "$1"; }
usage_error() { echo "ayakta-mi: $1" >&2; exit 2; }

is_uint() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }
for pair in TIMEOUT:SOD_CHECK_TIMEOUT DISK_MAX_PCT:SOD_DISK_MAX_PCT DISK_MIN_FREE_MB:SOD_DISK_MIN_FREE_MB BACKUP_MAX_AGE_HOURS:SOD_BACKUP_MAX_AGE_HOURS; do
  v=${pair%%:*}
  is_uint "${!v}" || usage_error "${pair#*:} sayı olmalı: '${!v}'"
done
[ "$DISK_MAX_PCT" -le 100 ] || usage_error "SOD_DISK_MAX_PCT 0-100 arası olmalı: $DISK_MAX_PCT"
command -v curl >/dev/null 2>&1 || usage_error "curl bulunamadı"

# ---------- 1. sağlık uçları ----------
health_paths() {
  echo /healthz
  echo /api/account/health
  local f
  for f in "$PLATFORM"/gateway/conf/default.conf "$PLATFORM"/gateway/conf/products/*.conf; do
    [ -f "$f" ] || continue
    sed -n 's#^[[:space:]]*location = \(/api/[a-z0-9-]*/health\) {.*#\1#p' "$f"
  done
  local p
  for p in $EXTRA_PATHS; do echo "$p"; done
}

probe() { # ad, adres
  local code
  code=$(curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}' "$2" 2>/dev/null)
  code=${code:-000}
  if [ "$code" = 200 ]; then ok "$1"; else bad "$1: yanıt $code ($2)"; fi
}

while IFS= read -r p; do
  [ -n "$p" ] && probe "sağlık $p" "$URL$p"
done < <(health_paths | awk '!seen[$0]++')
if [ "$SITE_URL" = off ]; then skip "site: SOD_CHECK_SITE_URL=off"; else probe "site" "$SITE_URL"; fi

# ---------- 2. kaplar ----------
if [ "$PROJECT" = off ]; then
  skip "kaplar: SOD_COMPOSE_PROJECT=off"
elif ! command -v docker >/dev/null 2>&1; then
  skip "kaplar: docker bulunamadı"
elif ! ps_out=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Status}}' 2>&1); then
  skip "kaplar: docker'a erişilemedi ($(printf '%s' "$ps_out" | head -n 1))"
elif [ -z "$ps_out" ]; then
  bad "kaplar: '$PROJECT' projesinde kap yok (sistem açık değil)"
else
  container_problems=0
  while IFS='|' read -r svc state status; do
    [ -n "$svc" ] || continue
    case "$svc" in
      *-migrate | *-upgrade)
        # Tek seferlik: çalışıyor ya da 0 ile bitmiş olmalı.
        case "$state:$status" in
          running:* | exited:"Exited (0)"*) ;;
          *) bad "kap $svc: $status"; container_problems=$((container_problems + 1)) ;;
        esac
        ;;
      *)
        case "$state:$status" in
          running:*"(unhealthy)"*) bad "kap $svc: sağlıksız ($status)"; container_problems=$((container_problems + 1)) ;;
          running:*) ;;
          *) bad "kap $svc: $state ($status)"; container_problems=$((container_problems + 1)) ;;
        esac
        ;;
    esac
  done <<<"$ps_out"
  [ "$container_problems" -eq 0 ] && ok "kaplar: $(printf '%s\n' "$ps_out" | grep -c .) kap, sorun yok"
fi

# ---------- 3. disk ----------
for p in $DISK_PATHS; do
  if [ ! -e "$p" ]; then
    skip "disk $p: yol yok"
    continue
  fi
  # POSIX çıktısı: Dosya-sistemi 1024-blok Kullanılan Boş Kullanım% Bağlama. Dosya sistemi adı boşluk içerebilir:
  # alanlar yüzde sütunundan geriye sayılır.
  pct=
  avail_kb=
  read -r pct avail_kb < <(df -Pk "$p" 2>/dev/null | awk 'NR == 2 { for (i = NF; i > 1; i--) if ($i ~ /^[0-9]+%$/) { sub("%", "", $i); print $i, $(i - 1); exit } }')
  if ! is_uint "${pct:-}" || ! is_uint "${avail_kb:-}"; then
    bad "disk $p: df okunamadı"
    continue
  fi
  free_mb=$((avail_kb / 1024))
  if [ "$pct" -ge "$DISK_MAX_PCT" ] || [ "$free_mb" -lt "$DISK_MIN_FREE_MB" ]; then
    bad "disk $p: %$pct dolu, boş $free_mb MB (sınır %$DISK_MAX_PCT, en az $DISK_MIN_FREE_MB MB)"
  else
    ok "disk $p: %$pct dolu, boş $free_mb MB"
  fi
done

# ---------- 4. yedek ----------
mtime() { stat -c %Y "$1" 2>/dev/null; }

if [ "$BACKUP_MAX_AGE_HOURS" -eq 0 ]; then
  skip "yedek: SOD_BACKUP_MAX_AGE_HOURS=0"
elif [ ! -d "$BACKUP_DIR" ]; then
  bad "yedek: klasör yok ($BACKUP_DIR)"
else
  newest=0
  newest_name=
  for d in "$BACKUP_DIR"/*/; do
    d=${d%/}
    name=${d##*/}
    [[ $name =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}(-[0-9]+)?$ ]] || continue
    [ -f "$d/yedek.json" ] || continue
    t=$(mtime "$d/yedek.json")
    if is_uint "${t:-}" && [ "$t" -gt "$newest" ]; then
      newest=$t
      newest_name=$name
    fi
  done
  status_file="$BACKUP_DIR/son-yedek.json"
  last_code=
  if [ -f "$status_file" ]; then
    last_code=$(tr -d '\r' <"$status_file" | sed -n 's/.*"kod"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p' | head -n 1)
    if [ "$last_code" = 0 ]; then
      t=$(mtime "$status_file")
      if is_uint "${t:-}" && [ "$t" -gt "$newest" ]; then
        newest=$t
        newest_name=son-yedek.json
      fi
    fi
  fi
  if [ -n "$last_code" ] && [ "$last_code" != 0 ]; then
    summary=$(tr -d '\r' <"$status_file" | sed -n 's/.*"ozet"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    bad "yedek: son deneme hatalı (kod $last_code${summary:+: $summary})"
  fi
  if [ "$newest" -eq 0 ]; then
    bad "yedek: başarılı yedek bulunamadı ($BACKUP_DIR)"
  else
    age_h=$((($(date +%s) - newest) / 3600))
    if [ "$age_h" -ge "$BACKUP_MAX_AGE_HOURS" ]; then
      bad "yedek: son başarılı yedek $age_h saat önce ($newest_name; sınır $BACKUP_MAX_AGE_HOURS saat)"
    else
      ok "yedek: son başarılı yedek $age_h saat önce ($newest_name)"
    fi
  fi
fi

# ---------- özet ----------
if [ "$PROBLEMS" -gt 0 ]; then
  line SONUC "$PROBLEMS sorun, $OKS tamam, $SKIPS atlandı"
  exit 1
fi
line SONUC "sorun yok ($OKS tamam, $SKIPS atlandı)"
exit 0
