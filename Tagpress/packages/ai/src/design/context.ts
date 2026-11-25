import type { BreakExample } from "./similar.ts";
import type { DesignIntent, Profile } from "@tagpress/domain";
import type { FontAvailability } from "./fonts.ts";

/** Şablonun AI'a giden özeti. Hesabı sunucu yapar (templates/engine geometrisinden); burada yalnızca anlatılır. */
export interface TemplateSummary {
  key?: string;
  /** Şablonun kısa tarifi (Template.notes). */
  notes?: string;
  tags?: string[];
  /** Serbest yazı alanının en/boy oranı. */
  areaAspect?: number;
  /**
   * Alanın birkaç yüksekliğindeki kullanılabilir genişlik, ana fontun tipik puntosunda karakter cinsinden
   * (ör. { at: 0.5, chars: 18 } = alanın ortasında ~18 karakter).
   */
  widthHints?: Array<{ at: number; chars: number }>;
  /** Üstte kurdele bandı (kesim çapına oran), 0 = yok. */
  ribbonTop?: number;
  printedText?: boolean;
  darkBackground?: boolean;
}

export interface DesignImages {
  /** Şablonun basılı hali. */
  template?: Buffer;
  /** Yazı alanı yeşil işaretli görsel. */
  area?: Buffer;
  /** Kullanıcının bu şablondaki gerçek bitmiş etiketleri. */
  references?: Buffer[];
  /** Revizyonda başlangıç varyasyonunun önizlemesi. */
  revisionBase?: Buffer;
}

export interface DesignContext {
  /** Müşteri metni (normalizeText sonrası). */
  text: string;
  /** Müşterinin satır ipuçları. */
  segments?: string[];
  /** Tasarım dili (profil v2). İstem bundan üretilir. */
  profile: Profile;
  template?: TemplateSummary;
  /** Bu iş için font kataloğu; verilmezse profilden (büyük harf sınırıyla) hesaplanır. */
  fonts?: FontAvailability[];
  /** Önceki varyasyonların satır bölmeleri (yeni adaylar bunlardan farklı olmalı). */
  previous?: Array<{ lines: string[] }>;
  /** İşe özel AI notu. */
  aiNote?: string;
  /** Revizyon: önceki niyet + istenen değişiklik. */
  revision?: { intent: DesignIntent; request: string };
  /** Aday sayısı (varsayılan 3). */
  candidates?: number;
  images?: DesignImages;
  /** Kullanıcının geçmiş işlerinden bu metne en benzer bölmeler (yalnızca öğrenme kümesi). */
  similar?: BreakExample[];
}
