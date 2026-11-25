import { API, type FixAction, type ImportRow, type Issue, type IssueCode, type LabelSize, type ProfileTryRequest, type ProfileTryResponse } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { fixLabel, issueText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { TemplatePicker, TemplateThumb, templateImageUrl } from "../../ortak/index.ts";
import { fixTextPreview, type SelectMods } from "./mantik/desk.ts";
import {
  displaySegments,
  fixesFor,
  isDuplicate,
  isTextEdited,
  issueShort,
  parseQuantity,
  quantityText,
  quotesStripped,
  type RowPatch,
  rowSeverity,
  sortIssues,
  templateSuggestions,
} from "./mantik/rows.ts";
import { Button, Checkbox, cx, Icon, IssueBadge, Kbd, Popover, Tag, TextArea } from "../../tezgah/index.ts";

export interface RowActions {
  patch(index: number, patch: RowPatch): void;
  activate(index: number): void;
  select(index: number, mods: SelectMods): void;
  startEdit(index: number): void;
  stopEdit(): void;
  setPicker(index: number, open: boolean): void;
  fix(index: number, issue: Issue, fix: FixAction): void;
}

export interface SatirProps {
  row: ImportRow;
  active: boolean;
  selected: boolean;
  editing: boolean;
  pickerOpen: boolean;
  validating: boolean;
  languageId: string | null;
  templateKeys: readonly string[];
  sizes: readonly LabelSize[];
  actions: RowActions;
}

const ORDER_CODES: IssueCode[] = ["order-missing"];
const QUANTITY_CODES: IssueCode[] = ["quantity-missing", "quantity-invalid"];
const SIZE_CODES: IssueCode[] = ["size-unknown"];
const TEMPLATE_CODES: IssueCode[] = ["template-missing", "template-unknown"];

/** Yazarken ham metni koruyan, odak çıkınca ya da Enter'da dışarıya yazan hücre girişi. */
function CellInput({ value, onText, invalid, field, label, placeholder, numeric }: { value: string; onText(t: string): void; invalid: boolean; field: string; label: string; placeholder?: string; numeric?: boolean }) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);
  return (
    <input
      data-field={field}
      value={text}
      inputMode={numeric ? "numeric" : undefined}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={cx("ia-cell", numeric && "tz-mono")}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        onText(e.target.value);
      }}
      onKeyDown={(e) => {
        // Enter/Esc: alandan çık, oklarla satır gezintisine dön.
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Yerinde metin düzenleme: Ctrl Enter kaydeder, Esc vazgeçer, odak çıkınca kaydeder; Enter yeni satırdır. */
function MetinDuzenle({ row, onSave, onDone }: { row: ImportRow; onSave(text: string): void; onDone(): void }) {
  const { t } = useTranslation("importDesk");
  const [text, setText] = useState(row.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(text);
    onDone();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="ia-edit">
      <TextArea
        ref={ref}
        autoGrow
        value={text}
        onChange={setText}
        aria-label={t("cols.text")}
        data-field="text"
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
          }
        }}
      />
      <p className="ia-edit-h">
        <Kbd combo="mod+enter" /> {t("edit.save")}
        <Kbd combo="escape" /> {t("edit.cancel")}
        <span>{t("edit.newLine")}</span>
        {row.textRaw !== text && (
          <button
            type="button"
            className="ia-link"
            // Odak çıkışı kaydetmesin diye fare basışında odağı almaz.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setText(row.textRaw)}
          >
            {t("edit.restoreRaw")}
          </button>
        )}
      </p>
      <p className="ia-raw tz-mono" title={t("edit.rawTitle")}>
        {t("edit.raw", { text: row.textRaw || t("edit.rawEmpty") })}
      </p>
    </div>
  );
}

/** Metin hücresi (düzenlenmiyorken): müşterinin satır ipuçları ara çizgiyle; tırnak ve düzenlendi işaretleri. */
function MetinGoster({ row, active, onEdit }: { row: ImportRow; active: boolean; onEdit(): void }) {
  const { t } = useTranslation("importDesk");
  const segments = displaySegments(row);
  const stripped = quotesStripped(row);
  const edited = isTextEdited(row);
  return (
    <>
      <button type="button" data-field="text-view" className="ia-text" title={t("row.editText")} onClick={onEdit}>
        {segments.length === 0 ? (
          <span className="ia-text-none">{t("row.noText")}</span>
        ) : (
          segments.map((s, k) => (
            <Fragment key={k}>
              {k > 0 && <span className="ia-seg" aria-hidden="true" />}
              <span className="ia-text-s">{s}</span>
            </Fragment>
          ))
        )}
        {stripped && (
          <span className="ia-mark" title={t("row.quotesTitle", { raw: row.textRaw })}>
            {t("row.quotes")}
          </span>
        )}
        {edited && (
          <span className="ia-mark ia-mark--ed" title={t("row.editedTitle", { raw: row.textRaw })}>
            {t("row.edited")}
          </span>
        )}
      </button>
      {row.product && (
        <span className="ia-sub" title={row.product}>
          {row.product}
        </span>
      )}
      {active && (stripped || edited) && <span className="ia-raw tz-mono">{t("edit.raw", { text: row.textRaw || t("edit.rawEmpty") })}</span>}
    </>
  );
}

/**
 * Yok sayılan uyarılar (maket T2 "süslü yazı": araç şeridinin sağında tek çip): bütün satırlardaki sayı; açılınca her
 * uyarı satır numarasıyla, yanında "Geri getir".
 */
export function YokSayilanlar({ rows, onRestore }: { rows: readonly ImportRow[]; onRestore(index: number, code: IssueCode): void }) {
  const { t } = useTranslation("importDesk");
  const items = rows.flatMap((r) => r.dismissed.map((code) => ({ index: r.index, code })));
  if (!items.length) return null;
  return (
    <Popover
      align="end"
      width={300}
      trigger={(p) => (
        <button type="button" className="ia-dis" {...p}>
          {t("row.dismissed", { count: items.length })}
        </button>
      )}
    >
      {(close) => (
        <ul className="ia-dis-l">
          {items.map(({ index, code }) => (
            <li key={`${index}:${code}`}>
              <span>{t("strip.dismissedItem", { n: index + 1, issue: issueShort({ code, message: code }) })}</span>
              <Button
                size="mini"
                variant="quiet"
                onClick={() => {
                  onRestore(index, code);
                  if (items.length === 1) close();
                }}
              >
                {t("row.restore")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

/** Sorun hücresi: en ağır sorunun kısa adı (+ kalan sayısı); hariç satırda "hariç". Boşsa sorun yok. */
function SorunHucresi({ row }: { row: ImportRow }) {
  const { t } = useTranslation("importDesk");
  const issues = sortIssues(row.issues);
  const first = issues[0];
  const title = issues.map((x) => issueText(x)).join("\n") || undefined;
  return (
    <>
      {!row.include ? (
        <span className="ia-exc-t">{isDuplicate(row) ? t("row.duplicateExcluded") : t("row.excluded")}</span>
      ) : (
        first && (
          <span className="ia-iss" title={title}>
            {first.severity === "info" ? <Tag>{issueShort(first)}</Tag> : <IssueBadge tone={first.severity === "error" ? "error" : "warn"}>{issueShort(first)}</IssueBadge>}
            {issues.length > 1 && <span className="ia-more tz-mono">{t("row.more", { n: issues.length - 1 })}</span>}
          </span>
        )
      )}
      {row.kind === "sticker" && !row.issues.some((x) => x.code === "sticker-detected") && <Tag>{t("row.sticker")}</Tag>}
    </>
  );
}

/** Sorunlu satırın altındaki düzeltme şeridi: her hata ve uyarı için cümle ve düğmeler; süslü yazıda iki hâlin önizlemesi. */
function DuzeltmeSeridi({ row, languageId, actions }: { row: ImportRow; languageId: string | null; actions: RowActions }) {
  const problems = sortIssues(row.issues).filter((x) => x.severity !== "info");
  const tone = rowSeverity(row) === "error" ? "is-err" : "is-warn";
  return (
    <div className={cx("ia-fix", tone)} role="row" data-fix-for={row.index}>
      <div role="cell" className="ia-fix-b">
        {problems.map((issue, k) => {
          const fixes = fixesFor(row, issue);
          const styled = issue.code === "text-unicode-styled";
          return (
            <div key={`${issue.code}:${k}`} className="ia-fix-i">
              <Icon name={issue.severity === "error" ? "err" : "warn"} size={15} className="ia-fix-ic" />
              <span className="ia-fix-t">{issueText(issue)}</span>
              <span className="ia-fix-x">
                {fixes.map((f, n) => (
                  <Button
                    key={`${f.kind}:${f.value ?? ""}:${n}`}
                    size="mini"
                    variant={styled || (f.kind !== "dismiss" && f.kind !== "skip") ? "secondary" : "quiet"}
                    onClick={() => actions.fix(row.index, issue, f)}
                  >
                    {fixLabel(f)}
                  </Button>
                ))}
              </span>
              {styled && <SusluOnizleme row={row} issue={issue} fixes={fixes} languageId={languageId} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Süslü yazı uyarısı: "Düz harfe çevir" ve "Olduğu gibi bas"ın sonucu iki etiket önizlemesi olarak (maket T2 "süslü
 * yazı"): satırın şablonunda, yayınlanmış profille ÜCRETSİZ motor denemesi (AI çağrılmaz, kayıt oluşmaz). Düz harf
 * önerilen yol olduğu için seçili çerçevede. Şablon yoksa, önizleme gelene dek ya da gelmezse iki hâl küçük metinle.
 */
function SusluOnizleme({ row, issue, fixes, languageId }: { row: ImportRow; issue: Issue; fixes: FixAction[]; languageId: string | null }) {
  const { t } = useTranslation("importDesk");
  const shown = fixes.filter((f) => f.kind === "convert-unicode" || f.kind === "dismiss");
  const convert = shown.find((f) => f.kind === "convert-unicode");
  const plain = convert ? fixTextPreview(row, issue, convert) : null;
  const templateKey = row.templateKey;
  const enabled = !!languageId && !!templateKey && plain !== null && plain.trim() !== "" && row.text.trim() !== "";
  const q = useQuery({
    queryKey: ["importStyledPreview", languageId, templateKey, plain, row.text],
    queryFn: () =>
      api.post<ProfileTryResponse>(path(API.profileTry, { lang: languageId ?? "" }), {
        samples: [
          { id: "plain", text: plain ?? "", templateKey, labelSize: null, referenceId: null },
          { id: "raw", text: row.text, templateKey, labelSize: null, referenceId: null },
        ],
        profiles: ["published"],
        mode: "engine",
      } satisfies ProfileTryRequest),
    enabled,
    retry: false,
    staleTime: Infinity,
  });
  if (!shown.length) return null;
  const url = (id: string) => q.data?.results.find((r) => r.sampleId === id)?.published?.previewUrl;
  const plainUrl = url("plain");
  const rawUrl = url("raw");
  if (enabled && plainUrl && rawUrl) {
    return (
      <div className="ia-pv-l">
        <figure className="ia-pv is-on">
          <img src={plainUrl} alt={t("styled.alt", { text: plain })} draggable={false} />
          <figcaption>{t("styled.plain")}</figcaption>
        </figure>
        <figure className="ia-pv">
          <img src={rawUrl} alt={t("styled.alt", { text: row.text })} draggable={false} />
          <figcaption>{t("styled.asIs")}</figcaption>
        </figure>
      </div>
    );
  }
  return (
    <dl className="ia-prev">
      {shown.map((f, n) => (
        <div key={`${f.kind}:${n}`}>
          <dt>{fixLabel(f)}</dt>
          <dd>{fixTextPreview(row, issue, f)}</dd>
        </div>
      ))}
    </dl>
  );
}

function SatirView({ row, active, selected, editing, pickerOpen, validating, languageId, templateKeys, sizes, actions }: SatirProps) {
  const { t } = useTranslation("importDesk");
  const i = row.index;
  const has = (codes: IssueCode[]) => row.issues.some((x) => codes.includes(x.code));
  const sev = rowSeverity(row);
  const sizeKnown = !row.labelSize || sizes.some((s) => s.id === row.labelSize);
  const tplText = row.templateKey ?? row.templateInput;
  const mods = useRef<SelectMods>({ shift: false, ctrl: true });
  const showFix = row.include && (sev === "error" || sev === "warning");
  return (
    <>
      <div
        role="row"
        aria-selected={selected}
        aria-busy={validating || undefined}
        data-row={i}
        className={cx(
          "ia-row",
          row.include && sev === "error" && "is-err",
          row.include && sev === "warning" && "is-warn",
          selected && "is-sel",
          active && "is-act",
          editing && "is-edit",
          !row.include && "is-exc",
          validating && "is-busy",
        )}
        onMouseDown={() => actions.activate(i)}
      >
        <span
          role="cell"
          className="ia-c ia-c-cb"
          onClickCapture={(e) => {
            mods.current = { shift: e.shiftKey, ctrl: true };
          }}
          onClick={(e) => {
            // Fareyle seçince odak kutuda kalmasın: Space ve Enter yeniden satırın olur.
            if (e.detail > 0) (e.target as HTMLElement).closest("button")?.blur();
          }}
        >
          <Checkbox checked={selected} onChange={() => actions.select(i, mods.current)} label={t("row.select", { n: i + 1 })} />
        </span>
        <span role="cell" className="ia-c">
          <CellInput
            field="orderNo"
            label={t("cols.orderNo")}
            value={row.orderNo ?? ""}
            placeholder="—"
            invalid={has(ORDER_CODES)}
            onText={(v) => actions.patch(i, { orderNo: v.trim() === "" ? null : v })}
          />
        </span>
        <span role="cell" className="ia-c ia-c-text">
          {editing ? <MetinDuzenle row={row} onSave={(v) => v !== row.text && actions.patch(i, { text: v })} onDone={actions.stopEdit} /> : <MetinGoster row={row} active={active} onEdit={() => actions.startEdit(i)} />}
        </span>
        <span role="cell" className="ia-c">
          <CellInput field="quantity" label={t("cols.quantity")} numeric value={quantityText(row.quantity)} placeholder="—" invalid={has(QUANTITY_CODES)} onText={(v) => actions.patch(i, { quantity: parseQuantity(v) })} />
        </span>
        <span role="cell" className="ia-c">
          <select
            data-field="labelSize"
            aria-label={t("cols.size")}
            aria-invalid={has(SIZE_CODES) || undefined}
            className="ia-cell ia-cell--sel"
            value={row.labelSize ?? ""}
            onChange={(e) => {
              actions.patch(i, { labelSize: e.target.value === "" ? null : e.target.value });
              e.currentTarget.blur();
            }}
          >
            <option value="">—</option>
            {!sizeKnown && <option value={row.labelSize ?? ""}>{row.labelSize}</option>}
            {sizes.map((s) => (
              <option key={s.id} value={s.id}>
                {t("row.sizeCm", { cm: formatNumber(s.cm) })}
              </option>
            ))}
          </select>
        </span>
        <span role="cell" className="ia-c">
          <TemplatePicker
            languageId={languageId}
            keys={templateKeys}
            value={row.templateKey}
            suggestions={templateSuggestions(row)}
            allowClear
            open={pickerOpen}
            onOpenChange={(o) => actions.setPicker(i, o)}
            onChange={(k) => actions.patch(i, { templateKey: k })}
            trigger={(p) => (
              <button
                type="button"
                data-field="template"
                className={cx("ia-tpl", has(TEMPLATE_CODES) && "is-invalid")}
                {...p}
                aria-label={t("row.templateLabel", { value: tplText ?? t("row.pickTemplate") })}
                title={row.templateKey ? row.templateKey : row.templateInput ? t("row.templateFileValue", { value: row.templateInput }) : t("row.pickTemplate")}
              >
                <TemplateThumb url={templateImageUrl(languageId, row.templateKey)} size={22} />
                <span className={cx("ia-tpl-t", !row.templateKey && "is-empty")}>{tplText ?? t("row.pickTemplate")}</span>
                <Icon name="chev" size={12} />
              </button>
            )}
          />
        </span>
        <span role="cell" className="ia-c ia-c-iss">
          <SorunHucresi row={row} />
        </span>
      </div>
      {showFix && <DuzeltmeSeridi row={row} languageId={languageId} actions={actions} />}
    </>
  );
}

export const Satir = memo(SatirView);
