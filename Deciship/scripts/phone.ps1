# Fiziksel Android telefonu SellerOnData sunucusuna bağlar (USB veya kablosuz hata ayıklama).
#  1) Bağlı telefonu bulur (emülatörleri atlar)
#  2) Release APK'yı kurar/günceller
#  3) adb reverse ile telefondaki 127.0.0.1:8088 -> bilgisayardaki gateway (:8088)
#     Böylece Wi-Fi/IP/Güvenlik Duvarı ayarı gerekmez. Uygulamada sunucu adresi: http://127.0.0.1:8088
# Kullanım:  powershell -ExecutionPolicy Bypass -File scripts\phone.ps1 [-NoInstall]
#   -Watch  sürekli çalışır; ~3 sn'de bir tüm bağlı cihazlarda (telefon + emülatör) reverse'ü kontrol eder,
#           kopmuşsa yeniden kurar. Ctrl+C ile durur. (kurulum yapmaz)
param([switch]$NoInstall, [switch]$Watch)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$adb = "$sdk\platform-tools\adb.exe"
$apk = "$root\apps\mobile\android\app\build\outputs\apk\release\app-release.apk"

& $adb start-server | Out-Null

if ($Watch) {
  $Host.UI.RawUI.WindowTitle = "SellerOnData ADB köprüsü"
  Write-Host "ADB köprüsü izleniyor (tcp:8088). Durdurmak için Ctrl+C." -ForegroundColor Green
  while ($true) {
    try {
      $devs = & $adb devices 2>$null | Select-Object -Skip 1 | Where-Object { $_ -match "\S" }
      foreach ($l in $devs) {
        $serial, $state = ($l -split "\s+")[0, 1]
        if ($state -ne "device") { continue }
        $rev = (& $adb -s $serial reverse --list 2>$null) -join "`n"
        if ($rev -notmatch "tcp:8088\s+tcp:8088") {
          & $adb -s $serial reverse tcp:8088 tcp:8088 2>$null | Out-Null
          if ($LASTEXITCODE -eq 0) { Write-Host ("[{0}] {1}: bağlantı yeniden kuruldu" -f (Get-Date -Format "HH:mm:ss"), $serial) -ForegroundColor Cyan }
        }
      }
    } catch { }
    Start-Sleep -Seconds 3
  }
}

$lines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\S" }
$phones = @(); $unauth = @()
foreach ($l in $lines) {
  $serial, $state = ($l -split "\s+")[0, 1]
  if ($serial -like "emulator-*") { continue }
  if ($state -eq "device") { $phones += $serial } elseif ($state -eq "unauthorized") { $unauth += $serial }
}
if ($unauth.Count -gt 0 -and $phones.Count -eq 0) {
  Write-Host "Telefon bulundu ama izin verilmedi. Telefon ekranındaki 'USB hata ayıklamasına izin verilsin mi?' sorusuna 'Her zaman izin ver' + 'İzin ver' deyin, sonra bu betiği tekrar çalıştırın." -ForegroundColor Yellow
  exit 1
}
if ($phones.Count -eq 0) {
  Write-Host "Telefon bulunamadı. USB kablosunu takın ve telefonda 'USB hata ayıklama'nın açık olduğundan emin olun (TELEFON-KURULUM.md, adım 1-2)." -ForegroundColor Yellow
  exit 1
}
$s = $phones[0]
$model = (& $adb -s $s shell getprop ro.product.model).Trim()
Write-Host "Telefon: $model ($s)" -ForegroundColor Green

if (-not $NoInstall) {
  if (-not (Test-Path $apk)) { Write-Host "APK yok: $apk" -ForegroundColor Red; exit 1 }
  Write-Host "Uygulama kuruluyor/güncelleniyor (1-2 dk)..."
  & $adb -s $s install -r $apk
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Kurulum başarısız. Telefonda başka imzalı eski bir SellerOnData varsa kaldırıp tekrar deneyin: adb -s $s uninstall com.sellerondata.app" -ForegroundColor Red
    exit 1
  }
}

& $adb -s $s reverse tcp:8088 tcp:8088 | Out-Null
Write-Host ""
Write-Host "Hazır. Telefonda SellerOnData'yı açın." -ForegroundColor Green
Write-Host "  Sunucu adresi (giriş ekranının altında):  http://127.0.0.1:8088"
Write-Host "  Giriş: e-posta veya telefon + şifre. Çalışan ilk girişini 'Davet kodum var' ile yapar."
Write-Host "Not: Kablo çıkarılırsa ya da telefon yeniden başlarsa bu betiği tekrar çalıştırın (-NoInstall ile hızlı)."
