import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { carriers, invoices } from "../../api/endpoints";
import type { Invoice, InvoicePatch, RecalcPatch } from "../../api/types";
import { Icon } from "../../components/Icon";
import { TariffSelect } from "../../components/TariffSelect";
import { toast } from "../../components/Toast";
import { Field, Modal, ModalAction } from "../../components/ui";
import { disputeErrorText } from "../disputes/parts";
import { CURRENCIES } from "../../lib/labels";
import { useRecalcFlow } from "./RecalcDialog";
import { errorCode } from "./recalc";

const day = (v?: string | null) => (v ? v.slice(0, 10) : "");

export function EditInvoiceModal({
  invoice,
  onClose,
}: {
  invoice: Invoice;
  onClose: () => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const qc = useQueryClient();
  const cs = useQuery({ queryKey: ["carriers"], queryFn: carriers.list });
  const [init] = useState(() => ({
    invoiceNo: invoice.invoiceNo,
    invoiceDate: day(invoice.invoiceDate),
    periodFrom: day(invoice.periodFrom),
    periodTo: day(invoice.periodTo),
    currency: invoice.currency ?? "",
    carrierId: invoice.carrierId ?? invoice.carrier?.id ?? "",
    tariffId: invoice.tariffId ?? "",
  }));
  // eski faturada (tarifesi boş) açılışta önseçilen varsayılan "değişiklik" sayılmaz
  const [initTariff, setInitTariff] = useState(init.tariffId);
  const [f, setF] = useState(init);
  const [touched, setTouched] = useState(false);
  const [noErr, setNoErr] = useState<string | null>(null);
  // Mesaj 4: gönderilmiş itirazda taşıyıcı, tarih, tarife ve para birimi değişmez (sunucu 409 INVOICE_HAS_DISPUTE); alanlar baştan kilitli
  const locked = !!invoice.dispute?.active;
  const recalc = useRecalcFlow();
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      // tarife taşıyıcıya bağlı: taşıyıcı değişince yeni taşıyıcının varsayılanı önseçilir
      setF({
        ...f,
        [k]: e.target.value,
        ...(k === "carrierId" ? { tariffId: "" } : {}),
      });
      if (k === "invoiceNo" || k === "carrierId") setNoErr(null);
    };
  const errs = {
    invoiceNo: !f.invoiceNo.trim() ? t("edit.errors.invoiceNo") : null,
    invoiceDate: !f.invoiceDate ? t("edit.errors.invoiceDate") : null,
    periodTo:
      f.periodFrom && f.periodTo && f.periodTo < f.periodFrom
        ? t("edit.errors.periodTo")
        : null,
  };
  const recompare =
    f.carrierId !== init.carrierId ||
    f.tariffId !== initTariff ||
    f.invoiceDate !== init.invoiceDate ||
    f.currency !== init.currency;
  const body: InvoicePatch = {};
  if (f.invoiceNo.trim() !== init.invoiceNo)
    body.invoiceNo = f.invoiceNo.trim();
  if (f.invoiceDate !== init.invoiceDate) body.invoiceDate = f.invoiceDate;
  if (f.periodFrom !== init.periodFrom) body.periodFrom = f.periodFrom || null;
  if (f.periodTo !== init.periodTo) body.periodTo = f.periodTo || null;
  if (f.currency !== init.currency) body.currency = f.currency;
  if (f.carrierId !== init.carrierId) body.carrierId = f.carrierId;
  if (f.tariffId !== initTariff) body.tariffId = f.tariffId || null;

  const save = useMutation({
    // hesabı değiştiren alan varsa önizlemenin token'ı birlikte gider (sunucu kaydı o önizlemeye bağlar)
    mutationFn: (token?: string) => invoices.update(invoice.id, token ? { ...body, token } : body),
    meta: { silent: true },
    onSuccess: (inv) => {
      if (inv && typeof inv === "object")
        qc.setQueryData<Invoice>(["invoice", invoice.id], (old) =>
          old ? { ...old, ...inv } : inv,
        );
      qc.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["measurements"] });
      qc.invalidateQueries({ queryKey: ["measurement"] });
      toast.ok(
        t("edit.saved"),
        recompare ? t("edit.savedRecompared") : undefined,
      );
      onClose();
    },
    onError: (e) => {
      // bayat önizleme: önce/sonra akışı önizlemeyi yenileyip pencereyi yeniden gösterir
      if (errorCode(e) === "PREVIEW_STALE") return;
      if (errorCode(e) === "INVOICE_HAS_DISPUTE") {
        qc.invalidateQueries({ queryKey: ["invoice", invoice.id] });
        toast.err(t("edit.updateFailed"), t("edit.errors.hasDispute"));
      } else if (errorCode(e) === "DECIDED_LINES_CHANGE") {
        // Y123: karar izni olmayan, kararı verilmiş satırın tutarını değiştiren düzeltmeyi kaydedemez (sunucu kilit altında bakar)
        toast.err(t("edit.updateFailed"), t("edit.errors.decidedLinesChange"));
      } else if (e instanceof ApiError && e.code === "INVOICE_EXISTS") {
        setNoErr(t("edit.errors.exists"));
        document.getElementById("e-ino")?.focus();
      } else toast.err(t("edit.updateFailed"), disputeErrorText(e));
    },
  });

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (Object.values(errs).some(Boolean)) return;
    if (Object.keys(body).length === 0) return onClose();
    if (!recompare) return save.mutate(undefined);
    // hesabı değiştiren alan: kaydetmeden önce önce/sonra; rakam değişmiyorsa sormadan (önizlemenin token'ıyla) kaydedilir
    const patch: RecalcPatch = {};
    if (body.carrierId !== undefined) patch.carrierId = body.carrierId;
    if (body.tariffId !== undefined) patch.tariffId = body.tariffId;
    if (body.invoiceDate !== undefined) patch.invoiceDate = body.invoiceDate;
    if (body.currency !== undefined) patch.currency = body.currency;
    recalc.start({
      kind: "invoice",
      invoiceId: invoice.id,
      currency: f.currency,
      label: `${invoice.carrier?.name ?? ""} · ${invoice.invoiceNo}`,
      // sabit dayanak + değişiklik: taşıyıcı / tarife değişiyorsa sunucu yalnız tarife parçasını bugünküne geçirir
      basis: "pinned",
      patch,
      purpose: "edit",
      apply: (token) => save.mutateAsync(token),
    });
  };

  const carrierOpts = (cs.data ?? []).filter(
    (c) => c.active || c.id === init.carrierId,
  );
  if (!carrierOpts.some((c) => c.id === init.carrierId) && invoice.carrier)
    carrierOpts.unshift({
      ...invoice.carrier,
      code: invoice.carrier.code ?? "generic",
      active: true,
    });

  // önce/sonra penceresi açıkken düzenleme penceresi gizlenir (iki pencere üst üste Esc'i paylaşmasın); Vazgeç forma döner
  if (recalc.open) return recalc.dialog;

  return (
    <Modal
      busy={save.isPending || recalc.busy}
      label={`${invoice.carrier?.name ?? ""} · ${invoice.invoiceNo}`}
      title={t("edit.title")}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t("edit.cancel")}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="check"
            type="submit"
            form="inv-edit"
            loading={save.isPending || recalc.busy}
          >
            {t("edit.save")}
          </ModalAction>
        </>
      }
    >
      <form
        id="inv-edit"
        className="form-grid inv-edit-form"
        onSubmit={submit}
        noValidate
      >
        <Field
          label={t("edit.invoiceNo")}
          htmlFor="e-ino"
          className="req"
          error={noErr ?? (touched ? errs.invoiceNo : null)}
        >
          <input
            id="e-ino"
            className="inp mono"
            value={f.invoiceNo}
            onChange={set("invoiceNo")}
            aria-invalid={!!(noErr || (touched && errs.invoiceNo)) || undefined}
          />
        </Field>
        <Field
          label={t("edit.invoiceDate")}
          htmlFor="e-idate"
          className="req"
          error={touched ? errs.invoiceDate : null}
        >
          <input
            id="e-idate"
            type="date"
            className="inp"
            value={f.invoiceDate}
            disabled={locked}
            onChange={set("invoiceDate")}
            aria-invalid={(touched && !!errs.invoiceDate) || undefined}
          />
        </Field>
        <Field label={t("edit.periodFrom")} htmlFor="e-pfrom" help={t("edit.optional")}>
          <input
            id="e-pfrom"
            type="date"
            className="inp"
            value={f.periodFrom}
            onChange={set("periodFrom")}
          />
        </Field>
        <Field
          label={t("edit.periodTo")}
          htmlFor="e-pto"
          error={touched ? errs.periodTo : null}
          help={t("edit.optional")}
        >
          <input
            id="e-pto"
            type="date"
            className="inp"
            value={f.periodTo}
            onChange={set("periodTo")}
            aria-invalid={(touched && !!errs.periodTo) || undefined}
          />
        </Field>
        <Field label={t("edit.currency")} htmlFor="e-cur">
          <select
            id="e-cur"
            className="sel"
            value={f.currency}
            disabled={locked}
            onChange={set("currency")}
          >
            {Array.from(new Set([init.currency, ...CURRENCIES])).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("edit.carrier")} htmlFor="e-car">
          <select
            id="e-car"
            className="sel"
            value={f.carrierId}
            disabled={locked}
            onChange={set("carrierId")}
          >
            {carrierOpts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {f.carrierId && (
          <fieldset className="span-all ds-ro" disabled={locked}>
            <TariffSelect
              id="e-tariff"
              carrierId={f.carrierId}
              value={f.tariffId}
              onChange={(v, auto) => {
                setF((cur) => ({ ...cur, tariffId: v }));
                if (auto && !initTariff && f.carrierId === init.carrierId)
                  setInitTariff(v);
              }}
              date={f.invoiceDate}
              locked={locked}
            />
          </fieldset>
        )}
        {locked && (
          <div className="notif info span-all" role="status">
            <Icon name="lock" />
            <span>{t("edit.lockedByDispute")}</span>
          </div>
        )}
        {recompare && (
          <div className="notif warn span-all" role="status">
            <Icon name="warn" />
            <span>
              <Trans t={t} i18nKey="edit.recompareNotice" components={{ b: <b /> }} />
            </span>
          </div>
        )}
      </form>
    </Modal>
  );
}
