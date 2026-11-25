import { validKey } from "./templateList.ts";

/**
 * Şablon yükleme ve "temadan üret" pencerelerinin doğrulaması (saf). Metin yok: sorun kodu döner, ekran sözlükten
 * okur (`templates:upload.problem.*`, `templates:generate.keyError.*`).
 */

export type UploadStatus = "idle" | "busy" | "ok" | "error";

export interface UploadRowLike {
  key: string;
  status: UploadStatus;
}

/** `invalidKey`: boş ya da / \ ? # % : * " < > | içeriyor; `duplicate`: aynı anahtar iki dosyada. */
export type UploadProblem = "invalidKey" | "duplicate";

export interface UploadPlan<T extends UploadRowLike> {
  /** Henüz yüklenmemiş satırlar (yüklenenler listede kalır ama tekrar gönderilmez). */
  pending: T[];
  /** Satır başına sorun (yüklenmiş satırda yok). */
  problems: Array<UploadProblem | null>;
  /** Var olan anahtarın üzerine yazacak satırların anahtarları. */
  overwrites: string[];
  canUpload: boolean;
}

export function uploadPlan<T extends UploadRowLike>(rows: readonly T[], existing: ReadonlySet<string>, busy: boolean): UploadPlan<T> {
  const pending = rows.filter((r) => r.status !== "ok");
  const counts = new Map<string, number>();
  for (const r of pending) counts.set(r.key.trim(), (counts.get(r.key.trim()) ?? 0) + 1);
  const problemOf = (r: T): UploadProblem | null => (!validKey(r.key) ? "invalidKey" : (counts.get(r.key.trim()) ?? 0) > 1 ? "duplicate" : null);
  const problems = rows.map((r) => (r.status === "ok" ? null : problemOf(r)));
  return {
    pending,
    problems,
    overwrites: pending.filter((r) => existing.has(r.key.trim())).map((r) => r.key.trim()),
    canUpload: pending.length > 0 && pending.every((r) => !problemOf(r)) && !busy,
  };
}

/** Yükleme bitti: bütün satırlar yüklendiyse pencere kapanır. */
export function allUploaded(rows: readonly UploadRowLike[]): boolean {
  return rows.every((r) => r.status === "ok");
}

/** "Temadan şablon üret" (ücretli): tema en az 3 harf; anahtar boş olabilir, doluysa geçerli ve yeni olmalı. */
export function generateCheck(input: { theme: string; key: string }, existing: ReadonlySet<string>, pending: boolean): { keyError: "exists" | "invalid" | null; can: boolean } {
  const key = input.key.trim();
  const keyError = key === "" ? null : existing.has(key) ? "exists" : !validKey(input.key) ? "invalid" : null;
  return { keyError, can: input.theme.trim().length >= 3 && keyError === null && !pending };
}

/** Sunucuya giden üretim gövdesi: boş isteğe bağlı alanlar gönderilmez. */
export function generateBody(input: { theme: string; sample: string; key: string }): { theme: string; sampleText?: string; key?: string } {
  return { theme: input.theme.trim(), ...(input.sample.trim() && { sampleText: input.sample.trim() }), ...(input.key.trim() && { key: input.key.trim() }) };
}
