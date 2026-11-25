import type { PrintTemplateView } from "@tagpress/domain";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { canDelete, type KindFilter, templateShortSummary, templateSummary } from "../mantik/sablon/editor.ts";
import { Button, EmptyState, Icon, IssueBadge, IssueBox, Menu, SearchField, Switch, Tabs, Tag, Tooltip } from "../../../tezgah/index.ts";

/** Kart ve satırdaki küçük kağıt çizimi (yuvalarla; en çok 400 yuva). */
export function PaperThumb({ t: tpl, size = 34 }: { t: Pick<PrintTemplateView, "paper" | "slots">; size?: number }) {
  const k = size / Math.max(tpl.paper.wMm, tpl.paper.hMm);
  const w = tpl.paper.wMm * k;
  const h = tpl.paper.hMm * k;
  return (
    <svg className="bs-thumb" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <g transform={`translate(${(size - w) / 2} ${(size - h) / 2}) scale(${k})`} strokeWidth={0.75 / k}>
        <rect className="bs-thumb-p" width={tpl.paper.wMm} height={tpl.paper.hMm} />
        {tpl.slots.slice(0, 400).map((s) =>
          s.shape === "rect" ? (
            <rect key={s.id} className="bs-thumb-s" x={s.cx - s.w / 2} y={s.cy - s.h / 2} width={s.w} height={s.h} rx={Math.min(s.cornerRadius, s.w / 2, s.h / 2)} />
          ) : (
            <ellipse key={s.id} className="bs-thumb-s" cx={s.cx} cy={s.cy} rx={s.w / 2} ry={s.h / 2} />
          ),
        )}
      </g>
    </svg>
  );
}

export interface ListeProps {
  shown: PrintTemplateView[];
  total: number;
  counts: { label: number; sticker: number };
  query: string;
  onQuery(v: string): void;
  kind: KindFilter;
  onKind(k: KindFilter): void;
  showArchived: boolean;
  onShowArchived(v: boolean): void;
  loading: boolean;
  error: string | null;
  creating: boolean;
  onCreate(kind: "label" | "sticker"): void;
  onOpen(id: string): void;
  onDelete(x: PrintTemplateView): void;
  onUnarchive(x: PrintTemplateView): void;
  /** Hiç şablon yokken kartların yerine (araç satırı ve "Arşivdekileri göster" yerinde kalır). */
  empty?: ReactNode;
}

/**
 * Sayfa şablonları listesi (maket ekran 6): arama, tür, "Arşivdekileri göster"; şablonlar kart olarak. Kartta kâğıt
 * çizimi, ad, kısa özet, kaç baskıda kullanıldığı ve görünür "Sil" (kullanılmış ve arşivdeyse "Arşivden çıkar").
 * Sonda "Yeni sayfa şablonu" kartı.
 */
export function Liste(p: ListeProps) {
  const { t } = useTranslation("printTemplates");
  const newItems = [
    { label: t("list.newLabel"), onSelect: () => p.onCreate("label") },
    { label: t("list.newSticker"), onSelect: () => p.onCreate("sticker") },
  ];
  return (
    <div className="bs-tl">
      <div className="bs-tl-tb">
        <SearchField className="bs-tl-q" value={p.query} placeholder={t("list.search")} aria-label={t("list.searchLabel")} onChange={p.onQuery} />
        <Tabs
          label={t("list.kind")}
          value={p.kind}
          onChange={(id) => p.onKind(id as KindFilter)}
          items={[
            { id: "all", label: t("list.kindAll") },
            { id: "label", label: t("kind.label"), count: p.counts.label },
            { id: "sticker", label: t("kind.sticker"), count: p.counts.sticker },
          ]}
        />
        <span className="tz-sp" />
        <Switch showLabel checked={p.showArchived} label={t("list.showArchived")} onChange={p.onShowArchived} />
      </div>
      {p.loading && <div className="bs-wait-l" aria-busy="true" />}
      {p.error && <IssueBox tone="error">{t("list.loadFailed", { detail: p.error })}</IssueBox>}
      {!p.loading && !p.error && p.total > 0 && !p.shown.length && <p className="bs-empty">{t("list.noMatch")}</p>}
      {!p.loading && !p.error && !p.total && p.empty}
      {!p.loading && !p.error && (p.total > 0 || !p.empty) && (
        <ul className="bs-tgrid" aria-label={t("title")}>
          {p.shown.map((x) => (
            <li key={x.id} className="bs-tcard">
              <Kart x={x} onOpen={() => p.onOpen(x.id)} onDelete={() => p.onDelete(x)} onUnarchive={() => p.onUnarchive(x)} />
            </li>
          ))}
          <li className="bs-tcard is-new">
            <Menu
              align="start"
              items={newItems}
              trigger={(tp) => (
                <button {...tp} type="button" className="bs-tnew" disabled={p.creating}>
                  <span className="bs-tnew-ic">
                    <Icon name="plus" size={18} />
                  </span>
                  <b>{t("list.newCard")}</b>
                  <small>{t("list.newCardSub")}</small>
                </button>
              )}
            />
          </li>
        </ul>
      )}
    </div>
  );
}

function Kart({ x, onOpen, onDelete, onUnarchive }: { x: PrintTemplateView; onOpen(): void; onDelete(): void; onUnarchive(): void }) {
  const { t } = useTranslation("printTemplates");
  const warn = x.warnings.length;
  return (
    <>
      <button type="button" className="bs-tcard-open" onClick={onOpen} aria-label={t("list.open", { name: x.name })}>
        <span className="bs-tcard-th">
          <PaperThumb t={x} size={168} />
        </span>
        <span className="bs-tcard-b">
          <b>{x.name}</b>
          <Tooltip content={templateSummary(x)}>
            <small>{templateShortSummary(x)}</small>
          </Tooltip>
        </span>
      </button>
      <div className="bs-tcard-f">
        {x.usedIn !== undefined && (
          <span className="bs-used">
            {x.usedIn > 0 && <Icon name="print" size={12} />}
            {x.usedIn > 0 ? t("list.usedIn", { count: x.usedIn }) : t("list.unused")}
          </span>
        )}
        {x.archived && <Tag>{t("list.archived")}</Tag>}
        {warn > 0 && <IssueBadge tone="error">{t("list.warnings", { count: warn })}</IssueBadge>}
        <span className="tz-sp" />
        {canDelete(x) ? (
          <Button need="edit" size="mini" icon="trash" aria-label={t("list.deleteLabel", { name: x.name })} onClick={onDelete}>
            {t("actions.delete")}
          </Button>
        ) : (
          <Button need="edit" size="mini" onClick={onUnarchive}>
            {t("actions.unarchive")}
          </Button>
        )}
      </div>
    </>
  );
}

/** Hiç şablon yokken: iki kurulum düğmesi. */
export function BosListe({ creating, onCreate }: { creating: boolean; onCreate(kind: "label" | "sticker"): void }) {
  const { t } = useTranslation("printTemplates");
  return (
    <EmptyState
      icon="layout"
      title={t("empty.title")}
      body={t("empty.body")}
      action={
        <>
          <Button need="edit" variant="primary" icon="plus" loading={creating} onClick={() => onCreate("label")}>
            {t("empty.newLabel")}
          </Button>
          <Button disabled={creating} onClick={() => onCreate("sticker")}>
            {t("empty.newSticker")}
          </Button>
        </>
      }
    />
  );
}
