import type { ImportReport, OverchargeByType, ReconStep } from "../../api/types";

/** Y20: PDF okumasının notu; `key` sözlükte `importReport.read.<key>`. Sıra ve birbirini dışlayanlar API uyarısıyla aynı. */
export type ReadNoteKey =
  | "vatUnverified"
  | "vatAssumed"
  | "weightUnusable"
  | "weightAssumed"
  | "weightLb"
  | "weightG"
  | "weightKept"
  | "dimUnusable"
  | "dimAssumed"
  | "dimIn"
  | "unitsMixed";
export interface ReadNote {
  key: ReadNoteKey;
  /** KDV oranı (yüzde) */
  pct?: number;
  /** satır sayısı */
  n?: number;
}

export function readNotes(r: ImportReport["pdfRead"]): ReadNote[] {
  if (!r) return [];
  const out: ReadNote[] = [];
  if (r.vatUnverified) out.push({ key: "vatUnverified", pct: r.vatPct });
  else if (r.vatAssumed) out.push({ key: "vatAssumed", pct: r.vatPct });
  if (r.weightUnusable) out.push({ key: "weightUnusable" });
  else if (r.weightAssumed) out.push({ key: "weightAssumed" });
  if (r.weightUnit === "lb") out.push({ key: "weightLb" });
  else if (r.weightUnit === "g") out.push({ key: "weightG" });
  if (r.weightKeptLines) out.push({ key: "weightKept", n: r.weightKeptLines });
  if (r.dimUnusable) out.push({ key: "dimUnusable" });
  else if (r.dimAssumed) out.push({ key: "dimAssumed" });
  if (r.dimUnit === "in") out.push({ key: "dimIn" });
  if (r.unitsMixed) out.push({ key: "unitsMixed" });
  return out;
}

/** Özet kartındaki tek satır uyarının parçaları; gösterilecek bir şey yoksa null. */
export interface ImportNotice {
  skipped: number;
  /** takip no'suz ücret satırı sayısı ve tutarı (tutar yoksa undefined) */
  noTracking: number;
  noTrackingAmount?: number;
  pdfUnverified: number;
  pdfNone: boolean;
  /** içe aktarmada PDF karşılaştırması o an yapılamadı (metin katmanı yok değil) */
  pdfSkipped: boolean;
  /** Y31: PDF metninde geçen ama okunmamış olabilecek takip no sayısı */
  pdfMissed: number;
  /** Y31: PDF metni çok büyüktü, okunmamış satır denetimi yapılamadı */
  pdfMissedTooLarge: boolean;
  /** Y20: KDV oranı ve birimlerle ilgili notlar (varsayım, doğrulanamayan oran, çeviri) */
  readNotes: ReadNote[];
}

export function importReportNotice(report: ImportReport | null | undefined): ImportNotice | null {
  if (!report) return null;
  const skipped = report.skippedCount ?? 0;
  const pdfUnverified = report.pdfCheck?.unverified ?? 0;
  const pdfNone = report.pdfCheck?.method === "none";
  const pdfSkipped = report.pdfCheck?.method === "skipped";
  const pdfMissed = report.pdfMissed?.count ?? 0;
  const pdfMissedTooLarge = report.pdfMissed?.tooLarge === true;
  const notes = readNotes(report.pdfRead);
  if (skipped <= 0 && pdfUnverified <= 0 && !pdfNone && !pdfSkipped && pdfMissed <= 0 && !pdfMissedTooLarge && !notes.length) return null;
  const noTracking = report.byReason?.NO_TRACKING ?? 0;
  return {
    skipped,
    noTracking,
    noTrackingAmount: noTracking > 0 ? report.noTrackingAmount : undefined,
    pdfUnverified,
    pdfNone,
    pdfSkipped,
    pdfMissed,
    pdfMissedTooLarge,
    readNotes: notes,
  };
}

/**
 * Penceredeki değer sütunu: satırı alınmayan yapan değer. Tutarı okunamayan satırda okunamayan tutar ("abc") gösterilir,
 * takip no yanına yazılır (yalnız takip no gösterilince kullanıcı neyin bozuk olduğunu göremiyordu).
 */
export function skippedValue(r: ImportReport["skippedRows"][number]): { kind: "raw" | "amount" | "none"; text?: string; amount?: number } {
  if (r.reason === "BAD_NET" && r.rawNet != null) return { kind: "raw", text: r.trackingRaw ? `${r.trackingRaw} · "${r.rawNet}"` : `"${r.rawNet}"` };
  if (r.trackingRaw) return { kind: "raw", text: r.trackingRaw };
  if (r.rawNet) return { kind: "raw", text: r.rawNet };
  if (r.amount != null) return { kind: "amount", amount: r.amount };
  return { kind: "none" };
}

export const IMPORT_REPORT_ROW_LIMIT = 200;

/** Tutarı 0 olan adım gösterilmez; sıra korunur. */
export function visibleSteps(steps: ReconStep[] | undefined): ReconStep[] {
  return (steps ?? []).filter((s) => s.amount !== 0);
}

/** Satırı ve tutarı olmayan tür satırları elenir. */
export function visibleByType(rows: OverchargeByType[] | undefined): OverchargeByType[] {
  return (rows ?? []).filter((r) => r.lines > 0 || r.amount !== 0);
}
