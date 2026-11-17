#!/usr/bin/env bash
# Yedek ve geri yükleme betiklerinin kap içindeki adımları (yedekle.ps1, geri-yukle.ps1 çağırır; elle çalıştırılmaz).
# postgres:17 imajında bash ile koşar: Postgres kabına `docker cp` ile kopyalanır ya da `docker run` kabına salt okunur bağlanır.
# PowerShell 5.1 tırnaklı bağımsız değişkenleri bozduğu için kabuk işleri burada durur.
#   say DÖKÜM          dökümdeki her tablonun satır sayısı ("tablo<TAB>sayı"); dökümün tamamını okur (açılabiliyor mu denetimi)
#   say-db VERİTABANI  aynı biçimde, veritabanındaki tablolar
#   geri DÖKÜM VERİTABANI
#                      dökümdeki şemaları (içindekiler tablosundan) tek işlemde silip dökümden yeniden kurar;
#                      hata olursa hiçbir şey değişmez
#   rol-parola VERİTABANI
#                      süper kullanıcının ve her kiracı rolünün (veritabanındaki sod_<k>, sod_<k>_admin) parolasını ortamdaki
#                      SOD_*_PASSWORD değerleriyle eşitler (yoksa compose'un geliştirme varsayılanı)
#   tar-al KAYNAK ARŞİV  KAYNAK içeriğini ARŞİV'e (tar.gz) yazar; "DOSYA <n>" ve "BAYT <n>" arşivin kendisinden sayılır
#   tar-ac ARŞİV HEDEF [temizle]
#                      arşivi önce HEDEF içinde geçici klasöre açar, dosya sayısı arşivle tutarsa yerine taşır
#                      (temizle: HEDEF'in eski içeriği ancak o zaman silinir); "DOSYA <n>" ve "BAYT <n>" HEDEF'ten sayılır
#   sha DOSYA          SHA-256
set -euo pipefail

komut=${1:-}
[ -n "$komut" ] || { echo "kullanım: yedek-kap.sh say|say-db|geri|rol-parola|tar-al|tar-ac|sha ..." >&2; exit 2; }
shift
PGU=${POSTGRES_USER:-postgres}

# Arşivdeki düz dosyaların sayısı ve toplam boyu (GNU tar -tv: "-rw-r--r-- kullanıcı/grup BOY TARİH SAAT AD").
arsiv_say() { tar -tzvf "$1" | awk '$1 ~ /^-/ { n++; s += $3 } END { printf "%d %.0f\n", n, s }'; }
klasor_say() { find "$1" -type f -printf '%s\n' | awk '{ n++; s += $1 } END { printf "%d %.0f\n", n, s }'; }

case "$komut" in
  say)
    dokum=$1
    # pg_restore yarıda kalırsa son satıra işaret düşer; işaret görülünce çıkış 3.
    { pg_restore -a -f - "$dokum" || echo "__SOD_PG_RESTORE_HATA__"; } | awk '
      /^__SOD_PG_RESTORE_HATA__$/ { hata = 1; next }
      ic && /^\\\.$/ { printf "%s\t%d\n", ad, n; ic = 0; tablo++; next }
      ic { n++; next }
      /^COPY / { ad = $2; n = 0; ic = 1; next }
      END { if (hata || ic) exit 3; if (tablo == 0) exit 4 }
    '
    ;;
  say-db)
    db=$1
    psql -U "$PGU" -d "$db" -v ON_ERROR_STOP=1 -AtF "$(printf '\t')" -c "
      SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
      ORDER BY 1"
    ;;
  geri)
    dokum=$1
    db=$2
    on=/tmp/sod-geri-on.sql
    govde=/tmp/sod-geri-govde.sql
    trap 'rm -f "$on" "$govde"' EXIT
    # İçindekiler satırı: "5; 2615 16390 SCHEMA - deciship sahip". public dökümde şema olarak yer almaz.
    semalar=$(pg_restore -l "$dokum" | awk '$4 == "SCHEMA" && $5 == "-" && $6 != "public" { print $6 }')
    [ -n "$semalar" ] || { echo "dökümde şema yok" >&2; exit 6; }
    : > "$on"
    for s in $semalar; do
      case "$s" in *[!a-z0-9_]*) echo "beklenmeyen şema adı: $s" >&2; exit 6 ;; esac
      printf 'DROP SCHEMA IF EXISTS %s CASCADE;\n' "$s" >> "$on"
    done
    pg_restore -f "$govde" "$dokum"
    # Uygulama bağlantıları durdurulmuş olmalı; kalan oturumlar (psql vb.) kesilir.
    psql -U "$PGU" -d "$db" -v ON_ERROR_STOP=1 -q -At -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()" > /dev/null
    # -1: iki dosya tek işlem; ilk hatada geri alınır.
    psql -U "$PGU" -d "$db" -v ON_ERROR_STOP=1 -q -1 -f "$on" -f "$govde" > /dev/null
    echo "SEMA $(echo $semalar)"
    ;;
  rol-parola)
    db=$1
    # Roller veritabanından okunur (elle liste yok): kiracı rolleri sod_<k> ve sod_<k>_admin, <k> şeması varsa.
    # Eski ortak rol sod_admin şeması olmadığından girmez. Değerler ortamdan gelir (docker exec -e AD; geri-yukle.ps1):
    # SOD_POSTGRES_PASSWORD, SOD_<K>_DB_PASSWORD, SOD_<K>_ADMIN_DB_PASSWORD. psql değeri \getenv ile ortamdan okur:
    # parola hiçbir komut satırına (/proc/*/cmdline) ve sunucu günlüğüne düşmez.
    # SOD_ENV=production: değeri olmayan ya da *_dev değerli rol varsa hiçbir parola değişmez, betik durur.
    # Üretim dışında değeri olmayan rol compose'un geliştirme varsayılanını (<rol>_dev) alır.
    uretim=0
    [ "${SOD_ENV:-}" = production ] && uretim=1
    roller=$(psql -U "$PGU" -d "$db" -v ON_ERROR_STOP=1 -At -c "
      SELECT rolname FROM pg_roles
      WHERE rolname ~ '^sod_[a-z][a-z0-9]{2,19}(_admin)?$'
        AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = regexp_replace(substr(rolname, 5), '_admin$', ''))
      ORDER BY 1")
    [ -n "$roller" ] || { echo "kiracı rolü bulunamadı" >&2; exit 7; }
    sql=$'SET log_statement = \'none\';\nSET log_min_error_statement = panic;\nSET log_min_duration_statement = -1;\nBEGIN;'
    eksik=""
    gelistirme=""
    for cift in "SOD_POSTGRES_PASSWORD:postgres:sod_postgres_dev" $(for r in $roller; do
      printf 'SOD_%s_DB_PASSWORD:%s:%s_dev\n' "$(printf '%s' "${r#sod_}" | tr '[:lower:]' '[:upper:]')" "$r" "$r"; done); do
      ad=${cift%%:*}; kalan=${cift#*:}; r=${kalan%%:*}; varsayilan=${kalan#*:}
      deger=${!ad:-}
      if [ -z "$deger" ]; then
        if [ "$uretim" = 1 ]; then eksik="$eksik $ad"; continue; fi
        sql+=$'\n'"\\set sod__p '$varsayilan'"
      else
        case "$deger" in *_dev) [ "$uretim" = 1 ] && gelistirme="$gelistirme $ad" ;; esac
        sql+=$'\n'"\\getenv sod__p $ad"
      fi
      sql+=$'\n'"ALTER ROLE $r PASSWORD :'sod__p';"
    done
    if [ -n "$eksik$gelistirme" ]; then
      [ -n "$eksik" ] && echo "üretimde değeri olmayan parola:$eksik" >&2
      [ -n "$gelistirme" ] && echo "üretimde geliştirme parolası (*_dev):$gelistirme" >&2
      echo "hiçbir parola değiştirilmedi" >&2
      exit 8
    fi
    sql+=$'\nCOMMIT;'
    printf '%s\n' "$sql" | psql -X -U "$PGU" -d "$db" -v ON_ERROR_STOP=1 -q
    echo "ROL tamam"
    ;;
  tar-al)
    kaynak=$1
    arsiv=$2
    # Gece de yazılabilir: okurken değişen dosya için GNU tar 1 döner, arşiv yine geçerlidir.
    set +e
    tar -czf "$arsiv" --warning=no-file-changed -C "$kaynak" .
    kod=$?
    set -e
    [ "$kod" -le 1 ] || exit "$kod"
    read -r n s < <(arsiv_say "$arsiv")
    printf 'DOSYA %d\nBAYT %s\n' "$n" "$s"
    ;;
  tar-ac)
    arsiv=$1
    hedef=$2
    gecici="$hedef/.sod-geri-yukleme"
    # Yarıda kalırsa (bozuk arşiv) geçici klasör silinir, eski içerik olduğu gibi kalır.
    trap 'rm -rf "$gecici"' EXIT
    rm -rf "$gecici"
    mkdir -p "$gecici"
    tar -xzf "$arsiv" -C "$gecici"
    read -r beklenen _ < <(arsiv_say "$arsiv")
    read -r acilan _ < <(klasor_say "$gecici")
    if [ "$acilan" != "$beklenen" ]; then
      rm -rf "$gecici"
      echo "açılan $acilan dosya, arşivde $beklenen; eski içerik yerinde bırakıldı" >&2
      exit 5
    fi
    if [ "${3:-}" = "temizle" ]; then
      find "$hedef" -mindepth 1 -maxdepth 1 ! -name .sod-geri-yukleme -exec rm -rf {} +
    fi
    find "$gecici" -mindepth 1 -maxdepth 1 -exec mv -t "$hedef" {} +
    rmdir "$gecici"
    read -r n s < <(klasor_say "$hedef")
    printf 'DOSYA %d\nBAYT %s\n' "$n" "$s"
    ;;
  sha)
    sha256sum "$1" | cut -d ' ' -f 1
    ;;
  *)
    echo "bilinmeyen komut: $komut" >&2
    exit 2
    ;;
esac
