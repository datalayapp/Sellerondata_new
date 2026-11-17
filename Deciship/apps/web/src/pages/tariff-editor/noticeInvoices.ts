/**
 * Tarife bildiriminin fatura satırları. `affected` toplu önizlemenin kapsamı (bu tarifeye düşen ama bugünkü sürümünde olmayan
 * faturalar): öneri ve "Yeni tarifeye geçir" yalnız onlar için çıkar. `other` başka tarifeye düşer: düğme vaat edilmez, ne
 * yapılacağı söylenir.
 */
export function noticeInvoices(notice: { affected: number; other?: number; recompared?: unknown }) {
  return { suggestRecompare: notice.affected > 0 && !notice.recompared, otherInvoices: notice.other ?? 0 };
}

/** Kaydetme sonrası bildirim: kullanan ya da başka tarifede fiyatlanan fatura varsa gösterilir; yoksa toast yeter. */
export const hasSavedNotice = (r: { affectedInvoices: number; otherInvoices: number }) => r.affectedInvoices > 0 || r.otherInvoices > 0;
