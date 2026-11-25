#!/usr/bin/env bash
# SellerOnData sunucu güncellemesi (Linux; KALANLAR 3.5). Ayrıntı: docs/KURULUM.md "Güncelleme".
#
#   bash scripts/guncelle.sh <etiket|commit>   yedek → sürüm → derleme → açılış → göç denetimi → sağlık
#   bash scripts/guncelle.sh -n <etiket>       kuru çalışma: yalnız git fetch; plan, göç farkı ve yedek yeri yazılır
#
# Seçenekler:
#   -n, --kuru                 hiçbir şeyi değiştirmez (git fetch dışında)
#   --ilk-kurulum              ilk açılış (kurulum.sh çağırır): veritabanı hacmi yoksa yedek atlanır, hedef verilmezse HEAD;
#                              sonunda firmalar araçlara duyurulur (org-announce)
#   --uyelik-duyur <ürün>[,..] sonunda üyeler araca yeniden duyurulur (members-announce): hazır rolün varsayılan izinleri
#                              değiştiğinde ya da araç off'tan açıldığında
#   --geri                     eski bir sürüme bilerek dönüş; yalnız aradaki sürümlerde veritabanı göçü yoksa
#
# Sıra: çalışma ağacı temiz mi → git fetch → hedef yalnız ileri mi → yedek (veritabanı + DeciShip dosyaları + .env, doğrulamalı)
# → hedef commit'e geçiş → docker compose build → up -d --wait → göç kapları 0 ile bitti mi → scripts/ayakta-mi.sh.
# Derleme bozulursa çalışan kaplara dokunulmaz, kod ve imajlar eski sürüme döner. Açılış, göç ya da sağlık tutmazsa: aradaki
# sürümlerde veritabanı göçü yoksa eski sürüm yeniden kurulur; göç varsa betik açıkça durur (göç geri alınamaz; KURULUM).
#
# Çıkış: 0 tamam; 1 güncelleme olmadı, sistem eski sürümde açık; 2 başlamadan durdu, hiçbir şey değişmedi (kullanım, kirli
# çalışma ağacı, geri sürüm, yedek alınamadı); 3 tutmadı ve kendiliğinden geri dönülemedi, elle bakılmalı; 4 güncelleme tamam,
# duyuru komutu tutmadı (yeniden çalıştırmak zararsız).
#
# Ayarlar (ortam değişkeni; hepsinin varsayılanı var):
#   SOD_COMPOSE_PROJECT       compose proje adı                         sellerondata
#   SOD_COMPOSE_FILES         compose dosyaları (Platform'a göre)       docker-compose.yml docker-compose.prod.yml
#   SOD_ENV_FILE              ayar dosyası                              <Platform>/.env
#   SOD_GIT_REMOTE            git uzak deposu                           origin
#   SOD_BACKUP_DIR            yedek kökü (ortamda yoksa .env); güncelleme yedekleri <kök>/guncelle/<YYYY-AA-GG_SSDD>   <Platform>/yedekler
#   SOD_UPDATE_BACKUP_KEEP    saklanan güncelleme yedeği                3
#   SOD_UPDATE_MIN_FREE_MB    yedekten önce en az boş yer (önceki yedeğin 3 katından az değil)   1024
#   SOD_UPDATE_WAIT_TIMEOUT   up --wait en çok saniye                   600
#   SOD_UPDATE_HEALTH_TRIES   sağlık denemesi                           6
#   SOD_UPDATE_HEALTH_WAIT    denemeler arası saniye                    10
#   SOD_CHECK_URL, SOD_CHECK_SITE_URL   sağlık adresleri; boşsa .env'deki APP_BASE_URL ve SITE_BASE_URL
# Sunucu yedeği (KALANLAR 3.3) scripts/yedekle.sh olarak gelince yedek_al onu çağırır (sözleşme işlevin başında).
#
# Bütün kod işlevlerin içinde, son satırda çağrılır: git checkout bu dosyayı değiştirse de çalışan kopya bozulmaz.
# kurulum.sh bu dosyayı `source` ile yükleyip yardımcı işlevleri kullanır; o zaman main çalışmaz.
set -uo pipefail

PLATFORM=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Veritabanı şemasını değiştiren yollar: bunlardan biri değişmişse eski sürüme kendiliğinden dönülmez.
GOC_DESEN='(^|/)prisma/migrations/|(^|/)migration\.sql$|^Platform/infra/postgres/'
# Hazır rollerin varsayılan izinleri (araç kaydı): değişince üyeler araca yeniden duyurulmalı.
ROL_KAYDI='Platform/packages/contracts/src/products.ts'

yaz() { printf '%s\n' "$*"; }
adim() { printf '\n==> %s\n' "$*"; }
uyari() { printf 'UYARI: %s\n' "$*"; }
hata() { printf 'HATA: %s\n' "$*"; }
kullanim_hatasi() {
  printf 'guncelle: %s\n(yardım: bash scripts/guncelle.sh --help)\n' "$1" >&2
  exit 2
}
yardim() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
is_uint() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }
mutlak() { case "$1" in /* | [A-Za-z]:*) printf '%s' "$1" ;; *) printf '%s/%s' "$PLATFORM" "${1#./}" ;; esac; }

# .env'deki son değer; compose kuralı: tırnak soyulur, tırnaksız değerde " #" sonrası yorumdur.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$1" '
    { sub(/\r$/, "") }
    $0 ~ "^[ \t]*" k "[ \t]*=" { v = substr($0, index($0, "=") + 1); found = 1 }
    END {
      if (!found) exit
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      q = substr(v, 1, 1)
      if (length(v) >= 2 && (q == "\"" || q == "\047") && substr(v, length(v), 1) == q) v = substr(v, 2, length(v) - 2)
      else { i = index(v, " #"); if (i) v = substr(v, 1, i - 1); sub(/[ \t]+$/, "", v) }
      print v
    }' "$ENV_FILE"
}

json_str() { # JSON dizgesi (tırnaklı)
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

ayarlar() {
  PROJECT=${SOD_COMPOSE_PROJECT:-sellerondata}
  ENV_FILE=$(mutlak "${SOD_ENV_FILE:-.env}")
  COMPOSE_FILES=${SOD_COMPOSE_FILES:-docker-compose.yml docker-compose.prod.yml}
  REMOTE=${SOD_GIT_REMOTE:-origin}
  BACKUP_DIR=${SOD_BACKUP_DIR:-$(env_get SOD_BACKUP_DIR)}
  BACKUP_DIR=$(mutlak "${BACKUP_DIR:-yedekler}")
  UPDATE_DIR=$BACKUP_DIR/guncelle
  KEEP=${SOD_UPDATE_BACKUP_KEEP:-3}
  MIN_FREE_MB=${SOD_UPDATE_MIN_FREE_MB:-1024}
  WAIT_TIMEOUT=${SOD_UPDATE_WAIT_TIMEOUT:-600}
  HEALTH_TRIES=${SOD_UPDATE_HEALTH_TRIES:-6}
  HEALTH_WAIT=${SOD_UPDATE_HEALTH_WAIT:-10}
  local pair v
  for pair in KEEP:SOD_UPDATE_BACKUP_KEEP MIN_FREE_MB:SOD_UPDATE_MIN_FREE_MB WAIT_TIMEOUT:SOD_UPDATE_WAIT_TIMEOUT HEALTH_TRIES:SOD_UPDATE_HEALTH_TRIES HEALTH_WAIT:SOD_UPDATE_HEALTH_WAIT; do
    v=${pair%%:*}
    is_uint "${!v}" || kullanim_hatasi "${pair#*:} sayı olmalı: '${!v}'"
  done
  [ "$KEEP" -ge 1 ] || kullanim_hatasi "SOD_UPDATE_BACKUP_KEEP en az 1 olmalı"
  [ "$HEALTH_TRIES" -ge 1 ] || kullanim_hatasi "SOD_UPDATE_HEALTH_TRIES en az 1 olmalı"
  DC=(docker compose -p "$PROJECT" --project-directory "$PLATFORM" --env-file "$ENV_FILE")
  DC_YAZI="docker compose -p $PROJECT"
  local f
  for f in $COMPOSE_FILES; do
    DC+=(-f "$(mutlak "$f")")
    DC_YAZI+=" -f $f"
  done
  PGVOL=${SOD_PGDATA_VOLUME:-$(env_get SOD_PGDATA_VOLUME)}
  PGVOL=${PGVOL:-sod_pgdata}
  STORVOL=${SOD_STORAGE_VOLUME:-$(env_get SOD_STORAGE_VOLUME)}
  STORVOL=${STORVOL:-sod_deciship_storage}
}

on_denetim() {
  local arac out
  for arac in docker git curl awk sha256sum; do
    command -v "$arac" >/dev/null 2>&1 || { hata "$arac bulunamadı"; exit 2; }
  done
  [ -f "$ENV_FILE" ] || {
    hata "ayar dosyası yok: $ENV_FILE (ilk kurulum: bash scripts/kurulum.sh)"
    exit 2
  }
  [ "$(env_get SOD_ENV)" = production ] || uyari "SOD_ENV=production değil: bu bir üretim sunucusu değilse sorun yok."
  docker info >/dev/null 2>&1 || {
    hata "docker'a erişilemiyor (kullanıcı docker grubunda mı, Docker açık mı?)"
    exit 2
  }
  if ! out=$("${DC[@]}" config --quiet 2>&1); then
    hata "compose ayarı geçersiz ya da .env eksik:"
    printf '%s\n' "$out" | sed 's/^/  /'
    exit 2
  fi
}

kilit_al() {
  mkdir -p "$UPDATE_DIR" && chmod 700 "$UPDATE_DIR" || {
    hata "klasör açılamadı: $UPDATE_DIR"
    exit 2
  }
  KILIT=$UPDATE_DIR/.kilit
  if ! mkdir "$KILIT" 2>/dev/null; then
    local eski
    eski=$(cat "$KILIT/pid" 2>/dev/null)
    if [ -n "$eski" ] && kill -0 "$eski" 2>/dev/null; then
      hata "başka bir güncelleme sürüyor (süreç $eski; kilit $KILIT)"
      exit 2
    fi
    uyari "yarım kalmış güncellemenin kilidi kaldırıldı (süreç ${eski:-?} artık yok)"
    rm -rf "$KILIT"
    mkdir "$KILIT" || exit 2
  fi
  echo $$ >"$KILIT/pid"
  trap 'rm -rf "$KILIT"' EXIT
}

G() { git -C "$REPO" "$@"; }
kisa() { git -C "$REPO" rev-parse --short "$1"; }

surum_sec() {
  REPO=$(git -C "$PLATFORM" rev-parse --show-toplevel 2>/dev/null) || {
    hata "git deposu değil: $PLATFORM"
    exit 2
  }
  local kirli
  kirli=$(G status --porcelain --untracked-files=no)
  if [ -n "$kirli" ]; then
    hata "çalışma ağacında commit'lenmemiş değişiklik var; güncelleme durdu:"
    printf '%s\n' "$kirli" | sed 's/^/  /'
    yaz "Sunucuda kod elle değiştirilmez: değişikliği depoya taşıyın ya da geri alın, sonra yeniden çalıştırın."
    exit 2
  fi
  ONCEKI=$(G rev-parse --verify HEAD) || exit 2
  if [ "$HEDEF" != HEAD ]; then
    yaz "git fetch $REMOTE..."
    G fetch --quiet --tags "$REMOTE" || {
      hata "git fetch $REMOTE başarısız (ağ ya da depo erişimi)"
      exit 2
    }
  fi
  HEDEF_SHA=$(G rev-parse --verify --quiet "$HEDEF^{commit}") || {
    hata "sürüm bulunamadı: $HEDEF (etiket, commit ya da $REMOTE/<dal>)"
    exit 2
  }
  if [ "$HEDEF_SHA" = "$ONCEKI" ]; then
    YON=ayni
  elif G merge-base --is-ancestor "$ONCEKI" "$HEDEF_SHA"; then
    YON=ileri
  elif G merge-base --is-ancestor "$HEDEF_SHA" "$ONCEKI"; then
    YON=geri
  else
    YON=yan
  fi
  GOCLER=$(G diff --name-only "$ONCEKI" "$HEDEF_SHA" | grep -E "$GOC_DESEN")
  ONCEKI_KISA=$(kisa "$ONCEKI")
  HEDEF_KISA=$(kisa "$HEDEF_SHA")
  case $YON in
    yan)
      hata "$HEDEF ($HEDEF_KISA) şimdiki sürümün ($ONCEKI_KISA) ne ilerisinde ne gerisinde (ayrı dal); güncelleme yalnız ileri gider."
      exit 2
      ;;
    geri)
      if [ "$GERI" = 0 ]; then
        hata "$HEDEF ($HEDEF_KISA) şimdiki sürümden ($ONCEKI_KISA) eski; güncelleme yalnız ileri gider. Bilerek dönmek için --geri (yalnız göç farkı yoksa)."
        exit 2
      fi
      if [ -n "$GOCLER" ]; then
        hata "eski sürüme dönülemez: aradaki veritabanı göçleri geri alınamaz:"
        printf '%s\n' "$GOCLER" | sed 's/^/  /'
        yaz "Yol: docs/KURULUM.md \"Güncelleme\" > \"Göçlü sürüm açılmazsa\" (yedekten dönüş)."
        exit 2
      fi
      ;;
  esac
  ROL_DEGISTI=0
  if [ "$YON" = ileri ] && [ -z "$DUYUR" ] && ! G diff --quiet "$ONCEKI" "$HEDEF_SHA" -- "$ROL_KAYDI"; then ROL_DEGISTI=1; fi
}

plan_yaz() {
  adim "Plan"
  case $YON in
    ayni) yaz "Sürüm: $ONCEKI_KISA (değişmiyor; imajlar yeniden derlenir, kaplar .env'e göre yeniden kurulur)" ;;
    ileri) yaz "Sürüm: $ONCEKI_KISA → $HEDEF_KISA ($HEDEF; $(G rev-list --count "$ONCEKI..$HEDEF_SHA") commit)" ;;
    geri) yaz "Sürüm: $ONCEKI_KISA → $HEDEF_KISA ($HEDEF; GERİ, $(G rev-list --count "$HEDEF_SHA..$ONCEKI") commit)" ;;
  esac
  if [ -n "$GOCLER" ]; then
    yaz "Veritabanı göçü var (geri alınamaz; sorun çıkarsa eski sürüme kendiliğinden dönülmez):"
    printf '%s\n' "$GOCLER" | sed 's/^/  /'
  elif [ "$YON" != ayni ]; then
    yaz "Veritabanı göçü yok: sorun çıkarsa eski sürüm yeniden kurulur."
  fi
  if [ "$ROL_DEGISTI" = 1 ]; then
    uyari "araç kaydı ($ROL_KAYDI) değişmiş: hazır rollerin varsayılan izinleri değiştiyse ardından --uyelik-duyur <ürün> ile yeniden çalıştırın (ör. bash scripts/guncelle.sh --uyelik-duyur deciship HEAD)."
  fi
  if [ "$ILK" = 1 ] && ! docker volume inspect "$PGVOL" >/dev/null 2>&1; then
    yaz "Yedek: ilk kurulum, veritabanı hacmi ($PGVOL) yok; atlanır."
  elif [ -f "$PLATFORM/scripts/yedekle.sh" ]; then
    yaz "Yedek: scripts/yedekle.sh (sunucu yedeği)"
  else
    yaz "Yedek: $UPDATE_DIR/<tarih-saat> (veritabanı, DeciShip dosyaları, .env; son $KEEP tanesi saklanır)"
  fi
  yaz "Sonra: build, up -d --wait, göç kapları, sağlık (scripts/ayakta-mi.sh; $CHECK_URL)"
  [ "$ILK" = 1 ] && yaz "İlk kurulum: sonunda org-announce"
  local u
  for u in $DUYUR; do yaz "Sonunda: members-announce $u"; done
  return 0
}

# ---------- yedek ----------

# Sunucu yedeği (KALANLAR 3.3) gelince: scripts/yedekle.sh. Sözleşme: çıkış 0 tamam, 2 yerel yedek tamam ama uyarı var, başka
# değer yedek yok; SOD_BACKUP_DIR/son-yedek.json "klasor" alanına yeni yedeğin klasörünü yazar (ayakta-mi.sh sözleşmesi).
# O gelene dek aşağıdaki yerel yedek: sunucu diskinde, şifresiz, başka yere kopyalanmaz.
yedek_al() {
  if [ -f "$PLATFORM/scripts/yedekle.sh" ]; then
    yaz "Sunucu yedeği (scripts/yedekle.sh)..."
    bash "$PLATFORM/scripts/yedekle.sh"
    local kod=$?
    case $kod in
      0) ;;
      2) uyari "yedek alındı ama uyarı var (yedekle.sh çıkış 2)" ;;
      *)
        hata "scripts/yedekle.sh çıkış $kod"
        return 1
        ;;
    esac
    YEDEK=$(tr -d '\r' <"$BACKUP_DIR/son-yedek.json" 2>/dev/null | sed -n 's/.*"klasor"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    YEDEK=${YEDEK:-$BACKUP_DIR}
    return 0
  fi
  yerel_yedek
}

KAP=/tmp/sod-guncelle
yedek_hatasi() {
  hata "yedek: $1"
  [ -n "${IS:-}" ] && rm -rf "$IS"
  "${DC[@]}" exec -T postgres rm -f "$KAP.dump" "$KAP-roller.sql" "$KAP-kap.sh" >/dev/null 2>&1
  return 1
}

postgres_acik() {
  if ! "${DC[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
    yaz "Veritabanı kapalı; yedek için açılıyor..."
    "${DC[@]}" up -d --wait --wait-timeout "$WAIT_TIMEOUT" postgres || {
      hata "veritabanı açılamadı"
      return 1
    }
  fi
}

yedek_klasorleri() { # tamamlanmış güncelleme yedekleri, eskiden yeniye
  local d
  for d in "$UPDATE_DIR"/*/; do
    d=${d%/}
    [[ ${d##*/} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}(-[0-9]+)?$ ]] || continue
    [ -f "$d/yedek.json" ] && printf '%s\n' "$d"
  done | sort
}

yer_denetle() {
  local onceki kb=0 gerek bos
  onceki=$(yedek_klasorleri | tail -n 1)
  [ -n "$onceki" ] && kb=$(du -sk "$onceki" 2>/dev/null | awk '{ print $1 }')
  is_uint "$kb" || kb=0
  gerek=$((kb * 3))
  [ "$gerek" -ge $((MIN_FREE_MB * 1024)) ] || gerek=$((MIN_FREE_MB * 1024))
  bos=$(df -Pk "$UPDATE_DIR" 2>/dev/null | awk 'NR == 2 { for (i = NF; i > 1; i--) if ($i ~ /^[0-9]+%$/) { print $(i - 1); exit } }')
  if is_uint "${bos:-}" && [ "$bos" -lt "$gerek" ]; then
    hata "diskte yer az: $((bos / 1024)) MB boş, en az $((gerek / 1024)) MB gerekli ($UPDATE_DIR)"
    return 1
  fi
}

yerel_yedek() {
  local stamp ad n=1 out kap_sha sha pgimg tar_out adet bayt tar_sha env_sha keys_dir s goc gocler='' pg_surum
  postgres_acik || return 1
  mkdir -p "$UPDATE_DIR" && chmod 700 "$UPDATE_DIR" || return 1
  yer_denetle || return 1
  stamp=$(date +%Y-%m-%d_%H%M)
  ad=$stamp
  while [ -e "$UPDATE_DIR/$ad" ] || [ -e "$UPDATE_DIR/$ad.yaziliyor" ]; do
    n=$((n + 1))
    ad=$stamp-$n
  done
  IS=$UPDATE_DIR/$ad.yaziliyor
  (umask 077 && mkdir "$IS") || { yedek_hatasi "klasör açılamadı: $IS"; return 1; }

  yaz "Veritabanı..."
  out=$("${DC[@]}" cp "$PLATFORM/scripts/yedek-kap.sh" "postgres:$KAP-kap.sh" 2>&1) || { yedek_hatasi "yardımcı betik kaba kopyalanamadı: $out"; return 1; }
  out=$("${DC[@]}" exec -T postgres pg_dump -U postgres -d sellerondata -Fc -f "$KAP.dump" 2>&1) || { yedek_hatasi "pg_dump başarısız: $out"; return 1; }
  # Roller yalnız başvuru için (parolasız): geri yüklemede roller .env parolalarıyla init.sql'den kurulur.
  out=$("${DC[@]}" exec -T postgres pg_dumpall -U postgres --globals-only --no-role-passwords -f "$KAP-roller.sql" 2>&1) || { yedek_hatasi "rol dökümü başarısız: $out"; return 1; }
  # Bütünlük: döküm baştan sona açılıp tablo tablo sayılır (yedek-kap.sh say).
  "${DC[@]}" exec -T postgres bash "$KAP-kap.sh" say "$KAP.dump" >"$IS/tablolar.tsv" 2>"$IS/say.err" || { yedek_hatasi "döküm okunamadı: $(tail -n 3 "$IS/say.err" 2>/dev/null)"; return 1; }
  rm -f "$IS/say.err"
  for s in platform._prisma_migrations deciship._prisma_migrations; do
    grep -q "^$s"$'\t' "$IS/tablolar.tsv" || { yedek_hatasi "dökümde $s yok: yanlış veritabanı ya da yarım kurulum"; return 1; }
  done
  kap_sha=$("${DC[@]}" exec -T postgres bash "$KAP-kap.sh" sha "$KAP.dump" 2>/dev/null | tr -d '\r\n ')
  out=$("${DC[@]}" cp "postgres:$KAP.dump" "$IS/veritabani.dump" 2>&1) || { yedek_hatasi "döküm kopyalanamadı: $out"; return 1; }
  out=$("${DC[@]}" cp "postgres:$KAP-roller.sql" "$IS/roller.sql" 2>&1) || { yedek_hatasi "rol dökümü kopyalanamadı: $out"; return 1; }
  sha=$(sha256sum "$IS/veritabani.dump" | cut -d ' ' -f 1)
  [ -n "$kap_sha" ] && [ "$sha" = "$kap_sha" ] || { yedek_hatasi "döküm kopyalanırken bozuldu (SHA-256 tutmuyor)"; return 1; }
  for s in platform deciship tagpress ai; do
    tbl=_prisma_migrations
    [ "$s" = tagpress ] && tbl=_tagpress_migrations
    goc=$("${DC[@]}" exec -T postgres psql -U postgres -d sellerondata -Atc "SELECT migration_name FROM $s.$tbl WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1" 2>/dev/null | tr -d '\r')
    gocler+="${gocler:+, }$(json_str "$s"): $(json_str "$goc")"
  done
  pg_surum=$("${DC[@]}" exec -T postgres psql -U postgres -Atc 'SHOW server_version' 2>/dev/null | tr -d '\r')
  "${DC[@]}" exec -T postgres rm -f "$KAP.dump" "$KAP-roller.sql" "$KAP-kap.sh" >/dev/null 2>&1

  # Dosya deposu veritabanından sonra (dökümden sonra eklenen dosya yalnız sahipsiz kalır, storage:orphans).
  yaz "DeciShip dosyaları..."
  docker volume inspect "$STORVOL" >/dev/null 2>&1 || { yedek_hatasi "dosya deposu hacmi yok: $STORVOL"; return 1; }
  pgimg=$(docker inspect -f '{{.Config.Image}}' "$("${DC[@]}" ps -q postgres)" 2>/dev/null)
  pgimg=${pgimg:-postgres:17}
  tar_out=$(docker run --rm --entrypoint bash -e "SOD_SAHIP=$(id -u):$(id -g)" -v "$STORVOL:/data:ro" -v "$IS:/yedek" \
    -v "$PLATFORM/scripts:/betik:ro" "$pgimg" -c 'bash /betik/yedek-kap.sh tar-al /data /yedek/dosyalar.tar.gz && chown "$SOD_SAHIP" /yedek/dosyalar.tar.gz' 2>&1) ||
    { yedek_hatasi "dosya deposu yedeklenemedi: $(printf '%s' "$tar_out" | tail -n 3)"; return 1; }
  adet=$(printf '%s\n' "$tar_out" | sed -n 's/^DOSYA \([0-9][0-9]*\)$/\1/p' | tail -n 1)
  bayt=$(printf '%s\n' "$tar_out" | sed -n 's/^BAYT \([0-9][0-9]*\)$/\1/p' | tail -n 1)
  is_uint "${adet:-}" && [ -s "$IS/dosyalar.tar.gz" ] || { yedek_hatasi "dosya arşivi sayılamadı"; return 1; }
  tar_sha=$(sha256sum "$IS/dosyalar.tar.gz" | cut -d ' ' -f 1)

  # Sırlar: .env (parolalar, imza ve dosya bağlantısı anahtarları); onsuz yedek geri kurulamaz.
  (umask 077 && mkdir "$IS/sirlar") || { yedek_hatasi "sirlar klasörü açılamadı"; return 1; }
  cp "$ENV_FILE" "$IS/sirlar/.env" && chmod 600 "$IS/sirlar/.env" || { yedek_hatasi ".env kopyalanamadı"; return 1; }
  env_sha=$(sha256sum "$ENV_FILE" | cut -d ' ' -f 1)
  [ "$(sha256sum "$IS/sirlar/.env" | cut -d ' ' -f 1)" = "$env_sha" ] || { yedek_hatasi ".env kopyası tutmuyor"; return 1; }
  keys_dir=${SOD_KEYS_DIR:-$(env_get SOD_KEYS_DIR)}
  keys_dir=$(mutlak "${keys_dir:-keys}")
  if [ -d "$keys_dir" ] && [ -n "$(ls -A "$keys_dir" 2>/dev/null)" ]; then
    cp -R "$keys_dir" "$IS/sirlar/keys" 2>/dev/null || uyari "keys/ kopyalanamadı ($keys_dir); üretimde imza anahtarı .env'de"
  fi

  # Künye en son yazılır: künyesi olmayan klasör yarım sayılır (yedekle.ps1 ile aynı alanlar, tur farklı).
  {
    printf '{\n'
    printf '  "surum": 1,\n  "tur": "guncelle-oncesi",\n'
    printf '  "ad": %s,\n  "olusturma": %s,\n' "$(json_str "$ad")" "$(json_str "$(date -Iseconds)")"
    printf '  "bilgisayar": %s,\n  "proje": %s,\n' "$(json_str "$(hostname 2>/dev/null)")" "$(json_str "$PROJECT")"
    printf '  "commit": %s,\n  "hedef": %s,\n' "$(json_str "$ONCEKI")" "$(json_str "$HEDEF_SHA")"
    printf '  "postgres": %s,\n  "imaj": %s,\n' "$(json_str "$pg_surum")" "$(json_str "$pgimg")"
    printf '  "gocler": { %s },\n' "$gocler"
    printf '  "veritabani": { "dosya": "veritabani.dump", "sha256": "%s", "bayt": %s, "tablolar": {' "$sha" "$(wc -c <"$IS/veritabani.dump" | tr -d ' ')"
    awk -F '\t' '{ gsub(/\\/, "\\\\", $1); gsub(/"/, "\\\"", $1); printf "%s \"%s\": %d", (NR > 1 ? "," : ""), $1, $2; t += $2 } END { printf " }, \"satir\": %d },\n", t }' "$IS/tablolar.tsv"
    printf '  "dosyalar": { "dosya": "dosyalar.tar.gz", "sha256": "%s", "bayt": %s, "adet": %s, "icerikBayt": %s, "hacim": %s },\n' \
      "$tar_sha" "$(wc -c <"$IS/dosyalar.tar.gz" | tr -d ' ')" "$adet" "${bayt:-0}" "$(json_str "$STORVOL")"
    printf '  "sirlar": { "env": true, "envSha256": "%s" }\n}\n' "$env_sha"
  } >"$IS/yedek.json" || { yedek_hatasi "künye yazılamadı"; return 1; }
  mv "$IS" "$UPDATE_DIR/$ad" || { yedek_hatasi "yedek klasörünün adı verilemedi: $IS"; return 1; }
  IS=
  YEDEK=$UPDATE_DIR/$ad
  yaz "Yedek hazır: $YEDEK ($(du -sh "$YEDEK" 2>/dev/null | cut -f 1); $(awk -F '\t' 'END { print NR }' "$YEDEK/tablolar.tsv") tablo, $adet dosya)"

  # Saklama: son KEEP güncelleme yedeği; yeni alınan hep kalır. Gece yedeklerine (SOD_BACKUP_DIR kökü) dokunulmaz.
  local eskiler i sil
  mapfile -t eskiler < <(yedek_klasorleri)
  sil=$((${#eskiler[@]} - KEEP))
  for ((i = 0; i < sil; i++)); do
    [ "${eskiler[i]}" = "$YEDEK" ] && continue
    rm -rf "${eskiler[i]}" && yaz "Eski güncelleme yedeği silindi: ${eskiler[i]##*/}"
  done
  return 0
}

# ---------- açılış ve denetim ----------

surume_gec() {
  G -c advice.detachedHead=false checkout --quiet --detach "$1" || {
    hata "git checkout $1 başarısız"
    return 1
  }
}

ac() { "${DC[@]}" up -d --wait --wait-timeout "$WAIT_TIMEOUT" --remove-orphans; }

# Tek seferlik kaplar (*-migrate, *-upgrade) 0 ile bitmiş olmalı.
goc_denetle() {
  local out bad=0 n=0 svc state code
  out=$("${DC[@]}" ps -a --format '{{.Service}}|{{.State}}|{{.ExitCode}}' 2>&1) || {
    hata "kap listesi alınamadı: $out"
    return 1
  }
  while IFS='|' read -r svc state code; do
    case "$svc" in
      *-migrate | *-upgrade)
        n=$((n + 1))
        if [ "$state" = exited ] && [ "$code" = 0 ]; then
          yaz "  $svc: tamam"
        else
          hata "$svc: $state (çıkış ${code:-?}); günlük: $DC_YAZI logs $svc"
          bad=1
        fi
        ;;
    esac
  done <<<"$out"
  [ "$n" -gt 0 ] || {
    hata "göç kabı bulunamadı"
    return 1
  }
  return $bad
}

# scripts/ayakta-mi.sh: sağlık uçları, site ve kaplar tutmalı; disk satırı yalnız uyarıdır, yedek yaşına bakılmaz.
saglik() {
  local i out kod sorun
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    out=$(SOD_COMPOSE_PROJECT="$PROJECT" SOD_BACKUP_MAX_AGE_HOURS=0 SOD_CHECK_URL="$CHECK_URL" SOD_CHECK_SITE_URL="$CHECK_SITE_URL" \
      SOD_CHECK_LOG= bash "$PLATFORM/scripts/ayakta-mi.sh" 2>&1)
    kod=$?
    sorun=$(printf '%s\n' "$out" | grep -E ' SORUN (sağlık|site|kap)')
    if [ "$kod" -ne 2 ] && [ -z "$sorun" ]; then
      printf '%s\n' "$out" | grep -E ' SORUN ' | sed 's/^[^ ]* SORUN /  UYARI: /'
      yaz "  sağlık tamam ($i. deneme)"
      return 0
    fi
    if [ "$i" -lt "$HEALTH_TRIES" ]; then
      yaz "  henüz değil ($i/$HEALTH_TRIES): $(printf '%s\n' "${sorun:-$out}" | head -n 1 | sed 's/^[^ ]* //')"
      sleep "$HEALTH_WAIT"
    fi
  done
  hata "sağlık denetimi tutmadı:"
  printf '%s\n' "$out" | grep -vE ' (TAMAM|ATLANDI) ' | sed 's/^/  /'
  return 1
}

goclu_durus() {
  hata "yeni sürüm açılmadı ve aradaki sürümlerde veritabanı göçü var:"
  printf '%s\n' "$GOCLER" | sed 's/^/  /'
  yaz "Göç geri alınamaz; betik eski sürüme kendiliğinden dönmedi. Kod $HEDEF_KISA'da, veritabanı yeni şemaya geçmiş olabilir."
  yaz "Ne yapılır (docs/KURULUM.md \"Güncelleme\" > \"Göçlü sürüm açılmazsa\"):"
  yaz "  1. Günlüklere bakın: $DC_YAZI ps -a; $DC_YAZI logs --tail 200 <servis>"
  yaz "  2. Önerilen: hatayı düzelten yeni sürümle ileri gidin: bash scripts/guncelle.sh <yeni sürüm>"
  yaz "  3. Olmazsa yedekten dönüş (yedekten sonra yazılan veri gider): yedek ${YEDEK:-yok}, eski sürüm $ONCEKI_KISA"
}

geri_don() {
  adim "Geri dönüş"
  if [ "$YON" = ayni ]; then
    hata "aynı sürüm yeniden kuruldu ve açılmadı; dönülecek eski sürüm yok."
    yaz "Günlükler: $DC_YAZI ps -a; $DC_YAZI logs --tail 200 <servis>. Son .env değişikliğini geri alıp yeniden deneyin."
    [ "$ILK" = 1 ] && yaz "İlk açılışta sağlık $CHECK_URL üzerinden denetlenir: DNS kaydı bu sunucuyu gösteriyor mu, 80 ve 443 açık mı (Caddy sertifikası: $DC_YAZI logs caddy)? Yeniden çalıştırmak güvenlidir."
    return 3
  fi
  if [ -n "$GOCLER" ]; then
    goclu_durus
    return 3
  fi
  yaz "Göç farkı yok: $ONCEKI_KISA yeniden kuruluyor."
  if surume_gec "$ONCEKI" && "${DC[@]}" build && ac && goc_denetle && saglik; then
    yaz "Eski sürüme dönüldü ($ONCEKI_KISA). Yeni sürüm ($HEDEF, $HEDEF_KISA) açılmadı; günlükler: $DC_YAZI logs <servis>"
    return 1
  fi
  hata "eski sürüm de açılmadı; elle bakın: $DC_YAZI ps -a; yedek ${YEDEK:-yok}"
  return 3
}

gecmis() { # sonuç
  printf '%s %s %s -> %s %s yedek=%s\n' "$(date -Iseconds)" "$1" "$ONCEKI_KISA" "$HEDEF_KISA" "$HEDEF" "${YEDEK:-yok}" >>"$UPDATE_DIR/gecmis.log" 2>/dev/null
  return 0
}

duyur() {
  local u kod=0
  if [ "$ILK" = 1 ]; then
    adim "Firmalar araçlara duyuruluyor (org-announce)"
    "${DC[@]}" exec -T account-api node dist/org-announce.js || kod=4
  fi
  for u in $DUYUR; do
    adim "Üyeler $u aracına duyuruluyor (members-announce)"
    "${DC[@]}" exec -T account-api node dist/members-announce.js "$u" || kod=4
  done
  [ "$kod" = 0 ] || hata "duyuru tutmadı; güncelleme tamam. Yeniden çalıştırmak zararsız: $DC_YAZI exec account-api node dist/<org-announce|members-announce>.js"
  return $kod
}

main() {
  KURU=0 ILK=0 GERI=0 DUYUR='' HEDEF='' YEDEK='' IS=''
  while [ $# -gt 0 ]; do
    case "$1" in
      -n | --kuru | --dry-run) KURU=1 ;;
      --ilk-kurulum) ILK=1 ;;
      --geri) GERI=1 ;;
      --uyelik-duyur)
        [ $# -ge 2 ] || kullanim_hatasi "--uyelik-duyur ürün adı ister (ör. deciship)"
        DUYUR+=" ${2//,/ }"
        shift
        ;;
      --uyelik-duyur=*) DUYUR+=" $(printf '%s' "${1#*=}" | tr ',' ' ')" ;;
      -h | --help)
        yardim
        exit 0
        ;;
      -*) kullanim_hatasi "bilinmeyen seçenek: $1" ;;
      *)
        [ -z "$HEDEF" ] || kullanim_hatasi "tek sürüm verilir: $HEDEF $1"
        HEDEF=$1
        ;;
    esac
    shift
  done
  local u
  for u in $DUYUR; do
    [[ $u =~ ^[a-z][a-z0-9-]{1,30}$ ]] || kullanim_hatasi "geçersiz ürün adı: $u"
  done
  if [ -z "$HEDEF" ]; then
    [ "$ILK" = 1 ] || kullanim_hatasi "sürüm gerekli: etiket ya da commit (ör. bash scripts/guncelle.sh v1.2.0)"
    HEDEF=HEAD
  fi
  [ "$ILK" = 1 ] && [ "$GERI" = 1 ] && kullanim_hatasi "--ilk-kurulum ile --geri birlikte kullanılmaz"

  ayarlar
  CHECK_URL=${SOD_CHECK_URL:-$(env_get APP_BASE_URL)}
  CHECK_URL=${CHECK_URL:-http://127.0.0.1:8088}
  CHECK_SITE_URL=${SOD_CHECK_SITE_URL:-$(env_get SITE_BASE_URL)}
  CHECK_SITE_URL=${CHECK_SITE_URL:-http://127.0.0.1:8089}
  [ "$CHECK_SITE_URL" = off ] || CHECK_SITE_URL=${CHECK_SITE_URL%/}/
  on_denetim
  [ "$KURU" = 1 ] || kilit_al
  surum_sec
  plan_yaz
  if [ "$KURU" = 1 ]; then
    yaz ""
    yaz "Kuru çalışma: hiçbir şey değişmedi."
    return 0
  fi

  adim "1/6 Yedek"
  if [ "$ILK" = 1 ] && ! docker volume inspect "$PGVOL" >/dev/null 2>&1; then
    yaz "İlk kurulum: veritabanı hacmi ($PGVOL) yok, yedek atlandı."
  elif [ "$ILK" = 0 ] && ! docker volume inspect "$PGVOL" >/dev/null 2>&1; then
    hata "veritabanı hacmi ($PGVOL) yok: sistem kurulmamış görünüyor (ilk kurulum: bash scripts/kurulum.sh)."
    return 2
  elif ! yedek_al; then
    hata "yedek alınamadı; güncelleme başlamadı, hiçbir şey değişmedi."
    return 2
  fi

  adim "2/6 Sürüm"
  if [ "$YON" = ayni ]; then
    yaz "Kod zaten $HEDEF_KISA; değişmeden yeniden kurulur."
  else
    surume_gec "$HEDEF_SHA" || return 2
    yaz "Kod: $ONCEKI_KISA → $HEDEF_KISA"
  fi

  adim "3/6 Derleme"
  if ! "${DC[@]}" build; then
    hata "derleme başarısız; çalışan kaplara dokunulmadı."
    if [ "$YON" != ayni ]; then
      yaz "Kod ve imajlar $ONCEKI_KISA'ya döndürülüyor..."
      if ! surume_gec "$ONCEKI" || ! "${DC[@]}" build; then
        hata "eski sürümün imajları yeniden derlenemedi: kaplar eski hâliyle çalışıyor ama bir sonraki 'up' yeni imajı alabilir; elle bakın."
        gecmis derleme-hatasi-geri-donulemedi
        return 3
      fi
    fi
    gecmis derleme-hatasi
    return 1
  fi

  adim "4/6 Açılış"
  local acildi=0 gocler_tamam=0
  ac && acildi=1
  adim "5/6 Göç denetimi"
  goc_denetle && gocler_tamam=1
  adim "6/6 Sağlık"
  if [ "$acildi" = 1 ] && [ "$gocler_tamam" = 1 ] && saglik; then
    local kod=0
    duyur || kod=4
    gecmis "$([ "$kod" = 0 ] && echo tamam || echo tamam-duyuru-hatasi)"
    yaz ""
    yaz "Güncelleme tamam: $HEDEF ($HEDEF_KISA).${YEDEK:+ Önceki hâlin yedeği: $YEDEK}"
    return $kod
  fi
  [ "$acildi" = 1 ] || hata "up -d --wait tutmadı (bir kap sağlıklı açılmadı ya da göç kabı hata verdi)"
  [ "$acildi" = 1 ] && [ "$gocler_tamam" = 1 ] || yaz "(sağlık denetimi atlandı)"
  geri_don
  local kod=$?
  gecmis "$([ "$kod" = 1 ] && echo geri-donuldu || echo elle-bakilmali)"
  return $kod
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
