import { apiUrl } from "../../../lib/platform.ts";
import type { SideLines } from "./compare.ts";

/**
 * SÖZLEŞMEDE OLMAYAN uçlar. Arayüz bunları aşağıdaki biçimde bekler; sunucu 404/405/501 dönerse ekran
 * "henüz bağlı değil" durumunu gösterir. Biçimler `packages/domain/src/api.ts`'e eklenmek üzere önerilmiştir.
 */

/** POST /api/languages/:lang/profile/try — taslak ve yayınlanmış profille örnek siparişleri dener. */
export const TRIAL_PATH = "/api/languages/:lang/profile/try";

export interface TrialSample {
  id: string;
  text: string;
  templateKey: string | null;
  labelSize?: string | null;
  /** Varsa bitmiş etiketin son hâli (referans). */
  referenceId?: string | null;
}

export interface TrialRequest {
  samples: TrialSample[];
  /** Hangi profillerle üretilsin. */
  profiles: Array<"published" | "draft">;
  /** true: üretmez, yalnızca tahmini maliyeti döner. */
  dryRun?: boolean;
  /** "ai": gerçek AI tasarımcı (ücretli, varsayılan); "engine": AI'sız motor tekrarı (ücretsiz). */
  mode?: TrialMode;
}

export type TrialMode = "ai" | "engine";

export interface TrialSide extends SideLines {
  previewUrl: string;
  issues: number;
  costUsd: number | null;
}

export interface TrialResult {
  sampleId: string;
  published: TrialSide | null;
  draft: TrialSide | null;
  error?: string | null;
}

export interface TrialResponse {
  estimateUsd: number | null;
  results: TrialResult[];
}

/** GET /api/languages/:lang/design-session — Claude Code ile tasarım dili oluşturma oturumunun canlı durumu. */
export const SESSION_PATH = "/api/languages/:lang/design-session";

export interface DesignSessionEntry {
  at: string;
  kind: "question" | "answer" | "draft-write" | "trial" | "note";
  text: string;
  /** draft-write: taslakta değişen alan yolları. */
  paths?: string[];
}

export interface DesignSession {
  status: "idle" | "asking" | "drafting" | "trying" | "done";
  updatedAt: string | null;
  entries: DesignSessionEntry[];
}

/** GET /api/references/:id/image.png — referansın bitmiş etiket görseli (Reference.image doluysa). */
export function referenceImageUrl(id: string): string {
  return apiUrl(`/api/references/${encodeURIComponent(id)}/image.png`);
}

/** Sunucu ucu henüz yok mu? (404, 405, 501) */
export function isNotConnected(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}
