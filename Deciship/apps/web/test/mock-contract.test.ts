// Mesaj 10 (15-B2, 10-B16): panelin sahte API'si (src/mocks, e2e bununla koşar) gerçek API ile aynı ŞEKLİ vermeli.
// Gerçek şekil `Deciship/apps/api/test/__contract__/*.json` dosyalarındadır (API veritabanı testi `test/contract.test.ts`
// yazar). Burada aynı uçlar sahte API'ye sorulur (msw işleyicileri tarayıcısız, `getResponse` ile) ve `compareShape` ile
// sınanır. Fark çıkınca test uç ve alan yolunu söyleyerek kırılır: sahte API (browser.ts, disputes.ts) gerçeğe uydurulur.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { before, describe, it } from 'node:test';
import { compareShape, mergeShapes, shapeOf, type Shape } from '../../../../scripts/lib/shape.mjs';

// Sahte API tarayıcı için yazılı: uzantısız içe aktarma (Vite çözer), `msw/browser` (Node'da yok) ve `src/i18n`
// (`import.meta.glob`) yalnız bu testte çözümleyici kancasıyla karşılanır. Sözleşme uçları bu ikisini kullanmaz.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `const stub = (src) => ({ url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true });`,
        `export async function resolve(s, c, n) {`,
        `  if (s === 'msw/browser') return stub('export const setupWorker = () => { throw new Error("tarayıcı yok"); };');`,
        `  let r;`,
        `  try { r = await n(s, c); } catch (e) {`,
        `    if (!(/^\\.\\.?\\//.test(s) && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ERR_UNSUPPORTED_DIR_IMPORT'))) throw e;`,
        `    for (const x of ['.ts', '/index.ts']) { try { r = await n(s + x, c); break; } catch {} }`,
        `    if (!r) throw e;`,
        `  }`,
        `  if (/\\/apps\\/web\\/src\\/i18n\\/index\\.ts$/.test(r.url)) return stub('export const i18n = { t: (k) => k, language: "tr" };');`,
        `  return r;`,
        `}`,
      ].join('\n'),
    ),
);

/** Tarayıcı deposunun bellek karşılığı (sahte API kancaları ve oturum buradan okunur). */
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
// Merkez tohumunun sahibi (o1 firmasında DeciShip yöneticisi), gecikmesiz, örnek itirazlarla (her durum)
storage.setItem('sod_mock_session', JSON.stringify({ personId: 'p1', orgId: 'o1' }));
storage.setItem('sod_mock_fast', '1');
storage.setItem('sod_mock_disputes', '1');

const { getResponse } = await import('msw');
// Yol değişkenle verilir: tip denetimi (tsconfig.node.json, Vite tipleri ve JSX yok) sahte API'nin içine girmesin
const MOCKS = new URL('../src/mocks/browser.ts', import.meta.url).href;
const { handlers } = (await import(MOCKS)) as { handlers: Parameters<typeof getResponse>[0] };

const CONTRACT_DIR = path.resolve(import.meta.dirname, '../../api/test/__contract__');
type Contract = { endpoint: string; status: number; code?: string; shape: Shape };
const contracts = new Map<string, Contract>(
  fs
    .readdirSync(CONTRACT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, f), 'utf8')) as Contract]),
);

/**
 * Bilinçli istisnalar: sözleşme adı → sınanmayacak yollar. Her satırın gerekçesi yanında; gerçek davranış değişmedikçe
 * liste büyütülmez.
 */
const IGNORE: Record<string, string[]> = {
  // Kur çevrimli satırın döküm adımı `fx` taşır (SPEC §FX). Gerçek fikstürde kur çevrimi yok: API testleri gerçek kur
  // servisine çıkmaz (test/noRealFx.ts), bu yüzden alan gerçek kayıtta hiç görülmez. Sahte API i1'de iki USD→TRY satırı tutar.
  'invoice-lines': ['$.items[].breakdown[].fx'],
};

type MockReply = { status: number; json: unknown };
async function call(method: string, url: string, body?: unknown): Promise<MockReply> {
  const req = new Request(`http://localhost/api/deciship${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-sod-csrf': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await getResponse(handlers, req, { baseUrl: 'http://localhost' });
  assert.ok(res, `sahte API ${method} ${url} için yanıt vermedi`);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Sahte API örnekleri: sözleşme adı → (durum, birleşik şekil). */
const samples = new Map<string, { status: number; code?: string; shape: Shape }>();
function sample(name: string, r: MockReply) {
  const shape = shapeOf(r.json);
  const code = (r.json as { error?: { code?: string } } | null)?.error?.code;
  const prev = samples.get(name);
  if (prev) {
    assert.equal(r.status, prev.status, `${name}: sahte API örnekleri farklı durum kodu veriyor`);
    prev.shape = mergeShapes(prev.shape, shape);
  } else samples.set(name, { status: r.status, ...(code ? { code } : {}), shape });
}

const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
type Round = { id: string; version: number; lines: { id: string; claimedAmount: number }[] };
type InvoiceBody = { invoice: { invoiceNo: string; dispute: { selectionDigest: string | null; active: Round | null } } };

before(async () => {
  for (const u of ['/me', '/settings', '/settings/onboarding', '/box-presets', '/carriers']) {
    const name = { '/me': 'me', '/settings': 'settings', '/settings/onboarding': 'settings-onboarding', '/box-presets': 'box-presets', '/carriers': 'carriers' }[u]!;
    sample(name, await call('GET', u));
  }

  // Tarifeler
  sample('tariffs-list', await call('GET', '/tariffs'));
  for (const t of ['t1', 't2']) sample('tariff', await call('GET', `/tariffs/${t}`));
  sample('tariff-versions', await call('GET', '/tariffs/t1/versions'));
  sample('tariff-quote', await call('POST', '/tariffs/t1/quote', { lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4 }));
  const t1 = (await call('GET', '/tariffs/t1')).json as { tariff: Record<string, unknown> };
  const { id: _id, ...dupBody } = t1.tariff;
  void _id;
  sample('error-400-validation', await call('POST', '/tariffs', { ...dupBody, name: 'Yinelenen', rates: [{ zone: 'A', weightUpto: 1, price: 10 }, { zone: 'A', weightUpto: 1, price: 12 }] }));

  // Ölçümler
  const ms = await call('GET', '/measurements');
  sample('measurements-list', ms);
  // ilki faturasız, ikincisi son faturanın bir satırında (`invoiceLines` dolu)
  for (const m of (ms.json as { items: { id: string }[] }).items.slice(0, 2)) sample('measurement', await call('GET', `/measurements/${m.id}`));

  // Faturalar: itirazsız (i1), taslak, gönderilmiş, kısmen geri alınmış, kapanmış
  sample('invoices-list', await call('GET', '/invoices?pageSize=100'));
  for (const id of ['i1', 'dsp-unsent', 'dsp-sent', 'dsp-partial', 'dsp-closed']) {
    sample('invoice', await call('GET', `/invoices/${id}`));
    sample('invoice-lines', await call('GET', `/invoices/${id}/lines`));
  }
  sample('invoice-dispute-text', await call('GET', '/invoices/dsp-unsent/dispute?lang=tr'));
  sample('invoice-tariff-health', await call('GET', '/invoices/i1/tariff-health'));
  storage.setItem('sod_mock_health_suspect', '1');
  sample('invoice-tariff-health', await call('GET', '/invoices/i1/tariff-health'));
  storage.removeItem('sod_mock_health_suspect');
  const i1Lines = (await call('GET', '/invoices/i1/lines?status=DIFF')).json as { items: { id: string }[] };
  sample('invoice-line-patch', await call('PATCH', `/invoice-lines/${i1Lines.items[0]!.id}`, { decision: 'VERIFIED' }));

  // İtiraz: gönder, sonuç gir, ikinci gönderim 409
  const u2 = (await call('GET', '/invoices/dsp-unsent2')).json as InvoiceBody;
  const sent = await call('POST', '/invoices/dsp-unsent2/disputes', { selectionDigest: u2.invoice.dispute.selectionDigest, sentOn: today(), channel: 'EMAIL', channelNote: 'efatura@ornek.test' });
  sample('dispute-send', sent);
  const round = (sent.json as { dispute: { active: Round } }).dispute.active;
  sample('dispute-result', await call('POST', `/disputes/${round.id}/results`, { version: round.version, kind: 'RECOVERED', resultOn: today(), creditNoteNo: 'AD-1', lines: [{ disputeLineId: round.lines[0]!.id, amount: round.lines[0]!.claimedAmount }] }));
  const sentDigest = ((await call('GET', '/invoices/dsp-sent')).json as InvoiceBody).invoice.dispute.selectionDigest ?? '0'.repeat(64);
  sample('error-409-dispute-active', await call('POST', '/invoices/dsp-sent/disputes', { selectionDigest: sentDigest, sentOn: today(), channel: 'EMAIL' }));

  sample('disputes-list', await call('GET', '/disputes'));
  sample('dashboard', await call('GET', `/dashboard?month=${today().slice(0, 7)}`));

  // Hatalar
  sample('error-404', await call('GET', `/invoices/${crypto.randomUUID()}`));
  storage.setItem('sod_mock_forbid', '/invoices');
  sample('error-403', await call('GET', '/invoices'));
  storage.removeItem('sod_mock_forbid');

  // Durum çeşidi (en sonda, depoyu değiştirir): dsp-usd'de ilk turda bir satır geri alındı, öbürü yeniden gönderildi;
  // yeni tur geri çekilir. Etkin tur yok, geri alınan satır geçerli kalır.
  const usd = (await call('GET', '/invoices/dsp-usd')).json as InvoiceBody;
  const active = usd.invoice.dispute.active!;
  const w = await call('POST', `/disputes/${active.id}/withdraw`, { version: active.version, reason: 'sözleşme' });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const list = (await call('GET', `/invoices?q=${encodeURIComponent(usd.invoice.invoiceNo)}`)).json as { items: { id: string; disputeStatus: string }[] };
  const items = list.items.filter((i) => i.id === 'dsp-usd');
  assert.deepEqual(items.map((i) => i.disputeStatus), ['NONE']);
  sample('invoices-list-withdrawn-after-recovery', { status: 200, json: { ...list, items } });
});

describe('sahte API = gerçek API şekli', () => {
  it('sözleşme dosyaları okundu', () => {
    assert.ok(contracts.size >= 20, `${CONTRACT_DIR} içinde sözleşme az: ${contracts.size}`);
  });
  it('her sözleşmenin sahte API örneği var', () => {
    assert.deepEqual([...contracts.keys()].filter((n) => !samples.has(n)), []);
  });
  for (const [name, real] of contracts) {
    it(`${name} (${real.endpoint})`, () => {
      const mock = samples.get(name);
      assert.ok(mock, `${name}: sahte API örneği yok`);
      assert.equal(mock.status, real.status, `${real.endpoint}: durum kodu sahte ${mock.status}, gerçek ${real.status}`);
      if (real.code) assert.equal(mock.code, real.code, `${real.endpoint}: hata kodu sahte ${mock.code}, gerçek ${real.code}`);
      const diffs = compareShape(mock.shape, real.shape, { ignore: IGNORE[name] ?? [] });
      assert.deepEqual(diffs, [], `${real.endpoint} (${name}) şekil farkı:\n  ${diffs.join('\n  ')}`);
    });
  }
});
