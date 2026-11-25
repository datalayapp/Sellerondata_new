import "./arsiv.css";
import type { PrintSessionSummary } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import type { EkranProps, Go } from "../../../lib/route.ts";
import { useDesignLanguage } from "../../../ortak/index.ts";
import { PRINT_KEYS, printApi, useSessions } from "../mantik/api.ts";
import { stamp } from "../mantik/shelf.ts";
import { AppFrame, Button, CenterColumn, type Crumb, cx, EmptyState, IssueBox, SearchField, Tag, ToolSpacer, ToolStrip, Tooltip, useToast, Workspace, WorkRow } from "../../../tezgah/index.ts";
import { useBaskiSekmeleri } from "../BaskiSekmeleri.tsx";

/** Siparişler sütununda görünen sipariş sayısı; fazlası "+N" ve ipucunda tam liste. */
const ORDERS_SHOWN = 3;
/** Yazarken arama bu kadar bekler (ms). */
const SEARCH_DELAY = 250;

/**
 * Baskı · Arşiv (maket 9): basılmış oturumlar (silinmez). Arama (oturum ya da sayfa adı, sipariş no, metin); satırda
 * Aç (salt okunur masa), Basılmadı (yanlışlıkla işaretlendiyse taslağa döner), Yeniden bas (yeni taslak, masada açılır).
 * Eski sticker ölçüsüyle basılmış oturumun adının yanında kısa "eski ölçü" işareti (`noticeCodes`; ipucunda açıklama).
 * Satır eylemleri satırın üzerine gelince, satır seçilince ya da klavye odağında görünür.
 */
export default function ArsivEkrani({ go }: EkranProps) {
  const { current, loading } = useDesignLanguage();
  const tabs = useBaskiSekmeleri("arsiv", go);
  const f = useTranslation("frame").t;
  const crumbs: Crumb[] = [{ label: f("nav.print"), onClick: () => go("baski") }, { label: f("routes.printArchive") }];
  return (
    <AppFrame band="work" active="baski" workRow={<WorkRow crumbs={crumbs} tabs={tabs} />}>
      <Workspace>{current ? <Arsiv key={current.id} languageId={current.id} go={go} /> : <DilYok loading={loading} go={go} />}</Workspace>
    </AppFrame>
  );
}

function Arsiv({ languageId, go }: { languageId: string; go: Go }) {
  const { t } = useTranslation("printArchive");
  // Oturum bildirimlerinin kısa işaretleri masanın sözlüğünde (bildirim metinleriyle bir arada).
  const d = useTranslation("printDesk").t;
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setQ(text.trim()), SEARCH_DELAY);
    return () => window.clearTimeout(id);
  }, [text]);
  const list = useSessions(languageId, "printed", q);
  const sessions = list.data?.sessions ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const reprint = async (s: PrintSessionSummary) => {
    setBusy(s.id);
    try {
      const r = await printApi.reprint(s.id);
      qc.setQueryData([PRINT_KEYS.session, r.id], r);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.sessions] });
      toast({ tone: "success", message: t("toast.reprinted", { name: r.name }) });
      go("baski", ["masa", r.id]);
    } catch (e) {
      toast({ tone: "error", message: t("toast.reprintFailed", { detail: serverText(e) }) });
    } finally {
      setBusy(null);
    }
  };
  const unprint = async (s: PrintSessionSummary) => {
    setBusy(s.id);
    try {
      await printApi.markPrinted(s.id, false);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.sessions] });
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.shelf] });
      toast({ message: t("toast.unprinted", { name: s.name }) });
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    } finally {
      setBusy(null);
    }
  };

  const strip = (
    <ToolStrip label={t("strip.label")}>
      <SearchField className="bs-ar-q" value={text} placeholder={t("search.placeholder")} aria-label={t("search.label")} onChange={setText} />
      <ToolSpacer />
      <span className="bs-ar-n" aria-live="polite">
        {list.isFetching ? t("search.busy") : t("search.count", { count: sessions.length })}
      </span>
    </ToolStrip>
  );

  let body;
  if (list.isLoading) body = <div className="bs-ar-wait" aria-busy="true" />;
  else if (list.isError) {
    body = (
      <div className="bs-ar-msg">
        <IssueBox tone="error">{t("loadFailed", { detail: serverText(list.error) })}</IssueBox>
      </div>
    );
  } else if (!sessions.length) {
    body = <EmptyState icon="print" title={q ? t("empty.noMatch") : t("empty.title")} body={t("empty.body")} />;
  } else {
    body = (
      <div className="bs-ar-scroll">
        <table className="bs-ar-tbl">
          <thead>
            <tr>
              <th scope="col">{t("col.session")}</th>
              <th scope="col">{t("col.printed")}</th>
              <th scope="col">{t("col.orders")}</th>
              <th scope="col">
                <span className="tz-sr">{t("col.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const shown = s.orderNos.slice(0, ORDERS_SHOWN);
              const more = s.orderNos.length - shown.length;
              const orders = (
                <span className="tz-mono">
                  {shown.map((n) => t("orderNo", { no: n })).join(" · ")}
                  {more > 0 && ` ${t("more", { count: more })}`}
                </span>
              );
              return (
                <tr key={s.id} className={cx(picked === s.id && "is-sel")} onClick={() => setPicked(s.id)}>
                  <td>
                    <span className="bs-ar-name">
                      <b>{s.name}</b>
                      {s.sourceSessionId && <Tag>{t("reprintTag")}</Tag>}
                      {(s.noticeCodes ?? []).includes("printed-old-scale") && (
                        <Tooltip content={d("archive.oldScaleHint")}>
                          <span className="bs-ar-flag" tabIndex={0}>
                            <Tag tone="info">{d("archive.oldScale")}</Tag>
                          </span>
                        </Tooltip>
                      )}
                    </span>
                    <small>{t("counts", { pages: t("pages", { count: s.pageCount }), sheets: t("sheets", { count: s.sheetCount }), labels: t("labels", { count: s.itemCount }) })}</small>
                  </td>
                  <td>{stamp(s.printedAt)}</td>
                  <td>{more > 0 ? <Tooltip content={s.orderNos.map((n) => t("orderNo", { no: n })).join(" · ")}>{orders}</Tooltip> : orders}</td>
                  <td>
                    <span className="bs-ar-acts">
                      <Button size="mini" onClick={() => go("baski", ["masa", s.id])}>
                        {t("actions.open")}
                      </Button>
                      <Button size="mini" variant="quiet" title={t("actions.unprintHint")} disabled={busy === s.id} onClick={() => void unprint(s)}>
                        {t("actions.unprint")}
                      </Button>
                      <Button size="mini" icon="print" loading={busy === s.id} onClick={() => void reprint(s)}>
                        {t("actions.reprint")}
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return <CenterColumn strip={strip}>{body}</CenterColumn>;
}

/** Tasarım dili yokken (ya da yüklenirken): arşiv tasarım diline bağlı. */
function DilYok({ loading, go }: { loading: boolean; go: Go }) {
  const { t } = useTranslation("printArchive");
  return (
    <CenterColumn>
      {loading ? (
        <div className="bs-ar-wait" aria-busy="true" />
      ) : (
        <EmptyState
          icon="print"
          title={t("empty.noLanguage")}
          body={t("empty.noLanguageBody")}
          action={
            <Button variant="primary" onClick={() => go("ayarlar", ["tasarim-dilleri"])}>
              {t("empty.toLanguages")}
            </Button>
          }
        />
      )}
    </CenterColumn>
  );
}
