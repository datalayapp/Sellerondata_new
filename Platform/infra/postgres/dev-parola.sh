#!/bin/sh
# upgrade.sql üretimde (SOD_ENV=production) çağırır: her sod_ rolüne ağ üzerinden "<rol>_dev" parolasıyla girmeyi dener.
# Biri girerse 1 döner ve upgrade.sql durur. Sunucu parolayı hiç sınamıyorsa (trust: yerel soket, 127.0.0.1) da 1:
# sınama yapılamaz, upgrade ağ adresiyle çalıştırılmalı (compose: -h postgres). Bağlantı bilgisi psql'in \setenv'inden.
# Roller veritabanından okunur; liste elle yazılmaz. Parola komut satırına değil yalnız psql sürecinin ortamına gider.
set -u
H=${SOD_PGHOST:?SOD_PGHOST yok}
PORT=${SOD_PGPORT:-5432}
DB=${SOD_PGDB:-sellerondata}
SU=${SOD_PGUSER:-postgres}

dene() { # rol parola -> 0: girdi
  PGPASSWORD="$2" PGCONNECT_TIMEOUT=5 psql -X -h "$H" -p "$PORT" -U "$1" -d "$DB" -Atc 'select 1' >/dev/null 2>&1
}

case "$H" in
  /*) echo "dev-parola: bağlantı yerel soket ($H); parola sınanamaz, upgrade.sql ağ adresiyle çalıştırılmalı" >&2; exit 1 ;;
esac
if dene "$SU" "sod-yanlis-parola-$$"; then
  echo "dev-parola: sunucu $H parolayı sınamıyor (trust); upgrade.sql ağ adresiyle çalıştırılmalı" >&2
  exit 1
fi

roller=$(psql -X -h "$H" -p "$PORT" -U "$SU" -d "$DB" -Atc "SELECT rolname FROM pg_roles WHERE rolname LIKE 'sod\_%' AND rolcanlogin ORDER BY 1") || exit 1
kotu=0
for r in $roller; do
  if dene "$r" "${r}_dev"; then
    echo "dev-parola: $r geliştirme parolasıyla giriyor (${r}_dev)" >&2
    kotu=1
  fi
done
exit $kotu
