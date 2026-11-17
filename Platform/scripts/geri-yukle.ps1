# SellerOnData geri yükleme: bir yedek klasöründen (ya da bilgisayar dışı şifreli kopyadan) sistemi geri kurar.
# Varsayılan PROVADIR: canlıya dokunmaz, ayrı bir yığına ("sellerondata-prova", hacimler sod_prova_*, Postgres 15444) kurar ve
# her tablonun satır sayısını ve dosya sayısını yedekle karşılaştırır. Ayrıntı: docs\KURULUM.md "Yedek ve geri yükleme".
#   (parametresiz)          en yeni yerel yedekle prova (veritabanı + dosya deposu, uygulama açılmaz)
#   -Yedek <klasör|dosya>   yedek klasörü ya da sellerondata-yedek-*.sodyedek (parola SOD_BACKUP_PASSWORD ya da sorulur)
#   -Tam                    prova yığınının tamamını da aç (derler): http://localhost:18098; kaydı olup diskte olmayan dosya da sayılır
#   -ProvaKaldir            prova yığınını, hacimlerini ve çözülmüş kopyaları siler (canlıya dokunmaz)
#   -YalnizAc [-Hedef <k>]  şifreli kopyayı yalnız çözüp klasöre açar (açılan klasör kalır; işiniz bitince silin)
#   -Canli -Yedek <k|d>     CANLI sistemi yedekle değiştirir: EVET yazdırır, önce güvenlik yedeği (yedekler\guvenlik-<tarih>) alır.
# Çalışırken yedek kilidini tutar: gece yedeği aynı anda başlamaz, saklama geri yüklenen yedeği silemez.
# Çıkış: 0 tamam, 1 hata (prova tutmadı dahil), 2 yanlış kullanım ya da onay verilmedi.
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param([string]$Yedek, [switch]$Tam, [switch]$ProvaKaldir, [switch]$YalnizAc, [string]$Hedef, [switch]$Canli)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
. (Join-Path $PSScriptRoot 'yedek-ortak.ps1')

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$project = if ($env:SOD_PROJECT) { $env:SOD_PROJECT } else { 'sellerondata' }
$envFile = if ($env:SOD_ENV_FILE) { Join-Path $root $env:SOD_ENV_FILE } else { Join-Path $root '.env' }
function Ayar($ad, $varsayilan) { Get-AyarDegeri $ad $varsayilan $envFile }
function Tam-Yol($p) { if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $root $p } }
function Hata($msg) { throw [Exception]::new($msg) }
function Adim($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
# Adı "Docker" olamaz: PowerShell işlevi programdan önce bulur, kendini sonsuz çağırırdı.
function DockerCalistir([string[]]$a) { Invoke-Arac docker $a }
function Kap($proje) {
  (DockerCalistir @('ps', '-a', '-q', '--filter', "label=com.docker.compose.project=$proje", '--filter', 'label=com.docker.compose.service=postgres')).Satirlar | Select-Object -First 1
}

if (@($Canli, $ProvaKaldir, $YalnizAc | Where-Object { $_ }).Count -gt 1) { Write-Host '-Canli, -ProvaKaldir ve -YalnizAc birlikte kullanılmaz.' -ForegroundColor Red; exit 2 }
if ($Tam -and ($Canli -or $ProvaKaldir -or $YalnizAc)) { Write-Host '-Tam yalnız provada kullanılır.' -ForegroundColor Red; exit 2 }
if ($Canli -and -not $Yedek) { Write-Host '-Canli için hangi yedeğin kurulacağını -Yedek <klasör|dosya> ile açıkça verin.' -ForegroundColor Red; exit 2 }

$yedekKok = Tam-Yol (Ayar 'SOD_BACKUP_DIR' 'yedekler')
New-Item -ItemType Directory -Force $yedekKok | Out-Null
$yedekKok = (Resolve-Path -LiteralPath $yedekKok).Path
$provaDir = Join-Path $yedekKok '_prova'
$provaEnv = Join-Path $provaDir 'prova.env'
$acilanKok = Join-Path $yedekKok '_acilan'
$canliPgHacim = Ayar 'SOD_PGDATA_VOLUME' 'sod_pgdata'
$canliDosyaHacim = Ayar 'SOD_STORAGE_VOLUME' 'sod_deciship_storage'
$canliHacimler = @($canliPgHacim, $canliDosyaHacim, 'sod_pgdata', 'sod_deciship_storage')

# Prova adı ve hacimleri sabittir; yine de her çalıştırmada canlıdan ayrı oldukları denetlenir.
Assert-ProvaGuvenli $script:ProvaProje $script:ProvaPgHacim $script:ProvaDosyaHacim $project $canliHacimler

# İşlem ortamındaki değerler compose'da ayar dosyasını ezer: prova değerleri ortama da yazılır.
function Set-ProvaOrtami([System.Collections.IDictionary]$a) {
  foreach ($k in $a.Keys) { [Environment]::SetEnvironmentVariable($k, $(if ($a[$k] -eq '') { $null } else { $a[$k] }), 'Process') }
}
function ComposeProva([string[]]$a) {
  $taban = @('compose', '-p', $script:ProvaProje)
  if (Test-Path -LiteralPath $provaEnv) { $taban += @('--env-file', $provaEnv) }
  Invoke-Arac docker ($taban + @('-f', (Join-Path $root 'docker-compose.yml')) + $a)
}
function ComposeCanli([string[]]$a) {
  $taban = @('compose', '-p', $project)
  if (Test-Path -LiteralPath $envFile) { $taban += @('--env-file', $envFile) }
  Invoke-Arac docker ($taban + @('-f', (Join-Path $root 'docker-compose.yml')) + $a)
}

# Yedek kilidi (yedekle.ps1 ile aynı dosya): gece yedeği ve saklama bu sırada çalışmaz.
$kilit = $null
if (-not $YalnizAc) {
  try { $kilit = [IO.File]::Open((Join-Path $yedekKok '.yedek.kilit'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { Write-Host 'Şu an bir yedek ya da başka bir geri yükleme sürüyor; bitince yeniden deneyin.' -ForegroundColor Red; exit 1 }
}
$script:acilanKlasor = $null
$script:kod = 0
# Gövde işlev içinde: "return" ile erken bitiş çıkış kodunu bozmasın ($script:kod en sonda exit ile verilir).
function Invoke-Ana {
  # ---------- Prova yığınını kaldır ----------
  if ($ProvaKaldir) {
    Adim "Prova yığını kaldırılıyor ($($script:ProvaProje))"
    $r = ComposeProva @('down', '--remove-orphans', '--rmi', 'local')
    if ($r.Kod -ne 0) { Hata "Prova yığını kapatılamadı: $($r.Satirlar | Select-Object -Last 3)" }
    foreach ($h in @($script:ProvaPgHacim, $script:ProvaDosyaHacim)) {
      if ((DockerCalistir @('volume', 'inspect', $h)).Kod -eq 0) {
        $r = DockerCalistir @('volume', 'rm', $h)
        if ($r.Kod -ne 0) { Hata "Hacim silinemedi: $h ($($r.Satirlar -join ' '))" }
        Write-Host "  hacim silindi: $h"
      }
    }
    if (Test-Path -LiteralPath $provaDir) { Remove-Item -LiteralPath $provaDir -Recurse -Force }
    if (Test-Path -LiteralPath $acilanKok) { Remove-Item -LiteralPath $acilanKok -Recurse -Force; Write-Host '  çözülmüş kopyalar silindi (_acilan)' }
    Write-Host 'Prova kaldırıldı. Canlı sisteme dokunulmadı.' -ForegroundColor Green
    return
  }

  # ---------- Yedeği bul (şifreliyse çöz) ----------
  if (-not $Yedek) {
    if ($YalnizAc) { Write-Host '-YalnizAc için -Yedek <dosya.sodyedek> verin.' -ForegroundColor Red; $script:kod = 2; return }
    $son = Get-ChildItem -LiteralPath $yedekKok -Directory | Where-Object { (ConvertFrom-YedekAdi $_.Name) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'veritabani.dump')) } |
      Sort-Object Name -Descending | Select-Object -First 1
    if (-not $son) { Hata "Yerel yedek yok: $yedekKok" }
    $Yedek = $son.FullName
  }
  $Yedek = Tam-Yol $Yedek
  if (-not (Test-Path -LiteralPath $Yedek)) { Hata "Yedek bulunamadı: $Yedek" }
  if ((Get-Item -LiteralPath $Yedek).PSIsContainer) {
    if ($YalnizAc) { Write-Host '-YalnizAc şifreli dosya ister (.sodyedek).' -ForegroundColor Red; $script:kod = 2; return }
    $klasor = (Resolve-Path -LiteralPath $Yedek).Path
  } else {
    Adim "Şifreli kopya çözülüyor: $Yedek"
    $parola = Ayar 'SOD_BACKUP_PASSWORD' ''
    if (-not $parola) {
      $g = Read-Host 'Yedek parolası' -AsSecureString
      $parola = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($g))
    }
    $acilan = if ($Hedef) { Tam-Yol $Hedef } else { $acilanKok }
    New-Item -ItemType Directory -Force $acilan | Out-Null
    # Çözülen kopyada sırlar açık durur: klasör yalnız bu kullanıcıya açık.
    Set-YalnizBen $acilan
    $tarDosya = Join-Path $acilan ((Split-Path -Leaf $Yedek) + '.tar')
    try {
      Unprotect-YedekDosyasi $Yedek $tarDosya $parola
      $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
      $liste = Invoke-Arac $tarExe @('-tf', $tarDosya)
      if ($liste.Kod -ne 0) { Hata "Paket okunamadı: $($liste.Satirlar -join ' ')" }
      $ust = @($liste.Satirlar | ForEach-Object { ($_ -replace '^\./', '') -split '[\\/]' | Select-Object -First 1 } | Where-Object { $_ } | Sort-Object -Unique)
      if ($ust.Count -ne 1) { Hata 'Paket beklenen biçimde değil (tek klasör olmalı).' }
      $klasor = Join-Path $acilan $ust[0]
      if (Test-Path -LiteralPath $klasor) { Remove-Item -LiteralPath $klasor -Recurse -Force }
      $r = Invoke-Arac $tarExe @('-xf', $tarDosya, '-C', $acilan)
      if ($r.Kod -ne 0) { Hata "Paket açılamadı: $($r.Satirlar -join ' ')" }
    } finally { if (Test-Path -LiteralPath $tarDosya) { Remove-Item -LiteralPath $tarDosya -Force } }
    Write-Host "Açıldı: $klasor" -ForegroundColor Green
    if ($YalnizAc) { Write-Host 'Klasörde sırlar (.env, anahtar) açık duruyor: işiniz bitince silin.' -ForegroundColor Yellow; return }
    # İş bitince (başarılı ya da değil) çözülen kopya silinir.
    if (-not $Hedef) { $script:acilanKlasor = $klasor }
  }

  # ---------- Yedeği denetle ----------
  Adim "Yedek denetleniyor: $klasor"
  $dump = Join-Path $klasor 'veritabani.dump'
  $tarGz = Join-Path $klasor 'dosyalar.tar.gz'
  foreach ($f in @($dump, $tarGz)) { if (-not (Test-Path -LiteralPath $f)) { Hata "Yedekte eksik dosya: $f" } }
  $kunye = $null
  $kunyeYolu = Join-Path $klasor 'yedek.json'
  if (Test-Path -LiteralPath $kunyeYolu) {
    $kunye = Get-Content -LiteralPath $kunyeYolu -Raw -Encoding UTF8 | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash.ToLowerInvariant() -ne $kunye.veritabani.sha256) { Hata 'veritabani.dump bozuk (SHA-256 künyeyle tutmuyor).' }
    if ((Get-FileHash -LiteralPath $tarGz -Algorithm SHA256).Hash.ToLowerInvariant() -ne $kunye.dosyalar.sha256) { Hata 'dosyalar.tar.gz bozuk (SHA-256 künyeyle tutmuyor).' }
    Write-Host "  künye tamam: $($kunye.ad), $($kunye.veritabani.satir) satır, $($kunye.dosyalar.adet) dosya, commit $($kunye.commit)"
  } else { Write-Host '  UYARI: künye (yedek.json) yok: eski biçim yedek; sayılar dökümden çıkarılacak.' -ForegroundColor Yellow }
  $yedekEnv = Join-Path $klasor 'sirlar\.env'
  $yedekKeys = Join-Path $klasor 'sirlar\keys'

  # Veritabanını ve dosya deposunu verilen kaba/hacme kurar, sayıları karşılaştırır. Dönüş: özet metni.
  # $RolParolaEnv: doluysa rol parolaları bu ayar dosyasındaki değerlerle eşitlenir (canlı: var olan küme başka parolayla kurulmuş olabilir).
  function Restore-Hedef([string]$PgKap, [string]$DosyaHacmi, [bool]$Temizle, [string]$RolParolaEnv) {
    $imaj = ((DockerCalistir @('inspect', '-f', '{{.Config.Image}}', $PgKap)).Satirlar -join '').Trim()
    $kapDump = '/tmp/sod-geri.dump'; $kapBetik = '/tmp/sod-yedek-kap.sh'
    try {
      $r = DockerCalistir @('cp', (Join-Path $PSScriptRoot 'yedek-kap.sh'), "${PgKap}:$kapBetik"); if ($r.Kod -ne 0) { Hata "Betik kaba kopyalanamadı: $($r.Satirlar -join ' ')" }
      $r = DockerCalistir @('cp', $dump, "${PgKap}:$kapDump"); if ($r.Kod -ne 0) { Hata "Döküm kaba kopyalanamadı: $($r.Satirlar -join ' ')" }
      $r = DockerCalistir @('exec', $PgKap, 'bash', $kapBetik, 'say', $kapDump)
      if ($r.Kod -ne 0) { Hata "Döküm okunamadı (çıkış $($r.Kod)): $($r.Satirlar | Select-Object -Last 3)" }
      $beklenen = ConvertFrom-SayimCiktisi $r.Satirlar
      if ($kunye) {
        $kb = [ordered]@{}; foreach ($p in $kunye.veritabani.tablolar.PSObject.Properties) { $kb[$p.Name] = [long]$p.Value }
        $f = Compare-Sayimlar $kb $beklenen
        if ($f.Count) { Hata "Döküm künyeyle tutmuyor: $($f -join '; ')" }
      }
      Write-Host '  veritabanı kuruluyor (tek işlem; hata olursa hiçbir şey değişmez)...'
      $r = DockerCalistir @('exec', $PgKap, 'bash', $kapBetik, 'geri', $kapDump, 'sellerondata')
      if ($r.Kod -ne 0) { Hata "Veritabanı geri yüklenemedi: $($r.Satirlar | Select-Object -Last 5)" }
      if ($RolParolaEnv) {
        # Adlar elle yazılmaz: SOD_ENV, süper kullanıcı ve her kiracı rolünün parolası ayar dosyasından desenle (yedek-ortak.ps1).
        # Değerler komut satırına yazılmaz: docker exec -e AD, değeri bu sürecin ortamından alır. Üretimde (SOD_ENV=production)
        # değeri olmayan ya da *_dev değerli rol varsa kap betiği hiçbir parolayı değiştirmeden durur.
        $adlar = @(Get-RolParolaAdlari $RolParolaEnv)
        $onceki = @{}
        $a = @('exec')
        foreach ($ad in $adlar) {
          $onceki[$ad] = [Environment]::GetEnvironmentVariable($ad, 'Process')
          $v = Get-AyarDegeri $ad '' $RolParolaEnv
          [Environment]::SetEnvironmentVariable($ad, $(if ($v) { $v } else { $null }), 'Process')
          if ($v) { $a += @('-e', $ad) }
        }
        $r = DockerCalistir ($a + @($PgKap, 'bash', $kapBetik, 'rol-parola', 'sellerondata'))
        foreach ($ad in $adlar) { [Environment]::SetEnvironmentVariable($ad, $onceki[$ad], 'Process') }
        if ($r.Kod -ne 0) { Hata "Rol parolaları .env ile eşitlenemedi: $($r.Satirlar | Select-Object -Last 3)" }
        Write-Host '  rol parolaları .env ile eşitlendi'
      }
      $r = DockerCalistir @('exec', $PgKap, 'bash', $kapBetik, 'say-db', 'sellerondata')
      if ($r.Kod -ne 0) { Hata "Geri yüklenen veritabanı sayılamadı: $($r.Satirlar | Select-Object -Last 3)" }
      $bulunan = ConvertFrom-SayimCiktisi $r.Satirlar
      $f = Compare-Sayimlar $beklenen $bulunan
      if ($f.Count) { Hata "Satır sayıları tutmuyor: $($f -join '; ')" }
      $satir = 0L; foreach ($v in $bulunan.Values) { $satir += $v }
      Write-Host "  veritabanı tamam: $($bulunan.Count) tablo, $satir satır, sayılar yedekle aynı" -ForegroundColor Green
    } finally {
      DockerCalistir @('exec', $PgKap, 'rm', '-f', $kapDump, $kapBetik) | Out-Null
    }

    Write-Host "  dosya deposu açılıyor ($DosyaHacmi; önce geçici klasöre, sayı tutunca yerine)..."
    $a = @('run', '--rm', '--entrypoint', 'bash', '-v', "${DosyaHacmi}:/data", '-v', "${tarGz}:/y/dosyalar.tar.gz:ro", '-v', "${PSScriptRoot}:/betik:ro", $imaj, '/betik/yedek-kap.sh', 'tar-ac', '/y/dosyalar.tar.gz', '/data')
    if ($Temizle) { $a += 'temizle' }
    $r = DockerCalistir $a
    if ($r.Kod -ne 0) { Hata "Dosya deposu açılamadı: $($r.Satirlar | Select-Object -Last 3)" }
    $ds = ConvertFrom-DosyaSayimi $r.Satirlar
    if ($kunye -and $null -ne $kunye.dosyalar.adet -and [long]$kunye.dosyalar.adet -ne $ds.Dosya) { Hata "Dosya sayısı tutmuyor: $($ds.Dosya) (yedekte $($kunye.dosyalar.adet))." }
    Write-Host "  dosya deposu tamam: $($ds.Dosya) dosya" -ForegroundColor Green
    return "$($bulunan.Count) tablo, $satir satır, $($ds.Dosya) dosya"
  }

  if (-not $Canli) {
    # ---------- PROVA ----------
    Adim "Prova: ayrı yığın $($script:ProvaProje) (canlıya dokunulmaz)"
    if (Kap $script:ProvaProje) { Hata "Önceki prova duruyor. Önce: powershell -File scripts\geri-yukle.ps1 -ProvaKaldir" }
    foreach ($h in @($script:ProvaPgHacim, $script:ProvaDosyaHacim)) {
      if ((DockerCalistir @('volume', 'inspect', $h)).Kod -eq 0) { Hata "Önceki provanın hacmi duruyor ($h). Önce: -ProvaKaldir" }
    }
    New-Item -ItemType Directory -Force $provaDir | Out-Null
    Set-YalnizBen $provaDir
    $provaKeys = Join-Path $provaDir 'keys'
    if (Test-Path -LiteralPath $provaKeys) { Remove-Item -LiteralPath $provaKeys -Recurse -Force }
    if (Test-Path -LiteralPath $yedekKeys) { Copy-Item -LiteralPath $yedekKeys -Destination $provaKeys -Recurse }
    else { New-Item -ItemType Directory -Force $provaKeys | Out-Null; Write-Host '  UYARI: yedekte keys\ yok.' -ForegroundColor Yellow }
    # Yedeğin kendi .env'i (aynı veritabanı parolaları gerekir); eski biçim yedekte canlı .env.
    $kaynakEnv = if (Test-Path -LiteralPath $yedekEnv) { $yedekEnv } else { Write-Host '  UYARI: yedekte .env yok; canlı .env kullanılıyor.' -ForegroundColor Yellow; $envFile }
    $metin = if (Test-Path -LiteralPath $kaynakEnv) { Get-Content -LiteralPath $kaynakEnv -Raw -Encoding UTF8 } else { '' }
    $ayarlar = Get-ProvaAyarlari $provaKeys
    Write-Utf8Dosya $provaEnv (Set-EnvMetni $metin $ayarlar)
    Set-ProvaOrtami $ayarlar

    # Son güvenlik: compose'un çözdüğü hacim adları prova adları mı?
    $r = ComposeProva @('config', '--format', 'json')
    if ($r.Kod -ne 0) { Hata 'Prova ayarı okunamadı (docker compose config).' }
    $cfg = ($r.Satirlar -join "`n") | ConvertFrom-Json
    $cozulen = @($cfg.volumes.PSObject.Properties | ForEach-Object { $_.Value.name })
    foreach ($h in $cozulen) { if ($canliHacimler -contains $h -or -not $h.StartsWith('sod_prova_')) { Hata "Prova canlı hacmi kullanacaktı ($h); durduruldu." } }

    Adim 'Prova veritabanı açılıyor (boş hacim; roller yedeğin .env parolalarıyla kurulur)'
    $r = ComposeProva @('up', '-d', '--wait', 'postgres')
    if ($r.Kod -ne 0) { Hata "Prova veritabanı açılamadı: $($r.Satirlar | Select-Object -Last 5)" }
    $pk = Kap $script:ProvaProje
    if (-not $pk) { Hata 'Prova veritabanı kabı bulunamadı.' }
    $r = DockerCalistir @('volume', 'create', '--label', "com.docker.compose.project=$($script:ProvaProje)", '--label', 'com.docker.compose.volume=sod_deciship_storage', $script:ProvaDosyaHacim)
    if ($r.Kod -ne 0) { Hata "Prova dosya hacmi açılamadı: $($r.Satirlar -join ' ')" }

    Adim 'Yedek prova yığınına kuruluyor'
    $ozet = Restore-Hedef $pk $script:ProvaDosyaHacim $false ''

    if ($Tam) {
      Adim 'Prova yığınının tamamı açılıyor (derleme; ilk sefer 10-15 dk)'
      $r = ComposeProva @('up', '-d', '--build', '--wait')
      if ($r.Kod -ne 0) { Hata "Prova yığını açılamadı: $($r.Satirlar | Select-Object -Last 8)" }
      # Kaydı olup diskte olmayan dosya (MISSING) sıfır olmalı: veritabanı ve dosya arşivi aynı anın.
      $r = ComposeProva @('exec', '-T', 'deciship-api', 'node', 'dist/cli/storageOrphans.js', '--min-age-hours', '0')
      $eksik = ConvertFrom-OrphanOzeti $r.Satirlar
      if ($r.Kod -ne 0 -or $null -eq $eksik) { Hata "Dosya denetimi (storage:orphans) çalışmadı: $($r.Satirlar | Select-Object -Last 3)" }
      if ($eksik -gt 0) { Hata "Kaydı olup diskte olmayan $eksik dosya var (MISSING): $(@($r.Satirlar | Where-Object { $_ -like 'MISSING*' }) | Select-Object -First 3)" }
      Write-Host '  dosya denetimi tamam: kaydı olup diskte olmayan dosya yok (MISSING=0)' -ForegroundColor Green
      $ozet += ', MISSING=0'
      Write-Host '  Uygulama: http://localhost:18098 (yedekteki hesaplarla giriş). Posta ve yapay zekâ kapalı.' -ForegroundColor Green
      Write-Host '  Not: tarayıcı çerezleri porttan bağımsızdır; provada giriş canlı sekmedeki oturumu kapatabilir.'
    }
    Write-Host ''
    Write-Host "PROVA GEÇTİ: $ozet." -ForegroundColor Green
    Write-Host "  Veritabanı: localhost:15444 (psql -h localhost -p 15444 -U postgres sellerondata; parola yedeğin .env'inde)"
    Write-Host '  Kaldırmak: powershell -File scripts\geri-yukle.ps1 -ProvaKaldir'
    return
  }

  # ---------- CANLI ----------
  Adim 'CANLI GERİ YÜKLEME'
  Write-Host "Bu işlem '$project' sisteminin veritabanını ve DeciShip dosyalarını yedekteki hâliyle DEĞİŞTİRİR." -ForegroundColor Red
  Write-Host "Yedek: $klasor$(if ($kunye) { "  (alınma: $($kunye.olusturma), $($kunye.veritabani.satir) satır, $($kunye.dosyalar.adet) dosya)" })"
  Write-Host 'Yedekten sonra girilen her şey (fatura, ölçüm, itiraz, kullanıcı) kaybolur. Önce provayı çalıştırdığınızdan emin olun.'
  if ((Read-Host 'Devam etmek için EVET yazın') -cne 'EVET') { Write-Host 'Vazgeçildi; hiçbir şey değişmedi.'; $script:kod = 2; return }

  # Sırlar: yalnız eksikse yedekten konur; var olanın üzerine yazılmaz. Rol parolaları sonra .env ile eşitlenir.
  if (-not (Test-Path -LiteralPath $envFile) -and (Test-Path -LiteralPath $yedekEnv)) { Copy-Item -LiteralPath $yedekEnv -Destination $envFile; Write-Host '  .env yedekten kondu.' }
  elseif ((Test-Path -LiteralPath $envFile) -and (Test-Path -LiteralPath $yedekEnv) -and
    (Get-FileHash -LiteralPath $envFile).Hash -ne (Get-FileHash -LiteralPath $yedekEnv).Hash) {
    Write-Host '  Not: .env yedektekinden farklı; şimdiki .env korunuyor (yedekteki: sirlar\.env).' -ForegroundColor Yellow
  }
  $keysDir = Tam-Yol (Ayar 'SOD_KEYS_DIR' 'keys')
  if ((-not (Test-Path -LiteralPath $keysDir) -or @(Get-ChildItem -LiteralPath $keysDir -Force).Count -eq 0) -and (Test-Path -LiteralPath $yedekKeys)) {
    New-Item -ItemType Directory -Force $keysDir | Out-Null
    Copy-Item -Path (Join-Path $yedekKeys '*') -Destination $keysDir -Recurse
    Write-Host '  keys\ yedekten kondu.'
  }

  # Veritabanı hacmi duruyorsa içinde veri vardır: kap silinmiş olsa bile önce açılıp güvenlik yedeği alınır.
  $pgHacimVardi = (DockerCalistir @('volume', 'inspect', $canliPgHacim)).Kod -eq 0
  Adim 'Veritabanı açılıyor'
  $r = ComposeCanli @('up', '-d', '--wait', '--no-build', 'postgres')
  if ($r.Kod -ne 0) { Hata "Veritabanı açılamadı: $($r.Satirlar | Select-Object -Last 5)" }
  if ($pgHacimVardi) {
    Adim 'Güvenlik yedeği (şimdiki hâl; geri dönmek gerekirse)'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'yedekle.ps1') -Guvenlik -KilitAtla
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Güvenlik yedeği alınamadı.' -ForegroundColor Red
      if ((Read-Host 'Güvenlik yedeği OLMADAN devam etmek için EVET yazın') -cne 'EVET') { Write-Host 'Vazgeçildi.'; $script:kod = 2; return }
    }
  } else { Write-Host '  Veritabanı hacmi yoktu (boş kurulum): güvenlik yedeği gerekmiyor.' }

  Adim 'Uygulamalar durduruluyor, veritabanı açık kalıyor'
  $r = ComposeCanli @('stop', 'gateway', 'account-api', 'deciship-api', 'hub-web', 'deciship-web')
  if ($r.Kod -ne 0) { Hata "Uygulamalar durdurulamadı: $($r.Satirlar | Select-Object -Last 3)" }
  $pg = Kap $project
  $dosyaHacmi = $canliDosyaHacim
  if ((DockerCalistir @('volume', 'inspect', $dosyaHacmi)).Kod -ne 0) {
    $r = DockerCalistir @('volume', 'create', '--label', "com.docker.compose.project=$project", '--label', 'com.docker.compose.volume=sod_deciship_storage', $dosyaHacmi)
    if ($r.Kod -ne 0) { Hata "Dosya hacmi açılamadı: $($r.Satirlar -join ' ')" }
  }

  Adim 'Yedek canlıya kuruluyor'
  $ozet = Restore-Hedef $pg $dosyaHacmi $true $envFile

  Adim 'Sistem açılıyor'
  $r = ComposeCanli @('up', '-d', '--wait')
  if ($r.Kod -ne 0) { Hata "Sistem açılamadı: $($r.Satirlar | Select-Object -Last 8). Durum: docker compose ps" }
  Write-Host ''
  Write-Host "GERİ YÜKLEME TAMAM: $ozet." -ForegroundColor Green
  Write-Host '  Sonra: docker compose -p sellerondata exec deciship-api node dist/cli/storageOrphans.js (KURULUM.md "Kaydı olmayan disk dosyaları"); MISSING sıfır olmalı.'
}

try { Invoke-Ana }
catch {
  $script:kod = 1
  Write-Host ''
  Write-Host "HATA: $($_.Exception.Message)" -ForegroundColor Red
  if ($Canli) { Write-Host 'Canlı geri yükleme yarıda kaldı. Güvenlik yedeği: Platform\yedekler\guvenlik-<tarih-saat> (en yenisi). Sistemi açmak: BASLAT.bat' -ForegroundColor Yellow }
} finally {
  if ($script:acilanKlasor -and (Test-Path -LiteralPath $script:acilanKlasor)) { Remove-Item -LiteralPath $script:acilanKlasor -Recurse -Force -ErrorAction SilentlyContinue }
  if ($kilit) { $kilit.Dispose() }
}
exit $script:kod
