import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useAuth, usePermission } from "../../auth/AuthContext";
import { carriers } from "../../api/endpoints";
import type { Carrier, CarrierCode, JobView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { JobProgress } from "../../components/JobProgress";
import { toast } from "../../components/Toast";
import { Button, Card, ErrorState, Field, Skel, errorMessage } from "../../components/ui";
import { CARRIER_OPTIONS, carrierKind } from "../../lib/labels";
import { MAX_MB, acceptList, pdfReadState } from "./uploadUtils";
import { isDailyAiBudget, isFileProblem, retryUseless, sendFileHref } from "./resume";

// ---------------- Step 1 ----------------
const CARRIER_TINT: Partial<Record<CarrierCode, string>> = {
  fedex: "c-purple",
  ups: "c-brown",
  dhl: "c-yellow",
  aras: "c-blue",
  yurtici: "c-navy",
  mng: "c-orange",
  ptt: "c-gold",
};

export function StepOne({
  carriers: list,
  loading,
  loadError,
  carrierId,
  setCarrierId,
  file,
  onFile,
  busy,
  error,
  onRetry,
  onStop,
  job,
  jobReceivedAt = 0,
  onStopJob,
}: {
  carriers: Carrier[];
  loading: boolean;
  loadError: unknown;
  carrierId: string;
  setCarrierId: (id: string) => void;
  /** Seçili dosya; sürdürme bandından açılan önizlemede yerel dosya yok, yalnız adı (10-B9: "Geri" ile 1. adıma dönülünce). */
  file: { name: string } | null;
  onFile: (f: File) => void;
  busy: boolean;
  error: unknown;
  onRetry: () => void;
  /** Süren okumayı bırakır; dosya seçili kalır. */
  onStop?: () => void;
  /** Süren PDF okuma işi: bırakma alanında ilerleme çıkar, "Durdur" işi durdurur. */
  job?: JobView | null;
  jobReceivedAt?: number;
  onStopJob?: () => void;
}) {
  const { t } = useTranslation("invoiceUpload");
  const { me } = useAuth();
  // Taşıyıcı eklemek ayar izniyle (`POST /carriers`); yükleme izni olan ama ayar izni olmayan (Denetleyici, Muhasebe) görmez.
  const canAddCarrier = usePermission("deciship.settings.manage");
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const aiOff = error instanceof ApiError && error.code === "AI_DISABLED";
  // Y65: firmanın dosya alanı doldu; yeniden denemek işe yaramaz (sunucu metni ne yapılacağını söyler)
  const storageFull = error instanceof ApiError && error.code === "STORAGE_QUOTA_EXCEEDED";
  // Y62-E3: bu ayki yapay zekâ hakkı doldu; yeniden denemek işe yaramaz (sunucu metni yeni dönemin tarihini söyler)
  // Sistemin günlük yapay zekâ tavanı (AI_DAILY_BUDGET) da: yeniden denemek bugün işe yaramaz. Kural `retryUseless`.
  const noRetry = retryUseless(error);
  // PDF seçeneği: anahtar yoksa ya da hak dolduysa kapalı
  const pdf = pdfReadState(me);
  const needCarrier = Boolean(file) && !carrierId;

  return (
    <div className="wiz-one">
      <Card
        title={
          <>
            <span className="sec-no">1</span> {t("one.pickCarrier")}
          </>
        }
        description={t("one.pickCarrierDesc")}
        className={needCarrier ? "attn" : undefined}
      >
        {loadError ? (
          <ErrorState error={loadError} />
        ) : loading ? (
          <div className="carrier-pick">
            <Skel h={64} />
            <Skel h={64} />
            <Skel h={64} />
          </div>
        ) : (
          <>
            {list.length === 0 && !adding && (
              <div className="notif warn cp-notice">
                <Icon name="warn" />
                <span>
                  {t(canAddCarrier ? "one.noCarriers" : "one.noCarriersAsk")}
                </span>
              </div>
            )}
            <div
              className="carrier-pick"
              role="radiogroup"
              aria-label={t("one.carrier")}
            >
              {list.map((c) => {
                const on = carrierId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`cp${on ? " on" : ""}`}
                    onClick={() => setCarrierId(c.id)}
                  >
                    <span
                      className={`cp-logo ${CARRIER_TINT[c.code] ?? ""}`}
                      aria-hidden="true"
                    >
                      {c.name.charAt(0).toLocaleUpperCase("tr-TR")}
                    </span>
                    <span className="cp-txt">
                      <span className="cp-name">{c.name}</span>
                      {c.defaultMapping ? (
                        <span className="cp-sub">
                          <Icon name="check" size={12} /> {t("one.savedMapping")}
                        </span>
                      ) : (
                        carrierKind(c) && (
                          <span className="cp-sub">{carrierKind(c)}</span>
                        )
                      )}
                    </span>
                    <span className="cp-radio" aria-hidden="true">
                      {on && <Icon name="check" size={12} />}
                    </span>
                  </button>
                );
              })}
              {!adding && canAddCarrier && (
                <button
                  type="button"
                  className="cp cp-add"
                  onClick={() => setAdding(true)}
                >
                  <span className="cp-logo" aria-hidden="true">
                    <Icon name="plus" />
                  </span>
                  <span className="cp-txt">
                    <span className="cp-name">{t("one.addCarrier")}</span>
                    {list.length > 0 && (
                      <span className="cp-sub">{t("one.notListed")}</span>
                    )}
                  </span>
                </button>
              )}
            </div>
            {adding && (
              <QuickCarrier
                onDone={(id) => {
                  setAdding(false);
                  if (id) setCarrierId(id);
                }}
              />
            )}
          </>
        )}
      </Card>

      <Card
        title={
          <>
            <span className="sec-no">2</span> {t("one.uploadFile")}
          </>
        }
        description={t(pdf === "quota" ? "one.uploadFileDescQuota" : me?.aiAvailable ? "one.uploadFileDesc" : "one.uploadFileDescNoAi", { mb: MAX_MB })}
      >
        {busy && job ? (
          <div className="drop drop-job has-file" data-testid="drop-job">
            <span className="drop-ic">
              <Icon name="doc" size={24} />
            </span>
            <b className="drop-name">{file?.name}</b>
            <JobProgress
              job={job}
              receivedAt={jobReceivedAt}
              onStop={onStopJob}
              queuedText={t("one.pdfQueued")}
              backgroundText={t("one.pdfBackground")}
              slowAfterSec={90}
            />
          </div>
        ) : (
        <button
          type="button"
          className={`drop${over ? " over" : ""}${file && !busy ? " has-file" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
          disabled={busy}
          aria-describedby="drop-help"
        >
          {busy ? (
            <>
              <span className="drop-ic">
                <Icon name="spin" className="spin" size={24} />
              </span>
              <b>{t("one.reading", { name: file?.name })}</b>
              <span className="muted">
                {file?.name.toLowerCase().endsWith(".pdf")
                  ? t("one.readingPdf")
                  : t("one.readingTable")}
              </span>
            </>
          ) : file ? (
            <>
              <span className="drop-ic">
                <Icon name="doc" size={24} />
              </span>
              <b className="drop-name">{file.name}</b>
              <span
                className={needCarrier ? "drop-warn" : "muted"}
                id="drop-help"
              >
                {needCarrier
                  ? t("one.needCarrier")
                  : t("one.pickAnother")}
              </span>
            </>
          ) : (
            <>
              <span className="drop-ic">
                <Icon name="upload" size={24} />
              </span>
              <b>{t("one.drag")}</b>
              <span className="muted" id="drop-help">
                {t("one.or")}
              </span>
              <span className="btn btn-secondary drop-btn">
                <Icon name="doc" /> {t("one.browse")}
              </span>
              <span className="drop-fmt">
                <span className="code-tag">CSV</span>
                <span className="code-tag">XLSX</span>
                {pdf === "on" && <span className="code-tag">PDF</span>}
              </span>
            </>
          )}
        </button>
        )}
        {busy && !job && onStop && (
          <div className="mt8">
            <button type="button" className="link-btn" onClick={onStop}>
              {t("one.stopReading")}
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={acceptList(pdf === "on")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="invoice-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        {Boolean(error) && (
          <div className="notif err mt16" role="alert">
            <Icon name="err" />
            <span>
              {aiOff ? (
                <>
                  <Trans t={t} i18nKey="one.aiOff" components={{ b: <b /> }} />
                </>
              ) : isDailyAiBudget(error) ? (
                errorMessage(error)
              ) : storageFull ? (
                <>
                  <Trans t={t} i18nKey="one.storageFull" components={{ b: <b /> }} /> {errorMessage(error)}
                </>
              ) : (
                <>
                  <Trans t={t} i18nKey="one.readFailed" components={{ b: <b /> }} /> {errorMessage(error)}
                </>
              )}
            </span>
            {!noRetry && (
              <button type="button" className="link-btn act" onClick={onRetry}>
                <Icon name="refresh" /> {t("one.retry")}
              </button>
            )}
            {/* Y124-E4: dosyanın kendisi okunamadıysa destek e-postası (dosyayı kullanıcı ekler; otomatik gönderim yok) */}
            {isFileProblem(error) && (
              <a
                className="link-btn act"
                data-testid="send-file"
                href={sendFileHref(
                  [t("one.sendFileSubject"), me?.company.name, file?.name],
                  t("one.sendFileBody", { name: file?.name ?? "", code: (error as ApiError).code }),
                )}
              >
                <Icon name="mail" /> {t("one.sendFile")}
              </a>
            )}
          </div>
        )}
        <p className="wiz-hint">
          <Icon name="info" /> {t("one.hint")}
        </p>
      </Card>
    </div>
  );
}

function QuickCarrier({ onDone }: { onDone: (id?: string) => void }) {
  const { t } = useTranslation("invoiceUpload");
  const qc = useQueryClient();
  const [code, setCode] = useState<CarrierCode>("fedex");
  const [name, setName] = useState("FedEx");
  const m = useMutation({
    mutationFn: () => carriers.create({ code, name: name.trim() }),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["carriers"] });
      toast.ok(t("one.carrierAdded"), c.name);
      onDone(c.id);
    },
  });
  return (
    <div className="quick-carrier">
      <Field label={t("one.preset")} htmlFor="qc-code">
        <select
          id="qc-code"
          className="sel w-md"
          value={code}
          onChange={(e) => {
            const c = e.target.value as CarrierCode;
            setCode(c);
            setName(
              CARRIER_OPTIONS.find((o) => o.code === c)?.name.replace(
                / \(.*\)$/,
                "",
              ) ?? "",
            );
          }}
        >
          {CARRIER_OPTIONS.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("one.displayName")} htmlFor="qc-name">
        <input
          id="qc-name"
          className="inp w-lg"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="btn-row">
        <Button kind="secondary" onClick={() => onDone()}>
          {t("one.cancel")}
        </Button>
        <Button
          icon="plus"
          loading={m.isPending}
          disabled={!name.trim()}
          onClick={() => m.mutate()}
        >
          {t("one.add")}
        </Button>
      </div>
    </div>
  );
}
