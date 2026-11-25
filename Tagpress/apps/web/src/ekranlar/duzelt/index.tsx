import type { ReactNode } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { activeTab, type EkranProps } from "../../lib/route.ts";
import { AppFrame, CenterColumn, type Crumb, EmptyState, Workspace, WorkRow } from "../../tezgah/index.ts";
import { DuzeltCalisma, Hata } from "./Calisma.tsx";
import { backRoute } from "./donus.ts";
import { useDuzeltModel } from "./useDuzeltModel.ts";

/**
 * Düzelt (`#/duzelt/<varyantId>?don=<adres>`, maket 2): bir varyasyonun yazısını elle ayarlayan tam ekran düzenleyici.
 * Kaydet ya da Vazgeç `don` adresine döner (yoksa Üretim); üst menüde etkin sekme `don` adresininki.
 * Üretim ve Baskı masası artık aynı düzenleyiciyi yerinde açılan pencerede açar (`gomulu.tsx`); bu adres eski
 * bağlantılar için durur.
 */
export default function DuzeltEkrani({ route, go }: EkranProps) {
  const { t } = useTranslation("adjust");
  const variantId = route.rest[0] ?? null;
  const don = route.query.get("don");
  const leave = useCallback(() => {
    const r = backRoute(don);
    go(r.id, r.rest, r.query, true);
  }, [don, go]);

  const m = useDuzeltModel(variantId);
  const job = m.state === "error" ? undefined : m.job;
  const variant = m.state === "error" ? undefined : m.variant;
  const name = job?.text.split(/\r?\n/)[0]?.trim();
  const crumbs = (back: () => void): Crumb[] => [
    { label: name ? (name.length > 32 ? `${name.slice(0, 31)}…` : name) : t("frame:routes.adjust"), onClick: back },
    ...(variant ? [{ label: job?.orderNo ? t("title.withOrder", { order: job.orderNo, no: variant.no }) : t("title.variant", { no: variant.no }) }] : []),
  ];
  const frame = (body: ReactNode, back: () => void) => (
    <AppFrame band="work" active={activeTab(route)} workRow={<WorkRow back={{ command: "duzelt.cancel", onClick: back }} crumbs={crumbs(back)} />}>
      {body}
    </AppFrame>
  );
  const centered = (body: ReactNode) => (
    <Workspace>
      <CenterColumn>{body}</CenterColumn>
    </Workspace>
  );

  if (m.state === "error") {
    return frame(
      centered(
        <Hata title={m.notAdjustable ? t("error.notAdjustable") : t("error.open")} body={m.notAdjustable ? t("error.notAdjustableBody") : variantId ? serverText(m.error) : t("error.noVariant")} onBack={leave} />,
      ),
      leave,
    );
  }
  if (m.state === "loading") return frame(centered(<EmptyState icon="layout" title={t("loading")} />), leave);
  return <DuzeltCalisma key={variantId} variantId={m.model.variantId} model={m.model} frameMm={m.frameMm} onLeave={leave} wrap={(body, d) => frame(body, () => void d.exit())} />;
}
