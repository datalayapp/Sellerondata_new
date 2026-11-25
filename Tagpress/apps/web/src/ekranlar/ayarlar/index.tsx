import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { type AccessNeed, useAccess } from "../../lib/access.ts";
import type { EkranProps, Go } from "../../lib/route.ts";
import { AppFrame, CenterColumn, Icon, type IconName, Panel, Workspace, WorkRow } from "../../tezgah/index.ts";
import "./ayarlar.css";
import Baglantilar from "./baglantilar.tsx";
import Dil from "./dil.tsx";
import Firma from "./firma.tsx";
import Fontlar from "./fontlar.tsx";
import Maliyet from "./maliyet.tsx";
import Ozellikler from "./ozellikler.tsx";
import TasarimDilleri from "./tasarim-dilleri.tsx";
import Uretim from "./uretim.tsx";

type Bolum = "baglantilar" | "uretim" | "fontlar" | "maliyet" | "tasarim-dilleri" | "ozellikler" | "firma" | "dil";

/**
 * `need`: bölümü görmek için gereken yetki (`lib/access.ts`). Yönetim bölümleri (anahtarlar, üretim ayarları, maliyet,
 * özellikler ve kurulum) yalnız yönetebilene görünür; sunucu aynı uçlarda 403 verir.
 */
const BOLUMLER: Array<{ id: Bolum; icon: IconName; Body: ComponentType<{ go: Go }>; need?: AccessNeed }> = [
  { id: "baglantilar", icon: "key", Body: Baglantilar, need: "manage" },
  { id: "uretim", icon: "gear", Body: Uretim, need: "manage" },
  { id: "fontlar", icon: "font", Body: Fontlar },
  { id: "maliyet", icon: "coins", Body: Maliyet, need: "manage" },
  { id: "tasarim-dilleri", icon: "book", Body: TasarimDilleri },
  { id: "ozellikler", icon: "list", Body: Ozellikler, need: "manage" },
  { id: "firma", icon: "bldg", Body: Firma },
  { id: "dil", icon: "globe", Body: Dil },
];

/** Eski adres: Görünüm bölümü Dil'e taşındı. */
const ESKI: Record<string, Bolum> = { gorunum: "dil" };

/** Ayarlar: solda bölüm listesi, ortada en çok 720 px genişlikte form sütunu. Rota `#/ayarlar/<bölüm>`. */
export default function AyarlarEkrani({ route, go }: EkranProps) {
  const { t } = useTranslation("settings");
  const access = useAccess();
  const wanted = route.rest[0];
  const id = (wanted && ESKI[wanted]) ?? wanted;
  const shown = BOLUMLER.filter((b) => !b.need || access[b.need]);
  const active = shown.find((b) => b.id === id) ?? shown[0];
  if (!active) return null;
  const Body = active.Body;
  const name = (b: Bolum) => t(NAMES[b]);
  return (
    <AppFrame
      band="work"
      active="ayarlar"
      workRow={<WorkRow crumbs={[{ label: t("title"), onClick: () => go("ayarlar") }, { label: name(active.id) }]} />}
    >
      <Workspace
        leftWidth={260}
        left={
          <Panel side="left">
            <nav className="ay-gl" aria-label={t("nav")}>
              {shown.map((b) => (
                <button key={b.id} type="button" className="ay-gl-b" aria-current={b.id === active.id ? "page" : undefined} onClick={() => go("ayarlar", [b.id])}>
                  <Icon name={b.icon} size={15} />
                  {name(b.id)}
                </button>
              ))}
            </nav>
          </Panel>
        }
      >
        <CenterColumn>
          <div className="ay-scroll">
            <div className="ay-col">
              <h2 className="ay-h">{name(active.id)}</h2>
              <Body key={active.id} go={go} />
            </div>
          </div>
        </CenterColumn>
      </Workspace>
    </AppFrame>
  );
}

const NAMES = {
  baglantilar: "sections.connections",
  uretim: "sections.production",
  fontlar: "sections.fonts",
  maliyet: "sections.cost",
  "tasarim-dilleri": "sections.designLanguages",
  ozellikler: "sections.features",
  firma: "sections.org",
  dil: "sections.language",
} as const;
