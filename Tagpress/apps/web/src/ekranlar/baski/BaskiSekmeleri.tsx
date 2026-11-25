import { useTranslation } from "react-i18next";
import type { Go } from "../../lib/route.ts";
import type { BandTabs } from "../../tezgah/index.ts";

/** Baskı'nın üç bölümü (iş satırındaki sekmeler): `#/baski/masa[/<oturum>]`, `#/baski/sablonlar[/<id>]`, `#/baski/arsiv`. */
export type BaskiBolum = "masa" | "sablonlar" | "arsiv";

const BOLUMLER: readonly BaskiBolum[] = ["masa", "sablonlar", "arsiv"];
const LABEL: Record<BaskiBolum, string> = { masa: "tabs.desk", sablonlar: "tabs.templates", arsiv: "tabs.archive" };

/**
 * İş satırının sekmeleri: Masa / Sayfa şablonları / Arşiv. Baskı'nın her bölümü (Sayfa şablonları ve Arşiv ekranları
 * dahil) `<WorkRow tabs={useBaskiSekmeleri("arsiv", go)} />` ile aynı sekmeleri gösterir.
 */
export function useBaskiSekmeleri(value: BaskiBolum, go: Go): BandTabs {
  const { t } = useTranslation("printDesk");
  return {
    items: BOLUMLER.map((id) => ({ id, label: t(LABEL[id]) })),
    value,
    onChange: (id) => {
      if (id === value) return;
      go("baski", id === "masa" ? ["masa"] : [id]);
    },
  };
}
