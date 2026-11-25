import type { PrintKind, PrintSlot, PrintTemplate, Profile } from "@tagpress/domain";

export type { PrintKind, PrintSlot, PrintTemplate };
/** Baskı kuralları: tasarım dilinin (profil) `printing` bölümü. Eşikler koda gömülmez, buradan gelir. */
export type PrintRules = Profile["printing"];

/** Planlanacak bir sipariş (etiket ya da sticker). `designKey`: aynı numaralılar aynı karışık sayfaya girmez. */
export interface PlanOrder {
  jobId: string;
  variantId: string;
  orderNo: string;
  quantity: number;
  designKey: string | null;
}

/** Sticker siparişi: `wMm × hMm` sticker'ın mürekkep kutusudur (mm). */
export interface PlanStickerOrder extends PlanOrder {
  wMm: number;
  hMm: number;
}

/** Sayfadaki bir öğe. `xMm,yMm` etiketin/sticker kutusunun MERKEZİ (kağıdın sol üstünden, mm). */
export interface PlannedItem {
  jobId: string;
  variantId: string;
  slotId: string | null;
  xMm: number;
  yMm: number;
  /** Sipariş adedinin üstündeki fazlalık. */
  extra: boolean;
  /** Yalnızca yeniden planlamada: elle konmuş öğe, olduğu gibi korundu. */
  manual?: boolean;
}

export interface PlannedCellLabel {
  jobId: string;
  slotId: string | null;
  /** Yazının sol üst köşesi (mm). */
  xMm: number;
  yMm: number;
  text: string;
}

export interface PlannedPage {
  name: string;
  kind: "full" | "mixed";
  /** Bu sayfadan kaç baskı (tek siparişin dolu sayfaları). */
  copies: number;
  items: PlannedItem[];
  cellLabels: PlannedCellLabel[];
  /** Yalnızca yeniden planlamada: kilitsiz giriş sayfasının dizini (korunan sayfa); yeni sayfada null. */
  fromIndex?: number | null;
}
