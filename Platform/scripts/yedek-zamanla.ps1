# Gece yedeğini Windows Görev Zamanlayıcı'ya kaydeder, kaldırır ya da durumunu gösterir. Yönetici hakkı istemez.
#   durum                      (varsayılan) görev, son çalışma, en yeni yedek, günlüğün sonu; sorun varsa çıkış 1
#   kaydet [-Saat 03:00] [-Uyandir]
#                              her gece yedekle.ps1 -Zamanli. Bilgisayar o saatte kapalıysa ilk açılışta çalışır.
#                              10 saat sonra ikinci tetikleme: ilki başarılıysa bir şey yapmaz, değilse aynı gün yeniden dener
#                              (Görev Zamanlayıcı'nın "başarısızsa yeniden başlat" ayarı çıkış koduna bakmaz; bu yüzden kullanılmaz).
#                              -Uyandir: uyku kipindeki bilgisayarı yedek için uyandırır.
#   kaldir                     görevi siler (yedeklere dokunmaz)
# Görev yalnız oturum açıkken çalışır (Docker Desktop da kullanıcı oturumunda çalışır); parola saklanmaz.
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param(
  [Parameter(Position = 0)][ValidateSet('durum', 'kaydet', 'kaldir')][string]$Islem = 'durum',
  [string]$Saat = '03:00',
  [switch]$Uyandir
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $PSScriptRoot 'yedek-ortak.ps1')

$root = Split-Path -Parent $PSScriptRoot
$envFile = if ($env:SOD_ENV_FILE) { Join-Path $root $env:SOD_ENV_FILE } else { Join-Path $root '.env' }
$gorevAdi = 'SellerOnData gece yedegi'
$gorevYolu = '\'
$betik = Join-Path $PSScriptRoot 'yedekle.ps1'

function Get-Gorev { Get-ScheduledTask -TaskName $gorevAdi -TaskPath $gorevYolu -ErrorAction SilentlyContinue }

switch ($Islem) {
  'kaydet' {
    try { $zaman = [datetime]::ParseExact($Saat, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture) }
    catch { Write-Host "Saat SS:DD biçiminde olmalı (ör. 03:00): $Saat" -ForegroundColor Red; exit 2 }
    $arg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$betik`" -Zamanli"
    $eylem = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $root
    $tetik = @((New-ScheduledTaskTrigger -Daily -At $zaman), (New-ScheduledTaskTrigger -Daily -At $zaman.AddHours(10)))
    $ayar = @{
      StartWhenAvailable         = $true
      AllowStartIfOnBatteries    = $true
      DontStopIfGoingOnBatteries = $true
      ExecutionTimeLimit         = (New-TimeSpan -Hours 3)
      MultipleInstances          = 'IgnoreNew'
    }
    if ($Uyandir) { $ayar.WakeToRun = $true }
    $ayarlar = New-ScheduledTaskSettingsSet @ayar
    $kim = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $aciklama = "SellerOnData her gece yedek: veritabanı, DeciShip dosyaları, .env ve keys; SOD_BACKUP_OFFSITE_DIR doluysa şifreli dış kopya. Betik: $betik"
    try {
      Register-ScheduledTask -TaskName $gorevAdi -TaskPath $gorevYolu -Action $eylem -Trigger $tetik -Settings $ayarlar -Principal $kim -Description $aciklama -Force -ErrorAction Stop | Out-Null
    } catch { Write-Host "Görev kaydedilemedi: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
    Write-Host "Kaydedildi: '$gorevAdi', her gün $Saat (olmazsa $($zaman.AddHours(10).ToString('HH:mm'))'de yeniden)$(if ($Uyandir) { ', uykudan uyandırır' })." -ForegroundColor Green
    Write-Host 'Bilgisayar o saatte kapalıysa ilk açılışta çalışır. Durum: powershell -File scripts\yedek-zamanla.ps1 durum'
    if (-not (Get-AyarDegeri 'SOD_BACKUP_OFFSITE_DIR' '' $envFile)) {
      Write-Host 'UYARI: bilgisayar dışı kopya ayarlı değil (.env SOD_BACKUP_OFFSITE_DIR). Yedekler yalnız bu bilgisayarda kalır.' -ForegroundColor Yellow
    } elseif (-not (Get-AyarDegeri 'SOD_BACKUP_PASSWORD' '' $envFile)) {
      Write-Host 'UYARI: dış kopya parolası yok. Gece görevi parolayı görünmeden üretmez: bir kez YEDEKLE.bat ile elle çalıştırın.' -ForegroundColor Yellow
    }
    exit 0
  }
  'kaldir' {
    if (-not (Get-Gorev)) { Write-Host 'Görev zaten yok.'; exit 0 }
    try { Unregister-ScheduledTask -TaskName $gorevAdi -TaskPath $gorevYolu -Confirm:$false -ErrorAction Stop }
    catch { Write-Host "Görev silinemedi: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
    Write-Host 'Görev silindi. Var olan yedekler duruyor.' -ForegroundColor Green
    exit 0
  }
  default {
    $sorun = $false
    $g = Get-Gorev
    if (-not $g) { Write-Host 'Gece görevi KAYITLI DEĞİL. Kaydetmek: powershell -File scripts\yedek-zamanla.ps1 kaydet' -ForegroundColor Yellow; $sorun = $true }
    else {
      $b = Get-ScheduledTaskInfo -TaskName $gorevAdi -TaskPath $gorevYolu
      $sonuc = switch ($b.LastTaskResult) { 0 { 'tamam' } 1 { 'yedek alınamadı' } 2 { 'yerel tamam, dış kopya alınamadı' } 267009 { 'şu an çalışıyor' } 267011 { 'henüz çalışmadı' } default { "kod $($b.LastTaskResult)" } }
      Write-Host "Görev: $($g.State), saat $(($g.Triggers | Select-Object -First 1).StartBoundary -replace '^.*T(\d\d:\d\d).*$', '$1')"
      Write-Host "  son çalışma: $(if ($b.LastRunTime -and $b.LastRunTime.Year -gt 2000) { $b.LastRunTime } else { '-' })  sonuç: $sonuc"
      Write-Host "  sonraki: $($b.NextRunTime)"
      if ($b.LastTaskResult -in 1, 2) { $sorun = $true }
    }
    $yedekKok = Get-AyarDegeri 'SOD_BACKUP_DIR' 'yedekler' $envFile
    if (-not [IO.Path]::IsPathRooted($yedekKok)) { $yedekKok = Join-Path $root $yedekKok }
    $son = Get-ChildItem -LiteralPath $yedekKok -Directory -ErrorAction SilentlyContinue | Where-Object { ConvertFrom-YedekAdi $_.Name } | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $son) { Write-Host "Yerel yedek yok ($yedekKok)." -ForegroundColor Yellow; $sorun = $true }
    else {
      $yas = (Get-Date) - (ConvertFrom-YedekAdi $son.Name).Zaman
      $renk = if ($yas.TotalHours -gt 36) { 'Yellow' } else { 'Green' }
      Write-Host ("En yeni yerel yedek: {0} ({1:N0} saat önce)" -f $son.Name, $yas.TotalHours) -ForegroundColor $renk
      if ($yas.TotalHours -gt 36) { $sorun = $true }
    }
    $sonJson = Join-Path $yedekKok 'son-yedek.json'
    if (Test-Path -LiteralPath $sonJson) {
      $s = Get-Content -LiteralPath $sonJson -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Host "Son çalıştırma: $($s.zaman)  çıkış $($s.kod)  $($s.ozet)"
      if ($s.kod -ne 0) { $sorun = $true }
    }
    $disari = Get-AyarDegeri 'SOD_BACKUP_OFFSITE_DIR' '' $envFile
    if (-not $disari) { Write-Host 'Bilgisayar dışı kopya: AYARLI DEĞİL (.env SOD_BACKUP_OFFSITE_DIR).' -ForegroundColor Yellow }
    else {
      $d = Get-ChildItem -LiteralPath $disari -File -ErrorAction SilentlyContinue | Where-Object { Get-DisariYedekAdi $_.Name } | Sort-Object Name -Descending | Select-Object -First 1
      if (-not (Get-AyarDegeri 'SOD_BACKUP_PASSWORD' '' $envFile)) {
        Write-Host 'Dış kopya parolası YOK: bir kez YEDEKLE.bat ile elle çalıştırın (parola üretilir, gösterilir).' -ForegroundColor Yellow; $sorun = $true
      }
      if ($d) {
        $dyas = (Get-Date) - (ConvertFrom-YedekAdi (Get-DisariYedekAdi $d.Name)).Zaman
        $drenk = if ($dyas.TotalHours -gt 36) { 'Yellow' } else { 'Green' }
        Write-Host ("Bilgisayar dışı en yeni kopya: {0} ({1:N0} saat önce)" -f $d.FullName, $dyas.TotalHours) -ForegroundColor $drenk
        if ($dyas.TotalHours -gt 36) { $sorun = $true }
      } else { Write-Host "Bilgisayar dışı kopya yok ya da hedefe ulaşılamıyor: $disari" -ForegroundColor Yellow; $sorun = $true }
    }
    $gunluk = Get-ChildItem -LiteralPath (Join-Path $yedekKok 'gunluk') -File -Filter 'yedek-*.log' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($gunluk) { Write-Host ''; Write-Host "Günlük ($($gunluk.FullName)), son satırlar:"; Get-Content -LiteralPath $gunluk.FullName -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" } }
    exit $(if ($sorun) { 1 } else { 0 })
  }
}
