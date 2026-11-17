# SellerOnData: tek tıkla kurulum (yalnızca Docker Desktop gerekir; Node/Python gerekmez)
# BASLAT.bat / DURDUR.bat / SIFIRLA.bat bu betiği çağırır.
#   (parametresiz)  derle -> başlat -> sağlık bekle -> tarayıcıyı aç
#   -Stop           durdur (veriler korunur)
#   -Reset          bu sistemin kendi hacimlerini siler (veritabanı, DeciShip dosyaları); onay ister
#   -Seed           demo hesaplarını (Hesap servisi tohumu) yeniden yükler
#   -Yes            soru sorma (otomasyon/test için)
#   -NoBrowser      tarayıcıyı açma
# Yan yana ikinci sistem (uçtan uca test): SOD_PROJECT, SOD_ENV_FILE ortam değişkenleri + e2e/.env.e2e içindeki hacim ve portlar.
# Ayarlar önce işlem ortamından, sonra ayar dosyasından okunur (docker compose ile aynı öncelik).
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param([switch]$Stop, [switch]$Reset, [switch]$Seed, [switch]$Yes, [switch]$NoBrowser)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$project = if ($env:SOD_PROJECT) { $env:SOD_PROJECT } else { "sellerondata" }   # eski "deciship" compose projesinden ayrıdır; onun hacimlerine dokunulmaz
$envFile = if ($env:SOD_ENV_FILE) { Join-Path $root $env:SOD_ENV_FILE } else { Join-Path $root ".env" }
function Get-Setting($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($v) { return $v }
  if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
      if ($line -match "^\s*$name=(.*)$") { $x = $Matches[1].Trim(); if ($x) { return $x } }
    }
  }
  return $default
}
# Port ayarı "8088" ya da "127.0.0.1:8088" (yalnız bu bilgisayardan erişim, KURULUM.md) olabilir: adres ve denetim için port numarası.
function Get-PortSetting($name, $default) { return ((Get-Setting $name $default) -split ':')[-1] }
function Compose {
  if (Test-Path $envFile) { docker compose -p $project --env-file $envFile @args } else { docker compose -p $project @args }
}
function Test-Url($u) { try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false } }
function Fail($msg) { Write-Host ""; Write-Host "HATA: $msg" -ForegroundColor Red; if (-not $Yes) { Read-Host "Kapatmak için Enter" }; exit 1 }
function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# Tek depo (SellerOnData; Platform onun alt klasörü). Güncellemeyi otomatik çekmeyiz; yalnız durumunu gösteririz.
function Show-GitStatus {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return }
  $repo = (git -C $root rev-parse --show-toplevel 2>$null)
  if (-not $repo) { return }
  Step "Depo durumu (güncelleme otomatik çekilmez)"
  $name = Split-Path -Leaf $repo
  $branch = (git -C $repo branch --show-current 2>$null)
  $dirty = @(git -C $repo status --porcelain 2>$null).Count
  $line = "  {0,-14} dal: {1}" -f $name, $branch
  $counts = (git -C $repo rev-list --left-right --count "@{upstream}...HEAD" 2>$null)
  if ($counts) { $p = $counts -split "\s+"; $line += "   geride: $($p[0])  önde: $($p[1])" }
  if ($dirty -gt 0) { $line += "   kaydedilmemiş değişiklik: $dirty" }
  Write-Host $line
  Write-Host "  Yeni sürüm için GitHub Desktop'ta 'Fetch origin' ve 'Pull origin' yapın."
}

# 1) Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker Desktop kurulu değil. https://www.docker.com/products/docker-desktop/ adresinden kurup bilgisayarı yeniden başlatın."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Step "Docker Desktop başlatılıyor (1-2 dakika sürebilir)..."
  $exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $exe) { Start-Process $exe }
  $deadline = (Get-Date).AddMinutes(4)
  do { Start-Sleep 4; docker info *> $null } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop açılmadı. Docker Desktop'ı elle açıp tekrar deneyin." }
}

# Olay hedefi (PRODUCT_EVENT_TARGETS) burada ezilmez: değer docker-compose.yml varsayılanından ya da .env'den gelir.
# Böylece yeni araç eklemek bu betiği değiştirmeyi gerektirmez (Mesaj 11, 06-B12).

if ($Stop) {
  Step "SellerOnData durduruluyor..."
  Compose stop
  Write-Host "Durduruldu. Veriler korunuyor; tekrar açmak için BASLAT.bat." -ForegroundColor Green
  exit 0
}

# Tohumdan sonra demo sahibi gerçekten girebiliyor mu (gateway üzerinden, Hesap servisinin giriş ucu). Mobil istemci: CSRF başlığı gerekmez.
function Test-DemoLogin {
  $url = "http://localhost:$(Get-PortSetting 'GATEWAY_PORT' '8088')/api/account/auth/login"
  $body = '{"identifier":"sahip@demo.sellerondata.com","password":"Demo12345!","client":"mobile"}'
  try {
    $r = Invoke-WebRequest $url -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 15
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Invoke-Seed {
  # Bilinen şifreli demo hesaplar canlı adreste açılmaz (boş ya da tanımsız adres yerel sayılır).
  $appUrl = Get-Setting 'APP_BASE_URL' ''
  if ($appUrl) {
    $appHost = try { ([Uri]$appUrl).Host } catch { $null }
    if ($appHost -notin @('localhost', '127.0.0.1', '[::1]', '::1')) { Fail "Demo hesapları yalnız yerel kurulumda yüklenir (APP_BASE_URL=$appUrl)" }
  }
  Step "Demo hesapları yükleniyor..."
  # İmajda tsx ve kaynak yoktur: tohum derlenmiş paketten çalışır. Çıkış 0 yetmez: tohum yazdıklarını sayıp son satıra
  # "SEED-OK" yazar, ardından demo hesapla giriş denenir. İkisinden biri olmazsa "yüklendi" denmez (komut sessizce boş
  # geçebiliyordu: apps/account-api/test/cli-entries.test.mjs).
  $seedOut = @(Compose exec -T account-api node dist/seed.js)
  $seedCode = $LASTEXITCODE
  $seedOut | Out-Host
  $manual = "Elle: docker compose -p $project exec account-api node dist/seed.js"
  if ($seedCode -ne 0) {
    Write-Host "Demo hesapları yüklenemedi (çıkış $seedCode). Sistem açık mı? (BASLAT.bat). $manual" -ForegroundColor Yellow
    return $false
  }
  if (-not ($seedOut | Where-Object { "$_" -match '^SEED-OK ' })) {
    Write-Host "Demo tohumu çalıştı ama yüklediğini doğrulamadı (SEED-OK satırı yok). İmaj eski olabilir: BASLAT.bat ile yeniden derleyin. $manual" -ForegroundColor Yellow
    return $false
  }
  if (-not (Test-DemoLogin)) {
    Write-Host "Demo hesaplar yazıldı ama sahip@demo.sellerondata.com ile giriş olmadı. Kayıtlara bakın: docker compose -p $project logs account-api --tail 30" -ForegroundColor Yellow
    return $false
  }
  Write-Host "  Doğrulandı: sahip@demo.sellerondata.com ile giriş çalışıyor." -ForegroundColor Green
  # Tohum olay üretmez: ürünler firmanın adını, para birimini ve ülkesini bu duyurudan öğrenir (TTK süresi ülkeye bağlıdır).
  Compose exec -T account-api node dist/org-announce.js | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "Firmalar ürünlere duyurulamadı; DeciShip firma ülkesini öğrenemez. Elle: docker compose -p $project exec account-api node dist/org-announce.js" -ForegroundColor Yellow }
  # Demo itirazları: Demo Lojistik'e örnek faturalar ve her durumda itiraz. Firmada fatura varsa tohum kendisi atlar.
  # Uçtan uca test yığını kendi verisini kurar: e2e/.env.e2e SOD_DEMO_DATA=0 verir, bu adım orada çalışmaz.
  if ((Get-Setting 'SOD_DEMO_DATA' '1') -ne '0') {
    Compose exec -T deciship-api node dist/seedDemoDisputes.js | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host "Demo itirazları yüklenemedi; hesaplar ve sistem çalışır, yalnız örnek faturalar ve itirazlar eksik. Elle: docker compose -p $project exec deciship-api node dist/seedDemoDisputes.js" -ForegroundColor Yellow }
  }
  return $true
}

# Gerçek kullanım (scripts\gercek-kullanim.ps1 yazar; docs\KURULUM.md "Gerçek kullanıma geçiş"): demo yüklenmez, sıfırlanmaz.
$realUse = Get-Setting 'SOD_GERCEK_KULLANIM' ''
$realUseStop = "Bu kurulum gerçek kullanımda (.env SOD_GERCEK_KULLANIM=$realUse): gerçek veri var."

if ($Seed) {
  if ($realUse) { Fail "$realUseStop Demo hesapları yüklenmez (bilinen şifreli hesaplar gerçek verinin yanına girmesin)." }
  if (-not (Invoke-Seed)) { Fail "Demo hesapları yüklenemedi." }
  Write-Host "Demo hesapları yüklendi. Şifre: Demo12345!" -ForegroundColor Green
  exit 0
}

if ($Reset) {
  if ($realUse) {
    Fail "$realUseStop SIFIRLA.bat kapalı: bütün firmaları ve faturaları siler. Bilerek gerekiyorsa önce YEDEKLE.bat, sonra .env içindeki SOD_GERCEK_KULLANIM satırını silip yeniden deneyin."
  }
  Step "Sıfırlama"
  Show-GitStatus
  Write-Host ""
  Write-Host "Silinecek (yalnız '$project' projesi): veritabanı ($(Get-Setting 'SOD_PGDATA_VOLUME' 'sod_pgdata')) ve DeciShip dosyaları ($(Get-Setting 'SOD_STORAGE_VOLUME' 'sod_deciship_storage'))." -ForegroundColor Yellow
  Write-Host "Silinmeyecek: eski 'deciship' projesi, imza anahtarları (keys\), .env."
  if (-not $Yes) {
    $ans = (Read-Host "Tüm hesaplar, firmalar ve DeciShip verileri silinecek. Onaylamak için EVET yazın").Trim()
    if ($ans -ne "EVET") { Write-Host "Vazgeçildi, hiçbir şey silinmedi." -ForegroundColor Green; exit 0 }
  }
  Compose down -v --remove-orphans
  if ($LASTEXITCODE -ne 0) { Fail "Sıfırlanamadı. Yukarıdaki hata mesajına bakın." }
  Write-Host "Sıfırlandı. Boş sistemi açmak için BASLAT.bat (demo hesapları yeniden yüklenir)." -ForegroundColor Green
  exit 0
}

Show-GitStatus

# 2) .env (ilk çalıştırmada bir kez oluşturulur, repoya girmez)
$freshEnv = $false
if (-not (Test-Path $envFile)) {
  $freshEnv = $true
  Step "İlk kurulum: ayar dosyası (.env) oluşturuluyor..."
  $key = ""
  if (-not $Yes) {
    Write-Host "PDF fatura okuma ve tartı fotoğrafı okuma için Anthropic API anahtarı gerekir."
    Write-Host "Anahtarınız yoksa boş bırakıp Enter'a basın (diğer her şey çalışır; sonradan .env dosyasına eklenebilir)."
    $key = (Read-Host "ANTHROPIC_API_KEY").Trim()
  }
  $envText = (Get-Content "$root\.env.example" -Raw -Encoding UTF8) `
    -replace '(?m)^ANTHROPIC_API_KEY=.*$', "ANTHROPIC_API_KEY=$key" `
    -replace '(?m)^ENABLE_DATA_RESET=.*$', "ENABLE_DATA_RESET=true"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $envFile) | Out-Null
  [IO.File]::WriteAllText($envFile, $envText, (New-Object Text.UTF8Encoding $false))
}

# Yerel sırlar: ilk kurulumda rastgele üretilir, sonra aynı kalır (repoya girmez). Kod özeti biberi ve dosya bağlantısı anahtarı
# değişmesin: açık telefon kodları ve imzalı bağlantılar yeniden başlatmada düşmez. Var olan .env'de boşsa doldurulur, doluysa dokunulmaz.
function Set-LocalSecret($name) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $value = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $text = Get-Content $envFile -Raw -Encoding UTF8
  if ($text -match "(?m)^$name=\S") { return }
  if ($text -match "(?m)^$name=") { $text = $text -replace "(?m)^$name=.*$", "$name=$value" }
  else { $text = $text.TrimEnd() + "`n$name=$value`n" }
  [IO.File]::WriteAllText($envFile, $text, (New-Object Text.UTF8Encoding $false))
}
Set-LocalSecret 'ACCOUNT_CODE_PEPPER'
Set-LocalSecret 'FILE_TOKEN_SECRET'

# Ayar dosyası artık var: portlar ondan okunur, GATEWAY_PORT değişince sağlık denetimi ve tarayıcı da ona gider.
$base = "http://localhost:$(Get-PortSetting 'GATEWAY_PORT' '8088')"
$siteBase = "http://localhost:$(Get-PortSetting 'SITE_PORT' '8089')"

# 3) İmza anahtarı. Geliştirmede ACCOUNT_SIGNING_KEY boşsa account-api anahtarı keys\ altına kendisi üretir
# ve sonraki açılışlarda aynısını kullanır; oturumlar yeniden başlatmada düşmez. Klasör önceden hazır olsun.
$keysDir = Join-Path $root (Get-Setting 'SOD_KEYS_DIR' 'keys')
if (-not (Test-Path $keysDir)) { New-Item -ItemType Directory -Force -Path $keysDir | Out-Null }

# Port denetimi: hata derlemeden sonra değil, baştan ve adıyla söylenir.
# Uygulama portu doluysa durulur. Yalnız geliştirme için açık portlar (veritabanı, Hesap, görüntü servisi) boş bir porta alınır:
# bunun için eski DeciShip kurulumunu veya başka bir programı kapatmak gerekmez.
function Get-PortUser($port) {
  $names = @(docker ps --filter "publish=$port" --format "{{.Names}}" 2>$null | Where-Object { $_ })
  if ($names.Count -gt 0) {
    if (@($names | Where-Object { $_ -like "$project-*" }).Count -gt 0) { return $null }
    return ($names -join ", ")
  }
  try {
    $l = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), ([int]$port)
    $l.Start(); $l.Stop()
    return $null
  } catch { return "başka bir program" }
}
function Set-Setting($name, $value) {
  [Environment]::SetEnvironmentVariable($name, "$value")
  $text = Get-Content $envFile -Raw -Encoding UTF8
  if ($text -match "(?m)^$name=") { $text = $text -replace "(?m)^$name=.*$", "$name=$value" }
  else { $text = $text.TrimEnd() + "`n$name=$value`n" }
  [IO.File]::WriteAllText($envFile, $text, (New-Object Text.UTF8Encoding $false))
}
foreach ($p in @(@('GATEWAY_PORT', '8088'), @('SITE_PORT', '8089'))) {
  $port = Get-PortSetting $p[0] $p[1]
  $who = Get-PortUser $port
  if ($who) { Fail "$port portu dolu: $who. Onu kapatın ya da .env içinde $($p[0]) değerini değiştirin (bkz. docs\KURULUM.md)." }
}
foreach ($p in @(@('SOD_POSTGRES_PORT', '5434'), @('ACCOUNT_API_PORT', '4100'), @('VISION_PORT', '8001'))) {
  $port = [int](Get-Setting $p[0] $p[1])
  $who = Get-PortUser $port
  if ($who) {
    $free = $port + 10000
    while (Get-PortUser $free) { $free += 1 }
    Set-Setting $p[0] $free
    Write-Host "  $port portu dolu ($who): bu sistemde $free kullanılıyor. Uygulamayı etkilemez, $($p[0]) olarak .env dosyasına yazıldı." -ForegroundColor Yellow
  }
}

# 4) Derle + başlat
$volumeExisted = $false
docker volume inspect (Get-Setting 'SOD_PGDATA_VOLUME' 'sod_pgdata') *> $null
if ($LASTEXITCODE -eq 0) { $volumeExisted = $true }

Step "Sistem derleniyor ve başlatılıyor (ilk seferde 10-15 dakika sürebilir, sonrakiler hızlıdır)..."
Compose up -d --build --remove-orphans
if ($LASTEXITCODE -ne 0) {
  Fail "Başlatılamadı: derleme hatası olabilir ya da $base / $siteBase portunu başka bir program kullanıyor olabilir. Yukarıdaki hata mesajına bakın."
}

Step "Sistemin hazır olması bekleniyor..."
$required = @("$base/healthz", "$base/api/account/health", "$base/home")
$optional = @("$base/api/deciship/health", "$base/deciship/")
$deadline = (Get-Date).AddMinutes(4)
$pending = $required + $optional
while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
  $pending = @($pending | Where-Object { -not (Test-Url $_) })
  if ($pending.Count -gt 0) { Start-Sleep 3 }
}
$pendingRequired = @($pending | Where-Object { $required -contains $_ })
$pendingOptional = @($pending | Where-Object { $optional -contains $_ })
if ($pendingRequired.Count -gt 0) {
  Write-Host "Yanıt vermeyenler: $($pending -join ', ')" -ForegroundColor Yellow
  Compose ps
  Compose logs --tail 30 account-api deciship-api gateway
  Fail "Sistem tam açılamadı. Yukarıdaki kayıtlara bakın."
}
if ($pendingOptional.Count -gt 0) {
  Write-Host "Uyarı: DeciShip açılamadı; giriş ve Merkez çalışıyor. Yanıt vermeyenler: $($pendingOptional -join ', ')" -ForegroundColor Yellow
  Compose logs --tail 30 deciship-api
}

# 5) İmza anahtarı yayında mı (DeciShip jetonları bununla doğrular)
if (-not (Test-Url "$base/api/account/.well-known/jwks.json")) {
  Write-Host "Uyarı: imza anahtarı (JWKS) yayında değil; DeciShip oturum doğrulayamaz." -ForegroundColor Yellow
}

# 6) Demo hesapları: ilk kurulumda (boş veritabanı) otomatik
$seedFailed = $false
if ($realUse) {
  if ($freshEnv -or -not $volumeExisted) { Write-Host "Gerçek kullanım: boş veritabanına demo hesapları yüklenmedi." -ForegroundColor Yellow }
} elseif ($freshEnv -or -not $volumeExisted) { $seedFailed = -not (Invoke-Seed) }

Write-Host ""
Write-Host "================== SellerOnData hazır ==================" -ForegroundColor Green
Write-Host "  Uygulama   : $base"
if ($realUse) {
  Write-Host "               Gerçek kullanım: kendi hesabınızla girin (demo hesap yok)."
} elseif ($seedFailed) {
  Write-Host "               Demo hesapları YÜKLENMEDİ (yukarıdaki uyarıya bakın). Yeniden denemek: scripts\demo.ps1 -Seed" -ForegroundColor Yellow
} else {
  Write-Host "               sahip@demo.sellerondata.com / Demo12345!   (diğer demo hesaplar: docs\KURULUM.md)"
}
Write-Host "  Tanıtım    : $siteBase"
Write-Host "  Gelen postalar: POSTA.bat   (doğrulama ve şifre bağlantıları yerelde buraya düşer)"
if ($realUse) { Write-Host "  Durdurmak  : DURDUR.bat     Yedek: YEDEKLE.bat" }
else { Write-Host "  Durdurmak  : DURDUR.bat     Sıfırlamak: SIFIRLA.bat     Demo hesapları yeniden: scripts\demo.ps1 -Seed" }
Write-Host "========================================================" -ForegroundColor Green
# Yedek durumu (gece yedeği, dış kopya): sorun varsa her açılışta kırmızı yazılır. Yan yana ikinci sistemde (e2e) bakılmaz.
if ($project -eq 'sellerondata' -and -not $env:SOD_ENV_FILE) {
  $yedekDurum = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'yedek-zamanla.ps1') durum 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "YEDEKTE SORUN VAR:" -ForegroundColor Red
    foreach ($l in $yedekDurum) { if ($l -match '^Günlük') { break }; if ($l.Trim()) { Write-Host "  $l" -ForegroundColor Red } }
    Write-Host "  Ayrıntı: powershell -File scripts\yedek-zamanla.ps1 durum   (docs\KURULUM.md 'Yedek ve geri yükleme')" -ForegroundColor Red
  }
}
if (-not $NoBrowser) { Start-Process $base }
if (-not $Yes) { Read-Host "Bu pencereyi kapatabilirsiniz (sistem arka planda çalışmaya devam eder). Enter" }
