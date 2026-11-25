#!/usr/bin/env bash
# init.sql ve upgrade.sql'i gerçek yoluyla (docker-entrypoint) tek kullanımlık kaplarda sınar. Var olan hacme ve yığına dokunmaz:
# kaplar --rm ile açılır, adları sod-init-verify-<pid>-*, bitişte (hata olsa da) anonim hacimleriyle silinir.
#   bash infra/postgres/verify.sh [KLASÖR]
# KLASÖR: init.sql ve upgrade.sql'in durduğu yer (varsayılan bu klasör; geçici kayıtla üretilmişi denemek için başka klasör).
# SOD_VERIFY_OLD_INIT=<dosya>: hacim önce bu eski init.sql ile kurulur, sonra KLASÖR/upgrade.sql çalışır (var olan hacme yeni araç);
# bu yolda üretim bölümüne "eski hacim + üretim + yeni araç" senaryosu da eklenir.
# Kiracılar (şema + sod_<k>_admin + sod_<k>) init.sql'deki "-- @sod-schemas" satırından okunur; liste elle yazılmaz.
# Bütün bağlantılar kabın kendi IP adresine gider: imajın pg_hba'sı 127.0.0.1 ve yerel soketi parolasız (trust) kabul eder,
# IP üzerinden scram-sha-256 ister. Böylece parola gerçekten sınanır.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "${1:-$HERE}" && pwd)"
C=sod-init-verify-$$
IMAGE=postgres:17
FAIL=0
check() { # açıklama beklenen gerçek
  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "HATA  $1: beklenen [$2], gelen [$3]"; FAIL=$((FAIL + 1)); fi
}
cleanup() { docker rm -f -v "$C" "$C-prod" "$C-prodok" "$C-prodold" >/dev/null 2>&1; }
trap cleanup EXIT

SCHEMAS="$(sed -n 's/^-- @sod-schemas //p' "$DIR/init.sql" | tr -d '\r')"
[ -n "$SCHEMAS" ] || { echo "HATA init.sql içinde '-- @sod-schemas' satırı yok"; exit 1; }
case " $SCHEMAS " in *" platform "*) ;; *) echo "HATA şema listesinde platform yok: $SCHEMAS"; exit 1 ;; esac
echo "kiracılar: $SCHEMAS"

mnt() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
export MSYS_NO_PATHCONV=1
INIT_MOUNT="$(mnt "$DIR/init.sql")"
FIRST_INIT="$INIT_MOUNT"
OLD="${SOD_VERIFY_OLD_INIT:-}"
[ -n "$OLD" ] && FIRST_INIT="$(mnt "$(cd "$(dirname "$OLD")" && pwd)/$(basename "$OLD")")"
# upgrade.sql'in okuduğu klasör (init.sql'in hak bölümü, dev-parola.sh). Başka klasörde dev-parola.sh yoksa buradakinin kopyası bağlanır.
DEVP="$DIR/dev-parola.sh"; [ -f "$DEVP" ] || DEVP="$HERE/dev-parola.sh"
INFRA=(-v "$(mnt "$DIR/init.sql"):/infra/postgres/init.sql:ro" -v "$(mnt "$DIR/upgrade.sql"):/infra/postgres/upgrade.sql:ro"
  -v "$(mnt "$DEVP"):/infra/postgres/dev-parola.sh:ro")
KAP_BETIK=(-v "$(mnt "$HERE/../../scripts/yedek-kap.sh"):/betik/yedek-kap.sh:ro")

upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }
dev_pw() { echo "$1_dev"; }
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
ROLES="$(for s in $SCHEMAS; do echo "sod_${s}_admin"; echo "sod_$s"; done)"
# Üretim denemesinin "gerçek" parolası: rol başına farklı, *_dev değil.
real_pw() { echo "gercek-$1-p4r0la"; }
real_env() { # -e SOD_<K>[_ADMIN]_DB_PASSWORD=<gerçek> her kiracı için (verilen şemalar)
  local s
  for s in "$@"; do printf -- '-e\nSOD_%s_ADMIN_DB_PASSWORD=%s\n-e\nSOD_%s_DB_PASSWORD=%s\n' \
    "$(upper "$s")" "$(real_pw "sod_${s}_admin")" "$(upper "$s")" "$(real_pw "sod_$s")"; done
}

wait_ready() { # kap süper-kullanıcı-parolası: IP üzerinden giriş (kurulum sırasındaki geçici sunucu yalnız soketi dinler)
  local ip
  for _ in $(seq 1 90); do
    ip="$(ip_of "$1")"
    if [ -n "$ip" ] && docker exec -e PGPASSWORD="$2" "$1" psql -h "$ip" -U postgres -d sellerondata -Atc 'select 1' >/dev/null 2>&1; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != "true" ]; then return 1; fi
    sleep 1
  done
  return 1
}
qk() { docker exec -e PGPASSWORD="$4" "$1" psql -h "$(ip_of "$1")" -U "$2" -d "$3" -Atc "$5" 2>&1; } # kap rol db parola sql
q() { qk "$C" "$@"; }
sq() { q postgres sellerondata su "$1"; }
login() { # kap rol parola -> "giriş" ya da "ret"
  if docker exec -e PGPASSWORD="$3" "$1" psql -h "$(ip_of "$1")" -U "$2" -d sellerondata -Atc 'select 1' >/dev/null 2>&1; then echo giriş; else echo ret; fi
}
denied() { # rol db parola sql -> "denied" ya da çıktı
  local out; out="$(q "$1" "$2" "$3" "$4")"
  case "$out" in *"permission denied"*|*"must be owner"*) echo denied ;; *) echo "$out" ;; esac
}
catalog() { # rollerin, hakların ve varsayılanların dökümü (parolasız); yükseltmenin bir şey değiştirmediğini karşılaştırmak için
  # \restrict satırındaki anahtar her dökümde rastgeledir, karşılaştırmaya girmez.
  docker exec -e PGPASSWORD=su "$C" pg_dumpall -h "$(ip_of "$C")" -U postgres --no-role-passwords --schema-only 2>&1 \
    | sed -e '/^--/d' -e '/^$/d' -e '/^.restrict /d' -e '/^.unrestrict /d'
}
run_upgrade() { # kap süper-parola [-e AD=DEĞER ...]
  # Kabın kendi ortamı (docker run -e ile verilen parolalar) temizlenir: upgrade.sql yalnız verilen değerleri görür,
  # compose'daki ayrı postgres-upgrade kabı gibi.
  local k="$1" su="$2" vars=(); shift 2
  while [ $# -gt 0 ]; do [ "$1" = -e ] && shift; vars+=("$1"); shift; done
  docker exec "$k" env -i PATH=/usr/local/bin:/usr/bin:/bin PGPASSWORD="$su" "${vars[@]}" \
    psql -h "$(ip_of "$k")" -U postgres -d sellerondata -v ON_ERROR_STOP=1 -q -f /infra/postgres/upgrade.sql 2>&1
}
settings() { # kap süper-parola -> rol|veritabanı|ayarlar, sıralı
  qk "$1" postgres sellerondata "$2" "select pg_get_userbyid(setrole) || '|' || setdatabase || '|' || setconfig::text from pg_db_role_setting where pg_get_userbyid(setrole) like 'sod\_%' order by 1"
}
EXPECTED_SETTINGS="$(for s in $SCHEMAS; do echo "sod_$s|0|{\"search_path=$s, pg_temp\",TimeZone=UTC}"; echo "sod_${s}_admin|0|{\"search_path=$s, pg_temp\"}"; done | sort)"

echo "== geliştirme kurulumu =="
docker run -d --rm --name "$C" -e POSTGRES_PASSWORD=su \
  -v "$FIRST_INIT:/docker-entrypoint-initdb.d/01-init.sql:ro" "${INFRA[@]}" "$IMAGE" >/dev/null
wait_ready "$C" su || { docker logs "$C" 2>&1 | tail -20; echo "HATA kurulum tamamlanmadı"; exit 1; }
if [ -n "$OLD" ]; then
  echo "== eski kurulum + upgrade.sql =="
  out="$(run_upgrade "$C" su)"; code=$?
  check "upgrade.sql eski hacimde hatasız" 0 "$code"
  [ "$code" = 0 ] || echo "$out" | tail -5
fi

check "parola sınanıyor: süper kullanıcı yanlış parolayla IP üzerinden giremez" ret "$(login "$C" postgres yanlis)"
check "sellerondata sahibi süper kullanıcı" "postgres" "$(sq "select pg_get_userbyid(datdba) from pg_database where datname='sellerondata'")"
check "sod_admin yok" "0" "$(sq "select count(*) from pg_roles where rolname='sod_admin'")"
check "hiçbir rolde CREATEDB, CREATEROLE, BYPASSRLS, SUPERUSER, REPLICATION yok" "0" "$(sq "select count(*) from pg_roles where rolname like 'sod\_%' and (rolcreatedb or rolcreaterole or rolbypassrls or rolsuper or rolreplication)")"
check "sod_ rolleri hiçbir role üye değil, hiçbir rol onlara üye değil" "0" "$(sq "select count(*) from pg_auth_members m join pg_roles a on a.oid=m.roleid join pg_roles b on b.oid=m.member where a.rolname like 'sod\_%' or b.rolname like 'sod\_%'")"
check "sod_ rolleri tam olarak kiracıların iki rolü" "$(echo "$ROLES" | sort | tr '\n' ' ')" "$(sq "select rolname from pg_roles where rolname like 'sod\_%' order by 1" | sort | tr '\n' ' ')"
check "sellerondata'da kiracı ve sistem dışı şema yok" "$(echo $SCHEMAS public | tr ' ' '\n' | sort | tr '\n' ' ')" \
  "$(sq "select nspname from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema' order by 1" | sort | tr '\n' ' ')"
check "public şemasında kimsenin hakkı yok (yalnız sahibi)" "0" "$(sq "select count(*) from pg_roles r where r.rolname like 'sod\_%' and (has_schema_privilege(r.oid, 'public', 'USAGE') or has_schema_privilege(r.oid, 'public', 'CREATE'))")"
check "kiracı şema adlarından hiçbiri Postgres ayrılmış sözcüğü değil" "0" "$(sq "select count(*) from pg_get_keywords() where catcode in ('R','T') and word in ($(for s in $SCHEMAS; do printf "'%s'," "$s"; done | sed 's/,$//'))")"
check "rol ayarları tam olarak search_path (+ uygulama rolünde UTC), veritabanına özel ayar yok" "$EXPECTED_SETTINGS" "$(settings "$C" su | sort)"

for s in $SCHEMAS; do
  A="sod_${s}_admin"; U="sod_$s"; AP="$(dev_pw "$A")"; UP="$(dev_pw "$U")"
  check "$s şeması sahibi" "$A" "$(sq "select pg_get_userbyid(nspowner) from pg_namespace where nspname='$s'")"
  check "$U search_path" "$s, pg_temp" "$(q "$U" sellerondata "$UP" 'show search_path')"
  check "$A search_path" "$s, pg_temp" "$(q "$A" sellerondata "$AP" 'show search_path')"
  check "$U saat dilimi" "UTC" "$(q "$U" sellerondata "$UP" 'show timezone')"
  check "$U kendi şemasında CREATE hakkı yok" "f" "$(sq "select has_schema_privilege('$U', '$s', 'CREATE')")"
  for role in "$A:$AP" "$U:$UP"; do
    r="${role%%:*}"; p="${role##*:}"
    check "$r yanlış parolayla giremez" ret "$(login "$C" "$r" "yanlis-$p")"
    for db in postgres template1; do
      out="$(q "$r" "$db" "$p" 'select 1')"
      case "$out" in *"permission denied"*) out=denied ;; esac
      check "$r $db veritabanına bağlanamaz" denied "$out"
    done
    check "$r CREATE DATABASE yapamaz" denied "$(denied "$r" sellerondata "$p" 'create database x')"
    check "$r TEMP tablo açamaz" denied "$(denied "$r" sellerondata "$p" 'create temp table x(i int)')"
    check "$r public şemasına yazamaz" denied "$(denied "$r" sellerondata "$p" 'create table public.x(i int)')"
    check "$r yeni şema açamaz" denied "$(denied "$r" sellerondata "$p" 'create schema x')"
    check "$r büyük nesne açamaz" denied "$(denied "$r" sellerondata "$p" 'select lo_create(0)')"
    check "$r pg_notify çağıramaz" denied "$(denied "$r" sellerondata "$p" "select pg_notify('a','b')")"
  done
done

echo "== upgrade.sql: değişmeyen katalog, rol ayarlarının geri yazılması =="
if [ -z "$OLD" ]; then
  before="$(catalog)"
  check "katalog dökümünde her rol var (karşılaştırma boş değil)" "$(( $(echo $SCHEMAS | wc -w) * 2 ))" "$(echo "$before" | grep -c '^CREATE ROLE sod_')"
  out1="$(run_upgrade "$C" su)"; c1=$?
  out2="$(run_upgrade "$C" su)"; c2=$?
  check "upgrade.sql iki kez hatasız" "0 0" "$c1 $c2"
  [ "$c1$c2" = 00 ] || echo "$out1 $out2" | tail -5
  after="$(catalog)"
  if [ "$before" = "$after" ]; then check "yükseltme sonrası katalog aynı" 1 1
  else check "yükseltme sonrası katalog aynı" 1 0; diff <(echo "$before") <(echo "$after") | head -20; fi
fi
# Uygulama rolü kendi rol ayarını değiştirebilir (Postgres buna izin verir); upgrade.sql her koşuda baştan yazar.
U1="sod_$(echo $SCHEMAS | cut -d' ' -f1)"
q "$U1" sellerondata "$(dev_pw "$U1")" "alter role $U1 set search_path = public; alter role $U1 set row_security = off" >/dev/null
check "$U1 kendi ayarını değiştirebiliyor (denemenin ön koşulu)" "public" "$(q "$U1" sellerondata "$(dev_pw "$U1")" 'show search_path')"
out="$(run_upgrade "$C" su)"; code=$?
check "upgrade.sql sonrası rol ayarları yine tam olarak beklenen" "0|$EXPECTED_SETTINGS" "$code|$(settings "$C" su | sort)"

echo "== upgrade.sql: kayıtta olmayan boş sod_ rolü silinir, nesnesi ya da hakkı olan kalır =="
# Test kurulumunun rolleri gibi (product-kit sod_ornekarac*): hiçbir nesne ve hak yok. sod_eskiarac: bu veritabanında bağlanma
# hakkı var. sod_eskisahip: başka veritabanında tablosu var (pg_shdepend bütün veritabanlarını görür).
sq "create role sod_ornekarac_admin login password 'x'; create role sod_ornekarac login password 'x'; alter role sod_ornekarac set search_path = ornekarac; create role sod_eskiarac login password 'x'; grant connect on database sellerondata to sod_eskiarac; create role sod_eskisahip" >/dev/null
sq "create database sod_verify_baska" >/dev/null
q postgres sod_verify_baska su "create table t(i int); alter table t owner to sod_eskisahip" >/dev/null
out="$(run_upgrade "$C" su)"; code=$?
check "upgrade.sql kalıntı rollerle hatasız" 0 "$code"
[ "$code" = 0 ] || echo "$out" | tail -5
check "boş kalıntı roller silindi, nesnesi ya da hakkı olanlar kaldı, kiracı rolleri yerinde" \
  "$(printf '%s\n' $ROLES sod_eskiarac sod_eskisahip | sort | tr '\n' ' ')" "$(sq "select rolname from pg_roles where rolname like 'sod\_%' order by 1" | sort | tr '\n' ' ')"
check "silinen rolün ayarı da gitti" "$EXPECTED_SETTINGS" "$(settings "$C" su | sort)"
check "başka veritabanındaki tablo yerinde" "sod_eskisahip" "$(q postgres sod_verify_baska su "select pg_get_userbyid(relowner) from pg_class where relname = 't'")"
sq "drop database sod_verify_baska" >/dev/null
sq "revoke connect on database sellerondata from sod_eskiarac; drop role sod_eskiarac; drop role sod_eskisahip" >/dev/null
check "kalıntı denemesinden sonra sod_ rolleri yine tam olarak kiracıların iki rolü" "$(echo "$ROLES" | sort | tr '\n' ' ')" "$(sq "select rolname from pg_roles where rolname like 'sod\_%' order by 1" | sort | tr '\n' ' ')"
out="$(run_upgrade "$C" su -e SOD_ENV=production)"; code=$?
check "üretimde upgrade.sql, *_dev parolasıyla giren rol varsa durur" "durdu" "$([ "$code" != 0 ] && echo "$out" | grep -q 'geliştirme parolasıyla giriyor' && echo durdu || echo "çıkış $code: $(echo "$out" | tail -2 | tr '\n' ' ')")"

echo "== şemalar arası ayrım =="
for s in $SCHEMAS; do
  A="sod_${s}_admin"
  q "$A" sellerondata "$(dev_pw "$A")" "create table $s.gizli(i int); insert into $s.gizli values (1); create function $s.gizli_f() returns int language sql as 'select 1'" >/dev/null
done
for s in $SCHEMAS; do
  A="sod_${s}_admin"; U="sod_$s"; AP="$(dev_pw "$A")"; UP="$(dev_pw "$U")"
  check "$U kendi şemasını okur (default privileges)" "1" "$(q "$U" sellerondata "$UP" "select * from $s.gizli")"
  check "$U kendi şemasına yazar" "2" "$(q "$U" sellerondata "$UP" "with x as (insert into $s.gizli values (2) returning i) select i from x")"
  check "$U kendi işlevini çağırır" "1" "$(q "$U" sellerondata "$UP" "select $s.gizli_f()")"
  check "$U kendi şemasında DDL yapamaz" denied "$(denied "$U" sellerondata "$UP" "create table $s.x(i int)")"
  check "$U kendi tablosunu silemez (sahip değil)" denied "$(denied "$U" sellerondata "$UP" "drop table $s.gizli")"
  check "$U RLS'yi kapatamaz (sahip değil)" denied "$(denied "$U" sellerondata "$UP" "alter table $s.gizli no force row level security")"
  for o in $SCHEMAS; do
    [ "$o" = "$s" ] && continue
    check "$A $o okuyamaz" denied "$(denied "$A" sellerondata "$AP" "select * from $o.gizli")"
    check "$A $o içinde tablo açamaz" denied "$(denied "$A" sellerondata "$AP" "create table $o.x(i int)")"
    check "$U $o okuyamaz" denied "$(denied "$U" sellerondata "$UP" "select * from $o.gizli")"
    check "$U $o içine yazamaz" denied "$(denied "$U" sellerondata "$UP" "insert into $o.gizli values (9)")"
    check "$U $o işlevini çağıramaz" denied "$(denied "$U" sellerondata "$UP" "select $o.gizli_f()")"
  done
done
check "kiracı rolleri başka kiracının nesnesinde hiçbir hak taşımıyor" "0" "$(sq "
  select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace, pg_roles r
  where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname in ($(for s in $SCHEMAS; do printf "'%s'," "$s"; done | sed 's/,$//')) and r.rolname like 'sod\_%'
    and r.rolname not in ('sod_' || n.nspname, 'sod_' || n.nspname || '_admin')
    and (has_table_privilege(r.oid, c.oid, 'SELECT') or has_table_privilege(r.oid, c.oid, 'INSERT')
      or has_table_privilege(r.oid, c.oid, 'UPDATE') or has_table_privilege(r.oid, c.oid, 'DELETE'))")"

echo "== üretim: geliştirme parolası reddi =="
out="$(timeout 120 docker run --rm --name "$C-prod" -e POSTGRES_PASSWORD=su -e SOD_ENV=production \
  -v "$INIT_MOUNT:/docker-entrypoint-initdb.d/01-init.sql:ro" "$IMAGE" 2>&1)"; code=$?
check "SOD_ENV=production + varsayılan parola: kurulum durur (kap kendiliğinden kapanır)" "durdu" "$([ "$code" != 0 ] && [ "$code" != 124 ] && echo durdu || echo "çıkış $code")"
echo "$out" | grep -q 'geliştirme parolası' && check "hata mesajı yazıldı" 1 1 || check "hata mesajı yazıldı" 1 0

echo "== üretim: gerçek parolalarla kurulum =="
P="$C-prodok"
mapfile -t ENVS < <(real_env $SCHEMAS)
docker run -d --rm --name "$P" -e POSTGRES_PASSWORD=su-gercek -e SOD_ENV=production "${ENVS[@]}" \
  -v "$INIT_MOUNT:/docker-entrypoint-initdb.d/01-init.sql:ro" "${INFRA[@]}" "${KAP_BETIK[@]}" "$IMAGE" postgres -c log_statement=all >/dev/null
OK=0; wait_ready "$P" su-gercek && OK=1
check "üretim parolalarıyla kurulum tamamlanır" 1 "$OK"
for r in $ROLES; do
  check "$r gerçek parolasıyla girer" giriş "$(login "$P" "$r" "$(real_pw "$r")")"
  check "$r *_dev parolasıyla giremez" ret "$(login "$P" "$r" "$(dev_pw "$r")")"
done
out="$(run_upgrade "$P" su-gercek -e SOD_ENV=production "${ENVS[@]}")"; code=$?
check "üretimde upgrade.sql gerçek parolalı kurulumda hatasız" 0 "$code"
[ "$code" = 0 ] || echo "$out" | tail -5

echo "== yedek-kap.sh rol-parola (geri yükleme sonrası parola eşitleme) =="
R1="$(echo "$ROLES" | tail -1)"
# Kabın kendi ortamı (docker run -e) temizlenir: betik yalnız verilen AD=DEĞER değerlerini görür (geri-yukle.ps1'in verdikleri gibi).
rp() { docker exec "$P" env -i PATH=/usr/local/bin:/usr/bin:/bin "$@" bash /betik/yedek-kap.sh rol-parola sellerondata 2>&1; }
mapfile -t NEWENVS < <(for r in $ROLES; do printf 'SOD_%s_DB_PASSWORD=yeni-%s-p4r0la\n' "$(upper "${r#sod_}")" "$r"; done)
out="$(rp SOD_ENV=production SOD_POSTGRES_PASSWORD=su-gercek "${NEWENVS[@]:0:${#NEWENVS[@]}-1}")"; code=$?
check "üretimde değeri olmayan rol varsa rol-parola durur" "durdu" "$([ "$code" != 0 ] && echo durdu || echo "çıkış $code")"
check "durunca hiçbir parola değişmedi" giriş "$(login "$P" "$(echo "$ROLES" | head -1)" "$(real_pw "$(echo "$ROLES" | head -1)")")"
out="$(rp SOD_ENV=production SOD_POSTGRES_PASSWORD=su-gercek "${NEWENVS[@]:0:${#NEWENVS[@]}-1}" "SOD_$(upper "${R1#sod_}")_DB_PASSWORD=${R1}_dev")"; code=$?
check "üretimde *_dev değeri reddedilir" "durdu" "$([ "$code" != 0 ] && echo durdu || echo "çıkış $code")"
out="$(rp SOD_ENV=production SOD_POSTGRES_PASSWORD=su-gercek "${NEWENVS[@]}")"; code=$?
check "üretimde bütün değerlerle rol-parola tamamlanır" 0 "$code"
[ "$code" = 0 ] || echo "$out" | tail -3
for r in $ROLES; do check "$r yeni parolasıyla girer" giriş "$(login "$P" "$r" "yeni-$r-p4r0la")"; done
out="$(rp)"; code=$?
check "geliştirmede değeri olmayan rol compose varsayılanını (*_dev) alır" "0 giriş" "$code $(login "$P" "$R1" "$(dev_pw "$R1")")"

if [ -n "$OLD" ]; then
  echo "== üretim: eski hacim + yeni araç (upgrade.sql) =="
  O="$C-prodold"
  docker run -d --rm --name "$O" -e POSTGRES_PASSWORD=su-gercek -e SOD_ENV=production "${ENVS[@]}" \
    -v "$FIRST_INIT:/docker-entrypoint-initdb.d/01-init.sql:ro" "${INFRA[@]}" "$IMAGE" postgres -c log_statement=all >/dev/null
  OK=0; wait_ready "$O" su-gercek && OK=1
  check "eski kurulum üretim parolalarıyla tamamlanır" 1 "$OK"
  HAVE="$(qk "$O" postgres sellerondata su-gercek "select rolname from pg_roles where rolname like 'sod\_%'")"
  NEW=""; OLDT=""
  for s in $SCHEMAS; do if echo "$HAVE" | grep -qx "sod_$s"; then OLDT="$OLDT $s"; else NEW="$NEW $s"; fi; done
  echo "eski kiracılar:$OLDT; yeni:${NEW:- (yok)}"
  check "eski hacimde en az bir yeni kiracı var (senaryonun ön koşulu)" 1 "$([ -n "$NEW" ] && echo 1 || echo 0)"
  mapfile -t OLDENVS < <(real_env $OLDT)
  # Eski init.sql (değişiklik öncesi) kurulumda parolayı günlüğe yazmış olabilir; yalnız yükseltmenin satırları denetlenir.
  LOG0=$(docker logs "$O" 2>&1 | wc -l)
  out="$(run_upgrade "$O" su-gercek -e SOD_ENV=production "${OLDENVS[@]}")"; code=$?
  check "üretimde yeni aracın parolası yoksa upgrade.sql durur" "durdu" "$([ "$code" != 0 ] && echo "$out" | grep -q 'geliştirme parolasıyla' && echo durdu || echo "çıkış $code")"
  check "durunca yeni rol açılmadı" 0 "$(qk "$O" postgres sellerondata su-gercek "select count(*) from pg_roles where rolname in ($(for s in $NEW; do printf "'sod_%s','sod_%s_admin'," "$s" "$s"; done | sed 's/,$//'))")"
  out="$(run_upgrade "$O" su-gercek -e SOD_ENV=production "${ENVS[@]}")"; code=$?
  check "üretimde parolalarla upgrade.sql hatasız" 0 "$code"
  [ "$code" = 0 ] || echo "$out" | tail -5
  for s in $NEW; do
    for r in "sod_${s}_admin" "sod_$s"; do
      check "$r (yeni) gerçek parolasıyla girer" giriş "$(login "$O" "$r" "$(real_pw "$r")")"
      check "$r (yeni) *_dev parolasıyla giremez" ret "$(login "$O" "$r" "$(dev_pw "$r")")"
    done
  done
  check "eski hacimde rol ayarları tam olarak beklenen" "$EXPECTED_SETTINGS" "$(settings "$O" su-gercek | sort)"
  docker logs "$O" 2>&1 | tail -n +$((LOG0 + 1)) | grep -q 'p4r0la' && check "yükseltmede sunucu günlüğüne düz parola düşmedi" 1 0 || check "yükseltmede sunucu günlüğüne düz parola düşmedi" 1 1
fi
docker logs "$P" 2>&1 | grep -q 'p4r0la' && check "sunucu günlüğünde düz parola yok (üretim kabı)" 1 0 || check "sunucu günlüğünde düz parola yok (üretim kabı)" 1 1

if [ "$FAIL" -gt 0 ]; then echo "$FAIL denetim başarısız"; exit 1; fi
echo "tüm denetimler geçti"
