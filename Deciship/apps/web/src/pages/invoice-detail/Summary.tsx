import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Invoice, InvoiceTotals } from "../../api/types";
import { useAuth, useHoldsPermission } from "../../auth/AuthContext";
import { Icon } from "../../components/Icon";
import { Skel } from "../../components/ui";
import { TermHint } from "../../components/TermHint";
import { InvoiceSourceLine } from "./Header";
import { basisNotice } from "./recalc";
import { HowComputed } from "./HowComputed";
import { ImportReportNotice } from "./ImportReport";
import { fmtDate, fmtMoney, fmtMoneySigned, fmtMoneySplit, fmtNum, getFormatLocale } from "../../lib/format";
import {
  TTK_DISPUTE_DAYS,
  disputeDeadlines,
  invoiceSummaryAmounts,
  nothingCompared,
  onlyDuplicateOvercharge,
  overchargeNote,
  summaryGap,
} from "@deciship/core";
import type { TFunction } from "i18next";

/** Özetin tek cümlesi (çekirdekteki `invoiceSummarySentence` ile aynı mantık, çevrilebilir). */
function summarySentence(t: TFunction, x: InvoiceTotals): string {
  const compared = x.match + x.diff;
  const pakU = x.pakUnmatched ?? 0;
  const pakT = x.pakNoTariff ?? 0;
  const parts: string[] = [];
  const partial = x.lines > 0 && compared < x.lines;
  if (partial) {
    parts.push(
      t(x.diff > 0 ? "summary.sentence.compared" : "summary.sentence.comparedNoDiff", {
        count: x.lines,
        compared: fmtNum(compared),
        total: fmtNum(x.lines),
      }),
    );
  } else if (x.diff === 0) {
    parts.push(t("summary.sentence.noDiff"));
  }
  if (x.diff > 0) parts.push(t("summary.sentence.diff", { count: x.diff, n: fmtNum(x.diff) }));
  const unmatched = x.unmatched - pakU;
  if (unmatched > 0) parts.push(t("summary.sentence.unmatched", { count: unmatched, n: fmtNum(unmatched) }));
  // Kur alınamayan satırın tarifesi var: "tarifesiz" denmez, asıl neden söylenir.
  const fx = Math.min(x.fxMissing ?? 0, x.noTariff - pakT);
  const noTariff = x.noTariff - pakT - fx;
  if (noTariff > 0) parts.push(t("summary.sentence.noTariff", { count: noTariff, n: fmtNum(noTariff) }));
  if (fx > 0) parts.push(t("summary.sentence.fxMissing", { count: fx, n: fmtNum(fx) }));
  if (pakU + pakT > 0) parts.push(t("summary.sentence.pak", { count: pakU + pakT, n: fmtNum(pakU + pakT) }));
  return parts.join(" · ");
}

/** Answer first: how much was overpaid and on how many lines. Counts live on the tabs below. */
export function InvoiceSummary({
  inv,
  line,
  onRecalc,
  recalcBusy,
  onShowPending,
}: {
  inv?: Invoice;
  /** Satır paneli açıkken tek satır: liste ve karar aynı anda görünsün. */
  line?: boolean;
  /** Mesaj 4: "Yeni tarifeyle / yeni ayarla hesapla" (yetki yoksa verilmez). */
  onRecalc?: (purpose: "tariff" | "rules") => void;
  recalcBusy?: boolean;
  /** Yeniden hesap bekleyen satırları süzer. */
  onShowPending?: () => void;
}) {
  const { t: tr } = useTranslation("invoiceDetail");
  const t = inv?.totals;
  const cur = inv?.currency ?? "";
  const over = t ? t.overchargeTotal > 0 : false;
  if (line) {
    return (
      <section className={`inv-sum inv-sum-line${over ? " over" : ""}`} aria-label={tr("summary.label")} aria-busy={!t || undefined}>
        <span className="inv-sum-l">{tr("summary.overpaid")}</span>
        <span className={`inv-sum-v num${over ? " red" : ""}`}>{t ? fmtMoney(t.overchargeTotal, cur) : <Skel w={120} h={20} />}</span>
        {t && <span className="inv-sum-n ellipsis">{summarySentence(tr, t)}</span>}
      </section>
    );
  }
  // Faturalanan ile Beklenen aynı kalemleri kapsar (mükerrer Faturalanan'da, beklenen karşılığı 0); tarifede olmayan ek
  // ücretler (Beklenen'e faturadaki tutarıyla dahil) ve fatura toplamı bilgi olarak ayrı satırda
  const a = t ? invoiceSummaryAmounts(t) : null;
  // büyük sayı ile Faturalanan − Beklenen farklıysa neden farklı olduğunu tek satırda söyle
  const note = t ? overchargeNote(t, t.overchargeTotal, getFormatLocale()) : null;
  // Mesaj 5: döküm varsa dipnotlar "Nasıl hesaplandı?" içine taşınır; yoksa bugünkü gibi kartta kalır
  const how = !!t?.reconciliation;
  const onlyDup = !!t && onlyDuplicateOvercharge(t, t.overchargeTotal);
  // hiç karşılaştırılan satır yok (ör. ölçümsüz yeni fatura): 0,00 yerine fatura toplamı ve "henüz karşılaştırılmadı"
  const none = !!t && nothingCompared(t);
  // büyük sayının altında: "= Faturalanan − Beklenen" ya da aradaki adımlar adlarıyla (döküm yoksa eski açıklama)
  const gap = t && !none && !onlyDup ? summaryGap(t, t.overchargeTotal) : null;
  const notes: string[] = [];
  if (how && a && t) {
    if (note && !gap) notes.push(tr("summary.overchargeNote"));
    if (a.unchecked > 0) notes.push(`${tr("summary.unchecked")} ${fmtMoney(a.unchecked, cur)}`);
    if (a.showInvoiceTotal && !none) notes.push(`${tr("summary.invoiceTotal")} ${fmtMoney(a.invoiceTotal, cur)}`);
  }
  return (
    <section
      className={`inv-sum lift${over ? " over" : ""}`}
      aria-label={tr("summary.label")}
      aria-busy={!t || undefined}
    >
      <div className="inv-sum-top">
        <div className="inv-sum-main">
          <span className="inv-sum-l">
            {tr("summary.overpaid")}{" "}
            <span className="inv-sum-l2">
              · {tr("summary.onCompared").toLocaleLowerCase(getFormatLocale())}, {tr("summary.exclVat")}
            </span>
          </span>
          <span className={`inv-sum-v num${over ? " red" : ""}`}>
            {t ? <Money n={t.overchargeTotal} cur={cur} /> : <Skel w={180} h={36} />}
          </span>
          {gap && (
            <span className="inv-sum-eq">
              {gap.parts.length === 0
                ? tr("summary.eq.equal")
                : [
                    `${tr("summary.eq.net")} ${fmtMoney(gap.net, cur)}`,
                    ...gap.parts.map((p) => `${tr(`summary.eq.part.${p.key}`)} ${fmtMoneySigned(p.amount, cur)}`),
                  ].join(" · ")}
            </span>
          )}
        </div>
        {a && t && (
          <dl className="inv-sum-kvs">
            {none ? (
              <>
                <div>
                  <dt>{tr("summary.invoiceTotal")}</dt>
                  <dd className="num">{fmtMoney(a.invoiceTotal, cur)}</dd>
                </div>
                <div className="pending">
                  <dt>{tr("summary.expected")}</dt>
                  <dd>{tr("summary.notCompared")}</dd>
                </div>
              </>
            ) : onlyDup ? (
              <div className="only-dup">
                <dd>{tr("summary.onlyDuplicates")}</dd>
              </div>
            ) : (
              <>
                <div>
                  <dt>
                    {tr("summary.billed")}
                    {a.duplicates > 0 && (
                      <>
                        {" "}
                        <span className="t3">
                          <Trans
                            t={tr}
                            i18nKey="summary.inclDuplicates"
                            components={{ dup: <TermHint hint={tr("common:diffHint.DUPLICATE")}>{""}</TermHint> }}
                          />
                        </span>
                      </>
                    )}
                  </dt>
                  <dd className="num">{fmtMoney(a.billed, cur)}</dd>
                </div>
                <div>
                  <dt>{tr("summary.expected")}</dt>
                  <dd className="num">{fmtMoney(a.expected, cur)}</dd>
                </div>
              </>
            )}
            <div>
              <dt>{tr("summary.inDisputeList")}</dt>
              <dd className="num">{fmtMoney(t.verifiedTotal, cur)}</dd>
            </div>
            {(t.estimatedOverchargeTotal ?? 0) > 0 && (
              <div className="est" title={tr("summary.estimatedNote")}>
                <dt>
                  {tr("summary.estimated")}{" "}
                  <span className="t3">
                    ({tr("summary.estimatedLines", { count: t.estimatedLines ?? 0, n: fmtNum(t.estimatedLines ?? 0) })})
                  </span>
                </dt>
                <dd className="num">{fmtMoney(t.estimatedOverchargeTotal ?? 0, cur)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
      <div className="inv-sum-foot">
        <span className="inv-sum-n">
          {t ? summarySentence(tr, t) : <Skel w={220} h={14} />}
        </span>
        {t && t.unmatched - (t.pakUnmatched ?? 0) > 0 && (
          <span className="inv-sum-n">
            {tr("summary.unmatchedHint")} <Link to="/measurements">{tr("panel.goMeasurements")}</Link>
          </span>
        )}
        {inv && <ImportReportNotice report={inv.importReport} currency={cur} />}
        {inv && t && t.diff > 0 && <DisputeDue inv={inv} />}
        {inv && <BasisNotice inv={inv} onRecalc={onRecalc} busy={recalcBusy} />}
        {t && (t.pendingLines ?? 0) > 0 && (
          <span className="inv-sum-n">
            {tr("recalc.pendingSummary", { count: t.pendingLines, n: fmtNum(t.pendingLines ?? 0) })}
            {onShowPending && (
              <>
                {" "}
                <button type="button" className="link-btn" onClick={onShowPending}>
                  {tr("recalc.showPending")}
                </button>
              </>
            )}
          </span>
        )}
        {inv?.tariffSuspect && <TariffSuspect inv={inv} />}
        {a && t && !how && note && <span className="inv-sum-fine">{tr("summary.overchargeNote")}</span>}
        {a && t && !how && a.unchecked > 0 && (
          <span className="inv-sum-fine" title={tr("summary.uncheckedNote")}>
            {tr("summary.unchecked")} {fmtMoney(a.unchecked, cur)}
          </span>
        )}
        {a && t && !how && a.showInvoiceTotal && !none && (
          <span className="inv-sum-fine">
            {tr("summary.invoiceTotal")} {fmtMoney(a.invoiceTotal, cur)}
          </span>
        )}
        {inv && <InvoiceSourceLine inv={inv} />}
      </div>
      {inv && how && <HowComputed inv={inv} notes={notes} />}
    </section>
  );
}

/**
 * Tek satır: "İtiraz için son gün 04.11.2026 · 3 gün kaldı" (TTK 8 gün, yalnız Türkiye firmasında; FedEx'te 30 günlük düzeltme
 * süresi de). Başka ülkede yalnız taşıyıcının kendi süresi yazılır, o da yoksa satır çıkmaz.
 */
function DisputeDue({ inv }: { inv: Invoice }) {
  const { t } = useTranslation("invoiceDetail");
  const [tip, setTip] = useState(false);
  const tipId = useId();
  const country = useAuth().me?.company.settings.country;
  const dl = disputeDeadlines(inv.invoiceDate, inv.carrier?.code, new Date(), country);
  if (!dl) return null;
  const sent = inv.dispute?.active;
  // gönderimden sonra listeye satır eklendiyse "zamanında" denmez: süre sayılmaya devam eder
  // KALANLAR 4a: süreye esas gün ilk gönderimdir (yeniden gönderimin günü değil)
  if (sent && !(inv.dispute?.unsentLineCount ?? 0)) return <SentDue inv={inv} ttk={sent.ttk} sentOn={sent.ttkSentOn ?? sent.sentOn} carrierLastDay={dl.carrier?.lastDay} />;
  const { ttk, carrier } = dl;
  const fedex =
    carrier && !carrier.expired
      ? t("due.carrierDeadline", { carrier: inv.carrier?.name ?? t("due.carrierFallback"), date: fmtDate(carrier.lastDay) })
      : null;
  if (!ttk && !fedex) return null;
  const left =
    ttk &&
    (ttk.daysLeft === 0
      ? t("due.today")
      : t("due.daysLeft", { count: ttk.daysLeft, n: fmtNum(ttk.daysLeft) }));
  const main = ttk ?? carrier;
  return (
    <>
      <span
        className={`inv-sum-due${main?.expired ? " over" : main && main.daysLeft <= 2 ? " soon" : ""}`}
      >
        {ttk
          ? ttk.expired
            ? t("due.expired", { count: TTK_DISPUTE_DAYS })
            : t("due.lastDay", { date: fmtDate(ttk.lastDay), left })
          : fedex}
        {ttk && fedex && <span className="t3"> · {fedex}</span>}
        {/* title yalnız fareyle çalışır; telefonda dokununca açılan küçük balon */}
        <button
          type="button"
          className="inv-sum-i"
          aria-label={t("due.about")}
          aria-expanded={tip}
          aria-controls={tipId}
          onClick={() => setTip((v) => !v)}
        >
          i
        </button>
      </span>
      {tip && (
        <span id={tipId} className="inv-sum-tip" role="note">
          {t(ttk ? "due.ttkNote" : "due.carrierNote")}
        </span>
      )}
    </>
  );
}

/** Gönderilmiş itiraz: sayaç durdu, süresinde mi gönderildiği yazılır. */
function SentDue({ inv, ttk, sentOn, carrierLastDay }: { inv: Invoice; ttk: "ON_TIME" | "LATE" | null; sentOn: string; carrierLastDay?: string }) {
  const { t } = useTranslation("disputes");
  const carrier = carrierLastDay
    ? `${inv.carrier?.name ?? t("deadline.carrierFallback")} · ${sentOn <= carrierLastDay ? t("deadline.onTime") : t("deadline.late")}`
    : null;
  const main = ttk ? `${t("deadline.ttkFull")} · ${ttk === "ON_TIME" ? t("deadline.onTime") : t("deadline.late")}` : carrier;
  if (!main) return null;
  const late = ttk ? ttk === "LATE" : !!carrierLastDay && sentOn > carrierLastDay;
  return (
    <span className={`inv-sum-due ${late ? "soon" : "ok"}`}>
      {main} ({fmtDate(sentOn)})
      {ttk && carrier && <span className="t3"> · {carrier}</span>}
    </span>
  );
}

/**
 * Mesaj 4: fatura hesaplandığı günkü tarife ve ayarla durur. Tarife ya da ayar sonradan değiştiyse kısa not ve tek eylem;
 * tarife silindiyse yalnız bilgi. Gönderilmiş itirazda yeni dayanakla hesap yapılmaz (sunucu 409): eylem yerine neden yazılır.
 */
function BasisNotice({ inv, onRecalc, busy }: { inv: Invoice; onRecalc?: (purpose: "tariff" | "rules") => void; busy?: boolean }) {
  const { t } = useTranslation("invoiceDetail");
  const n = basisNotice(inv.basis);
  if (!n) return null;
  if (!n.action) return <span className="inv-sum-fine">{t(n.key, { name: inv.basis?.tariffName ?? "" })}</span>;
  const action = n.action;
  return (
    <span className="inv-sum-warn" role="status">
      <Icon name="warn" />
      <span>
        {t(n.key, { name: inv.basis?.tariffName ?? "" })}
        {onRecalc &&
          (inv.dispute?.active ? (
            <span className="t3"> {t("recalc.band.locked")}</span>
          ) : (
            <>
              {" "}
              <button type="button" className="link-btn" disabled={busy} onClick={() => onRecalc(action)}>
                {t(action === "tariff" ? "recalc.band.actionTariff" : "recalc.band.actionRules")}
              </button>
            </>
          ))}
      </span>
    </span>
  );
}

/** Wiki "Riskler": satırların çoğunda fiyat farkı varsa tarife yanlış/eski olabilir. */
function TariffSuspect({ inv }: { inv: Invoice }) {
  const { t } = useTranslation("invoiceDetail");
  const tid = inv.tariff?.id ?? inv.tariffsUsed?.[0]?.id;
  const canOpenTariff = useHoldsPermission("deciship.tariffs.view");
  return (
    <span className="inv-sum-warn" role="status">
      <Icon name="warn" />
      <span>
        {t("suspect.text")}
        {tid && canOpenTariff && (
          <>
            {" "}
            <Link to={`/tariffs/${tid}`}>{t("suspect.open")}</Link>
          </>
        )}
      </span>
    </span>
  );
}

/** Büyük tutar: birim küçük; parçalar paketten (`fmtMoneySplit`), metin ayrıştırılmaz. */
function Money({ n, cur }: { n: number; cur: string }) {
  const p = fmtMoneySplit(n, cur);
  return (
    <>
      {p.before}
      {p.small && <small>{p.small}</small>}
      {p.after}
    </>
  );
}
