import "./masa/kisayollar.ts";
import "./masa/masa.css";
import { useTranslation } from "react-i18next";
import type { EkranProps } from "../../lib/route.ts";
import { useDesignLanguage } from "../../ortak/index.ts";
import { AppFrame, Button, CenterColumn, EmptyState, Workspace, WorkRow } from "../../tezgah/index.ts";
import ArsivEkrani from "./arsiv/index.tsx";
import { type BaskiBolum, useBaskiSekmeleri } from "./BaskiSekmeleri.tsx";
import { Masa } from "./masa/Masa.tsx";
import SayfaSablonlariEkrani from "./sablonlar/index.tsx";

/**
 * Baskı (maket 4): `#/baski` ve `#/baski/masa/<oturum>` baskı masası. `#/baski/sablonlar[/<id>]` ve `#/baski/arsiv`
 * kendi ekranlarına gider (`tezgah/rotalar.tsx`); buraya düşerse de aynı ekranlar açılır.
 */
export default function BaskiEkrani({ route, go }: EkranProps) {
  const first = route.rest[0];
  const view: BaskiBolum = first === "sablonlar" || first === "arsiv" ? first : "masa";
  const { current, loading } = useDesignLanguage();
  if (view === "sablonlar") return <SayfaSablonlariEkrani route={route} go={go} />;
  if (view === "arsiv") return <ArsivEkrani route={route} go={go} />;
  if (!current) return <DilYok loading={loading} go={go} />;
  return <Masa key={current.id} languageId={current.id} sessionId={first === "masa" ? (route.rest[1] ?? null) : null} go={go} />;
}

/** Tasarım dili yokken (ya da yüklenirken): baskı şablonları ve kurallar tasarım diline bağlı. */
function DilYok({ loading, go }: { loading: boolean; go: EkranProps["go"] }) {
  const { t } = useTranslation("printDesk");
  const tabs = useBaskiSekmeleri("masa", go);
  return (
    <AppFrame band="work" active="baski" workRow={<WorkRow crumbs={[{ label: t("title") }]} tabs={tabs} />}>
      <Workspace>
        <CenterColumn>
          {loading ? (
            <div className="bm-wait" aria-busy="true" />
          ) : (
            <EmptyState
              icon="print"
              title={t("empty.noLanguage")}
              body={t("empty.noLanguageBody")}
              action={
                <Button variant="primary" onClick={() => go("ayarlar", ["tasarim-dilleri"])}>
                  {t("empty.toLanguages")}
                </Button>
              }
            />
          )}
        </CenterColumn>
      </Workspace>
    </AppFrame>
  );
}
