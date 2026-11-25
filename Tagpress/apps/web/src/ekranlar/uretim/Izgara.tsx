import type { JobSummary, ProgressStep } from "@tagpress/domain";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { issueText } from "../../i18n/sunucu.ts";
import { allState, isBusy, issueCount, type JobType, jobType, needsAttention, oneLine, type Section, shownVariant, type SortChoice } from "./mantik/jobs.ts";
import { Button, Checkbox, EmptyState, Icon, IconButton, SearchField, StatusDot } from "../../tezgah/index.ts";
import { GununMaliyeti, JobThumb, SortMenu } from "./parcalar.tsx";

export interface BoardProps {
  board: Record<Section, JobSummary[]>;
  /** Liste hiç boş değil ama süzgeç hepsini gizledi. */
  noMatch: boolean;
  query: string;
  onQuery(q: string): void;
  searchRef: Ref<HTMLInputElement>;
  problemCount: number;
  problems: boolean;
  onProblems(on: boolean): void;
  types: Array<JobType & { count: number }>;
  type: string | null;
  onType(key: string | null): void;
  sort: SortChoice;
  onSort(s: SortChoice): void;
  onClearFilter(): void;
  defaultSize?: string;
  currentId: string | null;
  selected: ReadonlySet<string>;
  /** Seçilebilen bekleyenler (sırada ya da üretilmekte olanlar seçilmez). */
  selectable: string[];
  onToggle(id: string): void;
  onSelectAll(all: boolean): void;
  canSpend: boolean;
  onGenerate(): void;
  onRetry(id: string): void;
  onApproveBest(): void;
  onPrint(): void;
  onOpen(id: string): void;
  onDelete(id: string): void;
  progress: Record<string, ProgressStep>;
  templateImages: Map<string, string>;
  sectionRef(s: Section): (el: HTMLElement | null) => void;
}

/**
 * Izgara (maket 2): araç satırı (arama, "Sorunlu n", tip çipleri, sıralama) ve üç bölüm. Üretilmeyi bekleyenler
 * seçilip üretilir; Düzenle kartına tıklayınca sağ panel açılır; her kartta çöp kutusu (bildirimde geri al).
 */
export function Board(p: BoardProps) {
  const { t } = useTranslation("production");
  const selectedCount = p.selectable.filter((id) => p.selected.has(id)).length;
  const head = (s: Section, aside?: ReactNode) => (
    <div className="ur-sec-h">
      <span className="ur-sec-t">
        <h2>
          <span className={`ur-sec-dot ur-sec-dot--${s}`} aria-hidden="true" />
          {t(`sections.${s}.title`)}
          <span className="ur-sec-n tz-mono">{p.board[s].length}</span>
        </h2>
        <small>{t(`sections.${s}.body`)}</small>
      </span>
      <span className="tz-sp" />
      {aside}
    </div>
  );

  return (
    <>
      <div className="ur-tools" role="toolbar" aria-label={t("tools.label")}>
        <SearchField
          ref={p.searchRef}
          className="ur-search"
          value={p.query}
          onChange={p.onQuery}
          command="uretim.search"
          placeholder={t("tools.search")}
          aria-label={t("tools.searchLabel")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (p.query) p.onQuery("");
              else e.currentTarget.blur();
            }
          }}
        />
        {p.problemCount > 0 && (
          <button type="button" className={`ur-chip ur-chip--warn${p.problems ? " is-on" : ""}`} aria-pressed={p.problems} onClick={() => p.onProblems(!p.problems)}>
            <Icon name="warn" size={15} />
            {t("tools.problems")} <b className="tz-mono">{p.problemCount}</b>
          </button>
        )}
        {p.types.length > 1 && (
          <span className="ur-types" role="group" aria-label={t("tools.type")}>
            <span className="ur-mut">{t("tools.type")}</span>
            <button type="button" className={`ur-chip${p.type === null ? " is-on" : ""}`} aria-pressed={p.type === null} onClick={() => p.onType(null)}>
              {t("tools.allTypes")}
            </button>
            {p.types.map((x) => (
              <button key={x.key} type="button" className={`ur-chip${p.type === x.key ? " is-on" : ""}`} aria-pressed={p.type === x.key} onClick={() => p.onType(p.type === x.key ? null : x.key)}>
                {x.label} <b className="tz-mono">{x.count}</b>
              </button>
            ))}
          </span>
        )}
        <span className="tz-sp" />
        <SortMenu value={p.sort} onChange={p.onSort} />
      </div>

      {p.noMatch && (
        <EmptyState
          icon="search"
          title={p.query ? t("tools.noMatchQuery", { q: p.query }) : t("tools.noMatch")}
          action={
            <Button variant="quiet" onClick={p.onClearFilter}>
              {t("tools.clearFilter")}
            </Button>
          }
        />
      )}

      {p.board.pending.length > 0 && (
        <section className="ur-sec" ref={p.sectionRef("pending")} data-sec="pending" aria-label={t("sections.pending.title")}>
          {head(
            "pending",
            p.canSpend && (
              <>
                <GununMaliyeti />
                {p.selectable.length > 0 && (
                  <span className="ur-selall">
                    <Checkbox checked={allState(p.selected, p.selectable)} onChange={p.onSelectAll} label={t("pending.selectAll")} />
                    <span aria-hidden="true">{t("pending.selectAll")}</span>
                  </span>
                )}
                <Button need="spend" variant="primary" size="page" icon="spark" command="uretim.generate" disabled={selectedCount === 0} onClick={p.onGenerate}>
                  {t("pending.generate", { count: selectedCount })}
                </Button>
              </>
            ),
          )}
          <div className="ur-pgrid">
            {p.board.pending.map((j) => (
              <PendingCard key={j.id} job={j} {...p} />
            ))}
          </div>
        </section>
      )}

      {p.board.edit.length > 0 && (
        <section className="ur-sec" ref={p.sectionRef("edit")} data-sec="edit" aria-label={t("sections.edit.title")}>
          {head(
            "edit",
            <Button need="edit" size="page" icon="check" command="uretim.approveBest" title={t("edit.approveBestHint")} onClick={p.onApproveBest}>
              {t("edit.approveBest")}
            </Button>,
          )}
          <div className="ur-egrid">
            {p.board.edit.map((j) => (
              <PreviewCard key={j.id} job={j} {...p} />
            ))}
          </div>
        </section>
      )}

      {p.board.approved.length > 0 && (
        <section className="ur-sec" ref={p.sectionRef("approved")} data-sec="approved" aria-label={t("sections.approved.title")}>
          {head(
            "approved",
            <Button variant="link" icon="print" onClick={p.onPrint}>
              {t("approvedSec.toPrint")}
            </Button>,
          )}
          <div className="ur-egrid">
            {p.board.approved.map((j) => (
              <PreviewCard key={j.id} job={j} {...p} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

type CardProps = BoardProps & { job: JobSummary };

/** Kartın tip etiketi ("3,8 cm", "Sticker"). Ürün tipleri gelince "Tip seç" uyarısı da burada. */
function TypeTag({ job, defaultSize }: { job: JobSummary; defaultSize?: string }) {
  const type = jobType(job, defaultSize);
  return type ? <span className="ur-tg">{type.label}</span> : null;
}

function DeleteButton({ job, onDelete }: { job: JobSummary; onDelete(id: string): void }) {
  const { t } = useTranslation("production");
  return <IconButton icon="trash" size={28} className="ur-del" label={t("card.delete", { v: job.orderNo ?? oneLine(job.text) })} onClick={() => onDelete(job.id)} />;
}

/** Üretilmeyi bekleyen kart: onay kutusu, soluk şablon, metin, tip ve adet, durum (Bekliyor, Sırada, Üretiliyor, Üretilemedi). */
function PendingCard(p: CardProps) {
  const { t } = useTranslation("production");
  const j = p.job;
  const busy = isBusy(j);
  const sel = p.selected.has(j.id);
  const firstIssue = needsAttention(j) ? (j.issues.find((i) => i.severity === "error") ?? j.issues.find((i) => i.severity === "warning")) : undefined;
  const status =
    j.status === "failed" ? (
      <span className="ur-st ur-st--err">
        <Icon name="err" size={15} />
        {t("card.failed")}
        {p.canSpend && (
          <>
            {" · "}
            <Button variant="link" size="mini" need="spend" onClick={() => p.onRetry(j.id)}>
              {t("card.retry")}
            </Button>
          </>
        )}
      </span>
    ) : j.status === "generating" ? (
      <span className="ur-st ur-st--run">
        <StatusDot tone="busy" />
        {p.progress[j.id]?.message || t("card.generating")}
      </span>
    ) : j.status === "queued" ? (
      <span className="ur-st ur-st--run">
        <StatusDot tone="busy" />
        {t("card.queued")}
      </span>
    ) : (
      <span className="ur-st">
        <StatusDot tone="idle" />
        {t("card.new")}
      </span>
    );
  return (
    <div
      data-job={j.id}
      className={`ur-pc${sel ? " is-sel" : ""}${busy ? " is-busy" : ""}${j.status === "failed" ? " is-fail" : ""}${firstIssue ? " is-iss" : ""}${p.currentId === j.id ? " is-cur" : ""}`}
    >
      {p.canSpend && (
        <span className="ur-pc-cb">
          <Checkbox checked={sel} disabled={busy} onChange={() => p.onToggle(j.id)} label={t("card.select", { v: j.orderNo ?? oneLine(j.text) })} />
        </span>
      )}
      <button type="button" className="ur-pc-b" aria-current={p.currentId === j.id || undefined} onClick={() => p.onOpen(j.id)}>
        <JobThumb job={j} size="m" templateImage={j.templateKey ? p.templateImages.get(j.templateKey) : undefined} />
        <span className="ur-pc-m">
          {j.orderNo && <span className="ur-no tz-mono">{t("card.order", { v: j.orderNo })}</span>}
          <b>{oneLine(j.text)}</b>
          <span className="ur-pc-r">
            <TypeTag job={j} defaultSize={p.defaultSize} />
            {j.quantity !== null && <span className="ur-mut">{t("card.quantity", { count: j.quantity })}</span>}
          </span>
          {firstIssue ? (
            <span className={`ur-st ${firstIssue.severity === "error" ? "ur-st--err" : "ur-st--warn"}`}>
              <Icon name="warn" size={15} />
              <span className="ur-st-t">{issueText(firstIssue)}</span>
            </span>
          ) : null}
          {(!firstIssue || j.status !== "new") && status}
        </span>
      </button>
      <DeleteButton job={j} onDelete={p.onDelete} />
    </div>
  );
}

/** Düzenle ve Onaylandı kartı: büyük önizleme, sipariş no, uyarı rozeti ya da "Onaylı · Vn", metin, tip, seçenek sayısı. */
function PreviewCard(p: CardProps) {
  const { t } = useTranslation("production");
  const j = p.job;
  const approved = j.status === "approved";
  const shown = shownVariant(j);
  const n = issueCount(j);
  const err = j.worst === "error";
  return (
    <div data-job={j.id} className={`ur-ec${approved ? " is-ok" : ""}${n > 0 && !approved ? " is-iss" : ""}${p.currentId === j.id ? " is-cur" : ""}`}>
      <button type="button" className="ur-ec-b" aria-current={p.currentId === j.id || undefined} onClick={() => p.onOpen(j.id)}>
        <JobThumb job={j} size={approved ? "m" : "l"} />
        <span className="ur-ec-m">
          <span className="ur-ec-r">
            {j.orderNo && <span className="ur-no tz-mono">{t("card.order", { v: j.orderNo })}</span>}
            <span className="tz-sp" />
            {approved ? (
              <span className="ur-tg ur-tg--ok">{shown ? t("card.approvedV", { no: shown.no }) : t("card.approved")}</span>
            ) : n > 0 ? (
              <span className={`ur-tg ${err ? "ur-tg--err" : "ur-tg--warn"}`}>
                <Icon name="warn" size={12} />
                {err ? t("card.errors", { count: n }) : t("card.warnings", { count: n })}
              </span>
            ) : null}
          </span>
          <b>{oneLine(j.text)}</b>
          <span className="ur-ec-r">
            <TypeTag job={j} defaultSize={p.defaultSize} />
            {!approved && <small className="ur-mut">{t("card.variants", { count: j.variants.length })}</small>}
          </span>
        </span>
      </button>
      <DeleteButton job={j} onDelete={p.onDelete} />
    </div>
  );
}
