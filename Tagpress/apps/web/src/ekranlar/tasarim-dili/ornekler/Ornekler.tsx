import { API, ptToPx, type Reference } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import { api, path } from "../../../lib/api.ts";
import { useReferences, useWork } from "../mantik/work.tsx";
import {
  Button,
  CenterColumn,
  EmptyState,
  IconButton,
  Panel,
  PanelSection,
  SearchField,
  Segmented,
  StatusDot,
  Tabs,
  ToolDivider,
  ToolSpacer,
  ToolStrip,
  Tooltip,
  useToast,
  Workspace,
} from "../../../tezgah/index.ts";
import { num } from "../dil.ts";
import { RefGorsel } from "./RefGorsel.tsx";
import "./ornekler.css";

type SplitFilter = "all" | "train" | "test";

/** Kart görselinin kenarı (mm; tuval dışında gerçek mm ≈ 113 px). */
const CARD_MM = 30;
const PANEL_MM = 30;

/** "№ 8812 · 60 adet · A15" gibi kısa künye. */
export function useRefMeta() {
  const { t } = useTranslation("designLanguageLab");
  return (r: Reference, extra: Array<string | null> = []) =>
    [r.orderNo ? t("ref.orderNo", { no: r.orderNo }) : null, r.quantity ? t("ref.quantity", { count: r.quantity }) : null, r.templateKey, ...extra].filter(Boolean).join(" · ");
}

/**
 * Örnekler: ortada küme süzgeci, arama ve bitmiş etiket kartları; seçili örneğin ayrıntısı sağ panelde (son hâl, programın
 * önerisi, satırlar, kaynak, Öğrenme / Test seçimi). Örnek eklemek Oluştur akışından.
 */
export default function Ornekler({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const refs = useReferences(w.languageId);
  const [split, setSplit] = useState<SplitFilter>("all");
  const [q, setQ] = useState("");
  // undefined: henüz seçilmedi (ilk kart açık gelir); null: kullanıcı paneli kapattı.
  const [open, setOpen] = useState<string | null | undefined>(undefined);

  const all = useMemo(() => refs.data ?? [], [refs.data]);
  const list = useMemo(() => {
    const term = q.trim().toLocaleLowerCase("tr");
    return all.filter((r) => (split === "all" || r.split === split) && (!term || `${r.text} ${r.orderNo ?? ""} ${r.templateKey ?? ""}`.toLocaleLowerCase("tr").includes(term)));
  }, [all, split, q]);
  const counts = { all: all.length, train: all.filter((r) => r.split === "train").length, test: all.filter((r) => r.split === "test").length };
  const current = open === undefined ? (list[0] ?? null) : (all.find((r) => r.id === open) ?? null);

  const body = refs.isLoading ? (
    <div className="td-or-bos">
      <StatusDot tone="busy" label={t("ornekler.loading")} />
    </div>
  ) : refs.isError ? (
    <div className="td-or-bos">
      <EmptyState icon="warn" title={t("ornekler.loadFailed")} body={serverText(refs.error)} action={<Button onClick={() => void refs.refetch()}>{t("ornekler.retry")}</Button>} />
    </div>
  ) : all.length === 0 ? (
    <div className="td-or-bos">
      <EmptyState
        icon="img"
        title={t("ornekler.empty")}
        body={t("ornekler.emptyBody")}
        action={
          <Button variant="primary" onClick={onCreate}>
            {t("ornekler.howTo")}
          </Button>
        }
      />
    </div>
  ) : list.length === 0 ? (
    <div className="td-or-bos">
      <EmptyState icon="search" title={t("ornekler.noMatch")} body={t("ornekler.noMatchBody")} />
    </div>
  ) : (
    <ul className="td-or-kartlar" aria-label={t("ornekler.listLabel")}>
      {list.map((r) => (
        <li key={r.id}>
          <button type="button" className="td-or-kart" aria-current={r.id === current?.id || undefined} aria-label={t("ornekler.open", { text: r.text })} onClick={() => setOpen(r.id)}>
            <RefGorsel reference={r} mm={CARD_MM} />
            <span className="td-or-m">
              <b>{r.text}</b>
              <small>{[r.orderNo ? t("ref.orderNo", { no: r.orderNo }) : null, r.templateKey, t(`split.${r.split}`)].filter(Boolean).join(" · ")}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <Workspace rightWidth={330} right={all.length > 0 ? <Ayrinti reference={current} onClose={() => setOpen(null)} /> : undefined}>
      <CenterColumn
        strip={
          all.length > 0 ? (
            <ToolStrip label={t("ornekler.tools")}>
              <Tabs
                label={t("ornekler.splitLabel")}
                value={split}
                onChange={(v) => setSplit(v as SplitFilter)}
                items={(["all", "train", "test"] as const).map((s) => ({ id: s, label: t(`ornekler.filter.${s}`), count: counts[s] }))}
              />
              <ToolDivider />
              <span className="td-or-ara">
                <SearchField value={q} onChange={setQ} placeholder={t("ornekler.searchPlaceholder")} aria-label={t("ornekler.searchLabel")} />
              </span>
              <ToolSpacer />
              <span className="td-mut">{t("ornekler.count", { count: list.length })}</span>
            </ToolStrip>
          ) : undefined
        }
      >
        <div className="td-or-orta">{body}</div>
      </CenterColumn>
    </Workspace>
  );
}

/** Sağ panel: bugünkü ayrıntı penceresinin bütün içeriği. Küme seçimi hemen kaydedilir. */
function Ayrinti({ reference, onClose }: { reference: Reference | null; onClose: () => void }) {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!reference) {
    return (
      <Panel side="right" title={t("ornekler.detail")}>
        <EmptyState icon="cursor" title={t("ornekler.pick")} />
      </Panel>
    );
  }
  const pxPerPt = w.value ? ptToPx(w.value, 1) : null;
  // Başlıkta sağda soluk künye (şablon kartta yazılı).
  const head = [reference.orderNo ? t("ref.orderNo", { no: reference.orderNo }) : null, reference.quantity ? t("ref.quantity", { count: reference.quantity }) : null].filter(Boolean).join(" · ");
  const setSplit = async (split: Reference["split"]) => {
    setBusy(true);
    try {
      await api.patch(path(API.reference, { id: reference.id }), { split });
      await qc.invalidateQueries({ queryKey: ["references"] });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      side="right"
      title={reference.text}
      actions={
        <>
          {head && <span className="td-mut td-or-kunye">{head}</span>}
          <IconButton icon="x" size={28} label={t("ornekler.close")} onClick={onClose} />
        </>
      }
    >
      <PanelSection>
        <div className="td-or-ikili">
          <figure>
            <RefGorsel reference={reference} mm={PANEL_MM} />
            <figcaption>{t("ornekler.final")}</figcaption>
          </figure>
          {reference.program && (
            <figure>
              <RefGorsel reference={reference} side="program" mm={PANEL_MM} alt={t("ornekler.program")} />
              <figcaption>{reference.programMeta?.profileVersion ? t("ornekler.programVersion", { version: reference.programMeta.profileVersion }) : t("ornekler.program")}</figcaption>
            </figure>
          )}
        </div>
        <p className="td-mut">{t("ornekler.source", { source: t(`source.${reference.source}`) })}</p>
      </PanelSection>
      <PanelSection heading={t("ornekler.lines")}>
        <table className="td-or-satir">
          <thead className="td-sr">
            <tr>
              <th scope="col">{t("ornekler.col.text")}</th>
              <th scope="col">{t("ornekler.col.font")}</th>
              <th scope="col">{t("ornekler.col.size")}</th>
            </tr>
          </thead>
          <tbody>
            {reference.user.map((l, i) => (
              <tr key={i}>
                <td>{l.text}</td>
                <td>
                  {l.family} {l.style !== "Regular" ? l.style : ""}
                  {l.segments.length > 1 && <small>{t("ornekler.fonts", { count: new Set(l.segments.map((s) => s.family)).size })}</small>}
                </td>
                <td className="td-mono">{pxPerPt ? t("ornekler.pt", { n: num(l.sizePx / pxPerPt, 1) }) : t("ornekler.px", { n: num(l.sizePx, 1) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="td-mut">{t("ornekler.ptNote")}</p>
      </PanelSection>
      <PanelSection>
        {/* Etiketin ipucunda kümelerin anlamı (açıklama metni ekranda yok). */}
        <div className="tz-pr td-or-kume">
          <Tooltip content={t("ornekler.splitHelp")}>
            <span>{t("ornekler.thisOne")}</span>
          </Tooltip>
          <Segmented<Reference["split"]>
            aria-label={t("ornekler.splitLabel")}
            value={reference.split}
            onChange={(s) => {
              if (!busy && s !== reference.split) void setSplit(s);
            }}
            options={[
              { value: "train", label: t("ornekler.filter.train") },
              { value: "test", label: t("ornekler.filter.test") },
            ]}
          />
        </div>
      </PanelSection>
    </Panel>
  );
}
