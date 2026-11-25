import { fromCents, round2, toCents } from './calc';
import { disputeDeadlines, ttkApplies } from './invoiceHints';

/**
 * İtiraz takibinin saf hesabı: talep kuralı, tur ve fatura toplamları, durum, TTK'ya göre zamanında mı.
 * API ve testler aynı fonksiyonu kullanır; para hep kuruş tamsayısıyla toplanır, para birimleri toplanmaz.
 */

export type DisputeLineOutcome = 'PENDING' | 'RECOVERED' | 'REJECTED';
export type InvoiceDisputeStatus = 'NONE' | 'SENT' | 'CLOSED';
export type DisputeTtkStatus = 'ON_TIME' | 'LATE';

/** Talep hesabına giren satır alanları (itiraz metni ve paket aynı kuralı kullanır). */
export type ClaimInput = {
  diffTypes: readonly string[];
  billedAmount: number;
  diffAmount: number | null;
  decision?: 'OPEN' | 'VERIFIED' | 'ACCEPTED' | null;
  status?: 'MATCH' | 'DIFF' | 'UNMATCHED' | 'NO_TARIFF' | null;
};

/** Satırın talebi: mükerrer satırda faturalanan tutarın tamamı, diğerlerinde fark. Negatif talep olmaz. */
export function disputeClaim(l: Pick<ClaimInput, 'diffTypes' | 'billedAmount' | 'diffAmount'>): number {
  const raw = l.diffTypes.includes('DUPLICATE') ? l.billedAmount : (l.diffAmount ?? 0);
  return Math.max(0, round2(raw));
}

/**
 * İtiraz edilebilir satır: "İtiraz listesinde" (VERIFIED; karar verilmemişse çağıran süzmüştür), güncel karşılaştırmada
 * "Fark var" (durum verilmemişse sayılır) ve talebi sıfırdan büyük.
 */
export function isDisputable(l: ClaimInput): boolean {
  return (l.decision == null || l.decision === 'VERIFIED') && (l.status == null || l.status === 'DIFF') && disputeClaim(l) > 0;
}

export type DisputeSums = {
  claimedAmount: number;
  recoveredAmount: number;
  rejectedAmount: number;
  pendingAmount: number;
  shortfallAmount: number;
};

export type DisputeLineFact = { claimedAmount: number; outcome: DisputeLineOutcome; recoveredAmount: number | null };

export function emptyDisputeSums(): DisputeSums {
  return { claimedAmount: 0, recoveredAmount: 0, rejectedAmount: 0, pendingAmount: 0, shortfallAmount: 0 };
}

/**
 * Satırların toplamı. talep = geri alınan + eksik kalan + reddedilen + bekleyen (kuruşu kuruşuna).
 * Kısmi geri almada eksik kalan = talep − geri alınan; geri alınan talebi aşmışsa (olmamalı) eksik kalan 0 sayılmaz, eksi yazılmaz.
 */
export function disputeSums(lines: readonly DisputeLineFact[]): DisputeSums {
  let claimed = 0;
  let recovered = 0;
  let rejected = 0;
  let pending = 0;
  let shortfall = 0;
  for (const l of lines) {
    const c = toCents(l.claimedAmount);
    claimed += c;
    if (l.outcome === 'RECOVERED') {
      const r = toCents(l.recoveredAmount ?? 0);
      recovered += r;
      shortfall += Math.max(0, c - r);
    } else if (l.outcome === 'REJECTED') rejected += c;
    else pending += c;
  }
  return {
    claimedAmount: fromCents(claimed),
    recoveredAmount: fromCents(recovered),
    rejectedAmount: fromCents(rejected),
    pendingAmount: fromCents(pending),
    shortfallAmount: fromCents(shortfall),
  };
}

/** İki toplamı birleştirir (aynı para biriminde olmalı: çağıran para birimine göre gruplar). */
export function addDisputeSums(a: DisputeSums, b: DisputeSums): DisputeSums {
  const add = (x: number, y: number) => fromCents(toCents(x) + toCents(y));
  return {
    claimedAmount: add(a.claimedAmount, b.claimedAmount),
    recoveredAmount: add(a.recoveredAmount, b.recoveredAmount),
    rejectedAmount: add(a.rejectedAmount, b.rejectedAmount),
    pendingAmount: add(a.pendingAmount, b.pendingAmount),
    shortfallAmount: add(a.shortfallAmount, b.shortfallAmount),
  };
}

/**
 * Faturanın geçerli itiraz satırları: her fatura satırı için geri çekilmemiş en son turdaki satır. Yeniden göndermede
 * geri alınan satır yeni tura girmez; eski turdaki sonucu fatura toplamında sayılmaya devam eder.
 *
 * 10-B12: en son satır yerini yeniye bırakmış (`superseded`) bir turdaysa `RECOVERED` ya da (K38, kullanıcı kararı
 * 2026-11-13) `REJECTED` ise geçerlidir: reddedilmiş satırın yeniden talebi geri çekildiyse taşıyıcının son cevabı reddir;
 * yalnız fatura satırı hâlâ itiraz listesindeyken (`listed`; verilmezse öyle sayılır). O
 * turda sonuçsuz kalan en son satır (önceki turdaki giriş geri alındı ya da yeniden gönderilen tur geri çekildi) yeniden
 * gönderilecek satırdır: "gönderilmemiş" sayılır, burada sayılmaz (iki kez sayılmasın). API
 * `disputeFacts`, `lineDisputeStates` ve Merkez `hub/metrics.ts` aynı kuralı SQL ile uygular. `superseded` ya da `outcome`
 * verilmezse yalnız ilk kural.
 */
export function effectiveDisputeLines<
  T extends { invoiceLineId: string; round: number; withdrawn: boolean; superseded?: boolean; outcome?: DisputeLineOutcome; listed?: boolean },
>(
  lines: readonly T[],
): T[] {
  const best = new Map<string, T>();
  for (const l of lines) {
    if (l.withdrawn) continue;
    const prev = best.get(l.invoiceLineId);
    if (!prev || l.round > prev.round) best.set(l.invoiceLineId, l);
  }
  return [...best.values()].filter(
    (l) => !l.superseded || l.outcome === undefined || l.outcome === 'RECOVERED' || (l.outcome === 'REJECTED' && l.listed !== false),
  );
}

/** Etkin tur yoksa NONE; etkin turda sonuçsuz satır varsa SENT, yoksa CLOSED. */
export function invoiceDisputeStatus(hasActiveRound: boolean, pendingLines: number): InvoiceDisputeStatus {
  if (!hasActiveRound) return 'NONE';
  return pendingLines > 0 ? 'SENT' : 'CLOSED';
}

/**
 * TTK m.21/2: gönderim TTK son gününe kadarsa zamanında. TTK yalnız Türkiye firmasında uygulanır, değilse null.
 * Tarihler YYYY-MM-DD; fatura tarihi geçersizse null.
 */
export function disputeTtkStatus(invoiceDate: string | null | undefined, sentOn: string, country: string | null | undefined): DisputeTtkStatus | null {
  if (!ttkApplies(country)) return null;
  // Son gün bugüne göre değil fatura tarihine göredir: bugün olarak gönderim günü verilir.
  const ttk = disputeDeadlines(invoiceDate, null, sentOn, country)?.ttk;
  if (!ttk) return null;
  return sentOn <= ttk.lastDay ? 'ON_TIME' : 'LATE';
}

export type RecoveredAmountCheck = 'OK' | 'NOT_POSITIVE' | 'EXCEEDS_CLAIM';

/** Geri alınan pay: 0 < tutar ≤ talep (kuruşla karşılaştırılır). */
export function checkRecoveredAmount(claimed: number, amount: number): RecoveredAmountCheck {
  const a = toCents(amount);
  if (!Number.isFinite(amount) || a <= 0) return 'NOT_POSITIVE';
  return a > toCents(claimed) ? 'EXCEEDS_CLAIM' : 'OK';
}
