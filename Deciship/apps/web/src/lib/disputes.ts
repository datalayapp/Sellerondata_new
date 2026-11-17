import type { DeadlineInfo } from '@deciship/core';
import type { DisputeResultView, DisputeRound, DisputeTtk, InvoiceDispute, PersonRef } from '../api/types';

/**
 * İtiraz takibinin saf yardımcıları (tarayıcısız sınanır): süre durumu, sonuç girişindeki toplamlar, form denetimi, geçmiş.
 * Metin yok; arayüz durum adını `disputes` ad alanında çevirir.
 */

// Kuruş tamsayısı (çekirdekteki `toCents` ile aynı sonuç; bu dosya tarayıcısız testte çekirdeği yüklemesin diye yerel).
const toCents = (n: number) => Math.round(Math.round(n * 1000) / 10);
const fromCents = (c: number) => c / 100;

export type DeadlineState = 'onTime' | 'late' | 'open' | 'soon' | 'today' | 'expired';

/**
 * Bir süre (TTK ya da taşıyıcı) için durum. Gönderilmişse sayaç durur: son güne kadar gönderildiyse "zamanında".
 * TTK'da sunucunun kararı (`ttkStatus`) varsa o geçerlidir.
 */
export function deadlineState(d: DeadlineInfo, sentOn?: string | null, ttkStatus?: DisputeTtk): DeadlineState {
  if (sentOn) {
    if (ttkStatus) return ttkStatus === 'ON_TIME' ? 'onTime' : 'late';
    return sentOn <= d.lastDay ? 'onTime' : 'late';
  }
  if (d.expired) return 'expired';
  if (d.daysLeft === 0) return 'today';
  return d.daysLeft <= 2 ? 'soon' : 'open';
}

/** Sonuç girişinde canlı toplam: talep, geri alınan, eksik kalan (kuruşla, kayan nokta hatasız). Boş tutar 0 sayılır. */
export function recoveryTotals(rows: { claimed?: number | null; amount: number | null }[]) {
  let c = 0;
  let r = 0;
  for (const x of rows) {
    c += toCents(x.claimed ?? 0);
    r += toCents(x.amount ?? 0);
  }
  return { claimed: fromCents(c), recovered: fromCents(r), shortfall: fromCents(Math.max(0, c - r)) };
}

/** Geri alınan tutar geçerli mi: 0 < tutar ≤ talep, en çok iki ondalık (talep bilinmiyorsa yalnız alt sınır). */
export function amountValid(amount: number | null, claimed?: number | null): boolean {
  if (amount == null || !Number.isFinite(amount) || toCents(amount) <= 0) return false;
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return false;
  return claimed == null || toCents(amount) <= toCents(claimed);
}

export type SendErrors = { sentOn?: 'required' | 'future' | 'beforeInvoice'; channelNote?: 'required' };

/** Gönderim formu: tarih bugünden sonra ve fatura tarihinden önce olamaz; "Diğer" kanalda açıklama zorunlu. Tarihler YYYY-MM-DD. */
export function validateSend(f: { sentOn: string; today: string; invoiceDate?: string | null; channel: string; channelNote: string }): SendErrors {
  const e: SendErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.sentOn)) e.sentOn = 'required';
  else if (f.sentOn > f.today) e.sentOn = 'future';
  else if (f.invoiceDate && f.sentOn < f.invoiceDate.slice(0, 10)) e.sentOn = 'beforeInvoice';
  if (f.channel === 'OTHER' && !f.channelNote.trim()) e.channelNote = 'required';
  return e;
}

/** Turda canlı (geri alınmamış) alacak dekontu var mı: varsa geri çekilemez (409 HAS_RECOVERED_RESULTS). */
export const hasLiveRecovery = (r: DisputeRound) => r.results.some((x) => x.kind === 'RECOVERED' && !x.revertedAt);

export type TimelineEvent =
  | { kind: 'sent'; at: string; round: DisputeRound; by: PersonRef }
  | { kind: 'result'; at: string; round: DisputeRound; result: DisputeResultView; by: PersonRef }
  | { kind: 'reverted'; at: string; round: DisputeRound; result: DisputeResultView; by: PersonRef | null }
  | { kind: 'withdrawn'; at: string; round: DisputeRound; by: PersonRef | null }
  | { kind: 'superseded'; at: string; round: DisputeRound; next: number };

/** Aynı anda olanlarda sıra (yeni önce): yeni tur, eskinin kapanması; giriş geri alma, geri çekme. */
const WEIGHT: Record<TimelineEvent['kind'], number> = { sent: 5, superseded: 4, withdrawn: 3, reverted: 2, result: 1 };

/** Denetim izi: bütün turların olayları, yeni önce. Geri alınan girişler ve geri çekilen turlar da yer alır. */
export function timelineOf(d: InvoiceDispute | null | undefined): TimelineEvent[] {
  if (!d) return [];
  const rounds = [...(d.active ? [d.active] : []), ...d.history];
  const out: TimelineEvent[] = [];
  for (const r of rounds) {
    out.push({ kind: 'sent', at: r.createdAt, round: r, by: r.sentBy });
    for (const x of r.results) {
      out.push({ kind: 'result', at: x.enteredAt, round: r, result: x, by: x.enteredBy });
      if (x.revertedAt) out.push({ kind: 'reverted', at: x.revertedAt, round: r, result: x, by: x.revertedBy });
    }
    if (r.withdrawnAt) out.push({ kind: 'withdrawn', at: r.withdrawnAt, round: r, by: r.withdrawnBy });
    const next = r.supersededById ? rounds.find((x) => x.id === r.supersededById) : null;
    if (next) out.push({ kind: 'superseded', at: r.supersededAt ?? next.createdAt, round: r, next: next.round });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || WEIGHT[b.kind] - WEIGHT[a.kind]);
}

/** Arayüzün kendi metniyle açıkladığı hata kodları (`disputes:errors.<KOD>`). Diğerleri sunucunun iletisiyle gösterilir. */
export const DISPUTE_ERROR_CODES = [
  'STALE',
  'DISPUTE_ACTIVE',
  'NO_SENDABLE_LINES',
  'LINE_NOT_PENDING',
  'AMOUNT_EXCEEDS_CLAIM',
  'REASON_REQUIRED',
  'CREDIT_NOTE_REQUIRED',
  'HAS_RECOVERED_RESULTS',
  'SENT_ON_IN_FUTURE',
  'RESULT_ON_IN_FUTURE',
  'RESULT_ON_BEFORE_SENT',
  'LINE_IN_DISPUTE',
  'INVOICE_HAS_DISPUTE',
  // 10-B3: metin üretildikten sonra itiraz listesi değişti; 10-B12: girişin satırları yeni turda; 10-B13: satırın kararı değişti
  'SELECTION_CHANGED',
  'RESULT_LINES_RESENT',
  'LINE_CHANGED',
] as const;

/** Bu hatadan sonra güncel kayıt yeniden okunmalı mı (başkası değiştirmiş). */
export const needsRefetch = (code: string) =>
  code === 'STALE' ||
  code === 'DISPUTE_ACTIVE' ||
  code === 'LINE_NOT_PENDING' ||
  code === 'HAS_RECOVERED_RESULTS' ||
  code === 'LINE_IN_DISPUTE' ||
  code === 'SELECTION_CHANGED' ||
  code === 'RESULT_LINES_RESENT' ||
  code === 'LINE_CHANGED';

/** Geri alınabilecek sonuç girişi ve turu (geri alma isteği turun `version`'ını taşır). */
export type RevertableResult = { result: DisputeResultView; round: DisputeRound };

/**
 * 10-B12: geri alınabilecek girişler, yeni önce. Etkin turun canlı girişleri ve yerini yeniye bırakmış (geri çekilmemiş)
 * turlardaki, satırlarından hiçbiri sonraki (geri çekilmemiş) bir turda yeniden talep edilmemiş canlı girişler (pratikte
 * yanlış girilmiş dekont). Sunucu aynı kuralı uygular (409 RESULT_LINES_RESENT).
 */
export function revertableResults(d: InvoiceDispute | null | undefined): RevertableResult[] {
  if (!d) return [];
  const rounds = [...(d.active ? [d.active] : []), ...d.history].filter((r) => !r.withdrawnAt);
  const out: RevertableResult[] = [];
  for (const r of rounds) {
    if (r !== d.active && !r.supersededAt && !r.supersededById) continue;
    const later = new Set(rounds.filter((x) => x.round > r.round).flatMap((x) => x.lines.map((l) => l.invoiceLineId)));
    for (const x of r.results) {
      if (x.revertedAt) continue;
      const lineIds = r.lines.filter((l) => x.lines.some((s) => s.disputeLineId === l.id)).map((l) => l.invoiceLineId);
      if (r !== d.active && lineIds.some((id) => later.has(id))) continue;
      out.push({ result: x, round: r });
    }
  }
  return out.sort((a, b) => b.result.enteredAt.localeCompare(a.result.enteredAt));
}
