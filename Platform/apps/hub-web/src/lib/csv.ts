import { saveBlob } from '@sellerondata/shell';
import { safeCell } from './csvCell.ts';

/** Türkçe Excel `;` ayraç ve ondalık virgül bekler (Veriler CSV'siyle aynı biçim). Başındaki BOM Türkçe karakterleri korur. */
export function toCsv(rows: (string | number | null | undefined)[][], locale: string): string {
  const sep = locale === 'tr' ? ';' : ',';
  const body = rows
    .map((r) =>
      r
        .map((v) => safeCell(v, locale === 'tr'))
        .map((c) => (c.includes(sep) || c.includes('"') || c.includes('\n') ? `"${c.replaceAll('"', '""')}"` : c))
        .join(sep),
    )
    .join('\r\n');
  return `\uFEFF${body}`;
}

export function downloadCsv(name: string, rows: (string | number | null | undefined)[][], locale: string) {
  saveBlob(new Blob([toCsv(rows, locale)], { type: 'text/csv;charset=utf-8' }), name.endsWith('.csv') ? name : `${name}.csv`);
}
