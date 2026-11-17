# SellerOnData mobil — Android derlemesi (Windows)
#
# Neden CMake: react-native-worklets C++ derlemesi, SDK'daki CMake 3.22.1'in eski ninja'sı uzun yolları
# desteklemediği için "ninja: error: mkdir(...)" ile düşer. subst/kısa sürücü işe yaramaz (Node gerçek
# yolu C:\ olarak çözer). Çözüm: SDK'ya CMake 3.31.6 (ninja 1.12.1) kurmak; apps/mobile/plugins/
# with-windows-cmake.js bunu prebuild sırasında android/local.properties'e cmake.dir olarak yazar.
# Kayıt defteri değişikliği gerekmez.
#
# Profil ortamı (APP_ENV, EXPO_PUBLIC_API_URL) apps\mobile\eas.json içindeki profilden okunur.
# android\ klasörü, yapılandırma (app.json, app.config.js, eklentiler, package-lock.json) ya da profil
# ortamı değişince kendiliğinden yeniden üretilir. Derleme sonrası APK'nın kimliği (applicationId,
# versionCode) app.json ile karşılaştırılır; uyuşmazsa betik hata verir. Sonuç sod-build.json'a yazılır.
#
# Kullanım:
#   powershell -ExecutionPolicy Bypass -File scripts\android-build.ps1 [-Profile development|preview|production]
#       [-Variant debug|release] [-Device emulator-5554] [-Clean]
# Varsayılan: -Profile development -Variant debug (dev client). preview/production'da -Variant verilmezse release.
param(
  [ValidateSet("development", "preview", "production")]
  [string]$Profile = "development",
  [ValidateSet("debug", "release")]
  [string]$Variant,
  [string]$Device = "emulator-5554",
  [switch]$Clean
)
$ErrorActionPreference = "Stop"
if (-not $Variant) { $Variant = if ($Profile -eq "development") { "debug" } else { "release" } }
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root "apps\mobile"
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }

if (-not (Test-Path (Join-Path $sdk "cmake\3.31.6"))) {
  Write-Host "CMake 3.31.6 kuruluyor..."
  $sdkm = Join-Path $sdk "cmdline-tools\latest\bin\sdkmanager.bat"
  "y`ny`ny`n" | & $sdkm "cmake;3.31.6"
}

Push-Location $mobile
try {
  # 1. Profil ortamı eas.json'dan süreç ortamına konur (tek kaynak eas.json)
  $eas = Get-Content "eas.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  $profileDef = $eas.build.$Profile
  if (-not $profileDef) { throw "eas.json içinde '$Profile' profili yok" }
  $envPairs = @()
  foreach ($p in $profileDef.env.PSObject.Properties) {
    Set-Item -Path ("Env:" + $p.Name) -Value ([string]$p.Value)
    $envPairs += ($p.Name + "=" + $p.Value)
  }
  if ($Profile -ne "development" -and -not ($env:EXPO_PUBLIC_API_URL -like "https://*")) {
    throw "Profil '$Profile': EXPO_PUBLIC_API_URL https:// ile başlamalı (eas.json: '$($env:EXPO_PUBLIC_API_URL)')"
  }
  Write-Host "Profil: $Profile  Varyant: $Variant  APP_ENV=$($env:APP_ENV)  API=$($env:EXPO_PUBLIC_API_URL)"

  # node_modules yoksa ya da package-lock.json son kurulumdan yeniyse (ör. yeni eklenti) kur
  $installed = "node_modules\.package-lock.json"
  if (-not (Test-Path $installed) -or (Get-Item "package-lock.json").LastWriteTime -gt (Get-Item $installed).LastWriteTime) { npm install }

  # 2. Prebuild parmak izi: yapılandırma dosyaları + profil ortamı
  $files = @("app.json", "app.config.js", "package-lock.json", "modules\box-measure\app.plugin.js", "modules\box-measure\expo-module.config.json")
  $files += @(Get-ChildItem "plugins" -Filter "*.js" | Sort-Object Name | ForEach-Object { "plugins\" + $_.Name })
  $parts = @()
  foreach ($f in $files) {
    if (Test-Path $f) { $parts += ($f + ":" + (Get-FileHash -Algorithm SHA256 $f).Hash) } else { $parts += ($f + ":yok") }
  }
  $parts += ("env:" + (($envPairs | Sort-Object) -join "|"))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fingerprint = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))))).Replace("-", "")
  $fpFile = "android\.sod-prebuild"
  $oldFp = if (Test-Path $fpFile) { (Get-Content $fpFile -Raw).Trim() } else { "" }

  if ($Clean -or $oldFp -ne $fingerprint -or -not (Test-Path "android")) {
    Write-Host "android\ yeniden üretiliyor (prebuild)..."
    # Dosya kilidi olmasın: önce Gradle daemon'unu durdur
    if (Test-Path "android\gradlew.bat") { Push-Location android; try { .\gradlew.bat --stop } finally { Pop-Location } }
    if ($Clean) {
      Remove-Item -Recurse -Force "node_modules\react-native-worklets\android\.cxx", "node_modules\react-native-worklets\android\build" -ErrorAction SilentlyContinue
    }
    npx expo prebuild --platform android --clean --no-install
    if ($LASTEXITCODE -ne 0) { throw "prebuild başarısız (çıkış kodu $LASTEXITCODE)" }
    Set-Content -Path $fpFile -Value $fingerprint -Encoding ASCII
  } else {
    Write-Host "android\ güncel (parmak izi aynı), prebuild atlandı."
  }

  # 3. Derleme (Metro ayrı başlatılır: npx expo start --dev-client)
  $runArgs = @("expo", "run:android", "--no-bundler", "--device", $Device)
  if ($Variant -eq "release") { $runArgs += @("--variant", "release") }
  & npx @runArgs
  if ($LASTEXITCODE -ne 0) { throw "derleme başarısız (çıkış kodu $LASTEXITCODE)" }

  # 4. Denetim: çıkan APK'nın kimliği app.json ile aynı olmalı
  $appJson = (Get-Content "app.json" -Raw -Encoding UTF8 | ConvertFrom-Json).expo
  $outDir = Join-Path $mobile "android\app\build\outputs\apk\$Variant"
  $metaFile = Join-Path $outDir "output-metadata.json"
  if (-not (Test-Path $metaFile)) { throw "output-metadata.json bulunamadı: $metaFile" }
  $meta = Get-Content $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $element = @($meta.elements)[0]
  if ($meta.applicationId -ne $appJson.android.package) {
    throw "applicationId uyuşmuyor: APK '$($meta.applicationId)', app.json '$($appJson.android.package)'"
  }
  if ([int]$element.versionCode -ne [int]$appJson.android.versionCode) {
    throw "versionCode uyuşmuyor: APK '$($element.versionCode)', app.json '$($appJson.android.versionCode)'"
  }

  # 5. Derleme kaydı
  $abi = "universal"
  foreach ($flt in @($element.filters)) { if ($flt.filterType -eq "ABI") { $abi = $flt.value } }
  $commit = (git -C $root rev-parse --short HEAD)
  $record = [ordered]@{
    profile       = $Profile
    appEnv        = $env:APP_ENV
    apiUrl        = $env:EXPO_PUBLIC_API_URL
    version       = $appJson.version
    versionCode   = [int]$element.versionCode
    applicationId = $meta.applicationId
    commit        = $commit
    abi           = $abi
    builtAt       = (Get-Date).ToString("o")
  }
  [System.IO.File]::WriteAllText((Join-Path $outDir "sod-build.json"), ($record | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Derleme tamam: $($meta.applicationId) $($appJson.version) ($($element.versionCode)) [$Profile/$Variant, $abi]"

  # 6. Gradle daemon ~3 GB bellek tutar; derleme sonrası kapat
  Push-Location android; try { .\gradlew.bat --stop } finally { Pop-Location }
} finally {
  Pop-Location
}
