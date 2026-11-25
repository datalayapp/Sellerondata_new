import type { FixAction, Issue, JobDetail, JobLog, JobPatch, JobSummary, LabelSize, ProgressStep, VariantDetail, VariantSummary } from "@tagpress/domain";
import { type Ref, type RefObject, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { fixLabel, issueText } from "../../i18n/sunucu.ts";
import { parseQuantity } from "../ice-aktar/mantik/rows.ts";
import { canAdjust } from "../duzelt/mantik/adjust-math.ts";
import { HizliDuzelt, type HizliDuzeltHandle } from "../duzelt/gomulu.tsx";
import { isBusy, type Section } from "./mantik/jobs.ts";
import { orderNoValue, textCommit } from "./mantik/masa.ts";
import { TemplatePicker, TemplateThumb, templateImageUrl } from "../../ortak/index.ts";
import {
  Button,
  CollapsedGroup,
  Icon,
  IconButton,
  IssueBox,
  Kbd,
  Menu,
  type MenuItem,
  PanelSection,
  PropPair,
  PropRow,
  Segmented,
  Select,
  StatusDot,
  Tag,
  TextArea,
  TextField,
  Tooltip,
  useToast,
} from "../../tezgah/index.ts";
import { Details } from "./Ayrintilar.tsx";
import { AiNoteForm, KIND_KEY } from "./parcalar.tsx";

export interface JobFieldRefs {
  text: RefObject<HTMLTextAreaElement | null>;
  quantity: RefObject<HTMLInputElement | null>;
  order: RefObject<HTMLInputElement | null>;
  size: RefObject<HTMLSelectElement | null>;
}

export interface SidePanelProps {
  job: JobSummary & Partial<JobDetail>;
  languageId: string;
  sizes: LabelSize[];
  /** Tasarım dilinin varsayılan boyutu (iş boyutu boşken geçerli olan). */
  defaultSize?: string;
  variants: VariantSummary[];
  focused: VariantSummary | null;
  variantDetail: VariantDetail | undefined;
  issues: Issue[];
  log?: JobLog;
  logLoading: boolean;
  progress?: ProgressStep;
  refs: JobFieldRefs;
  position: { section: Section; index: number; total: number };
  pickerOpen: boolean;
  onPickerOpen(o: boolean): void;
  /** "Sipariş bilgileri" açık mı (sorun düzeltmesi bir alana götürünce açılır). */
  infoOpen: boolean;
  locked: boolean;
  busy: boolean;
  canSpend: boolean;
  quickRef: Ref<HizliDuzeltHandle>;
  revise: { open: boolean; value: string; ref: Ref<HTMLInputElement> };
  onReviseChange(v: string): void;
  onReviseOpen(o: boolean): void;
  onRevise(): void;
  onPrev(): void;
  onNext(): void;
  onClose(): void;
  onPatch(p: JobPatch): unknown;
  onFix(issue: Issue, fix: FixAction): void;
  onRegenerate(): void;
  onImage(): void;
  onSaveNote(note: string): void;
  onFocus(id: string): void;
  onApprove(): void;
  onUnapprove(): void;
  onAdjust(): void;
  onQuickSaved(): void;
  onPrint(): void;
  onOpenTemplate(key: string): void;
  onDeleteJob(): void;
  onDeleteVariant(v: VariantSummary): void;
  onToggleSuspect(v: VariantSummary): void;
}

const TONE = { error: "error", warning: "warn", info: "ok" } as const;

/**
 * Sağ panel ("küçük tezgâh", maket 3): karta tıklayınca sütunun sağında açılır (yeri ve geçişi `index.tsx` verir).
 * Üstte önceki/sonraki, sipariş no, ⋯ ve kapat; gövdede müşteri metni, sorunlar, seçenek şeridi (V1–Vn, Yeni), gömülü küçük tezgâh (`HizliDuzelt`) ve kapalı
 * gruplarda sipariş bilgileri ile ayrıntılar; altta tek birincil "Vn onayla" (Enter); "Ayrıntılı düzenle" (D) tasarım alanının başlığında.
 */
export function SidePanel(p: SidePanelProps) {
  const { t } = useTranslation("production");
  const job = p.job;
  const running = isBusy(job);
  const v = p.focused;
  const hasStale = p.variants.some((x) => x.stale);
  const adjustable = !!v && canAdjust(v);
  const warnings = job.issues.filter((i) => i.severity !== "info").length;

  const menu: Array<MenuItem | "sep"> = [];
  if (p.canSpend) {
    if (v) menu.push({ label: t("panel.revise"), icon: "spark", command: "uretim.revise", disabled: p.locked, onSelect: () => p.onReviseOpen(true) });
    menu.push({ label: t("panel.image"), icon: "img", disabled: running, onSelect: p.onImage });
    menu.push({ label: t("panel.newVariant"), icon: "refresh", command: "uretim.regenerate", disabled: running || p.locked, onSelect: p.onRegenerate });
  }
  if (v) {
    if (menu.length) menu.push("sep");
    menu.push({ label: v.suspect ? t("panel.unflag") : t("panel.flag", { no: v.no }), icon: "flag", onSelect: () => p.onToggleSuspect(v) });
    menu.push({ label: t("panel.deleteVariant", { no: v.no }), icon: "trash", disabled: p.locked, onSelect: () => p.onDeleteVariant(v) });
  }
  if (menu.length) menu.push("sep");
  menu.push({ label: t("panel.deleteJob"), icon: "trash", command: "uretim.delete", danger: true, onSelect: p.onDeleteJob });

  const footer = running ? (
    <div className="ur-side-run" aria-live="polite">
      <StatusDot tone="busy" label={job.status === "queued" ? t("card.queued") : t("card.generating")} />
      {p.progress && <small>{p.progress.message}</small>}
    </div>
  ) : p.variants.length === 0 ? (
    p.canSpend ? (
      <Button need="spend" variant="primary" size="page" wide icon="spark" command="uretim.regenerate" kbd={false} disabled={p.busy} onClick={p.onRegenerate}>
        {job.status === "failed" ? t("card.retry") : t("panel.generate")}
      </Button>
    ) : null
  ) : v?.approved ? (
    <>
      <Button size="page" wide icon="print" onClick={p.onPrint}>
        {t("panel.toPrint")}
      </Button>
      <div className="ur-row">
        <Button variant="quiet" size="mini" icon="undo" disabled={p.locked} onClick={p.onUnapprove}>
          {t("panel.unapprove")}
        </Button>
      </div>
    </>
  ) : (
    <>
      <Button need="edit" variant="primary" size="page" wide icon="check" command="uretim.approve" kbd disabled={!v || p.locked} loading={p.locked} onClick={p.onApprove}>
        {v ? t("panel.approve", { no: v.no }) : t("panel.approveNone")}
      </Button>
      <div className="ur-row">
        <span className="tz-sp" />
        <span className="ur-mut">{t("panel.nextHint")}</span>
      </div>
    </>
  );

  return (
    <aside className="ur-side" aria-label={t("panel.label")}>
      <header className="ur-side-h">
        <IconButton icon="left" command="uretim.prev" disabled={p.position.total < 2} onClick={p.onPrev} />
        <IconButton icon="right" command="uretim.next" disabled={p.position.total < 2} onClick={p.onNext} />
        <span className="ur-side-t">
          <b className="tz-mono">{job.orderNo ? t("card.order", { v: job.orderNo }) : t("panel.title")}</b>
          <small>
            {t("panel.position", { section: t(`sections.${p.position.section}.short`), n: p.position.index + 1, total: p.position.total })}
            {warnings > 0 && ` · ${t("card.warnings", { count: warnings })}`}
          </small>
        </span>
        <span className="tz-sp" />
        <Menu align="end" trigger={(tp) => <IconButton {...tp} icon="dots" label={t("panel.more")} />} items={menu} />
        <IconButton icon="x" command="uretim.close" onClick={p.onClose} />
      </header>

      <div className="ur-side-b">
        <PanelSection
          heading={t("panel.text")}
          aside={
            <>
              {job.textRaw !== undefined && job.textRaw !== job.text && <Tag>{t("panel.edited")}</Tag>}
              <Kbd command="uretim.editText" />
            </>
          }
        >
          <CustomerText key={job.id} job={job} inputRef={p.refs.text} onSave={(text) => p.onPatch({ text })} />
        </PanelSection>

        {hasStale && !running && (
          <IssueBox
            tone="warn"
            fixes={
              p.canSpend ? (
                <Button size="mini" icon="refresh" disabled={p.busy} onClick={p.onRegenerate}>
                  {t("panel.regenerate")}
                </Button>
              ) : undefined
            }
          >
            {t("panel.stale")}
          </IssueBox>
        )}

        {(p.issues.length > 0 || (job.error && job.status === "failed")) && (
          <div className="ur-issues" role="group" aria-label={v && p.variantDetail?.issues.length ? t("panel.issuesOf", { no: v.no }) : t("panel.issues")}>
            {job.error && job.status === "failed" && (
              <IssueBox tone="error">
                <b>{t("panel.failed")}</b> {job.error}
              </IssueBox>
            )}
            {p.issues.map((i) => (
              <IssueBox
                key={`${i.code}|${i.message}|${i.field ?? ""}`}
                tone={TONE[i.severity]}
                fixes={
                  i.fixes.length > 0 ? (
                    <>
                      {i.fixes.map((f, k) => (
                        <Button key={`${f.kind}-${k}`} size="mini" variant={k === 0 ? "secondary" : "quiet"} disabled={p.busy} onClick={() => p.onFix(i, f)}>
                          {fixLabel(f)}
                        </Button>
                      ))}
                    </>
                  ) : undefined
                }
              >
                {issueText(i)}
              </IssueBox>
            ))}
          </div>
        )}

        {(p.variants.length > 0 || running) && (
          <PanelSection heading={t("panel.variants")} aside={p.variants.length > 1 ? <span className="ur-mut">{t("panel.pickHint", { n: Math.min(9, p.variants.length) })}</span> : undefined}>
            <div className="ur-vs" role="radiogroup" aria-label={t("panel.variants")}>
              {p.variants.map((x, i) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={x.id === v?.id}
                  aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                  className={`ur-vth${x.id === v?.id ? " is-on" : ""}`}
                  onClick={() => p.onFocus(x.id)}
                >
                  {i < 9 && <span className="ur-vth-k tz-mono">{i + 1}</span>}
                  <img src={x.previewUrl} alt="" draggable={false} />
                  <span className="tz-mono">
                    {t("card.variant", { no: x.no })}
                    {x.approved && <Icon name="check" size={12} />}
                  </span>
                </button>
              ))}
              {running ? (
                <span className="ur-vth is-run" aria-live="polite">
                  <StatusDot tone="busy" />
                  <span>{t("card.generating")}</span>
                </span>
              ) : (
                p.canSpend && (
                  <Tooltip command="uretim.regenerate" content={t("panel.newVariant")}>
                    <button type="button" className="ur-vth is-add" disabled={p.locked} onClick={p.onRegenerate}>
                      <Icon name="plus" size={18} />
                      <span>{t("panel.new")}</span>
                    </button>
                  </Tooltip>
                )
              )}
            </div>
            {v && v.kind !== "text" && <p className="ur-hint">{t(KIND_KEY[v.kind])}</p>}
          </PanelSection>
        )}

        {p.revise.open && v && (
          <form
            className="ur-revise"
            onSubmit={(e) => {
              e.preventDefault();
              p.onRevise();
            }}
          >
            <TextField
              ref={p.revise.ref}
              className="ur-grow"
              leading={<Icon name="spark" size={15} />}
              value={p.revise.value}
              onChange={p.onReviseChange}
              aria-label={t("panel.revise")}
              placeholder={t("panel.revisePlaceholder", { no: v.no })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  p.onReviseOpen(false);
                }
              }}
            />
            <Button type="submit" size="mini" disabled={!p.revise.value.trim() || p.locked || p.busy}>
              {t("panel.reviseSubmit")}
            </Button>
          </form>
        )}

        {v && adjustable && (
          <PanelSection
            heading={t("panel.design")}
            aside={
              <Button size="tool" icon="pen" command="uretim.adjust" kbd onClick={p.onAdjust}>
                {t("panel.adjust")}
              </Button>
            }
          >
            <div className="ur-quick">
              <HizliDuzelt key={v.id} variantId={v.id} handleRef={p.quickRef} onSaved={p.onQuickSaved} />
            </div>
          </PanelSection>
        )}

        <OrderInfo {...p} />

        {p.variants.length > 0 && (
          <CollapsedGroup title={t("details.title")} summary={t("details.summary")} persistKey="uretim.ayrintilar">
            <Details variant={p.variantDetail} variants={p.variants} focusedId={v?.id ?? null} onFocus={p.onFocus} log={p.log} logLoading={p.logLoading} />
          </CollapsedGroup>
        )}
      </div>

      {footer && <footer className="ur-side-f">{footer}</footer>}
    </aside>
  );
}

/**
 * Sipariş bilgileri: no, adet, boyut, şablon, AI notu. Henüz üretilmemiş işte açık (önce bunlar düzelir), üretilmişte
 * kapalı grup; sorun düzeltmesi bir alana götürünce açılır.
 */
function OrderInfo(p: SidePanelProps) {
  const { t } = useTranslation("production");
  const job = p.job;
  const fields = (
    <>
      <PropPair>
        <CommitField label={t("panel.orderNo")} inputRef={p.refs.order} value={job.orderNo ?? ""} onCommit={(x) => void p.onPatch({ orderNo: orderNoValue(x) })} />
        <CommitField label={t("panel.quantity")} inputRef={p.refs.quantity} value={job.quantity === null ? "" : String(job.quantity)} onCommit={(x) => void p.onPatch({ quantity: parseQuantity(x) })} />
      </PropPair>
      <PropRow label={t("panel.size")}>
        <SizeControl job={job} sizes={p.sizes} defaultSize={p.defaultSize} selectRef={p.refs.size} onChange={(labelSize) => void p.onPatch({ labelSize })} />
      </PropRow>
      <PropRow label={t("panel.template")}>
        <span className="ur-row ur-grow">
          <TemplatePicker
            languageId={p.languageId}
            value={job.templateKey}
            open={p.pickerOpen}
            onOpenChange={p.onPickerOpen}
            align="end"
            allowClear
            onChange={(k) => void p.onPatch({ templateKey: k })}
            trigger={(tp) => (
              <button type="button" className="ur-tpl" {...tp} aria-label={`${t("panel.changeTemplate")}: ${job.templateKey ?? t("panel.noTemplate")}`}>
                <TemplateThumb url={templateImageUrl(p.languageId, job.templateKey)} size={20} />
                <span className="ur-tpl-t">{job.templateKey ?? t("panel.noTemplate")}</span>
                <Icon name="chev" size={15} className="ur-tpl-c" />
              </button>
            )}
          />
          {job.templateKey && <IconButton icon="pen" size={28} label={t("panel.openTemplate")} onClick={() => p.onOpenTemplate(job.templateKey as string)} />}
        </span>
      </PropRow>
      <AiNoteForm key={`${job.id}:${job.aiNote}`} count={1} initial={job.aiNote} onSave={p.onSaveNote} />
    </>
  );
  if (p.variants.length === 0) return <PanelSection heading={t("panel.info")}>{fields}</PanelSection>;
  const summary = [job.quantity !== null ? t("card.quantity", { count: job.quantity }) : null, job.templateKey].filter(Boolean).join(" · ");
  return (
    <CollapsedGroup key={p.infoOpen ? "open" : "closed"} title={t("panel.info")} summary={summary || undefined} defaultOpen={p.infoOpen}>
      {fields}
    </CollapsedGroup>
  );
}

/** Segmentle gösterilen en çok boyut sayısı; fazlası açılır listede. */
const SEGMENT_MAX = 4;

/**
 * Boyut: az boyutta segment (yalnız seçilide birim), çokta açılır liste. Segmentte boş boyut (dilin varsayılanı)
 * varsayılan boyutun segmenti olarak seçili görünür; ona basmak işi değiştirmez.
 */
function SizeControl({ job, sizes, defaultSize, selectRef, onChange }: { job: JobSummary & Partial<JobDetail>; sizes: LabelSize[]; defaultSize?: string; selectRef: RefObject<HTMLSelectElement | null>; onChange(id: string | null): void }) {
  const { t } = useTranslation("production");
  const current = job.labelSize ?? defaultSize;
  const segment = sizes.length > 0 && sizes.length <= SEGMENT_MAX && current !== undefined && sizes.some((s) => s.id === current);
  if (segment) {
    return (
      <Segmented
        aria-label={t("panel.size")}
        value={current}
        options={sizes.map((s) => ({ value: s.id, label: s.id === current ? t("panel.sizeCm", { v: formatNumber(s.cm) }) : formatNumber(s.cm) }))}
        onChange={(x) => {
          if (x !== current) onChange(x);
        }}
      />
    );
  }
  return (
    <Select
      ref={selectRef}
      aria-label={t("panel.size")}
      value={job.labelSize ?? ""}
      options={[{ value: "", label: t("panel.defaultSize") }, ...sizes.map((s) => ({ value: s.id, label: t("panel.sizeCm", { v: formatNumber(s.cm) }) }))]}
      onChange={(x) => onChange(x || null)}
    />
  );
}

/** Müşteri metni: yerinde düzenlenir; odaktan çıkınca ya da Ctrl Enter ile kaydedilir, Esc vazgeçer. Yalnız kullanıcı değiştirir. */
function CustomerText({ job, inputRef, onSave }: { job: JobSummary & Partial<JobDetail>; inputRef: RefObject<HTMLTextAreaElement | null>; onSave(text: string): unknown }) {
  const { t } = useTranslation("production");
  const toast = useToast();
  const [draft, setDraft] = useState(job.text);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(job.text);
  }, [job.text, editing]);
  const edited = job.textRaw !== undefined && job.textRaw !== job.text;

  const commit = () => {
    setEditing(false);
    const d = textCommit(draft, job.text);
    if (d === "same") return;
    if (d === "empty") {
      toast({ tone: "error", message: t("panel.emptyText") });
      setDraft(job.text);
      return;
    }
    void onSave(draft);
  };

  // Açıklama ipucunda; altta yalnız düzenlerken tuşlar, düzenlenmiş metinde "dosyadaki metne dön".
  const restore = edited && !editing && job.textRaw !== undefined;
  return (
    <div className="ur-text">
      {/* İçerik sabit kalır: ipucu kalkıp gelirse ağaç değişir ve alan odağını yitirir. */}
      <Tooltip content={t("panel.textHint")}>
        <TextArea
          ref={inputRef}
          autoGrow
          value={draft}
          aria-label={t("panel.text")}
          aria-keyshortcuts="E"
          spellCheck={false}
          onFocus={() => setEditing(true)}
          onChange={setDraft}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              const el = e.currentTarget;
              setDraft(job.text);
              setEditing(false);
              // Esc vazgeçer: taslak önce eski metne döner, odak sonraki karede bırakılır (blur kaydetmesin).
              requestAnimationFrame(() => el.blur());
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </Tooltip>
      {(editing || restore) && (
        <p className="ur-hint">
          {editing ? (
            t("panel.textKeys")
          ) : (
            <button type="button" className="ur-link" title={t("panel.editedHint", { raw: job.textRaw })} onClick={() => void onSave(job.textRaw as string)}>
              {t("panel.restore")}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function CommitField({ label, value, onCommit, inputRef }: { label: string; value: string; onCommit(v: string): void; inputRef: RefObject<HTMLInputElement | null> }) {
  const [text, setText] = useState(value);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(value);
  }, [value, focus]);
  return (
    <label className="ur-pf">
      <span>{label}</span>
      <TextField
        ref={inputRef}
        className="tz-mono"
        value={text}
        inputMode="numeric"
        onFocus={() => setFocus(true)}
        onChange={setText}
        onBlur={() => {
          setFocus(false);
          if (text !== value) onCommit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            setText(value);
            setFocus(false);
          }
        }}
      />
    </label>
  );
}
