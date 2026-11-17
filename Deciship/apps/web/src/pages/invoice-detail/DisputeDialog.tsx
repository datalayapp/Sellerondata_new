import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { ApiError } from "../../api/client";
import { invoices } from "../../api/endpoints";
import type { Invoice } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Icon } from "../../components/Icon";
import { toast } from "../../components/Toast";
import { Empty, ErrorState, Field, Modal, ModalAction, Skel, errorMessage } from "../../components/ui";
import { disputeEmailKey, mailPlan, needsLangConfirm, signatureHeaders } from "../../lib/disputeMail";
import { fmtMoney, fmtNum } from "../../lib/format";
import type { SendSelection } from "./DisputeDialogs";

type Lang = "tr" | "en";

// Hatırlanan taşıyıcı adresi: tarayıcı depolaması kapalıysa pencere yine çalışır.
function readEmail(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeEmail(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* depolama yoksa adres yalnız bu pencerede kalır */
  }
}

export function DisputeModal({
  invoice,
  onClose,
  onMarkSent,
  onShowPending,
}: {
  invoice: Invoice;
  onClose: () => void;
  /**
   * İtiraz izni olan kişi metni gönderdikten sonra kaydı buradan düşer. 10-B3: kayıt bu metnin satır kümesini taşır (sayı,
   * toplam, özet); arada liste değiştiyse sunucu kaydı durdurur.
   */
  onMarkSent?: (draft: SendSelection) => void;
  /** 10-B11: "Yeniden hesap bekleyen" satırları süzgeçte göster */
  onShowPending?: () => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const { t: td } = useTranslation("disputes");
  const { me, person } = useAuth();
  // KALANLAR 1.12: imzaya Merkez hesabındaki e-posta ve telefon (metin ve ZIP aynı mektubu yazsın)
  const sign = signatureHeaders(person?.person);
  const signKey = `${sign["X-Signature-Email"] ?? ""}|${sign["X-Signature-Phone"] ?? ""}`;
  const [lang, setLang] = useState<Lang>(i18n.language === "en" ? "en" : "tr");
  const [pendingLang, setPendingLang] = useState<Lang | null>(null);
  const emailKey = disputeEmailKey(me?.company.id ?? "", invoice.carrier?.id ?? invoice.carrierId ?? "");
  const [email, setEmail] = useState(() => readEmail(emailKey));
  const q = useQuery({
    queryKey: ["invoice", invoice.id, "dispute", lang, signKey],
    queryFn: () => invoices.dispute(invoice.id, lang, sign),
    retry: false,
    meta: { silent: true },
  });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (q.data) {
      setSubject(q.data.subject);
      setBody(q.data.body);
    }
  }, [q.data]);
  const edited = needsLangConfirm(q.data, { subject, body });
  const askLang = (next: Lang) => {
    if (next === lang) return;
    if (edited) setPendingLang(next);
    else setLang(next);
  };
  const confirmLang = () => {
    if (pendingLang) setLang(pendingLang);
    setPendingLang(null);
  };
  // mektubun dilinde kısa giriş: e-posta uygulamasına tam metin sığmazsa yalnız bu gider
  const shortBody = i18n.getFixedT(lang, "invoiceDetail")("dispute.mailShortBody") ?? "";
  const mail = mailPlan(email, subject, body, shortBody);
  const noLines =
    q.error instanceof ApiError && q.error.code === "NO_VERIFIED_LINES";
  const pendingLines = invoice.dispute?.recalcPendingLines ?? 0;
  const noPhoto = q.data?.linesWithoutPhoto ?? 0;

  const [zipBusy, setZipBusy] = useState(false);
  const downloadZip = async () => {
    setZipBusy(true);
    try {
      await invoices.downloadEvidenceZip(invoice.id, invoice.invoiceNo, lang, sign);
    } catch (e) {
      toast.err(t("dispute.evidenceFailed"), errorMessage(e));
    } finally {
      setZipBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${subject}\n\n${body}`);
      toast.ok(t("dispute.copied"), t("dispute.copiedBody"));
    } catch {
      toast.err(
        t("dispute.copyFailed"),
        t("dispute.copyFailedBody"),
      );
    }
  };

  return (
    <Modal
      label={`${invoice.carrier?.name} · ${invoice.invoiceNo}`}
      title={t("dispute.title")}
      size="wide"
      className="dispute-dlg"
      onClose={onClose}
      actions={
        q.data && (
          <>
            {onMarkSent && (
              <ModalAction
                kind="dark"
                icon="check"
                onClick={() => onMarkSent({ lineCount: q.data!.lineCount, total: q.data!.total, selectionDigest: q.data!.selectionDigest ?? null })}
              >
                {td("card.markSent")}
              </ModalAction>
            )}
            <ModalAction kind={mail.long ? "prim" : "dark"} icon="copy" onClick={copy}>
              {t("dispute.copy")}
            </ModalAction>
            <a
              className={`pa ${mail.long ? "dark" : "prim"} dispute-mail${!email ? " disabled" : ""}`}
              href={email ? mail.href : undefined}
              aria-disabled={!email}
              onClick={(e) => !email && e.preventDefault()}
            >
              <span>{t("dispute.openEmail")}</span>
              <Icon name="mail" />
            </a>
          </>
        )
      }
    >
      <div className="row center-y dispute-head">
        {/* telefonda dil seçimi daralıp "English" kesiliyordu: küçülmez, talep özeti alta iner */}
        <div className="seg dispute-lang" role="group" aria-label={t("dispute.language")}>
          <button
            type="button"
            className={lang === "tr" ? "on" : ""}
            aria-pressed={lang === "tr"}
            onClick={() => askLang("tr")}
          >
            {t("dispute.langTr")}
          </button>
          <button
            type="button"
            className={lang === "en" ? "on" : ""}
            aria-pressed={lang === "en"}
            onClick={() => askLang("en")}
          >
            {t("dispute.langEn")}
          </button>
        </div>
        {q.data && (
          <span className="muted">
            {/* K43: faturanın KDV oranı biliniyorsa talep KDV dahil hâliyle de (metindeki toplamla aynı) */}
            <Trans
              t={t}
              i18nKey={q.data.totalInclVat != null ? "dispute.summaryVat" : "dispute.summary"}
              count={q.data.lineCount}
              values={{
                n: fmtNum(q.data.lineCount),
                total: fmtMoney(q.data.total, invoice.currency),
                ...(q.data.totalInclVat != null ? { totalVat: fmtMoney(q.data.totalInclVat, invoice.currency) } : {}),
              }}
              components={{ b: <b className="red num" /> }}
            />
          </span>
        )}
      </div>
      {pendingLang && (
        <div className="notif warn dispute-langask" role="alert">
          <Icon name="warn" />
          <span>{t("dispute.langConfirm")}</span>
          <span className="dispute-langask-btns">
            <button type="button" className="link-btn" onClick={confirmLang}>
              {t("dispute.langChange")}
            </button>
            <button type="button" className="link-btn" onClick={() => setPendingLang(null)}>
              {t("dispute.langKeep")}
            </button>
          </span>
        </div>
      )}
      {q.isLoading ? (
        <div className="col">
          <Skel h={40} />
          <Skel h={240} />
        </div>
      ) : noLines ? (
        <Empty compact icon="flag" title={t("dispute.noLines.title")}>
          {t("dispute.noLines.body")}
        </Empty>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="col dispute-form">
          {/* 10-B11: göndermeden önce (spec/itiraz.md "Gönderim uyarısı"): rakamı güncellenmemiş satırlar */}
          {pendingLines > 0 && (
            <div className="notif warn" role="status">
              <Icon name="warn" />
              <span>
                {td("send.pendingLines", { count: pendingLines, n: fmtNum(pendingLines) })}
                {onShowPending && (
                  <>
                    {" "}
                    <button type="button" className="link-btn" onClick={onShowPending}>
                      {t("dispute.showPending")}
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
          {mail.long && (
            <div className="notif info">
              <Icon name="info" />
              <span>{t("dispute.longNotice")}</span>
            </div>
          )}
          <Field
            label={t("dispute.carrierEmail")}
            htmlFor="d-email"
            help={t("dispute.carrierEmailHelp")}
          >
            <input
              id="d-email"
              className="inp"
              type="email"
              placeholder={t("dispute.carrierEmailPlaceholder")}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                writeEmail(emailKey, e.target.value);
              }}
            />
          </Field>
          <Field label={t("dispute.subject")} htmlFor="d-subj">
            <input
              id="d-subj"
              className="inp"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <Field label={t("dispute.body")} htmlFor="d-body">
            <textarea
              id="d-body"
              className="txt dispute-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {/* KALANLAR 1.11: kargoya yalnız ona yönelik olan gider (metin + fotoğraflar). Fark raporu (Excel/PDF) iç rapordur:
              ölçen çalışanın adı, iç notlar, kararlar ve lehimize farklar içerir; burada önerilmez (fatura sayfasından indirilir). */}
          {((q.data?.photoCount ?? 0) > 0 || noPhoto > 0) && (
            <div className="inv-sum-fine dispute-attach">
              <span>{t("dispute.attachments")}</span>
              {(q.data?.photoCount ?? 0) > 0 && (
                <button type="button" className="link-btn" disabled={zipBusy} onClick={downloadZip}>
                  {t("dispute.evidenceZip")}
                </button>
              )}
              {/* 10-B11: kanıtı eksik satırlar göndermeden önce bilinsin */}
              {noPhoto > 0 && <span className="t3">{t("dispute.linesWithoutPhoto", { count: noPhoto, n: fmtNum(noPhoto) })}</span>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
