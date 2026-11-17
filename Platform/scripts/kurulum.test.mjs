// node --test scripts/kurulum.test.mjs  (Platform klasöründen; Docker, ağ ve sunucu istemez)
// Sunucuda ilk kurulum (scripts/kurulum.sh): .env üretimi ve denetimi, ilk açılış (guncelle.sh --ilk-kurulum), sahibin kayıt
// daveti, sahip denetimi, kalıcı silmenin açılışı. docker ve curl taklit (scripts/test-fixtures/sunucu); openssl gerçek (Git Bash).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findBash, runScript, setupRoot, workTree } from './test-fixtures/sunucu/ortam.mjs';

let env;
let n = 0;

before(() => {
  assert.ok(findBash(), 'bash bulunamadı (Windows: Git for Windows kurulu olmalı; SOD_BASH ile yol verilebilir)');
  env = setupRoot('kurulum-');
});
after(() => env?.cleanup());

const APP = 'https://app.ornek.test';
const CURL_OK = [`${APP}/healthz 200`, `${APP}/api/account/health 200`, `${APP}/api/deciship/health 200`, 'https://ornek.test/ 200'];
const FLAGS = [
  '--app-host',
  'app.ornek.test',
  '--site-host',
  'ornek.test',
  '--acme-email',
  'ops@ornek.test',
  '--smtp-url',
  'smtp://u:pa$$w0rd@smtp.ornek.test:587',
];
const SECRETS = [
  'SOD_POSTGRES_PASSWORD',
  'SOD_PLATFORM_ADMIN_DB_PASSWORD',
  'SOD_DECISHIP_ADMIN_DB_PASSWORD',
  'SOD_PLATFORM_DB_PASSWORD',
  'SOD_DECISHIP_DB_PASSWORD',
  'ACCOUNT_CODE_PEPPER',
  'FILE_TOKEN_SECRET',
  'PRODUCT_NOTIFY_SECRET',
];

function kur({ envText, psql } = {}) {
  const wt = workTree(env, `w${++n}`);
  if (envText !== undefined) writeFileSync(path.join(wt.platform, '.env'), envText);
  writeFileSync(path.join(wt.fake, 'volumes'), '');
  writeFileSync(path.join(wt.fake, 'running'), '');
  writeFileSync(path.join(wt.fake, 'curl.txt'), CURL_OK.join('\n') + '\n');
  writeFileSync(path.join(wt.fake, 'docker-ps.txt'), 'postgres|running|Up 1 minute (healthy)\n');
  if (psql) writeFileSync(path.join(wt.fake, 'psql-stdin.txt'), psql.join('\n') + '\n');
  return wt;
}

async function kurulum(wt, args, input) {
  const r = await runScript(
    env,
    wt,
    'kurulum.sh',
    args,
    { SOD_UPDATE_HEALTH_WAIT: '0', SOD_UPDATE_HEALTH_TRIES: '1', SOD_DISK_PATHS: '/yok-boyle-bir-yol' },
    input,
  );
  const f = path.join(wt.fake, 'calls.log');
  r.calls = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  return r;
}

const envOf = (wt) => readFileSync(path.join(wt.platform, '.env'), 'utf8');
/** .env satırları → { AD: ham değer } (tırnaklar soyulur; sonuncu geçerli, compose gibi). */
function parse(text) {
  const o = {};
  for (const l of text.split('\n')) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].replace(/^'(.*)'$/, '$1');
  }
  return o;
}

const VALID_ENV = `SOD_ENV=production
APP_HOST=app.ornek.test
SITE_HOST=ornek.test
ACME_EMAIL=ops@ornek.test
APP_BASE_URL=${APP}
SITE_BASE_URL=https://ornek.test
`;

describe('kurulum.sh', { concurrency: 4 }, () => {
  test('ac: .env güçlü rastgele değerlerle üretilir, denetlenir; ilk açılış, org-announce ve sahibin daveti', async () => {
    const wt = kur();
    const r = await kurulum(wt, ['ac', ...FLAGS, '--sahip-eposta', 'sahip@ornek.test']);
    assert.equal(r.code, 0, r.out);
    const text = envOf(wt);
    const e = parse(text);
    assert.equal(e.SOD_ENV, 'production');
    assert.equal(e.APP_BASE_URL, APP);
    assert.equal(e.ALLOWED_ORIGINS, APP);
    assert.equal(e.SITE_BASE_URL, 'https://ornek.test');
    assert.equal(e.SITE_ORIGINS, 'https://ornek.test,https://www.ornek.test');
    assert.equal(e.COOKIE_LANG_DOMAIN, '.ornek.test');
    assert.equal(e.SIGNUP_MODE, 'invite');
    assert.equal(e.ENABLE_DATA_RESET, 'false');
    assert.equal(e.DEMO_TOUR, 'off');
    assert.equal(e.AI_DAILY_BUDGET_TRY, '200');
    assert.equal(e.MAIL_FROM, 'SellerOnData <no-reply@ornek.test>');
    // SMTP parolasındaki $ compose'da değişken sanılmasın: tek tırnak.
    assert.match(text, /^SMTP_URL='smtp:\/\/u:pa\$\$w0rd@smtp\.ornek\.test:587'$/m);
    assert.ok(!/^DELETED_INVOICE_PURGE_DAYS=/m.test(text), 'kalıcı silme kendiliğinden açılmamalı');
    const values = SECRETS.map((k) => e[k]);
    for (const [i, v] of values.entries()) assert.match(v, /^[0-9a-f]{64}$/, SECRETS[i]);
    assert.equal(new Set(values).size, values.length, 'gizli değerler birbirinden farklı olmalı');
    // İmza anahtarı geçerli Ed25519 özel JWK: x, d'den türeyen açık anahtar; imza doğrulanır.
    const jwk = JSON.parse(e.ACCOUNT_SIGNING_KEY);
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.alg, 'EdDSA');
    assert.match(jwk.kid, /^sod-\d{4}-\d\d-\d\d-[0-9a-f]{8}$/);
    const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    assert.equal(crypto.createPublicKey(priv).export({ format: 'jwk' }).x, jwk.x);
    const sig = crypto.sign(null, Buffer.from('deneme'), priv);
    assert.ok(crypto.verify(null, Buffer.from('deneme'), crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }), sig));

    assert.match(r.out, /İlk kurulum: veritabanı hacmi \(sod_pgdata\) yok, yedek atlandı/);
    assert.equal(r.calls.filter((l) => / up -d --wait /.test(l)).length, 1);
    assert.equal(r.calls.filter((l) => /org-announce\.js/.test(l)).length, 1);
    assert.ok(
      r.calls.some((l) => /signup-invite\.js --email sahip@ornek\.test --operator kurulum --lang tr/.test(l)),
      r.calls.join('\n'),
    );
    assert.match(r.out, /https:\/\/app\.ornek\.test\/register\?invite=sahte-jeton/);
    assert.match(r.out, /kurulum\.sh dogrula --sahip-eposta sahip@ornek\.test/);

    // Yeniden çalıştırma: var olan değerlere dokunulmaz.
    const r2 = await kurulum(wt, ['ac']);
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /\.env tam; değişmedi/);
    assert.equal(envOf(wt), text);
    // Verilen seçenek var olanla çelişirse durur, .env değişmez.
    const r3 = await kurulum(wt, ['ac', '--app-host', 'baska.ornek.test']);
    assert.equal(r3.code, 2, r3.out);
    assert.match(r3.out, /çelişiyor: APP_HOST/);
    assert.equal(envOf(wt), text);
  });

  test('ac -n: hiçbir dosya yazılmaz, yazılacak ayarlar ve denetim gösterilir; eksik seçenek ve geçersiz değer çıkış 2', async () => {
    const wt = kur();
    const r = await kurulum(wt, ['ac', '-n', ...FLAGS]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Yazılacak \(\S+\.env\): SOD_ENV APP_HOST/);
    assert.match(r.out, /ACCOUNT_SIGNING_KEY/);
    assert.match(r.out, /Ayarlar tamam/);
    assert.match(r.out, /Kuru çalışma: hiçbir şey değişmedi/);
    assert.ok(!existsSync(path.join(wt.platform, '.env')));
    assert.deepEqual(
      r.calls.filter((l) => !/^compose version/.test(l)),
      [],
    );

    let x = await kurulum(kur(), ['ac', ...FLAGS.slice(0, 6)]);
    assert.equal(x.code, 2);
    assert.match(x.stderr, /eksik seçenek: --smtp-url/);
    x = await kurulum(kur(), ['ac', ...FLAGS.slice(2), '--app-host', 'App_Ornek']);
    assert.equal(x.code, 2);
    assert.match(x.stderr, /geçersiz alan adı: App_Ornek/);
    x = await kurulum(kur(), ['ac', ...FLAGS, '--sahip-eposta', 'eposta-degil']);
    assert.equal(x.code, 2);
    assert.match(x.stderr, /geçersiz e-posta/);
    x = await kurulum(kur(), ['kur']);
    assert.equal(x.code, 2);
    assert.match(x.stderr, /bilinmeyen adım: kur/);
    const old = kur();
    writeFileSync(path.join(old.fake, 'compose-version'), '2.20.3\n');
    x = await kurulum(old, ['ac', ...FLAGS]);
    assert.equal(x.code, 2);
    assert.match(x.out, /docker compose 2\.20\.3 eski/);
  });

  test('ac: var olan .env üretime uygun değilse eksikler eklenir ama açılış olmaz; çıkış 2', async () => {
    const wt = kur({
      envText: `${VALID_ENV}SMTP_URL=smtp://x@y:25\nENABLE_DATA_RESET=true\nSOD_POSTGRES_PASSWORD=sod_postgres_dev\nAPP_BASE_URL=http://app.ornek.test\nSIGNUP_MODE=open\n`,
    });
    const r = await kurulum(wt, ['ac']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /HATA: SOD_POSTGRES_PASSWORD geliştirme parolası/);
    assert.match(r.out, /HATA: ENABLE_DATA_RESET=true üretimde servisi açmaz/);
    assert.match(r.out, /HATA: APP_BASE_URL https:\/\/ ile başlamalı/);
    assert.match(r.out, /UYARI: SIGNUP_MODE=open/);
    assert.equal(r.calls.filter((l) => / up |build/.test(l)).length, 0);
    const e = parse(envOf(wt));
    assert.equal(e.SOD_POSTGRES_PASSWORD, 'sod_postgres_dev', 'var olan değer korunur');
    assert.match(e.SOD_DECISHIP_DB_PASSWORD, /^[0-9a-f]{64}$/, 'eksik olan eklenir');
  });

  test('dogrula: kayıt yok, doğrulanmamış, sahip; adres psql değişkeniyle geçer', async () => {
    let wt = kur({ envText: VALID_ENV, psql: ['firma_sayisi|0'] });
    let r = await kurulum(wt, ['dogrula', '--sahip-eposta', 'sahip@ornek.test']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Sahip henüz kayıt olmadı/);
    assert.ok(
      r.calls.some((l) => /exec -T postgres psql .*-v e=sahip@ornek\.test -At/.test(l)),
      r.calls.join('\n'),
    );
    assert.ok(r.calls.some((l) => /signup-invite\.js --list --email sahip@ornek\.test/.test(l)));

    wt = kur({ envText: VALID_ENV, psql: ['kisi|sahip@ornek.test|false', 'firma|Örnek Lojistik|OWNER', 'firma_sayisi|1'] });
    r = await kurulum(wt, ['dogrula', '--sahip-eposta', 'sahip@ornek.test']);
    assert.equal(r.code, 1);
    assert.match(r.out, /e-postası henüz doğrulanmadı/);

    wt = kur({ envText: VALID_ENV, psql: ['kisi|sahip@ornek.test|true', 'firma|Örnek Lojistik|OWNER', 'firma_sayisi|1'] });
    r = await kurulum(wt, ['dogrula', '--sahip-eposta', 'sahip@ornek.test']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Tamam: sahip@ornek\.test doğrulandı, Örnek Lojistik firmasının sahibi/);

    r = await kurulum(kur({ envText: VALID_ENV }), ['davet']);
    assert.equal(r.code, 2);
    r = await kurulum(kur(), ['davet', '--sahip-eposta', 'a@b.test']);
    assert.equal(r.code, 2);
    assert.match(r.out, /ayar dosyası yok/);
  });

  test('kalici-silme: önce kuru çalışma; EVET ile .env 30, eski hâli saklanır, DeciShip API yeniden açılır ve kapta denetlenir', async () => {
    const dry = kur({ envText: VALID_ENV });
    let r = await kurulum(dry, ['kalici-silme', '-n']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Done \(nothing deleted\): companies=1 invoices=2/);
    assert.ok(r.calls.some((l) => /purgePreview\.js --invoice-days 30 --photo-days 30/.test(l)));
    assert.equal(envOf(dry), VALID_ENV);

    const no = kur({ envText: VALID_ENV });
    r = await kurulum(no, ['kalici-silme'], 'hayır\n');
    assert.equal(r.code, 1);
    assert.match(r.out, /Vazgeçildi; \.env değişmedi/);
    assert.equal(envOf(no), VALID_ENV);

    const yes = kur({ envText: `${VALID_ENV}DELETED_INVOICE_PURGE_DAYS=\nDELETED_INVOICE_PURGE_DAYS=off\n` });
    r = await kurulum(yes, ['kalici-silme'], 'EVET\n');
    assert.equal(r.code, 0, r.out);
    const text = envOf(yes);
    assert.equal(text.match(/^DELETED_INVOICE_PURGE_DAYS=/gm).length, 1, 'tekrar eden satır kalmamalı');
    assert.match(text, /^DELETED_INVOICE_PURGE_DAYS=30$/m);
    assert.match(text, /^DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=30$/m);
    assert.ok(text.startsWith(VALID_ENV), 'öteki satırlar korunur');
    const saved = readdirSync(path.join(yes.platform, 'yedekler', 'kurulum'));
    assert.equal(saved.length, 1);
    assert.ok(r.calls.some((l) => / up -d --wait --wait-timeout 600 deciship-api /.test(l)));
    assert.match(r.out, /Kalıcı silme açık: 30 gün/);

    r = await kurulum(yes, ['kalici-silme', '--evet']);
    assert.equal(r.code, 0);
    assert.match(r.out, /Zaten açık/);

    const fail = kur({ envText: VALID_ENV });
    writeFileSync(path.join(fail.fake, 'fail-preview'), '');
    r = await kurulum(fail, ['kalici-silme', '--evet']);
    assert.equal(r.code, 1);
    assert.match(r.out, /purge:preview çalışmadı/);
    assert.equal(envOf(fail), VALID_ENV);
  });
});
