import { z } from 'zod';

/** `contains`/`startsWith` için LIKE kaçışı: Prisma `%` ve `_` karakterlerini kaçışlamaz, `q=%` her satırı bulurdu. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type DecimalLike = { toString(): string } | number | string | null | undefined;

export function num(v: DecimalLike): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

export function numOrNull(v: DecimalLike): number | null {
  if (v === null || v === undefined) return null;
  return num(v);
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export function paged<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize };
}

export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export const idParam = z.object({ id: z.string().min(1) });

/**
 * Olay döngüsünü bir tur bırakır (19-B1): uzun eşzamanlı işin parçaları arasında başka isteklerin (ölçüm, sağlık, başka firma)
 * sırası gelsin. Sonucu değiştirmez; yalnız arada bekleyen G/Ç ve zamanlayıcılar çalışır.
 */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Uzun döngülerin dilim boyu: bu kadar satırdan sonra olay döngüsü bırakılır. */
export const YIELD_EVERY_ROWS = 2_000;

/** `xs.map(f)` ile aynı sonuç (sıra korunur), `YIELD_EVERY_ROWS` öğede bir olay döngüsü molasıyla. */
export async function mapSliced<T, R>(xs: readonly T[], f: (x: T) => R): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && i % YIELD_EVERY_ROWS === 0) await yieldToLoop();
    out[i] = f(xs[i]!);
  }
  return out;
}

export function sum(values: number[]): number {
  return Math.round(values.reduce((a, b) => a + Math.round(b * 100), 0)) / 100;
}

/** Parses "YYYY-MM-DD" (or full ISO) into a Date; date-only values are UTC midnight. */
export function parseDateInput(s: string | undefined | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  // JS "2026-02-31" değerini 3 Mart'a kaydırır: takvimde olmayan gün geçersizdir.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (ymd) {
    const chk = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    if (chk.toISOString().slice(0, 10) !== `${ymd[1]}-${ymd[2]}-${ymd[3]}`) return undefined;
  }
  return d;
}

/** Fatura numarası: görünmez/biçim karakterleri (sıfır genişlikli, yumuşak tire, BOM) atılır, NFKC uygulanır, kenar boşluğu kırpılır. */
export function normInvoiceNo(s: string): string {
  return s.normalize('NFKC').replace(/[\p{Cf}]/gu, '').trim();
}

/** Karşılaştırma anahtarı: normInvoiceNo + büyük/küçük harf yok + Türkçe İ/ı = i. */
export function invoiceNoKey(s: string): string {
  return normInvoiceNo(s).replace(/\u0130/g, 'i').toLowerCase().replace(/\u0131/g, 'i'); // I ve dotless i -> i
}

/**
 * Gün alanı (fatura tarihi, tarife geçerliliği): "2026-10-15" → 2026-10-15 UTC gece yarısı. Saatli değer
 * ("2026-10-15T00:00:00+03:00", "2026-10-14T21:00:00.000Z") Türkiye saatindeki güne çevrilir — aksi hâlde Türkiye gece
 * yarısı (UTC 21:00) bir önceki güne düşer, tarife geçerliliği ve TCMB kur günü kayardı. Geçersizse undefined.
 */
export function parseDayInput(s: string | undefined | null): Date | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseDateInput(`${t}T00:00:00.000Z`);
  const d = parseDateInput(t);
  if (!d) return undefined;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parseDateInput(`${day}T00:00:00.000Z`);
}
