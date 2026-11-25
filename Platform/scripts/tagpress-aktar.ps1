# TagPress: yerel kipin verisini (SQLite, Tagpress\data) platformdaki bir firmaya (Postgres tagpress şeması + dosya hacmi) aktarır.
# Kapta çalışır: docker compose --profile tools run --build --rm tagpress-aktar (araç: Tagpress/apps/server/src/bin/aktar-pg.ts).
# Aktarım süresince platformdaki TagPress (tagpress-api) durdurulur, sonra yeniden başlatılır.
#   -Firma <kimlik>     hedef Hesap firma kimliği (zorunlu). Firmada TagPress Merkez'den bir kez açılmış olmalı.
#   -KuruCalisma        her şeyi dener ve doğrular, hiçbir şey yazmaz (önce bununla sayı tablosunu okuyun)
#   -YalnizDosyalar     veritabanı aktarılmış, dosya kopyası yarıda kalmışsa yalnız eksik dosyaları kopyalar
#   -Kaynak <klasör>    kaynak veri klasörü (varsayılan ..\Tagpress\data; kapta salt okunur bağlanır, hiç değişmez)
#   -KaynakFirma <k>    kaynakta birden çok firma varsa hangisi (varsayılan kurulumun sahibi)
# Çıkış kodu araçla aynı: 0 tamam, 1 hata, 2 reddedildi (hedef dolu, ikinci koşu …; hiçbir şey yazılmadı), 3 dosyalar eksik.
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param(
  [Parameter(Mandatory = $true)][string]$Firma,
  [switch]$KuruCalisma,
  [switch]$YalnizDosyalar,
  [string]$Kaynak,
  [string]$KaynakFirma
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$project = if ($env:SOD_PROJECT) { $env:SOD_PROJECT } else { "sellerondata" }
$envFile = if ($env:SOD_ENV_FILE) { Join-Path $root $env:SOD_ENV_FILE } else { Join-Path $root ".env" }
function Compose {
  if (Test-Path $envFile) { docker compose -p $project --env-file $envFile @args } else { docker compose -p $project @args }
}
function Fail($msg) { Write-Host ""; Write-Host "HATA: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail "Docker bulunamadı (Docker Desktop açık mı?)." }
if ($Firma -notmatch '^[A-Za-z0-9-]{1,64}$') { Fail "Firma kimliği geçersiz: $Firma" }

# Kaynak klasör: compose bunu /kaynak'a salt okunur bağlar.
if ($Kaynak) {
  $resolved = Resolve-Path -LiteralPath $Kaynak -ErrorAction SilentlyContinue
  if (-not $resolved) { Fail "Kaynak klasör yok: $Kaynak" }
  $env:TAGPRESS_AKTAR_KAYNAK = $resolved.Path
}
$kaynakYolu = if ($env:TAGPRESS_AKTAR_KAYNAK) { $env:TAGPRESS_AKTAR_KAYNAK } else { Join-Path (Split-Path -Parent $root) "Tagpress\data" }
if (-not (Test-Path -LiteralPath (Join-Path $kaynakYolu "studio.db"))) { Fail "Kaynakta studio.db yok: $kaynakYolu" }

# Yerel TagPress açıksa kaynak veritabanı yazılıyor olabilir: önce kapatılsın (araç da kopya sırasında değişikliği yakalar).
$open = Get-NetTCPConnection -LocalPort 5420 -State Listen -ErrorAction SilentlyContinue
if ($open) { Fail "Yerel TagPress açık görünüyor (5420). Önce kapatın, sonra yeniden çalıştırın." }

$toolArgs = @("--hedef-firma", $Firma)
if ($KuruCalisma) { $toolArgs += "--kuru" }
if ($YalnizDosyalar) { $toolArgs += "--yalniz-dosyalar" }
if ($KaynakFirma) { $toolArgs += @("--kaynak-firma", $KaynakFirma) }

Write-Host "==> TagPress aktarımı: $kaynakYolu -> firma $Firma$(if ($KuruCalisma) { ' (kuru çalışma)' })" -ForegroundColor Cyan
# Platformdaki TagPress açıkken aktarılmaz (açıkken yazdıkları aktarılanın üstüne geçebilir; araç da denetler ve reddeder):
# tagpress-api aktarım süresince durdurulur, sonunda (başarıda da hatada da) yeniden başlatılır. Kapalıysa kapalı kalır.
$apiRunning = [bool](Compose ps --status running -q tagpress-api)
$code = 1
try {
  if ($apiRunning) {
    Write-Host "==> TagPress uygulaması (tagpress-api) aktarım süresince durduruluyor" -ForegroundColor Cyan
    Compose stop tagpress-api
    if ($LASTEXITCODE -ne 0) { throw "tagpress-api durdurulamadı; aktarım yapılmadı." }
  }
  # --build: araç kodu değiştiyse kap imajı yenilenir (eski imajla aktarılmaz).
  Compose --profile tools run --build --rm tagpress-aktar @toolArgs
  $code = $LASTEXITCODE
} catch {
  Write-Host ""; Write-Host "HATA: $_" -ForegroundColor Red
  $code = 1
} finally {
  if ($apiRunning) {
    Write-Host "==> TagPress uygulaması yeniden başlatılıyor" -ForegroundColor Cyan
    Compose start tagpress-api
    if ($LASTEXITCODE -ne 0) { Write-Host "UYARI: tagpress-api yeniden başlatılamadı; elle başlatın: docker compose -p $project start tagpress-api" -ForegroundColor Yellow }
  }
}
switch ($code) {
  0 { if ($KuruCalisma) { Write-Host "Kuru çalışma bitti; hiçbir şey yazılmadı. Tablo uygunsa -KuruCalisma olmadan çalıştırın." -ForegroundColor Green } else { Write-Host "Aktarım tamam." -ForegroundColor Green } }
  2 { Write-Host "Aktarım reddedildi; hiçbir şey yazılmadı (nedeni yukarıda)." -ForegroundColor Yellow }
  3 { Write-Host "Veritabanı aktarıldı, dosyalar eksik: sorunu giderip -YalnizDosyalar ile yeniden çalıştırın." -ForegroundColor Yellow }
  default { Write-Host "Aktarım başarısız (kod $code); hiçbir şey yazılmadı." -ForegroundColor Red }
}
exit $code
