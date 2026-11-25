// Kullanıcı seçmediğinde yeni kayıt firmanın para biriminde açılır; ekranda para birimi sabiti yazılmaz.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { firmCurrency } from '../src/lib/currency.ts';

const SRC = path.resolve(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('firma para birimi', () => {
  it('firmanın para birimini verir', () => {
    assert.equal(firmCurrency({ company: { settings: { currency: 'USD' } } }), 'USD');
    assert.equal(firmCurrency({ company: { settings: { currency: 'EUR' } } }), 'EUR');
  });
  it('ayarı göremeyen kişi ya da yanıt gelmeden TRY', () => {
    assert.equal(firmCurrency({ company: { settings: {} } }), 'TRY');
    assert.equal(firmCurrency(null), 'TRY');
  });
});

describe('ekranda para birimi sabiti yok', () => {
  // Sihirbazın simge tablosu birim testinde core olmadan yüklenir; para birimi listeleri seçenektir.
  const ALLOWED = new Set(['pages/onboarding/steps.ts']);

  it('sayfalarda TRY ve ₺ sabiti yazılmaz', () => {
    const hits = sources(path.join(SRC, 'pages')).flatMap((file) => {
      const rel = path.relative(SRC, file).replaceAll('\\', '/');
      if (ALLOWED.has(rel)) return [];
      return code(fs.readFileSync(file, 'utf8'))
        .split('\n')
        .filter((l) => /₺|['"]TRY['"]/.test(l))
        .map((l) => `${rel}: ${l.trim()}`);
    });
    assert.deepEqual(hits, []);
  });
});

describe('yapay zekâ metni', () => {
  const read = (lang: string) => JSON.parse(fs.readFileSync(path.join(SRC, `locales/${lang}/invoiceUpload.json`), 'utf8')).one;

  it('kapalıyken PDF okunur denmez', () => {
    for (const lang of ['tr', 'en']) {
      const text = read(lang).uploadFileDescNoAi as string;
      assert.ok(text.includes('{{mb}}'), lang);
      assert.doesNotMatch(text, /yapay zek|\bAI\b/i, lang);
    }
  });
});

describe('bekleyen karar terimi', () => {
  const decision = (lang: string, ns: string) => JSON.parse(fs.readFileSync(path.join(SRC, `locales/${lang}/${ns}.json`), 'utf8')).decision.OPEN;

  it('arayüz, PDF ve Merkez aynı terimi yazar', () => {
    for (const ns of ['common', 'invoiceDetail']) {
      assert.equal(decision('tr', ns), 'Karar bekliyor', ns);
      assert.equal(decision('en', ns), 'Awaiting decision', ns);
    }
  });
});
