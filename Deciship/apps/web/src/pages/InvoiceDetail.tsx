import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { usePageTitle } from "../components/Brand";
import { RecordNotFound, isRecordId, isRecordMissing } from "../components/RecordNotFound";
import { Link, useParams, useSearchParams } from "react-router";
import { disputes, invoices } from "../api/endpoints";
import type { Decision, DiffType, DisputeRound, InvoiceLine } from "../api/types";
import { Icon } from "../components/Icon";
import { usePermission } from "../auth/AuthContext";
import { toast } from "../components/Toast";
import {
  ErrorState,
  Field,
  PageHeader,
  Pager,
  TableSkeleton,
  errorMessage,
  tabListKeyDown,
  tabStop,
} from "../components/ui";
import { FEATURES } from "../lib/features";
import { fmtNum } from "../lib/format";
import { enumParam, pageParam } from "../lib/urlParams";
import { DECISION_LABEL, DIFF_LABEL } from "../lib/labels";
import { DisputeModal } from "./invoice-detail/DisputeDialog";
import { DisputeCard } from "./invoice-detail/DisputeCard";
import { SendDialog, useDisputeAction, type SendSelection } from "./invoice-detail/DisputeDialogs";
import { EditInvoiceModal } from "./invoice-detail/EditDialog";
import { BulkBar } from "./invoice-detail/BulkBar";
import {
  EMPTY_SELECTION,
  filterOf,
  isChecked,
  isEligible,
  offersSelectAll,
  pageState,
  selectFilter,
  selectedCount,
  selectionKey,
  toggleLine,
  togglePage,
  type Selection,
} from "./invoice-detail/bulk";
import { InvoiceHeader } from "./invoice-detail/Header";
import { LinePanel } from "./invoice-detail/LinePanel";
import { EmptyTab, LineRow, SelectBox } from "./invoice-detail/LineTable";
import { PAGE_SIZE, decisionLabel, diffLabel, type Tab } from "./invoice-detail/lineUtils";
import { InvoiceSummary } from "./invoice-detail/Summary";
import { useRecalcFlow, type InvoiceRecalcJob } from "./invoice-detail/RecalcDialog";
import { TariffHealthPanel } from "./invoice-detail/TariffHealth";

/** Karar süzgecinde "Yeniden hesap bekleyen" seçeneğinin adres değeri. */
const RECALC_FILTER = "RECALC";
/** Mesaj 5 (Y2): "İncele" (güveni düşük) satırlar; karar süzgecindeki ikinci ek seçenek (ayrı denetim eklenmez). */
const REVIEW_FILTER = "REVIEW";
const EXTRA_FILTERS = new Set([RECALC_FILTER, REVIEW_FILTER]);
/** Adresten okunabilen değerler: elle yazılan `?tab=all` ya da bilinmeyen değer API'ye gitmez, varsayılana düşer. */
const TABS: readonly Tab[] = ["DIFF", "UNMATCHED", "MATCH", "NO_TARIFF", "FLAGGED", "ALL"];
const DIFF_TYPES = Object.keys(DIFF_LABEL) as DiffType[];
const DECISION_FILTERS = [...(Object.keys(DECISION_LABEL) as Decision[]), RECALC_FILTER, REVIEW_FILTER];

export function InvoiceDetailPage() {
  const { t } = useTranslation("invoiceDetail");
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = enumParam(sp.get("tab"), TABS, "DIFF");
  const page = pageParam(sp.get("page"));
  const diffType = enumParam(sp.get("diffType"), DIFF_TYPES, "");
  const decision = enumParam(sp.get("decision"), DECISION_FILTERS, "");
  const [qText, setQText] = useState(sp.get("q") ?? "");
  const q = sp.get("q") ?? "";
  const lineId = sp.get("line");
  const canEdit = usePermission("deciship.invoices.upload");
  const canRecompare = usePermission("deciship.lines.decide");
  const canExport = usePermission("deciship.data.export");
  const showPrices = usePermission("deciship.prices.view");
  const canManageDispute = usePermission("deciship.disputes.manage");
  const [disputeOpen, setDisputeOpen] = useState(false);
  // itiraz metninden "Gönderildi olarak işaretle": metnin satır kümesi (sayı, toplam, özet) ve metin açıldığındaki etkin tur
  // (varsa yeniden gönderme; tur bu arada değiştiyse sunucu 409 STALE der, başkasının turu sessizce yenilenmez)
  const [markSent, setMarkSent] = useState<{ draft: SendSelection; round: DisputeRound | null } | null>(null);
  const runDispute = useDisputeAction(id);
  const [busyDl, setBusyDl] = useState<"xlsx" | "pdf" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // Last PATCHed line: keeps the panel open when a fix moves the line out of the current tab/search.
  const [patched, setPatched] = useState<InvoiceLine | null>(null);
  // Mesaj 14: satır seçimi. Süzgecin (fatura, sekme, tür, karar, arama) herhangi bir parçası değişince sıfırlanır; sayfa değişince korunur.
  const selKey = selectionKey({ invoiceId: id, tab, diffType, decision, q });
  const [selState, setSelState] = useState<{ key: string; sel: Selection }>({ key: selKey, sel: EMPTY_SELECTION });
  const sel = selState.key === selKey ? selState.sel : EMPTY_SELECTION;
  const setSel = (s: Selection) => setSelState({ key: selKey, sel: s });

  const setParams = (
    patch: Record<string, string | null>,
    resetPage = true,
  ) => {
    // Render'daki `sp` değil, adresin şu anki hali: art arda iki güncelleme birbirini geri almasın (panel kapat + süzgeç seç).
    const n = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) n.set(k, v);
      else n.delete(k);
    }
    if (resetPage && !("page" in patch)) n.delete("page");
    setSp(n, { replace: true });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (qText !== q) setParams({ q: qText || null });
    }, 300);
    return () => clearTimeout(timer);
  }, [qText]);

  const validId = isRecordId(id);
  const inv = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => invoices.get(id),
    enabled: validId,
  });
  usePageTitle(inv.data ? t("pageTitle", { no: inv.data.invoiceNo }) : null);
  const lines = useQuery({
    queryKey: ["invoice", id, "lines", { tab, page, diffType, decision, q }],
    queryFn: () =>
      invoices.lines(id, {
        status: tab === "ALL" || tab === "FLAGGED" ? undefined : tab,
        flagged: tab === "FLAGGED" ? true : undefined,
        diffType: diffType || undefined,
        // "Yeniden hesap bekleyen" ve "İncele işaretli" karar süzgecindeki ek seçenekler: karar değil, satır işareti süzülür
        decision: decision && !EXTRA_FILTERS.has(decision) ? decision : undefined,
        recalcPending: decision === RECALC_FILTER ? true : undefined,
        review: decision === REVIEW_FILTER ? true : undefined,
        q: q || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    enabled: validId,
  });

  const recompare = useMutation({
    mutationFn: () => invoices.recompare(id),
    onSuccess: () => {
      toast.ok(
        t("toast.recompared"),
        t("toast.recomparedBody"),
      );
      qc.invalidateQueries({ queryKey: ["invoice", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  // Mesaj 4: yeniden hesap önce/sonra penceresiyle (değişiklik yoksa pencere açılmaz)
  const recalc = useRecalcFlow();
  const startRecalc = (basis: InvoiceRecalcJob["basis"], purpose: InvoiceRecalcJob["purpose"]) => {
    const d0 = inv.data;
    if (!d0) return;
    recalc.start({
      kind: "invoice",
      invoiceId: id,
      currency: d0.currency ?? "",
      label: `${d0.carrier?.name ?? ""} · ${d0.invoiceNo}`,
      basis,
      purpose,
    });
  };

  const dl = async (kind: "xlsx" | "pdf") => {
    if (!inv.data) return;
    setBusyDl(kind);
    try {
      if (kind === "xlsx") await invoices.downloadXlsx(id, inv.data.invoiceNo);
      else await invoices.downloadPdf(id, inv.data.invoiceNo);
    } catch (e) {
      toast.err(t("toast.downloadFailed"), errorMessage(e));
    } finally {
      setBusyDl(null);
    }
  };

  // Panel açılınca üst bölümler daralır: üzerinde çalışılan satır görünür alanda kalsın.
  useEffect(() => {
    if (!lineId) return;
    const raf = requestAnimationFrame(() => document.querySelector(".lines-dt tr.sel")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(raf);
  }, [lineId, lines.data]);

  if (!validId || (inv.isError && !inv.data)) {
    return (
      <>
        <PageHeader
          title={t("notFound.pageTitle")}
          crumbs={<Link to="/invoices">{t("header.crumb")}</Link>}
        />
        <div className="content">
          {!validId || isRecordMissing(inv.error) ? (
            <RecordNotFound backTo="/invoices" backLabel={t("notFound.back")} />
          ) : (
            <ErrorState error={inv.error} onRetry={() => inv.refetch()} />
          )}
        </div>
      </>
    );
  }

  const d = inv.data;
  const tot = d?.totals;
  const cur = d?.currency ?? "";
  const items = lines.data?.items ?? [];
  const selected =
    items.find((l) => l.id === lineId) ??
    (patched?.id === lineId ? patched : null);
  const compact = Boolean(lineId);
  // Kutular yalnız: özellik açık, karar verme izni var, sekme Fark var ya da Tümü, satır paneli kapalı
  const boxes = FEATURES.bulkDecide && canRecompare && (tab === "DIFF" || tab === "ALL") && !compact;
  const pageIds = items.filter(isEligible).map((l) => l.id);
  const picked = boxes ? selectedCount(sel) : 0;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    // Tek kural: satır durumunun sekmesindedir, karar sekme değiştirmez. Sekmeler Tümü'ye denk; Fark var, başlık, Pano ve PDF ile aynı sayı.
    { key: "DIFF", label: t("tabs.diff"), count: tot?.diff },
    { key: "UNMATCHED", label: t("tabs.unmatched"), count: tot?.unmatched },
    { key: "MATCH", label: t("tabs.match"), count: tot?.match },
    ...(tot && tot.noTariff > 0
      ? [{ key: "NO_TARIFF" as Tab, label: t((tot.fxMissing ?? 0) >= tot.noTariff ? "tabs.fxMissing" : "tabs.noTariff"), count: tot.noTariff }]
      : []),
    ...((tot?.flaggedLines ?? 0) > 0 || tab === "FLAGGED"
      ? [
          {
            key: "FLAGGED" as Tab,
            label: t("tabs.flagged"),
            count: tot?.flaggedLines ?? 0,
          },
        ]
      : []),
    { key: "ALL", label: t("tabs.all"), count: tot?.lines },
  ];
  // Tür ve karar süzgeci yalnız Fark var ve Tümü'nde görünür; başka sekmeye taşınırsa liste boş kalır ve kişi temizleyemez
  const goTab = (k: Tab) =>
    setParams({
      tab: k === "DIFF" ? null : k,
      line: null,
      ...(k === "DIFF" || k === "ALL" ? {} : { diffType: null, decision: null }),
    });

  const selectNext = () => {
    // Yanıt gelene kadar kişi paneli kapattıysa ya da başka satıra geçtiyse panel yeniden açılmaz.
    if (new URLSearchParams(window.location.search).get("line") !== lineId) return;
    const i = items.findIndex((l) => l.id === lineId);
    const next = items[i + 1];
    setParams({ line: next ? next.id : null }, false);
  };

  const tabStrip = (
    <div
      className="ptabs inv-tabs"
      role="tablist"
      aria-label={t("tabs.label")}
      onKeyDown={tabListKeyDown}
    >
      {tabs.map((x, i) => (
        <button
          key={x.key}
          type="button"
          role="tab"
          aria-selected={tab === x.key}
          tabIndex={tabStop(i, tabs.findIndex((y) => y.key === tab))}
          className={tab === x.key ? "on" : ""}
          onClick={() => goTab(x.key)}
        >
          {x.label}
          {x.count !== undefined && (
            <span
              className={`cnt${x.key === "DIFF" && x.count > 0 ? " red" : ""}${x.key === "FLAGGED" && x.count > 0 ? " warn" : ""}`}
            >
              {fmtNum(x.count)}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <InvoiceHeader
        d={d}
        canEdit={canEdit}
        canRecompare={canRecompare}
        canExport={canExport}
        recomparing={recompare.isPending || recalc.busy}
        busyDl={busyDl}
        onEdit={() => setEditOpen(true)}
        onRecompare={() => startRecalc("pinned", "recompare")}
        dl={dl}
        onDispute={() => setDisputeOpen(true)}
        selectionActive={picked > 0}
      />
      <div className="layout inv-layout">
        <div className={`main inv-main${picked > 0 ? " has-bulk" : ""}`}>
          {showPrices && (
            <InvoiceSummary
              inv={d}
              line={compact}
              onRecalc={canRecompare ? (purpose) => startRecalc(purpose, purpose) : undefined}
              recalcBusy={recalc.busy}
              onShowPending={() => setParams({ tab: "ALL", decision: RECALC_FILTER, diffType: null, line: null })}
            />
          )}
          {d && <DisputeCard inv={d} compact={compact} />}
          {!compact && canRecompare && (tot?.fxMissing ?? 0) > 0 && (
            <div className="notif warn mt16" role="status">
              <Icon name="warn" />
              <span>
                <Trans
                  t={t}
                  i18nKey="fxMissing"
                  count={tot!.fxMissing}
                  values={{ n: fmtNum(tot!.fxMissing) }}
                  components={{
                    act: (
                      <button
                        type="button"
                        className="link-btn"
                        disabled={recompare.isPending}
                        onClick={() => recompare.mutate()}
                      />
                    ),
                  }}
                />
              </span>
            </div>
          )}
          {/* Y18: eski tarihli kurla hesaplanan satırlar; kur alınamadı uyarısı varken ikinci düğme gösterilmez (aynı eylem) */}
          {!compact && canRecompare && (tot?.fxMissing ?? 0) === 0 && (tot?.fxStale ?? 0) > 0 && (
            <div className="notif warn mt16" role="status">
              <Icon name="warn" />
              <span>
                <Trans
                  t={t}
                  i18nKey="fxStale"
                  count={tot!.fxStale}
                  values={{ n: fmtNum(tot!.fxStale!) }}
                  components={{
                    act: (
                      <button
                        type="button"
                        className="link-btn"
                        disabled={recompare.isPending}
                        onClick={() => recompare.mutate()}
                      />
                    ),
                  }}
                />
              </span>
            </div>
          )}
          {/* K37: arka plandaki yeniden hesap 5 kez düştü; eylem yetkisi olmayana yalnız bilgi */}
          {!compact && d?.recalcFailed && (
            <div className="notif warn mt16" role="status">
              <Icon name="warn" />
              <span>
                <Trans
                  t={t}
                  i18nKey="recalcFailed"
                  components={{
                    act: canRecompare ? (
                      <button
                        type="button"
                        className="link-btn"
                        disabled={recompare.isPending}
                        onClick={() => recompare.mutate()}
                      />
                    ) : (
                      <span />
                    ),
                  }}
                />
              </span>
            </div>
          )}
          {d?.status === "FAILED" && (
            <div className="notif err mt16">
              <Icon name="err" />
              <span>
                {t("failed")}
              </span>
            </div>
          )}
          {showPrices && d && d.status !== "FAILED" && <TariffHealthPanel invoiceId={id} foldable lineOpen={compact} />}
          {tabStrip}
          <div className="filters line-filters">
            <Field label={t("filters.trackingNo")} htmlFor="lq" className="sr-label">
              <div className="search">
                <Icon name="search" />
                <input
                  id="lq"
                  className="inp sm w-lg"
                  placeholder={t("filters.searchTracking")}
                  value={qText}
                  onChange={(e) => setQText(e.target.value)}
                />
              </div>
            </Field>
            {(tab === "DIFF" || tab === "ALL") && (
              <Field label={t("filters.diffType")} htmlFor="ldt" className="sr-label">
                <select
                  id="ldt"
                  className="sel sm w-md"
                  value={diffType}
                  onChange={(e) =>
                    setParams({ diffType: e.target.value || null })
                  }
                >
                  <option value="">{t("filters.allTypes")}</option>
                  {(Object.keys(DIFF_LABEL) as DiffType[]).map((k) => (
                    <option key={k} value={k}>
                      {diffLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {(tab === "DIFF" || tab === "ALL") && (
              <Field label={t("filters.decision")} htmlFor="ldec" className="sr-label">
                <select
                  id="ldec"
                  className="sel sm ln-dec-sel"
                  value={decision}
                  onChange={(e) =>
                    setParams({ decision: e.target.value || null })
                  }
                >
                  <option value="">{t("filters.allDecisions")}</option>
                  {(Object.keys(DECISION_LABEL) as Decision[]).map((k) => (
                    <option key={k} value={k}>
                      {k === "OPEN" ? t("filters.pending") : decisionLabel(k)}
                    </option>
                  ))}
                  <option value={REVIEW_FILTER}>{t("filters.review")}</option>
                  {((tot?.pendingLines ?? 0) > 0 || decision === RECALC_FILTER) && (
                    <option value={RECALC_FILTER}>{t("recalc.filter")}</option>
                  )}
                </select>
              </Field>
            )}
          </div>

          {lines.isError && !lines.data ? (
            <ErrorState error={lines.error} onRetry={() => lines.refetch()} />
          ) : !lines.data ? (
            <TableSkeleton cols={8} />
          ) : items.length === 0 ? (
            <EmptyTab
              tab={tab}
              filtered={Boolean(q || diffType || decision)}
              compared={tot ? tot.match + tot.diff : undefined}
            />
          ) : (
            <>
              {picked > 0 && (
                <BulkBar
                  invoiceId={id}
                  selection={sel}
                  filter={filterOf({ tab, diffType, decision, q })}
                  canSelectAll={offersSelectAll(sel, pageIds, items.length, lines.data.total, lines.data.selectionDigest, lines.data.selectionEligible)}
                  total={lines.data.total}
                  eligible={lines.data.selectionEligible ?? null}
                  reviewFilter={decision === REVIEW_FILTER}
                  onSelectAll={() => {
                    if (lines.data?.selectionDigest) setSel(selectFilter(lines.data.total, lines.data.selectionDigest, lines.data.selectionEligible));
                  }}
                  onClear={() => setSel(EMPTY_SELECTION)}
                />
              )}
              <div
                className={`table-wrap${lines.isPlaceholderData ? " is-stale" : ""}`}
              >
                <table
                  className={`dt dt-cards lines-dt${compact ? " tight" : ""}${boxes ? " has-sel" : ""}`}
                >
                  <thead>
                    <tr>
                      {boxes && (
                        <th className="ln-c-sel">
                          <SelectBox
                            label={t("bulk.selectPage")}
                            checked={pageState(sel, pageIds) === "all"}
                            mixed={pageState(sel, pageIds) === "some"}
                            disabled={pageIds.length === 0}
                            onChange={() => setSel(togglePage(sel, pageIds))}
                          />
                        </th>
                      )}
                      <th>{t("cols.trackingNo")}</th>
                      <th>{t("cols.statusType")}</th>
                      <th className="r">
                        {t("cols.ourMeasurement")}<span className="sub">{t("cols.unitsSub")}</span>
                      </th>
                      <th className="r">
                        {t("cols.billedMeasurement")}
                        <span className="sub">{t("cols.unitsSub")}</span>
                      </th>
                      {/* 01-B9 (a): tutarlar KDV hariç; ölçü başlıklarındaki alt satır deseniyle (satır yüksekliği aynı) */}
                      {!compact && showPrices && (
                        <th className="r col-amt">
                          {t("cols.expected")}
                          <span className="sub">{t("cols.amountsSub")}</span>
                        </th>
                      )}
                      {!compact && showPrices && (
                        <th className="r col-amt">
                          {t("cols.billed")}
                          <span className="sub">{t("cols.amountsSub")}</span>
                        </th>
                      )}
                      {showPrices && (
                        <th className="r">
                          {t("cols.discrepancy")}
                          <span className="sub">{t("cols.amountsSub")}</span>
                        </th>
                      )}
                      {!compact && <th className="ln-c-dec">{t("cols.decision")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((l) => (
                      <LineRow
                        key={l.id}
                        l={l}
                        cur={cur}
                        compact={compact}
                        selected={l.id === lineId}
                        box={
                          boxes
                            ? {
                                checked: isChecked(sel, l.id, isEligible(l)),
                                disabled: !isEligible(l),
                                onToggle: () => setSel(toggleLine(sel, l.id, pageIds)),
                              }
                            : undefined
                        }
                        onOpen={() =>
                          setParams(
                            { line: l.id === lineId ? null : l.id },
                            false,
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={page}
                pageSize={lines.data.pageSize || PAGE_SIZE}
                total={lines.data.total}
                onPage={(p) => setParams({ page: String(p) }, false)}
                label={t("unit")}
              />
            </>
          )}
        </div>
        {lineId && (
          <LinePanel
            line={selected}
            loading={!lines.data}
            invoiceId={id}
            cur={cur}
            onClose={() => setParams({ line: null }, false)}
            onDecided={selectNext}
            onPatched={setPatched}
          />
        )}
      </div>
      {disputeOpen && d && (
        <DisputeModal
          invoice={d}
          onClose={() => setDisputeOpen(false)}
          // metni gönderen kişi aynı yerden kaydı da düşer; kayıt metnin satır kümesini taşır (10-B3). Etkin tur varken
          // (gönderimden sonra listeye satır eklendi) bu yeniden göndermedir: kartta görünen küme değil, yollanan metnin kümesi.
          onMarkSent={
            canManageDispute && d.dispute && (d.dispute.active ? (d.dispute.unsentLineCount ?? 0) > 0 : d.dispute.sendableLineCount > 0)
              ? (draft) => {
                  setDisputeOpen(false);
                  setMarkSent({ draft, round: d.dispute?.active ?? null });
                }
              : undefined
          }
          // 10-B11: yeniden hesap bekleyen satırlar süzgeçte
          onShowPending={() => {
            setDisputeOpen(false);
            setParams({ tab: "ALL", decision: RECALC_FILTER, diffType: null, line: null });
          }}
        />
      )}
      {markSent && d && (
        <SendDialog
          invoice={d}
          draft={markSent.draft}
          round={markSent.round}
          showPrices={showPrices}
          run={runDispute}
          send={(b) => {
            const r = markSent.round;
            return r ? disputes.resend(r.id, { ...b, version: r.version }) : disputes.send(id, b);
          }}
          onClose={() => setMarkSent(null)}
          onReopenText={() => {
            setMarkSent(null);
            // metin ve kart güncel kümeden (başka sekmenin değişikliği bu sayfaya kendiliğinden gelmez)
            void qc.invalidateQueries({ queryKey: ["invoice", id] });
            setDisputeOpen(true);
          }}
        />
      )}
      {recalc.dialog}
      {editOpen && d && (
        <EditInvoiceModal invoice={d} onClose={() => setEditOpen(false)} />
      )}
    </>
  );
}
