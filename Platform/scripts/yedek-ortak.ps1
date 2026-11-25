# Yedek betiklerinin ortak işlevleri (yedekle.ps1, geri-yukle.ps1, yedek-zamanla.ps1 bunu nokta ile yükler).
# Docker istemeyen kısımlar (adlar, saklama, ayar dosyası, şifreleme) burada; testi scripts\yedek.test.mjs.
# Windows PowerShell 5.1 ve PowerShell 7 ile çalışır (test Linux'ta pwsh ile de koşar).
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.

# Yedek klasörü adı: 2026-11-16_0300, aynı dakikada ikinci yedek 2026-11-16_0300-2.
$script:YedekAdDeseni = '^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:-(\d+))?$'
$script:DisariOnek = 'sellerondata-yedek-'
$script:DisariUzanti = '.sodyedek'
# Şifreli dosya: "SODYEDK1" | PBKDF2 tur sayısı (int32, küçük uçlu) | tuz (16) | IV (16) | AES-256-CBC şifreli tar | HMAC-SHA256 (32).
# Anahtar: PBKDF2-SHA256(parola, tuz) = ana anahtar; şifreleme ve doğrulama anahtarları ondan HMAC ile ayrılır. HMAC başlık dahil her şeyi kapsar.
$script:SifreBuyu = [byte[]](0x53, 0x4F, 0x44, 0x59, 0x45, 0x44, 0x4B, 0x31)
$script:SifreBaslikBoy = 8 + 4 + 16 + 16
$script:SifreVarsayilanTur = 600000

# Prova (geri yükleme denemesi) yığını: canlıdan ayrı proje, hacim ve portlar. Hacim adları "sod_prova_" ile başlamak zorunda.
$script:ProvaProje = 'sellerondata-prova'
$script:ProvaPgHacim = 'sod_prova_pgdata'
$script:ProvaDosyaHacim = 'sod_prova_storage'
$script:ProvaTagpressHacim = 'sod_prova_tagpress_storage'

function ConvertFrom-YedekAdi([string]$Ad) {
  if ($Ad -notmatch $script:YedekAdDeseni) { return $null }
  $m = $Matches
  try {
    $t = [datetime]::ParseExact("$($m[1])-$($m[2])-$($m[3]) $($m[4]):$($m[5])", 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  } catch { return $null }
  $ek = if ($m[6]) { [int]$m[6] } else { 0 }
  return [pscustomobject]@{ Ad = $Ad; Zaman = $t; Ek = $ek }
}

function Get-DisariDosyaAdi([string]$YedekAdi) { return "$script:DisariOnek$YedekAdi$script:DisariUzanti" }

# Dosya adından yedek adı; tanınmayan ad için $null.
function Get-DisariYedekAdi([string]$DosyaAdi) {
  if (-not $DosyaAdi.StartsWith($script:DisariOnek) -or -not $DosyaAdi.EndsWith($script:DisariUzanti)) { return $null }
  $ad = $DosyaAdi.Substring($script:DisariOnek.Length, $DosyaAdi.Length - $script:DisariOnek.Length - $script:DisariUzanti.Length)
  if (-not (ConvertFrom-YedekAdi $ad)) { return $null }
  return $ad
}

# Aynı dakikada var olan ada çakışmayan yeni yedek adı.
function New-YedekAdi([datetime]$Zaman, [string[]]$Var = @()) {
  $taban = $Zaman.ToString('yyyy-MM-dd_HHmm', [Globalization.CultureInfo]::InvariantCulture)
  $ad = $taban; $i = 1
  while ($Var -contains $ad) { $i++; $ad = "$taban-$i" }
  return $ad
}

# Saklama: bir yedek şu üçünden biri tutuyorsa kalır, yoksa silinir. Desene uymayan adlara hiç dokunulmaz.
#   son  en yeni $SonSayi yedek (yedek durmuşsa eski yedekler kendiliğinden erimez); en yeni yedek her durumda kalır
#   gun  son $Gun gün içinde alınmış (gün içindeki elle yedekler)
#   ay   en yeni $Ay ayın her birinin son yedeği
function Select-YedekBudama {
  param([string[]]$Adlar = @(), [datetime]$Simdi = (Get-Date), [int]$SonSayi = 14, [int]$Gun = 14, [int]$Ay = 12)
  $liste = @($Adlar | ForEach-Object { ConvertFrom-YedekAdi $_ } | Where-Object { $_ } |
    Sort-Object -Property @{ Expression = 'Zaman'; Descending = $true }, @{ Expression = 'Ek'; Descending = $true })
  $aylar = @{}
  foreach ($y in $liste) {
    $k = $y.Zaman.ToString('yyyy-MM', [Globalization.CultureInfo]::InvariantCulture)
    if (-not $aylar.ContainsKey($k)) { $aylar[$k] = $y.Ad }
  }
  # Windows PowerShell 5.1'de Select-Object -First 0 hepsini döndürür: 0 ayrıca ele alınır.
  $tutulanAylar = if ($Ay -gt 0) { @($aylar.Keys | Sort-Object -Descending | Select-Object -First $Ay) } else { @() }
  $ayinSonu = @{}
  foreach ($k in $tutulanAylar) { $ayinSonu[$aylar[$k]] = $true }
  $i = 0
  foreach ($y in $liste) {
    $neden = @()
    if ($i -lt [Math]::Max(1, $SonSayi)) { $neden += 'son' }
    if (($Simdi - $y.Zaman).TotalDays -lt $Gun) { $neden += 'gun' }
    if ($ayinSonu.ContainsKey($y.Ad)) { $neden += 'ay' }
    [pscustomobject]@{ Ad = $y.Ad; Zaman = $y.Zaman; Sakla = ($neden.Count -gt 0); Neden = ($neden -join ',') }
    $i++
  }
}

# .env değeri docker compose gibi okunur: 'tek tırnak' olduğu gibi, "çift tırnak" kaçışlarıyla (\n \t \" \\),
# tırnaksız değerde boşluktan sonraki # yorumdur.
function ConvertFrom-EnvDegeri([string]$Ham) {
  $v = $Ham.Trim()
  $tek = [char]39; $cift = [char]34; $ters = [char]92
  if ($v.Length -ge 2 -and $v[0] -eq $tek) {
    $son = $v.IndexOf($tek, 1)
    if ($son -gt 0) { return $v.Substring(1, $son - 1) }
  }
  if ($v.Length -ge 2 -and $v[0] -eq $cift) {
    $sb = New-Object Text.StringBuilder
    for ($i = 1; $i -lt $v.Length; $i++) {
      $c = $v[$i]
      if ($c -eq $ters -and $i + 1 -lt $v.Length) {
        $i++; $n = [string]$v[$i]
        if ($n -ceq 'n') { [void]$sb.Append([char]10) } elseif ($n -ceq 't') { [void]$sb.Append([char]9) } else { [void]$sb.Append($n) }
      } elseif ($c -eq $cift) { return $sb.ToString() }
      else { [void]$sb.Append($c) }
    }
  }
  $m = [regex]::Match($v, '\s#')
  if ($m.Success) { $v = $v.Substring(0, $m.Index) }
  return $v.Trim()
}

# Ayar: önce işlem ortamı, sonra ayar dosyası (docker compose ile aynı öncelik; dosyada iki kez geçerse sonuncusu, baştaki
# "export " atlanır). Boş değer varsayılana düşer.
function Get-AyarDegeri([string]$Ad, [string]$Varsayilan, [string]$EnvDosyasi) {
  $v = [Environment]::GetEnvironmentVariable($Ad)
  if ($v) { return $v }
  $x = $null
  if ($EnvDosyasi -and (Test-Path -LiteralPath $EnvDosyasi)) {
    foreach ($satir in (Get-Content -LiteralPath $EnvDosyasi -Encoding UTF8)) {
      if ($satir -match "^\s*(?:export\s+)?$([regex]::Escape($Ad))\s*=(.*)$") { $x = ConvertFrom-EnvDegeri $Matches[1] }
    }
  }
  if ($x) { return $x }
  return $Varsayilan
}

# Geri yüklemede Postgres kabına verilecek ayar adları (yedek-kap.sh rol-parola): SOD_ENV, süper kullanıcı parolası ve her
# kiracı rolünün parolası (SOD_<K>_DB_PASSWORD, SOD_<K>_ADMIN_DB_PASSWORD). Elle liste yok: ayar dosyasından ve işlem ortamından
# desenle okunur; yeni aracın parolası .env'e yazılınca kendiliğinden gider. Rolün değeri yoksa üretimde kap betiği durur.
function Get-RolParolaAdlari([string]$EnvDosyasi) {
  $desen = '^(SOD_ENV|SOD_POSTGRES_PASSWORD|SOD_[A-Z][A-Z0-9]*(_ADMIN)?_DB_PASSWORD)$'
  $adlar = @()
  foreach ($ad in [Environment]::GetEnvironmentVariables('Process').Keys) { if ("$ad" -cmatch $desen) { $adlar += "$ad" } }
  if ($EnvDosyasi -and (Test-Path -LiteralPath $EnvDosyasi)) {
    foreach ($satir in (Get-Content -LiteralPath $EnvDosyasi -Encoding UTF8)) {
      if ($satir -cmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { if ($Matches[1] -cmatch $desen) { $adlar += $Matches[1] } }
    }
  }
  return @($adlar | Sort-Object -Unique -CaseSensitive)
}

# Saklama sayısı ayarı: tam sayı ve en az 1 (0 her şeyi silerdi). Geçersizse hata.
function ConvertTo-SaklamaSayisi([string]$Ad, [string]$Deger) {
  $n = 0
  if (-not [int]::TryParse($Deger, [ref]$n) -or $n -lt 1) { throw "$Ad geçersiz ('$Deger'): 1 ya da daha büyük bir tam sayı olmalı." }
  return $n
}

# Ani düşüş: satır ya da dosya sayısı önceki yedeğin yarısının altındaysa uyarı metni, değilse $null (önceki künye yoksa denetim yok).
# Düşüş varsa o çalıştırmada eski yedekler silinmez: veri yanlışlıkla silindiyse iyi yedekler kalsın.
function Test-AniDusus($Onceki, [long]$Satir, [long]$Dosya) {
  if (-not $Onceki) { return $null }
  $m = @()
  $os = [long]$Onceki.veritabani.satir
  $od = [long]$Onceki.dosyalar.adet
  if ($os -gt 0 -and $Satir * 2 -lt $os) { $m += "satır $os -> $Satir" }
  if ($od -gt 0 -and $Dosya * 2 -lt $od) { $m += "dosya $od -> $Dosya" }
  if ($m.Count -eq 0) { return $null }
  return "önceki yedeğe ($($Onceki.ad)) göre ani düşüş: $($m -join ', ')"
}

# Dış kopya parolası: gerekmez | var | uret (elle çalıştırma: üret, göster, onay al) | elle (gece görevi: görünmeden üretilmez).
function Get-ParolaKarari([string]$DisariDir, [string]$Parola, [bool]$Zamanli) {
  if (-not $DisariDir) { return 'gerekmez' }
  if ($Parola) { return 'var' }
  if ($Zamanli) { return 'elle' }
  return 'uret'
}

# Son başarılı yedek $Saat saatten yeniyse gece görevinin ikinci tetiklemesi (gün içi yeniden deneme) atlanır.
function Test-YakindaAlindi($Son, [datetime]$Simdi, [int]$Saat = 20) {
  if (-not $Son -or [int]$Son.kod -ne 0 -or -not $Son.zaman) { return $false }
  # PowerShell 7 ConvertFrom-Json tarihi kendisi çevirir, 5.1 metin bırakır.
  if ($Son.zaman -is [datetime]) { $z = $Son.zaman.ToLocalTime() }
  else { try { $z = [datetimeoffset]::Parse([string]$Son.zaman, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime } catch { return $false } }
  $fark = ($Simdi - $z).TotalHours
  return ($fark -ge 0 -and $fark -lt $Saat)
}

# storage:orphans özet satırından (Done ... missing=<n> ...) kaydı olup diskte olmayan dosya sayısı; bulunamazsa $null.
function ConvertFrom-OrphanOzeti([string[]]$Satirlar) {
  foreach ($l in $Satirlar) { if ($l -match '^Done .*\bmissing=(\d+)') { return [long]$Matches[1] } }
  return $null
}

# Klasörü yalnız şimdiki kullanıcıya açar (kalıtım kesilir). Yalnız Windows; başka sistemde bir şey yapmaz.
function Set-YalnizBen([string]$Yol) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  $r = Invoke-Arac $icacls @($Yol, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '/q')
  if ($r.Kod -ne 0) { throw "İzin verilemedi ($Yol): $($r.Satirlar -join ' ')" }
}

# Yedek sorunu: masaüstüne uyarı dosyası ve (olursa) Windows bildirimi. Sonraki başarılı yedekte dosya silinir.
function Get-UyariDosyasi {
  $m = [Environment]::GetFolderPath('Desktop')
  if (-not $m) { return $null }
  return (Join-Path $m 'SellerOnData-YEDEK-SORUNU.txt')
}
function Show-YedekUyarisi([string]$Mesaj, [string]$Gunluk) {
  $d = Get-UyariDosyasi
  if ($d) {
    $metin = @(
      'SellerOnData yedeğinde sorun var.', '', $Mesaj, '',
      "Zaman: $((Get-Date).ToString('yyyy-MM-dd HH:mm'))", "Günlük: $Gunluk",
      'Durum: Platform klasöründe powershell -File scripts\yedek-zamanla.ps1 durum',
      'Bir sonraki başarılı yedekte bu dosya kendiliğinden silinir.'
    ) -join ([string][char]13 + [char]10)
    try { [IO.File]::WriteAllText($d, $metin, (New-Object Text.UTF8Encoding $true)) } catch { }
  }
  # Ek kurulumsuz Windows bildirimi (Windows PowerShell'in kendi uygulama kimliğiyle); olmazsa sessizce geçilir.
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $t = $x.GetElementsByTagName('text')
    $null = $t.Item(0).AppendChild($x.CreateTextNode('SellerOnData yedeğinde sorun'))
    $null = $t.Item(1).AppendChild($x.CreateTextNode($Mesaj))
    $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show([Windows.UI.Notifications.ToastNotification]::new($x))
  } catch { }
}
function Clear-YedekUyarisi {
  $d = Get-UyariDosyasi
  if ($d -and (Test-Path -LiteralPath $d)) { try { Remove-Item -LiteralPath $d -Force } catch { } }
}

# Ayar metninde değerleri yazar: anahtar varsa ilk satırı değişir (tekrarlar silinir), yoksa sona eklenir. Yorumlar korunur.
function Set-EnvMetni([string]$Metin, [System.Collections.IDictionary]$Degerler) {
  $satirlar = New-Object System.Collections.Generic.List[string]
  foreach ($s in ($Metin -split "`r?`n")) { $satirlar.Add($s) }
  while ($satirlar.Count -gt 0 -and $satirlar[$satirlar.Count - 1] -eq '') { $satirlar.RemoveAt($satirlar.Count - 1) }
  foreach ($ad in $Degerler.Keys) {
    $desen = "^\s*$([regex]::Escape($ad))="
    $yazildi = $false
    for ($i = 0; $i -lt $satirlar.Count; $i++) {
      if ($satirlar[$i] -match $desen) {
        if ($yazildi) { $satirlar.RemoveAt($i); $i-- }
        else { $satirlar[$i] = "$ad=$($Degerler[$ad])"; $yazildi = $true }
      }
    }
    if (-not $yazildi) { $satirlar.Add("$ad=$($Degerler[$ad])") }
  }
  return (($satirlar -join "`n") + "`n")
}

# Prova yığınının ayarları: yedeğin .env'i bunlarla ezilir. Posta ve yapay zekâ kapalı (prova gerçek kişiye posta atmasın, para harcamasın).
function Get-ProvaAyarlari([string]$AnahtarKlasoru) {
  $a = [ordered]@{
    SOD_PGDATA_VOLUME      = $script:ProvaPgHacim
    SOD_STORAGE_VOLUME     = $script:ProvaDosyaHacim
    SOD_TAGPRESS_STORAGE_VOLUME = $script:ProvaTagpressHacim
    SOD_KEYS_DIR           = $AnahtarKlasoru
    SOD_POSTGRES_PORT      = '15444'
    ACCOUNT_API_PORT       = '14110'
    VISION_PORT            = '18011'
    GATEWAY_PORT           = '127.0.0.1:18098'
    SITE_PORT              = '127.0.0.1:18099'
    APP_BASE_URL           = 'http://localhost:18098'
    SITE_BASE_URL          = 'http://localhost:18099'
    ALLOWED_ORIGINS        = 'http://localhost:18098'
    SITE_ORIGINS           = 'http://localhost:18099'
    SMTP_URL               = ''
    ANTHROPIC_API_KEY      = ''
    ENABLE_DATA_RESET      = 'false'
    PRODUCT_EVENT_TARGETS  = ''
    SOD_BACKUP_OFFSITE_DIR = ''
  }
  return $a
}

# Prova canlı veriye dokunamaz: proje adı canlıdan farklı, hacimler "sod_prova_" ile başlar ve canlı adlardan farklı.
function Assert-ProvaGuvenli([string]$Proje, [string]$PgHacim, [string]$DosyaHacim, [string]$CanliProje, [string[]]$CanliHacimler, [string]$TagpressHacim = '') {
  if (-not $Proje -or $Proje -eq $CanliProje) { throw "Prova proje adı canlıyla aynı olamaz ($Proje)." }
  $hacimler = @($PgHacim, $DosyaHacim)
  if ($TagpressHacim) { $hacimler += $TagpressHacim }
  foreach ($h in $hacimler) {
    if (-not $h -or -not $h.StartsWith('sod_prova_')) { throw "Prova hacmi 'sod_prova_' ile başlamalı: '$h'." }
    if ($CanliHacimler -contains $h) { throw "Prova hacmi canlı hacimle aynı: '$h'." }
  }
}

# "tablo<TAB>sayı" satırları -> sıralı sözlük.
function ConvertFrom-SayimCiktisi([string[]]$Satirlar) {
  $s = [ordered]@{}
  foreach ($l in $Satirlar) {
    if ($l -match '^(\S+)\t(\d+)\s*$') { $s[$Matches[1]] = [long]$Matches[2] }
  }
  return $s
}

# İki sayım arasındaki farklar (boş liste = aynı).
function Compare-Sayimlar([System.Collections.IDictionary]$Beklenen, [System.Collections.IDictionary]$Bulunan) {
  $fark = @()
  foreach ($t in $Beklenen.Keys) {
    if (-not $Bulunan.Contains($t)) { $fark += "$t yok (beklenen $($Beklenen[$t]) satır)" }
    elseif ([long]$Bulunan[$t] -ne [long]$Beklenen[$t]) { $fark += "$t $($Bulunan[$t]) satır (beklenen $($Beklenen[$t]))" }
  }
  foreach ($t in $Bulunan.Keys) { if (-not $Beklenen.Contains($t)) { $fark += "$t fazla ($($Bulunan[$t]) satır)" } }
  return , $fark
}

# "DOSYA n" / "BAYT n" satırları.
function ConvertFrom-DosyaSayimi([string[]]$Satirlar) {
  $r = [ordered]@{ Dosya = $null; Bayt = $null }
  foreach ($l in $Satirlar) {
    if ($l -match '^DOSYA (\d+)') { $r.Dosya = [long]$Matches[1] }
    if ($l -match '^BAYT (\d+)') { $r.Bayt = [long]$Matches[1] }
  }
  return $r
}

# Elle yazılabilir parola: 6 grup x 5 harf, 32 harflik abece (karışan harfler yok), ~150 bit.
function New-YedekParolasi {
  $abece = 'abcdefghjkmnpqrstuvwxyz23456789'.ToCharArray()
  $b = New-Object byte[] 30
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  $gruplar = for ($g = 0; $g -lt 6; $g++) { -join (0..4 | ForEach-Object { $abece[$b[$g * 5 + $_] % $abece.Length] }) }
  return ($gruplar -join '-')
}

function Get-SifreAnahtarlari([string]$Parola, [byte[]]$Tuz, [int]$Tur) {
  $kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($Parola, $Tuz, $Tur, [Security.Cryptography.HashAlgorithmName]::SHA256)
  $ana = $kdf.GetBytes(32); $kdf.Dispose()
  $h = [Security.Cryptography.HMACSHA256]::new($ana)
  $r = [pscustomobject]@{
    Sifre    = $h.ComputeHash([Text.Encoding]::ASCII.GetBytes('sellerondata-yedek/sifreleme'))
    Dogrulama = $h.ComputeHash([Text.Encoding]::ASCII.GetBytes('sellerondata-yedek/dogrulama'))
  }
  $h.Dispose()
  return $r
}

function Get-RastgeleBayt([int]$Boy) {
  $b = New-Object byte[] $Boy
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  return , $b
}

function Read-TamBayt([IO.Stream]$Akis, [int]$Boy) {
  $b = New-Object byte[] $Boy
  $okunan = 0
  while ($okunan -lt $Boy) {
    $n = $Akis.Read($b, $okunan, $Boy - $okunan)
    if ($n -le 0) { throw 'Dosya beklenenden kısa.' }
    $okunan += $n
  }
  return , $b
}

function New-Aes([byte[]]$Anahtar, [byte[]]$Iv) {
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.Mode = [Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $Anahtar
  $aes.IV = $Iv
  return $aes
}

# Kaynağı parolayla şifreleyip Hedef'e yazar (Hedef varsa üzerine).
function Protect-YedekDosyasi([string]$Kaynak, [string]$Hedef, [string]$Parola, [int]$Tur = $script:SifreVarsayilanTur) {
  if (-not $Parola -or $Parola.Length -lt 12) { throw 'Yedek parolası en az 12 karakter olmalı.' }
  $tuz = Get-RastgeleBayt 16
  $iv = Get-RastgeleBayt 16
  $k = Get-SifreAnahtarlari $Parola $tuz $Tur
  $aes = New-Aes $k.Sifre $iv
  $hmac = [Security.Cryptography.HMACSHA256]::new($k.Dogrulama)
  $baslik = [byte[]]($script:SifreBuyu + [BitConverter]::GetBytes([int]$Tur) + $tuz + $iv)
  $giris = [IO.File]::OpenRead($Kaynak)
  $cikis = [IO.File]::Open($Hedef, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $macAkis = $null; $sifreAkis = $null
  try {
    # Şifreli veri önce HMAC akışından geçer (HMAC, ICryptoTransform olarak veriyi olduğu gibi geçirir), sonra dosyaya.
    $macAkis = [Security.Cryptography.CryptoStream]::new($cikis, $hmac, [Security.Cryptography.CryptoStreamMode]::Write)
    $macAkis.Write($baslik, 0, $baslik.Length)
    $sifreAkis = [Security.Cryptography.CryptoStream]::new($macAkis, $aes.CreateEncryptor(), [Security.Cryptography.CryptoStreamMode]::Write)
    $tampon = New-Object byte[] (1024 * 1024)
    while (($n = $giris.Read($tampon, 0, $tampon.Length)) -gt 0) { $sifreAkis.Write($tampon, 0, $n) }
    $sifreAkis.FlushFinalBlock()
    if (-not $macAkis.HasFlushedFinalBlock) { $macAkis.FlushFinalBlock() }
    $etiket = $hmac.Hash
    $cikis.Write($etiket, 0, $etiket.Length)
    $cikis.Flush($true)
  } finally {
    if ($sifreAkis) { $sifreAkis.Dispose() }
    if ($macAkis) { $macAkis.Dispose() }
    $cikis.Dispose(); $giris.Dispose(); $aes.Dispose(); $hmac.Dispose()
  }
}

# Önce dosyanın tamamını doğrular (parola ve bütünlük); Hedef verilmişse sonra çözer. Hata: yanlış parola ya da bozuk dosya.
function Unprotect-YedekDosyasi([string]$Kaynak, [string]$Hedef, [string]$Parola) {
  $giris = [IO.File]::OpenRead($Kaynak)
  try {
    $boy = $giris.Length
    if ($boy -lt ($script:SifreBaslikBoy + 16 + 32)) { throw 'Şifreli yedek bozuk: dosya çok kısa.' }
    $baslik = Read-TamBayt $giris $script:SifreBaslikBoy
    for ($i = 0; $i -lt 8; $i++) { if ($baslik[$i] -ne $script:SifreBuyu[$i]) { throw 'Bu dosya SellerOnData şifreli yedeği değil.' } }
    $tur = [BitConverter]::ToInt32($baslik, 8)
    if ($tur -lt 1 -or $tur -gt 100000000) { throw 'Şifreli yedek bozuk: başlık geçersiz.' }
    $tuz = New-Object byte[] 16; [Array]::Copy($baslik, 12, $tuz, 0, 16)
    $iv = New-Object byte[] 16; [Array]::Copy($baslik, 28, $iv, 0, 16)
    $k = Get-SifreAnahtarlari $Parola $tuz $tur
    $sifreliBoy = $boy - $script:SifreBaslikBoy - 32

    $hmac = [Security.Cryptography.HMACSHA256]::new($k.Dogrulama)
    try {
      [void]$hmac.TransformBlock($baslik, 0, $baslik.Length, $null, 0)
      $tampon = New-Object byte[] (1024 * 1024)
      $kalan = $sifreliBoy
      while ($kalan -gt 0) {
        $n = $giris.Read($tampon, 0, [int][Math]::Min($tampon.Length, $kalan))
        if ($n -le 0) { throw 'Dosya beklenenden kısa.' }
        [void]$hmac.TransformBlock($tampon, 0, $n, $null, 0)
        $kalan -= $n
      }
      [void]$hmac.TransformFinalBlock((New-Object byte[] 0), 0, 0)
      $etiket = Read-TamBayt $giris 32
      $fark = 0
      for ($i = 0; $i -lt 32; $i++) { $fark = $fark -bor ($etiket[$i] -bxor $hmac.Hash[$i]) }
      if ($fark -ne 0) { throw 'Parola yanlış ya da şifreli yedek bozuk (doğrulama tutmadı).' }
    } finally { $hmac.Dispose() }

    if (-not $Hedef) { return }
    [void]$giris.Seek($script:SifreBaslikBoy, [IO.SeekOrigin]::Begin)
    $aes = New-Aes $k.Sifre $iv
    $cikis = [IO.File]::Open($Hedef, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $cozAkis = $null
    try {
      $cozAkis = [Security.Cryptography.CryptoStream]::new($cikis, $aes.CreateDecryptor(), [Security.Cryptography.CryptoStreamMode]::Write)
      $kalan = $sifreliBoy
      while ($kalan -gt 0) {
        $n = $giris.Read($tampon, 0, [int][Math]::Min($tampon.Length, $kalan))
        if ($n -le 0) { throw 'Dosya beklenenden kısa.' }
        $cozAkis.Write($tampon, 0, $n)
        $kalan -= $n
      }
      $cozAkis.FlushFinalBlock()
    } finally {
      if ($cozAkis) { $cozAkis.Dispose() } else { $cikis.Dispose() }
      $aes.Dispose()
    }
  } finally { $giris.Dispose() }
}

# Yerel komut: çıktı (stdout ve stderr satırları) ve çıkış kodu. Bağımsız değişkenlerde çift tırnak kullanmayın (PowerShell 5.1 bozar).
function Invoke-Arac([string]$Dosya, [string[]]$Arg) {
  # Yalnız gerçek program çalışır: aynı adlı bir PowerShell işlevi (ör. "Docker") araya girip kendini sonsuz çağırmasın.
  $exe = if (Test-Path -LiteralPath $Dosya -PathType Leaf) { $Dosya } else {
    $c = Get-Command -Name $Dosya -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return [pscustomobject]@{ Kod = 127; Satirlar = @("Program bulunamadı: $Dosya") } }
    $c.Source
  }
  $eski = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $o = & $exe @Arg 2>&1
    $kod = $LASTEXITCODE
  } finally { $ErrorActionPreference = $eski }
  return [pscustomobject]@{ Kod = $kod; Satirlar = @($o | ForEach-Object { "$_" }) }
}

function Get-KlasorBoyu([string]$Yol) {
  $t = 0L
  Get-ChildItem -LiteralPath $Yol -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $t += $_.Length }
  return $t
}

function Write-Utf8Dosya([string]$Yol, [string]$Metin) {
  [IO.File]::WriteAllText($Yol, $Metin, (New-Object Text.UTF8Encoding $false))
}
