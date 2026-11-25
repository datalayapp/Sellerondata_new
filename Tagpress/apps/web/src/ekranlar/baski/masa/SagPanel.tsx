import { PRINT_DPI, PRINT_DPI_MAX, PRINT_DPI_MIN, type PrintSessionNotice, type PrintTemplate, type PrintTemplateView } from "@tagpress/domain";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMm, formatNumber } from "../../../i18n/bicim.ts";
import type { Page, PagePatch, Session, Templates } from "../mantik/desk-model.ts";
import { dpiInput, type ExportFormat, exportKey, type ExportOptions, type ExportScope, itemCount, pageFill, type PdfMode, sheetCount } from "../mantik/masa.ts";
import { stamp } from "../mantik/shelf.ts";
import { Button, CollapsedGroup, Dialog, IconButton, IssueBox, NumberStepper, Panel, PanelSection, ProgressBar, PropRow, Segmented, Select, Switch, TextField, Tooltip } from "../../../tezgah/index.ts";
import { useDosya } from "./useDosya.ts";

/** Dosyaları sırayla indirir (tarayıcı art arda indirmelere izin versin diye kısa aralıkla). */
function downloadAll(files: Array<{ name: string; url: string }>) {
  files.forEach((f, i) => {
    window.setTimeout(() => {
      const a = document.createElement("a");
      a.href = f.url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 350);
  });
}

export interface SagPanelProps {
  session: Session;
  /** Oturum bildirimleri (düzenleyiciden; sürüm artmadan da değişebilir). */
  notices: readonly PrintSessionNotice[];
  activePage: Page | null;
  templates: Templates;
  liveTemplates: PrintTemplateView[];
  readOnly: boolean;
  markWarnings: Array<{ id: string; name: string }>;
  /** Tasarım dilindeki çözünürlük (dpi). */
  defaultDpi: number | null;
  settle(): Promise<number | null>;
  printing: boolean;
  onPatchPage(id: string, patch: PagePatch, key?: string): void;
  onTemplate(pageId: string, templateId: string): void;
  onDeletePage(id: string): void;
  onEditTemplate(templateId: string): void;
  onMarkPrinted(): void;
  onReprint(): void;
  /** Yeniden planla (masadaki eylem); "Dosyayı üret" onayındaki "Önce yeniden planla" bunu çağırır. */
  onReplan(): void;
}

/**
 * Sağ panel: etkin sayfanın adı (tıklayınca değişir), kilidi ve silme başlıkta; şablon, kopya, sipariş adı; dosya
 * biçimi ve kapsamı; şablon değerleri ile PDF türü ve çözünürlük kapalı gruplarda; altta "Dosyayı üret" ve "Basıldı
 * olarak işaretle" (basılmış oturumda "Yeniden bas").
 */
export function SagPanel(p: SagPanelProps) {
  const { t } = useTranslation("printDesk");
  const page = p.activePage;
  const tpl = page ? p.templates.get(page.templateId) : undefined;
  const editable = !!page && !p.readOnly;

  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [pdfMode, setPdfMode] = useState<PdfMode>("raster");
  const [scope, setScope] = useState<ExportScope>("all");
  const [dpi, setDpi] = useState<number | null>(null);
  useEffect(() => {
    if (!page && scope === "page") setScope("all");
  }, [page, scope]);
  const options: ExportOptions = { format, pdfMode, scope, pageId: page?.id ?? null, dpi };
  const file = useDosya(p.session.id, p.settle);
  const [askStale, setAskStale] = useState(false);
  const planStale = p.notices.some((n) => n.code === "plan-stale");
  const stale = file.phase === "done" && file.madeWith !== null && file.madeWith !== exportKey(options);
  const shownDpi = dpi ?? p.defaultDpi;

  const title = page ? <SayfaAdi key={`${page.id}:${page.name}`} name={page.name} disabled={!editable} onRename={(name) => p.onPatchPage(page.id, { name })} /> : t("panel.session");
  const actions = page ? (
    <>
      <IconButton icon="lock" size={28} pressed={page.locked} disabled={p.readOnly} label={page.locked ? t("page.unlock") : t("page.lock")} title={t("page.lockHint")} onClick={() => p.onPatchPage(page.id, { locked: !page.locked })} />
      <IconButton icon="trash" size={28} disabled={!editable || page.locked} label={t("page.delete")} onClick={() => p.onDeletePage(page.id)} />
    </>
  ) : undefined;

  // Sayfanın şablonu arşivlenmişse listede yine görünür (seçili değer kaybolmasın).
  const tplOptions = p.liveTemplates.map((x) => ({ value: x.id, label: t("strip.templateOption", { name: x.name, count: x.capacity }) }));
  if (page && tpl && !tplOptions.some((o) => o.value === tpl.id)) tplOptions.unshift({ value: tpl.id, label: tpl.name });

  const footer = (
    <div className="bm-foot">
      <Button need="edit" variant="primary" size="page" wide icon="file" loading={file.starting || file.phase === "running"} onClick={() => (planStale ? setAskStale(true) : void file.start(options))}>
        {t("export.run")}
      </Button>
      {p.readOnly ? (
        <Button size="page" wide icon="print" onClick={p.onReprint}>
          {t("printed.reprint")}
        </Button>
      ) : (
        <Button variant="quiet" size="page" wide icon="stamp" loading={p.printing} onClick={p.onMarkPrinted}>
          {t("printed.mark")}
        </Button>
      )}
    </div>
  );

  const staleDialog = askStale ? (
    <Dialog
      title={t("notices.exportTitle")}
      size="sm"
      onClose={() => setAskStale(false)}
      footer={
        <>
          <Button
            variant="quiet"
            onClick={() => {
              setAskStale(false);
              void file.start(options);
            }}
          >
            {t("notices.exportAnyway")}
          </Button>
          <Button
            variant="primary"
            data-autofocus=""
            onClick={() => {
              setAskStale(false);
              p.onReplan();
            }}
          >
            {t("notices.replanFirst")}
          </Button>
        </>
      }
    >
      <p>{t("notices.exportBody")}</p>
    </Dialog>
  ) : null;

  const planTpl = tpl ?? p.templates.get(p.session.templateId ?? "");
  const fill = page ? pageFill(page, tpl) : null;

  return (
    <Panel side="right" title={title} actions={actions} footer={footer}>
      {staleDialog}
      {p.readOnly && (
        <PanelSection>
          <IssueBox tone="info">{t("printed.readOnly", { when: stamp(p.session.printedAt) })}</IssueBox>
        </PanelSection>
      )}
      {page && fill ? (
        <PanelSection>
          <PropRow label={t("page.template")}>
            <Select value={page.templateId} options={tplOptions} disabled={!editable || page.locked} aria-label={t("page.template")} onChange={(v) => v !== page.templateId && p.onTemplate(page.id, v)} />
          </PropRow>
          <PropRow label={t("page.copies")}>
            <NumberStepper
              value={page.copies}
              step={1}
              min={1}
              max={10000}
              format={(v) => formatNumber(v)}
              disabled={!editable}
              aria-label={t("page.copies")}
              onChange={(v) => p.onPatchPage(page.id, { copies: Math.round(v) }, `copies:${page.id}`)}
            />
          </PropRow>
          {tpl?.kind !== "sticker" && (
            <PropRow label={t("page.orderName")}>
              <span className="bm-row">
                <Switch checked={page.showCellLabels} disabled={!editable} label={t("page.orderName")} onChange={(v) => p.onPatchPage(page.id, { showCellLabels: v })} />
                <span className="bm-mut">{page.showCellLabels ? t("page.printed") : t("page.notPrinted")}</span>
              </span>
            </PropRow>
          )}
          <PropRow label={t("page.fillLabel")}>
            <span className="tz-mono">
              {fill.capacity === null ? t("page.fillFree", { count: fill.count }) : t("page.fill", { n: fill.count, capacity: fill.capacity })}
              {fill.extras > 0 && ` · ${t("page.extras", { count: fill.extras })}`}
            </span>
          </PropRow>
        </PanelSection>
      ) : (
        <PanelSection>
          {/* "Bir sayfayı ayarlamak için tuvalde ona tıklayın": açıklama metni panelde durmaz, sayfa sayısının ipucunda. */}
          <Tooltip content={t("panel.pickPage")}>
            <div className="bm-tipw">
              <PropRow label={t("panel.pages")}>
                <span className="tz-mono">{formatNumber(p.session.pages.length)}</span>
              </PropRow>
            </div>
          </Tooltip>
          <PropRow label={t("panel.sheets")}>
            <span className="tz-mono">{formatNumber(sheetCount(p.session))}</span>
          </PropRow>
          <PropRow label={t("panel.labels")}>
            <span className="tz-mono">{formatNumber(itemCount(p.session))}</span>
          </PropRow>
        </PanelSection>
      )}

      <PanelSection heading={t("export.title")}>
        {p.markWarnings.length > 0 && <IssueBox tone="warn">{t("export.markWarning", { names: p.markWarnings.map((m) => `“${m.name}”`).join(", ") })}</IssueBox>}
        <PropRow label={t("export.format")}>
          <Segmented
            value={format}
            aria-label={t("export.format")}
            onChange={setFormat}
            options={[
              { value: "pdf", label: t("export.pdf") },
              { value: "png", label: t("export.png") },
            ]}
          />
        </PropRow>
        <PropRow label={t("export.scope")}>
          <Segmented
            value={scope}
            aria-label={t("export.scope")}
            onChange={setScope}
            options={[
              { value: "all", label: t("export.allPages") },
              { value: "page", label: t("export.selectedPage") },
            ]}
          />
        </PropRow>
        {scope === "page" && !page && <p className="bm-mut">{t("export.pickPage")}</p>}
        <ExportState file={file} stale={stale} />
      </PanelSection>

      {planTpl && (
        <CollapsedGroup title={t("tpl.title")} summary={t("tpl.summary", { w: formatMm(planTpl.paper.wMm), h: formatMm(planTpl.paper.hMm), count: planTpl.slots.length })} persistKey="baski.sablon">
          <TemplateValues t={planTpl} onEdit={() => p.onEditTemplate(planTpl.id)} />
        </CollapsedGroup>
      )}
      <CollapsedGroup
        title={t("export.detail")}
        summary={`${format === "pdf" ? (pdfMode === "vector" ? t("export.vector") : t("export.raster")) : t("export.png")} · ${shownDpi ? t("export.dpiValue", { n: shownDpi }) : t("export.dpiDefault")}`}
        persistKey="baski.dosya"
      >
        {format === "pdf" && (
          <PropRow label={t("export.pdfMode")}>
            <Segmented
              value={pdfMode}
              aria-label={t("export.pdfMode")}
              onChange={setPdfMode}
              options={[
                { value: "raster", label: t("export.raster") },
                { value: "vector", label: t("export.vector") },
              ]}
            />
          </PropRow>
        )}
        {format === "pdf" && <p className="bm-mut">{pdfMode === "vector" ? t("export.vectorHint") : t("export.rasterHint")}</p>}
        <PropRow label={t("export.dpi")}>
          <NumberStepper value={shownDpi ?? PRINT_DPI} step={50} min={PRINT_DPI_MIN} max={PRINT_DPI_MAX} format={(v) => t("export.dpiValue", { n: v })} aria-label={t("export.dpi")} onChange={(v) => setDpi(dpiInput(v, p.defaultDpi))} />
        </PropRow>
        <p className="bm-mut">{dpi === null ? (p.defaultDpi ? t("export.dpiFromLanguage", { n: p.defaultDpi }) : t("export.dpiDefault")) : p.defaultDpi ? t("export.dpiManual", { n: p.defaultDpi }) : t("export.dpiManualOnly")}</p>
        <p className="bm-mut">{format === "pdf" ? t("export.pdfCopies") : t("export.pngPages")}</p>
      </CollapsedGroup>
    </Panel>
  );
}

/** Üretim durumu: ilerleme, hata, dosyalar ve "Hepsini indir". */
function ExportState({ file, stale }: { file: ReturnType<typeof useDosya>; stale: boolean }) {
  const { t } = useTranslation("printDesk");
  const { phase, progress, ex, error } = file;
  if (error) return <IssueBox tone="error">{t("export.failed", { detail: error })}</IssueBox>;
  if (phase === "idle") return null;
  if (phase === "running") {
    return (
      <div className="bm-exp" aria-live="polite">
        <span>{t("export.running", { done: progress.done, total: progress.total || "?" })}</span>
        <ProgressBar value={progress.done} max={Math.max(progress.total, 1)} label={t("export.progress")} />
      </div>
    );
  }
  if (phase === "failed") return <IssueBox tone="error">{ex?.error ? t("export.serverError", { detail: ex.error }) : ex?.status === "interrupted" ? t("export.interrupted") : t("export.failedShort")}</IssueBox>;
  const files = ex?.files ?? [];
  return (
    <div className="bm-exp" aria-live="polite">
      {stale && <p className="bm-mut">{t("export.stale")}</p>}
      <ul className="bm-files">
        {files.map((f) => (
          <li key={f.url}>
            <a href={f.url} download={f.name}>
              {f.name}
            </a>
            <small className="tz-mono">{f.bytes >= 1_048_576 ? t("export.mb", { n: formatNumber(f.bytes / 1_048_576, { maximumFractionDigits: 1 }) }) : t("export.kb", { n: Math.max(1, Math.round(f.bytes / 1024)) })}</small>
          </li>
        ))}
      </ul>
      {files.length > 1 && (
        <Button size="mini" variant="quiet" icon="file" onClick={() => downloadAll(files)}>
          {t("export.downloadAll", { count: files.length })}
        </Button>
      )}
    </div>
  );
}

/** Sayfa şablonunun değerleri (salt okunur) ve düzenleyiciye bağlantı. */
function TemplateValues({ t: tpl, onEdit }: { t: PrintTemplate; onEdit(): void }) {
  const { t } = useTranslation("printDesk");
  const d = tpl.labelDiameterMm ?? tpl.slots[0]?.w ?? null;
  return (
    <>
      <PropRow label={t("tpl.paper")}>
        <span className="tz-mono">{t("tpl.paperValue", { w: formatMm(tpl.paper.wMm), h: formatMm(tpl.paper.hMm) })}</span>
      </PropRow>
      <PropRow label={t("tpl.slots")}>
        <span className="tz-mono">{d && tpl.slots.length ? t("tpl.slotsValue", { count: tpl.slots.length, d: formatMm(d) }) : formatNumber(tpl.slots.length)}</span>
      </PropRow>
      <PropRow label={t("tpl.cut")}>
        <span>{tpl.cut.outlineVisible ? t("tpl.cutPrinted") : t("tpl.cutScreen")}</span>
      </PropRow>
      <PropRow label={t("tpl.marks")}>
        <span>{tpl.cut.registration.enabled ? t("tpl.on") : t("tpl.off")}</span>
      </PropRow>
      <Button size="mini" variant="quiet" icon="pen" onClick={onEdit}>
        {t("tpl.edit")}
      </Button>
    </>
  );
}

/** Panel başlığında sayfa adı: tıklayınca yerinde değişir (Enter kaydeder, Esc vazgeçer). */
function SayfaAdi({ name, disabled, onRename }: { name: string; disabled: boolean; onRename(v: string): void }) {
  const { t } = useTranslation("printDesk");
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(name);
  if (!editing || disabled) {
    return disabled ? (
      <span>{name}</span>
    ) : (
      <Tooltip content={t("page.renameHint")}>
        <button type="button" className="bm-pn" onClick={() => setEditing(true)}>
          {name}
        </button>
      </Tooltip>
    );
  }
  const done = (save: boolean) => {
    setEditing(false);
    const x = v.trim();
    if (save && x && x !== name) onRename(x);
    else setV(name);
  };
  return (
    <TextField
      className="bm-pn-in"
      autoFocus
      value={v}
      aria-label={t("page.name")}
      onChange={setV}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      }}
    />
  );
}
