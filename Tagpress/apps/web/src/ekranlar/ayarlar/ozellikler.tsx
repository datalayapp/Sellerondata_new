import { FEATURE_GROUPS, type FeatureDef, type FeatureKey, type FeaturesResponse } from "@tagpress/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { changedFeatures, featureDictId, patchFeatures, refreshOrg, useFeatures } from "../../lib/features.ts";
import type { Go } from "../../lib/route.ts";
import { Button, PanelSection, Switch, Tag, useToast } from "../../tezgah/index.ts";
import { Giris, Yukleniyor, YuklemeHatasi } from "./veri.tsx";

/**
 * Özellikler (`GET`/`PATCH /api/features`): kayıttaki her özellik grubuyla, tek tıkla açılır ya da kapanır. Açarken
 * bağlı olduğu özellikler de açılır, kapatırken ona bağlı olanlar da kapanır (sunucu yazar; bildirim söyler).
 * Kapatmak veri silmez. "Kurulumu yeniden çalıştır" eski cevaplarla Kurulum'u açar.
 */
export default function Ozellikler({ go }: { go: Go }) {
  const { t } = useTranslation("settings");
  const q = useFeatures();
  const qc = useQueryClient();
  const toast = useToast();
  const name = (k: string) => t(`setup:feat.${featureDictId(k)}.name`);

  const toggle = useMutation({
    mutationFn: ({ key, on }: { key: FeatureKey; on: boolean }) => patchFeatures({ [key]: on }),
    onSuccess: (v: FeaturesResponse, { key }) => {
      const before = q.data?.effective;
      refreshOrg(qc, v);
      const also = changedFeatures(before, v.effective).filter((k) => k !== key);
      toast({
        message: also.length ? t("features.savedWith", { names: also.map(name).join(", ") }) : t("state.saved"),
        tone: "success",
      });
    },
    onError: (e) => toast({ message: serverText(e), tone: "error" }),
  });

  const v = q.data;
  const groups = v ? FEATURE_GROUPS.map((g) => ({ g, items: v.registry.filter((d) => d.group === g) })).filter((x) => x.items.length > 0) : [];

  return (
    <>
      <Giris>{t("features.intro")}</Giris>
      {q.isLoading && <Yukleniyor />}
      {q.error && <YuklemeHatasi error={q.error} retry={() => void q.refetch()} />}
      {groups.map(({ g, items }) => (
        <PanelSection key={g} heading={t(`features.groups.${g}`)}>
          <ul className="ay-list">
            {items.map((d: FeatureDef) => {
              const on = v?.effective[d.key] ?? false;
              return (
                <li key={d.key} className="ay-li">
                  <div className="ay-li-t">
                    <span className="ay-li-n">
                      <span>{name(d.key)}</span>
                      {d.paid !== "none" && <Tag>{t("features.paid")}</Tag>}
                    </span>
                    <span className="ay-li-s">{d.always ? t("features.always") : t(`setup:feat.${featureDictId(d.key)}.desc`)}</span>
                  </div>
                  <Switch checked={on} disabled={d.always || toggle.isPending} label={name(d.key)} onChange={(next) => toggle.mutate({ key: d.key, on: next })} />
                </li>
              );
            })}
          </ul>
        </PanelSection>
      ))}
      {v && (
        <PanelSection heading={t("features.setupTitle")}>
          <div className="ay-actions">
            <p className="ay-note">{t("features.setupHint")}</p>
            <span className="tz-sp" />
            <Button onClick={() => go("kurulum")}>{t("features.setup")}</Button>
          </div>
        </PanelSection>
      )}
    </>
  );
}
