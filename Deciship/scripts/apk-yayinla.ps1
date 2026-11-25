# Mobil APK'yı GitHub Releases'a yükler (repo'nun "Releases" bölümünde "DeciShip Android" altında durur).
# APK git'e konmaz (125 MB; GitHub dosya sınırı 100 MB). Patron telefonundan Releases sayfasından indirir.
# Önce APK'yı derleyin: scripts\android-build.ps1 -Profile production
# Yalnız production profilinde derlenmiş APK yüklenir (derleme kaydı: sod-build.json); -AllowNonProduction ile aşılır.
# Kullanım:  powershell -ExecutionPolicy Bypass -File scripts\apk-yayinla.ps1 [-AllowNonProduction]
param([switch]$AllowNonProduction)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root "apps\mobile"
$releaseDir = Join-Path $mobile "android\app\build\outputs\apk\release"
$apk = Join-Path $releaseDir "app-release.apk"
if (-not (Test-Path $apk)) { throw "APK bulunamadı: $apk  (önce scripts\android-build.ps1 -Profile production çalıştırın)" }

$recordFile = Join-Path $releaseDir "sod-build.json"
if (-not (Test-Path $recordFile)) { throw "Derleme kaydı yok: $recordFile  (APK bu betikle derlenmemiş; scripts\android-build.ps1 ile yeniden derleyin)" }
$record = Get-Content $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
$expected = (Get-Content (Join-Path $mobile "app.json") -Raw -Encoding UTF8 | ConvertFrom-Json).expo.android.package
if ($record.applicationId -ne $expected) { throw "applicationId uyuşmuyor: APK '$($record.applicationId)', app.json '$expected'" }
if ($record.profile -ne "production" -and -not $AllowNonProduction) {
  throw "APK '$($record.profile)' profiliyle derlenmiş; yayın için production gerekir (zorlamak için -AllowNonProduction)."
}

$tag = "android"
$out = Join-Path $env:TEMP "DeciShip.apk"
Copy-Item $apk $out -Force
$built = (Get-Item $apk).LastWriteTime.ToString("dd.MM.yyyy HH:mm")
$commit = (git -C $root log -1 --format="%h %s")
$notes = "Derleme: $built`nProfil: $($record.profile)`nAPI adresi: $($record.apiUrl)`nSürüm: $($record.version) (versionCode $($record.versionCode))`nKod: $commit`n`nTelefonda bu sayfayı açıp DeciShip.apk dosyasını indirin ve kurun. Kurulum adımları: TELEFON-KURULUM.md"

Push-Location $root
try {
  # "gh release view" yoksa stderr'e yazar; PS 5.1 + Stop bunu hata sayar. list stderr'e yazmaz.
  $exists = @(gh release list --json tagName --jq '.[].tagName') -contains $tag
  if ($exists) {
    gh release upload $tag $out --clobber
    gh release edit $tag --notes $notes
  } else {
    gh release create $tag $out --title "DeciShip Android" --notes $notes --latest
  }
  if ($LASTEXITCODE -ne 0) { throw "Yükleme başarısız" }
  Write-Host "Yüklendi:" (gh release view $tag --json url --jq .url)
} finally { Pop-Location; Remove-Item $out -ErrorAction SilentlyContinue }
