# SellerOnData: bu bilgisayardaki kurulumu gerçek kullanıma geçirir (KALANLAR 2.1). Ayrıntı: docs\KURULUM.md "Gerçek kullanıma geçiş".
#   (parametresiz)     denetler, planı yazar, EVET ister. Sonra: yedek (scripts\yedekle.ps1), .env güncellenir (eski hâli
#                      yedekler\gercek-kullanim\ altında), demo varsa veritabanı ve DeciShip dosyaları sıfırdan kurulur (demo
#                      tohumu yüklenmez), yığın derlenip açılır, son durum denetlenir.
#   -KuruCalisma       hiçbir şey değiştirmez: ne yapılacağını ve şimdiki durumu yazar
#   -SahipEposta <a>   sonunda bu adres için tek kullanımlık kayıt daveti üretir (kayıt kipi davetle)
#   -Evet              soru sorma (otomasyon); demo dışı firma da silinecekse ayrıca -DemoDisiniDeSil gerekir
#   -DemoDisiniDeSil   demo dışında firma ve kişi varsa onlar da silinsin (yedekte kalır)
#   -Bekle             bitince Enter bekler (çift tıklanınca pencere hemen kapanmasın)
# Çıkış: 0 tamam, 1 durdu ya da son denetim geçmedi. Yalnız yerel kurulum içindir (APP_BASE_URL localhost);
# sunucu için docs\KURULUM.md "Üretim açılışı". Yeniden çalıştırmak güvenlidir: yapılmış adım atlanır.
# Saf işlevler (ayar satırları, denetim kuralları) scripts\gercek-kullanim.test.mjs ile sınanır: dosya nokta ile
# yüklenince yalnız işlevler tanımlanır, hiçbir şey çalışmaz.
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param([switch]$KuruCalisma, [string]$SahipEposta, [switch]$Evet, [switch]$DemoDisiniDeSil, [switch]$Bekle)

# ---------- Varsayılanlar (ince ayar; KALANLAR "Yayından önce") ----------
# Günlük tavan bütün firmaların toplamıdır (Sonnet 5.5, kur 100: 200 TL ≈ 2 USD, ≈ 25 PDF sayfası). Aylık hak firma başına.
# Var olan değer bundan düşükse (ör. 0 = acil durdurma) korunur; yüksekse, boşsa ya da off ise bu değere iner.
$script:GkGunlukTavan = 200
$script:GkAylikHak = 1500
$script:GkDemoKisiOnek = '00000000-0000-7000-8000-00000000b'
$script:GkDemoFirmaOnek = '00000000-0000-7000-8000-00000000a'
$script:GkDemoAlan = 'demo.sellerondata.com'
$script:GkYerelAdlar = @('localhost', '127.0.0.1', '[::1]', '::1')

# ---------- Saf işlevler (Docker istemez) ----------

# .env değeri: tırnak soyulur, tırnaksız değerde " #" sonrası yorumdur (docker compose ile aynı).
function ConvertFrom-EnvHam([string]$Ham) {
  $v = $Ham.Trim()
  if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { return $v.Substring(1, $v.Length - 2) }
  $i = $v.IndexOf(' #')
  if ($i -ge 0) { $v = $v.Substring(0, $i).TrimEnd() }
  return $v
}

# Satır yoksa $null. Aynı ad birden çok kez varsa sonuncusu (compose sonuncuyu alır).
function Get-EnvDegeri([string]$Metin, [string]$Ad) {
  $deger = $null
  foreach ($s in ($Metin -split "`r?`n")) {
    if ($s -match "^\s*$([regex]::Escape($Ad))\s*=(.*)$") { $deger = ConvertFrom-EnvHam $Matches[1] }
  }
  return $deger
}

# "8088", "0.0.0.0:8088", "127.0.0.1:8088" → "127.0.0.1:8088". Port okunamazsa varsayılan port.
function Get-YerelBaglanti([string]$Eski, [string]$VarsayilanPort) {
  $port = $VarsayilanPort
  if ($Eski -and $Eski.Trim()) {
    $son = ($Eski.Trim() -split ':')[-1]
    if ($son -match '^\d{1,5}$') { $port = $son }
  }
  return "127.0.0.1:$port"
}

# Tavan: düz ondalık sayı tavanı aşmıyorsa korunur; aşıyorsa, boşsa, off ya da bozuksa tavan.
function Get-TavanDegeri([string]$Eski, [decimal]$Tavan) {
  $t = if ($Eski) { $Eski.Trim() } else { '' }
  if ($t -match '^\d+(\.\d+)?$') {
    $d = [decimal]::Parse($t, [Globalization.CultureInfo]::InvariantCulture)
    if ($d -le $Tavan) { return $t }
  }
  return $Tavan.ToString([Globalization.CultureInfo]::InvariantCulture)
}

function Test-YerelAdres([string]$Url) {
  if (-not $Url -or -not $Url.Trim()) { return $true }   # boş: varsayılan http://localhost:8088
  try { $ad = ([Uri]$Url.Trim()).Host.ToLowerInvariant().Trim('[', ']') } catch { return $false }
  if ($script:GkYerelAdlar -contains $ad) { return $true }
  # .NET Framework IPv6'yı açık yazar ([::1] → [0000:...:0001]); Hesap servisi yalnız ::1'i yerel sayar, 127.0.0.2 gibileri değil.
  $ip = $null
  if ([Net.IPAddress]::TryParse($ad, [ref]$ip)) { return ($ip.Equals([Net.IPAddress]::IPv6Loopback) -or $ip.Equals([Net.IPAddress]::Loopback)) }
  return $false
}

# Gerçek kullanım için .env değişiklikleri. Yalnız farklı olanlar döner: Ad, Eski ($null = satır yok), Yeni, Neden.
function Get-GercekKullanimPlani([string]$Metin, [string]$Tarih) {
  $plan = New-Object System.Collections.Generic.List[object]
  $ekle = {
    param($ad, $yeni, $neden)
    $eski = Get-EnvDegeri $Metin $ad
    if ($eski -cne $yeni) { $plan.Add([pscustomobject]@{ Ad = $ad; Eski = $eski; Yeni = $yeni; Neden = $neden }) }
  }
  & $ekle 'ENABLE_DATA_RESET' 'false' 'Ayarlar > Veri yönetimi > "Örnek verileri yükle" (firma verisini siler) kapalı'
  & $ekle 'DEMO_TOUR' 'off' 'örnek veriyle deneme turu kapalı'
  & $ekle 'SIGNUP_MODE' 'invite' 'yeni firma kaydı yalnız davetle (ekip daveti etkilenmez)'
  & $ekle 'GATEWAY_PORT' (Get-YerelBaglanti (Get-EnvDegeri $Metin 'GATEWAY_PORT') '8088') 'uygulama yalnız bu bilgisayardan (telefon USB ile, adb reverse)'
  & $ekle 'SITE_PORT' (Get-YerelBaglanti (Get-EnvDegeri $Metin 'SITE_PORT') '8089') 'tanıtım sitesi yalnız bu bilgisayardan'
  & $ekle 'AI_DAILY_BUDGET_TRY' (Get-TavanDegeri (Get-EnvDegeri $Metin 'AI_DAILY_BUDGET_TRY') $script:GkGunlukTavan) "günlük yapay zekâ tavanı en çok $($script:GkGunlukTavan) TL"
  & $ekle 'AI_FREE_CREDIT_MONTHLY_TRY' (Get-TavanDegeri (Get-EnvDegeri $Metin 'AI_FREE_CREDIT_MONTHLY_TRY') $script:GkAylikHak) "firmanın aylık yapay zekâ hakkı en çok $($script:GkAylikHak) TL"
  # Kapatılmış güvenlik ayarları açılır; yoksa compose varsayılanı (açık) geçerlidir, satır eklenmez.
  $dogrulama = Get-EnvDegeri $Metin 'SOD_EMAIL_VERIFICATION'
  if ($null -ne $dogrulama -and $dogrulama.Trim() -and $dogrulama.Trim().ToLowerInvariant() -notin @('true', '1')) {
    & $ekle 'SOD_EMAIL_VERIFICATION' 'true' 'e-posta doğrulaması açık'
  }
  $kota = Get-EnvDegeri $Metin 'AI_QUOTA_ENFORCED'
  if ($null -ne $kota -and $kota.Trim().ToLowerInvariant() -in @('false', 'off', '0', 'no')) {
    & $ekle 'AI_QUOTA_ENFORCED' 'true' 'yapay zekâ hakkı dolunca durdurur'
  }
  if (-not (Get-EnvDegeri $Metin 'SOD_GERCEK_KULLANIM')) {
    & $ekle 'SOD_GERCEK_KULLANIM' $Tarih 'bu kurulum gerçek veri taşıyor (geçiş tarihi)'
  }
  return , $plan.ToArray()
}

# Planı metne uygular: ad varsa ilk satır değişir, tekrarları silinir; yoksa sona başlık yorumuyla eklenir.
# Yorumlar ve öteki satırlar olduğu gibi kalır; satır sonu (CRLF ya da LF) korunur.
function Set-EnvDegerleri([string]$Metin, $Plan, [string]$Baslik) {
  $nl = if ($Metin -match "`r`n") { "`r`n" } else { "`n" }
  $satirlar = New-Object System.Collections.Generic.List[string]
  foreach ($s in ($Metin -split "`r?`n")) { $satirlar.Add($s) }
  while ($satirlar.Count -gt 0 -and $satirlar[$satirlar.Count - 1] -eq '') { $satirlar.RemoveAt($satirlar.Count - 1) }
  $eklenecek = New-Object System.Collections.Generic.List[string]
  foreach ($d in $Plan) {
    $desen = "^\s*$([regex]::Escape($d.Ad))\s*="
    $yazildi = $false
    for ($i = 0; $i -lt $satirlar.Count; $i++) {
      if ($satirlar[$i] -match $desen) {
        if ($yazildi) { $satirlar.RemoveAt($i); $i-- } else { $satirlar[$i] = "$($d.Ad)=$($d.Yeni)"; $yazildi = $true }
      }
    }
    if (-not $yazildi) { $eklenecek.Add("$($d.Ad)=$($d.Yeni)") }
  }
  if ($eklenecek.Count -gt 0) {
    if ($satirlar.Count -gt 0) { $satirlar.Add('') }
    $satirlar.Add("# $Baslik")
    foreach ($s in $eklenecek) { $satirlar.Add($s) }
  }
  return (($satirlar -join $nl) + $nl)
}

# docker inspect HostConfig.PortBindings → Ip, Port listesi. Boş HostIp = bütün ağ arayüzleri.
function Get-PortBaglantilari($PortBindings) {
  $sonuc = New-Object System.Collections.Generic.List[object]
  if ($null -eq $PortBindings) { return , $sonuc.ToArray() }
  foreach ($p in $PortBindings.PSObject.Properties) {
    foreach ($b in @($p.Value)) {
      if ($null -eq $b) { continue }
      $ip = if ($b.HostIp) { [string]$b.HostIp } else { '0.0.0.0' }
      $sonuc.Add([pscustomobject]@{ Ip = $ip; Port = [string]$b.HostPort; Kap = $p.Name })
    }
  }
  return , $sonuc.ToArray()
}

function Test-YalnizYerel($Baglantilar) {
  $l = @($Baglantilar)
  if ($l.Count -eq 0) { return $false }
  foreach ($b in $l) { if ($b.Ip -notin @('127.0.0.1', '::1')) { return $false } }
  return $true
}

# Kap ortamı ("AD=değer" satırları) → sözlük.
function ConvertFrom-KapOrtami([string[]]$Satirlar) {
  $h = @{}
  foreach ($s in $Satirlar) { $i = $s.IndexOf('='); if ($i -gt 0) { $h[$s.Substring(0, $i)] = $s.Substring($i + 1) } }
  return $h
}

# Veritabanı durum sorgusunun çıktısı (Invoke-VeriDurumu): demo kişi/firma sayısı, demo dışı kişi sayısı ve firmalar.
function ConvertFrom-VeriDurumu([string[]]$Satirlar) {
  $d = [pscustomobject]@{ DemoKisi = -1; DemoFirma = -1; DigerKisi = -1; Firmalar = @() }
  $firmalar = New-Object System.Collections.Generic.List[object]
  foreach ($s in $Satirlar) {
    $p = $s -split '\|', 5
    switch ($p[0]) {
      'demo_kisi' { $d.DemoKisi = [int]$p[1] }
      'demo_firma' { $d.DemoFirma = [int]$p[1] }
      'diger_kisi' { $d.DigerKisi = [int]$p[1] }
      'firma' { if ($p.Count -eq 5) { $firmalar.Add([pscustomobject]@{ Uye = [int]$p[1]; Fatura = [int]$p[2]; Olcum = [int]$p[3]; Ad = $p[4] }) } }
    }
  }
  $d.Firmalar = $firmalar.ToArray()
  return $d
}

function New-Sonuc([string]$Durum, [string]$Ad, [string]$Ayrinti) { [pscustomobject]@{ Durum = $Durum; Ad = $Ad; Ayrinti = $Ayrinti } }

function Test-SayiTavan([string]$Deger, [decimal]$Tavan) {
  $t = if ($Deger) { $Deger.Trim() } else { '' }
  if ($t -notmatch '^\d+(\.\d+)?$') { return $false }
  return ([decimal]::Parse($t, [Globalization.CultureInfo]::InvariantCulture) -le $Tavan)
}

# Çalışan kapların ortamına bakar (servislerin okuduğu kurallarla: Deciship/apps/api/src/env.ts, Platform/apps/account-api/src/env.ts).
# $null sözlük: kap yok.
function Test-KapAyarlari($Deci, $Hesap) {
  $r = New-Object System.Collections.Generic.List[object]
  if ($null -eq $Deci) { $r.Add((New-Sonuc 'HATA' 'DeciShip API' 'kap bulunamadı')) } else {
    $v = $Deci['ENABLE_DATA_RESET']
    $r.Add((New-Sonuc $(if ($v -ne 'true') { 'tamam' } else { 'HATA' }) 'Veri sıfırlama ucu kapalı' "ENABLE_DATA_RESET=$v"))
    $v = $Deci['DEMO_TOUR']
    $kapali = $v -and $v.Trim().ToLowerInvariant() -in @('false', 'off', '0', 'no')
    $r.Add((New-Sonuc $(if ($kapali) { 'tamam' } else { 'HATA' }) 'Deneme turu kapalı' "DEMO_TOUR=$v"))
    $v = $Deci['AI_DAILY_BUDGET_TRY']
    $r.Add((New-Sonuc $(if (Test-SayiTavan $v $script:GkGunlukTavan) { 'tamam' } else { 'HATA' }) "Günlük yapay zekâ tavanı ≤ $($script:GkGunlukTavan) TL" "AI_DAILY_BUDGET_TRY=$v$(if (-not $v) { ' (boş = 1000)' })"))
    $v = $Deci['AI_FREE_CREDIT_MONTHLY_TRY']
    $r.Add((New-Sonuc $(if (Test-SayiTavan $v $script:GkAylikHak) { 'tamam' } else { 'HATA' }) "Aylık yapay zekâ hakkı ≤ $($script:GkAylikHak) TL" "AI_FREE_CREDIT_MONTHLY_TRY=$v$(if (-not $v) { ' (boş = 2500)' })"))
    $v = $Deci['AI_QUOTA_ENFORCED']
    $kapali = $v -and $v.Trim().ToLowerInvariant() -in @('false', 'off', '0', 'no')
    $r.Add((New-Sonuc $(if (-not $kapali) { 'tamam' } else { 'HATA' }) 'Yapay zekâ hakkı uygulanıyor' "AI_QUOTA_ENFORCED=$v"))
  }
  if ($null -eq $Hesap) { $r.Add((New-Sonuc 'HATA' 'Hesap servisi' 'kap bulunamadı')) } else {
    $v = $Hesap['SIGNUP_MODE']
    $r.Add((New-Sonuc $(if ($v -and $v.Trim().ToLowerInvariant() -eq 'invite') { 'tamam' } else { 'HATA' }) 'Yeni firma kaydı yalnız davetle' "SIGNUP_MODE=$v"))
    $v = $Hesap['EMAIL_VERIFICATION_REQUIRED']
    $acik = (-not $v) -or ($v.Trim().ToLowerInvariant() -in @('true', '1'))
    $r.Add((New-Sonuc $(if ($acik) { 'tamam' } else { 'HATA' }) 'E-posta doğrulaması açık' "EMAIL_VERIFICATION_REQUIRED=$v"))
    $v = $Hesap['REGISTRATION_ENABLED']
    $kapali = $v -and $v.Trim() -and ($v.Trim().ToLowerInvariant() -notin @('true', '1'))
    if ($kapali) { $r.Add((New-Sonuc 'uyarı' 'Kayıt tamamen kapalı' "REGISTRATION_ENABLED=$v; davetle de firma açılamaz")) }
  }
  return , $r.ToArray()
}

# yedekle.ps1 sonucunun özetinden sorun kısmı ("...; SORUN: a; b"): çıkış 2 artık dış kopya dışında da olur
# (parola yok, saklama ayarı geçersiz, ani düşüş). Sorun yoksa $null.
function Get-YedekSorunu([string]$Ozet) {
  if (-not $Ozet) { return $null }
  $i = $Ozet.IndexOf('SORUN: ')
  if ($i -lt 0) { return $null }
  return $Ozet.Substring($i + 7).Trim()
}

# Yerel yedek gerçekten alındı mı: çıkış 0 ya da 2, son-yedek.json bu çalıştırmadan (başlangıçtan en çok 5 sn önce), kod 1 değil,
# klasör duruyor. $Son: son-yedek.json içeriği (ConvertFrom-Json) ya da $null.
function Test-YedekTamam($Son, [int]$Cikis, [datetime]$Baslangic) {
  if ($Cikis -ne 0 -and $Cikis -ne 2) { return $false }
  if (-not $Son -or [int]$Son.kod -eq 1 -or -not $Son.klasor) { return $false }
  if (-not (Test-Path -LiteralPath $Son.klasor)) { return $false }
  try { $z = [datetime]$Son.zaman } catch { return $false }
  return ($z -ge $Baslangic.AddSeconds(-5))
}

# Nokta ile yüklendiyse (test) burada durulur.
if ($MyInvocation.InvocationName -eq '.') { return }

# ---------- Çalıştırma ----------
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$project = if ($env:SOD_PROJECT) { $env:SOD_PROJECT } else { 'sellerondata' }
$envFile = if ($env:SOD_ENV_FILE) { Join-Path $root $env:SOD_ENV_FILE } else { Join-Path $root '.env' }

function Step($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Bitir([int]$k) {
  if ($Bekle) { Write-Host ''; try { Read-Host 'Kapatmak için Enter' | Out-Null } catch { } }
  exit $k
}
function Fail($msg) { Write-Host ''; Write-Host "HATA: $msg" -ForegroundColor Red; Bitir 1 }
function Compose { docker compose -p $project --env-file $envFile @args }
function Oku-EnvMetni { if (Test-Path -LiteralPath $envFile) { [IO.File]::ReadAllText($envFile) } else { '' } }
function Ayar($ad, $varsayilan) {
  $v = [Environment]::GetEnvironmentVariable($ad)
  if ($v) { return $v }
  $v = Get-EnvDegeri (Oku-EnvMetni) $ad
  if ($v) { return $v }
  return $varsayilan
}
function Get-KapId($servis) { @(Compose ps -q $servis 2>$null | Where-Object { $_ }) | Select-Object -First 1 }
function Get-KapBilgisi($servis) {
  $id = Get-KapId $servis
  if (-not $id) { return $null }
  $j = @((docker inspect $id 2>$null) -join "`n" | ConvertFrom-Json)[0]
  if (-not $j) { return $null }
  return [pscustomobject]@{
    Id = $id
    Calisiyor = [bool]$j.State.Running
    Ortam = ConvertFrom-KapOrtami @($j.Config.Env)
    Baglantilar = Get-PortBaglantilari $j.HostConfig.PortBindings
  }
}
function Invoke-VeriDurumu($pgId) {
  $kisiDemo = "(p.id::text like '$($script:GkDemoKisiOnek)%' or coalesce(p.email, '') ilike '%@$($script:GkDemoAlan)')"
  $firmaDemo = "(o.id::text like '$($script:GkDemoFirmaOnek)%')"
  $sql = @"
select 'demo_kisi|' || count(*) from platform."Person" p where $kisiDemo;
select 'demo_firma|' || count(*) from platform."Organization" o where $firmaDemo;
select 'diger_kisi|' || count(*) from platform."Person" p where not $kisiDemo;
select 'firma|' || (select count(*) from platform."Membership" m where m."orgId" = o.id)
  || '|' || (select count(*) from deciship."Invoice" i where i."companyId"::text = o.id::text)
  || '|' || (select count(*) from deciship."Measurement" x where x."companyId"::text = o.id::text)
  || '|' || o.name
  from platform."Organization" o where not $firmaDemo order by o."createdAt";
"@
  $out = @($sql | & docker exec -i $pgId psql -U postgres -d sellerondata -At -v ON_ERROR_STOP=1 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { throw "veritabanı okunamadı: $($out -join ' ')" }
  return ConvertFrom-VeriDurumu $out
}
function Test-TcpAcik([string]$Ip, [int]$Port) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($Ip, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $false }
    $c.EndConnect($iar); return $true
  } catch { return $false } finally { $c.Close() }
}
function Get-GirisKodu($base) {
  $body = '{"identifier":"sahip@demo.sellerondata.com","password":"Demo12345!","client":"mobile"}'
  try {
    $r = Invoke-WebRequest "$base/api/account/auth/login" -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 15
    return [int]$r.StatusCode
  } catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; return 0 }
}
# Yedek: yedekle.ps1 ayrı süreçte (kendi exit'i bu betiği kapatmasın). Dönen: Tamam, Cikis, Klasor, Sorun.
function Invoke-Yedek([string[]]$Ek = @()) {
  $t0 = Get-Date
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $yedekBetik @Ek
  $cikis = $LASTEXITCODE
  $kok = Ayar 'SOD_BACKUP_DIR' 'yedekler'
  if (-not [IO.Path]::IsPathRooted($kok)) { $kok = Join-Path $root $kok }
  $son = try { Get-Content -LiteralPath (Join-Path $kok 'son-yedek.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { $null }
  $tamam = Test-YedekTamam $son $cikis $t0
  return [pscustomobject]@{ Tamam = $tamam; Cikis = $cikis; Klasor = $(if ($son) { $son.klasor }); Sorun = $(if ($son) { Get-YedekSorunu $son.ozet }) }
}
function Test-Url($u) { try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 5 | Out-Null; $true } catch { $false } }

# Son durum denetimi. -GirisDene: demo hesapla giriş denenir (kuru çalışmada denenmez: başarılı giriş oturum yazar).
function Invoke-Denetim([switch]$GirisDene) {
  $s = New-Object System.Collections.Generic.List[object]
  $port = ((Ayar 'GATEWAY_PORT' '8088') -split ':')[-1]
  $base = "http://localhost:$port"
  foreach ($k in @(@('gateway', 'Uygulama (gateway)'), @('site', 'Tanıtım sitesi'))) {
    $b = Get-KapBilgisi $k[0]
    if (-not $b) { $s.Add((New-Sonuc 'HATA' "$($k[1]) yalnız 127.0.0.1" 'kap bulunamadı')); continue }
    $liste = (@($b.Baglantilar) | ForEach-Object { "$($_.Ip):$($_.Port)" }) -join ', '
    $s.Add((New-Sonuc $(if (Test-YalnizYerel $b.Baglantilar) { 'tamam' } else { 'HATA' }) "$($k[1]) yalnız 127.0.0.1" $liste))
  }
  $lan = @([Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not [Net.IPAddress]::IsLoopback($_) } | ForEach-Object { $_.IPAddressToString })
  if ($lan.Count -eq 0) { $s.Add((New-Sonuc 'bakılmadı' 'Yerel ağdan erişilemiyor' 'bu bilgisayarın ağ adresi yok')) } else {
    $acik = @($lan | Where-Object { Test-TcpAcik $_ ([int]$port) })
    $s.Add((New-Sonuc $(if ($acik.Count -eq 0) { 'tamam' } else { 'HATA' }) 'Yerel ağdan erişilemiyor' $(if ($acik.Count) { "port $port açık: $($acik -join ', ')" } else { "port $port, denendi: $($lan -join ', ')" })))
  }
  $deci = Get-KapBilgisi 'deciship-api'; $hesap = Get-KapBilgisi 'account-api'
  foreach ($x in (Test-KapAyarlari $(if ($deci) { $deci.Ortam }) $(if ($hesap) { $hesap.Ortam }))) { $s.Add($x) }
  $pg = Get-KapBilgisi 'postgres'
  if ($pg -and $pg.Calisiyor) {
    try {
      $v = Invoke-VeriDurumu $pg.Id
      $s.Add((New-Sonuc $(if ($v.DemoKisi -eq 0 -and $v.DemoFirma -eq 0) { 'tamam' } else { 'HATA' }) 'Veritabanında demo yok' "demo kişi $($v.DemoKisi), demo firma $($v.DemoFirma)"))
    } catch { $s.Add((New-Sonuc 'HATA' 'Veritabanında demo yok' $_.Exception.Message)) }
  } else { $s.Add((New-Sonuc 'HATA' 'Veritabanında demo yok' 'veritabanı kabı çalışmıyor')) }
  foreach ($u in @("$base/api/account/health", "$base/api/deciship/health")) {
    $s.Add((New-Sonuc $(if (Test-Url $u) { 'tamam' } else { 'HATA' }) 'Sağlık' $u))
  }
  if ($GirisDene) {
    $kod = Get-GirisKodu $base
    $durum = if ($kod -eq 200) { 'HATA' } elseif ($kod -eq 0) { 'HATA' } else { 'tamam' }
    $s.Add((New-Sonuc $durum 'Demo hesapla giriş reddediliyor' $(if ($kod) { "sahip@demo.sellerondata.com → HTTP $kod" } else { 'gateway yanıt vermedi' })))
  } else { $s.Add((New-Sonuc 'bakılmadı' 'Demo hesapla giriş reddediliyor' 'kuru çalışmada denenmez')) }
  return , $s.ToArray()
}
function Show-Denetim($sonuclar) {
  foreach ($x in $sonuclar) {
    $renk = switch ($x.Durum) { 'tamam' { 'Green' } 'HATA' { 'Red' } default { 'Yellow' } }
    Write-Host ("  [{0,-9}] {1}: {2}" -f $x.Durum, $x.Ad, $x.Ayrinti) -ForegroundColor $renk
  }
}
function Show-Adimlar($davetUrl) {
  $port = ((Ayar 'GATEWAY_PORT' '8088') -split ':')[-1]
  Write-Host ''
  Write-Host '================ Sizin adımlarınız ================' -ForegroundColor Green
  if ($davetUrl) {
    Write-Host "  1. Kayıt: tarayıcıda şu bağlantıyı açın (tek kullanımlık):"
    Write-Host "     $davetUrl" -ForegroundColor Cyan
  } else {
    Write-Host '  1. Kayıt daveti üretin (kayıt yalnız davetle):'
    Write-Host '     powershell -ExecutionPolicy Bypass -File scripts\gercek-kullanim.ps1 -SahipEposta <e-postanız>' -ForegroundColor Cyan
    Write-Host '     Çıkan bağlantıyı tarayıcıda açın.'
  }
  Write-Host '     Firma adını, adınızı ve şifrenizi girin.'
  Write-Host '  2. Doğrulama postası: POSTA.bat açın, son postadaki bağlantıya tıklayın.'
  Write-Host "  3. http://localhost:$port adresinden girin: Merkez > DeciShip. Taşıyıcı ve tarifenizi ekleyin, faturayı yükleyin."
  Write-Host '  4. Telefon (USB): Deciship klasöründe  powershell -ExecutionPolicy Bypass -File scripts\phone.ps1 -NoInstall'
  Write-Host '     Uygulamada eski demo oturumundan çıkıp yeni hesabınızla girin. Aynı Wi-Fi ile doğrudan bağlantı artık çalışmaz.'
  Write-Host '  5. Çalışanlar: Merkez > Ekip > davet (e-posta ya da telefon + kod).'
  Write-Host '  6. Her gece yedek: powershell -File scripts\yedek-zamanla.ps1 kaydet; .env içinde SOD_BACKUP_OFFSITE_DIR (bulut klasörü ya da harici disk).'
  Write-Host '  Bundan sonra ÇALIŞTIRMAYIN: SIFIRLA.bat (bütün veriyi siler), scripts\demo.ps1 -Seed ve scripts\dev.ps1 -Seed (demo hesap ekler).' -ForegroundColor Yellow
  Write-Host '  Açmak / kapatmak: BASLAT.bat / DURDUR.bat (veri korunur, demo yüklenmez).'
  Write-Host '===================================================' -ForegroundColor Green
}

Write-Host ''
Write-Host "SellerOnData gerçek kullanıma geçiş$(if ($KuruCalisma) { ' (KURU ÇALIŞMA: hiçbir şey değişmez)' })" -ForegroundColor Cyan

# 1) Ön denetim (yalnız okur)
Step 'Ön denetim'
if (-not (Test-Path -LiteralPath $envFile)) { Fail ".env yok ($envFile). Önce BASLAT.bat ile sistemi bir kez kurun." }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker kurulu değil.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker çalışmıyor. Docker Desktop açık mı?' }
$appUrl = Ayar 'APP_BASE_URL' ''
if (-not (Test-YerelAdres $appUrl)) { Fail "Bu betik yalnız bu bilgisayardaki kurulum içindir (APP_BASE_URL=$appUrl). Sunucu: docs\KURULUM.md 'Üretim açılışı'." }
$yedekBetik = Join-Path $PSScriptRoot 'yedekle.ps1'
if (-not (Test-Path -LiteralPath $yedekBetik)) { Fail "Yedek betiği yok: $yedekBetik" }

$pgHacim = Ayar 'SOD_PGDATA_VOLUME' 'sod_pgdata'
$pg = Get-KapBilgisi 'postgres'
$veri = $null
$bosKurulum = $false
if ($pg -and $pg.Calisiyor) {
  try { $veri = Invoke-VeriDurumu $pg.Id } catch { Fail $_.Exception.Message }
} else {
  docker volume inspect $pgHacim *> $null
  if ($LASTEXITCODE -eq 0) { Fail 'Sistem kapalı. Önce BASLAT.bat ile açın (veri var; demo yeniden yüklenmez), sonra bu betiği yeniden çalıştırın.' }
  $bosKurulum = $true
  Write-Host "  Veritabanı hacmi ($pgHacim) yok: boş kurulum. Silinecek veri yok; demo yüklenmeden açılacak."
}
$sifirla = $false
$digerFirmalar = @()
if ($veri) {
  $sifirla = ($veri.DemoKisi -gt 0 -or $veri.DemoFirma -gt 0)
  $digerFirmalar = @($veri.Firmalar)
  Write-Host "  Demo: $($veri.DemoKisi) kişi, $($veri.DemoFirma) firma. Demo dışı: $($veri.DigerKisi) kişi, $($digerFirmalar.Count) firma."
  foreach ($f in $digerFirmalar) { Write-Host "    - $($f.Ad): $($f.Uye) üye, $($f.Fatura) fatura, $($f.Olcum) ölçüm" }
}

$bugun = Get-Date -Format 'yyyy-MM-dd'
$envMetni = Oku-EnvMetni
$plan = Get-GercekKullanimPlani $envMetni $bugun

# 2) Plan
Step 'Yapılacaklar'
$no = 1
if (-not $bosKurulum) { Write-Host "  $no. Yedek: scripts\yedekle.ps1 (veritabanı, DeciShip dosyaları, .env, keys\)."; $no++ }
if ($plan.Count) {
  Write-Host "  $no. .env güncellenir (eski hâli yedek klasörüne tarihli kopya):"; $no++
  foreach ($d in $plan) { Write-Host ("       {0}: {1} -> {2}   ({3})" -f $d.Ad, $(if ($null -eq $d.Eski) { '(yok)' } elseif ($d.Eski -eq '') { '(boş)' } else { $d.Eski }), $d.Yeni, $d.Neden) }
} else { Write-Host '  - .env zaten gerçek kullanım ayarında; değişmez.' }
if ($sifirla) {
  Write-Host "  $no. Veritabanı ve DeciShip dosyaları silinip boş kurulur (demo tohumu yüklenmez). keys\ ve .env kalır; herkes oturumdan düşer." -ForegroundColor Yellow; $no++
  if ($digerFirmalar.Count) { Write-Host "     Demo dışı $($digerFirmalar.Count) firma ve $($veri.DigerKisi) kişi de silinir (yedekte kalır). Firmanızı davetle yeniden açacaksınız." -ForegroundColor Yellow }
} elseif ($veri) { Write-Host '  - Veritabanında demo yok; veri silinmez.' }
$yenidenBaslat = ($plan.Count -gt 0 -or $sifirla -or $bosKurulum)
if ($yenidenBaslat) { Write-Host "  $no. Sistem derlenip açılır (docker compose up -d --build; birkaç dakika)."; $no++ }
Write-Host "  $no. Son denetim: ayarlar kaplarda etkin mi, gateway yalnız 127.0.0.1'de mi, demo giriş reddediliyor mu."

if ($KuruCalisma) {
  Step 'Şimdiki durum (yalnız okundu)'
  Show-Denetim (Invoke-Denetim)
  Write-Host ''
  Write-Host 'Kuru çalışma: hiçbir şey değişmedi.' -ForegroundColor Green
  Bitir 0
}

# 3) Onay
if ($sifirla -and $digerFirmalar.Count -and $Evet -and -not $DemoDisiniDeSil) {
  Fail 'Demo dışı firma var; -Evet ile silinmez. Listeye bakın; silinsin istiyorsanız -DemoDisiniDeSil ekleyin.'
}
if (-not $Evet) {
  $ans = (Read-Host 'Onaylamak için EVET yazın').Trim()
  if ($ans -cne 'EVET') { Write-Host 'Vazgeçildi, hiçbir şey değişmedi.' -ForegroundColor Green; Bitir 0 }
}

# 4) Yedek
if (-not $bosKurulum) {
  Step 'Yedek alınıyor'
  $y = Invoke-Yedek
  if ($y.Cikis -ne 0 -and $y.Cikis -ne 2) { Fail "Yedek alınamadı (çıkış $($y.Cikis)). Hiçbir şey değişmedi." }
  if (-not $y.Tamam) { Fail 'Yedek doğrulanamadı (yedekler\son-yedek.json, yedek klasörü). Hiçbir şey değişmedi.' }
  $yedekKlasoru = $y.Klasor
  Write-Host "  Yedek: $yedekKlasoru" -ForegroundColor Green
  # Çıkış 2: yerel yedek tamam, ama dış kopya, parola, saklama ayarı ya da ani düşüşte sorun var. Geçişi durdurmaz.
  if ($y.Cikis -eq 2) { Write-Host "  Uyarı: yerel yedek tamam, ama: $(if ($y.Sorun) { $y.Sorun } else { 'ayrıntı yedekler\son-yedek.json' })" -ForegroundColor Yellow }
} else { $yedekKlasoru = $null }

# 5) .env
$envKopya = $null
if ($plan.Count) {
  Step '.env güncelleniyor'
  $kopyaDir = Ayar 'SOD_BACKUP_DIR' 'yedekler'
  if (-not [IO.Path]::IsPathRooted($kopyaDir)) { $kopyaDir = Join-Path $root $kopyaDir }
  $kopyaDir = Join-Path $kopyaDir 'gercek-kullanim'
  New-Item -ItemType Directory -Force -Path $kopyaDir | Out-Null
  $envKopya = Join-Path $kopyaDir ("env-{0}.env" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
  Copy-Item -LiteralPath $envFile -Destination $envKopya
  $yeni = Set-EnvDegerleri $envMetni $plan "Gerçek kullanım (scripts\gercek-kullanim.ps1, $bugun)"
  [IO.File]::WriteAllText($envFile, $yeni, (New-Object Text.UTF8Encoding $false))
  Write-Host "  Yazıldı. Eski hâli: $envKopya" -ForegroundColor Green
}
$geriDon = "Geri dönüş: $(if ($envKopya) { "eski .env $envKopya; " })veri için powershell -File scripts\geri-yukle.ps1 -Canli -Yedek $(if ($yedekKlasoru) { $yedekKlasoru } else { '<yedek klasörü>' })"

# 6) Demo verisini kaldır: veritabanı ve dosyalar sıfırdan (Hesap servisi de "demo verisi canlıya taşınamaz: veritabanını
# sıfırdan kurun" der, apps/account-api/src/lib/demo.ts). Seçerek silen hazır bir yol yok.
if ($sifirla) {
  Step 'Demo verisi kaldırılıyor (veritabanı ve DeciShip dosyaları sıfırdan)'
  Compose down -v --remove-orphans
  if ($LASTEXITCODE -ne 0) { Fail "Sistem durdurulamadı ya da hacimler silinemedi. $geriDon" }
  docker volume inspect $pgHacim *> $null
  if ($LASTEXITCODE -eq 0) { Fail "Veritabanı hacmi ($pgHacim) hâlâ duruyor. Docker Desktop'ta onu kullanan kabı kapatıp bu betiği yeniden çalıştırın. $geriDon" }
}

# 7) Başlat (demo tohumu yüklenmez; hacim artık var, BASLAT.bat da sonradan yüklemez)
if ($yenidenBaslat) {
  Step 'Sistem derleniyor ve başlatılıyor'
  Compose up -d --build --remove-orphans
  if ($LASTEXITCODE -ne 0) { Fail "Başlatılamadı. Hatayı giderip bu betiği yeniden çalıştırın (BASLAT.bat değil: boş veritabanına demo yükler). $geriDon" }
  $port = ((Ayar 'GATEWAY_PORT' '8088') -split ':')[-1]
  $bekle = @("http://localhost:$port/healthz", "http://localhost:$port/api/account/health", "http://localhost:$port/api/deciship/health")
  $deadline = (Get-Date).AddMinutes(4)
  while ($bekle.Count -gt 0 -and (Get-Date) -lt $deadline) {
    $bekle = @($bekle | Where-Object { -not (Test-Url $_) })
    if ($bekle.Count -gt 0) { Start-Sleep 3 }
  }
  if ($bekle.Count -gt 0) { Write-Host "  Yanıt vermeyenler: $($bekle -join ', ')" -ForegroundColor Yellow; Compose logs --tail 30 account-api deciship-api }
}

# 8) Son denetim
Step 'Son denetim'
$sonuclar = Invoke-Denetim -GirisDene
Show-Denetim $sonuclar
$hata = @($sonuclar | Where-Object { $_.Durum -eq 'HATA' }).Count

# 8b) Yeni taban yedeği: veri bilerek silindi; ilk gece yedeği geçiş öncesine göre "ani düşüş" demesin
# (yedekle.ps1 en yeni yedekle karşılaştırır). Alınamazsa geçiş geçerli kalır, uyarı yazılır.
$tabanYedek = $null
if ($hata -eq 0 -and ($sifirla -or $bosKurulum)) {
  Step 'Yeni taban yedeği (boş kurulum)'
  $t = Invoke-Yedek @('-YeniTaban')
  if ($t.Tamam) {
    $tabanYedek = $t.Klasor
    Write-Host "  Yedek: $tabanYedek" -ForegroundColor Green
    if ($t.Cikis -eq 2 -and $t.Sorun) { Write-Host "  Uyarı: $($t.Sorun)" -ForegroundColor Yellow }
  } else {
    Write-Host '  Taban yedeği alınamadı. YEDEKLE.bat ile elle alın; yoksa bu gecenin yedeği "ani düşüş" uyarısı verir (veri silinmez).' -ForegroundColor Yellow
  }
}

# 9) Kayıt daveti
$davetUrl = $null
if ($hata -eq 0) {
  if (-not $SahipEposta -and -not $Evet) { $SahipEposta = (Read-Host 'Kayıt daveti için e-posta adresiniz (boş: sonra)').Trim() }
  if ($SahipEposta) {
    if ($SahipEposta -notmatch '^[^\s@"'']+@[^\s@"'']+\.[^\s@"'']+$') { Write-Host "  Geçersiz e-posta: $SahipEposta. Davet üretilmedi." -ForegroundColor Yellow }
    else {
      Step 'Kayıt daveti'
      $out = @(Compose exec -T account-api node dist/signup-invite.js --email $SahipEposta --operator gercek-kullanim 2>&1 | ForEach-Object { "$_" })
      if ($LASTEXITCODE -eq 0) { $davetUrl = @($out | Where-Object { $_ -match '^https?://' })[0]; $out | Where-Object { $_ -ne $davetUrl } | Out-Host }
      else { $out | Out-Host; Write-Host '  Davet üretilemedi; adımlardaki komutla yeniden deneyin.' -ForegroundColor Yellow }
    }
  }
}

if ($hata -gt 0) {
  Write-Host ''
  Write-Host "Son denetimde $hata sorun var (yukarıda kırmızı). $geriDon" -ForegroundColor Red
  Bitir 1
}
Write-Host ''
Write-Host 'Gerçek kullanıma geçildi.' -ForegroundColor Green
if ($yedekKlasoru) { Write-Host "  Geçiş öncesi yedek: $yedekKlasoru (demo verisi; gerekirse geri-yukle.ps1 ile prova)" }
if ($tabanYedek) { Write-Host "  Yeni taban yedeği: $tabanYedek" }
if ($envKopya) { Write-Host "  Eski .env: $envKopya" }
Show-Adimlar $davetUrl
Bitir 0
