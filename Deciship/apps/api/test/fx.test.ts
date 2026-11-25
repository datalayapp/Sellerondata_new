import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FxService, parseTcmbXml, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { recalculate } from './recalcHelpers.ts';
import { getApp, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

type Auth = { authorization: string };
type Rates = Record<string, [number, number, number?]>;

function xml(dmy: string, rates: Rates) {
  const cur = Object.entries(rates)
    .map(
      ([code, [buy, sell, unit]]) =>
        `<Currency CrossOrder="0" Kod="${code}" CurrencyCode="${code}"><Unit>${unit ?? 1}</Unit><Isim>X</Isim><CurrencyName>X</CurrencyName><ForexBuying>${buy}</ForexBuying><ForexSelling>${sell}</ForexSelling><BanknoteBuying>1</BanknoteBuying><BanknoteSelling>1</BanknoteSelling><CrossRateUSD/><CrossRateOther/></Currency>`,
    )
    .join('');
  const [d, m, y] = dmy.split('.');
  return `<?xml version="1.0" encoding="ISO-8859-9"?><Tarih_Date Tarih="${dmy}" Date="${m}/${d}/${y}" Bulten_No="2026/1">${cur}</Tarih_Date>`;
}

/** Sahte TCMB: verilen günler için bülten; diğerleri 404; `down` true ise ağ hatası. */
function fakeTcmb(days: Record<string, Rates>, opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const fetcher: FxFetcher = async (url) => {
    calls.push(url);
    if (opts.down) throw new Error('ECONNREFUSED');
    for (const [iso, rates] of Object.entries(days)) {
      if (url === tcmbUrl(iso)) {
        const [y, m, d] = iso.split('-');
        return { status: 200, text: xml(`${d}.${m}.${y}`, rates) };
      }
    }
    return { status: 404, text: '' };
  };
  return { fetcher, calls };
}

const tmpDirs: string[] = [];
function tmpCache() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-fx-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  setFxService(null);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = () => new Date('2026-11-04T12:00:00Z');

describe('FxService (TCMB)', () => {
  it('XML: alış/satış ortalaması, Unit bölünür', () => {
    const b = parseTcmbXml(xml('03.06.2025', { USD: [39.1469, 39.2174], JPY: [27.1, 27.3, 100] }));
    expect(b!.date).toBe('2025-06-03');
    expect(b!.rates.USD).toBeCloseTo(39.18215, 6);
    expect(b!.rates.JPY).toBeCloseTo(0.272, 6);
  });

  it('hafta sonu → önceki iş günü; dosya önbelleği yeniden indirmeyi önler', async () => {
    const cacheDir = tmpCache();
    const t = fakeTcmb({ '2025-06-06': { USD: [39, 39.1], EUR: [44, 44.2] } });
    const fx = new FxService({ fetcher: t.fetcher, cacheDir, now: NOW });
    const r = await fx.getRate('USD', 'TRY', '2025-06-08');
    expect(r).toEqual({ base: 'USD', quote: 'TRY', rate: 39.05, date: '2025-06-06', source: 'TCMB' });
    expect(t.calls).toEqual([tcmbUrl('2025-06-08'), tcmbUrl('2025-06-07'), tcmbUrl('2025-06-06')]);
    // çapraz kur TRY üzerinden
    const cross = await fx.getRate('EUR', 'USD', '2025-06-07');
    expect(cross!.rate).toBeCloseTo(44.1 / 39.05, 6);
    // yeni süreç (yeniden başlatma): ağ kapalı ama önbellekten okunur
    const off = new FxService({ fetcher: fakeTcmb({}, { down: true }).fetcher, cacheDir, now: NOW });
    expect((await off.getRate('USD', 'TRY', '2025-06-08'))!.rate).toBe(39.05);
  });

  it('10 günden eski bülten aranmaz; ağ hatasında null (zincir durur)', async () => {
    const t = fakeTcmb({ '2025-05-01': { USD: [1, 1] } });
    const fx = new FxService({ fetcher: t.fetcher, cacheDir: null, now: NOW });
    expect(await fx.getRate('USD', 'TRY', '2025-05-20')).toBeNull();
    expect(t.calls).toHaveLength(11);
    const down = fakeTcmb({}, { down: true });
    const fx2 = new FxService({ fetcher: down.fetcher, cacheDir: null, backoffMs: [0], now: NOW });
    expect(await fx2.getRate('USD', 'TRY', '2025-06-03')).toBeNull();
    // ilk deneme + bir yeniden deneme, sonra devre kesici
    expect(down.calls).toHaveLength(2);
  });

  it('9 günlük bayram tatili (Cmt–sonraki Paz): tatilin son günü önceki cumanın kurunu bulur', async () => {
    // Uydurma kurlar. Cuma 22.05.2026 son bülten; 23–31.05 tatil (9 gün); Pzt 01.06 bülten var.
    const t = fakeTcmb({ '2026-05-22': { USD: [40, 40.2] }, '2026-06-01': { USD: [41, 41.2] } });
    const fx = new FxService({ fetcher: t.fetcher, cacheDir: null, now: NOW });
    // tatilin son günü (Pazar 31.05): 9 gün geride cuma → eski 7 günlük sınırda bulunamıyordu
    expect(await fx.getRate('USD', 'TRY', '2026-05-31')).toEqual({ base: 'USD', quote: 'TRY', rate: 40.1, date: '2026-05-22', source: 'TCMB' });
    expect(t.calls).toHaveLength(10);
    expect(t.calls.at(-1)).toBe(tcmbUrl('2026-05-22'));
    // tatil ortası ve sonrası
    expect((await fx.getRate('USD', 'TRY', '2026-05-27'))!.date).toBe('2026-05-22');
    expect((await fx.getRate('USD', 'TRY', '2026-06-01'))!.rate).toBe(41.1);
  });

  it('zaman aşımında bir kez yeniden dener; tek yavaş yanıt kuru kaybettirmez', async () => {
    const calls: string[] = [];
    const fetcher: FxFetcher = (url, signal) => {
      calls.push(url);
      if (calls.length === 1) {
        // ilk istek zaman aşımına uğrar (sinyal iptal edene kadar yanıt yok)
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      }
      return Promise.resolve({ status: 200, text: xml('15.10.2026', { USD: [40, 40.1] }) });
    };
    const fx = new FxService({ fetcher, cacheDir: null, timeoutMs: 30, backoffMs: [0], now: NOW });
    expect(await fx.getRate('USD', 'TRY', '2026-10-15')).toMatchObject({ rate: 40.05, date: '2026-10-15' });
    expect(calls).toEqual([tcmbUrl('2026-10-15'), tcmbUrl('2026-10-15')]);
  });

  it('devre kesici yalnız arka arkaya 2 başarısızlıktan sonra açılır', async () => {
    let n = 0;
    const calls: string[] = [];
    const fetcher: FxFetcher = async (url) => {
      calls.push(url);
      n++;
      // 1: hata, 2: başarı (sayaç sıfırlanır), 3: hata, 4: hata → kesici açık
      if (n === 1 || n >= 3) throw new Error('ETIMEDOUT');
      return { status: 200, text: xml('15.10.2026', { USD: [40, 40.1] }) };
    };
    const fx = new FxService({ fetcher, cacheDir: null, backoffMs: [0], now: NOW });
    expect(await fx.getRate('USD', 'TRY', '2026-10-15')).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(await fx.getRate('USD', 'TRY', '2026-09-15')).toBeNull();
    expect(calls).toHaveLength(4);
    // kesici açık: ağa gidilmez
    expect(await fx.getRate('USD', 'TRY', '2026-08-14')).toBeNull();
    expect(calls).toHaveLength(4);
  });

  it('prefetch: günler sırayla, 3 deneme; yavaş/hatalı yanıtlar devre kesiciyi açmaz', async () => {
    const tries = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    const days: Record<string, string> = { '2026-10-13': '13.10.2026', '2026-10-14': '14.10.2026', '2026-10-15': '15.10.2026' };
    const fetcher: FxFetcher = async (url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 2));
        const n = (tries.get(url) ?? 0) + 1;
        tries.set(url, n);
        // her gün ilk iki denemede düşer, üçüncüde gelir
        if (n < 3) throw new Error('ETIMEDOUT');
        const iso = Object.keys(days).find((d) => tcmbUrl(d) === url)!;
        return { status: 200, text: xml(days[iso]!, { USD: [40, 40.1] }) };
      } finally {
        inFlight--;
      }
    };
    const fx = new FxService({ fetcher, cacheDir: null, backoffMs: [0], timeoutMs: 30_000, now: NOW });
    const res = await fx.prefetch(Object.keys(days).map((date) => ({ base: 'USD', quote: 'TRY', date })));
    expect(res.failed).toEqual([]);
    expect([...res.rates.values()].every((r) => r?.rate === 40.05)).toBe(true);
    expect([...tries.values()]).toEqual([3, 3, 3]);
    expect(maxInFlight).toBe(1);
  });

  it('prefetch, süren arka plan (sabırsız) isteğinin hatasını devralmaz; kendi denemelerini yapar', async () => {
    // Ölçüm kuyruğu birden gelince arka planda sabırsız istekler başlar; hemen ardından "Yeniden karşılaştır".
    let n = 0;
    const fetcher: FxFetcher = async () => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      if (n <= 2) throw new Error('ECONNRESET'); // ilk iki deneme düşer → sabırsız istek kesiciyi açar
      return { status: 200, text: xml('15.10.2026', { USD: [40, 40.1] }) };
    };
    const fx = new FxService({ fetcher, cacheDir: null, backoffMs: [0], now: NOW });
    const background = fx.getRate('USD', 'TRY', '2026-10-15'); // sabırsız
    const res = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-10-15' }]); // sabırlı, aynı gün
    expect(await background).toBeNull();
    expect(res.failed).toEqual([]);
    expect(res.rates.get('USD>TRY@2026-10-15')).toMatchObject({ rate: 40.05 });
  });

  it('prefetch: TCMB kapalı → 2 gün denenir, kalanlar yalnız önbellekten; alınamayanlar failed', async () => {
    const cacheDir = tmpCache();
    const ok = fakeTcmb({ '2026-10-20': { USD: [40, 40.1] } });
    await new FxService({ fetcher: ok.fetcher, cacheDir, now: NOW }).getRate('USD', 'TRY', '2026-10-20');
    const down = fakeTcmb({}, { down: true });
    const fx = new FxService({ fetcher: down.fetcher, cacheDir, backoffMs: [0], now: NOW });
    const dates = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-20'];
    const res = await fx.prefetch(dates.map((date) => ({ base: 'USD', quote: 'TRY', date })));
    // 13 ve 14: 3'er deneme; 15: ağa gidilmez; 20: önbellekten
    expect(down.calls).toEqual([...Array(3).fill(tcmbUrl('2026-10-13')), ...Array(3).fill(tcmbUrl('2026-10-14'))]);
    expect(res.failed).toEqual(['USD>TRY@2026-10-13', 'USD>TRY@2026-10-14', 'USD>TRY@2026-10-15']);
    expect(res.rates.get('USD>TRY@2026-10-20')).toMatchObject({ rate: 40.05 });
    // sonraki prefetch (Yeniden karşılaştır) yine dener: devre kesici prefetch'i engellemez
    await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-10-13' }]);
    expect(down.calls).toHaveLength(9);
  });

  it('prefetch: toplam süre üst sınırı aşılınca istek beklemez; kalan günler önbellekten, alınamayanlar failed', async () => {
    const cacheDir = tmpCache();
    const ok = fakeTcmb({ '2026-10-20': { USD: [40, 40.1] } });
    await new FxService({ fetcher: ok.fetcher, cacheDir, now: NOW }).getRate('USD', 'TRY', '2026-10-20');
    const calls: string[] = [];
    // TCMB yanıt vermiyor: tek istek kendi zaman aşımına (burada 5 sn) kadar asılı kalır
    const hanging: FxFetcher = (url, signal) => {
      calls.push(url);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    const fx = new FxService({ fetcher: hanging, cacheDir, timeoutMs: 5_000, backoffMs: [0], now: NOW, prefetchBudgetMs: 50 });
    const started = Date.now();
    const res = await fx.prefetch(['2026-10-13', '2026-10-14', '2026-10-20'].map((date) => ({ base: 'USD', quote: 'TRY', date })));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.failed).toEqual(['USD>TRY@2026-10-13', 'USD>TRY@2026-10-14']);
    expect(res.rates.get('USD>TRY@2026-10-20')).toMatchObject({ rate: 40.05 });
    expect(calls.filter((u) => u === tcmbUrl('2026-10-14'))).toHaveLength(0);
  });

  it('prefetch: üst sınırda kalan günler arka planda iner; Yeniden karşılaştır önbellekten tamamlanır', async () => {
    // Y18: günler aralarında 7 günden fazla olacak biçimde seçildi; yoksa geç kalan gün, önce inen günün saklı kurunu
    // (bayat kur) alır ve `failed`'e girmez (o davranış aşağıdaki "saklı kur" testlerinde).
    const days: Record<string, Rates> = { '2026-10-01': { USD: [40, 40.1] }, '2026-10-13': { USD: [40, 40.1] }, '2026-10-25': { USD: [40, 40.1] } };
    const slow = fakeTcmb(days);
    const fetcher: FxFetcher = async (url, signal) => {
      await new Promise((r) => setTimeout(r, 40));
      return slow.fetcher(url, signal);
    };
    const fx = new FxService({ fetcher, cacheDir: tmpCache(), now: NOW, prefetchBudgetMs: 60 });
    const reqs = Object.keys(days).map((date) => ({ base: 'USD', quote: 'TRY', date }));
    const first = await fx.prefetch(reqs);
    expect(first.failed.length).toBeGreaterThan(0);
    await expect.poll(() => slow.calls.length, { timeout: 2_000 }).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    const before = slow.calls.length;
    const second = await fx.prefetch(reqs);
    expect(second.failed).toEqual([]);
    expect([...second.rates.values()].every((r) => r?.rate === 40.05)).toBe(true);
    expect(slow.calls.length).toBe(before);
  });

  it('Y18 saklı kur: TCMB kapalı → saklı en yakın önceki gün (en çok 7 gün) stale işaretiyle; daha eskisi yok sayılır', async () => {
    const cacheDir = tmpCache();
    const ok = fakeTcmb({ '2026-10-12': { USD: [40, 40.1], EUR: [44, 44.2] } });
    await new FxService({ fetcher: ok.fetcher, cacheDir, now: NOW }).getRate('USD', 'TRY', '2026-10-12');
    const down = fakeTcmb({}, { down: true });
    const fx = new FxService({ fetcher: down.fetcher, cacheDir, backoffMs: [0], now: NOW });
    // 15.10 → 12.10 (3 gün), 19.10 → 12.10 (7 gün, sınırda); 20.10 → 8 gün: saklı kur kullanılmaz
    const res = await fx.prefetch([
      { base: 'USD', quote: 'TRY', date: '2026-10-15' },
      { base: 'EUR', quote: 'USD', date: '2026-10-19' },
      { base: 'TRY', quote: 'USD', date: '2026-10-20' },
    ]);
    expect(res.rates.get('USD>TRY@2026-10-15')).toEqual({ base: 'USD', quote: 'TRY', rate: 40.05, date: '2026-10-12', source: 'TCMB', stale: true });
    expect(res.rates.get('EUR>USD@2026-10-19')).toMatchObject({ date: '2026-10-12', stale: true, rate: Math.round((44.1 / 40.05) * 1e6) / 1e6 });
    expect(res.rates.get('TRY>USD@2026-10-20')).toBeNull();
    expect(res.failed).toEqual(['TRY>USD@2026-10-20']);
    // saklı kur yalnız alınamayınca: tek başına getRate bayat kur vermez
    expect(await fx.getRate('USD', 'TRY', '2026-10-15')).toBeNull();
  });

  it('Y18 saklı kur: süre sınırına takılan gün saklı kurla hesaplanır, arka planda iner; sonraki prefetch taze kur', async () => {
    const cacheDir = tmpCache();
    const days: Record<string, Rates> = { '2026-10-12': { USD: [40, 40.1] }, '2026-10-15': { USD: [41, 41.1] } };
    await new FxService({ fetcher: fakeTcmb(days).fetcher, cacheDir, now: NOW }).getRate('USD', 'TRY', '2026-10-12');
    const slow = fakeTcmb(days);
    const fetcher: FxFetcher = async (url, signal) => {
      await new Promise((r) => setTimeout(r, 100));
      return slow.fetcher(url, signal);
    };
    const fx = new FxService({ fetcher, cacheDir, now: NOW, prefetchBudgetMs: 20 });
    const first = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-10-15' }]);
    expect(first.failed).toEqual([]);
    expect(first.rates.get('USD>TRY@2026-10-15')).toMatchObject({ rate: 40.05, date: '2026-10-12', stale: true });
    await expect.poll(() => slow.calls.length, { timeout: 2_000 }).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 150));
    const second = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-10-15' }]);
    expect(second.rates.get('USD>TRY@2026-10-15')).toEqual({ base: 'USD', quote: 'TRY', rate: 41.05, date: '2026-10-15', source: 'TCMB' });
  });

  it('Y18 saklı kur (inceleme): hafta sonu için önbellekteki cuma kuru bayat değildir; pazartesi için bayattır', async () => {
    const cacheDir = tmpCache();
    await new FxService({ fetcher: fakeTcmb({ '2026-10-16': { USD: [40, 40.1] } }).fetcher, cacheDir, now: NOW }).getRate('USD', 'TRY', '2026-10-16');
    const fx = new FxService({ fetcher: fakeTcmb({}, { down: true }).fetcher, cacheDir, backoffMs: [0], now: NOW, retryAfterMs: 60_000 });
    const res = await fx.prefetch([
      { base: 'USD', quote: 'TRY', date: '2026-10-18' }, // Pazar → Cuma: taze yolun da bulacağı kur
      { base: 'USD', quote: 'TRY', date: '2026-10-17' }, // Cumartesi
      { base: 'USD', quote: 'TRY', date: '2026-10-19' }, // Pazartesi: o günün bülteni bilinmiyor
    ]);
    expect(res.rates.get('USD>TRY@2026-10-18')).toEqual({ base: 'USD', quote: 'TRY', rate: 40.05, date: '2026-10-16', source: 'TCMB' });
    expect(res.rates.get('USD>TRY@2026-10-17')).toEqual({ base: 'USD', quote: 'TRY', rate: 40.05, date: '2026-10-16', source: 'TCMB' });
    expect(res.rates.get('USD>TRY@2026-10-19')).toMatchObject({ date: '2026-10-16', stale: true });
    expect(res.failed).toEqual([]);
  });

  it('Y18 saklı kur (inceleme): tatil sonrası bilinmeyen gün 7 günden eski bayat kur almaz; tatil içindeki gün taze kuru bulur', async () => {
    const cacheDir = tmpCache();
    // 9 günlük tatil: 22.05 cuma son bülten, 23–31.05 işaretli "yok"
    const t = fakeTcmb({ '2026-05-22': { USD: [40, 40.2] } });
    await new FxService({ fetcher: t.fetcher, cacheDir, now: NOW }).getRate('USD', 'TRY', '2026-05-31');
    const fx = new FxService({ fetcher: fakeTcmb({}, { down: true }).fetcher, cacheDir, backoffMs: [0], now: NOW, retryAfterMs: 60_000 });
    const res = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-06-01' }]);
    // 01.06 bilinmiyor (pazartesi), 31.05–23.05 "yok": 22.05 bayat ama 10 gün içinde değil → 7 gün sınırı aşıldı
    expect(res.rates.get('USD>TRY@2026-06-01')).toBeNull();
    const holiday = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-05-31' }]);
    expect(holiday.rates.get('USD>TRY@2026-05-31')).toEqual({ base: 'USD', quote: 'TRY', rate: 40.1, date: '2026-05-22', source: 'TCMB' });
  });

  it('Y18 (inceleme): ağ hatası alan gün bir süre sonra arka planda yeniden indirilir', async () => {
    let up = false;
    const ok = fakeTcmb({ '2026-10-15': { USD: [40, 40.1] } });
    const calls: string[] = [];
    const fetcher: FxFetcher = async (url, signal) => {
      calls.push(url);
      if (!up) throw new Error('ECONNREFUSED');
      return ok.fetcher(url, signal);
    };
    const fx = new FxService({ fetcher, cacheDir: tmpCache(), backoffMs: [0], now: NOW, retryAfterMs: 30 });
    const first = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-10-15' }]);
    expect(first.failed).toEqual(['USD>TRY@2026-10-15']);
    up = true;
    await expect.poll(() => calls.length, { timeout: 2_000 }).toBe(4);
    await new Promise((r) => setTimeout(r, 20));
    const second = await fx.prefetch([{ base: 'USD', quote: 'TRY', date: '2026-10-15' }]);
    expect(second.rates.get('USD>TRY@2026-10-15')).toMatchObject({ rate: 40.05, date: '2026-10-15' });
    expect(second.rates.get('USD>TRY@2026-10-15')!.stale).toBeUndefined();
    expect(calls).toHaveLength(4);
  });

  it('prefetch: TCMB kapalıyken arka planda indirme başlamaz', async () => {
    const down = fakeTcmb({}, { down: true });
    const fx = new FxService({ fetcher: down.fetcher, cacheDir: tmpCache(), backoffMs: [0], now: NOW });
    await fx.prefetch(['2026-10-13', '2026-10-14', '2026-10-15'].map((date) => ({ base: 'USD', quote: 'TRY', date })));
    const after = down.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(down.calls.length).toBe(after);
  });

  it('bugün için today.xml; henüz yayımlanmadıysa dünkü kullanılır', async () => {
    const calls: string[] = [];
    const fetcher: FxFetcher = async (url) => {
      calls.push(url);
      if (url.endsWith('/today.xml')) return { status: 200, text: xml('03.11.2026', { USD: [42, 42.2] }) };
      return { status: 404, text: '' };
    };
    const fx = new FxService({ fetcher, cacheDir: null, now: NOW });
    const r = await fx.getRate('USD', 'TRY', '2026-11-04');
    expect(r).toMatchObject({ rate: 42.1, date: '2026-11-03' });
    expect(calls[0]).toMatch(/today\.xml$/);
  });
});

async function setup(app: FastifyInstance, auth: Auth) {
  const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: 'FedEx USD' } });
  const carrierId = c.json().carrier?.id ?? c.json().id;
  const tariff = await app.inject({
    method: 'POST',
    url: '/api/deciship/tariffs',
    headers: auth,
    payload: {
      carrierId,
      name: 'FedEx USD Test',
      currency: 'USD',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'A' }],
      rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'A', weightUpto: i + 1, price: (i + 1) * 10 })),
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  return carrierId as string;
}

async function measure(app: FastifyInstance, auth: Auth) {
  // 40×30×25 / 3000 = 10 kg ücretli → 100 USD
  const p = measurementPayload({ trackingRaw: uniq('7948') });
  const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.trackingNo as string;
}

async function importInvoice(
  app: FastifyInstance,
  auth: Auth,
  carrierId: string,
  invoiceDate: string,
  rows: { tracking: string; amount: number; date?: string }[],
) {
  const csv = ['Takip No;Tarih;Desi;Tutar', ...rows.map((r) => `${r.tracking};${r.date ?? '15.10.2026'};10;${r.amount}`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const res = await app.inject({
    method: 'POST',
    url: '/api/deciship/invoices',
    headers: auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate,
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', shipDate: 'Tarih', billedKg: 'Desi', netAmount: 'Tutar' },
      saveMapping: false,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().invoice.id as string;
  const l = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines`, headers: auth });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id, lines: l.json().items as Record<string, any>[] };
}

describe('fatura karşılaştırma: TRY fatura, USD tarife', () => {
  let t: ReturnType<typeof fakeTcmb>;
  beforeEach(() => {
    t = fakeTcmb({ '2026-10-15': { USD: [40, 40.1] }, '2026-10-16': { USD: [41, 41.1] } });
    setFxService(new FxService({ fetcher: t.fetcher, cacheDir: tmpCache(), now: NOW }));
  });

  it('kur uygulanır, tolerans ve hafta sonu düşüşü çalışır, rapor Kur kolonu dolu', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const carrierId = await setup(app, auth);
    const [a, b, c, d] = [await measure(app, auth), await measure(app, auth), await measure(app, auth), await measure(app, auth)];
    const inv = await importInvoice(app, auth, carrierId, '2026-10-15', [
      { tracking: a, amount: 4005 }, // 100 × 40,05
      { tracking: b, amount: 4050 }, // +%1,1 → kur farkı
      { tracking: c, amount: 4500 }, // fark
      { tracking: d, amount: 4105, date: '17.10.2026' }, // cumartesi → 16.10 (41,05) = 4.105,00
    ]);
    const by = new Map(inv.lines.map((l) => [l.trackingNo, l]));
    expect(by.get(a)).toMatchObject({
      status: 'MATCH',
      expectedAmount: 4005,
      diffAmount: 0,
      fx: { base: 'USD', quote: 'TRY', rate: 40.05, date: '2026-10-15', expected: 100 },
    });
    expect(by.get(a)!.breakdown.at(-1).label).toBe('Beklenen 100,00 USD × 40,0500 (TCMB 15.10.2026)');
    expect(by.get(b)).toMatchObject({ status: 'MATCH', diffAmount: 45, note: 'Kur farkı tolerans içinde (%1,5)' });
    expect(by.get(c)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 495 });
    expect(by.get(d)).toMatchObject({ status: 'MATCH', expectedAmount: 4105, fx: { date: '2026-10-16', requestedDate: '2026-10-17' } });
    // aynı gün bir kez indirilir
    expect(t.calls.filter((u) => u === tcmbUrl('2026-10-15'))).toHaveLength(1);

    const x = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/report.xlsx`, headers: auth });
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Tüm satırlar')!;
    const col = (ws.getRow(1).values as unknown[]).indexOf('Kur');
    expect(col).toBeGreaterThan(0);
    const texts = Array.from({ length: 4 }, (_, i) => String(ws.getRow(i + 2).getCell(col).value));
    expect(texts).toContain('1 USD = 40,0500 TRY (TCMB 15.10.2026)');
    expect(texts).toContain('1 USD = 41,0500 TRY (TCMB 16.10.2026, 17.10.2026 için)');
    const pdf = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/report.pdf`, headers: auth });
    expect(pdf.statusCode).toBe(200);
  });

  it('kur ağ hatasında fatura yine yüklenir, satır "Kur bulunamadı"; tolerans ayarı + yeniden karşılaştırma', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const carrierId = await setup(app, auth);
    const a = await measure(app, auth);
    setFxService(new FxService({ fetcher: fakeTcmb({}, { down: true }).fetcher, cacheDir: tmpCache(), backoffMs: [0], now: NOW }));
    const inv = await importInvoice(app, auth, carrierId, '2026-10-15', [{ tracking: a, amount: 4100 }]);
    expect(inv.lines[0]).toMatchObject({
      status: 'NO_TARIFF',
      note: 'Kur alınamadı (USD→TRY, 15.10.2026) — TCMB yanıt vermedi',
      fx: null,
    });
    const h = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}`, headers: auth });
    expect(h.json().invoice.totals).toMatchObject({ fxMissing: 1, comparedBilledTotal: 0, billedTotal: 4100 });

    // ağ geri geldi + tolerans %3: 4.100 (≈ %2,4) uyumlu
    setFxService(new FxService({ fetcher: t.fetcher, cacheDir: tmpCache(), now: NOW }));
    const s = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { fxTolerancePct: 3 } });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ fxTolerancePct: 3, fxSource: 'TCMB döviz alış/satış ortalaması' });
// KARARLAR "Geçmiş sonuçlar donar" (2026-11-10): ayar/tarife değişince fatura eski dayanağıyla kalır; yeni dayanağa recalculate ile geçilir.
    const r = await recalculate(app, auth, inv.id, { basis: 'rules' });
    const l = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines`, headers: auth });
    expect(l.json().items[0]).toMatchObject({ status: 'MATCH', diffAmount: 95, note: 'Kur farkı tolerans içinde (%3)' });
    expect(r.invoice.totals).toMatchObject({ fxMissing: 0, comparedBilledTotal: 4100, expectedTotal: 4005 });
  });

  it('ayar varsayılanı %1,5 ve kaynak salt okunur', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const s = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: auth });
    expect(s.json()).toMatchObject({ fxTolerancePct: 1.5, fxSource: 'TCMB döviz alış/satış ortalaması' });
    const bad = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { fxTolerancePct: 50 } });
    expect(bad.statusCode).toBe(400);
  });
});
