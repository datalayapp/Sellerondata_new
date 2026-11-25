import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { invoices, tariffs } from "../../api/endpoints";
import type { Invoice, TariffHealth, TariffHealthGroup } from "../../api/types";
import { Icon } from "../../components/Icon";
import { useHoldsPermission, usePermission } from "../../auth/AuthContext";
import { toast } from "../../components/Toast";
import { Button, Card, ErrorState, Modal, ModalAction, Skel, errorMessage } from "../../components/ui";
import { fmtNum, getFormatLocale } from "../../lib/format";
import { fmtSignedPct } from "@deciship/core";
import { useRecalcFlow } from "./RecalcDialog";

/** "Yok say" denen gruplar tarayıcıda, fatura başına saklanır. */
const ignoreKey = (invoiceId: string) => `deciship.tariffHealth.ignored.${invoiceId}`;

function readIgnored(invoiceId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ignoreKey(invoiceId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeIgnored(invoiceId: string, keys: string[]) {
  try {
    if (keys.length) localStorage.setItem(ignoreKey(invoiceId), JSON.stringify(keys));
    else localStorage.removeItem(ignoreKey(invoiceId));
  } catch {
    /* depolama kapalı: yalnız bu oturumda */
  }
}

/**
 * SPEC §3.9 "Tarife uyumu": taşıyıcının bu faturadaki fiyatları tarifeyle (faturanın kendi ücretli kg'ında) ülke
 * gruplarında karşılaştırılır. Ucuz gruplar ülke istisnası olarak tarifeye yazılabilir; pahalı gruplar itiraz konusu.
 * `compact`: kurulum sihirbazı gibi dar yerler için (açıklama yok, en çok 3 sorun satırı).
 */
export function TariffHealthPanel({ invoiceId, compact, foldable, lineOpen }: { invoiceId: string; compact?: boolean   /** Fatura ayrıntısı: tek satıra katlanır, tablo ilk ekrana girer. */
  foldable?: boolean;
  lineOpen?: boolean;
}) {
  const { t } = useTranslation("invoiceDetail");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["invoice", invoiceId, "tariff-health"],
    queryFn: () => invoices.tariffHealth(invoiceId),
  });
  const canEditTariff = usePermission("deciship.tariffs.edit");
  const canRecompare = usePermission("deciship.lines.decide");
  const canOpenTariff = useHoldsPermission("deciship.tariffs.view");
  /** Kişi katlayıp açtıysa o kalır; yoksa sapma varken ve satır paneli kapalıyken açık. */
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [ignored, setIgnored] = useState<string[]>(() => readIgnored(invoiceId));
  const [confirm, setConfirm] = useState<TariffHealthGroup | null>(null);
  // Mesaj 4: istisna faturaları kendiliğinden yeniden hesaplamaz; yazıldıktan sonra toplu önce/sonra penceresi açılır
  const recalc = useRecalcFlow({ onApplied: () => qc.invalidateQueries({ queryKey: ["invoice", invoiceId, "tariff-health"] }) });

  const setIgnore = (keys: string[]) => {
    setIgnored(keys);
    writeIgnored(invoiceId, keys);
  };

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["tariff"] });
    qc.invalidateQueries({ queryKey: ["tariffs"] });
    qc.invalidateQueries({ queryKey: ["tariff-versions"] });
  };

  const recompare = useMutation({
    mutationFn: () => invoices.recompare(invoiceId),
    meta: { silent: true },
    onSuccess: () => {
      toast.ok(t("health.recompared"));
      refreshAll();
    },
    onError: (e) => toast.err(t("health.recompareFailed"), errorMessage(e)),
  });

  const apply = useMutation({
    mutationFn: (g: TariffHealthGroup) => {
      const h = q.data!;
      const no = qc.getQueryData<Invoice>(["invoice", invoiceId])?.invoiceNo;
      // tarifesi silinmiş faturada "uygula" gösterilmez (canApply): buraya yalnız tarifesi duran rapor gelir
      return tariffs.setCountryAdjustment(h.tariff!.id!, {
        country: g.country!,
        pct: g.suggestedAdjustmentPct!,
        note: no
          ? t("health.noteWithInvoice", { no, count: g.lines, n: fmtNum(g.lines) })
          : t("health.note", { count: g.lines, n: fmtNum(g.lines) }),
        source: "invoice",
        invoiceId,
      });
    },
    meta: { silent: true },
    onSuccess: (r, g) => {
      if (r.health) qc.setQueryData(["invoice", invoiceId, "tariff-health"], r.health);
      toast.ok(t("health.applied", { country: g.countryName }), t("health.appliedBody"));
      setConfirm(null);
      refreshAll();
      const tariff = r.tariff ?? q.data?.tariff;
      if (tariff?.id && canRecompare) recalc.start({ kind: "tariff", tariffId: tariff.id, tariffName: tariff.name });
    },
    onError: (e) => toast.err(t("health.applyFailed"), errorMessage(e)),
  });

  const title = t("health.title");
  const description = compact ? undefined : t("health.desc");

  if (q.isLoading) {
    return (
      <Card title={title} description={description} className="th-card">
        <Skel w="70%" h={16} />
        <Skel w="50%" h={16} />
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card title={title} className="th-card">
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }

  const h: TariffHealth = q.data;
  const issues = h.groups.filter((g) => g.status !== "ok");
  const visible = issues.filter((g) => !ignored.includes(g.key));
  const hiddenCount = issues.length - visible.length;
  const shown = compact ? visible.slice(0, 3) : visible;
  const open = !foldable || (userOpen ?? (visible.length > 0 && !lineOpen));
  const foldSummary = h.stale
    ? t("health.staleShort")
    : visible.length > 0
      ? t("health.issuesShort", { count: visible.length, n: fmtNum(visible.length) })
      : h.checkedLines === 0
        ? t("health.nothingShort")
        : t("health.okShort", { count: h.okLines, n: fmtNum(h.okLines) });

  if (foldable && !open) {
    return (
      <section className={`card th-card th-fold${visible.length > 0 || h.stale ? " warn" : ""}`} aria-label={title}>
        <button type="button" className="th-fold-btn" aria-expanded={false} onClick={() => setUserOpen(true)}>
          <span className="th-fold-t">{title}</span>
          <span className="th-fold-s">{foldSummary}</span>
          <Icon name="chev" />
        </button>
      </section>
    );
  }

  return (
    <Card
      title={title}
      description={description}
      className={`th-card${compact ? " compact" : ""}`}
      actions={
        h.tariff?.id && canOpenTariff || foldable ? (
          <span className="row center-y gap8">
            {h.tariff?.id && canOpenTariff && (
              <Link className="link-btn" to={`/tariffs/${h.tariff.id}`}>
                {t("health.openTariff")} <Icon name="arrow" />
              </Link>
            )}
            {foldable && (
              <button type="button" className="icon-btn" aria-expanded aria-label={t("health.fold")} onClick={() => setUserOpen(false)}>
                <Icon name="up" />
              </button>
            )}
          </span>
        ) : undefined
      }
    >
      {h.stale ? (
        <div className="notif info" role="status">
          <Icon name="info" />
          <span>{t("health.stale")}</span>
          {canRecompare && (
            <Button kind="secondary" small icon="refresh" loading={recompare.isPending} onClick={() => recompare.mutate()}>
              {t("health.recompare")}
            </Button>
          )}
        </div>
      ) : h.checkedLines === 0 ? (
        <p className="t3 s13 th-empty">
          {t("health.nothingToCompare", {
            reason: h.tariff ? t("health.reasonNoPrice") : t("health.reasonNoTariff"),
          })}
        </p>
      ) : (
        <ul className="th-list">
          {h.okLines > 0 && (
            <li className="th-row ok">
              <span className="th-ic" aria-hidden>
                <Icon name="check" />
              </span>
              <span className="th-msg">
                <span>
                  <Trans
                    t={t}
                    i18nKey="health.okLines"
                    count={h.okLines}
                    values={{ n: fmtNum(h.okLines) }}
                    components={{ b: <b /> }}
                  />
                  <span className="t3"> · {t("health.withinTolerance", { pct: fmtNum(h.okTolerancePct, 0, 1) })}</span>
                </span>
              </span>
            </li>
          )}
          {shown.map((g) => (
            <HealthRow
              key={g.key}
              g={g}
              canApply={canEditTariff && Boolean(h.tariff?.id) && g.status === "cheaper" && !g.suspect && g.suggestedAdjustmentPct != null && g.country != null}
              busy={apply.isPending}
              onApply={() => setConfirm(g)}
              onIgnore={() => setIgnore([...ignored, g.key])}
            />
          ))}
          {compact && visible.length > shown.length && (
            <li className="th-more t3 s13">{t("health.moreGroups", { count: visible.length - shown.length, n: fmtNum(visible.length - shown.length) })}</li>
          )}
          {issues.length === 0 && h.okLines === h.checkedLines && !compact && (
            <li className="th-foot t3 s13">{t("health.noDeviation")}</li>
          )}
        </ul>
      )}
      {!h.stale && h.overallNote && (
        <p className="th-note s13">
          <Icon name="info" /> <span>{h.overallNote}</span>
        </p>
      )}
      {!h.stale && h.fuelNote && !compact && (
        <p className="th-note s13">
          <Icon name="info" /> <span>{h.fuelNote}</span>
        </p>
      )}
      {!h.stale && (hiddenCount > 0 || (!compact && h.skippedLines > 0)) && (
        <p className="th-foot t3 s12">
          {!compact && h.skippedLines > 0 && (
            <span>{t("health.skipped", { count: h.skippedLines, n: fmtNum(h.skippedLines) })} </span>
          )}
          {hiddenCount > 0 && (
            <>
              {t("health.ignoredGroups", { count: hiddenCount, n: fmtNum(hiddenCount) })}{" "}
              <button type="button" className="link-btn" onClick={() => setIgnore([])}>
                {t("health.show")}
              </button>
            </>
          )}
        </p>
      )}

      {recalc.dialog}
      {confirm && h.tariff && (
        <Modal
          busy={apply.isPending}
          title={t("health.confirmTitle", { country: confirm.countryName })}
          label={t("health.title")}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setConfirm(null)}>
                {t("health.cancel")}
              </ModalAction>
              <ModalAction kind="prim" icon="check" loading={apply.isPending} onClick={() => apply.mutate(confirm)}>
                {t("health.apply")}
              </ModalAction>
            </>
          }
        >
          <p>
            <Trans
              t={t}
              i18nKey="health.confirmBody"
              values={{ tariff: h.tariff.name, country: confirm.countryName, pct: fmtSignedPct(confirm.suggestedAdjustmentPct!, getFormatLocale()) }}
              components={{ b: <b />, num: <b className="num" /> }}
            />
          </p>
          {confirm.currentAdjustmentPct !== 0 && (
            <p className="t2 s13 mt8">{t("health.currentAdjustment", { pct: fmtSignedPct(confirm.currentAdjustmentPct, getFormatLocale()) })}</p>
          )}
          {confirm.weak && (
            <p className="notif warn mt12">
              <Icon name="warn" />
              <span>
                {confirm.lines < 3
                  ? t("health.weakFew", { count: confirm.lines, n: fmtNum(confirm.lines) })
                  : t("health.weakScattered", { min: fmtSignedPct(confirm.minDeviationPct, getFormatLocale()), max: fmtSignedPct(confirm.maxDeviationPct, getFormatLocale()) })}
              </span>
            </p>
          )}
          <p className="t3 s13 mt12">
            {t("health.confirmFooter")}
          </p>
        </Modal>
      )}
    </Card>
  );
}

function HealthRow({
  g,
  canApply,
  busy,
  onApply,
  onIgnore,
}: {
  g: TariffHealthGroup;
  canApply: boolean;
  busy: boolean;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const tone = g.status === "pricier" ? "pricier" : g.suspect ? "suspect" : "cheaper";
  const sub = [g.service, g.zone ? t("health.zone", { zone: g.zone }) : null].filter(Boolean).join(" · ");
  return (
    <li className={`th-row ${tone}`}>
      <span className="th-ic" aria-hidden>
        <Icon name={g.status === "pricier" || g.suspect ? "warn" : "info"} />
      </span>
      <span className="th-msg">
        <span>{g.message}</span>
        <span className="th-sub t3 s12">
          {sub}
          {sub && " · "}
          {t("health.median", { pct: fmtSignedPct(g.medianDeviationPct, getFormatLocale()) })}
          {g.lines > 1 && g.minDeviationPct !== g.maxDeviationPct && `, ${t("health.range", { min: fmtSignedPct(g.minDeviationPct, getFormatLocale()), max: fmtSignedPct(g.maxDeviationPct, getFormatLocale()) })}`}
          {g.weak && ` · ${t("health.weak")}`}
        </span>
        {g.suspect && <span className="th-sub t3 s12">{t("health.checkDiscount")}</span>}
      </span>
      <span className="th-acts">
        {canApply && (
          <Button kind="secondary" small onClick={onApply} disabled={busy}>
            {t("health.apply")}
          </Button>
        )}
        <Button kind="ghost" small onClick={onIgnore}>
          {t("health.ignore")}
        </Button>
      </span>
    </li>
  );
}
