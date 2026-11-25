# SellerOnData yerel posta kutusu: geliştirmede giden postalar (doğrulama, şifre sıfırlama, davet) SMTP yerine veritabanına yazılır.
#   (parametresiz)  son 20 postayı bir sayfada listeler ve tarayıcıda açar
#   -To <adres>     yalnız bu alıcının postaları
#   -Open           en yeni postanın bağlantısını doğrudan açar
#   -NoBrowser      tarayıcı açma, listeyi konsola yaz
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param([string]$To, [switch]$Open, [switch]$NoBrowser)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$project = if ($env:SOD_PROJECT) { $env:SOD_PROJECT } else { "sellerondata" }
$envFile = if ($env:SOD_ENV_FILE) { Join-Path $root $env:SOD_ENV_FILE } else { Join-Path $root ".env" }

# Kullanıcı ve veritabanı adı kapta POSTGRES_USER / POSTGRES_DB ile belirlenir (tanımsızsa postgres / sellerondata).
$sql = 'SELECT coalesce(json_agg(t),''[]'') FROM (SELECT "to", subject, template, body, "createdAt" FROM platform."MailLog" ORDER BY "createdAt" DESC LIMIT 200) t'
# SQL standart girdiden gider: Windows PowerShell 5.1 çift tırnaklı argümanları bozar.
$shell = 'psql -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-sellerondata} -At'
if (Test-Path $envFile) { $raw = $sql | docker compose -p $project --env-file $envFile exec -T postgres sh -c $shell }
else { $raw = $sql | docker compose -p $project exec -T postgres sh -c $shell }
if ($LASTEXITCODE -ne 0 -or -not $raw) {
  Write-Host "Posta kutusu okunamadı. Sistem açık mı? Önce BASLAT.bat çalıştırın." -ForegroundColor Yellow
  exit 1
}
$json = ($raw | Out-String).Trim()
# Windows PowerShell 5.1 diziyi tek nesne olarak döndürür: açarak düzleştirilir.
$mails = @(ConvertFrom-Json -InputObject $json | ForEach-Object { $_ } | ForEach-Object { $_ })
if ($To) { $mails = @($mails | Where-Object { $_.to -eq $To }) }
$mails = @($mails | Select-Object -First 20)

# Veritabanı saati UTC'dir (saat dilimsiz yazılır): yerel saate çevrilir; okunamazsa olduğu gibi yazılır.
function Format-LocalTime($s) {
  try {
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    $d = [DateTime]::Parse([string]$s, [Globalization.CultureInfo]::InvariantCulture, $styles)
    return $d.ToLocalTime().ToString('dd.MM.yyyy HH:mm:ss')
  } catch { return [string]$s }
}

function Get-Links($body) { @([regex]::Matches([string]$body, 'https?://[^\s<>"'')]+') | ForEach-Object { $_.Value }) }

if ($Open) {
  $link = $null
  foreach ($m in $mails) { $l = @(Get-Links $m.body); if ($l.Count) { $link = $l[0]; break } }
  if (-not $link) { Write-Host "Bağlantılı posta yok." -ForegroundColor Yellow; exit 0 }
  Write-Host "Açılıyor: $link"
  if (-not $NoBrowser) { Start-Process $link }
  exit 0
}

if (-not $mails.Count) { Write-Host "Posta kutusu boş."; exit 0 }

if ($NoBrowser) {
  foreach ($m in $mails) {
    Write-Host ("[{0}] {1}  ->  {2}" -f (Format-LocalTime $m.createdAt), $m.subject, $m.to) -ForegroundColor Cyan
    foreach ($l in (Get-Links $m.body)) { Write-Host "    $l" }
  }
  exit 0
}

$enc = { param($s) [System.Net.WebUtility]::HtmlEncode([string]$s) }
$html = New-Object System.Text.StringBuilder
[void]$html.Append('<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SellerOnData posta kutusu</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}article{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:12px 0}small{color:#666}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><h1>Gelen postalar</h1>')
foreach ($m in $mails) {
  [void]$html.Append("<article><strong>$(& $enc $m.subject)</strong><br><small>$(& $enc $m.to) &middot; $(& $enc (Format-LocalTime $m.createdAt)) &middot; $(& $enc $m.template)</small>")
  foreach ($l in (Get-Links $m.body)) { $e = & $enc $l; [void]$html.Append("<p><a href=""$e"">$e</a></p>") }
  [void]$html.Append("<pre>$(& $enc $m.body)</pre></article>")
}
[void]$html.Append('</body></html>')
$file = Join-Path $env:TEMP "sellerondata-posta.html"
[System.IO.File]::WriteAllText($file, $html.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Posta listesi: $file"
Start-Process $file
