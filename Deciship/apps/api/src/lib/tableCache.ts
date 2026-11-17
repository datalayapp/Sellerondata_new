/**
 * Fatura önizlemesinin okunmuş tabloları (06-B1, 19-B7): doğrulama ve yapay zekâ eşleme her eşleme değişikliğinde dosyayı
 * yeniden okumasın diye API belleğinde tutulur. Eskiden yalnız sayıyla (8 tablo) sınırlıydı: 100.000 x 60'lık bir tablo
 * yaklaşık 220 MB tuttuğundan birkaç büyük dosya API'nin 1 GB'lık yığınını doldurup süreci düşürüyordu.
 *
 * Kurallar:
 * - Toplam tahmini boyut `INVOICE_TABLE_CACHE_MB` (varsayılan 150) ve en çok `TABLE_CACHE_MAX_ENTRIES` tablo; aşılınca en uzun
 *   süredir kullanılmayan bırakılır. Tek başına toplam sınırı aşan tablo hiç tutulmaz: her doğrulamada dosyadan yeniden okunur
 *   (dosya çalışanında; sonuç aynı, yalnız daha yavaş). `0`: önbellek kapalı.
 * - `INVOICE_TABLE_CACHE_TTL_MS` (varsayılan 15 dk) kullanılmayan tablo düşer (içe aktarılmadan bırakılan önizleme).
 * - İçe aktarma ve önizlemeden vazgeçme girdiyi siler (`routes/invoices.ts`).
 * - Boyut tahmini ucuzdur: hücre ve karakter sayısı tam sayılır, yalnız iki baytlık karakter payı en çok `SAMPLE_ROWS`
 *   satırdan kestirilir (V8 dizgesi ~16 bayt + karakter başına 1 bayt, Latin-1 dışı karakterde 2, 8 bayta hizalı; dizi
 *   başına 16 + hücre başına 8 bayt). Ölçü yaklaşıktır; amaç bellek tavanı, tam hesap değil (100.000 x 60'lık tabloda
 *   ölçülen 220 MB).
 */
import type { Table } from '@deciship/core';
import { env } from '../env.ts';

const MB = 1024 * 1024;
export const TABLE_CACHE_MAX_ENTRIES = 8;
const SAMPLE_ROWS = 256;
const STRING_HEADER = 16;
const ARRAY_HEADER = 16;
const POINTER = 8;

/** Latin-1 dışı karakter (Türkçe ş, ğ, ı…) dizgeyi iki baytlık yapar. */
function isWide(s: string): boolean {
  // eslint-disable-next-line no-control-regex -- aralığın başı (U+0000) bilerek: Latin-1 dışı karakter aranıyor
  return /[^\u0000-ÿ]/.test(s);
}

function stringBytes(s: string): number {
  const chars = isWide(s) ? s.length * 2 : s.length;
  // V8 nesneleri 8 bayta hizalanır
  return STRING_HEADER + Math.ceil(chars / 8) * 8;
}

function rowBytes(row: readonly string[]): number {
  let n = ARRAY_HEADER + row.length * POINTER;
  for (const c of row) n += typeof c === 'string' ? stringBytes(c) : POINTER;
  return n;
}

/**
 * Tablonun API yığınında tuttuğu yaklaşık bayt. Hücre sayısı ve karakter sayısı tam sayılır (bütün hücrelerde yalnız
 * `length` okunur: 100.000 x 60'lık tabloda ~40 ms); yalnız iki baytlık (Latin-1 dışı) karakter payı `SAMPLE_ROWS` satırdan
 * kestirilir. Mesaj 6 bağımsız inceleme: tahmin eskiden tamamen örneklemeydi; uzun metin hücreleri örneklenmeyen satırlarda
 * toplanınca (ör. dosyanın başında 300 satırlık açıklama bloğu) tahmin gerçeğin onda birine düşüp bayt sınırı deliniyordu.
 * Şimdi en kötü durumda düşük tahmin karakter baytlarının iki katıyla sınırlıdır.
 */
export function estimateTableBytes(t: Table): number {
  const rows = t.rows.length;
  let bytes = ARRAY_HEADER + rows * POINTER + rowBytes(t.headers) + (t.numeric?.byteLength ?? 0);
  let chars = 0;
  for (const r of t.rows) {
    bytes += ARRAY_HEADER + r.length * POINTER;
    for (const c of r) {
      if (typeof c !== 'string') {
        bytes += POINTER;
        continue;
      }
      // tek baytlık dizge: başlık + 8 bayta hizalı karakterler
      bytes += STRING_HEADER + Math.ceil(c.length / 8) * 8;
      chars += c.length;
    }
  }
  // Latin-1 dışı karakterli dizgeler iki baytlıktır: örnek satırlardaki payları kadar ek
  let sampleChars = 0;
  let sampleWide = 0;
  const step = rows <= SAMPLE_ROWS ? 1 : rows / SAMPLE_ROWS;
  for (let i = 0; i < Math.min(rows, SAMPLE_ROWS); i++) {
    for (const c of t.rows[Math.floor(i * step)]!) {
      if (typeof c !== 'string') continue;
      sampleChars += c.length;
      if (isWide(c)) sampleWide += c.length;
    }
  }
  if (sampleChars > 0) bytes += chars * (sampleWide / sampleChars);
  return Math.ceil(bytes);
}

type Entry = { table: Table; bytes: number; usedAt: number };

export type TableCacheLimits = { maxBytes: number; ttlMs: number; maxEntries: number };

function envLimits(): TableCacheLimits {
  return { maxBytes: env.invoiceTableCacheMb * MB, ttlMs: env.invoiceTableCacheTtlMs, maxEntries: TABLE_CACHE_MAX_ENTRIES };
}

/** Bayt, süre ve sayıyla sınırlı, en az yakın zamanda kullanılanı bırakan önbellek. Sınırlar her işlemde yeniden okunur. */
export class TableCache {
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly limits: () => TableCacheLimits = envLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): Table | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (this.now() - e.usedAt > this.limits().ttlMs) {
      this.delete(id);
      return undefined;
    }
    // en sona taşı: Map sırası "en eski kullanılan önce"
    this.entries.delete(id);
    e.usedAt = this.now();
    this.entries.set(id, e);
    return e.table;
  }

  /** Tabloyu tutar; sınırı tek başına aşıyorsa tutmaz (false). Aynı kimliğin eski girdisi her durumda kalkar. */
  set(id: string, table: Table): boolean {
    this.delete(id);
    const { maxBytes, maxEntries } = this.limits();
    const bytes = estimateTableBytes(table);
    if (maxBytes <= 0 || bytes > maxBytes) return false;
    this.entries.set(id, { table, bytes, usedAt: this.now() });
    this.total += bytes;
    this.sweepExpired();
    for (const [oldId] of this.entries) {
      if (this.total <= maxBytes && this.entries.size <= maxEntries) break;
      if (oldId === id) break;
      this.delete(oldId);
    }
    this.armSweeper();
    return true;
  }

  delete(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.total -= e.bytes;
    if (!this.entries.size) this.disarmSweeper();
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
    this.disarmSweeper();
  }

  /** Testler ve tanı: girdi sayısı, toplam tahmini bayt, kimlikler (en eski önce). */
  stats() {
    return { entries: this.entries.size, bytes: this.total, ids: [...this.entries.keys()] };
  }

  private sweepExpired() {
    const ttl = this.limits().ttlMs;
    const now = this.now();
    for (const [id, e] of this.entries) if (now - e.usedAt > ttl) this.delete(id);
  }

  /** Kullanılmayan tablo istek gelmese de süresi dolunca bırakılsın; zamanlayıcı süreci açık tutmaz. */
  private armSweeper() {
    if (this.sweeper || !this.entries.size) return;
    this.sweeper = setInterval(() => this.sweepExpired(), Math.min(60_000, Math.max(1_000, this.limits().ttlMs)));
    this.sweeper.unref();
  }

  private disarmSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
