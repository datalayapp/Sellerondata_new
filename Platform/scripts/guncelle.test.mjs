// node --test scripts/guncelle.test.mjs  (Platform klasöründen; Docker, ağ ve sunucu istemez)
// Sunucu güncellemesi (scripts/guncelle.sh): geçici git deposunda etiketli sürümler (v1 temel, v2 göçsüz, v3 göçlü, v4 araç
// kaydı değişir), docker ve curl yerine taklit komutlar (scripts/test-fixtures/sunucu). Sağlık denetimi gerçek ayakta-mi.sh.
// Windows'ta Git Bash ile, başka sistemde bash ile koşar.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findBash, git, runScript, setupRoot, workTree } from './test-fixtures/sunucu/ortam.mjs';

let env;
let n = 0;

before(() => {
  assert.ok(findBash(), 'bash bulunamadı (Windows: Git for Windows kurulu olmalı; SOD_BASH ile yol verilebilir)');
  env = setupRoot('guncelle-');
});
after(() => env?.cleanup());

const APP = 'https://app.ornek.test';
const SITE = 'https://ornek.test/';
const CURL_OK = [`${APP}/healthz 200`, `${APP}/api/account/health 200`, `${APP}/api/deciship/health 200`, `${SITE} 200`];
const PS_OK = ['postgres|running|Up 1 minute (healthy)', 'account-migrate|exited|Exited (0) 1 minute ago', 'deciship-api|running|Up 1 minute (healthy)'];

/** Çalışma kopyası + taklit durum. fail: { adım: [sürüm etiketleri] | true }. */
function kur({ at = 'v1', volumes = ['sod_pgdata', 'sod_deciship_storage'], fail = {}, curlBySha = {}, envText } = {}) {
  const wt = workTree(env, `w${++n}`, at);
  writeFileSync(path.join(wt.platform, '.env'), envText ?? `SOD_ENV=production\nAPP_BASE_URL=${APP}\nSITE_BASE_URL=https://ornek.test\n`);
  writeFileSync(path.join(wt.fake, 'volumes'), volumes.join('\n') + '\n');
  writeFileSync(path.join(wt.fake, 'running'), 'postgres\n');
  writeFileSync(path.join(wt.fake, 'curl.txt'), CURL_OK.join('\n') + '\n');
  writeFileSync(path.join(wt.fake, 'docker-ps.txt'), PS_OK.join('\n') + '\n');
  for (const [step, tags] of Object.entries(fail)) {
    writeFileSync(path.join(wt.fake, `fail-${step}`), tags === true ? '' : tags.map((t) => env.sha[t]).join('\n') + '\n');
  }
  for (const [tag, lines] of Object.entries(curlBySha)) writeFileSync(path.join(wt.fake, `curl-${env.sha[tag]}.txt`), lines.join('\n') + '\n');
  return wt;
}

async function guncelle(wt, args, extra = {}) {
  const r = await runScript(env, wt, 'guncelle.sh', args, {
    SOD_UPDATE_HEALTH_WAIT: '0',
    SOD_UPDATE_HEALTH_TRIES: '2',
    SOD_UPDATE_MIN_FREE_MB: '1',
    SOD_DISK_PATHS: '/yok-boyle-bir-yol',
    ...extra,
  });
  const callsFile = path.join(wt.fake, 'calls.log');
  r.calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [];
  return r;
}

const head = (wt) => git(wt.repo, 'rev-parse', '--short=7', 'HEAD');
const calls = (r, re) => r.calls.filter((l) => re.test(l));
const backupsOf = (wt) => {
  const d = path.join(wt.platform, 'yedekler', 'guncelle');
  return existsSync(d)
    ? readdirSync(d)
        .filter((x) => /^\d{4}-\d\d-\d\d_\d{4}/.test(x))
        .sort()
    : [];
};

// Senaryolar ayrı çalışma kopyalarında, paralel (Windows'ta her bash çağrısı yavaş).
describe('guncelle.sh', { concurrency: 4 }, () => {
  test('ileri güncelleme: önce doğrulanmış yedek, sonra sürüm, derleme, açılış, göç ve sağlık; çıkış 0', async () => {
    const wt = kur();
    const r = await guncelle(wt, ['v2']);
    assert.equal(r.code, 0, r.out);
    assert.equal(head(wt), env.sha.v2);
    assert.match(r.out, /Veritabanı göçü yok: sorun çıkarsa eski sürüm yeniden kurulur/);
    assert.match(r.out, /Güncelleme tamam: v2/);
    // Sıra: döküm ve dosya arşivi (eski sürümde) → derleme ve açılış (yeni sürümde) → sağlık (ayakta-mi docker ps).
    const order = r.calls.map((l) => l.replace(/^compose (?:(?:-p|--project-directory|--env-file|-f) \S+ )*/, ''));
    const iDump = order.findIndex((l) => /exec -T postgres pg_dump .*@/.test(l));
    const iTar = order.findIndex((l) => /^run --rm/.test(l));
    const iBuild = order.findIndex((l) => /^build @/.test(l));
    const iUp = order.findIndex((l) => /^up -d --wait --wait-timeout 600 --remove-orphans @/.test(l));
    assert.ok(iDump >= 0 && iDump < iTar && iTar < iBuild && iBuild < iUp, r.calls.join('\n'));
    assert.ok(order[iDump].endsWith(`@${env.sha.v1}`) && order[iBuild].endsWith(`@${env.sha.v2}`), r.calls.join('\n'));
    // Proje adı, iki compose dosyası ve .env compose'a verilir.
    assert.match(
      r.calls[iBuild],
      /^compose -p sellerondata --project-directory \S+ --env-file \S+\/Platform\/\.env -f \S+docker-compose\.yml -f \S+docker-compose\.prod\.yml build/,
    );
    assert.equal(calls(r, /org-announce|members-announce/).length, 0);

    const [b] = backupsOf(wt);
    assert.ok(b, 'yedek klasörü yok');
    const dir = path.join(wt.platform, 'yedekler', 'guncelle', b);
    for (const f of ['veritabani.dump', 'roller.sql', 'dosyalar.tar.gz', 'tablolar.tsv', 'sirlar/.env']) assert.ok(existsSync(path.join(dir, f)), f);
    const k = JSON.parse(readFileSync(path.join(dir, 'yedek.json'), 'utf8'));
    assert.equal(k.tur, 'guncelle-oncesi');
    assert.equal(k.commit, git(wt.repo, 'rev-parse', env.sha.v1));
    assert.equal(k.hedef, git(wt.repo, 'rev-parse', env.sha.v2));
    assert.equal(k.veritabani.tablolar['platform."Person"'], 2);
    assert.equal(k.veritabani.satir, 16);
    assert.equal(k.dosyalar.adet, 3);
    assert.equal(k.gocler.deciship, '20261116000000_son');
    assert.match(k.veritabani.sha256, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(path.join(dir, 'sirlar', '.env'), 'utf8'), readFileSync(path.join(wt.platform, '.env'), 'utf8'));
    assert.equal(readdirSync(path.join(wt.platform, 'yedekler', 'guncelle')).filter((x) => x.endsWith('.yaziliyor')).length, 0);
    // Kaba kopyalanan geçici dosyalar silinir.
    assert.equal(calls(r, /exec -T postgres rm -f \/tmp\/sod-guncelle\.dump/).length, 1);
    const log = readFileSync(path.join(wt.platform, 'yedekler', 'guncelle', 'gecmis.log'), 'utf8');
    assert.match(log, new RegExp(` tamam ${env.sha.v1} -> ${env.sha.v2} v2 yedek=`));
  });

  test('başlamadan durur (çıkış 2, kod ve kaplar değişmez): kirli çalışma ağacı, eski sürüm, ayrı dal, sürümsüz çağrı', async () => {
    const dirty = kur();
    writeFileSync(path.join(dirty.repo, 'README.md'), 'elle değişti\n');
    let r = await guncelle(dirty, ['v2']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /commit'lenmemiş değişiklik var/);
    assert.match(r.out, /M README\.md/);
    assert.equal(head(dirty), env.sha.v1);
    assert.equal(calls(r, /build|pg_dump|up /).length, 0);

    const back = kur({ at: 'v2' });
    r = await guncelle(back, ['v1']);
    assert.equal(r.code, 2);
    assert.match(r.out, /şimdiki sürümden .* eski; güncelleme yalnız ileri gider/);
    assert.equal(head(back), env.sha.v2);

    const side = kur();
    git(side.repo, 'checkout', '-q', '--detach', 'v1');
    writeFileSync(path.join(side.repo, 'yan.txt'), 'yan\n');
    git(side.repo, 'add', 'yan.txt');
    git(side.repo, 'commit', '-q', '-m', 'yan dal');
    const sideSha = head(side);
    r = await guncelle(side, ['v2']);
    assert.equal(r.code, 2);
    assert.match(r.out, /ayrı dal/);
    assert.equal(head(side), sideSha);

    r = await guncelle(kur(), []);
    assert.equal(r.code, 2);
    assert.match(r.err ?? r.stderr, /sürüm gerekli/);
    r = await guncelle(kur(), ['--uyelik-duyur', 'Deci$hip', 'v2']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /geçersiz ürün adı/);
    r = await guncelle(kur(), ['--bilinmez', 'v2']);
    assert.equal(r.code, 2);
    r = await guncelle(kur(), ['yok-boyle-surum']);
    assert.equal(r.code, 2);
    assert.match(r.out, /sürüm bulunamadı: yok-boyle-surum/);
  });

  test('--geri: göç farkı yoksa eski sürüme döner; aradaki sürümde göç varsa durur', async () => {
    const ok = kur({ at: 'v2' });
    let r = await guncelle(ok, ['--geri', 'v1']);
    assert.equal(r.code, 0, r.out);
    assert.equal(head(ok), env.sha.v1);
    assert.match(r.out, /GERİ, 1 commit/);

    const blocked = kur({ at: 'v4' });
    r = await guncelle(blocked, ['--geri', 'v2']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /eski sürüme dönülemez: aradaki veritabanı göçleri geri alınamaz/);
    assert.match(r.out, /Deciship\/apps\/api\/prisma\/migrations\/20261120000000_yeni\/migration\.sql/);
    assert.equal(head(blocked), env.sha.v4);
    assert.equal(calls(r, /pg_dump|build/).length, 0);
  });

  test('kuru çalışma (-n): plan ve göç farkı yazılır; yedek, checkout, derleme yok', async () => {
    const wt = kur();
    const r = await guncelle(wt, ['-n', 'v4']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Sürüm: \w+ → \w+ \(v4; 3 commit\)/);
    assert.match(r.out, /Veritabanı göçü var \(geri alınamaz/);
    assert.match(r.out, /UYARI: araç kaydı \(Platform\/packages\/contracts\/src\/products\.ts\) değişmiş: .*--uyelik-duyur/);
    assert.match(r.out, /Kuru çalışma: hiçbir şey değişmedi/);
    assert.equal(head(wt), env.sha.v1);
    assert.equal(calls(r, /pg_dump|build|up |run --rm|exec/).length, 0);
    assert.ok(!existsSync(path.join(wt.platform, 'yedekler')), 'kuru çalışma klasör açtı');
  });

  test('derleme bozulursa: kaplara dokunulmaz, kod ve imajlar eski sürüme döner; çıkış 1', async () => {
    const wt = kur({ fail: { build: ['v2'] } });
    const r = await guncelle(wt, ['v2']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /derleme başarısız; çalışan kaplara dokunulmadı/);
    assert.equal(head(wt), env.sha.v1);
    assert.deepEqual(
      calls(r, /^compose .* build @/).map((l) => l.split('@').pop()),
      [env.sha.v2, env.sha.v1],
    );
    assert.equal(calls(r, / up /).length, 0);
    assert.equal(backupsOf(wt).length, 1, 'yedek alınmış olmalı');
  });

  test('sağlık tutmazsa ve göç farkı yoksa eski sürüm yeniden kurulur; çıkış 1', async () => {
    const bad = [`${APP}/healthz 200`, `${APP}/api/account/health 200`, `${APP}/api/deciship/health 502`, `${SITE} 200`];
    const wt = kur({ curlBySha: { v2: bad } });
    const r = await guncelle(wt, ['v2']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /henüz değil \(1\/2\): SORUN sağlık \/api\/deciship\/health: yanıt 502/);
    assert.match(r.out, /Göç farkı yok: \w+ yeniden kuruluyor/);
    assert.match(r.out, /Eski sürüme dönüldü/);
    assert.equal(head(wt), env.sha.v1);
    assert.deepEqual(
      calls(r, /^compose .* (build|up -d --wait --wait-timeout 600 --remove-orphans) /).map((l) => `${l.match(/ (build|up) /)[1]}@${l.split('@').pop()}`),
      [`build@${env.sha.v2}`, `up@${env.sha.v2}`, `build@${env.sha.v1}`, `up@${env.sha.v1}`],
    );
    assert.match(readFileSync(path.join(wt.platform, 'yedekler', 'guncelle', 'gecmis.log'), 'utf8'), / geri-donuldu /);
  });

  test('göçlü sürüm açılmazsa betik açıkça durur, eski sürüme dönmez; çıkış 3', async () => {
    const wt = kur({ fail: { migrate: ['v3'] } });
    const r = await guncelle(wt, ['v3']);
    assert.equal(r.code, 3, r.out);
    assert.match(
      r.out,
      /HATA: deciship-migrate: exited \(çıkış 1\); günlük: docker compose -p sellerondata -f docker-compose\.yml -f docker-compose\.prod\.yml logs deciship-migrate/,
    );
    assert.match(r.out, /\(sağlık denetimi atlandı\)/);
    assert.match(r.out, /Göç geri alınamaz; betik eski sürüme kendiliğinden dönmedi/);
    assert.match(r.out, /yedekten dönüş .*yedek \S+yedekler\/guncelle\/\d{4}-/);
    assert.equal(head(wt), env.sha.v3);
    assert.equal(calls(r, /build @/).length, 1);

    // Aynı sürüm yeniden kurulup açılmazsa dönülecek sürüm yok: yine 3.
    const same = kur({ fail: { up: true } });
    const r2 = await guncelle(same, ['v1']);
    assert.equal(r2.code, 3, r2.out);
    assert.match(r2.out, /up -d --wait tutmadı/);
    assert.match(r2.out, /dönülecek eski sürüm yok/);
  });

  test('yedek alınamazsa güncelleme başlamaz (çıkış 2); yarım klasör kalmaz', async () => {
    for (const [name, opts] of [
      ['döküm', { fail: { dump: true } }],
      ['dosya', { fail: { tar: true } }],
    ]) {
      const wt = kur(opts);
      const r = await guncelle(wt, ['v2']);
      assert.equal(r.code, 2, `${name}: ${r.out}`);
      assert.match(r.out, /yedek alınamadı; güncelleme başlamadı, hiçbir şey değişmedi/);
      assert.equal(head(wt), env.sha.v1);
      assert.equal(calls(r, /build/).length, 0);
      assert.deepEqual(
        readdirSync(path.join(wt.platform, 'yedekler', 'guncelle')).filter((x) => /^\d/.test(x)),
        [],
        name,
      );
    }
    const sha = kur();
    writeFileSync(path.join(sha.fake, 'bozuk-sha'), '');
    let r = await guncelle(sha, ['v2']);
    assert.equal(r.code, 2);
    assert.match(r.out, /döküm kopyalanırken bozuldu/);

    const disk = kur();
    r = await guncelle(disk, ['v2'], { SOD_UPDATE_MIN_FREE_MB: '999999999' });
    assert.equal(r.code, 2);
    assert.match(r.out, /diskte yer az/);

    // İlk kurulum değilken veritabanı hacmi yoksa: sistem kurulmamış.
    const empty = kur({ volumes: [] });
    r = await guncelle(empty, ['v2']);
    assert.equal(r.code, 2);
    assert.match(r.out, /sistem kurulmamış görünüyor/);
  });

  test('--ilk-kurulum: hacim yoksa yedek atlanır, hedef HEAD, sonunda org-announce; --uyelik-duyur her ürün için', async () => {
    const wt = kur({ volumes: [] });
    const r = await guncelle(wt, ['--ilk-kurulum', '--uyelik-duyur', 'deciship,orderloom']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /İlk kurulum: veritabanı hacmi \(sod_pgdata\) yok, yedek atlandı/);
    assert.match(r.out, /Kod zaten \w+; değişmeden yeniden kurulur/);
    assert.equal(calls(r, /pg_dump|fetch/).length, 0);
    assert.equal(calls(r, /exec -T account-api node dist\/org-announce\.js/).length, 1);
    assert.deepEqual(
      calls(r, /members-announce/).map((l) => l.match(/members-announce\.js (\S+)/)[1]),
      ['deciship', 'orderloom'],
    );
    assert.match(r.out, /2 firma yeniden duyuruldu/);

    // Duyuru tutmazsa güncelleme yine tamam, çıkış 4.
    const ann = kur({ fail: { announce: true } });
    const r2 = await guncelle(ann, ['--uyelik-duyur', 'deciship', 'v2']);
    assert.equal(r2.code, 4, r2.out);
    assert.equal(head(ann), env.sha.v2);
    assert.match(r2.out, /duyuru tutmadı; güncelleme tamam/);
  });

  test('saklama: son SOD_UPDATE_BACKUP_KEEP güncelleme yedeği kalır; gece yedeklerine ve yarım klasöre dokunulmaz', async () => {
    const wt = kur();
    const base = path.join(wt.platform, 'yedekler');
    for (const d of [
      'guncelle/2026-01-01_0300',
      'guncelle/2026-01-02_0300',
      'guncelle/2026-01-03_0300',
      'guncelle/2026-01-04_0300.yaziliyor',
      '2026-01-01_0300',
    ]) {
      mkdirSync(path.join(base, d), { recursive: true });
      writeFileSync(path.join(base, d, 'yedek.json'), '{}');
    }
    const r = await guncelle(wt, ['v2'], { SOD_UPDATE_BACKUP_KEEP: '2' });
    assert.equal(r.code, 0, r.out);
    const left = backupsOf(wt);
    assert.equal(left.length, 3, left.join(','));
    assert.equal(left[0], '2026-01-03_0300');
    assert.equal(left[1], '2026-01-04_0300.yaziliyor');
    assert.ok(existsSync(path.join(base, '2026-01-01_0300', 'yedek.json')), 'gece yedeği silindi');
    assert.match(r.out, /Eski güncelleme yedeği silindi: 2026-01-01_0300/);
    assert.match(r.out, /Eski güncelleme yedeği silindi: 2026-01-02_0300/);
  });

  test("kilit: yarım kalan güncellemenin kilidi (süreç yok) kaldırılır; sağlık adresleri .env'den, SOD_CHECK_URL ezer", async () => {
    const wt = kur();
    const lock = path.join(wt.platform, 'yedekler', 'guncelle', '.kilit');
    mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(lock, 'pid'), '999999\n');
    let r = await guncelle(wt, ['v2']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /yarım kalmış güncellemenin kilidi kaldırıldı/);
    assert.ok(!existsSync(lock), 'kilit bırakılmadı');

    const other = kur();
    writeFileSync(
      path.join(other.fake, 'curl.txt'),
      ['http://gw.test/healthz 200', 'http://gw.test/api/account/health 200', 'http://gw.test/api/deciship/health 200'].join('\n') + '\n',
    );
    r = await guncelle(other, ['v2'], { SOD_CHECK_URL: 'http://gw.test', SOD_CHECK_SITE_URL: 'off' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sağlık tamam/);
  });
});
