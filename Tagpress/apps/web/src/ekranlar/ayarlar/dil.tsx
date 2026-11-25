import { useTranslation } from "react-i18next";
import { changeLocale, type Locale } from "../../i18n/index.ts";
import { isLocale } from "../../i18n/locale.ts";
import { Field, PanelSection, Segmented } from "../../tezgah/index.ts";
import { Giris } from "./veri.tsx";

/**
 * Arayüz dili (eski "Görünüm" bölümünün yerine; koyu tema kaldırıldı, tema seçimi yok). Seçim `changeLocale` ile
 * yerel kayda ve `sod_lang` çerezine yazılır, ekran anında çevrilir.
 */
export default function Dil() {
  const { t, i18n } = useTranslation("settings");
  const value: Locale = isLocale(i18n.language) ? i18n.language : "en";
  return (
    <>
      <Giris>{t("language.intro")}</Giris>
      <PanelSection>
        <Field label={t("language.label")} hint={t("language.hint")}>
          <Segmented<Locale>
            aria-label={t("language.aria")}
            value={value}
            onChange={changeLocale}
            options={[
              // Dillerin kendi adları: hangi dilde olursa olsun aynı yazılır.
              { value: "tr", label: "Türkçe" }, // i18n-ok: dilin kendi adı
              { value: "en", label: "English" },
            ]}
          />
        </Field>
      </PanelSection>
    </>
  );
}
