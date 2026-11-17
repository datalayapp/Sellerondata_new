#!/usr/bin/env bash
# SellerOnData sunucuda ilk kurulum (Linux; KALANLAR 3.7). Ayrıntı ve sıra: docs/KURULUM.md "Sunucuda ilk kurulum".
#
#   bash scripts/kurulum.sh ac --app-host <ad> --site-host <ad> --acme-email <adres> --smtp-url <url> [--sahip-eposta <adres>]
#        .env (güçlü rastgele parolalar ve anahtarlar, SOD_ENV=production, kayıt yalnız davetle, demo kapalı, alan adları),
#        ayar denetimi, ilk açılış (scripts/guncelle.sh --ilk-kurulum), verildiyse sahibin kayıt daveti
#   bash scripts/kurulum.sh davet --sahip-eposta <adres>     tek kullanımlık kayıt daveti (signup-invite; posta gitmez)
#   bash scripts/kurulum.sh dogrula --sahip-eposta <adres>   sahip kayıt oldu mu, e-postası doğrulandı mı, firmanın sahibi mi
#   bash scripts/kurulum.sh kalici-silme [--evet]            purge:preview kuru çalışması, onay, DELETED_*_PURGE_DAYS=30
#
# Seçenekler: -n / --kuru (hiçbir şey değiştirmez), --mail-from <metin>, --dil tr|en (davet), --operator <ad> (denetim izi;
# varsayılan kurulum), --evet (onay sorma).
# .env varsa var olan değere dokunulmaz: yalnız eksik ayarlar eklenir; verilen seçenek var olanla çelişirse durur.
# Yeniden çalıştırmak güvenlidir. Çıkış: 0 tamam; 1 adım tutmadı (dogrula: sahip henüz hazır değil); 2 başlamadan durdu
# (kullanım, eksik araç, .env denetimi); 3-4 scripts/guncelle.sh'in çıkışı (ilk açılış).
# Yerel bilgisayarda gerçek kullanıma geçiş bu değil: scripts/gercek-kullanim.ps1.
set -uo pipefail

# Yardımcılar (yaz, adim, env_get, mutlak, ayarlar, DC) guncelle.sh'ten; source edilince onun main'i çalışmaz.
# shellcheck source=guncelle.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guncelle.sh"

# Varsayılanlar (ince ayar; KALANLAR "Yayından önce"). Yapay zekâ tavanları gercek-kullanim.ps1 ile aynı.
GUNLUK_TAVAN=200
AYLIK_HAK=1500
PURGE_GUN=30 # KARARLAR 2026-11-12: silinenler 30 gün sonra kalıcı silinir

kullanim() {
  printf 'kurulum: %s\n(yardım: bash scripts/kurulum.sh --help)\n' "$1" >&2
  exit 2
}
yardim_kurulum() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$PLATFORM/scripts/kurulum.sh"; }

alan_adi_mi() { [[ $1 =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; }
eposta_mi() { [[ $1 =~ ^[^[:space:]@\'\"]+@[^[:space:]@\'\"]+\.[^[:space:]@\'\"]+$ ]]; }
rastgele() { openssl rand -hex 32; }
b64url() { base64 | tr -d '\n=' | tr '+/' '-_'; }

# Ed25519 özel JWK, tek satır (Hesap servisinin keys:generate çıktısıyla aynı alanlar). Node gerekmez.
imza_anahtari() {
  local t d x
  t=$(mktemp) || return 1
  if ! openssl genpkey -algorithm ED25519 -out "$t" 2>/dev/null; then
    rm -f "$t"
    return 1
  fi
  # PKCS#8 DER'in son 32 baytı tohum (d), SPKI DER'in son 32 baytı açık anahtar (x).
  d=$(openssl pkey -in "$t" -outform DER 2>/dev/null | tail -c 32 | b64url)
  x=$(openssl pkey -in "$t" -pubout -outform DER 2>/dev/null | tail -c 32 | b64url)
  rm -f "$t"
  [ ${#d} = 43 ] && [ ${#x} = 43 ] || return 1
  printf '{"crv":"Ed25519","d":"%s","x":"%s","kty":"OKP","kid":"sod-%s-%s","alg":"EdDSA","use":"sig"}' "$d" "$x" "$(date +%Y-%m-%d)" "$(openssl rand -hex 4)"
}

# ---------- .env ----------

# İstenen ayarlar: "AD=değer" satırları. Gizli değerler yalnız yoksa üretilir (çağıran var olanı atlar).
istenen_ayarlar() {
  local www=https://www.$SITE_HOST cookie=
  case "$APP_HOST" in *."$SITE_HOST") cookie=.$SITE_HOST ;; esac
  cat <<EOF
SOD_ENV=production
APP_HOST=$APP_HOST
SITE_HOST=$SITE_HOST
ACME_EMAIL=$ACME_EMAIL
APP_BASE_URL=https://$APP_HOST
ALLOWED_ORIGINS=https://$APP_HOST
SITE_BASE_URL=https://$SITE_HOST
SITE_ORIGINS=https://$SITE_HOST,$www
COOKIE_LANG_DOMAIN=$cookie
SMTP_URL=$SMTP_URL
MAIL_FROM=${MAIL_FROM:-SellerOnData <no-reply@$SITE_HOST>}
SIGNUP_MODE=invite
REGISTRATION_ENABLED=true
ENABLE_DATA_RESET=false
DEMO_TOUR=off
AI_DAILY_BUDGET_TRY=$GUNLUK_TAVAN
AI_FREE_CREDIT_MONTHLY_TRY=$AYLIK_HAK
EOF
}
GIZLILER='SOD_POSTGRES_PASSWORD SOD_PLATFORM_ADMIN_DB_PASSWORD SOD_DECISHIP_ADMIN_DB_PASSWORD SOD_PLATFORM_DB_PASSWORD SOD_DECISHIP_DB_PASSWORD ACCOUNT_CODE_PEPPER FILE_TOKEN_SECRET PRODUCT_NOTIFY_SECRET ACCOUNT_SIGNING_KEY'

env_var_mi() { [ -f "$ENV_FILE" ] && grep -qE "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE"; }

# .env'i yazar (yoksa) ya da eksikleri ekler. Seçenekle verilen değer var olanla çelişirse durur. KURU=1: geçici dosyaya.
env_hazirla() {
  local satir ad deger eski eklenen='' eksik_zorunlu='' celiski=''
  local hedef=$ENV_FILE
  if [ "$KURU" = 1 ]; then
    hedef=$(mktemp)
    [ -f "$ENV_FILE" ] && cat "$ENV_FILE" >"$hedef"
  fi
  local yeni=0
  [ -f "$ENV_FILE" ] || yeni=1
  local ek
  ek=$(mktemp)
  while IFS= read -r satir; do
    ad=${satir%%=*}
    deger=${satir#*=}
    if env_var_mi "$ad"; then
      eski=$(env_get "$ad")
      # Yalnız seçenekle verilen alan adı, posta ve adres değerleri çelişki sayılır; öteki eski değerler korunur.
      case "$ad" in
        APP_HOST | SITE_HOST | ACME_EMAIL | SMTP_URL | MAIL_FROM)
          if [ -n "$(secenek_degeri "$ad")" ] && [ "$eski" != "$deger" ]; then celiski+=" $ad"; fi
          ;;
      esac
      continue
    fi
    case "$ad" in
      APP_HOST | SITE_HOST | ACME_EMAIL | SMTP_URL)
        if [ -z "$(secenek_degeri "$ad")" ]; then
          eksik_zorunlu+=" $(secenek_adi "$ad")"
          continue
        fi
        ;;
    esac
    # Posta değerleri tek tırnakta: compose tırnaksız ve çift tırnaklı değerde $ ile başlayanı değişken sanar (SMTP parolası).
    case "$ad" in
      SMTP_URL | MAIL_FROM) printf "%s='%s'\n" "$ad" "$deger" >>"$ek" ;;
      *) printf '%s=%s\n' "$ad" "$deger" >>"$ek" ;;
    esac
    eklenen+=" $ad"
  done < <(istenen_ayarlar_guvenli)
  if [ -n "$celiski" ]; then
    rm -f "$ek"
    [ "$KURU" = 1 ] && rm -f "$hedef"
    hata ".env'deki değer verilen seçenekle çelişiyor:$celiski. Değiştirmek istiyorsanız .env'i elle düzeltin (eski değer korunur)."
    exit 2
  fi
  if [ -n "$eksik_zorunlu" ]; then
    rm -f "$ek"
    [ "$KURU" = 1 ] && rm -f "$hedef"
    kullanim "eksik seçenek:$eksik_zorunlu"
  fi
  for ad in $GIZLILER; do
    env_var_mi "$ad" && [ -n "$(env_get "$ad")" ] && continue
    if [ "$ad" = ACCOUNT_SIGNING_KEY ]; then
      deger=$(imza_anahtari) || {
        rm -f "$ek"
        hata "imza anahtarı üretilemedi (openssl ED25519)"
        exit 2
      }
      printf "%s='%s'\n" "$ad" "$deger" >>"$ek"
    else
      printf '%s=%s\n' "$ad" "$(rastgele)" >>"$ek"
    fi
    eklenen+=" $ad"
  done
  if [ -s "$ek" ]; then
    # Dosya önce yalnız sahibine açık oluşturulur, sonra yazılır (gizli değerler bir an bile herkese açık durmasın).
    (umask 077 && touch "$hedef") && chmod 600 "$hedef" || {
      hata "$hedef yazılamadı"
      exit 2
    }
    {
      if [ "$yeni" = 1 ] || [ ! -s "$hedef" ]; then
        printf '# SellerOnData sunucu ayarları: kurulum.sh %s. Commit edilmez; parola yöneticisine yedekleyin.\n' "$(date +%Y-%m-%d)"
        printf '# Ayrıntı: docs/KURULUM.md "Sunucuda ilk kurulum"; tam liste .env.example.\n'
      else
        printf '\n# kurulum.sh %s: eksik ayarlar eklendi\n' "$(date +%Y-%m-%d)"
      fi
      cat "$ek"
      if ! grep -qE '^[[:space:]]*DELETED_INVOICE_PURGE_DAYS[[:space:]]*=' "$hedef" 2>/dev/null; then
        printf '# Silinenlerin kalıcı silinmesi kapalı: sahip firmasını açınca bash scripts/kurulum.sh kalici-silme (purge:preview, sonra 30).\n'
        printf '# Yapay zekâ (PDF fatura, tartı fotoğrafı) için ANTHROPIC_API_KEY=; boşsa yalnız bu ikisi kapalı.\n'
      fi
    } >>"$hedef" || {
      hata "$hedef yazılamadı"
      exit 2
    }
  fi
  rm -f "$ek"
  ENV_EKLENEN=$eklenen
  ENV_HEDEF=$hedef
}

# istenen_ayarlar ama seçenekle verilmemiş alanlar için var olan .env değerleri (yeniden çalıştırmada çelişki sanılmasın).
istenen_ayarlar_guvenli() {
  local v
  APP_HOST=${APP_HOST:-$(env_get APP_HOST)}
  SITE_HOST=${SITE_HOST:-$(env_get SITE_HOST)}
  ACME_EMAIL=${ACME_EMAIL:-$(env_get ACME_EMAIL)}
  SMTP_URL=${SMTP_URL:-$(env_get SMTP_URL)}
  v=$(env_get MAIL_FROM)
  [ -n "${MAIL_FROM:-}" ] || MAIL_FROM=$v
  istenen_ayarlar
}
secenek_degeri() {
  case "$1" in
    APP_HOST) printf '%s' "$O_APP_HOST" ;;
    SITE_HOST) printf '%s' "$O_SITE_HOST" ;;
    ACME_EMAIL) printf '%s' "$O_ACME_EMAIL" ;;
    SMTP_URL) printf '%s' "$O_SMTP_URL" ;;
    MAIL_FROM) printf '%s' "$O_MAIL_FROM" ;;
  esac
}
secenek_adi() {
  case "$1" in
    APP_HOST) echo --app-host ;;
    SITE_HOST) echo --site-host ;;
    ACME_EMAIL) echo --acme-email ;;
    SMTP_URL) echo --smtp-url ;;
  esac
}

# Üretim ayarları denetimi (servislerin açılışta reddettikleri ve kapalı deneme kuralları). Hata varsa 1.
env_denetle() {
  local f=$1 hatalar=0 ad v app
  local ENV_FILE=$f
  h() { hata "$1"; hatalar=$((hatalar + 1)); }
  [ "$(env_get SOD_ENV)" = production ] || h "SOD_ENV=production olmalı"
  for ad in SOD_POSTGRES_PASSWORD SOD_PLATFORM_ADMIN_DB_PASSWORD SOD_DECISHIP_ADMIN_DB_PASSWORD SOD_PLATFORM_DB_PASSWORD SOD_DECISHIP_DB_PASSWORD; do
    v=$(env_get "$ad")
    if [ -z "$v" ]; then
      h "$ad boş"
    elif [[ $v == *_dev ]]; then
      h "$ad geliştirme parolası (*_dev)"
    elif [[ ! $v =~ ^[A-Za-z0-9_-]{24,}$ ]]; then
      h "$ad en az 24 karakter, yalnız harf, rakam, - ve _ olmalı (@ / : bağlantı adresini bozar)"
    fi
  done
  for ad in ACCOUNT_CODE_PEPPER FILE_TOKEN_SECRET PRODUCT_NOTIFY_SECRET; do
    v=$(env_get "$ad")
    [ ${#v} -ge 32 ] || h "$ad en az 32 karakter olmalı"
  done
  [[ $(env_get ACCOUNT_SIGNING_KEY) == *'"d":"'* ]] || h "ACCOUNT_SIGNING_KEY özel JWK değil (d alanı yok)"
  app=$(env_get APP_BASE_URL)
  [[ $app == https://* ]] || h "APP_BASE_URL https:// ile başlamalı: $app"
  [[ $(env_get SITE_BASE_URL) == https://* ]] || h "SITE_BASE_URL https:// ile başlamalı"
  [[ ",$(env_get ALLOWED_ORIGINS)," == *",${app%/},"* ]] || h "ALLOWED_ORIGINS APP_BASE_URL kökenini içermeli"
  [[ $(env_get SITE_ORIGINS) == https://* ]] || h "SITE_ORIGINS https kökeni olmalı"
  for ad in APP_HOST SITE_HOST ACME_EMAIL; do [ -n "$(env_get "$ad")" ] || h "$ad boş"; done
  [[ $(env_get SMTP_URL) =~ ^smtps?:// ]] || h "SMTP_URL smtp:// ya da smtps:// ile başlamalı"
  [ "$(env_get ENABLE_DATA_RESET)" != true ] || h "ENABLE_DATA_RESET=true üretimde servisi açmaz"
  [ "$(env_get COOKIE_SECURE)" != false ] || h "COOKIE_SECURE=false üretimde servisi açmaz"
  v=$(env_get SIGNUP_MODE)
  [ -z "$v" ] || [ "$v" = invite ] || uyari "SIGNUP_MODE=$v: yeni firma kaydı herkese açık (kapalı denemede invite)"
  v=$(env_get DEMO_TOUR)
  [ "$v" = off ] || uyari "DEMO_TOUR=${v:-on}: örnek veriyle deneme turu açık"
  [ -n "$(env_get ANTHROPIC_API_KEY)" ] || uyari "ANTHROPIC_API_KEY boş: PDF fatura ve tartı fotoğrafı okuma kapalı (sonra eklenebilir)"
  unset -f h
  [ "$hatalar" = 0 ]
}

compose_surumu() {
  local s maj min
  s=$(docker compose version --short 2>/dev/null) || {
    hata "docker compose bulunamadı (Docker Engine + compose eklentisi)"
    exit 2
  }
  s=${s#v}
  maj=${s%%.*}
  min=${s#*.}
  min=${min%%.*}
  # !reset (üretim katmanı portları kapatır) compose 2.24.4 ister; v5.1.4 ile sınandı.
  if ! is_uint "$maj" || ! is_uint "$min" || [ "$maj" -lt 2 ] || { [ "$maj" = 2 ] && [ "$min" -lt 25 ]; }; then
    hata "docker compose $s eski: en az 2.25 gerekir (üretim katmanının !reset'i)"
    exit 2
  fi
  yaz "docker compose $s"
}

# ---------- adımlar ----------

adim_ac() {
  local a
  adim "Ön denetim"
  for a in docker git curl openssl awk base64 sha256sum; do
    command -v "$a" >/dev/null 2>&1 || {
      hata "$a bulunamadı"
      exit 2
    }
  done
  compose_surumu
  for a in "$O_APP_HOST" "$O_SITE_HOST"; do
    [ -z "$a" ] || alan_adi_mi "$a" || kullanim "geçersiz alan adı: $a (küçük harf, ör. app.ornek.com)"
  done
  [ -z "$O_APP_HOST" ] || [ "$O_APP_HOST" != "$O_SITE_HOST" ] || kullanim "--app-host ile --site-host farklı olmalı"
  [ -z "$O_ACME_EMAIL" ] || eposta_mi "$O_ACME_EMAIL" || kullanim "geçersiz e-posta: $O_ACME_EMAIL"
  [ -z "$O_SMTP_URL" ] || [[ $O_SMTP_URL =~ ^smtps?://[^[:space:]\']+$ ]] || kullanim "--smtp-url smtp://kullanici:parola@sunucu:587 biçiminde olmalı (boşluk ve ' olmadan; özel karakterler URL kodlu)"
  [[ $O_MAIL_FROM != *"'"* ]] || kullanim "--mail-from ' içeremez"
  [ -z "$SAHIP" ] || eposta_mi "$SAHIP" || kullanim "geçersiz e-posta: $SAHIP"

  adim ".env"
  APP_HOST=$O_APP_HOST SITE_HOST=$O_SITE_HOST ACME_EMAIL=$O_ACME_EMAIL SMTP_URL=$O_SMTP_URL MAIL_FROM=$O_MAIL_FROM
  env_hazirla
  if [ -n "$ENV_EKLENEN" ]; then
    yaz "$([ "$KURU" = 1 ] && echo 'Yazılacak' || echo 'Yazıldı') ($ENV_FILE):$ENV_EKLENEN"
  else
    yaz "$ENV_FILE tam; değişmedi."
  fi
  adim "Ayar denetimi"
  if ! env_denetle "$ENV_HEDEF"; then
    [ "$KURU" = 1 ] && rm -f "$ENV_HEDEF"
    hata ".env üretim için uygun değil; düzeltip yeniden çalıştırın."
    exit 2
  fi
  [ "$KURU" = 1 ] && rm -f "$ENV_HEDEF"
  yaz "Ayarlar tamam."
  if [ "$KURU" = 1 ]; then
    yaz ""
    yaz "Kuru çalışma: hiçbir şey değişmedi. Sonra: compose config, ilk açılış (guncelle.sh --ilk-kurulum)${SAHIP:+, $SAHIP için kayıt daveti}."
    return 0
  fi

  adim "İlk açılış"
  bash "$PLATFORM/scripts/guncelle.sh" --ilk-kurulum
  local kod=$?
  if [ "$kod" != 0 ] && [ "$kod" != 4 ]; then
    hata "ilk açılış tutmadı (guncelle.sh çıkış $kod); yukarıdaki iletiye bakın, düzeltip yeniden çalıştırın."
    return "$kod"
  fi
  if [ -n "$SAHIP" ]; then
    adim_davet || return 1
  else
    yaz ""
    yaz "Sistem açık. Sıradaki: bash scripts/kurulum.sh davet --sahip-eposta <adres>"
  fi
  return 0
}

adim_davet() {
  [ -n "$SAHIP" ] || kullanim "--sahip-eposta <adres> gerekli"
  eposta_mi "$SAHIP" || kullanim "geçersiz e-posta: $SAHIP"
  adim "Sahibin kayıt daveti ($SAHIP)"
  if [ "$KURU" = 1 ]; then
    yaz "Kuru çalışma: davet üretilmedi."
    return 0
  fi
  "${DC[@]}" exec -T account-api node dist/signup-invite.js --email "$SAHIP" --operator "$OPERATOR" --lang "$DIL" || {
    hata "davet üretilemedi"
    return 1
  }
  yaz ""
  yaz "Sahibin adımları:"
  yaz "  1. Bağlantıyı (yukarıda, tek kullanımlık) sahibe güvenli yoldan iletin; posta gitmez."
  yaz "  2. Sahip bağlantıyla kayıt olur: firma adı, şifre. Firma o anda açılır, sahibi odur."
  yaz "  3. Doğrulama postası gelir (gerçek SMTP); bağlantıya tıklar, giriş yapar."
  yaz "  4. Burada: bash scripts/kurulum.sh dogrula --sahip-eposta $SAHIP"
  return 0
}

adim_dogrula() {
  [ -n "$SAHIP" ] || kullanim "--sahip-eposta <adres> gerekli"
  eposta_mi "$SAHIP" || kullanim "geçersiz e-posta: $SAHIP"
  adim "Sahip denetimi ($SAHIP)"
  local out kisi='' dogru='' firma_sayisi='' sahip_firma='' satir tur a b
  # Adres psql değişkeniyle geçer (stdin'deki sorgu :'e' ile okur): tırnak sorunu ve SQL enjeksiyonu yok.
  out=$(printf '%s\n' \
    "SELECT 'kisi|' || p.email || '|' || (p.\"emailVerifiedAt\" IS NOT NULL)::text FROM platform.\"Person\" p WHERE lower(p.email) = lower(:'e');" \
    "SELECT 'firma|' || o.name || '|' || m.\"orgRole\" FROM platform.\"Person\" p JOIN platform.\"Membership\" m ON m.\"personId\" = p.id AND m.status = 'ACTIVE' JOIN platform.\"Organization\" o ON o.id = m.\"orgId\" WHERE lower(p.email) = lower(:'e');" \
    "SELECT 'firma_sayisi|' || count(*) FROM platform.\"Organization\";" |
    "${DC[@]}" exec -T postgres psql -X -U postgres -d sellerondata -v ON_ERROR_STOP=1 -v "e=$SAHIP" -At 2>&1) || {
    hata "veritabanı okunamadı: $out"
    return 1
  }
  while IFS='|' read -r tur a b; do
    case "$tur" in
      kisi) kisi=$a dogru=$b ;;
      firma)
        yaz "  firma: $a ($b)"
        [ "$b" = OWNER ] && sahip_firma=$a
        ;;
      firma_sayisi) firma_sayisi=$a ;;
    esac
  done <<<"$(printf '%s' "$out" | tr -d '\r')"
  yaz "  sistemdeki firma sayısı: ${firma_sayisi:-?}"
  if [ -z "$kisi" ]; then
    yaz "Sahip henüz kayıt olmadı. Davet durumu:"
    "${DC[@]}" exec -T account-api node dist/signup-invite.js --list --email "$SAHIP" | sed 's/^/  /'
    yaz "Davet yoksa ya da süresi dolduysa: bash scripts/kurulum.sh davet --sahip-eposta $SAHIP"
    return 1
  fi
  if [ "$dogru" != true ]; then
    yaz "Sahip kayıt oldu, e-postası henüz doğrulanmadı."
    yaz "  Posta gelmediyse: $DC_YAZI logs account-api | grep -iE 'e-posta|smtp' (SMTP_URL, gönderici alan adı doğrulaması);"
    yaz "  istenmeyen klasörüne bakılsın; giriş ekranından \"bağlantıyı yeniden gönder\"."
    return 1
  fi
  if [ -z "$sahip_firma" ]; then
    yaz "E-posta doğrulandı ama kişi hiçbir firmanın sahibi değil (davetle kayıt firma açar; başka yoldan mı katıldı?)."
    return 1
  fi
  yaz "Tamam: $SAHIP doğrulandı, $sahip_firma firmasının sahibi."
  yaz "Sıradaki: bash scripts/kurulum.sh kalici-silme (silinenlerin 30 gün sonra kalıcı silinmesi)."
  return 0
}

# .env'de AD=değer: ilk satır değişir, tekrarları silinir, yoksa sona eklenir; izinler korunur.
env_yaz() {
  local t
  t=$(mktemp) || return 1
  awk -v k="$1" -v v="$2" '
    { line = $0; sub(/\r$/, "", line) }
    line ~ "^[ \t]*" k "[ \t]*=" { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" >"$t" && cat "$t" >"$ENV_FILE"
  local kod=$?
  rm -f "$t"
  return $kod
}

adim_kalici_silme() {
  local fatura foto out kayit
  fatura=$(env_get DELETED_INVOICE_PURGE_DAYS)
  foto=$(env_get DELETED_MEASUREMENT_PHOTO_PURGE_DAYS)
  adim "Kuru çalışma (purge:preview; hiçbir şey silinmez)"
  out=$("${DC[@]}" exec -T deciship-api node dist/cli/purgePreview.js --invoice-days "$PURGE_GUN" --photo-days "$PURGE_GUN" 2>&1) || {
    printf '%s\n' "$out" | sed 's/^/  /'
    hata "purge:preview çalışmadı (DeciShip API açık mı?)"
    return 1
  }
  printf '%s\n' "$out" | sed 's/^/  /'
  yaz "Yukarıdaki faturalar (silinmiş, $PURGE_GUN günden eski; itiraz kaydı olanlar hariç) ve silinmiş ölçüm fotoğrafları,"
  yaz "açıldıktan sonra saatlik bakımda KALICI silinir; geri dönüş yalnız yedekten."
  if [ "$fatura" = "$PURGE_GUN" ] && [ "$foto" = "$PURGE_GUN" ]; then
    yaz "Zaten açık (DELETED_INVOICE_PURGE_DAYS=$fatura, DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=$foto)."
    return 0
  fi
  [ -z "$fatura$foto" ] || uyari "şimdiki değerler: DELETED_INVOICE_PURGE_DAYS=${fatura:-boş}, DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=${foto:-boş}; $PURGE_GUN yazılacak"
  if [ "$KURU" = 1 ]; then
    yaz "Kuru çalışma: .env değişmedi."
    return 0
  fi
  if [ "$EVET" != 1 ]; then
    printf 'Açmak için EVET yazın: '
    local cevap=''
    read -r cevap || true
    [ "$cevap" = EVET ] || {
      yaz "Vazgeçildi; .env değişmedi."
      return 1
    }
  fi
  adim ".env ve DeciShip API"
  kayit=$BACKUP_DIR/kurulum
  mkdir -p "$kayit" && chmod 700 "$kayit" && cp "$ENV_FILE" "$kayit/env-$(date +%Y-%m-%d_%H%M%S).env" && chmod 600 "$kayit"/env-*.env || {
    hata ".env'in eski hâli saklanamadı ($kayit); değişmedi."
    return 1
  }
  env_yaz DELETED_INVOICE_PURGE_DAYS "$PURGE_GUN" && env_yaz DELETED_MEASUREMENT_PHOTO_PURGE_DAYS "$PURGE_GUN" || {
    hata ".env yazılamadı"
    return 1
  }
  yaz "Yazıldı: DELETED_INVOICE_PURGE_DAYS=$PURGE_GUN, DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=$PURGE_GUN (eski hâli $kayit)"
  "${DC[@]}" up -d --wait --wait-timeout "$WAIT_TIMEOUT" deciship-api || {
    hata "DeciShip API yeniden açılmadı: $DC_YAZI logs deciship-api"
    return 1
  }
  local a b
  a=$("${DC[@]}" exec -T deciship-api printenv DELETED_INVOICE_PURGE_DAYS 2>/dev/null | tr -d '\r')
  b=$("${DC[@]}" exec -T deciship-api printenv DELETED_MEASUREMENT_PHOTO_PURGE_DAYS 2>/dev/null | tr -d '\r')
  if [ "$a" != "$PURGE_GUN" ] || [ "$b" != "$PURGE_GUN" ]; then
    hata "kapta değer görünmüyor (DELETED_INVOICE_PURGE_DAYS=${a:-boş}, DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=${b:-boş})"
    return 1
  fi
  yaz "Kalıcı silme açık: $PURGE_GUN gün. Kapatmak: iki satırı boşaltıp $DC_YAZI up -d deciship-api."
  return 0
}

kurulum_main() {
  local komut=${1:-}
  case "$komut" in
    -h | --help | '')
      yardim_kurulum
      [ -n "$komut" ] && exit 0
      exit 2
      ;;
    ac | davet | dogrula | kalici-silme) shift ;;
    *) kullanim "bilinmeyen adım: $komut (ac, davet, dogrula, kalici-silme)" ;;
  esac
  KURU=0 EVET=0 SAHIP='' DIL=tr OPERATOR=kurulum
  O_APP_HOST='' O_SITE_HOST='' O_ACME_EMAIL='' O_SMTP_URL='' O_MAIL_FROM=''
  while [ $# -gt 0 ]; do
    case "$1" in
      -n | --kuru) KURU=1 ;;
      --evet) EVET=1 ;;
      --app-host | --site-host | --acme-email | --smtp-url | --mail-from | --sahip-eposta | --dil | --operator)
        [ $# -ge 2 ] && [ -n "$2" ] || kullanim "$1 değer ister"
        case "$1" in
          --app-host) O_APP_HOST=$2 ;;
          --site-host) O_SITE_HOST=$2 ;;
          --acme-email) O_ACME_EMAIL=$2 ;;
          --smtp-url) O_SMTP_URL=$2 ;;
          --mail-from) O_MAIL_FROM=$2 ;;
          --sahip-eposta) SAHIP=$2 ;;
          --dil) DIL=$2 ;;
          --operator) OPERATOR=$2 ;;
        esac
        shift
        ;;
      *) kullanim "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  case "$DIL" in tr | en) ;; *) kullanim "--dil tr ya da en" ;; esac
  ayarlar
  if [ "$komut" != ac ]; then
    [ -f "$ENV_FILE" ] || {
      hata "ayar dosyası yok: $ENV_FILE (önce: bash scripts/kurulum.sh ac ...)"
      exit 2
    }
    command -v docker >/dev/null 2>&1 || {
      hata "docker bulunamadı"
      exit 2
    }
  fi
  case "$komut" in
    ac) adim_ac ;;
    davet) adim_davet ;;
    dogrula) adim_dogrula ;;
    kalici-silme) adim_kalici_silme ;;
  esac
}

kurulum_main "$@"; exit $?
