import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'check-i18n.mjs');
const fixtures = path.join(here, 'test-fixtures', 'i18n');

function check(root, ...extra) {
  const r = spawnSync(process.execPath, [script, '--root', root, '--locales', 'src/locales', '--src', 'src', ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const fx = (name) => path.join(fixtures, name);

/** Bir fikstürün geçici kopyasında `fn(tmp)` çalıştırır (CRLF ve parametre denemeleri için). */
function withCopy(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-fx-'));
  try {
    fs.cpSync(fx(name), tmp, { recursive: true });
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const put = (tmp, rel, text) => fs.writeFileSync(path.join(tmp, rel), text);

test('temiz ağaç: strict sıfır (düzenli ifade ve console satırları sayılmaz)', () => {
  const r = check(fx('ok'), '--strict');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /anahtar hatası: 0, kodda kalan Türkçe satır: 0/);
});

test('eksik EN anahtarı hata verir', () => {
  const r = check(fx('missing-en'));
  assert.equal(r.code, 1);
  assert.match(r.out, /EN'de yok: common\.json b\.c/);
});

test("fazla EN anahtarı (TR'de yok) hata verir", () => {
  const r = check(fx('extra-en'));
  assert.equal(r.code, 1);
  assert.match(r.out, /TR'de yok: common\.json d/);
});

test('koda gömülü Türkçe: strict hata, strict olmadan uyarı', () => {
  const soft = check(fx('hardcoded'));
  assert.equal(soft.code, 0, soft.out);
  assert.match(soft.out, /Kalan: src\/App\.tsx:1/);
  const strict = check(fx('hardcoded'), '--strict');
  assert.equal(strict.code, 1);
  assert.match(strict.out, /Kalan: src\/App\.tsx:1/);
});

test('JSX metnindeki Türkçe yakalanır', () => {
  const r = check(fx('jsx'), '--strict');
  assert.equal(r.code, 1);
  assert.match(r.out, /Kalan: src\/App\.tsx:2/);
});

test('yorumlardaki Türkçe sayılmaz', () => {
  assert.equal(check(fx('comment-only'), '--strict').code, 0);
});

test('// i18n-ok: neden satırı atlatır; nedensiz işaret hatadır', () => {
  assert.equal(check(fx('i18n-ok'), '--strict').code, 0);
  withCopy('i18n-ok', (tmp) => {
    put(tmp, 'src/App.tsx', "export const NAME = 'Türkçe'; // i18n-ok\n");
    const r = check(tmp, '--strict');
    assert.equal(r.code, 1);
    assert.match(r.out, /Nedensiz i18n-ok işareti: src\/App\.tsx:1/);
  });
});

test('şablon dizgesi: ${} içeren anahtar atlanır, şablondaki Türkçe yakalanır', () => {
  assert.equal(check(fx('template'), '--strict').code, 0);
  withCopy('template', (tmp) => {
    put(tmp, 'src/App.tsx', 'export const m = (n: number) => `Toplam ${n} çalışan`;\n');
    const r = check(tmp, '--strict');
    assert.equal(r.code, 1);
    assert.match(r.out, /Kalan: src\/App\.tsx:1/);
  });
});

test('sözlükte olmayan kullanılan anahtar: strict hata, değilse uyarı', () => {
  const soft = check(fx('used-missing'));
  assert.equal(soft.code, 0, soft.out);
  assert.match(soft.out, /JSON'da yok: src\/App\.tsx: common:yok\.anahtar/);
  assert.equal(check(fx('used-missing'), '--strict').code, 1);
});

test('test, mock ve __tests__ dosyaları atlanır', () => {
  assert.equal(check(fx('skipped'), '--strict').code, 0);
});

test('CRLF satır sonlu dosyada // yorumu sayılmaz (plan 14-B8 hatası)', () => {
  withCopy('ok', (tmp) => {
    const lines = ['// Türkçe yorum: şu çalışan', 'export const x = 1; // sağ yorum: ışık', '/* blok: öğe', '   devam: ğ */', 'export const y = 2;', ''];
    put(tmp, 'src/App.tsx', lines.join('\r\n'));
    const r = check(tmp, '--strict');
    assert.equal(r.code, 0, r.out);
  });
});

test('--default-ns: bildirimsiz t() çağrısı o ad alanına bakar', () => {
  withCopy('ok', (tmp) => {
    put(tmp, 'src/App.tsx', "export const f = (t: (k: string) => string) => t('yok.anahtar');\n");
    assert.equal(check(tmp, '--strict').code, 0);
    const r = check(tmp, '--strict', '--default-ns', 'common');
    assert.equal(r.code, 1);
    assert.match(r.out, /common:yok\.anahtar/);
  });
});

test('açık { ns } seçeneği ile çoğul ve bağlam sonekleri tanınır', () => {
  withCopy('ok', (tmp) => {
    put(tmp, 'src/locales/tr/common.json', '{"a":"x","n_one":"bir","n_other":"çok","g_ctx_one":"b","g_ctx_other":"c"}');
    put(tmp, 'src/locales/en/common.json', '{"a":"x","n_one":"one","n_other":"many","g_ctx_one":"b","g_ctx_other":"c"}');
    put(tmp, 'src/App.tsx', "import { useTranslation } from 'react-i18next';\nexport function A() {\n  const { t } = useTranslation('common');\n  return <p>{t('n')}{t('g')}{t('baska', { ns: 'shell' })}</p>;\n}\n");
    const r = check(tmp, '--strict');
    assert.equal(r.code, 0, r.out);
  });
});

test('yasak sözcük hata verir', () => {
  withCopy('ok', (tmp) => {
    put(tmp, 'src/locales/tr/common.json', '{"a":"Yeni işçi ekle","b":{"c":"x"}}');
    const r = check(tmp);
    assert.equal(r.code, 1);
    assert.match(r.out, /Yasak kelime/);
  });
});
