import type { HubColumn, HubRow, Locale } from '@sellerondata/contracts';
import { DEFAULT_TIME_ZONE } from './time.ts';

/**
 * Merkez CSV'si, saf (her araçta aynı biçim). DeciShip `apps/api/src/services/hub/csv.ts` ile aynı çıktı; `test/pure.test.ts`
 * DeciShip'in örnekleriyle sınar.
 */

/** Excel UTF-8 işaretini görmezse Türkçe karakterler bozulur. */
export const CSV_BOM = '\uFEFF';

/** Türkçe Excel `;` ayırıcı ve ondalık virgül bekler; İngilizcede `,` ve nokta. */
export const csvSeparator = (locale: Locale) => (locale === 'tr' ? ';' : ',');

const formatters = new Map<string, Intl.DateTimeFormat>();
/** An firmanın saatinde yazılır: ekranla aynı gün. */
function dateTime(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' });
    formatters.set(timeZone, f);
  }
  return f;
}

function numberText(n: number, format: HubColumn['format'], locale: Locale): string {
  const text = format === 'money' ? n.toFixed(2) : String(n);
  return locale === 'tr' ? text.replace('.', ',') : text;
}

/**
 * Kullanıcı metni hücrede formül olarak çalışmasın (CSV enjeksiyonu). Excel baştaki boşluk ve satır sonlarını yutabilir:
 * formül karakteri onların arkasında da aranır. Tam genişlikli yazım da aynı işi görür.
 */
export const neutralizeCsv = (s: string) => (/^[\t\r\n]|^\s*[=+\-@＝＋－＠]/.test(s) ? `'${s}` : s);

function cellText(value: string | number | null | undefined, col: HubColumn, locale: Locale, timeZone: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return numberText(value, col.format, locale);
  if (col.format === 'datetime') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? neutralizeCsv(value) : dateTime(timeZone).format(d);
  }
  return neutralizeCsv(value);
}

function quote(s: string, sep: string): string {
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvHeader(columns: HubColumn[], locale: Locale): string {
  const sep = csvSeparator(locale);
  return `${CSV_BOM}${columns.map((c) => quote(neutralizeCsv(c.label), sep)).join(sep)}\r\n`;
}

export function csvRows(columns: HubColumn[], rows: HubRow[], locale: Locale, timeZone: string = DEFAULT_TIME_ZONE): string {
  const sep = csvSeparator(locale);
  let out = '';
  for (const r of rows) out += `${columns.map((c) => quote(cellText(r.cells[c.id], c, locale, timeZone), sep)).join(sep)}\r\n`;
  return out;
}
