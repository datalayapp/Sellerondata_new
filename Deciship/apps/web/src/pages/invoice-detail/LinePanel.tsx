import { showsDecision } from "./decisionVisible";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { invoices } from "../../api/endpoints";
import { usePermission } from "../../auth/AuthContext";
import type { Decision, Invoice, InvoiceLine, InvoiceLinePatch } from "../../api/types";
import { Icon } from "../../components/Icon";
import { PhotoStrip } from "../../components/Photos";
import { TariffLink } from "../../components/TariffLink";
import { toast } from "../../components/Toast";
import {
  DecisionTag,
  DiffTags,
  SidePanel,
  Skel,
  StatusTag,
  errorMessage,
} from "../../components/ui";
import { fmtDate, fmtDateTime, fmtDims, fmtKg, fmtMoney, fmtMoneySigned, fmtNum, getFormatLocale } from "../../lib/format";
import { fmtFxRate, fmtPct, fxSourceText, isDisputable, isPakNote, subMoney, uncheckedSurchargeTotal } from "@deciship/core";
import { PAGE_SIZE, applyLinePatch, badFields, billedDims, fxTitle, statusLabel } from "./lineUtils";
import { isFxMissingNote } from "@deciship/core";
import { MatchBox, NoteBox, ReadCheckBox } from "./PanelParts";
import { MatchModal, ReasonModal } from "./LineDialogs";
import { ApiError } from "../../api/client";
import { OutcomeTag, disputeErrorText } from "../disputes/parts";
import { useRecalcFlow } from "./RecalcDialog";
import { pendingKey, prevResultKey } from "./recalc";
import { i18n } from "../../i18n";
import { isCarrierPackaging, packagingName, packagingOf } from "../../lib/packaging";

export function LinePanel({
  line: l,
  loading,
  invoiceId,
  cur,
  onClose,
  onDecided,
  onPatched,
}: {
  line: InvoiceLine | null;
  loading: boolean;
  invoiceId: string;
  cur: string;
  onClose: () => void;
  onDecided: () => void;
  onPatched: (l: InvoiceLine) => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const { t: tDsp } = useTranslation("disputes");
  const qc = useQueryClient();
  const canDecide = usePermission("deciship.lines.decide");
  const showPrices = usePermission("deciship.prices.view");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  // Mesaj 4: donmuş satırda "Yeni ölçümle hesapla" (önce/sonra penceresi). Hesaptan sonra satır "Yeniden hesap bekleyen"
  // süzgecinden (ya da sekmesinden) düşer; panel "Satır bulunamadı" demesin, sonuç ve eski fark notu görünsün diye
  // satırın güncel hâli okunur ve sayfaya verilir (düzeltmede olduğu gibi).
  const recalc = useRecalcFlow({
    onApplied: () => {
      if (!l) return;
      const { id: lineId, trackingNo } = l;
      invoices
        .lines(invoiceId, { q: trackingNo, page: 1, pageSize: PAGE_SIZE })
        .then((r) => {
          const fresh = r.items.find((x) => x.id === lineId);
          if (fresh) onPatched(fresh);
        })
        .catch(() => undefined);
    },
  });
  const patch = useMutation({
    mutationFn: (b: InvoiceLinePatch & { okMsg: string }) => {
      const { okMsg: _ok, ...body } = b;
      return invoices.updateLine(l!.id, body);
    },
    meta: { silent: true },
    onSuccess: (r, v) => {
      applyLinePatch(qc, invoiceId, r.line, r.totals);
      onPatched(r.line);
      toast.ok(v.okMsg);
    },
    onError: (e) => toast.err(t("panel.updateFailed"), errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: ({
      decision,
      reason,
    }: {
      decision: Decision;
      reason?: string;
      edit?: boolean;
    }) => invoices.decide(l!.id, decision, reason, l!.decision),
    // Paketteki satır (409 LINE_IN_DISPUTE) ya da bu arada kararı değişen satır (409 LINE_CHANGED, 10-B13: panel gördüğü
    // kararı gönderir): kendi cümlesiyle söylenir, güncel durum okunur.
    meta: { silent: true },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === "LINE_IN_DISPUTE" || e.code === "LINE_CHANGED")) qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      toast.err(t("panel.updateFailed"), disputeErrorText(e));
    },
    onSuccess: (_r, v) => {
      toast.ok(
        v.edit
          ? t("panel.toast.reasonUpdated")
          : v.decision === "VERIFIED"
            ? t("panel.toast.addedToDispute")
            : v.decision === "ACCEPTED"
              ? t("panel.toast.accepted")
              : t("panel.toast.undone"),
      );
      setReasonOpen(false);
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // editing the reason keeps the same line selected; a fresh decision jumps to the next line
      if (v.decision !== "OPEN" && !v.edit) onDecided();
    },
  });

  if (!l) {
    return (
      <SidePanel
        title={loading ? <Skel w={200} h={24} /> : t("panel.notFound")}
        onClose={onClose}
      >
        {loading ? (
          <Skel />
        ) : (
          <p className="muted">
            {t("panel.notFoundHint")}
          </p>
        )}
      </SidePanel>
    );
  }

  const m = l.measurement;
  // pak/zarf satırı kapsam dışı (core notu): "ölçüm yok" yerine bunu söyle
  const pak = isPakNote(l.note);
  const c = l.currency ?? cur;
  const bd = billedDims(l);
  const bad = badFields(l);
  const billedCh = l.billedChargeableKg ?? l.billedKg;
  const chDelta =
    billedCh != null && l.ourChargeableKg != null
      ? billedCh - l.ourChargeableKg
      : null;
  const actDelta = l.actualKg != null && m ? l.actualKg - m.weightKg : null;
  const billedRows: { label: string; amount: number }[] = [
    ...(l.baseAmount != null
      ? [{ label: t("panel.freight"), amount: l.baseAmount }]
      : []),
    ...(l.discountAmount != null
      ? [{ label: t("panel.discount"), amount: -Math.abs(l.discountAmount) }]
      : []),
    ...(l.fuelAmount != null
      ? [{ label: t("panel.fuel"), amount: l.fuelAmount }]
      : []),
    ...l.surcharges.map((s) => ({
      label: t("panel.surchargeRow", { code: s.code, name: s.name ? ` · ${s.name}` : "" }),
      amount: s.amount,
    })),
  ];
  const over = l.diffAmount != null && l.diffAmount > 0 && l.status === "DIFF";
  // Tarifede olmayan ek ücretler: Beklenen'e faturadaki tutarıyla girer (iki tarafta eşit, farka etkisi yok)
  const passthrough = (l.breakdown ?? []).filter((b) => b.unchecked);
  const passTotal = uncheckedSurchargeTotal(passthrough);
  const tariffAmount =
    l.expectedAmount != null ? subMoney(l.expectedAmount, passTotal) : null;
  const pinned = Boolean(l.measurementPinned);
  // SPEC §3.8: beklenenin dayanağı (tarife | taşıyıcının faturadaki fiyatı) ve güven
  const byInvoice = l.pricingBasis === "INVOICE";
  const estimated = l.status === "DIFF" && l.confidence === "LOW";
  // Mesaj 5 (Y2): güveni düşük her satır "İncele" (uyumlu çıkan da); kısa neden `reviewCode` etiketinden
  const review = l.confidence === "LOW";
  const reviewLabel = l.reviewCode ? i18n.t(`reviewCode.${l.reviewCode}`) : null;
  const priceHero = showPrices && l.diffAmount != null;
  const carrierName =
    qc.getQueryData<Invoice>(["invoice", invoiceId])?.carrier?.name ?? t("panel.carrierFallback");
  const infoRows = (l.breakdown ?? []).filter((b) => b.info);
  // tarife dayanağında kur kalemi ayrıca (Tarife toplamı + Kur) gösterilir
  const calcRows = (l.breakdown ?? []).filter((b) => !b.unchecked && !b.info && (byInvoice || !b.fx));
  // Ambalaj satırı yalnız poşet / zarf söz konusuysa (bizde, faturada ya da fiyatlamada); kendi ambalajı satırında görünmez.
  const carrierCode = qc.getQueryData<Invoice>(["invoice", invoiceId])?.carrier?.code;
  const ourPack = m ? packagingOf(m.packaging) : null;
  const billedPack = l.packaging ?? null;
  const packDiff = l.diffTypes.includes("PACKAGING");
  const showPack = isCarrierPackaging(ourPack) || isCarrierPackaging(billedPack) || Boolean(l.pricedPackaging) || packDiff;
  const mLink = m
    ? `/measurements?id=${m.id}${pinned ? "" : `&q=${encodeURIComponent(l.trackingNo)}`}`
    : null;

  // Gönderilmiş itiraz paketindeki satırın kararı değişmez; geri çekilene dek açıklama gösterilir.
  const locked = !!qc.getQueryData<Invoice>(["invoice", invoiceId])?.dispute?.active?.lines.some((x) => x.invoiceLineId === l.id);
  // Y126: talebi sıfır olan satır itiraz listesine girmez (API 409 NO_CLAIM, toplu yolda `noClaim`); düğme gösterilmez.
  // Fiyat izni olmayan kullanıcıya tutar gelmez: düğme kalır, kuralı sunucu söyler.
  const claimable = !showPrices || isDisputable({ diffTypes: l.diffTypes ?? [], billedAmount: l.netAmount ?? 0, diffAmount: l.diffAmount ?? null, status: "DIFF" });
  const actions =
    !canDecide || l.status !== "DIFF" ? undefined : locked ? (
      <p className="dec-q dsp-locked">
        <Icon name="lock" size={14} /> {tDsp("card.lockedLine")}
      </p>
    ) : l.decision === "OPEN" ? (
      <>
        <p className="dec-q">{t("panel.decisionQ")}</p>
        <button
          type="button"
          className="pa dark"
          onClick={() => setReasonOpen(true)}
          disabled={decide.isPending}
        >
          <span>{t("reason.acceptTitle")}</span>
          <Icon name="check" />
        </button>
        {claimable && (
          <button
            type="button"
            className="pa prim"
            onClick={() => decide.mutate({ decision: "VERIFIED" })}
            disabled={decide.isPending}
          >
            <span>{t("panel.addToDispute")}</span>
            {decide.isPending ? (
              <Icon name="spin" className="spin" />
            ) : (
              <Icon name="flag" />
            )}
          </button>
        )}
      </>
    ) : (
      <>
        <p className="dec-q">
          {t("panel.decision")} <DecisionTag decision={l.decision} />
        </p>
        <button
          type="button"
          className="pa ghost"
          onClick={() => decide.mutate({ decision: "OPEN" })}
          disabled={decide.isPending}
        >
          <span>{t("panel.undoDecision")}</span>
          {decide.isPending ? (
            <Icon name="spin" className="spin" />
          ) : (
            <Icon name="back" />
          )}
        </button>
      </>
    );

  const delta = (n: number | null, show: boolean) =>
    show && n != null && Math.abs(n) > 0.049 ? (
      <span className="vs-delta">
        {n > 0 ? "+" : "−"}
        {fmtKg(Math.abs(n))}
      </span>
    ) : null;

  return (
    <SidePanel
      meta={
        <span className="pn-tags">
          <StatusTag status={l.status} />
          <DiffTags types={l.diffTypes} />
          {l.dispute ? (
            <OutcomeTag outcome={l.dispute.outcome} line />
          ) : showsDecision(l) ? (
            <DecisionTag decision={l.decision} />
          ) : null}
        </span>
      }
      title={<span className="mono">{l.trackingNo}</span>}
      onClose={onClose}
      actions={actions}
    >
      <p className="pn-sub">
        {[l.destCountry, l.service, l.shipDate && fmtDate(l.shipDate)]
          .filter(Boolean)
          .join(" · ") || t("line.rowNo", { n: l.rowIndex + 1 })}
      </p>
      {!canDecide && (
        <p className="pn-ro" title={t("panel.readOnlyTitle")}>
          <Icon name="lock" size={14} /> {t("panel.readOnly")}
        </p>
      )}

      {(l.parseFlags ?? []).length > 0 && (
        <fieldset className="ds-ro" disabled={!canDecide}>
        <ReadCheckBox
          line={l}
          busy={patch.isPending}
          onToggle={(checked) =>
            patch.mutate({
              parseChecked: checked,
              okMsg: checked
                ? t("panel.toast.markedChecked")
                : t("panel.toast.willRecheck"),
            })
          }
        />
        </fieldset>
      )}

      {showPrices && l.diffAmount != null && (
        <div
          className={`dhero${over ? " over" : l.diffAmount < 0 ? " under" : ""}`}
        >
          <div className="dhero-l">
            <span className="dhero-k">
              {over
                ? t("panel.overbilled")
                : l.diffAmount < 0
                  ? t("panel.underbilled")
                  : t("cols.discrepancy")}
            </span>
            <span className="dhero-v num">
              {fmtMoneySigned(l.diffAmount, c)}
            </span>
          </div>
          <div className="dhero-r num">
            <span>
              {t("cols.expected")} <b>{fmtMoney(l.expectedAmount, c)}</b>
            </span>
            <span>
              {t("cols.billed")} <b>{fmtMoney(l.netAmount, c)}</b>
            </span>
          </div>
          {l.expectedAmount != null && (
            <p className="pn-basis">
              <BasisText line={l} carrierName={carrierName} />
            </p>
          )}
          {review && (
            <p className="pn-basis est">
              <Trans
                t={t}
                i18nKey={estimated ? "panel.estimatedBasis" : "panel.reviewBasis"}
                values={{ reason: l.confidenceReason ?? reviewLabel ?? t("panel.unverifiedFromInvoice") }}
                components={{ b: <b /> }}
              />
            </p>
          )}
          {passTotal > 0 && (
            <p className="dhero-note">
              {t("panel.passthroughNote", { count: passthrough.length, n: fmtNum(passthrough.length), amount: fmtMoney(passTotal, c) })}
            </p>
          )}
        </div>
      )}

      {review && !priceHero && (
        // Fiyat görmeyen (ya da tutarı olmayan satır): yalnız kısa neden; ayrıntılı gerekçe tutar içerebilir
        <div className="notif warn pn-note" role="status">
          <Icon name="warn" />
          <span>
            <Trans
              t={t}
              i18nKey="panel.reviewBasis"
              values={{ reason: (showPrices ? l.confidenceReason : null) ?? reviewLabel ?? t("panel.unverifiedFromInvoice") }}
              components={{ b: <b /> }}
            />
          </span>
        </div>
      )}

      {l.prevResult && <PrevResultNote line={l} currency={c} showPrices={showPrices} />}
      {l.recalcPending && (
        <div className="notif warn pn-note" role="status">
          <Icon name="warn" />
          <span>
            {t("recalc.pendingNote", { what: t(pendingKey(l.recalcPending)) })}
            {locked && <> {t("recalc.errors.LINE_IN_DISPUTE")}</>}
          </span>
          {canDecide && !locked && (
            <button
              type="button"
              className="link-btn act"
              disabled={recalc.busy}
              onClick={() =>
                recalc.start({
                  kind: "invoice",
                  invoiceId,
                  currency: c,
                  label: l.trackingNo,
                  basis: "pinned",
                  lineIds: [l.id],
                  purpose: "measurement",
                })
              }
            >
              {recalc.busy ? <Icon name="spin" className="spin" /> : <Icon name="refresh" />}{" "}
              {t(l.recalcPending === "MEASUREMENT" ? "recalc.lineAction" : "recalc.lineActionOther")}
            </button>
          )}
        </div>
      )}

      {l.decision !== "OPEN" &&
        (l.decisionReason || l.decision === "ACCEPTED") && (
          <div className="notif ok pn-note">
            <Icon name="ok" />
            <span>
              <b>{t("panel.reasonLabel")}</b>{" "}
              {l.decisionReason || <span className="t3">{t("panel.reasonEmpty")}</span>}
            </span>
            {canDecide && l.decision === "ACCEPTED" && (
              <button
                type="button"
                className="link-btn act"
                onClick={() => setReasonOpen(true)}
              >
                <Icon name="edit" /> {t("header.edit")}
              </button>
            )}
          </div>
        )}

      <div className="sec">{t("panel.secMatch")}</div>
      <MatchBox
        key={`match-${l.id}`}
        line={l}
        readOnly={!canDecide || locked}
        busy={patch.isPending}
        onTracking={(trackingNo) =>
          patch.mutateAsync({ trackingNo, okMsg: t("panel.toast.trackingFixed") })
        }
        onMatch={() => setMatchOpen(true)}
        onUnpin={() =>
          patch.mutate({
            measurementId: null,
            okMsg: t("panel.toast.unpinned"),
          })
        }
      />

      <div className="sec">{t("panel.secDims")}</div>
      <table className="vs">
        <thead>
          <tr>
            <th>
              <span className="sr-only">{t("panel.field")}</span>
            </th>
            <th>
              {mLink ? (
                <Link
                  className="link-btn pn-mlink"
                  to={mLink}
                  title={t("panel.openMeasurement")}
                >
                  {t("cols.ourMeasurement")}
                </Link>
              ) : (
                t("cols.ourMeasurement")
              )}
            </th>
            <th>{t("cols.billed")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{t("panel.dimsCm")}</th>
            <td className={m ? "mono" : undefined}>
              {m ? (
                fmtDims(m.lengthCm, m.widthCm, m.heightCm)
              ) : (
                <span className="t3">{pak ? t("line.outOfScope") : t("line.noMeasurement")}</span>
              )}
            </td>
            <td className={`mono${bad.dims ? " bad" : ""}`}>{bd ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">{t("panel.actualKg")}</th>
            <td>{m ? fmtKg(m.weightKg) : "—"}</td>
            <td className={bad.actual ? "bad" : undefined}>
              {fmtKg(l.actualKg)}
              {delta(actDelta, bad.actual)}
            </td>
          </tr>
          <tr>
            <th scope="row">{t("panel.billableKg")}</th>
            <td>{fmtKg(l.ourChargeableKg)}</td>
            <td className={bad.chargeable ? "bad" : undefined}>
              {fmtKg(billedCh)}
              {delta(chDelta, bad.chargeable)}
            </td>
          </tr>
          {showPack && (
            <tr>
              <th scope="row">{t("panel.packaging")}</th>
              <td>{ourPack ? packagingName(ourPack, carrierCode) : "—"}</td>
              <td className={packDiff ? "bad" : undefined}>
                {billedPack ? packagingName(billedPack, carrierCode) : <span className="t3">{t("panel.packagingUnknown")}</span>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {l.pricedPackaging && (
        <p className="t3 s12 mt8">{t("panel.pricedPackaging", { pack: packagingName(l.pricedPackaging, carrierCode) })}</p>
      )}
      {!m && (
        <p className="t3 s12 mt8">
          {pak ? t("panel.pakNote") : t("panel.noMeasurementNote")}
        </p>
      )}

      {m && (
        <>
          <div className="sec">
            {t("panel.photos")}{" "}
            <span className="r">
              {m.measuredByName} · {fmtDateTime(m.measuredAt)}
            </span>
          </div>
          <PhotoStrip photos={m.photos ?? []} />
        </>
      )}

      <div className="sec">
        {byInvoice
          ? t("panel.expectedByInvoice")
          : t("panel.expectedByTariff", { fx: l.fx ? ` · ${l.fx.base}` : "" })}
      </div>
      {l.tariff && (
        <p className="ln-tariff">
          {t("header.tariff")}{" "}
          <TariffLink id={l.tariff.id} title={t("panel.openTariff")}>
            {l.tariff.name}
          </TariffLink>
        </p>
      )}
      {l.breakdown && l.breakdown.length > 0 ? (
        <table className="pb">
          <tbody>
            {calcRows.map((b, i) => (
              <tr key={i}>
                <td>{b.label}</td>
                <td>{fmtMoney(b.amount, b.currency ?? c)}</td>
              </tr>
            ))}
            {l.fx && !byInvoice && (
              <>
                <tr className="pb-sub">
                  <td>{t("panel.tariffTotal")}</td>
                  <td>{fmtMoney(l.fx.expected, l.fx.base)}</td>
                </tr>
                <tr className="pb-fx" title={fxTitle(l.fx)}>
                  <td>
                    {t("panel.fxRate", { base: l.fx.base, quote: l.fx.quote })}{" "}
                    <span className="t3">{fxSourceText(l.fx, getFormatLocale())}</span>
                  </td>
                  <td>× {fmtFxRate(l.fx.rate, getFormatLocale())}</td>
                </tr>
              </>
            )}
            {passthrough.length > 0 && (
              <>
                <tr className="pb-sub pb-tariff-sub">
                  <td>{byInvoice ? t("panel.computed") : t("panel.perTariff")}</td>
                  <td>{fmtMoney(tariffAmount, c)}</td>
                </tr>
                <tr className="pb-pass-h">
                  <td colSpan={2}>
                    {t("panel.passthroughHead")}
                    <span className="t3"> · {t("panel.passthroughSub")}</span>
                  </td>
                </tr>
                {passthrough.map((b, i) => (
                  <tr key={`u${i}`} className="pb-pass">
                    <td>+ {b.label}</td>
                    <td>{fmtMoney(b.amount, b.currency ?? c)}</td>
                  </tr>
                ))}
              </>
            )}
            <tr className="tot">
              <td>{t("cols.expected")}</td>
              <td>{fmtMoney(l.expectedAmount, c)}</td>
            </tr>
            {infoRows.map((b, i) => (
              <tr key={`i${i}`} className="pb-info">
                <td>{t("panel.infoRow", { label: b.label })}</td>
                <td>{fmtMoney(b.amount, b.currency ?? c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="t3 s12">
          {pak
            ? t("panel.noBreakdown.pak")
            : l.status === "UNMATCHED"
            ? (
              <>
                {t("panel.noBreakdown.unmatched")} <Link to="/measurements">{t("panel.goMeasurements")}</Link>
              </>
            )
            : l.status === "NO_TARIFF"
              ? isFxMissingNote(l.note)
                ? t("panel.noBreakdown.fx", { note: l.note })
                : t("panel.noBreakdown.noTariff")
              : t("panel.noBreakdown.none")}
        </p>
      )}

      <div className="sec">{t("cols.billed")}</div>
      <table className="pb">
        <tbody>
          {billedRows.map((b, i) => (
            <tr key={i}>
              <td>{b.label}</td>
              <td>{fmtMoney(b.amount, c)}</td>
            </tr>
          ))}
          <tr className="tot">
            <td>{t("panel.netAmount")}</td>
            <td>{fmtMoney(l.netAmount, c)}</td>
          </tr>
        </tbody>
      </table>
      <div className="sec">{t("panel.noteLabel")}</div>
      <NoteBox
        key={`note-${l.id}`}
        note={l.note ?? ""}
        busy={patch.isPending}
        onSave={(note) =>
          patch.mutateAsync({
            note: note || null,
            okMsg: note ? t("panel.toast.noteSaved") : t("panel.toast.noteDeleted"),
          })
        }
      />

      {mLink && (
        <p className="s12 mt16">
          <Link className="link-btn" to={mLink}>
            {t("panel.openMeasurement")} <Icon name="arrow" />
          </Link>
        </p>
      )}

      {matchOpen && (
        <MatchModal
          line={l}
          loading={patch.isPending}
          onClose={() => setMatchOpen(false)}
          onPick={(measurementId) =>
            patch.mutate(
              { measurementId, okMsg: t("panel.toast.matched") },
              { onSuccess: () => setMatchOpen(false) },
            )
          }
        />
      )}

      {recalc.dialog}
      {reasonOpen && (
        <ReasonModal
          trackingNo={l.trackingNo}
          initial={l.decision === "ACCEPTED" ? (l.decisionReason ?? "") : ""}
          editing={l.decision === "ACCEPTED"}
          loading={decide.isPending}
          onClose={() => setReasonOpen(false)}
          onSubmit={(reason) =>
            decide.mutate({
              decision: "ACCEPTED",
              reason,
              edit: l.decision === "ACCEPTED",
            })
          }
        />
      )}
    </SidePanel>
  );
}

/** Mesaj 4: "Ölçüm değişti; eski fark 120,00 ₺ (12.10.2026)". Fiyat görmeyene tutar yerine eski durum yazılır. */
function PrevResultNote({ line: l, currency, showPrices }: { line: InvoiceLine; currency: string; showPrices: boolean }) {
  const { t } = useTranslation("invoiceDetail");
  const p = l.prevResult!;
  const cause = t(prevResultKey(p.cause));
  const date = fmtDate(p.at);
  return (
    <p className="t3 s12 mt8 pn-prev">
      {showPrices && p.diffAmount != null
        ? t("recalc.prevDiff", { cause, amount: fmtMoneySigned(p.diffAmount, currency), date })
        : t("recalc.prevStatus", { cause, status: statusLabel(p.status), date })}
    </p>
  );
}

/** Beklenenin dayanağı, düz Türkçe (SPEC §3.8). */
function BasisText({ line: l, carrierName }: { line: InvoiceLine; carrierName: string }) {
  const { t } = useTranslation("invoiceDetail");
  const dev = l.rateDeviationPct;
  const pct = (n: number) => fmtPct(Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Math.abs(n), getFormatLocale());
  if (l.pricingBasis === "INVOICE") {
    return (
      <Trans
        t={t}
        i18nKey="basis.invoice"
        values={{ carrier: carrierName, lower: dev != null ? t("basis.lowerBy", { pct: pct(dev) }) : t("basis.lower") }}
        components={{ b: <b /> }}
      />
    );
  }
  if (l.pricingBasis === "TARIFF" && dev != null && dev > 1) {
    return (
      <Trans
        t={t}
        i18nKey="basis.tariffHigher"
        values={{ carrier: carrierName, pct: pct(dev) }}
        components={{ b: <b /> }}
      />
    );
  }
  return <>{t("basis.byTariff")}</>;
}
