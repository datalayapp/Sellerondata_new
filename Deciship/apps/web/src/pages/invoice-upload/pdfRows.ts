/**
 * Elle eklenen PDF satırının no'su (Y23): mevcut en büyük no + 1. Yapay zekâ satırlarının no'su okuma sırasıdır (0 tabanlı,
 * takip no'suz satırlar dahil); sabit taban (eski 10000) 10.000+ satırlı okumada onlarla çakışırdı. Boş listede 0.
 */
export function nextPdfRowIndex(rows: readonly { rowIndex: number }[]): number {
  return rows.reduce((m, r) => Math.max(m, Number.isFinite(r.rowIndex) ? r.rowIndex : -1), -1) + 1;
}
