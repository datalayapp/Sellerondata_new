import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bucketize,
  createSlotCounter,
  csvHeader,
  csvRows,
  isTimeZone,
  makePeriod,
  MAX_RANGE_DAYS,
  previousPeriod,
  releaseWhenBoth,
  resolvePeriod,
  validDay,
  zonedDate,
} from '../src/pure/index.ts';

/**
 * `@sellerondata/product-kit/pure`, DeciShip'teki kopyalarla aynı davranış. Girdi ve beklenen çıktı DeciShip API testlerinden
 * (dosya ve test adı her bloğun başında); DeciShip kodu buradan içe aktarılmaz (paket DeciShip'e bağlanmaz).
 */

describe('dönem (DeciShip test/hub/access.test.ts "tarih aralığı", services/hub/period.ts)', () => {
  const issue = (q: Record<string, string>) => {
    const r = resolvePeriod(q, '2026-10-31');
    return 'issue' in r ? r.issue : null;
  };

  it('geçersiz ve fazla uzun aralık reddedilir; Şubat 30 kabul edilmez', () => {
    expect(issue({ from: '2026-02-30', to: '2026-03-01' })).toBe('dateFormat');
    expect(issue({ from: '2026-10-10', to: '2026-10-01' })).toBe('dateOrder');
    expect(issue({ from: '2020-01-01', to: '2026-01-01' })).toBe('dateRange');
    // access.test.ts "hata metni dile göre": `from=bozuk`
    expect(issue({ from: 'bozuk' })).toBe('dateFormat');
    expect(MAX_RANGE_DAYS).toBe(732);
  });

  it('verilmezse son 30 gün (firmanın günü `today`)', () => {
    const r = resolvePeriod({}, '2026-11-01');
    expect('period' in r && [r.period.from, r.period.to, r.period.days]).toEqual(['2026-10-03', '2026-11-01', 30]);
    // yalnız `to`: ondan geriye 30 gün
    const onlyTo = resolvePeriod({ to: '2026-10-31' }, '2026-11-15');
    expect('period' in onlyTo && onlyTo.period.from).toBe('2026-10-02');
  });

  it('DeciShip ile aynı sınırlar: yıl 2000–2999, en çok 732 gün dahil', () => {
    for (const bad of ['1999-12-31', '3000-01-01', '2026-2-01', 20260101, null]) expect(validDay(bad)).toBe(false);
    expect(validDay('2026-02-28')).toBe(true);
    const longest = resolvePeriod({ from: '2026-01-01', to: '2028-01-02' }, '2026-01-01');
    expect('period' in longest && longest.period.days).toBe(732);
    expect('issue' in resolvePeriod({ from: '2026-01-01', to: '2028-01-03' }, '2026-01-01')).toBe(true);
  });

  it('dönem sınırları UTC gece yarısı; önceki dönem aynı uzunlukta', () => {
    const p = makePeriod('2026-10-01', '2026-10-31');
    expect([p.start.toISOString(), p.end.toISOString(), p.days]).toEqual(['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 31]);
    expect(previousPeriod(p)).toMatchObject({ from: '2026-08-31', to: '2026-09-30', days: 31 });
  });

  it('grafik (DeciShip test/hub/consistency.test.ts: Kasım ayının ilk noktası 1 Kasım); bugünden sonrası null', () => {
    const nov = bucketize(makePeriod('2026-11-01', '2026-11-30'), (d) => (d === '2026-11-01' ? 1 : 0), { today: '2026-11-03' });
    expect(nov[0]).toEqual({ x: '2026-11-01', y: 1 });
    expect(nov.slice(1, 4).map((p) => p.y)).toEqual([0, 0, null]);
    expect(nov).toHaveLength(30);
    // 62 günden uzun: haftalık, 200 günden uzun: 30 günlük
    expect(bucketize(makePeriod('2026-01-01', '2026-04-30'), () => 1)).toHaveLength(18);
    expect(bucketize(makePeriod('2025-01-01', '2026-12-31'), () => 1)).toHaveLength(25);
  });
});

describe('saat dilimi (DeciShip test/hub/consistency.test.ts, test/reviewFindings.test.ts "O10")', () => {
  it('firmanın günü', () => {
    expect(zonedDate(new Date('2026-10-31T21:30:00.000Z'), 'Europe/Istanbul')).toBe('2026-11-01');
    expect(zonedDate(new Date('2026-10-31T21:30:00.000Z'), 'UTC')).toBe('2026-10-31');
  });

  it('yalnız IANA adı', () => {
    for (const bad of ['+03:00', '-05:00', 'GMT+3', 'EST', 'utc+3', 'Foo/Bar', '03:00', 'Europe/', '/Istanbul']) expect(isTimeZone(bad), bad).toBe(false);
    for (const ok of ['Europe/Istanbul', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Etc/GMT+3']) expect(isTimeZone(ok), ok).toBe(true);
  });
});

describe('CSV (DeciShip test/reviewFindings.test.ts "CSV: satır sonu ve boşlukla gizlenen formül de etkisiz; tarih firma saatinde")', () => {
  it('formül etkisiz; tarih firma saatinde', () => {
    const col = { id: 'a', label: 'A', format: 'text' as const };
    const cell = (v: string) => csvRows([col], [{ id: '1', cells: { a: v } }], 'en', 'UTC');
    for (const v of ['\n=1+1', ' =1+1', '\t=1+1', '\r=1+1', '  @SUM(A1)', '\n\n+1', '＝1+1']) expect(cell(v), JSON.stringify(v)).toContain(`'`);
    expect(cell('normal')).toBe('normal\r\n');
    const when = { id: 'w', label: 'W', format: 'datetime' as const };
    const row = [{ id: '1', cells: { w: '2026-10-15T22:30:00.000Z' } }];
    expect(csvRows([when], row, 'en', 'UTC')).toBe('2026-10-15 22:30\r\n');
    expect(csvRows([when], row, 'en', 'Europe/Istanbul')).toBe('2026-10-16 01:30\r\n');
    expect(csvRows([when], row, 'en', 'America/New_York')).toBe('2026-10-15 18:30\r\n');
  });

  it('dile göre ayırıcı ve ondalık, BOM, tırnak (DeciShip services/hub/csv.ts)', () => {
    const cols = [
      { id: 'a', label: 'Ad', format: 'text' as const },
      { id: 'b', label: 'Tutar', format: 'money' as const },
    ];
    expect(csvHeader(cols, 'tr')).toBe('\uFEFFAd;Tutar\r\n');
    expect(csvHeader(cols, 'en')).toBe('\uFEFFAd,Tutar\r\n');
    expect(csvRows(cols, [{ id: '1', cells: { a: 'x;y', b: 12.5 } }], 'tr')).toBe('"x;y";12,50\r\n');
    expect(csvRows(cols, [{ id: '1', cells: { a: 'a"b', b: null } }], 'en')).toBe('"a""b",\r\n');
  });
});

describe('yuva sayacı (DeciShip services/hub/limiter.ts kuralı)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('havuz ve firma başına sınır; bırakma bir kez sayılır', () => {
    const slots = createSlotCounter<'general' | 'export'>((p) => (p === 'export' ? 1 : 2));
    const a = slots.take('general', 'o1');
    const b = slots.take('general', 'o1');
    expect(slots.take('general', 'o1')).toBeNull();
    expect(slots.take('general', 'o2')).not.toBeNull();
    const e = slots.take('export', 'o1');
    expect(e).not.toBeNull();
    expect(slots.take('export', 'o1')).toBeNull();
    expect(slots.inUse('o1')).toBe(3);
    a!();
    a!();
    expect(slots.inUse('o1')).toBe(2);
    expect(slots.take('general', 'o1')).not.toBeNull();
    b!();
    e!();
    expect(slots.inUse('o1')).toBe(1);
  });

  it('yuva işleyici bitince VE yanıt kapanınca bırakılır (sıra önemsiz); koruyucu süre dolarsa bırakılır ve bağlantı kesilir', () => {
    const released: string[] = [];
    const expired: string[] = [];
    const one = releaseWhenBoth(() => released.push('1'), 1000, () => expired.push('1'));
    one.responseClosed();
    expect(released).toEqual([]);
    one.handlerDone();
    expect(released).toEqual(['1']);
    const two = releaseWhenBoth(() => released.push('2'), 1000, () => expired.push('2'));
    two.handlerDone();
    expect(released).toEqual(['1']);
    two.responseClosed();
    two.responseClosed();
    expect(released).toEqual(['1', '2']);
    // ikisinden biri hiç gelmez: süre dolunca bir kez bırakılır, sonra gelen işaret etkisiz
    const stuck = releaseWhenBoth(() => released.push('3'), 1000, () => expired.push('3'));
    stuck.handlerDone();
    vi.advanceTimersByTime(999);
    expect(released).toEqual(['1', '2']);
    vi.advanceTimersByTime(1);
    expect([released, expired]).toEqual([['1', '2', '3'], ['3']]);
    stuck.responseClosed();
    vi.advanceTimersByTime(5000);
    expect([released, expired]).toEqual([['1', '2', '3'], ['3']]);
  });
});
