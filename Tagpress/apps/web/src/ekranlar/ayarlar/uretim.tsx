import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { useLanguage } from "../../lib/language.tsx";
import { CollapsedGroup, Field, NumberStepper, PanelSection, Segmented, Select } from "../../tezgah/index.ts";
import { Giris, usePatchSettings, useSettings, Yukleniyor, YuklemeHatasi } from "./veri.tsx";

export default function Uretim() {
  const { t } = useTranslation("settings");
  const q = useSettings();
  const patch = usePatchSettings();
  const { languages } = useLanguage();
  const s = q.data?.settings;

  return (
    <>
      <Giris>{t("production.intro")}</Giris>
      {q.isLoading && <Yukleniyor />}
      {q.error && <YuklemeHatasi error={q.error} retry={() => void q.refetch()} />}
      {s && (
        <PanelSection>
          <div className="ay-form">
            <Field label={t("production.variants.label")} hint={t("production.variants.hint")}>
              <Segmented
                aria-label={t("production.variants.aria")}
                value={String(s.variantsPerRun) as "1" | "2" | "3"}
                onChange={(v) => v !== String(s.variantsPerRun) && patch.mutate({ variantsPerRun: Number(v) })}
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ]}
              />
            </Field>
            <Field label={t("production.language.label")} hint={t("production.language.hint")}>
              <Select
                value={s.defaultLanguageId ?? ""}
                onChange={(v) => patch.mutate({ defaultLanguageId: v || null })}
                options={[
                  ...(s.defaultLanguageId ? [] : [{ value: "", label: t("production.language.notChosen") }]),
                  ...languages.map((l) => ({ value: l.id, label: l.name })),
                ]}
              />
            </Field>
            <CollapsedGroup title={t("production.advanced")} summary={t("production.advancedSummary")} persistKey="ayarlar.uretim">
              <div className="ay-form">
                <Field label={t("production.concurrency.label")} hint={t("production.concurrency.hint")}>
                  <NumberStepper
                    aria-label={t("production.concurrency.aria")}
                    decreaseLabel={t("production.concurrency.decrease")}
                    increaseLabel={t("production.concurrency.increase")}
                    value={s.concurrency}
                    step={1}
                    min={1}
                    max={8}
                    format={(v) => formatNumber(v)}
                    onChange={(v) => v !== s.concurrency && patch.mutate({ concurrency: Math.round(v) })}
                  />
                </Field>
              </div>
            </CollapsedGroup>
          </div>
        </PanelSection>
      )}
    </>
  );
}
