# Testler için Docker'sız yerel Postgres (KALANLAR 0.1). Yönetici hakkı istemez; Docker yığınına (5434) dokunmaz.
# Resmî taşınabilir PostgreSQL Windows ikilileri (EnterpriseDB zip'i, postgresql.org'un gösterdiği dağıtım) kullanıcı
# klasörüne iner; küme yalnız testler içindir: port 5435, yalnız localhost, fsync kapalı (veri kaybı önemsiz, hız önemli).
# Roller ve parolalar Docker'daki ile aynı: Platform/infra/postgres/init.sql bir kez, süper kullanıcı postgres/sod_postgres_dev.
#
#   npm run pg:baslat              yoksa indirir ve kurar, sonra başlatır
#   npm run pg:durdur              durdurur (veri kalır)
#   npm run pg:durum               çalışıyor mu, nerede
#   npm run pg:yerel -- sil        durdurur ve kümeyi siler (ikililer kalır; sonraki başlatma yeniden kurar)
#
# Testler: kök koşucular (npm test:db, npm run t, npm run test:changed) 5434 kapalıysa 5435'i kendiliğinden bulur ve
# TEST_DB_HOST=localhost:5435 ile koşar. Elle: PowerShell $env:TEST_DB_HOST='localhost:5435'; npx vitest run test/x.test.ts
# Konum: $env:SOD_PG_HOME (varsayılan %LOCALAPPDATA%\SellerOnData\pg-test); depo dışında, git'e girmez.
# Dosya UTF-8 BOM'ludur: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle doğru okur. BOM'u silmeyin.
param(
  [Parameter(Position = 0)][ValidateSet('baslat', 'durdur', 'durum', 'kur', 'sil')][string]$Komut = 'durum'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # npm ve borular Türkçe harfi bozmasın
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest ilerleme çubuğu 5.1'de indirmeyi çok yavaşlatır

# Docker'daki postgres:17 ile aynı ana sürüm. Sürüm değişirse SHA-256 da değişir (indirip Get-FileHash ile yazın).
$Version = '17.12'
$Sha256 = 'A2CD8A774389347B70BE7748AC4A37EF43CB6EE539C5FC3E85AE264B15E4A04C'
$Port = if ($env:SOD_PG_LOCAL_PORT) { [int]$env:SOD_PG_LOCAL_PORT } else { 5435 }
$SuperPassword = 'sod_postgres_dev'   # yalnız yerel test kümesi; Docker yerel geliştirme varsayılanıyla aynı

$repo = Split-Path -Parent $PSScriptRoot
$home_ = if ($env:SOD_PG_HOME) { $env:SOD_PG_HOME } else { Join-Path $env:LOCALAPPDATA 'SellerOnData\pg-test' }
$binRoot = Join-Path $home_ "pg-$Version"
$bin = Join-Path $binRoot 'pgsql\bin'
$data = Join-Path $home_ 'data17'
$log = Join-Path $home_ 'postgres.log'
$initSql = Join-Path $repo 'Platform\infra\postgres\init.sql'
$url = "https://get.enterprisedb.com/postgresql/postgresql-$Version-1-windows-x64-binaries.zip"

function Say($m) { Write-Host $m }
function Fail($m) { Write-Host "HATA: $m" -ForegroundColor Red; exit 1 }
function Exe($name) { Join-Path $bin "$name.exe" }
function Test-Port {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $a = $c.BeginConnect('127.0.0.1', $Port, $null, $null); return ($a.AsyncWaitHandle.WaitOne(1000) -and $c.Connected) }
  catch { return $false } finally { $c.Close() }
}
function Test-Running {
  if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) { return $false }
  & (Exe 'pg_ctl') status -D $data *> $null
  return $LASTEXITCODE -eq 0
}

function Install-Binaries {
  if (Test-Path (Exe 'postgres')) { return }
  New-Item -ItemType Directory -Force $home_ | Out-Null
  $zip = Join-Path $home_ "postgresql-$Version.zip"
  if (-not (Test-Path $zip)) {
    Say "İndiriliyor: $url (yaklaşık 380 MB, bir kez)"
    $tmp = "$zip.part"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    Move-Item -Force $tmp $zip
  }
  $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash
  if ($hash -ne $Sha256) {
    Remove-Item -Force $zip
    Fail "indirilen dosyanın SHA-256'sı beklenen değil ($hash). Dosya silindi; sürüm değiştiyse betikteki `$Sha256'yı güncelleyin."
  }
  Say 'Açılıyor (pgAdmin, StackBuilder, belgeler ve hata ayıklama simgeleri atlanır)'
  $tmpDir = "$binRoot.part"
  if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
  New-Item -ItemType Directory -Force $tmpDir | Out-Null
  # Windows 10+ tar.exe (bsdtar) zip açar ve dışlama kalıbını destekler; Expand-Archive hepsini açar ve yavaştır.
  & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $tmpDir --exclude 'pgsql/pgAdmin 4' --exclude 'pgsql/StackBuilder' --exclude 'pgsql/symbols' --exclude 'pgsql/doc'
  if ($LASTEXITCODE -ne 0) { Fail 'zip açılamadı (tar)' }
  Move-Item $tmpDir $binRoot
  Remove-Item -Force $zip
}

function Initialize-Cluster {
  if (Test-Path (Join-Path $data 'PG_VERSION')) { return }
  if (Test-Path $data) { Remove-Item -Recurse -Force $data }   # yarım kalmış kurulum
  $pw = Join-Path $home_ 'pw.tmp'
  [IO.File]::WriteAllText($pw, $SuperPassword)
  try {
    Say "Küme kuruluyor: $data"
    # ICU en-US: Docker imajının en_US.utf8 sıralamasına en yakın; ileti dili İngilizce (testler hata metnine bakabilir).
    & (Exe 'initdb') -D $data -U postgres "--pwfile=$pw" -A scram-sha-256 -E UTF8 --locale-provider=icu --icu-locale=en-US --locale=C --lc-messages=C | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'initdb başarısız' }
  } finally { Remove-Item -Force $pw -ErrorAction SilentlyContinue }
  # Yalnız test kümesi: dayanıklılık kapalı, saat dilimi Docker kabı gibi UTC.
  $conf = @"

# --- SellerOnData yerel test kümesi (scripts/pg-yerel.ps1) ---
port = $Port
listen_addresses = 'localhost'
max_connections = 200
timezone = 'UTC'
log_timezone = 'UTC'
lc_messages = 'C'
fsync = off
synchronous_commit = off
full_page_writes = off
logging_collector = off
"@
  Add-Content -Path (Join-Path $data 'postgresql.conf') -Value $conf -Encoding ASCII
}

function Start-Cluster {
  if (Test-Running) { Say "Zaten çalışıyor: localhost:$Port"; return }
  if (Test-Port) { Fail "port $Port başka bir süreçte açık; SOD_PG_LOCAL_PORT ile başka port seçin" }
  # Ayrı, gizli konsolda: bu terminal kapansa da sunucu sürer. Durdurma yalnız pg_ctl stop ile.
  # -Wait kullanılmaz: 5.1'de alt süreçleri (sunucunun kendisi) de bekler ve hiç dönmez. Yalnız pg_ctl beklenir.
  $p = Start-Process -FilePath (Exe 'pg_ctl') -ArgumentList @('start', '-w', '-t', '60', '-D', "`"$data`"", '-l', "`"$log`"") -WindowStyle Hidden -PassThru
  $null = $p.Handle   # çıkış kodu ancak tutamaç alınmışsa okunur
  $p.WaitForExit()
  if ($p.ExitCode -ne 0 -or -not (Test-Running)) { Fail "başlatılamadı; günlük: $log" }
  Say "Çalışıyor: localhost:$Port (günlük: $log)"
}

function Initialize-Roles {
  $marker = Join-Path $data 'sod-init.done'
  if (Test-Path $marker) { return }
  Say 'Roller kuruluyor (Platform/infra/postgres/init.sql)'
  $env:PGPASSWORD = $SuperPassword
  $env:POSTGRES_PASSWORD = $SuperPassword
  & (Exe 'psql') -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f $initSql | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'init.sql başarısız (küme silinip yeniden kurulabilir: npm run pg:yerel -- sil)' }
  New-Item -ItemType File $marker | Out-Null
}

function Stop-Cluster {
  if (-not (Test-Running)) { Say 'Çalışmıyor.'; return }
  & (Exe 'pg_ctl') stop -D $data -m fast -w | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'durdurulamadı' }
  Say 'Durdu.'
}

switch ($Komut) {
  'kur' { Install-Binaries; Initialize-Cluster; Say "Kurulu: $binRoot" }
  'baslat' { Install-Binaries; Initialize-Cluster; Start-Cluster; Initialize-Roles; Say "Testler için: TEST_DB_HOST=localhost:$Port (kök koşucular kendiliğinden bulur)" }
  'durdur' { if (Test-Path (Exe 'pg_ctl')) { Stop-Cluster } else { Say 'Kurulu değil.' } }
  'durum' {
    if (-not (Test-Path (Exe 'postgres'))) { Say "Kurulu değil ($binRoot). Kurmak ve başlatmak: npm run pg:baslat"; exit 3 }
    if (Test-Running) { Say "Çalışıyor: localhost:$Port  küme: $data"; exit 0 }
    Say "Kurulu, çalışmıyor. Başlatmak: npm run pg:baslat"; exit 3
  }
  'sil' {
    if (Test-Path (Exe 'pg_ctl')) { Stop-Cluster }
    if (Test-Path $data) { Remove-Item -Recurse -Force $data; Say "Küme silindi: $data" } else { Say 'Küme yok.' }
  }
}
