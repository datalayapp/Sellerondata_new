# SellerOnData geliştirme ortamı: Postgres + görüntü servisi Docker'da, uygulamalar kendi pencerelerinde (hızlı yeniden yükleme).
#   .\scripts\dev.ps1            postgres'i aç, migration uygula, tüm sunucuları başlat
#   .\scripts\dev.ps1 -Seed      ayrıca demo hesaplarını yükle
#   .\scripts\dev.ps1 -NoWeb     arayüzleri açma (yalnız API'ler ve gateway)
# TagPress (platform kipi, API 5422, web 5423) pnpm ister; pnpm yoksa (corepack enable) TagPress atlanır, geri kalanı açılır.
# Yapay zekâ geçidi (ai-api) :4300; araçlar ona bağlanmaz (AI_GATEWAY_URL boş): yalnız Merkez uçları ve anahtar deposu.
# Adres: http://localhost:8088 (scripts\dev-gateway.mjs). Durdurmak için açılan pencereleri kapatın.
# Dosya UTF-8 BOM'ludur (Windows PowerShell 5.1 Türkçe için). BOM'u silmeyin.
param([switch]$Seed, [switch]$NoWeb, [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Gerçek kullanım (scripts\gercek-kullanim.ps1 yazar): bilinen şifreli demo hesaplar gerçek verinin yanına yüklenmez.
$realUse = $null
$envPath = Join-Path $root ".env"
if (Test-Path $envPath) { foreach ($l in (Get-Content $envPath -Encoding UTF8)) { if ($l -match '^\s*SOD_GERCEK_KULLANIM=(.*)$' -and $Matches[1].Trim()) { $realUse = $Matches[1].Trim() } } }
if ($Seed -and $realUse) {
  Write-Host "HATA: Bu kurulum gerçek kullanımda (.env SOD_GERCEK_KULLANIM=$realUse): -Seed demo hesap ekler, çalıştırılmadı." -ForegroundColor Red
  exit 1
}
$deciship = Join-Path (Split-Path -Parent $root) "Deciship"
$tagpress = Join-Path (Split-Path -Parent $root) "Tagpress"
$project = "sellerondata"
function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Need($cmd, $hint) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host "HATA: $cmd bulunamadı. $hint" -ForegroundColor Red; exit 1 } }

Need docker "Docker Desktop'ı kurun ve açın."
Need node "Node.js 24 kurun."
Need npm "Node.js 24 kurun."
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "HATA: Docker Desktop çalışmıyor. Açıp tekrar deneyin." -ForegroundColor Red; exit 1 }
if (-not (Test-Path $deciship)) { Write-Host "HATA: Deciship klasörü bulunamadı: $deciship" -ForegroundColor Red; exit 1 }

# Bağlantı adresleri (ARCHITECTURE §4: uygulama rolleri ve migration rolü ayrıdır)
$pg = "localhost:5434/sellerondata"
# Araç bildirim anahtarı (yalnız yerel; compose varsayılanıyla aynı). Kabukta PRODUCT_NOTIFY_SECRET tanımlıysa o kullanılır.
$notifySecret = if ($env:PRODUCT_NOTIFY_SECRET) { $env:PRODUCT_NOTIFY_SECRET } else { "yerel-bildirim-anahtari-0123456789abcdef" }
$common = @{
  ALLOWED_ORIGINS = "http://localhost:8088,http://localhost:5180"
  TRUST_PROXY_HOPS = "1"
}
# Yapay zekâ geçidinin araç jetonları (yalnız yerel; compose varsayılanlarıyla aynı, `yerel-gecit-` önekli). Kabukta tanımlıysa o.
$aiTokenShip = if ($env:DECISHIP_AI_GATEWAY_TOKEN) { $env:DECISHIP_AI_GATEWAY_TOKEN } else { "yerel-gecit-deciship-0123456789abcdef" }
$aiTokenTp = if ($env:TAGPRESS_AI_GATEWAY_TOKEN) { $env:TAGPRESS_AI_GATEWAY_TOKEN } else { "yerel-gecit-tagpress-0123456789abcdef" }
$account = $common + @{
  PORT = "4100"
  DATABASE_URL = "postgresql://sod_platform:sod_platform_dev@$pg"
  MIGRATE_DATABASE_URL = "postgresql://sod_platform_admin:sod_platform_admin_dev@$pg`?schema=platform"
  APP_BASE_URL = "http://localhost:8088"
  PRODUCT_EVENT_TARGETS = "deciship=http://localhost:4000/api/deciship/internal/events,tagpress=http://localhost:5422/api/tagpress/internal/events"
  PRODUCT_NOTIFY_SECRETS = "deciship=$notifySecret"
  PLATFORM_SERVICE_TARGETS = "ai=http://localhost:4300/api/ai/internal/events"
  EMAIL_VERIFICATION_REQUIRED = "true"
  DEV_MAILBOX = "true"
}
$ship = $common + @{
  PORT = "4000"
  DATABASE_URL = "postgresql://sod_deciship:sod_deciship_dev@$pg"
  ACCOUNT_JWKS_URL = "http://localhost:4100/api/account/.well-known/jwks.json"
  ACCOUNT_NOTIFY_URL = "http://localhost:4100/api/account/internal/notify"
  PRODUCT_NOTIFY_SECRET = $notifySecret
  VISION_URL = "http://localhost:8001"
  ENABLE_DATA_RESET = "true"
  # Geçit adresi verilmez (AI_GATEWAY_URL boş): DeciShip yerelde ANTHROPIC_API_KEY ile doğrudan. Jeton hazır durur.
  AI_GATEWAY_TOKEN = $aiTokenShip
}
if ($env:ANTHROPIC_API_KEY) { $ship["ANTHROPIC_API_KEY"] = $env:ANTHROPIC_API_KEY }
# TagPress platform kipi. Veri klasörü depo dışında: sahibin yerel TagPress verisi (Tagpress\data, 5420) hiç kullanılmaz.
$tp = $common + @{
  TAGPRESS_AUTH = "platform"
  PORT = "5422"
  DATABASE_URL = "postgresql://sod_tagpress:sod_tagpress_dev@$pg"
  ACCOUNT_JWKS_URL = "http://localhost:4100/api/account/.well-known/jwks.json"
  TAGPRESS_DATA_DIR = (Join-Path $env:LOCALAPPDATA "SellerOnData\tagpress-gelistirme")
  AI_GATEWAY_TOKEN = $aiTokenTp
}
$migrateTp = @{ MIGRATE_DATABASE_URL = "postgresql://sod_tagpress_admin:sod_tagpress_admin_dev@$pg`?schema=tagpress" }
$tpWeb = @{ VITE_TAGPRESS_PLATFORM = "1" }
$tpOk = [bool](Get-Command pnpm -ErrorAction SilentlyContinue) -and (Test-Path $tagpress)
if (-not $tpOk) { Write-Host "pnpm ya da Tagpress klasörü yok: TagPress açılmayacak (kurmak için: corepack enable)." -ForegroundColor Yellow }
# Yapay zekâ geçidi. Ana anahtar boş: geliştirme ana anahtarı (yalnız yerel; apps/ai-api/src/env.ts).
$ai = $common + @{
  PORT = "4300"
  DATABASE_URL = "postgresql://sod_ai:sod_ai_dev@$pg"
  ACCOUNT_JWKS_URL = "http://localhost:4100/api/account/.well-known/jwks.json"
  AI_GATEWAY_TOKENS = "deciship=$aiTokenShip,tagpress=$aiTokenTp"
}
$migrateAi = @{ MIGRATE_DATABASE_URL = "postgresql://sod_ai_admin:sod_ai_admin_dev@$pg`?schema=ai" }
$migrateShip = @{
  MIGRATE_DATABASE_URL = "postgresql://sod_deciship_admin:sod_deciship_admin_dev@$pg`?schema=deciship"
  DATABASE_URL = "postgresql://sod_deciship_admin:sod_deciship_admin_dev@$pg`?schema=deciship"
}

# Bir klasörde komutu, verilen ortam değişkenleriyle çalıştır (senkron).
function Invoke-In($dir, $vars, $command) {
  Push-Location $dir
  $saved = @{}
  foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
  try { cmd /c $command; if ($LASTEXITCODE -ne 0) { throw "Komut başarısız: $command ($dir)" } }
  finally {
    foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    Pop-Location
  }
}

# Yeni pencerede uzun süren sunucu başlat.
function Start-Server($title, $dir, $vars, $command) {
  $setters = ($vars.Keys | ForEach-Object { "`$env:$_ = '" + ($vars[$_] -replace "'", "''") + "'" }) -join "; "
  $script = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$dir'; $setters; $command"
  Start-Process powershell -ArgumentList "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $script | Out-Null
  Write-Host "  başlatıldı: $title"
}

# 1) Bağımlılıklar (yalnız eksikse)
Step "Bağımlılıklar"
$apps = @(
  (Join-Path $root "apps\account-api"), (Join-Path $root "apps\hub-web"), (Join-Path $root "apps\ai-api"),
  (Join-Path $deciship "apps\api"), (Join-Path $deciship "apps\web")
)
foreach ($a in $apps) {
  if (-not (Test-Path (Join-Path $a "node_modules"))) { Write-Host "  npm ci: $a"; Invoke-In $a @{} "npm ci" }
}
if ($tpOk -and -not (Test-Path (Join-Path $tagpress "node_modules"))) { Write-Host "  pnpm install: $tagpress"; Invoke-In $tagpress @{} "pnpm install --frozen-lockfile" }

# 2) Postgres + görüntü servisi
Step "Postgres ve görüntü servisi başlatılıyor"
Push-Location $root
docker compose -p $project up -d --wait postgres
$rc = $LASTEXITCODE
if ($rc -ne 0) { Pop-Location; Write-Host "HATA: postgres açılamadı. 5434 portu dolu olabilir." -ForegroundColor Red; exit 1 }
docker compose -p $project run --rm postgres-upgrade
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host "HATA: veritabanı rolleri güncellenemedi." -ForegroundColor Red; exit 1 }
# Görüntü servisi zorunlu değil: açılmazsa yalnız referans kartıyla ölçüm çalışmaz.
$visionOk = $false
docker compose -p $project up -d vision
$visionDeadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $visionDeadline) {
  $vid = (docker compose -p $project ps -q vision | Select-Object -First 1)
  if ($vid) {
    $vstate = (docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $vid)
    if ($vstate -eq "healthy" -or $vstate -eq "running") { $visionOk = $true; break }
  }
  Start-Sleep 3
}
Pop-Location
if (-not $visionOk) { Write-Host "Görüntü servisi açılmadı; referans kartıyla ölçüm çalışmaz, geri kalanı çalışır." -ForegroundColor Yellow }

# 3) Migration
Step "Migration uygulanıyor"
Invoke-In (Join-Path $root "apps\account-api") $account "npx prisma migrate deploy"
Invoke-In (Join-Path $deciship "apps\api") $migrateShip "npx prisma migrate deploy"
Invoke-In (Join-Path $root "apps\ai-api") $migrateAi "npx prisma migrate deploy"
if ($tpOk) { Invoke-In (Join-Path $tagpress "apps\server") $migrateTp "pnpm exec tsx src/bin/migrate-pg.ts" }

if ($Seed) {
  Step "Demo hesapları yükleniyor"
  Invoke-In (Join-Path $root "apps\account-api") $account "npm run seed"
}

# 4) Sunucular
Step "Sunucular başlatılıyor"
Start-Server "account-api :4100" (Join-Path $root "apps\account-api") $account "npm run dev"
Start-Server "deciship-api :4000" (Join-Path $deciship "apps\api") $ship "npm run dev"
Start-Server "ai-api :4300" (Join-Path $root "apps\ai-api") $ai "npm run dev"
# `--yerel` verilmez: TAGPRESS_AUTH=platform ortamdan.
if ($tpOk) { Start-Server "tagpress-api :5422" (Join-Path $tagpress "apps\server") $tp "pnpm exec tsx watch src/main.ts" }
if (-not $NoWeb) {
  Start-Server "hub-web :5180" (Join-Path $root "apps\hub-web") @{} "npm run dev"
  Start-Server "deciship-web :5173" (Join-Path $deciship "apps\web") @{} "npm run dev"
  if ($tpOk) { Start-Server "tagpress-web :5423" (Join-Path $tagpress "apps\web") $tpWeb "pnpm exec vite --port 5423 --strictPort" }
}
Start-Server "gateway :8088" $root @{} "node scripts/dev-gateway.mjs"

Write-Host ""
Write-Host "================ Geliştirme ortamı açılıyor ================" -ForegroundColor Green
Write-Host "  Adres      : http://localhost:8088"
Write-Host "  Demo hesap : sahip@demo.sellerondata.com / Demo12345!   (yüklemek için: -Seed)"
Write-Host "  Durdurmak  : açılan pencereleri kapatın. Postgres için: docker compose -p $project stop"
Write-Host "============================================================" -ForegroundColor Green
if (-not $NoBrowser) { Start-Sleep 6; Start-Process "http://localhost:8088" }
