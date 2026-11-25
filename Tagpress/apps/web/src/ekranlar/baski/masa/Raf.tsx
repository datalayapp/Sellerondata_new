import type { PrintTemplateView } from "@tagpress/domain";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { type AddTarget, canAddTo, filterShelf, hasMarkOverlap, hiddenDoneCount, missingQuantityCount, rowState, shelfTotals } from "../mantik/masa.ts";
import { groupSizeLabel, groupTitle, neededLabel, type ShelfGroup, type ShelfRow } from "../mantik/shelf.ts";
import { Button, cx, Icon, IconButton, IssueBox, Menu, Panel, PanelSection, SearchField, Switch, Tooltip } from "../../../tezgah/index.ts";
import { groupTemplates } from "../mantik/raf.ts";
import { SHELF_MIME, shelfDrag } from "./surukle.ts";

type Mode = "cards" | "summary";
// Eski masayla aynı kayıt ("full" = kartlar, "summary" = tek satırlık özet).
const MODE_KEY = "studio.baski.raf";
function readMode(): Mode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "full" ? "cards" : v === "summary" ? "summary" : null;
  } catch {
    return null;
  }
}
function writeMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m === "cards" ? "full" : "summary");
  } catch {
    /* gizli pencere */
  }
}

export interface RafProps {
  groups: ShelfGroup[];
  templates: PrintTemplateView[];
  /** Açık (taslak) oturum var mı: yoksa kartlar sürüklenmez. */
  canDrop: boolean;
  planning: boolean;
  onPlan(g: ShelfGroup, templateId: string): void;
  addTarget: AddTarget | null;
  adding: boolean;
  onAdd(g: ShelfGroup): void;
  onTemplates(): void;
  /** Klavyeyle koy (kartta Enter; Shift ile kalanların hepsi). */
  onPlace(row: ShelfRow, shift: boolean): void;
}

/**
 * Raf (sol panel): onaylı, basılmamış etiketler boyuta / sayfa türüne göre gruplu. Grup başlığında Planla (o grubun
 * işleriyle otomatik oturum) ve Oturuma ekle (kalanları açık taslağa); kart sayfaya sürüklenir (Shift kalanların
 * hepsi, Alt serbest konum) ya da odaktayken Enter ile etkin sayfaya konur. Bütünüyle dizilmiş işler "Yalnızca
 * kalanlar" açıkken tek satırdır ("3 iş dizildi · göster"). Kartlar / tek satırlık özet başlıktaki ikonla.
 */
export function Raf(p: RafProps) {
  const { t } = useTranslation("printDesk");
  const [query, setQuery] = useState("");
  const [onlyRemaining, setOnlyRemaining] = useState(true);
  // Raf solda dikey bir panel: kartlar tuvalden yer almaz, varsayılan kartlar (maket); tercih hatırlanır.
  const [pref, setPref] = useState<Mode | null>(readMode);
  const mode: Mode = pref ?? "cards";
  const filter = { query, onlyRemaining };
  const shown = useMemo(() => filterShelf(p.groups, { query, onlyRemaining }), [p.groups, query, onlyRemaining]);
  const hidden = hiddenDoneCount(p.groups, filter);
  const totals = shelfTotals(p.groups);
  const toggleMode = () => {
    const m: Mode = mode === "cards" ? "summary" : "cards";
    setPref(m);
    writeMode(m);
  };

  return (
    <Panel
      side="left"
      title={t("shelf.title")}
      count={t("shelf.remaining", { count: totals.remaining })}
      actions={<IconButton icon="layout" size={28} label={mode === "cards" ? t("shelf.toSummary") : t("shelf.toCards")} onClick={toggleMode} />}
      footer={<p className="bm-drag">{p.canDrop ? t("shelf.dragHint") : t("shelf.noSessionHint")}</p>}
    >
      <PanelSection>
        <div className="bm-rf">
          <SearchField value={query} onChange={setQuery} placeholder={t("shelf.search")} aria-label={t("shelf.searchLabel")} />
          <label className="bm-only">
            <Switch checked={onlyRemaining} onChange={setOnlyRemaining} label={t("shelf.onlyRemaining")} />
            <span>{t("shelf.onlyRemaining")}</span>
          </label>
        </div>
      </PanelSection>
      {shown.length === 0 && hidden === 0 && <p className="bm-empty">{totals.orders === 0 ? t("shelf.empty") : t("shelf.noMatch")}</p>}
      {shown.map((g) => (
        <Grup key={g.key} g={g} p={p} mode={mode} />
      ))}
      {hidden > 0 && (
        <div className="bm-done">
          <Icon name="okc" size={15} />
          <span>{t("shelf.doneCount", { count: hidden })}</span>
          <Button variant="link" className="bm-lnk" onClick={() => setOnlyRemaining(false)}>
            {t("shelf.show")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function Grup({ g, p, mode }: { g: ShelfGroup; p: RafProps; mode: Mode }) {
  const { t } = useTranslation("printDesk");
  // Kesim uyumu: grubun kesimine uymayan boyutsuz şablonlar Planla'da önerilmez (sunucunun kendiliğinden seçimiyle aynı).
  const { usable: ts, unfit } = groupTemplates(g, p.templates);
  const size = groupSizeLabel(g);
  const misfit = ts.length === 0 && unfit.length > 0 && size ? { size, names: unfit.map((x) => x.name).join(", ") } : null;
  const missing = missingQuantityCount(g);
  const warn = ts.find(hasMarkOverlap);
  const title = groupTitle(g);
  return (
    <section className="bm-g" aria-label={title}>
      <div className="bm-gh">
        <span className="bm-gt">
          <b>{title}</b>
          <small>
            {t("shelf.groupRemaining", { count: g.remaining })}
            {missing > 0 && <em> · {t("shelf.missingCount", { count: missing })}</em>}
          </small>
        </span>
        <PlanButton g={g} ts={ts} planning={p.planning} onPlan={p.onPlan} onTemplates={p.onTemplates} />
        {canAddTo(p.addTarget, g) && (
          <Button variant="link" className="bm-lnk" title={t("shelf.addHint", { name: p.addTarget?.name ?? "" })} loading={p.adding} onClick={() => p.onAdd(g)}>
            {t("shelf.add")}
          </Button>
        )}
      </div>
      {misfit &&
        (mode === "cards" ? (
          <IssueBox tone="warn">{t("shelf.cutMismatch", { ...misfit, count: unfit.length })}</IssueBox>
        ) : (
          <small className="bm-warn">
            <Icon name="warn" size={12} />
            {t("shelf.cutMismatchShort")}
          </small>
        ))}
      {warn &&
        (mode === "cards" ? (
          <IssueBox
            tone="warn"
            fixes={
              <Button size="mini" variant="quiet" onClick={p.onTemplates}>
                {t("shelf.fixTemplate")}
              </Button>
            }
          >
            {t("shelf.markOverlap", { name: warn.name })}
          </IssueBox>
        ) : (
          <small className="bm-warn">
            <Icon name="warn" size={12} />
            {t("shelf.markOverlapShort")}
          </small>
        ))}
      {mode === "cards" && (
        <div className="bm-cards">
          {g.rows.map((r) => (
            <Kart key={r.jobId} row={r} draggable={p.canDrop} onPlace={p.onPlace} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Planla: tek şablonda düğme, birkaç şablonda menü; bu boyutta şablon yoksa "Şablon kur". */
function PlanButton({ g, ts, planning, onPlan, onTemplates }: { g: ShelfGroup; ts: PrintTemplateView[]; planning: boolean; onPlan: RafProps["onPlan"]; onTemplates(): void }) {
  const { t } = useTranslation("printDesk");
  if (ts.length === 0) {
    return (
      <Button size="mini" variant="quiet" icon="filep" title={t("shelf.noTemplate")} onClick={onTemplates}>
        {t("shelf.setupTemplate")}
      </Button>
    );
  }
  if (ts.length === 1) {
    const only = ts[0]!;
    return (
      <Button size="mini" icon="layout" loading={planning} disabled={g.remaining === 0} title={t("shelf.planWith", { name: only.name })} onClick={() => onPlan(g, only.id)}>
        {t("shelf.plan")}
      </Button>
    );
  }
  return (
    <Menu
      align="end"
      trigger={(tp) => (
        <Button {...tp} size="mini" icon="layout" loading={planning} disabled={g.remaining === 0}>
          {t("shelf.plan")}
        </Button>
      )}
      items={ts.map((x) => ({ label: t("shelf.templateOption", { name: x.name, count: x.capacity }), onSelect: () => onPlan(g, x.id) }))}
    />
  );
}

function Kart({ row, draggable, onPlace }: { row: ShelfRow; draggable: boolean; onPlace: RafProps["onPlace"] }) {
  const { t } = useTranslation("printDesk");
  const state = rowState(row);
  const no = row.orderNo ?? "—";
  return (
    <Tooltip content={draggable ? t("shelf.cardHint", { needed: neededLabel(row) }) : t("shelf.noSessionHint")}>
      <div
        className={cx("bm-card", state === "done" && "is-done", draggable && "is-drag")}
        draggable={draggable}
        tabIndex={draggable ? 0 : undefined}
        role={draggable ? "button" : undefined}
        aria-label={t("shelf.cardLabel", { no })}
        data-job={row.jobId}
        onDragStart={(e) => {
          shelfDrag.current = row;
          e.dataTransfer.setData(SHELF_MIME, row.jobId);
          e.dataTransfer.setData("text/plain", row.orderNo ?? row.jobId);
          // "all": Windows'ta sürüklerken Shift/Alt işletim sisteminin etkisini (taşı/bağla) değiştirir; "copy" ile bırakma reddedilirdi.
          e.dataTransfer.effectAllowed = "all";
          const img = e.currentTarget.querySelector("img");
          if (img) e.dataTransfer.setDragImage(img, 17, 17);
        }}
        onDragEnd={() => {
          shelfDrag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !draggable) return;
          e.preventDefault();
          onPlace(row, e.shiftKey);
        }}
      >
        <span className="bm-thumb-s">
          <img src={row.previewUrl} alt="" width={34} height={34} loading="lazy" decoding="async" draggable={false} />
        </span>
        <span className="bm-card-t">
          <b>
            <span className="tz-mono bm-card-no">{no}</span>
            {row.product && <> {row.product}</>}
          </b>
          {state === "missing" ? (
            <small className="bm-warn">
              <Icon name="warn" size={12} />
              {t("shelf.noQuantityShort")}
            </small>
          ) : (
            <small>
              <Trans t={t} i18nKey="shelf.placed" values={{ placed: row.placedNow, needed: row.needed }} components={{ b: <b className="bm-card-n" /> }} />
            </small>
          )}
        </span>
      </div>
    </Tooltip>
  );
}
