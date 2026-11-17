// node --test scripts/gercek-kullanim.test.mjs  (Platform klasöründen; Docker ve veritabanı istemez)
// Gerçek kullanıma geçiş betiğinin (scripts/gercek-kullanim.ps1) saf mantığı: .env satırlarının okunması ve güncellenmesi,
// geçiş planı (yerel bağlama, yapay zekâ tavanı, kapatılmış güvenlik ayarları), port bağlantısı ve kap ayarı denetimi.
// Betik nokta ile yüklenir: yalnız işlevler tanımlanır, Docker'a dokunulmaz.
// Windows'ta powershell.exe (5.1), başka sistemde pwsh (7) ile koşar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BETIK = path.join(HERE, 'gercek-kullanim.ps1');
const PS = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
let dir;
let R;

const SCRIPT = String.raw`
param([string]$Betik)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. $Betik
$o = [ordered]@{}
$LF = [string][char]10
$CRLF = [string][char]13 + $LF
# İşlevler diziyi tek nesne olarak döndürür (virgülle): sonucu önce değişkene alıp foreach ile dolaşın.
function Plan([string]$m) {
  $p = Get-GercekKullanimPlani $m '2026-11-17'
  $l = @(); foreach ($d in $p) { $l += [ordered]@{ ad = $d.Ad; eski = $d.Eski; yeni = $d.Yeni } }
  return , $l
}

$o.oku = @(
  (Get-EnvDegeri ((@('A=1', '  B = iki ', '# C=yorum', 'D="tırnak # içi"', 'E=değer # yorum', 'A=son') -join $LF)) 'A'),
  (Get-EnvDegeri ('B = iki ' + $LF) 'B'),
  (Get-EnvDegeri ('# C=yorum' + $LF) 'C'),
  (Get-EnvDegeri ('D="tırnak # içi"' + $LF) 'D'),
  (Get-EnvDegeri ('E=değer # yorum' + $LF) 'E'),
  (Get-EnvDegeri ('AB=1' + $LF) 'A'),
  (Get-EnvDegeri ('F=' + $LF) 'F')
)
$o.okuYok = ($null -eq (Get-EnvDegeri 'X=1' 'Y'))

$o.port = @(
  (Get-YerelBaglanti '8088' '8088'), (Get-YerelBaglanti '9090' '8088'), (Get-YerelBaglanti '0.0.0.0:9090' '8088'),
  (Get-YerelBaglanti '127.0.0.1:8088' '8088'), (Get-YerelBaglanti '' '8089'), (Get-YerelBaglanti 'bozuk' '8089')
)
$o.tavan = @(
  (Get-TavanDegeri '200' 200), (Get-TavanDegeri '150.50' 200), (Get-TavanDegeri '0' 200), (Get-TavanDegeri '1000' 200),
  (Get-TavanDegeri '' 200), (Get-TavanDegeri 'off' 200), (Get-TavanDegeri '1e3' 200), (Get-TavanDegeri '-5' 200), (Get-TavanDegeri $null 1500)
)
$o.yerel = @(
  (Test-YerelAdres 'http://localhost:8088'), (Test-YerelAdres 'http://127.0.0.1:8088'), (Test-YerelAdres 'http://[::1]:8088'),
  (Test-YerelAdres ''), (Test-YerelAdres 'https://app.sellerondata.com'), (Test-YerelAdres 'http://192.168.1.5:8088'), (Test-YerelAdres 'bozuk')
)

# Bugünkü yerel .env'e benzer: demo kurulumu (ilk BASLAT ENABLE_DATA_RESET=true yazar), port tüm arayüzlerde.
$demoEnv = (@(
  '# SellerOnData', 'APP_BASE_URL=http://localhost:8088', 'ENABLE_DATA_RESET=true', '# Örnek veriyle deneme turu', 'DEMO_TOUR=on',
  'SIGNUP_MODE=', 'GATEWAY_PORT=8088', 'SITE_PORT=8089', '# AI_DAILY_BUDGET_TRY=1000', 'SOD_EMAIL_VERIFICATION=false', 'AI_QUOTA_ENFORCED=off'
) -join $LF) + $LF
$o.planDemo = Plan $demoEnv
$o.metinDemo = Set-EnvDegerleri $demoEnv (Get-GercekKullanimPlani $demoEnv '2026-11-17') 'Gerçek kullanım (deneme)'
# Zaten sıkı ayarlı .env (ör. bugünkü): yalnız eksikler; düşük tavan korunur, doğrulama satırı yoksa eklenmez.
$sikiEnv = (@('ENABLE_DATA_RESET=false', 'GATEWAY_PORT=127.0.0.1:8088', 'SITE_PORT=127.0.0.1:8089', 'AI_DAILY_BUDGET_TRY=50', 'EMAIL_VERIFICATION_REQUIRED=false') -join $CRLF) + $CRLF
$o.planSiki = Plan $sikiEnv
$o.metinSiki = Set-EnvDegerleri $sikiEnv (Get-GercekKullanimPlani $sikiEnv '2026-11-17') 'B'
# İkinci çalıştırma: uygulanmış metinde plan boştur.
$o.planIkinci = Plan $o.metinDemo
# Tekrarlanan satır: ilki değişir, tekrarı silinir; yorumdaki ad dokunulmaz.
$o.tekrar = Set-EnvDegerleri ((@('DEMO_TOUR=on', '# DEMO_TOUR=on', 'X=1', 'DEMO_TOUR=on') -join $LF) + $LF) @([pscustomobject]@{ Ad = 'DEMO_TOUR'; Yeni = 'off' }) 'B'
$o.bos = Set-EnvDegerleri '' @([pscustomobject]@{ Ad = 'A'; Yeni = '1' }) 'B'

$pb = '{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8088"}]}' | ConvertFrom-Json
$pbTum = '{"80/tcp":[{"HostIp":"","HostPort":"8088"}]}' | ConvertFrom-Json
$pbIki = '{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8088"},{"HostIp":"0.0.0.0","HostPort":"8088"}]}' | ConvertFrom-Json
$o.bag = @(
  (Test-YalnizYerel (Get-PortBaglantilari $pb)), (Test-YalnizYerel (Get-PortBaglantilari $pbTum)),
  (Test-YalnizYerel (Get-PortBaglantilari $pbIki)), (Test-YalnizYerel (Get-PortBaglantilari $null)),
  (@(Get-PortBaglantilari $pbTum)[0].Ip)
)

$o.kapOrtam = (ConvertFrom-KapOrtami @('A=1', 'B=x=y', 'C=', 'bozuk'))
$v = ConvertFrom-VeriDurumu @('demo_kisi|8', 'demo_firma|2', 'diger_kisi|3', 'firma|3|0|0|GiftUpStore', 'firma|1|2|5|Ad | çizgili', 'gurultu')
$o.veri = [ordered]@{ demoKisi = $v.DemoKisi; demoFirma = $v.DemoFirma; diger = $v.DigerKisi; firmalar = @($v.Firmalar | ForEach-Object { "$($_.Ad)/$($_.Uye)/$($_.Fatura)/$($_.Olcum)" }) }

function Denetim($d, $h) {
  $r = Test-KapAyarlari $d $h
  $l = @(); foreach ($x in $r) { $l += "$($x.Durum)|$($x.Ad)" }
  return , $l
}
$iyiDeci = @{ ENABLE_DATA_RESET = 'false'; DEMO_TOUR = 'off'; AI_DAILY_BUDGET_TRY = '200'; AI_FREE_CREDIT_MONTHLY_TRY = '1500'; AI_QUOTA_ENFORCED = 'true' }
$iyiHesap = @{ SIGNUP_MODE = 'invite'; EMAIL_VERIFICATION_REQUIRED = 'true'; REGISTRATION_ENABLED = 'true' }
$o.denIyi = Denetim $iyiDeci $iyiHesap
# Bugünkü demo kurulumu: compose varsayılanları (deneme turu açık, aylık hak 2500, kayıt açık).
$o.denDemo = Denetim @{ ENABLE_DATA_RESET = 'true'; DEMO_TOUR = 'on'; AI_DAILY_BUDGET_TRY = ''; AI_FREE_CREDIT_MONTHLY_TRY = '2500'; AI_QUOTA_ENFORCED = 'false' } @{ SIGNUP_MODE = 'open'; EMAIL_VERIFICATION_REQUIRED = 'false'; REGISTRATION_ENABLED = 'false' }
$o.denYok = Denetim $null $null
$o.denOff = Denetim @{ ENABLE_DATA_RESET = 'false'; DEMO_TOUR = 'off'; AI_DAILY_BUDGET_TRY = 'off'; AI_FREE_CREDIT_MONTHLY_TRY = '0' } @{ SIGNUP_MODE = 'INVITE' }

$o.sorun = @(
  (Get-YedekSorunu 'yerel tamam: C:\y\2026-11-17_0300; dış kopya ayarlı değil'),
  (Get-YedekSorunu 'yerel tamam: C:\y\2026-11-17_0300; SORUN: parola yok; önceki yedeğe göre ani düşüş: satır 900 -> 40'),
  (Get-YedekSorunu '')
)
$t0 = Get-Date
$var = [IO.Path]::GetTempPath()
function Son($kod, $klasor, $zaman) { [pscustomobject]@{ kod = $kod; klasor = $klasor; zaman = $zaman.ToString('o'); ozet = '' } }
$o.yedekTamam = @(
  (Test-YedekTamam (Son 0 $var $t0) 0 $t0),
  (Test-YedekTamam (Son 2 $var $t0) 2 $t0),
  (Test-YedekTamam (Son 0 $var $t0) 1 $t0),
  (Test-YedekTamam (Son 1 $var $t0) 2 $t0),
  (Test-YedekTamam $null 0 $t0),
  (Test-YedekTamam (Son 0 (Join-Path $var 'yok-gercek-kullanim-testi') $t0) 0 $t0),
  (Test-YedekTamam (Son 0 $var $t0.AddMinutes(-10)) 0 $t0)
)

$o | ConvertTo-Json -Depth 6 -Compress
`;

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gercek-kullanim-test-'));
  const file = path.join(dir, 'calistir.ps1');
  // BOM: Windows PowerShell 5.1 Türkçe karakterleri ancak böyle okur.
  writeFileSync(file, String.fromCharCode(0xfeff) + SCRIPT, 'utf8');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Betik', BETIK], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `PowerShell çıkış ${r.status}\n${r.stderr}\n${r.stdout}`);
  const line = r.stdout.trim().split(/\r?\n/).pop();
  R = JSON.parse(line);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('ayar okuma: son tekrar, boşluk, tırnak, satır içi yorum', () => {
  assert.deepEqual(R.oku, ['son', 'iki', null, 'tırnak # içi', 'değer', null, '']);
  assert.equal(R.okuYok, true);
});

test('port yalnız bu bilgisayara bağlanır, port numarası korunur', () => {
  assert.deepEqual(R.port, ['127.0.0.1:8088', '127.0.0.1:9090', '127.0.0.1:9090', '127.0.0.1:8088', '127.0.0.1:8089', '127.0.0.1:8089']);
});

test('tavan: düşük değer korunur, yüksek/boş/off/bozuk tavana iner', () => {
  assert.deepEqual(R.tavan, ['200', '150.50', '0', '200', '200', '200', '200', '200', '1500']);
});

test('yalnız yerel adreste çalışır', () => {
  assert.deepEqual(R.yerel, [true, true, true, true, false, false, false]);
});

test('demo kurulumunun planı: bütün güvenlik ayarları', () => {
  const plan = Object.fromEntries(R.planDemo.map((d) => [d.ad, [d.eski, d.yeni]]));
  assert.deepEqual(plan, {
    ENABLE_DATA_RESET: ['true', 'false'],
    DEMO_TOUR: ['on', 'off'],
    SIGNUP_MODE: ['', 'invite'],
    GATEWAY_PORT: ['8088', '127.0.0.1:8088'],
    SITE_PORT: ['8089', '127.0.0.1:8089'],
    AI_DAILY_BUDGET_TRY: [null, '200'],
    AI_FREE_CREDIT_MONTHLY_TRY: [null, '1500'],
    SOD_EMAIL_VERIFICATION: ['false', 'true'],
    AI_QUOTA_ENFORCED: ['off', 'true'],
    SOD_GERCEK_KULLANIM: [null, '2026-11-17'],
  });
  // Var olan satır yerinde değişir, yorumlar kalır; yeni satırlar sona başlıkla eklenir; LF korunur.
  assert.equal(
    R.metinDemo,
    [
      '# SellerOnData',
      'APP_BASE_URL=http://localhost:8088',
      'ENABLE_DATA_RESET=false',
      '# Örnek veriyle deneme turu',
      'DEMO_TOUR=off',
      'SIGNUP_MODE=invite',
      'GATEWAY_PORT=127.0.0.1:8088',
      'SITE_PORT=127.0.0.1:8089',
      '# AI_DAILY_BUDGET_TRY=1000',
      'SOD_EMAIL_VERIFICATION=true',
      'AI_QUOTA_ENFORCED=true',
      '',
      '# Gerçek kullanım (deneme)',
      'AI_DAILY_BUDGET_TRY=200',
      'AI_FREE_CREDIT_MONTHLY_TRY=1500',
      'SOD_GERCEK_KULLANIM=2026-11-17',
      '',
    ].join('\n'),
  );
  assert.deepEqual(R.planIkinci, [], 'ikinci çalıştırmada değişiklik yok');
});

test('sıkı ayarlı .env: düşük tavan korunur, olmayan bayrak eklenmez, CRLF korunur', () => {
  assert.deepEqual(
    R.planSiki.map((d) => d.ad),
    ['DEMO_TOUR', 'SIGNUP_MODE', 'AI_FREE_CREDIT_MONTHLY_TRY', 'SOD_GERCEK_KULLANIM'],
  );
  assert.ok(R.metinSiki.includes('AI_DAILY_BUDGET_TRY=50\r\n'));
  // Compose dışı ad (EMAIL_VERIFICATION_REQUIRED) compose'da etkisizdir; dokunulmaz.
  assert.ok(R.metinSiki.includes('EMAIL_VERIFICATION_REQUIRED=false\r\n'));
  assert.ok(R.metinSiki.endsWith('SOD_GERCEK_KULLANIM=2026-11-17\r\n'));
  assert.ok(!/[^\r]\n/.test(R.metinSiki), 'yalnız CRLF');
});

test('tekrarlanan satır tekilleşir, yorum kalır; boş metne eklenir', () => {
  assert.equal(R.tekrar, 'DEMO_TOUR=off\n# DEMO_TOUR=on\nX=1\n');
  assert.equal(R.bos, '# B\nA=1\n');
});

test('port bağlantısı: yalnız 127.0.0.1 geçer, boş HostIp bütün arayüzlerdir', () => {
  assert.deepEqual(R.bag, [true, false, false, false, '0.0.0.0']);
});

test('kap ortamı ve veritabanı durumu ayrıştırılır', () => {
  assert.deepEqual(R.kapOrtam, { A: '1', B: 'x=y', C: '' });
  assert.deepEqual(R.veri, { demoKisi: 8, demoFirma: 2, diger: 3, firmalar: ['GiftUpStore/3/0/0', 'Ad | çizgili/1/2/5'] });
});

test('kap ayarı denetimi', () => {
  assert.ok(R.denIyi.every((s) => s.startsWith('tamam|')), R.denIyi.join('\n'));
  assert.equal(R.denIyi.length, 7);
  const hatalar = R.denDemo.filter((s) => s.startsWith('HATA|'));
  assert.equal(hatalar.length, 7, R.denDemo.join('\n'));
  assert.ok(R.denDemo.some((s) => s.startsWith('uyarı|Kayıt tamamen kapalı')));
  assert.deepEqual(R.denYok, ['HATA|DeciShip API', 'HATA|Hesap servisi']);
  // off (tavan yok) ve 0 TL hak; büyük harfli invite servisin okuduğu gibi kabul.
  const off = Object.fromEntries(R.denOff.map((s) => s.split('|').reverse()));
  assert.equal(off['Günlük yapay zekâ tavanı ≤ 200 TL'], 'HATA');
  assert.equal(off['Aylık yapay zekâ hakkı ≤ 1500 TL'], 'tamam');
  assert.equal(off['Yeni firma kaydı yalnız davetle'], 'tamam');
  assert.equal(off['E-posta doğrulaması açık'], 'tamam');
});

test('yedek sonucu: sorun kısmı okunur, yerel yedek yalnız bu çalıştırmadan ve klasörüyle tamam sayılır', () => {
  assert.deepEqual(R.sorun, [null, 'parola yok; önceki yedeğe göre ani düşüş: satır 900 -> 40', null]);
  // 0 ve 2 tamam; çıkış 1, künye kodu 1, künye yok, klasör yok, eski künye tamam değil.
  assert.deepEqual(R.yedekTamam, [true, true, false, false, false, false, false]);
});

test('betik UTF-8 BOM ve CRLF', () => {
  const b = readFileSync(BETIK);
  assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(!/[^\r]\n/.test(b.toString('utf8')), 'yalnız CRLF');
});
