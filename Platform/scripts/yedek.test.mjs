// node --test scripts/yedek.test.mjs  (Platform klasöründen; Docker ve veritabanı istemez)
// Yedek betiklerinin Docker'sız mantığı (scripts/yedek-ortak.ps1): yedek adları, saklama seçimi, ayar dosyası yazımı,
// prova güvenlik denetimi, sayım karşılaştırması ve şifreli kopyanın açılıp bozulmanın yakalanması.
// Windows'ta powershell.exe (5.1), başka sistemde pwsh (7) ile koşar; ikisi de yoksa test kalır.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORTAK = path.join(HERE, 'yedek-ortak.ps1');
const PS = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
let dir;
let R;

// Tek PowerShell çalıştırması: her durumun sonucu JSON olarak döner (her çağrı ~1 sn sürdüğü için toplu).
const SCRIPT = String.raw`
param([string]$Ortak, [string]$Dir)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. $Ortak
function Hatasi([scriptblock]$b) { try { & $b; return $null } catch { return $_.Exception.Message } }
$o = [ordered]@{}
$LF = [string][char]10
$TAB = [string][char]9

$o.ad = @(
  (ConvertFrom-YedekAdi '2026-11-16_0300').Zaman.ToString('s'),
  (ConvertFrom-YedekAdi '2026-11-16_0300-2').Ek,
  [bool](ConvertFrom-YedekAdi 'gunluk'),
  [bool](ConvertFrom-YedekAdi '2026-11-16_0300.yaziliyor'),
  [bool](ConvertFrom-YedekAdi '2026-13-40_9999'),
  [bool](ConvertFrom-YedekAdi '_prova')
)
$o.yeniAd = @(
  (New-YedekAdi ([datetime]'2026-11-16T03:00:30') @()),
  (New-YedekAdi ([datetime]'2026-11-16T03:00:30') @('2026-11-16_0300')),
  (New-YedekAdi ([datetime]'2026-11-16T03:00:30') @('2026-11-16_0300', '2026-11-16_0300-2'))
)
$o.disari = @(
  (Get-DisariDosyaAdi '2026-11-16_0300'),
  (Get-DisariYedekAdi 'sellerondata-yedek-2026-11-16_0300.sodyedek'),
  (Get-DisariYedekAdi 'sellerondata-yedek-2026-11-16_0300.sodyedek.tmp'),
  (Get-DisariYedekAdi 'baska-2026-11-16_0300.sodyedek'),
  (Get-DisariYedekAdi 'sellerondata-yedek-bozuk.sodyedek')
)

# Saklama: 2025-08..2026-09 her ay bir yedek, 2026-10-01..2026-11-16 her gece, iki de ilgisiz klasör.
$adlar = @('gunluk', '_prova', '2026-11-16_0300.yaziliyor')
$ay = [datetime]'2025-08-01'
while ($ay -lt [datetime]'2026-10-01') { $adlar += $ay.AddMonths(1).AddDays(-1).ToString('yyyy-MM-dd') + '_0300'; $ay = $ay.AddMonths(1) }
$g = [datetime]'2026-10-01'
while ($g -le [datetime]'2026-11-16') { $adlar += $g.ToString('yyyy-MM-dd') + '_0300'; $g = $g.AddDays(1) }
$adlar += '2026-11-16_1200'
$sec = @(Select-YedekBudama -Adlar $adlar -Simdi ([datetime]'2026-11-16T13:00:00'))
$o.budama = [ordered]@{
  toplam = $sec.Count
  sakla = @($sec | Where-Object Sakla | ForEach-Object Ad)
  sil = @($sec | Where-Object { -not $_.Sakla } | ForEach-Object Ad)
  neden = [ordered]@{}
}
foreach ($s in $sec) { $o.budama.neden[$s.Ad] = $s.Neden }
# Yedek aylarca durmuşsa son yedekler silinmez.
$o.durmus = @(Select-YedekBudama -Adlar @('2026-01-01_0300', '2026-01-02_0300', '2026-01-03_0300') -Simdi ([datetime]'2026-11-16') | ForEach-Object Sakla)
# Aynı dakikadaki ikinci yedek daha yeni sayılır.
$o.sira = @(Select-YedekBudama -Adlar @('2026-11-16_0300', '2026-11-16_0300-2') -Simdi ([datetime]'2026-11-20') -SonSayi 1 -Gun 0 -Ay 0 | ForEach-Object { "$($_.Ad)=$($_.Sakla)" })

$metin = (@('# yorum', 'A=1', 'B=eski', '# B=yorumdaki', 'B=tekrar', 'C=') -join $LF) + $LF
$o.env = Set-EnvMetni $metin ([ordered]@{ B = 'yeni'; C = 'dolu'; D = 'eklendi' })
$o.envBos = Set-EnvMetni '' ([ordered]@{ X = 'y' })
$envDosya = Join-Path $Dir 'deneme.env'
[IO.File]::WriteAllText($envDosya, ('SOD_DENEME_AYAR=dosyadan' + $LF + 'SOD_DENEME_BOS=' + $LF), (New-Object Text.UTF8Encoding $false))
$o.ayar = @(
  (Get-AyarDegeri 'SOD_DENEME_AYAR' 'varsayilan' $envDosya),
  (Get-AyarDegeri 'SOD_DENEME_BOS' 'varsayilan' $envDosya),
  (Get-AyarDegeri 'SOD_DENEME_YOK' 'varsayilan' $envDosya)
)
$env:SOD_DENEME_AYAR = 'ortamdan'
$o.ayar += (Get-AyarDegeri 'SOD_DENEME_AYAR' 'varsayilan' $envDosya)

$p = Get-ProvaAyarlari 'C:\prova\keys'
$o.prova = [ordered]@{
  proje = $script:ProvaProje
  pg = $p.SOD_PGDATA_VOLUME; dosya = $p.SOD_STORAGE_VOLUME; keys = $p.SOD_KEYS_DIR
  smtp = $p.SMTP_URL; ai = $p.ANTHROPIC_API_KEY; reset = $p.ENABLE_DATA_RESET
  portlar = @($p.SOD_POSTGRES_PORT, $p.ACCOUNT_API_PORT, $p.VISION_PORT, $p.GATEWAY_PORT, $p.SITE_PORT)
  uygulandi = (Set-EnvMetni ((@('SOD_PGDATA_VOLUME=sod_pgdata', 'SMTP_URL=smtp://gercek', 'SOD_POSTGRES_PASSWORD=gizli') -join $LF) + $LF) $p)
  guvenli = (Hatasi { Assert-ProvaGuvenli $script:ProvaProje $p.SOD_PGDATA_VOLUME $p.SOD_STORAGE_VOLUME 'sellerondata' @('sod_pgdata', 'sod_deciship_storage') })
  ayniProje = (Hatasi { Assert-ProvaGuvenli 'sellerondata' 'sod_prova_pgdata' 'sod_prova_storage' 'sellerondata' @('sod_pgdata') })
  canliHacim = (Hatasi { Assert-ProvaGuvenli 'sellerondata-prova' 'sod_pgdata' 'sod_prova_storage' 'sellerondata' @('sod_pgdata') })
  onekYok = (Hatasi { Assert-ProvaGuvenli 'sellerondata-prova' 'sod_prova_pgdata' 'baska_storage' 'sellerondata' @('sod_pgdata') })
  canliOnekli = (Hatasi { Assert-ProvaGuvenli 'sellerondata-prova' 'sod_prova_pgdata' 'sod_prova_x' 'sellerondata' @('sod_prova_x') })
}

$say = ConvertFrom-SayimCiktisi @(('platform."Person"' + $TAB + '8'), ('deciship._prisma_migrations' + $TAB + '41'), 'gurultu satiri', ('deciship."Invoice"' + $TAB + '0'))
$o.sayim = [ordered]@{
  tablolar = @($say.Keys)
  person = $say['platform."Person"']
  ayni = (Compare-Sayimlar $say $say).Count
  fark = (Compare-Sayimlar $say ([ordered]@{ 'platform."Person"' = 7; 'deciship._prisma_migrations' = 41; 'deciship."Fazla"' = 1 }))
  dosya = ConvertFrom-DosyaSayimi @('DOSYA 12', 'BAYT 3456789')
}

$pw = New-YedekParolasi
$o.parola = [ordered]@{ desen = ($pw -match '^[a-z2-9]{5}(-[a-z2-9]{5}){5}$'); farkli = ($pw -ne (New-YedekParolasi)) }

# Şifreleme: 3 MB (birden çok tampon) rastgele veri, düşük tur sayısıyla (yalnız hız için; başlıkta saklanır).
$kaynak = Join-Path $Dir 'duz.bin'; $sifreli = Join-Path $Dir 'k.sodyedek'; $cozulen = Join-Path $Dir 'cozulen.bin'
$veri = New-Object byte[] (3 * 1024 * 1024 + 17)
(New-Object Random 7).NextBytes($veri)
[IO.File]::WriteAllBytes($kaynak, $veri)
$parola = 'dogru-parola-12345'
Protect-YedekDosyasi $kaynak $sifreli $parola 1000
$sb = [IO.File]::ReadAllBytes($sifreli)
Unprotect-YedekDosyasi $sifreli $cozulen $parola
$c = [IO.File]::ReadAllBytes($cozulen)
$ayniMi = ($c.Length -eq $veri.Length) -and ([Convert]::ToBase64String($c) -eq [Convert]::ToBase64String($veri))
$bozuk = Join-Path $Dir 'bozuk.sodyedek'
$b2 = [byte[]]$sb.Clone(); $b2[100000] = $b2[100000] -bxor 1; [IO.File]::WriteAllBytes($bozuk, $b2)
$kisa = Join-Path $Dir 'kisa.sodyedek'; [IO.File]::WriteAllBytes($kisa, $sb[0..($sb.Length - 40)])
$basBozuk = Join-Path $Dir 'bas.sodyedek'; $b3 = [byte[]]$sb.Clone(); $b3[9] = $b3[9] -bxor 1; [IO.File]::WriteAllBytes($basBozuk, $b3)
$cozBozuk = Join-Path $Dir 'cozulmemeli.bin'
$o.sifre = [ordered]@{
  buyu = [Text.Encoding]::ASCII.GetString($sb, 0, 8)
  tur = [BitConverter]::ToInt32($sb, 8)
  boy = $sb.Length
  duzBoy = $veri.Length
  icerikDuzMetinDegil = -not ([Convert]::ToBase64String($sb).Contains([Convert]::ToBase64String($veri[0..47])))
  ayni = $ayniMi
  yalnizDogrula = (Hatasi { Unprotect-YedekDosyasi $sifreli $null $parola })
  yanlisParola = (Hatasi { Unprotect-YedekDosyasi $sifreli $cozBozuk 'yanlis-parola-12345' })
  bozukBayt = (Hatasi { Unprotect-YedekDosyasi $bozuk $cozBozuk $parola })
  kisalmis = (Hatasi { Unprotect-YedekDosyasi $kisa $cozBozuk $parola })
  baslikBozuk = (Hatasi { Unprotect-YedekDosyasi $basBozuk $cozBozuk $parola })
  yabanci = (Hatasi { Unprotect-YedekDosyasi $kaynak $cozBozuk $parola })
  kisaParola = (Hatasi { Protect-YedekDosyasi $kaynak (Join-Path $Dir 'x.sodyedek') 'kisa' 1000 })
  bozuktaCiktiYok = -not (Test-Path -LiteralPath $cozBozuk)
}
# Aynı adlı işlev programın önüne geçmez (geri-yukle.ps1'deki "Docker" işlevi kendini sonsuz çağırıyordu).
function Node([string[]]$a) { Invoke-Arac node $a }
$n = Node @('-e', 'process.stdout.write(String(40+2))')
$o.arac = [ordered]@{ kod = $n.Kod; cikti = ($n.Satirlar -join ''); yok = (Invoke-Arac 'sod-boyle-bir-program-yok' @()).Kod }
# .env compose gibi okunur: tırnak, satır sonu yorumu, export, sonuncu kazanır.
$q = [string][char]34; $t1 = [string][char]39
$envDosya2 = Join-Path $Dir 'tirnak.env'
$satirlar2 = @(
  ('SOD_T_CIFT=' + $q + 'a b # yorum degil' + $q),
  ('SOD_T_TEK=' + $t1 + 'x#y' + $t1 + ' # yorum'),
  'SOD_T_YORUM=deger # yorum',
  'SOD_T_DIEZ=a#b',
  'export SOD_T_EXPORT=disari',
  'SOD_T_SON=ilk',
  'SOD_T_SON=ikinci',
  ('SOD_T_KACIS=' + $q + 'a\' + $q + 'b' + $q)
)
[IO.File]::WriteAllText($envDosya2, (($satirlar2 -join $LF) + $LF), (New-Object Text.UTF8Encoding $false))
$o.envOku = @('SOD_T_CIFT', 'SOD_T_TEK', 'SOD_T_YORUM', 'SOD_T_DIEZ', 'SOD_T_EXPORT', 'SOD_T_SON', 'SOD_T_KACIS') | ForEach-Object { Get-AyarDegeri $_ 'yok' $envDosya2 }

$o.saklamaAyari = @(
  (Hatasi { ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_LAST' '0' }),
  (Hatasi { ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_DAYS' 'on dort' }),
  (Hatasi { ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_DAYS' '-3' }),
  [string](ConvertTo-SaklamaSayisi 'SOD_BACKUP_KEEP_LAST' '3')
)
$o.hepsiSifir = @(Select-YedekBudama -Adlar @('2025-01-01_0300', '2025-01-02_0300') -Simdi ([datetime]'2026-11-16') -SonSayi 0 -Gun 0 -Ay 0 | ForEach-Object { "$($_.Ad)=$($_.Sakla)" })

$onceki = [pscustomobject]@{ ad = '2026-11-15_0300'; veritabani = [pscustomobject]@{ satir = 1000 }; dosyalar = [pscustomobject]@{ adet = 40 } }
$o.dusus = @(
  (Test-AniDusus $null 1 1),
  (Test-AniDusus $onceki 1000 40),
  (Test-AniDusus $onceki 500 20),
  (Test-AniDusus $onceki 499 40),
  (Test-AniDusus $onceki 1000 19),
  (Test-AniDusus ([pscustomobject]@{ ad = 'x'; veritabani = [pscustomobject]@{ satir = 0 }; dosyalar = [pscustomobject]@{ adet = 0 } }) 0 0)
)
$o.parolaKarari = @(
  (Get-ParolaKarari '' '' $true), (Get-ParolaKarari 'D:\y' 'abc' $true), (Get-ParolaKarari 'D:\y' '' $true), (Get-ParolaKarari 'D:\y' '' $false)
)
$simdi = [datetime]'2026-11-16T13:00:00'
function SonKayit($kod, $zaman) { [pscustomobject]@{ kod = $kod; zaman = $zaman } }
$o.yakinda = @(
  (Test-YakindaAlindi (SonKayit 0 ([datetime]'2026-11-16T03:00:00').ToString('o')) $simdi),
  (Test-YakindaAlindi (SonKayit 0 ([datetime]'2026-11-15T16:00:00').ToString('o')) $simdi),
  (Test-YakindaAlindi (SonKayit 2 ([datetime]'2026-11-16T03:00:00').ToString('o')) $simdi),
  (Test-YakindaAlindi (SonKayit 1 ([datetime]'2026-11-16T03:00:00').ToString('o')) $simdi),
  (Test-YakindaAlindi $null $simdi),
  (Test-YakindaAlindi (SonKayit 0 ([datetime]'2026-11-17T03:00:00').ToString('o')) $simdi),
  (Test-YakindaAlindi (SonKayit 0 'bozuk') $simdi)
)
$o.orphan = @(
  (ConvertFrom-OrphanOzeti @('MISSING a/b.pdf source=x id=1 kind=none', 'Done (nothing deleted): root=/data/storage scanned=10 orphans=0 orphanMB=0.0 missing=3 recentSkipped=0 links=4')),
  (ConvertFrom-OrphanOzeti @('Done (nothing deleted): root=/r scanned=0 orphans=0 orphanMB=0.0 missing=0 recentSkipped=0 links=0')),
  (ConvertFrom-OrphanOzeti @('hata'))
)
# Sırlar klasörü yalnız şimdiki kullanıcıya açık (Windows); başka sistemde işlev bir şey yapmaz.
$izin = Join-Path $Dir 'sirlar'
New-Item -ItemType Directory -Force $izin | Out-Null
Set-YalnizBen $izin
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
  $acl = Get-Acl -LiteralPath $izin
  $ben = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $o.izin = [ordered]@{
    kalitimKesik = $acl.AreAccessRulesProtected
    kimler = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
    ben = $ben
  }
} else { $o.izin = $null }

# Geri yüklemede kaba verilecek parola değişkenleri: elle liste yok, ayar dosyasından ve ortamdan desenle.
$envDosya3 = Join-Path $Dir 'roller.env'
[IO.File]::WriteAllText($envDosya3, ((@('SOD_POSTGRES_PASSWORD=su', 'SOD_PLATFORM_DB_PASSWORD=p', 'export SOD_ZETA_ADMIN_DB_PASSWORD=z',
  'SOD_ZETA_DB_PASSWORD=', '# SOD_YORUM_DB_PASSWORD=x', 'SOD_ENV=production', 'SOD_BACKUP_KEEP_LAST=3', 'SOD_kucuk_DB_PASSWORD=x') -join $LF) + $LF), (New-Object Text.UTF8Encoding $false))
[Environment]::SetEnvironmentVariable('SOD_ORTAM_DB_PASSWORD', 'o', 'Process')
$o.rolAdlari = @(Get-RolParolaAdlari $envDosya3)
[Environment]::SetEnvironmentVariable('SOD_ORTAM_DB_PASSWORD', $null, 'Process')

$o | ConvertTo-Json -Depth 8 -Compress
`;

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sod-yedek-test-'));
  const file = path.join(dir, 'calistir.ps1');
  writeFileSync(file, '\ufeff' + SCRIPT);
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ORTAK, dir], { encoding: 'utf8', timeout: 120000 });
  if (r.error) throw new Error(`${PS} çalıştırılamadı: ${r.error.message}`);
  assert.equal(r.status, 0, `PowerShell hata verdi:\n${r.stderr}\n${r.stdout}`);
  R = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('yedek adı: tarih-saat, aynı dakika eki; başka klasörler yedek sayılmaz', () => {
  assert.deepEqual(R.ad, ['2026-11-16T03:00:00', 2, false, false, false, false]);
  assert.deepEqual(R.yeniAd, ['2026-11-16_0300', '2026-11-16_0300-2', '2026-11-16_0300-3']);
});

test('dış kopya dosya adı gidip gelir; yarım (.tmp) ve yabancı dosya tanınmaz', () => {
  assert.deepEqual(R.disari, ['sellerondata-yedek-2026-11-16_0300.sodyedek', '2026-11-16_0300', null, null, null]);
});

test('saklama: son 14 yedek + son 14 gün + son 12 ayın her birinin son yedeği', () => {
  const b = R.budama;
  assert.equal(b.toplam, 14 + 47 + 1, 'ilgisiz klasörler listeye girmez');
  const silinmeli = ['2025-08-31_0300', '2025-09-30_0300', '2025-10-31_0300', '2025-11-30_0300', '2026-11-01_0300', '2026-11-02_0300'];
  for (let d = 1; d <= 30; d++) silinmeli.push(`2026-10-${String(d).padStart(2, '0')}_0300`);
  assert.deepEqual([...b.sil].sort(), silinmeli.sort());
  assert.ok(b.sakla.includes('2026-10-31_0300'), 'ekim ayının son yedeği kalır');
  assert.ok(b.sakla.includes('2025-12-31_0300'), '12. ay geriye kalır');
  assert.equal(b.neden['2026-11-16_1200'], 'son,gun,ay');
  assert.equal(b.neden['2026-11-04_0300'], 'son,gun');
  assert.equal(b.neden['2026-11-03_0300'], 'gun', 'son 14 yedeğin dışında ama 14 günden yeni');
  assert.equal(b.neden['2026-01-31_0300'], 'ay');
  assert.equal(b.sakla.length, 62 - silinmeli.length);
});

test('saklama: yedek durmuşsa son yedekler silinmez; aynı dakikadaki ek daha yenidir', () => {
  assert.deepEqual(R.durmus, [true, true, true]);
  assert.deepEqual(R.sira, ['2026-11-16_0300-2=True', '2026-11-16_0300=False']);
});

test('ayar dosyası: değer değişir, tekrar silinir, yorum kalır, eksik eklenir; ortam dosyayı ezer', () => {
  assert.equal(R.env, '# yorum\nA=1\nB=yeni\n# B=yorumdaki\nC=dolu\nD=eklendi\n');
  assert.equal(R.envBos, 'X=y\n');
  assert.deepEqual(R.ayar, ['dosyadan', 'varsayilan', 'varsayilan', 'ortamdan']);
});

test('prova: ayrı hacim ve portlar, posta ve yapay zekâ kapalı; canlıya dokunacak ayar reddedilir', () => {
  const p = R.prova;
  assert.equal(p.proje, 'sellerondata-prova');
  assert.equal(p.pg, 'sod_prova_pgdata');
  assert.equal(p.dosya, 'sod_prova_storage');
  assert.equal(p.keys, 'C:\\prova\\keys');
  assert.equal(p.smtp, '');
  assert.equal(p.ai, '');
  assert.equal(p.reset, 'false');
  assert.deepEqual(p.portlar, ['15444', '14110', '18011', '127.0.0.1:18098', '127.0.0.1:18099']);
  assert.match(p.uygulandi, /^SOD_PGDATA_VOLUME=sod_prova_pgdata$/m);
  assert.match(p.uygulandi, /^SMTP_URL=$/m);
  assert.match(p.uygulandi, /^SOD_POSTGRES_PASSWORD=gizli$/m, 'yedeğin veritabanı parolası korunur');
  assert.equal(p.guvenli, null);
  assert.match(p.ayniProje, /proje adı canlıyla aynı/);
  assert.match(p.canliHacim, /sod_prova_/);
  assert.match(p.onekYok, /sod_prova_/);
  assert.match(p.canliOnekli, /canlı hacimle aynı/);
});

test('sayım: tablo satırları okunur, farklar tek tek yazılır', () => {
  const s = R.sayim;
  assert.deepEqual(s.tablolar, ['platform."Person"', 'deciship._prisma_migrations', 'deciship."Invoice"']);
  assert.equal(s.person, 8);
  assert.equal(s.ayni, 0);
  assert.deepEqual(s.fark, [
    'platform."Person" 7 satır (beklenen 8)',
    'deciship."Invoice" yok (beklenen 0 satır)',
    'deciship."Fazla" fazla (1 satır)',
  ]);
  assert.deepEqual(s.dosya, { Dosya: 12, Bayt: 3456789 });
});

test('parola: elle yazılabilir 6x5 harf, her seferinde farklı', () => {
  assert.deepEqual(R.parola, { desen: true, farkli: true });
});

test('şifreli kopya: aynen açılır; yanlış parola, bozuk bayt, kısalmış ve yabancı dosya reddedilir', () => {
  const s = R.sifre;
  assert.equal(s.buyu, 'SODYEDK1');
  assert.equal(s.tur, 1000);
  const blok = Math.floor(s.duzBoy / 16) * 16 + 16;
  assert.equal(s.boy, 8 + 4 + 16 + 16 + blok + 32);
  assert.equal(s.icerikDuzMetinDegil, true);
  assert.equal(s.ayni, true);
  assert.equal(s.yalnizDogrula, null);
  assert.match(s.yanlisParola, /Parola yanlış ya da şifreli yedek bozuk/);
  assert.match(s.bozukBayt, /Parola yanlış ya da şifreli yedek bozuk/);
  assert.match(s.kisalmis, /Parola yanlış ya da şifreli yedek bozuk/);
  assert.match(s.baslikBozuk, /bozuk|geçersiz/);
  assert.match(s.yabanci, /SellerOnData şifreli yedeği değil/);
  assert.match(s.kisaParola, /en az 12 karakter/);
  assert.equal(s.bozuktaCiktiYok, true, 'doğrulama tutmazsa çözülmüş dosya hiç yazılmaz');
});

test('yerel komut: aynı adlı PowerShell işlevi araya girmez, olmayan program 127 döner', () => {
  assert.deepEqual(R.arac, { kod: 0, cikti: '42', yok: 127 });
});

test('.env docker compose gibi okunur: tırnak, satır sonu yorumu, export, sonuncu kazanır', () => {
  assert.deepEqual(R.envOku, ['a b # yorum degil', 'x#y', 'deger', 'a#b', 'disari', 'ikinci', 'a"b']);
});

test('saklama ayarı 1 ya da büyük tam sayı olmalı; ayar ne olursa olsun en yeni yedek kalır', () => {
  assert.match(R.saklamaAyari[0], /SOD_BACKUP_KEEP_LAST geçersiz \('0'\)/);
  assert.match(R.saklamaAyari[1], /geçersiz/);
  assert.match(R.saklamaAyari[2], /geçersiz/);
  assert.equal(R.saklamaAyari[3], '3');
  assert.deepEqual(R.hepsiSifir, ['2025-01-02_0300=True', '2025-01-01_0300=False']);
});

test('ani düşüş: satır ya da dosya önceki yedeğin yarısının altına inerse uyarı', () => {
  const [yok, ayni, yarisi, satirDustu, dosyaDustu, oncekiBos] = R.dusus;
  assert.equal(yok, null, 'önceki künye yoksa denetim yok');
  assert.equal(ayni, null);
  assert.equal(yarisi, null, 'tam yarısı sınırda: uyarı yok');
  assert.match(satirDustu, /2026-11-15_0300.*satır 1000 -> 499/);
  assert.match(dosyaDustu, /dosya 40 -> 19/);
  assert.equal(oncekiBos, null);
});

test('parola: gece görevinde görünmeden üretilmez, elle çalıştırmada üretilir', () => {
  assert.deepEqual(R.parolaKarari, ['gerekmez', 'var', 'elle', 'uret']);
});

test('gün içi yeniden deneme: son 20 saatte başarılı yedek varsa ikinci tetikleme atlanır', () => {
  assert.deepEqual(R.yakinda, [true, false, false, false, false, false, false]);
});

test('storage:orphans özetinden MISSING sayısı okunur', () => {
  assert.deepEqual(R.orphan, [3, 0, null]);
});

test('sırlar klasörü yalnız şimdiki kullanıcıya açık (Windows; başka sistemde işlev bir şey yapmaz)', () => {
  if (process.platform !== 'win32') { assert.equal(R.izin, null); return; }
  assert.equal(R.izin.kalitimKesik, true);
  assert.deepEqual(R.izin.kimler, [R.izin.ben]);
});

test('kap betiği bash ile, hata ve boru hattı hatasında durur; şema listesi dökümden okunur', () => {
  const sh = readFileSync(path.join(HERE, 'yedek-kap.sh'), 'utf8');
  assert.match(sh, /^#!\/usr\/bin\/env bash\n/);
  assert.match(sh, /^set -euo pipefail$/m);
  assert.doesNotMatch(sh, /DROP SCHEMA IF EXISTS platform/, 'şema adı sabit yazılmamalı');
  assert.match(sh, /\$4 == "SCHEMA"/);
  for (const f of ['yedekle.ps1', 'geri-yukle.ps1']) {
    const ps = readFileSync(path.join(HERE, f), 'utf8');
    assert.doesNotMatch(ps, /'sh', \$kapBetik|--entrypoint', 'sh'/, `${f} kap betiğini bash ile çağırmalı`);
    assert.doesNotMatch(ps, /^function Docker\b/im, `${f}: "Docker" adlı işlev programı gölgeler`);
  }
});

test('kap betiği LF satır sonlu, yedek betikleri UTF-8 BOM ile başlar', () => {
  assert.ok(!readFileSync(path.join(HERE, 'yedek-kap.sh')).includes(13), 'yedek-kap.sh CR içermemeli');
  for (const f of ['yedekle.ps1', 'geri-yukle.ps1', 'yedek-zamanla.ps1', 'yedek-ortak.ps1']) {
    const b = readFileSync(path.join(HERE, f));
    assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${f} BOM ile başlamalı`);
  }
});

test('geri yükleme parola değişkenleri ayar dosyasından ve ortamdan desenle okunur (elle liste yok)', () => {
  assert.deepEqual(R.rolAdlari, ['SOD_ENV', 'SOD_ORTAM_DB_PASSWORD', 'SOD_PLATFORM_DB_PASSWORD', 'SOD_POSTGRES_PASSWORD', 'SOD_ZETA_ADMIN_DB_PASSWORD', 'SOD_ZETA_DB_PASSWORD']);
  const geri = readFileSync(path.join(HERE, 'geri-yukle.ps1'), 'utf8');
  assert.doesNotMatch(geri, /SOD_DECISHIP_ADMIN_DB_PASSWORD|SOD_PLATFORM_DB_PASSWORD/, 'geri-yukle.ps1 rol adlarını elle yazmamalı');
  assert.match(geri, /Get-RolParolaAdlari/);
});

test('kap betiği rol parolalarını komut satırından değil ortamdan okur; üretimde eksik ya da _dev parola reddedilir', () => {
  const sh = readFileSync(path.join(HERE, 'yedek-kap.sh'), 'utf8');
  const blok = sh.slice(sh.indexOf('  rol-parola)'), sh.indexOf('  tar-al)'));
  assert.doesNotMatch(blok, /-v "?p\$i=|-v su=/, 'parola -v ile komut satırına gitmemeli');
  assert.match(blok, /\getenv/);
  assert.match(blok, /SOD_ENV/);
  assert.match(blok, /_dev/);
});
