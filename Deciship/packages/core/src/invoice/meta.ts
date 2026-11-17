import { normalizeHeader } from './normalize';
import { META_SYNONYMS } from './presets';
import type { ColumnMapping, MetaField, Table } from './types';
import { readDateOrder, type DateOrderReading } from './values';

const PATTERNS: Partial<Record<MetaField, RegExp>> = {
  invoiceNo: /^(.+ )?(invoice|fatura) (no|nr|number|num|numarasi|numara)$/,
  invoiceDate: /^(.+ )?(invoice|fatura) (date|tarihi|tarih)$/,
};
const NOT_META = /\b(hesap|account|kalem|line|satir|alternatif|alternate|kuru|rate|exchange)\b/;
/** "Inv #", "Invoice #", "Bill #": normalizeHeader `#` işaretini siler, yalın "Bill" ise tutar da olabilir. Ham başlığa bakılır. */
const NUMBER_SIGN = /^(inv\.?|invoice|bill|billing)\s*#$/i;

/**
 * Fatura düzeyi sütunları bulur: fatura no, fatura tarihi, faturanın ödenecek toplamı.
 * Önce META_SYNONYMS (presets.ts) tam eşleşme, sonra genel kalıp ("… Fatura Numarası", "… Invoice Date").
 * `rows` verilirse hep boş sütunlar atlanır.
 */
export function detectMetaColumns(headers: string[], rows?: string[][]): Partial<Record<MetaField, string>> {
  const nh = headers.map(normalizeHeader);
  const hasValue = (i: number) => !rows?.length || rows.some((r) => String(r[i] ?? '').trim() !== '');
  const out: Partial<Record<MetaField, string>> = {};
  for (const field of ['invoiceNo', 'invoiceDate', 'invoiceTotal'] as MetaField[]) {
    const syns = META_SYNONYMS[field].map(normalizeHeader);
    let idx = -1;
    for (const s of syns) {
      idx = nh.findIndex((h, i) => h === s && hasValue(i));
      if (idx >= 0) break;
    }
    if (idx < 0 && field === 'invoiceNo') idx = headers.findIndex((h, i) => NUMBER_SIGN.test(String(h ?? '').trim()) && hasValue(i));
    const re = PATTERNS[field];
    if (idx < 0 && re) idx = nh.findIndex((h, i) => re.test(h) && !NOT_META.test(h) && hasValue(i));
    if (idx >= 0) out[field] = headers[idx];
  }
  return out;
}

/**
 * Dosyanın tarih sırası. Gönderi ve fatura tarihi aynı dosyadadır, aynı biçimdedir: kanıt iki sütundan birlikte toplanır
 * ("10/15/2026" gönderi tarihi, "10/05/2026" fatura tarihini de ay/gün yapar). Eşlemedeki seçim yalnız değerlerden anlaşılmayan
 * dosyada geçerlidir: seçim taşıyıcıda hatırlanır, biçimi farklı sonraki dosyada kanıtı ezerse tarihler sessizce karışır.
 */
export function resolveDateOrder(t: Table, m: Partial<Pick<ColumnMapping, 'shipDate' | 'invoiceDate' | 'dateOrder'>> = {}): DateOrderReading {
  const invoiceDate = m.invoiceDate ?? detectMetaColumns(t.headers, t.rows).invoiceDate;
  const values: string[] = [];
  for (const h of new Set([m.shipDate, invoiceDate])) {
    const i = h ? t.headers.indexOf(h) : -1;
    if (i >= 0) for (const r of t.rows) values.push(String(r[i] ?? ''));
  }
  const reading = readDateOrder(values);
  // Seçim yalnız sorulan dosyada geçer: noktalı biçim sorulmaz, gün/ay okunur; kayıtlı ay/gün "05.10.2026"yı 10 Mayıs yapmasın.
  return reading.ambiguous && !reading.evident && (m.dateOrder === 'mdy' || m.dateOrder === 'dmy') ? { ...reading, order: m.dateOrder } : reading;
}
