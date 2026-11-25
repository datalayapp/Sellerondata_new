import { API, type FixAction, type ImportRow, type ImportValidateResponse, type Issue, type IssueCode, type JobDetail, type ProfileRecord } from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/bicim.ts";
import { fixLabel, issueText, notQueuedText, serverText } from "../i18n/sunucu.ts";
import { useCan } from "../lib/access.ts";
import { api, path } from "../lib/api.ts";
import { routeHash } from "../lib/route.ts";
import { fixesFor, parseQuantity, resolveFix, sortIssues, templateSuggestions } from "../ekranlar/ice-aktar/mantik/rows.ts";
import { IssueBox } from "../tezgah/durum/durum.tsx";
import { Button } from "../tezgah/dugme/Button.tsx";
import { Field, Select, TextArea, TextField } from "../tezgah/form/form.tsx";
import { Icon } from "../tezgah/ikon/Icon.tsx";
import { Dialog, useToast } from "../tezgah/katman/Dialog.tsx";
import { TemplatePicker, TemplateThumb, templateImageUrl } from "./ortak.tsx";

export interface ElleEkleProps {
  open: boolean;
  languageId: string;
  onClose(): void;
  onAdded(jobId: string): void;
}

/**
 * Elle ekle: tek bir sipariş. Eski `ManualAdd` ile aynı alanlar ve aynı çağrı (`POST /api/jobs/manual`).
 * Metin yazılırken sorunlar anında denetlenir (içe aktarma masasıyla aynı uç, `POST /api/import/validate`); hiçbir metin
 * kendiliğinden değişmez, yalnız tıklanan düzeltme uygulanır. Hata varken "Ekle ve üret" kapalıdır.
 * Ekledikten sonra pencere açık kalır (metin, sipariş no ve adet temizlenir; şablon ve boyut korunur): art arda eklemek için.
 * Ctrl+Enter ekler, Ctrl+Shift+Enter ekler ve üretir. "Ekle ve üret" ücretlidir: yapay zekâ izni yoksa düğme pasif,
 * kısayolu bir şey yapmaz ve `generate: true` hiç gönderilmez (sunucu 403 `FORBIDDEN` döner, hiçbir şey yazmaz).
 * Aynı form Üretim'in boş sayfasında pencere olmadan da durur (`useElleEkle` + `ElleEkleAlanlar`; orada yalnız ekler, üretmez).
 */
export function ElleEkle({ open, languageId, onClose, onAdded }: ElleEkleProps) {
  if (!open) return null;
  return <ElleEkleDialog languageId={languageId} onClose={onClose} onAdded={onAdded} />;
}

export type ElleEkleForm = ReturnType<typeof useElleEkle>;

/** Elle ekleme formunun durumu, anlık denetimi ve gönderimi (pencere ve Üretim'in sayfa içi kartı ortak kullanır). */
export function useElleEkle(languageId: string, onAdded: (jobId: string) => void) {
  const { t } = useTranslation("shared");
  const toast = useToast();
  const qc = useQueryClient();
  const canSpend = useCan("spend");
  const [text, setText] = useState("");
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [orderNo, setOrderNo] = useState("");
  const [quantity, setQuantity] = useState("");
  const [labelSize, setLabelSize] = useState("");
  const [busy, setBusy] = useState<null | "plain" | "generate">(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [dismissed, setDismissed] = useState<IssueCode[]>([]);
  const [checking, setChecking] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const sizeRef = useRef<HTMLSelectElement>(null);

  const profile = useQuery({
    queryKey: ["profile", languageId],
    queryFn: () => api.get<ProfileRecord>(path(API.profile, { lang: languageId })),
    enabled: !!languageId,
    staleTime: 60_000,
  });
  const sizeOptions = useMemo(
    () => [{ value: "", label: t("manualAdd.sizeDefault") }, ...(profile.data?.data.output.sizes ?? []).map((s) => ({ value: s.id, label: t("manualAdd.sizeCm", { cm: formatNumber(s.cm) }) }))],
    [profile.data, t],
  );

  // Anlık denetim: yazmayı bırakınca tek satırı sunucuya sor; eski yanıt yeniyi ezmesin diye sıra numarası.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!text.trim()) {
      setIssues([]);
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.post<ImportValidateResponse>(API.importValidate, {
          languageId,
          rows: [
            {
              index: 0,
              text,
              textRaw: text,
              templateInput: templateKey,
              templateKey,
              labelSize: labelSize === "" ? null : labelSize,
              orderNo: orderNo.trim() === "" ? null : orderNo,
              quantity: parseQuantity(quantity),
              dismissed,
            },
          ],
        });
        if (mine !== seq.current) return;
        setIssues(sortIssues(res.rows[0]?.issues ?? []));
        setChecking(false);
      } catch {
        if (mine !== seq.current) return;
        setChecking(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [text, templateKey, labelSize, orderNo, quantity, dismissed, languageId]);

  const suggestions = useMemo(() => templateSuggestions({ issues }), [issues]);
  const hasError = issues.some((i) => i.severity === "error");

  const onFix = (issue: Issue, fix: FixAction) => {
    const out = resolveFix({ text, dismissed } as ImportRow, issue, fix);
    if (out.type === "patch") {
      const p = out.patch;
      if (p.text !== undefined) setText(p.text);
      if (p.templateKey !== undefined) setTemplateKey(p.templateKey);
      if (p.labelSize !== undefined) setLabelSize(p.labelSize ?? "");
      if (p.orderNo !== undefined) setOrderNo(p.orderNo ?? "");
      if (p.quantity !== undefined) setQuantity(p.quantity === null ? "" : String(p.quantity));
      if (p.dismissed !== undefined) setDismissed(p.dismissed);
    } else if (out.type === "focus") (out.field === "quantity" ? qtyRef : out.field === "orderNo" ? orderRef : sizeRef).current?.focus();
    else if (out.type === "edit-text") textRef.current?.focus();
    else if (out.type === "pick-template") setPickerOpen(true);
    else if (out.type === "open-template") window.open(routeHash("sablonlar", [out.key]), "_blank", "noopener");
  };

  const canAdd = text.trim() !== "" && !busy;
  const dirty = text.trim() !== "" || orderNo.trim() !== "" || quantity.trim() !== "";

  const submit = async (generate: boolean) => {
    if (!canAdd || (generate && !canSpend)) return;
    setBusy(generate ? "generate" : "plain");
    try {
      const job = await api.post<JobDetail & { notQueued?: { code: string; message: string } }>(API.jobsManual, {
        languageId,
        text,
        templateKey,
        labelSize: labelSize === "" ? null : labelSize,
        orderNo: orderNo.trim() === "" ? null : orderNo.trim(),
        quantity: parseQuantity(quantity),
        generate,
      });
      void qc.invalidateQueries({ queryKey: ["batches"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({
        tone: "success",
        message: job.notQueued
          ? t("manualAdd.addedNotQueued", { reason: notQueuedText(job.notQueued) })
          : job.orderNo
            ? t(generate ? "manualAdd.addedOrderGenerating" : "manualAdd.addedOrder", { no: job.orderNo })
            : t(generate ? "manualAdd.addedGenerating" : "manualAdd.added"),
        action: {
          label: t("manualAdd.openBatch"),
          run: () => {
            window.location.hash = routeHash("uretim", [], { parti: job.batchId, is: job.id });
          },
        },
      });
      onAdded(job.id);
      setText("");
      setOrderNo("");
      setQuantity("");
      textRef.current?.focus();
    } catch (e) {
      toast({ tone: "error", message: t("manualAdd.failed", { detail: serverText(e) }) });
    } finally {
      setBusy(null);
    }
  };

  return {
    languageId,
    text,
    setText,
    templateKey,
    setTemplateKey,
    orderNo,
    setOrderNo,
    quantity,
    setQuantity,
    labelSize,
    setLabelSize,
    sizeOptions,
    busy,
    issues,
    dismissed,
    setDismissed,
    checking,
    pickerOpen,
    setPickerOpen,
    suggestions,
    hasError,
    canAdd,
    dirty,
    onFix,
    submit,
    refs: { text: textRef, order: orderRef, quantity: qtyRef, size: sizeRef },
  };
}

function ElleEkleDialog({ languageId, onClose, onAdded }: Omit<ElleEkleProps, "open">) {
  const { t } = useTranslation("shared");
  const f = useElleEkle(languageId, onAdded);
  return (
    <Dialog
      title={t("manualAdd.title")}
      onClose={onClose}
      dirty={f.dirty}
      busy={f.busy !== null}
      footer={
        <>
          <span className="or-ea-hint">{t("manualAdd.keys")}</span>
          <Button variant="quiet" onClick={onClose} disabled={f.busy !== null}>
            {t("manualAdd.close")}
          </Button>
          <Button need="edit" onClick={() => void f.submit(false)} disabled={!f.canAdd} loading={f.busy === "plain"}>
            {t("manualAdd.add")}
          </Button>
          <Button need="spend" variant="primary" onClick={() => void f.submit(true)} disabled={!f.canAdd || f.hasError} title={f.hasError ? t("manualAdd.errorBlocks") : undefined} loading={f.busy === "generate"}>
            {t("manualAdd.addAndGenerate")}
          </Button>
        </>
      }
    >
      <div
        className="or-ea"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void f.submit(e.shiftKey && !f.hasError);
          }
        }}
      >
        <ElleEkleAlanlar form={f} autoFocus />
      </div>
    </Dialog>
  );
}

/** Formun alanları ve anlık denetimin sorunları (pencere ve sayfa içi kart). `compact`: kısa metin alanı, açıklamasız. */
export function ElleEkleAlanlar({ form: f, autoFocus, compact }: { form: ElleEkleForm; autoFocus?: boolean; compact?: boolean }) {
  const { t } = useTranslation("shared");
  return (
    <>
      <Field label={t("manualAdd.text")} hint={compact ? undefined : t("manualAdd.textHint")}>
        <TextArea ref={f.refs.text} autoFocus={autoFocus} rows={compact ? 2 : 4} value={f.text} onChange={f.setText} invalid={f.issues.some((i) => i.code === "text-missing")} placeholder={t("manualAdd.textPlaceholder")} />
      </Field>
      <Field label={t("manualAdd.template")}>
        <TemplatePicker
          languageId={f.languageId}
          value={f.templateKey}
          allowClear
          suggestions={f.suggestions}
          open={f.pickerOpen}
          onOpenChange={f.setPickerOpen}
          onChange={f.setTemplateKey}
          trigger={(p) => (
            <button type="button" className="or-ea-pick" {...p} aria-label={`${t("manualAdd.template")}: ${f.templateKey ?? t("manualAdd.templatePlaceholder")}`}>
              <TemplateThumb url={templateImageUrl(f.languageId, f.templateKey)} size={28} />
              <span className={f.templateKey ? undefined : "is-empty"}>{f.templateKey ?? t("manualAdd.templatePlaceholder")}</span>
              <Icon name="chev" size={15} />
            </button>
          )}
        />
      </Field>
      <div className="or-ea-row">
        <Field label={t("manualAdd.orderNo")}>
          <TextField ref={f.refs.order} value={f.orderNo} onChange={f.setOrderNo} />
        </Field>
        <Field label={t("manualAdd.quantity")}>
          <TextField ref={f.refs.quantity} value={f.quantity} onChange={f.setQuantity} inputMode="numeric" />
        </Field>
        <Field label={t("manualAdd.size")}>
          <Select ref={f.refs.size} value={f.labelSize} options={f.sizeOptions} onChange={f.setLabelSize} />
        </Field>
      </div>
      <div className="or-ea-issues" aria-live="polite" aria-busy={f.checking}>
        {f.issues.map((i, k) => (
          <IssueBox
            key={`${i.code}:${k}`}
            tone={i.severity === "error" ? "error" : i.severity === "warning" ? "warn" : "ok"}
            fixes={fixesFor({ include: false }, i).map((fx, n) => (
              <Button key={`${fx.kind}:${fx.value ?? ""}:${n}`} size="mini" onClick={() => f.onFix(i, fx)}>
                {fixLabel(fx)}
              </Button>
            ))}
          >
            {issueText(i)}
          </IssueBox>
        ))}
        {f.dismissed.length > 0 && (
          <Button size="mini" variant="quiet" onClick={() => f.setDismissed([])}>
            {t("manualAdd.restoreDismissed", { n: f.dismissed.length })}
          </Button>
        )}
      </div>
    </>
  );
}
