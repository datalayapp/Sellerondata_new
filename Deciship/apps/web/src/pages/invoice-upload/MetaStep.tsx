import { useEffect, useRef, type RefObject } from "react";
import type { MappingVerification } from "@deciship/core";
import { Trans, useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import type { Carrier, InvoicePreview, JobView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { JobProgress } from "../../components/JobProgress";
import { TariffSelect } from "../../components/TariffSelect";
import { Card, Field, errorMessage } from "../../components/ui";
import { fmtNum } from "../../lib/format";
import { CURRENCIES, type MappingField } from "../../lib/labels";
import { fieldLabel, type Step } from "./uploadUtils";

interface InvoiceMeta {
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
}

/** Adım 3: fatura no / tarih / para birimi, tarife ve özet; içe aktarma hatası burada gösterilir. */
export function MetaStep({
  preview,
  meta,
  setMeta,
  metaTouched,
  metaErrs,
  found,
  importSlow,
  importJob,
  onStopImport,
  carrier,
  tariffId,
  setTariffId,
  tariffAuto,
  file,
  pdfRowCount,
  saveMapping,
  verification,
  hasIssues,
  createErr,
  exists,
  errRef,
}: {
  preview: InvoicePreview;
  meta: InvoiceMeta;
  setMeta: (m: InvoiceMeta) => void;
  metaTouched: boolean;
  metaErrs: { invoiceNo: string | null; invoiceDate: string | null };
  /** Dosyada (ya da yapay zekâ okumasında) gerçekten bulunan alanlar. */
  found: { invoiceNo: boolean; invoiceDate: boolean };
  importSlow: boolean;
  /** KALANLAR 6.18: büyük dosyanın içe aktarması arka planda; ilerleme bekleme notunun yerinde */
  importJob?: { job: JobView; receivedAt: number } | null;
  onStopImport?: () => void;
  carrier: Carrier | null;
  tariffId: string;
  /** `auto`: tarife kendiliğinden önseçildi (K2: fatura gününde geçerli, yoksa varsayılan); elle seçimde false. */
  setTariffId: (id: string, auto: boolean) => void;
  tariffAuto: boolean;
  /** yalnız adı gösterilir (sürdürme bandından açılan önizlemede yerel `File` yok) */
  file: { name: string } | null;
  pdfRowCount: number;
  saveMapping: boolean;
  verification?: MappingVerification;
  hasIssues: boolean;
  createErr: Error | null;
  exists: boolean;
  errRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("invoiceUpload");
  const waitRef = useRef<HTMLDivElement>(null);
  const queued = Boolean(importJob);
  useEffect(() => {
    if (importSlow || queued) waitRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [importSlow, queued]);
  const desc =
    found.invoiceNo && found.invoiceDate
      ? t("meta.desc")
      : found.invoiceNo || found.invoiceDate
        ? t("meta.descPartial")
        : t("meta.descNone");
  return (
    <Card
      title={t("meta.title")}
      description={desc}
    >
      <div className="meta-row">
        <Field
          label={t("meta.invoiceNo")}
          htmlFor="ino"
          className="req"
          error={metaTouched ? metaErrs.invoiceNo : null}
          help={
            !found.invoiceNo && !meta.invoiceNo ? (
              <span data-testid="meta-no-missing">{t("meta.noMissing")}</span>
            ) : null
          }
        >
          <input
            id="ino"
            className="inp mono w-lg"
            aria-invalid={
              (metaTouched && !!metaErrs.invoiceNo) || undefined
            }
            value={meta.invoiceNo}
            onChange={(e) =>
              setMeta({ ...meta, invoiceNo: e.target.value })
            }
          />
        </Field>
        <Field
          label={t("meta.invoiceDate")}
          htmlFor="idate"
          className="req"
          error={metaTouched ? metaErrs.invoiceDate : null}
          help={
            !found.invoiceDate && !meta.invoiceDate ? (
              <span data-testid="meta-date-missing">{t("meta.dateMissing")}</span>
            ) : null
          }
        >
          <input
            id="idate"
            type="date"
            className="inp w-md"
            aria-invalid={
              (metaTouched && !!metaErrs.invoiceDate) || undefined
            }
            value={meta.invoiceDate}
            onChange={(e) =>
              setMeta({ ...meta, invoiceDate: e.target.value })
            }
          />
        </Field>
        <Field label={t("meta.currency")} htmlFor="icur">
          <select
            id="icur"
            className="sel w-xs"
            value={meta.currency}
            onChange={(e) =>
              setMeta({ ...meta, currency: e.target.value })
            }
          >
            {Array.from(new Set([meta.currency, ...CURRENCIES])).map(
              (c) => (
                <option key={c}>{c}</option>
              ),
            )}
          </select>
        </Field>
      </div>
      {carrier && (
        <div className="tariff-fld">
          <TariffSelect
            id="itariff"
            carrierId={carrier.id}
            value={tariffId}
            onChange={(v, auto) => setTariffId(v, !!auto)}
            autoPicked={tariffAuto}
            date={meta.invoiceDate}
          />
        </div>
      )}
      <dl className="wsum">
        <div>
          <dt>{t("meta.carrier")}</dt>
          <dd>{carrier?.name}</dd>
        </div>
        <div>
          <dt>{t("meta.file")}</dt>
          <dd className="ellipsis" title={file?.name}>
            {file?.name}
          </dd>
        </div>
        <div>
          <dt>{t("meta.rows")}</dt>
          <dd className="num">
            {preview.format === "pdf"
              ? t("meta.rowsPdf", { n: fmtNum(pdfRowCount) })
              : fmtNum(preview.rowCount)}
          </dd>
        </div>
        {preview.format !== "pdf" && (
          <div>
            <dt>{t("meta.mapping")}</dt>
            <dd>
              {saveMapping
                ? t("meta.mappingSaved")
                : t("meta.mappingOnce")}
            </dd>
          </div>
        )}
        {verification && (
          <div>
            <dt>{t("meta.verification")}</dt>
            <dd className={hasIssues ? "warn-t" : "green"}>
              {hasIssues
                ? t("meta.issues", { count: verification.issues.length, n: fmtNum(verification.issues.length) })
                : t("meta.noIssues")}
            </dd>
          </div>
        )}
      </dl>
      {importJob ? (
        <div className="mt16" ref={waitRef} data-testid="import-job">
          <JobProgress job={importJob.job} receivedAt={importJob.receivedAt} onStop={onStopImport} />
        </div>
      ) : importSlow && (
        <div className="notif info mt16" role="status" ref={waitRef} data-testid="import-wait">
          <Icon name="info" />
          <span>
            <b>{t("meta.wait.title")}</b> {t("meta.wait.body")}
          </span>
        </div>
      )}
      {createErr && !(createErr instanceof ApiError && createErr.code === "INVOICE_OVERLAP") && (
        <div className="notif err mt16" role="alert" ref={errRef}>
          <Icon name="err" />
          <span>
            {createErr instanceof ApiError &&
            createErr.code === "MAPPING_UNVERIFIED" ? (
              <Trans t={t} i18nKey="meta.err.unverified" components={{ b: <b /> }} />
            ) : exists ? (
              <Trans
                t={t}
                i18nKey="meta.err.exists"
                values={{ carrier: carrier?.name, no: meta.invoiceNo }}
                components={{ b: <b />, mono: <span className="mono" /> }}
              />
            ) : (
              errorMessage(createErr)
            )}
          </span>
        </div>
      )}
    </Card>
  );
}

/** Alt çubuktaki durum iletisi (adım 2: eksik/sorun/hazır; adım 3: ne olacağı). */
export function WizbarMsg({
  step,
  missing,
  pdfInvalid,
  trackingEmpty,
  hasIssues,
  verification,
  isPdf,
  metaMissing,
}: {
  step: Step;
  missing: MappingField[];
  pdfInvalid: boolean;
  trackingEmpty: boolean;
  hasIssues: boolean;
  verification?: MappingVerification;
  isPdf: boolean;
  metaMissing: string[];
}) {
  const { t } = useTranslation("invoiceUpload");
  return (
    <>
      {step === 2 && missing.length > 0 && (
        <span className="red">
          <Icon name="err" /> {t("wiz.missing", { fields: missing.map((k) => fieldLabel(k)).join(", ") })}
        </span>
      )}
      {step === 2 && pdfInvalid && (
        <span className="red">
          <Icon name="err" /> {t("wiz.pdfInvalid")}
        </span>
      )}
      {step === 2 && !missing.length && trackingEmpty && (
        <span className="red">
          <Icon name="err" /> {t("wiz.trackingEmpty")}
        </span>
      )}
      {step === 2 &&
        !missing.length &&
        !pdfInvalid &&
        !trackingEmpty &&
        hasIssues && (
          <span className="warn-t">
            <Icon name="warn" /> {t("wiz.issues", { count: verification!.issues.length, n: fmtNum(verification!.issues.length) })}
          </span>
        )}
      {step === 2 &&
        !missing.length &&
        !pdfInvalid &&
        !trackingEmpty &&
        !hasIssues && (
          <span className="ok-msg">
            <Icon name="ok" /> {isPdf ? t("wiz.readyPdf") : t("wiz.readyMapped")}
          </span>
        )}
      {step === 3 && metaMissing.length > 0 && (
        <span className="warn-t">
          <Icon name="warn" /> {t("wiz.metaMissing", { fields: metaMissing.join(", ") })}
        </span>
      )}
      {step === 3 && metaMissing.length === 0 && (
        <span className="t3">
          {t("wiz.willImport")}
        </span>
      )}
    </>
  );
}
