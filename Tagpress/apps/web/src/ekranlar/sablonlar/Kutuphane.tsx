import { API, type TemplateItem, type TemplateSyncResult } from "@tagpress/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Ref, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { TemplateThumb, templateImageUrl } from "../../ortak/index.ts";
import {
  FILTERS,
  filterCounts,
  flagsOf,
  MAIN_FILTERS,
  OTHER_FILTERS,
  SORTS,
  sortTemplates,
  syncSummary,
  type TemplateFilter,
  type TemplateSort,
  visibleTemplates,
} from "./mantik/templateList.ts";
import { Button, EmptyState, IconButton, IssueBadge, IssueBox, Menu, Panel, SearchField, Tabs, Tag, useToast } from "../../tezgah/index.ts";
import { cutSizeText, kindLabel } from "./metin.ts";

/** Kütüphanenin verisi ve süzgeç durumu (sol panel ve büyük ızgara aynı durumu paylaşır). */
export function useKutuphane(lang: string) {
  const { t } = useTranslation("templates");
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["templates", lang], queryFn: () => api.get<{ templates: TemplateItem[] }>(path(API.templates, { lang })), staleTime: 15_000, retry: false });
  const items = useMemo(() => q.data?.templates ?? [], [q.data]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TemplateFilter>("all");
  const [sort, setSort] = useState<TemplateSort>("key");
  const [report, setReport] = useState<TemplateSyncResult | null>(null);
  const existing = useMemo(() => new Set(items.map((i) => i.template.key)), [items]);
  const counts = useMemo(() => filterCounts(items), [items]);
  const shown = useMemo(() => visibleTemplates(items, filter, query, sort), [items, filter, query, sort]);
  /** Önceki / sonraki şablon sırası: doğal anahtar sırası (eski ekranla aynı). */
  const natural = useMemo(() => sortTemplates(items, "key").map((i) => i.template.key), [items]);

  const sync = useMutation({
    mutationFn: () => api.post<TemplateSyncResult>(path(API.templatesSync, { lang })),
    onSuccess: (r) => {
      setReport(r);
      void qc.invalidateQueries({ queryKey: ["templates", lang] });
      if (syncSummary(r).none) toast({ message: t("sync.upToDate") });
    },
    onError: (e) => toast({ tone: "error", message: t("sync.failed", { error: serverText(e) }) }),
  });

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };
  return { q, items, query, setQuery, filter, setFilter, sort, setSort, report, setReport, existing, counts, shown, natural, sync, clearFilters };
}

export type Kutuphane = ReturnType<typeof useKutuphane>;

export interface LibraryActions {
  onOpen(key: string): void;
  onUpload(): void;
  onGenerate(): void;
  onToggleView(): void;
}

/** Arama, sıralama ve süzgeç satırı (panelde ve ızgarada aynı). */
function Suzgecler({ k, searchRef }: { k: Kutuphane; searchRef: Ref<HTMLInputElement> }) {
  const { t } = useTranslation("templates");
  const otherOn = OTHER_FILTERS.includes(k.filter);
  const label = (id: TemplateFilter) => FILTERS.find((f) => f.id === id)?.label ?? id;
  const sortLabel = SORTS.find((s) => s.id === k.sort)?.label ?? "";
  return (
    <>
      <div className="sb-row">
        <SearchField
          ref={searchRef}
          className="sb-grow"
          value={k.query}
          onChange={k.setQuery}
          command="sablonlar.search"
          placeholder={t("library.search")}
          aria-label={t("library.searchLabel")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (k.query) k.setQuery("");
              else e.currentTarget.blur();
            }
          }}
        />
        <Menu
          align="end"
          trigger={(p) => <IconButton {...p} icon="sort" size={28} label={t("library.sortLabel", { sort: sortLabel })} />}
          items={SORTS.map((s) => ({ label: s.label, icon: s.id === k.sort ? ("check" as const) : undefined, onSelect: () => k.setSort(s.id) }))}
        />
      </div>
      <Tabs
        label={t("library.filterLabel")}
        value={otherOn ? "other" : k.filter}
        onChange={(id) => k.setFilter(id as TemplateFilter)}
        items={[
          ...MAIN_FILTERS.map((id) => ({ id, label: label(id), count: k.counts[id] })),
          {
            id: "other",
            label: otherOn ? label(k.filter) : t("library.other"),
            count: otherOn ? k.counts[k.filter] : undefined,
            menuItems: OTHER_FILTERS.map((id) => ({ label: t("library.otherItem", { label: label(id), count: k.counts[id] }), icon: k.filter === id ? ("check" as const) : undefined, onSelect: () => k.setFilter(id) })),
          },
        ]}
      />
    </>
  );
}

/** Klasör tarama raporu: kapatılabilir not; anahtarlar tıklanınca şablon açılır (dosyası yok olanlar dahil). */
function TaramaRaporu({ k, onOpen }: { k: Kutuphane; onOpen(key: string): void }) {
  const { t } = useTranslation("templates");
  if (!k.report) return null;
  const sum = syncSummary(k.report);
  if (sum.none) return null;
  const n = (id: "added" | "updated" | "missing") => sum.groups.find((g) => g.id === id)?.keys.length ?? 0;
  const parts = [n("added") && t("sync.added", { count: n("added") }), n("updated") && t("sync.updated", { count: n("updated") }), n("missing") && t("sync.missing", { count: n("missing") })].filter(Boolean);
  return (
    <div className="sb-report">
      <IssueBox tone={sum.tone}>
        <span className="sb-report-h">
          <span>
            <b>{t("sync.title")}</b> {parts.join(", ")}
          </span>
          <IconButton icon="x" size={26} label={t("sync.close")} onClick={() => k.setReport(null)} />
        </span>
        {sum.groups.map((g) => (
          <span key={g.id} className="sb-report-g">
            <span>{t(`sync.group.${g.id}`)}: </span>
            {g.keys.map((key) => (
              <button key={key} type="button" className="sb-link tz-mono" onClick={() => onOpen(key)}>
                {key}
              </button>
            ))}
          </span>
        ))}
      </IssueBox>
    </div>
  );
}

function Bos({ k, a, grid }: { k: Kutuphane; a: LibraryActions; grid?: boolean }) {
  const { t } = useTranslation("templates");
  if (k.q.isLoading) return <div className="sb-wait" aria-busy="true" />;
  if (k.q.isError)
    return (
      <div className="sb-pad">
        <IssueBox
          tone="error"
          fixes={
            <Button size="mini" onClick={() => void k.q.refetch()}>
              {t("library.retry")}
            </Button>
          }
        >
          <b>{t("library.loadFailed")}</b> {serverText(k.q.error)}
        </IssueBox>
      </div>
    );
  if (k.items.length === 0)
    return (
      <EmptyState
        icon="img"
        title={t("library.empty")}
        body={grid ? t("library.emptyBody") : undefined}
        action={
          <div className="sb-row sb-wrap">
            <Button icon="up" onClick={a.onUpload}>
              {t("library.upload")}
            </Button>
            <Button variant="quiet" icon="refresh" loading={k.sync.isPending} onClick={() => k.sync.mutate()}>
              {t("library.scan")}
            </Button>
            <Button variant="quiet" icon="spark" onClick={a.onGenerate}>
              {t("library.generateShort")}
            </Button>
          </div>
        }
      />
    );
  return (
    <EmptyState
      icon="search"
      title={t("library.noMatch")}
      body={k.query ? t("library.noMatchQuery", { q: k.query }) : t("library.noMatchFilter")}
      action={
        <Button variant="quiet" onClick={k.clearFilters}>
          {t("library.clearFilters")}
        </Button>
      }
    />
  );
}

/** Sol panel: kütüphane (başlıkta Klasörü tara, Temadan şablon üret, Şablon yükle, Izgara görünümü). */
export function KutuphanePaneli({ k, a, current, lang, searchRef }: { k: Kutuphane; a: LibraryActions; current: string | null; lang: string; searchRef: Ref<HTMLInputElement> }) {
  const { t } = useTranslation("templates");
  return (
    <Panel
      side="left"
      title={t("library.title")}
      count={<span className="tz-mono">{k.shown.length}</span>}
      actions={
        <>
          <IconButton icon="refresh" size={28} label={t("library.scan")} title={t("library.scanHint")} disabled={k.sync.isPending} onClick={() => k.sync.mutate()} />
          <IconButton icon="spark" size={28} label={t("library.generate")} onClick={a.onGenerate} />
          <IconButton icon="up" size={28} label={t("library.upload")} onClick={a.onUpload} />
          <IconButton icon="layout" size={28} command="sablonlar.toggleView" label={t("library.gridView")} onClick={a.onToggleView} />
        </>
      }
    >
      <div className="sb-lib-head">
        <Suzgecler k={k} searchRef={searchRef} />
      </div>
      <TaramaRaporu k={k} onOpen={a.onOpen} />
      {k.shown.length === 0 ? (
        <Bos k={k} a={a} />
      ) : (
        <ul className="sb-lib" aria-label={t("library.list")}>
          {k.shown.map((it) => (
            <li key={it.template.key}>
              <Karo item={it} lang={lang} current={it.template.key === current} onOpen={() => a.onOpen(it.template.key)} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Karo({ item, lang, current, onOpen }: { item: TemplateItem; lang: string; current: boolean; onOpen(): void }) {
  const { t } = useTranslation("templates");
  const key = item.template.key;
  const name = [key, item.fileMissing ? t("flags.missing") : null, item.template.kind !== "label" ? kindLabel(item.template.kind) : null].filter(Boolean).join(", ");
  return (
    <button type="button" className={`sb-tile${current ? " is-cur" : ""}${item.fileMissing ? " is-missing" : ""}`} aria-current={current || undefined} aria-label={name} onClick={onOpen}>
      <TemplateThumb url={item.fileMissing ? "" : thumbUrl(lang, item)} size={60} />
      <span className="sb-tile-k tz-mono">{key}</span>
    </button>
  );
}

function thumbUrl(lang: string, item: TemplateItem): string {
  const base = templateImageUrl(lang, item.template.key);
  return base ? `${base}?v=${encodeURIComponent(item.template.hash || item.updatedAt)}` : "";
}

/** Tam genişlik büyük ızgara: kartlar büyük önizlemeyle; karta tıklayınca düzenleyici açılır. */
export function Izgara({ k, a, lang, searchRef }: { k: Kutuphane; a: LibraryActions; lang: string; searchRef: Ref<HTMLInputElement> }) {
  const { t } = useTranslation("templates");
  return (
    <div className="sb-gv">
      <div className="sb-gv-head">
        <div className="sb-gv-f">
          <Suzgecler k={k} searchRef={searchRef} />
        </div>
        <span className="tz-sp" />
        <IconButton icon="refresh" label={t("library.scan")} title={t("library.scanHint")} disabled={k.sync.isPending} onClick={() => k.sync.mutate()} />
        <IconButton icon="spark" label={t("library.generate")} onClick={a.onGenerate} />
        <Button need="edit" variant="primary" icon="up" onClick={a.onUpload}>
          {t("library.upload")}
        </Button>
        <IconButton icon="list" command="sablonlar.toggleView" label={t("library.editorView")} onClick={a.onToggleView} />
      </div>
      <TaramaRaporu k={k} onOpen={a.onOpen} />
      {k.shown.length === 0 ? (
        <Bos k={k} a={a} grid />
      ) : (
        <ul className="sb-grid" aria-label={t("library.list")}>
          {k.shown.map((it) => (
            <li key={it.template.key}>
              <Kart item={it} lang={lang} onOpen={() => a.onOpen(it.template.key)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Kart({ item, lang, onOpen }: { item: TemplateItem; lang: string; onOpen(): void }) {
  const { t } = useTranslation("templates");
  const tpl = item.template;
  const f = flagsOf(item);
  return (
    <button type="button" className="sb-card" onClick={onOpen} aria-label={t("library.open", { key: tpl.key })}>
      <TemplateThumb url={item.fileMissing ? "" : thumbUrl(lang, item)} size={132} />
      <span className="sb-card-k">
        <b className="tz-mono">{tpl.key}</b>
        {tpl.kind !== "label" && <small>{kindLabel(tpl.kind)}</small>}
      </span>
      {tpl.cut && <small className="sb-card-s tz-mono">{cutSizeText(tpl.cut)}</small>}
      <span className="sb-card-f">
        {f.fileMissing && <IssueBadge tone="error">{t("flags.missing")}</IssueBadge>}
        {f.manualArea && <Tag tone="accent">{t("flags.manualArea")}</Tag>}
        {f.centerMeasured && <Tag tone="info">{t("flags.centerMeasured")}</Tag>}
        {f.ribbonPct > 0 && <Tag>{t("flags.ribbon", { pct: formatNumber(f.ribbonPct) })}</Tag>}
      </span>
    </button>
  );
}
