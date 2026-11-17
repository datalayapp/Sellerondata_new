# SellerOnData yedeği: veritabanı (pg_dump, özel biçim), DeciShip dosya deposu, sırlar (.env, keys\) ve bilgisayar dışı şifreli kopya.
# Her gece Görev Zamanlayıcı ile çalışır (scripts\yedek-zamanla.ps1 kaydet), elle YEDEKLE.bat. Ayrıntı: docs\KURULUM.md "Yedek ve geri yükleme".
#   (parametresiz)   Platform\yedekler\<tarih-saat>\ (SOD_BACKUP_DIR), saklama uygulanır, SOD_BACKUP_OFFSITE_DIR doluysa şifreli kopya
#   -Dir <klasör>    yedeği tam bu (boş) klasöre yaz; yerel saklama uygulanmaz
#   -Disari <klasör> bilgisayar dışı kopya bu klasöre (SOD_BACKUP_OFFSITE_DIR yerine)
#   -DisariYok       bilgisayar dışı kopya alma
#   -Zamanli         gece görevi: Docker'ı bekler; son 20 saatte başarılı yedek varsa atlar (gün içi ikinci tetikleme yeniden denemedir)
#   -ParolaGoster    şifreli kopyanın parolasını yazar (parola yöneticisine kaydetmek için)
#   -Bekle           bitince Enter bekler (YEDEKLE.bat çift tıklanınca pencere hemen kapanmasın)
#   -Guvenlik        geri yükleme öncesi güvenlik yedeği: yedekler\guvenlik-<tarih-saat>\, saklama ve dış kopya yok (geri-yukle.ps1 çağırır)
#   -KilitAtla       yedek kilidini almaz; yalnız kilidi zaten tutan geri-yukle.ps1 kullanır
#   -YeniTaban       ani düşüş denetimi yapılmaz: veri bilerek silindi, bu yedek yeni taban (gercek-kullanim.ps1 demo silindikten sonra çağırır)
# Çıkış: 0 tamam (dış hedef ayarlı değilse uyarıyla), 1 yedek alınamadı,
#        2 yerel yedek tamam ama sorun var: dış kopya alınamadı, parola yok, saklama ayarı geçersiz ya da ani düşüş (eski yedekler silinmedi).
# Sorun olursa masaüstüne SellerOnData-YEDEK-SORUNU.txt yazılır ve Windows bildirimi denenir; başarılı yedek dosyayı siler.
# Sistem kapalıysa (DURDUR.bat) yalnız veritabanı kabı açılır; yedekten sonra, sistemin başka kabı çalışmıyorsa yine durdurulur.
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param([string]$Dir, [string]$Disari, [switch]$DisariYok, [switch]$Zamanli, [switch]$ParolaGoster, [switch]$Bekle, [switch]$Guvenlik, [switch]$KilitAtla, [switch]$YeniTaban)
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
function Bitir([int]$k) {
  if ($Bekle -and -not $Zamanli) { Write-Host ''; try { Read-Host 'Kapatmak için Enter' | Out-Null } catch { } }
  exit $k
}
if ($Guvenlik) { $DisariYok = $true }

if ($ParolaGoster) {
  $p = Ayar 'SOD_BACKUP_PASSWORD' ''
  if (-not $p) { Write-Host 'Parola henüz yok: bilgisayar dışı kopya ayarlıyken ilk elle çalıştırmada (YEDEKLE.bat) üretilir.'; Bitir 0 }
  Write-Host "Yedek parolası: $p"
  Write-Host 'Parola yöneticisine ya da kâğıda kaydedin. Bu bilgisayar kaybolursa şifreli kopya yalnız bu parolayla açılır.' -ForegroundColor Yellow
  Bitir 0
}

$yedekKok = Tam-Yol (Ayar 'SOD_BACKUP_DIR' 'yedekler')
New-Item -ItemType Directory -Force (Join-Path $yedekKok 'gunluk') | Out-Null
$yedekKok = (Resolve-Path -LiteralPath $yedekKok).Path
$gunluk = Join-Path $yedekKok ("gunluk\yedek-{0}.log" -f (Get-Date -Format 'yyyy-MM'))
$sonJson = Join-Path $yedekKok 'son-yedek.json'
function Log($msg, $renk) {
  $satir = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -LiteralPath $gunluk -Value $satir -Encoding UTF8 } catch { }
  if ($renk) { Write-Host $msg -ForegroundColor $renk } else { Write-Host $msg }
}
function Hata($msg) { throw [Exception]::new($msg) }

# Gün içi yeniden deneme: gece görevi iki kez tetiklenir; ilki başarılıysa ikincisi bir şey yapmaz.
if ($Zamanli -and (Test-Path -LiteralPath $sonJson)) {
  try { $sonKayit = Get-Content -LiteralPath $sonJson -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $sonKayit = $null }
  if (Test-YakindaAlindi $sonKayit (Get-Date)) { Log 'Son 20 saatte başarılı yedek var; gece görevi bu tetiklemeyi atladı.'; exit 0 }
}

# Aynı anda tek yedek ya da geri yükleme (gece görevi, elle çalıştırma, geri-yukle.ps1 çakışmasın).
$kilit = $null
if (-not $KilitAtla) {
  $kilitYolu = Join-Path $yedekKok '.yedek.kilit'
  try { $kilit = [IO.File]::Open($kilitYolu, 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { Log 'Başka bir yedek ya da geri yükleme sürüyor; bu çalıştırma atlandı.' Yellow; Bitir 1 }
}

$kod = 0
$ozet = ''
$sorunlar = @()
$out = $null; $yaziliyor = $null; $pg = $null; $pgBaslattim = $false
$stamp = $null; $kapDosyalari = @()
Log "== Yedek başlıyor (proje $project$(if ($Zamanli) { ', gece görevi' })$(if ($Guvenlik) { ', güvenlik yedeği' }))"
try {
  # Hata yutulmasın: her cmdlet hatası yedeği durdurur (yerel komutlar Invoke-Arac ile, çıkış koduna bakılarak).
  $ErrorActionPreference = 'Stop'

  # 0) Dış kopya hedefi ve parolası
  $disariDir = if ($DisariYok) { '' } elseif ($Disari) { $Disari } else { Ayar 'SOD_BACKUP_OFFSITE_DIR' '' }
  $parola = Ayar 'SOD_BACKUP_PASSWORD' ''
  $parolaKarari = Get-ParolaKarari $disariDir $parola ([bool]$Zamanli)
  if ($parolaKarari -eq 'uret') {
    $yeni = New-YedekParolasi
    Write-Host ''
    Write-Host 'Bilgisayar dışı kopya için yeni parola üretildi:' -ForegroundColor Yellow
    Write-Host "    $yeni" -ForegroundColor Yellow
    Write-Host 'Bu parolayı şimdi parola yöneticisine ya da kâğıda yazın. Bu bilgisayar kaybolursa kopya yalnız bununla açılır.'
    $onay = $null
    try { $onay = Read-Host 'Kaydettiyseniz EVET yazın' } catch { $onay = $null }
    if ($onay -ceq 'EVET') {
      $metin = if (Test-Path -LiteralPath $envFile) { Get-Content -LiteralPath $envFile -Raw -Encoding UTF8 } else { '' }
      Write-Utf8Dosya $envFile (Set-EnvMetni $metin ([ordered]@{ SOD_BACKUP_PASSWORD = $yeni }))
      $parola = $yeni
      Log 'Yeni yedek parolası .env dosyasına yazıldı (SOD_BACKUP_PASSWORD); sahibi kaydettiğini onayladı.'
    } else {
      $parolaKarari = 'elle'
      Log 'Parola onaylanmadı; .env değişmedi, bilgisayar dışı kopya bu sefer alınmayacak.' Yellow
    }
  }

  # 1) Docker
  $dockerBekle = if ($Zamanli) { 600 } else { 0 }
  $t0 = Get-Date
  while ($true) {
    $r = Invoke-Arac docker @('info', '--format', '{{.ServerVersion}}')
    if ($r.Kod -eq 0) { break }
    if (((Get-Date) - $t0).TotalSeconds -ge $dockerBekle) { Hata 'Docker çalışmıyor. Docker Desktop açık mı?' }
    Start-Sleep -Seconds 15
  }

  # 2) Veritabanı kabı
  $pg = ((Invoke-Arac docker @('ps', '-a', '-q', '--filter', "label=com.docker.compose.project=$project", '--filter', 'label=com.docker.compose.service=postgres')).Satirlar | Select-Object -First 1)
  if (-not $pg) { Hata "Veritabanı kabı yok ($project). Sistem hiç kurulmamış ya da silinmiş: BASLAT.bat." }
  function Test-PgCalisiyor { ((Invoke-Arac docker @('inspect', '-f', '{{.State.Running}}', $pg)).Satirlar -join '').Trim() -eq 'true' }
  # Açılışta Docker Desktop kendi kaplarını (restart: unless-stopped) biraz sonra kaldırır: gece görevinde önce o beklenir.
  if (-not (Test-PgCalisiyor) -and $Zamanli -and ((Get-Date) - $t0).TotalSeconds -lt 600) {
    $t1 = Get-Date
    while (-not (Test-PgCalisiyor) -and ((Get-Date) - $t1).TotalSeconds -lt 90) { Start-Sleep -Seconds 10 }
  }
  if (-not (Test-PgCalisiyor)) {
    Log 'Sistem kapalı: yalnız veritabanı yedek için açılıyor.'
    $r = Invoke-Arac docker @('start', $pg)
    if ($r.Kod -ne 0) { Hata "Veritabanı kabı açılamadı: $($r.Satirlar -join ' ')" }
    $pgBaslattim = $true
  }
  $t0 = Get-Date
  while ($true) {
    $saglik = ((Invoke-Arac docker @('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}yok{{end}}', $pg)).Satirlar -join '').Trim()
    if ($saglik -eq 'healthy' -or $saglik -eq 'yok') { break }
    if (((Get-Date) - $t0).TotalSeconds -ge 180) { Hata "Veritabanı hazır değil (durum: $saglik)." }
    Start-Sleep -Seconds 3
  }
  $imaj = ((Invoke-Arac docker @('inspect', '-f', '{{.Config.Image}}', $pg)).Satirlar -join '').Trim()
  $dosyaHacmi = Ayar 'SOD_STORAGE_VOLUME' 'sod_deciship_storage'
  if ((Invoke-Arac docker @('volume', 'inspect', $dosyaHacmi)).Kod -ne 0) { Hata "Dosya deposu hacmi yok: $dosyaHacmi." }

  # 3) Hedef klasör, önceki yedeğin künyesi, boş yer
  $mevcut = @(Get-ChildItem -LiteralPath $yedekKok -Directory | ForEach-Object { $_.Name })
  $oncekiKlasor = Get-ChildItem -LiteralPath $yedekKok -Directory | Where-Object { (ConvertFrom-YedekAdi $_.Name) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'yedek.json')) } |
    Sort-Object Name -Descending | Select-Object -First 1
  $oncekiKunye = $null
  if ($oncekiKlasor) { try { $oncekiKunye = Get-Content -LiteralPath (Join-Path $oncekiKlasor.FullName 'yedek.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $oncekiKunye = $null } }
  $stamp = New-YedekAdi (Get-Date) @($mevcut | ForEach-Object { ($_ -replace '\.yaziliyor$', '') -replace '^guvenlik-', '' })
  if ($Dir) {
    $out = Tam-Yol $Dir
    if ((Test-Path -LiteralPath $out) -and @(Get-ChildItem -LiteralPath $out -Force).Count -gt 0) { Hata "Klasör boş değil: $out" }
    New-Item -ItemType Directory -Force $out | Out-Null
    $out = (Resolve-Path -LiteralPath $out).Path
    $yaziliyor = $out
  } else {
    $ad = if ($Guvenlik) { "guvenlik-$stamp" } else { $stamp }
    $out = Join-Path $yedekKok $ad
    $yaziliyor = "$out.yaziliyor"
    New-Item -ItemType Directory -Force $yaziliyor | Out-Null
  }
  $gerekli = [Math]::Max(1GB, 3 * $(if ($oncekiKlasor) { Get-KlasorBoyu $oncekiKlasor.FullName } else { 0 }))
  try { $bos = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($yaziliyor))).AvailableFreeSpace } catch { $bos = $null }
  if ($null -ne $bos -and $bos -lt $gerekli) { Hata ("Diskte yer az: {0:N1} GB boş, en az {1:N1} GB gerekli." -f ($bos / 1GB), ($gerekli / 1GB)) }

  # 4) Veritabanı: kap içinde dosyaya yazılıp dışarı kopyalanır (PowerShell boru hattı ikili veriyi bozar).
  Log 'Veritabanı yedekleniyor...'
  $kapDump = "/tmp/sod-yedek-$stamp.dump"; $kapRoller = "/tmp/sod-yedek-$stamp-roller.sql"; $kapBetik = '/tmp/sod-yedek-kap.sh'
  $kapDosyalari = @($kapDump, $kapRoller, $kapBetik)
  $r = Invoke-Arac docker @('cp', (Join-Path $PSScriptRoot 'yedek-kap.sh'), "${pg}:$kapBetik")
  if ($r.Kod -ne 0) { Hata "Yardımcı betik kaba kopyalanamadı: $($r.Satirlar -join ' ')" }
  $r = Invoke-Arac docker @('exec', $pg, 'pg_dump', '-U', 'postgres', '-d', 'sellerondata', '-Fc', '-f', $kapDump)
  if ($r.Kod -ne 0) { Hata "pg_dump başarısız: $($r.Satirlar -join ' ')" }
  # Roller yalnız başvuru için (parolasız): geri yüklemede roller .env parolalarıyla init.sql'den kurulur.
  $r = Invoke-Arac docker @('exec', $pg, 'pg_dumpall', '-U', 'postgres', '--globals-only', '--no-role-passwords', '-f', $kapRoller)
  if ($r.Kod -ne 0) { Hata "Rol dökümü başarısız: $($r.Satirlar -join ' ')" }

  # Bütünlük: dökümün içindekiler listesi okunuyor ve tüm veri baştan sona açılıp tablo tablo sayılıyor.
  $r = Invoke-Arac docker @('exec', $pg, 'pg_restore', '-l', $kapDump)
  if ($r.Kod -ne 0) { Hata "Döküm açılamıyor (pg_restore -l): $($r.Satirlar -join ' ')" }
  $tocSatir = @($r.Satirlar | Where-Object { $_ -match '^\d+;' }).Count
  $r = Invoke-Arac docker @('exec', $pg, 'bash', $kapBetik, 'say', $kapDump)
  if ($r.Kod -ne 0) { Hata "Döküm verisi okunamadı (çıkış $($r.Kod)): $($r.Satirlar | Select-Object -Last 3)" }
  $tablolar = ConvertFrom-SayimCiktisi $r.Satirlar
  foreach ($gerek in @('platform._prisma_migrations', 'deciship._prisma_migrations')) {
    if (-not $tablolar.Contains($gerek)) { Hata "Dökümde $gerek yok: yanlış veritabanı ya da yarım kurulum." }
  }
  $satirToplam = 0L; foreach ($v in $tablolar.Values) { $satirToplam += $v }
  $kapSha = ((Invoke-Arac docker @('exec', $pg, 'bash', $kapBetik, 'sha', $kapDump)).Satirlar -join '').Trim()

  $db = Join-Path $yaziliyor 'veritabani.dump'
  $r = Invoke-Arac docker @('cp', "${pg}:$kapDump", $db)
  if ($r.Kod -ne 0) { Hata "Döküm kopyalanamadı: $($r.Satirlar -join ' ')" }
  $r = Invoke-Arac docker @('cp', "${pg}:$kapRoller", (Join-Path $yaziliyor 'roller.sql'))
  if ($r.Kod -ne 0) { Hata "Rol dökümü kopyalanamadı: $($r.Satirlar -join ' ')" }
  $dbSha = (Get-FileHash -LiteralPath $db -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($dbSha -ne $kapSha) { Hata 'Döküm kopyalanırken bozuldu (SHA-256 tutmuyor).' }
  $goc = [ordered]@{}
  foreach ($sema in @('platform', 'deciship')) {
    $q = "SELECT migration_name FROM $sema._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1"
    $goc[$sema] = ((Invoke-Arac docker @('exec', $pg, 'psql', '-U', 'postgres', '-d', 'sellerondata', '-Atc', $q)).Satirlar -join '').Trim()
  }
  $pgSurum = ((Invoke-Arac docker @('exec', $pg, 'psql', '-U', 'postgres', '-Atc', 'SHOW server_version')).Satirlar -join '').Trim()
  Log ("  veritabani.dump  {0:N1} MB, {1} tablo, {2} satır" -f ((Get-Item -LiteralPath $db).Length / 1MB), $tablolar.Count, $satirToplam)

  # 5) Dosya deposu: veritabanından sonra (dökümden sonra eklenen dosya yalnız sahipsiz kalır, storage:orphans).
  Log 'Dosya deposu yedekleniyor...'
  $r = Invoke-Arac docker @('run', '--rm', '--entrypoint', 'bash', '-v', "${dosyaHacmi}:/data:ro", '-v', "${yaziliyor}:/yedek", '-v', "${PSScriptRoot}:/betik:ro", $imaj, '/betik/yedek-kap.sh', 'tar-al', '/data', '/yedek/dosyalar.tar.gz')
  if ($r.Kod -ne 0) { Hata "Dosya deposu yedeklenemedi: $($r.Satirlar | Select-Object -Last 3)" }
  $dosya = ConvertFrom-DosyaSayimi $r.Satirlar
  if ($null -eq $dosya.Dosya) { Hata 'Dosya deposu arşivi sayılamadı.' }
  $tarGz = Join-Path $yaziliyor 'dosyalar.tar.gz'
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if ($env:SystemRoot -and (Test-Path -LiteralPath $tarExe)) {
    $r = Invoke-Arac $tarExe @('-tzf', $tarGz)
    if ($r.Kod -ne 0) { Hata "Dosya arşivi bu bilgisayarda açılamıyor: $($r.Satirlar | Select-Object -Last 2)" }
  }
  $tarSha = (Get-FileHash -LiteralPath $tarGz -Algorithm SHA256).Hash.ToLowerInvariant()
  Log ("  dosyalar.tar.gz  {0:N1} MB, {1} dosya" -f ((Get-Item -LiteralPath $tarGz).Length / 1MB), $dosya.Dosya)

  # 6) Sırlar: .env (parolalar, imza ve dosya bağlantısı anahtarları) ve keys\ (imza anahtarı). Onlarsız yedek geri kurulamaz.
  # Klasör yalnız şimdiki kullanıcıya açık.
  $sirDizini = Join-Path $yaziliyor 'sirlar'
  New-Item -ItemType Directory -Force $sirDizini | Out-Null
  Set-YalnizBen $sirDizini
  $envSha = $null
  if (Test-Path -LiteralPath $envFile) {
    Copy-Item -LiteralPath $envFile -Destination (Join-Path $sirDizini '.env')
    $envSha = (Get-FileHash -LiteralPath $envFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Get-FileHash -LiteralPath (Join-Path $sirDizini '.env') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $envSha) { Hata '.env kopyası tutmuyor.' }
  } else { Log "  UYARI: ayar dosyası yok ($envFile); yedekte .env olmayacak." Yellow }
  $keysDir = Tam-Yol (Ayar 'SOD_KEYS_DIR' 'keys')
  $anahtarlar = @()
  if (Test-Path -LiteralPath $keysDir) {
    Copy-Item -LiteralPath $keysDir -Destination (Join-Path $sirDizini 'keys') -Recurse
    $kaynakSay = @(Get-ChildItem -LiteralPath $keysDir -Recurse -File -Force).Count
    $anahtarlar = @(Get-ChildItem -LiteralPath (Join-Path $sirDizini 'keys') -Recurse -File -Force | ForEach-Object { $_.Name })
    if ($anahtarlar.Count -ne $kaynakSay) { Hata "keys\ kopyası eksik ($($anahtarlar.Count)/$kaynakSay dosya)." }
  } else { Log "  UYARI: anahtar klasörü yok ($keysDir)." Yellow }

  # 7) Künye: geri yükleme ve prova bununla karşılaştırır. En son yazılır; künyesi olmayan klasör yarım sayılır.
  $commit = $null
  if (Get-Command git -ErrorAction SilentlyContinue) { $commit = ((Invoke-Arac git @('-C', $root, 'rev-parse', 'HEAD')).Satirlar -join '').Trim() }
  $kunye = [ordered]@{
    surum         = 1
    ad            = $(if ($Dir) { Split-Path -Leaf $out } else { Split-Path -Leaf $out })
    olusturma     = (Get-Date).ToString('o')
    bilgisayar    = $env:COMPUTERNAME
    proje         = $project
    commit        = $commit
    postgres      = $pgSurum
    imaj          = $imaj
    gocler        = $goc
    veritabani    = [ordered]@{ dosya = 'veritabani.dump'; sha256 = $dbSha; bayt = (Get-Item -LiteralPath $db).Length; icindekiler = $tocSatir; tablolar = $tablolar; satir = $satirToplam }
    dosyalar      = [ordered]@{ dosya = 'dosyalar.tar.gz'; sha256 = $tarSha; bayt = (Get-Item -LiteralPath $tarGz).Length; adet = $dosya.Dosya; icerikBayt = $dosya.Bayt; hacim = $dosyaHacmi }
    sirlar        = [ordered]@{ env = [bool]$envSha; envSha256 = $envSha; anahtarlar = $anahtarlar }
  }
  Write-Utf8Dosya (Join-Path $yaziliyor 'yedek.json') ($kunye | ConvertTo-Json -Depth 6)
  if (-not $Dir) {
    # Ad değiştirme (Defender ya da Gezgin dosyayı tutuyorsa) birkaç kez denenir; sonunda klasör gerçekten yerinde olmalı.
    for ($deneme = 1; $deneme -le 5; $deneme++) {
      try { Rename-Item -LiteralPath $yaziliyor -NewName (Split-Path -Leaf $out); break }
      catch { if ($deneme -eq 5) { throw } ; Start-Sleep -Seconds 3 }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $out 'yedek.json')) -or (Test-Path -LiteralPath $yaziliyor)) { Hata "Yedek klasörünün adı verilemedi: $yaziliyor" }
    $yaziliyor = $null
  }
  Log "Yedek hazır: $out" Green
  $ozet = "yerel tamam: $out"

  # 7b) Ani düşüş: veri yanlışlıkla silindiyse bu çalıştırmada eski yedekler silinmez.
  $dusus = if ($Guvenlik -or $Dir -or $YeniTaban) { $null } else { Test-AniDusus $oncekiKunye $satirToplam $dosya.Dosya }
  if ($YeniTaban) { Log '  Yeni taban: veri bilerek silindi, ani düşüş denetimi yapılmadı; sonraki yedekler bununla karşılaştırılır.' }
  if ($dusus) {
    Log "UYARI: $dusus. Eski yedekler bu sefer silinmedi; veri bilerek silindiyse yarın normale döner." Yellow
    $sorunlar += $dusus
  }

  # 8) Yerel saklama (yalnız varsayılan klasörde ve düşüş yoksa)
  if (-not $Dir -and -not $Guvenlik -and -not $dusus) {
    try {
      $keepLast = ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_LAST' (Ayar 'SOD_BACKUP_KEEP_LAST' '14')
      $keepDays = ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_DAYS' (Ayar 'SOD_BACKUP_KEEP_DAYS' '14')
      $keepMonths = ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_MONTHS' (Ayar 'SOD_BACKUP_KEEP_MONTHS' '12')
      $adlar = @(Get-ChildItem -LiteralPath $yedekKok -Directory | ForEach-Object { $_.Name })
      foreach ($b in (Select-YedekBudama -Adlar $adlar -SonSayi $keepLast -Gun $keepDays -Ay $keepMonths)) {
        if (-not $b.Sakla) { Remove-Item -LiteralPath (Join-Path $yedekKok $b.Ad) -Recurse -Force; Log "  eski yedek silindi: $($b.Ad)" }
      }
      # Yarım kalmış (çöken) yedek ve 13 aydan eski günlükler
      Get-ChildItem -LiteralPath $yedekKok -Directory -Filter '*.yaziliyor' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Log "  yarım yedek silindi: $($_.Name)" }
      Get-ChildItem -LiteralPath (Join-Path $yedekKok 'gunluk') -File -Filter 'yedek-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMonths(-13) } |
        Remove-Item -Force
    } catch {
      Log "HATA: saklama uygulanamadı: $($_.Exception.Message)" Red
      $sorunlar += "saklama: $($_.Exception.Message)"
    }
  }

  # 9) Bilgisayar dışı şifreli kopya
  if ($Guvenlik) { }
  elseif ($DisariYok) { Log 'Bilgisayar dışı kopya istenmedi (-DisariYok).' }
  elseif (-not $disariDir) {
    Log 'UYARI: bilgisayar dışı kopya ayarlı değil (SOD_BACKUP_OFFSITE_DIR). Yedek yalnız bu bilgisayarda; disk ya da bilgisayar giderse yedek de gider.' Yellow
    $ozet += '; dış kopya ayarlı değil'
  } elseif ($parolaKarari -eq 'elle') {
    $m = 'dış kopya parolası yok: bir kez YEDEKLE.bat ile elle çalıştırın, parola üretilip gösterilir'
    Log "HATA: $m." Red
    $sorunlar += $m
  } else {
    try {
      $disariUst = Split-Path -Parent $disariDir
      if (-not (Test-Path -LiteralPath $disariDir)) {
        if ($disariUst -and -not (Test-Path -LiteralPath $disariUst)) { Hata "Dış hedefe ulaşılamıyor: $disariDir (disk takılı mı, bulut klasörü var mı?)" }
        New-Item -ItemType Directory -Force $disariDir | Out-Null
      }
      $adi = Split-Path -Leaf $out
      $hedefDosya = Join-Path $disariDir (Get-DisariDosyaAdi $(if ($Dir) { $stamp } else { $adi }))
      $araTar = Join-Path $yedekKok "$adi.tar"
      $gecici = "$hedefDosya.tmp"
      try {
        Log "Şifreli kopya yazılıyor: $hedefDosya"
        if (-not (Test-Path -LiteralPath $tarExe)) { Hata 'tar.exe bulunamadı (Windows 10 ve sonrası gerekir).' }
        $r = Invoke-Arac $tarExe @('-cf', $araTar, '-C', (Split-Path -Parent $out), $adi)
        if ($r.Kod -ne 0) { Hata "Paket oluşturulamadı: $($r.Satirlar -join ' ')" }
        Protect-YedekDosyasi $araTar $gecici $parola
        # Hedefteki dosya baştan sona yeniden okunup doğrulanır (USB'ye yazım hatası burada çıkar;
        # bulut klasöründe okuma yerel önbellekten olur, buluta yükleme ayrıca denetlenmez).
        Unprotect-YedekDosyasi $gecici $null $parola
        $boy = (Get-Item -LiteralPath $gecici).Length
        if (Test-Path -LiteralPath $hedefDosya) { Remove-Item -LiteralPath $hedefDosya -Force }
        Rename-Item -LiteralPath $gecici -NewName (Split-Path -Leaf $hedefDosya)
        if (-not (Test-Path -LiteralPath $hedefDosya) -or (Get-Item -LiteralPath $hedefDosya).Length -ne $boy) { Hata "Şifreli kopya yerine konamadı: $hedefDosya" }
      } finally {
        if (Test-Path -LiteralPath $araTar) { Remove-Item -LiteralPath $araTar -Force }
        if (Test-Path -LiteralPath $gecici) { Remove-Item -LiteralPath $gecici -Force }
      }
      Log ("  {0}  {1:N1} MB, doğrulandı" -f (Split-Path -Leaf $hedefDosya), ($boy / 1MB)) Green
      $ozet += "; dış kopya tamam: $hedefDosya"
      if (-not $dusus) {
        $keepLast = ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_LAST' (Ayar 'SOD_BACKUP_KEEP_LAST' '14')
        $keepDays = ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_DAYS' (Ayar 'SOD_BACKUP_KEEP_DAYS' '14')
        $keepMonths = ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_MONTHS' (Ayar 'SOD_BACKUP_KEEP_MONTHS' '12')
        $adlar = @(Get-ChildItem -LiteralPath $disariDir -File | ForEach-Object { Get-DisariYedekAdi $_.Name } | Where-Object { $_ })
        foreach ($b in (Select-YedekBudama -Adlar $adlar -SonSayi $keepLast -Gun $keepDays -Ay $keepMonths)) {
          if (-not $b.Sakla) { Remove-Item -LiteralPath (Join-Path $disariDir (Get-DisariDosyaAdi $b.Ad)) -Force; Log "  eski dış kopya silindi: $($b.Ad)" }
        }
      }
    } catch {
      Log "HATA: bilgisayar dışı kopya alınamadı: $($_.Exception.Message)" Red
      Log 'Yerel yedek tamam; dış kopya bir sonraki çalıştırmada yeniden denenir.' Yellow
      $sorunlar += "dış kopya: $($_.Exception.Message)"
    }
  }
  if ($sorunlar.Count -gt 0) { $kod = 2; $ozet += "; SORUN: $($sorunlar -join '; ')" }
} catch {
  $kod = 1
  $ozet = "HATA: $($_.Exception.Message)"
  Log "HATA: $($_.Exception.Message)" Red
  if ($_.InvocationInfo.ScriptLineNumber) { Log "  (yer: $(Split-Path -Leaf $_.InvocationInfo.ScriptName) satır $($_.InvocationInfo.ScriptLineNumber))" }
  if ($yaziliyor -and -not $Dir -and (Test-Path -LiteralPath $yaziliyor)) { Remove-Item -LiteralPath $yaziliyor -Recurse -Force -ErrorAction SilentlyContinue }
} finally {
  $ErrorActionPreference = 'Continue'
  if ($pg) { foreach ($f in $kapDosyalari) { Invoke-Arac docker @('exec', $pg, 'rm', '-f', $f) | Out-Null } }
  if ($pgBaslattim) {
    # Bu arada sistem açıldıysa (BASLAT.bat) veritabanı kullanımda: durdurulmaz.
    $baska = @((Invoke-Arac docker @('ps', '-q', '--filter', "label=com.docker.compose.project=$project")).Satirlar | Where-Object { $_ -and -not $pg.StartsWith($_) -and -not $_.StartsWith($pg) })
    if ($baska.Count -gt 0) { Log 'Sistem bu arada açılmış: veritabanı açık bırakıldı.' }
    else { Invoke-Arac docker @('stop', $pg) | Out-Null; Log 'Veritabanı kabı yeniden durduruldu.' }
  }
  if (-not $Guvenlik) {
    try {
      $son = [ordered]@{ zaman = (Get-Date).ToString('o'); kod = $kod; ozet = $ozet; klasor = $out }
      Write-Utf8Dosya $sonJson ($son | ConvertTo-Json)
    } catch { }
    if ($kod -eq 0) { Clear-YedekUyarisi } else { Show-YedekUyarisi $ozet $gunluk }
  }
  Log "== Bitti (çıkış $kod)"
  if ($kilit) { $kilit.Dispose() }
}
Bitir $kod
