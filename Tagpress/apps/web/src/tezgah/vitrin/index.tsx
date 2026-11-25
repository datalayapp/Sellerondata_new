import { useTranslation } from "react-i18next";
import type { EkranProps } from "../../lib/route.ts";
import { AppFrame, WorkRow } from "../cerceve/cerceve.tsx";
import TemelVitrin from "./temel.tsx";
import TuvalVitrin from "./tuval.tsx";
import "./vitrin.css";

/**
 * Bileşen vitrini (`#/vitrin`, yalnız geliştirmede). İki sekme: `#/vitrin` temel (T1: vitrin/temel.tsx),
 * `#/vitrin/tuval` tuval ve katmanlar (T2: vitrin/tuval.tsx). Yeni bileşen o dosyalara bir `<section>` olarak eklenir.
 */
export default function Vitrin({ route, go }: EkranProps) {
  const { t } = useTranslation(["frame", "showcase", "showcaseCanvas"]);
  const tab = route.rest[0] === "tuval" ? "tuval" : "temel";
  return (
    <AppFrame
      band="work"
      active={null}
      workRow={
        <WorkRow
          crumbs={[{ label: t("frame:routes.showcase") }]}
          tabs={{
            items: [
              { id: "temel", label: t("showcase:title") },
              { id: "tuval", label: t("showcaseCanvas:title") },
            ],
            value: tab,
            onChange: (id) => go("vitrin", id === "tuval" ? ["tuval"] : [], undefined, true),
          }}
        />
      }
    >
      <div className="tz-vitrin">{tab === "tuval" ? <TuvalVitrin /> : <TemelVitrin />}</div>
    </AppFrame>
  );
}
