import { useSyncExternalStore } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import type { Invoice } from "../../api/types";
import { Icon } from "../../components/Icon";
import { TariffLink } from "../../components/TariffLink";
import {
  Button,
  PageHeader,
  Skel,
  StatusPill,
} from "../../components/ui";
import { fmtDate, fmtDateTime, fmtNum } from "../../lib/format";
import { buildWhatsAppText, disputeDeadlines, whatsAppUrl } from "@deciship/core";
import { getFormatLocale } from "../../lib/format";
import { InvoiceDisputeTag } from "../disputes/parts";
import { MoreMenu } from "./MoreMenu";

/** Telefon genişliği (≤760 px): rozetler başlıktan alt satıra geçer. */
const NARROW = "(max-width: 760px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/** WhatsApp özeti: yalnızca sayılar; süre geçtiyse ya da firma Türkiye'de değilse son gün yazılmaz. */
function whatsAppText(inv: Invoice, fallbackCarrier: string, country: string | null | undefined): string {
  const t = inv.totals;
  const dl = disputeDeadlines(inv.invoiceDate, inv.carrier?.code, new Date(), country);
  return buildWhatsAppText({
    carrierName: inv.carrier?.name ?? fallbackCarrier,
    invoiceNo: inv.invoiceNo,
    invoiceDate: inv.invoiceDate,
    currency: inv.currency ?? "",
    lines: t?.lines ?? 0,
    diff: t?.diff ?? 0,
    unmatched: t?.unmatched ?? 0,
    overchargeTotal: t?.overchargeTotal ?? 0,
    disputeLastDay: dl?.ttk && !dl.ttk.expired ? dl.ttk.lastDay : null,
  }, getFormatLocale());
}

/**
 * Başlıkta tek satır: "Tarife: FedEx IP 2025" (tarife düzenleyicisine bağlantı). Eski faturalarda (tarifesi boş)
 * satırlarda kullanılan tarife(ler) gösterilir.
 */
function InvoiceTariffInfo({ inv }: { inv: Invoice }) {
  const { t } = useTranslation("invoiceDetail");
  const used = inv.tariffsUsed ?? [];
  const list = inv.tariff ? [{ ...inv.tariff, lines: 0 }] : used;
  // Mesaj 4: tarife silindi; fatura sürümdeki fiyatlarla durur, ad "(silindi)" ile yazılır (bağlantı yok)
  if (inv.basis?.state === "TARIFF_REMOVED" && inv.basis.tariffName && !inv.tariff)
    return (
      <span className="inv-tariff" title={t("header.tariffTitle", { names: inv.basis.tariffName })}>
        {t("header.tariff")} {inv.basis.tariffName} <span className="t3">{t("header.tariffRemoved")}</span>
      </span>
    );
  if (!list.length)
    return (
      <span className="inv-tariff">
        <Trans t={t} i18nKey="header.tariffNone" components={{ w: <span className="warn-t" /> }} />
      </span>
    );
  const full = list.map((u) => u.name).join(", ");
  return (
    <span className="inv-tariff" title={t("header.tariffTitle", { names: full })}>
      {t("header.tariff")}{" "}
      {list.map((u, i) => (
        <span key={u.id}>
          {i > 0 && ", "}
          <TariffLink id={u.id}>{u.name}</TariffLink>
          {list.length > 1 && <span className="t3"> ({t("header.tariffLines", { count: u.lines, n: fmtNum(u.lines) })})</span>}
        </span>
      ))}
    </span>
  );
}

/**
 * Kaynak satırı: tarife, yükleme zamanı, kaynak dosya. Bant standart boyda ve alt metni tek satır: bunlar banda binen
 * özet kartının altında durur (telefonda da kesilmez).
 */
export function InvoiceSourceLine({ inv }: { inv: Invoice }) {
  const { t } = useTranslation("invoiceDetail");
  return (
    <span className="inv-meta inv-src">
      <InvoiceTariffInfo inv={inv} />
      <span className="t3">{t("header.uploaded", { date: fmtDateTime(inv.createdAt) })}</span>
      {inv.fileUrl && (
        <a href={inv.fileUrl} target="_blank" rel="noreferrer" className="inv-file">
          <Icon name="doc" />
          <span className="ellipsis">{inv.fileName ?? t("header.sourceFile")}</span>
        </a>
      )}
    </span>
  );
}

/** Başlık: fatura no + durum, taşıyıcı/tarih satırı ve eylemler (telefonda ikincil eylemler "Diğer" menüsünde). */
export function InvoiceHeader({
  d,
  canEdit,
  canRecompare,
  canExport,
  recomparing,
  busyDl,
  onEdit,
  onRecompare,
  dl,
  onDispute,
  selectionActive = false,
}: {
  d?: Invoice;
  canEdit: boolean;
  canRecompare: boolean;
  canExport: boolean;
  recomparing: boolean;
  busyDl: "xlsx" | "pdf" | null;
  onEdit: () => void;
  onRecompare: () => void;
  dl: (kind: "xlsx" | "pdf") => void;
  onDispute: () => void;
  /** Satır seçimi açık: seçim çubuğunun eylemi birincildir, "İtiraz metni" ikincil olur. */
  selectionActive?: boolean;
}) {
  const { t } = useTranslation("invoiceDetail");
  const tot = d?.totals;
  const country = useAuth().me?.company.settings.country;
  const deadlines = d ? disputeDeadlines(d.invoiceDate, d.carrier?.code, new Date(), country) : null;
  // Türk Ticaret Kanunu süresi yalnız Türkiye firmasında: başka ülkede bu etiket çıkmaz.
  // Gönderilmiş itirazda sayaç durur: "süre doldu" yerine itiraz durumu yazılır.
  const sent = !!d?.dispute?.active;
  const windowClosed = !sent && !!deadlines?.ttk?.expired;
  // Bilinen süreler tamamen geçtiyse ya da fark yoksa itiraz ana iş değildir. Taşıyıcının düzeltme süresi açıksa hâlâ yapılabilir.
  const known = [deadlines?.ttk, deadlines?.carrier].filter((x) => !!x);
  const disputeIsMain = !sent && !!tot && tot.diff > 0 && !(known.length > 0 && known.every((x) => x.expired));
  // 08-B2: rozetler geniş ekranda başlıkta, telefonda alt satırda (tek yerde çizilir: aynı rozet iki kez DOM'da olmaz)
  const narrow = useNarrow();
  const pills = d ? (
    <span className="inv-pills">
      {tot &&
        (tot.diff > 0 ? (
          <StatusPill tone="red">
            {t("header.pillDiff", { count: tot.diff, n: fmtNum(tot.diff) })}
          </StatusPill>
        ) : tot.unmatched > 0 ? (
          <StatusPill tone="yellow">
            {t("header.pillUnmatched", { count: tot.unmatched, n: fmtNum(tot.unmatched) })}
          </StatusPill>
        ) : (
          <StatusPill tone="green">{t("header.pillMatch")}</StatusPill>
        ))}
      {tot && tot.diff > 0 && windowClosed && <StatusPill tone="yellow">{t("header.disputeExpired")}</StatusPill>}
      {d.dispute?.active && <InvoiceDisputeTag status={d.dispute.status} recovered={(d.dispute.sums ?? d.dispute.active.sums).recoveredAmount} />}
    </span>
  ) : null;
  const waText = (inv: Invoice) => whatsAppText(inv, t("header.carrierFallback"), country);
  return (
    <PageHeader
      crumbs={
        <>
          <Link to="/invoices">{t("header.crumb")}</Link>
          <span className="sep">/</span>
          <span>{t("header.comparison")}</span>
        </>
      }
      title={
        d ? (
          <>
            <span className="mono">{d.invoiceNo}</span>
            {!narrow && pills}
          </>
        ) : (
          <Skel w={220} h={32} />
        )
      }
      sub={
        d ? (
          <span className="inv-meta">
            <span>
              <Trans
                t={t}
                i18nKey="header.invoiceDated"
                values={{ carrier: d.carrier?.name, date: fmtDate(d.invoiceDate) }}
                components={{ b: <b /> }}
              />
              {d.periodFrom &&
                d.periodTo &&
                ` · ${t("header.period", { from: fmtDate(d.periodFrom), to: fmtDate(d.periodTo) })}`}
            </span>
            {narrow && pills}
          </span>
        ) : (
          <Skel w={360} />
        )
      }
      actions={
        <>
          {canExport && (
            <Button
              kind={disputeIsMain && !selectionActive ? "primary" : "secondary"}
              icon="mail"
              disabled={!d}
              onClick={onDispute}
              className="inv-dispute"
            >
              {t("header.dispute")}
            </Button>
          )}
          {/* nadir eylemler tek "⋯" menüsünde: indirme, düzenleme, yeniden karşılaştırma, paylaşım */}
          <MoreMenu
            className="inv-more"
            label={t("header.more")}
            disabled={!d}
            busy={recomparing || busyDl !== null}
            items={[
              ...(canExport
                ? [
                    { label: t("header.downloadXlsx"), icon: "download" as const, onSelect: () => dl("xlsx") },
                    { label: t("header.downloadPdf"), icon: "download" as const, onSelect: () => dl("pdf") },
                  ]
                : []),
              ...(canEdit ? [{ label: t("header.edit"), icon: "edit" as const, onSelect: onEdit }] : []),
              ...(canRecompare ? [{ label: t("header.recompare"), icon: "refresh" as const, onSelect: onRecompare }] : []),
              ...(d ? [{ label: t("header.whatsapp"), icon: "share" as const, href: whatsAppUrl(waText(d)) }] : []),
            ]}
          />
        </>
      }
    />
  );
}
