import "./kisayollar.ts";
import "./sablonlar.css";
import type { PrintTemplateView } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import type { EkranProps, Go } from "../../../lib/route.ts";
import { useDesignLanguage } from "../../../ortak/index.ts";
import { PRINT_KEYS, printApi, usePrintTemplates } from "../mantik/api.ts";
import { newTemplateBody } from "../mantik/sablon/draft.ts";
import { filterTemplates, type KindFilter } from "../mantik/sablon/editor.ts";
import { AppFrame, BandButton, Button, CenterColumn, type Crumb, EmptyState, useToast, Workspace, WorkRow } from "../../../tezgah/index.ts";
import { useBaskiSekmeleri } from "../BaskiSekmeleri.tsx";
import { Duzenleyici } from "./Duzenleyici.tsx";
import { BosListe, Liste } from "./Liste.tsx";
import { useSablonSil } from "./sil.ts";

/**
 * Baskı · Sayfa şablonları: `#/baski/sablonlar` liste (sütun; kartlar, görünür Sil, kullanım sayısı),
 * `#/baski/sablonlar/<id>` düzenleyici (kâğıt ortada, sağda Temel / Gelişmiş).
 */
export default function SayfaSablonlariEkrani({ route, go }: EkranProps) {
  const { current, loading } = useDesignLanguage();
  const templateId = route.rest[0] === "sablonlar" ? (route.rest[1] ?? null) : null;
  if (!current) return <DilYok loading={loading} go={go} />;
  if (templateId) return <Acik key={`${current.id}:${templateId}`} languageId={current.id} templateId={templateId} go={go} />;
  return <Sablonlar key={current.id} languageId={current.id} go={go} />;
}

/** Yeni şablon kur ve düzenleyicide aç. */
function useCreate(languageId: string, go: Go, all: readonly PrintTemplateView[]) {
  const { t } = useTranslation("printTemplates");
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const create = async (k: "label" | "sticker") => {
    setCreating(true);
    try {
      const v = await printApi.createTemplate(newTemplateBody(languageId, k, all.filter((x) => x.kind === k).length + 1));
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
      go("baski", ["sablonlar", v.id]);
    } catch (e) {
      toast({ tone: "error", message: t("toast.createFailed", { detail: serverText(e) }) });
    } finally {
      setCreating(false);
    }
  };
  return { creating, create };
}

function Sablonlar({ languageId, go }: { languageId: string; go: Go }) {
  const { t } = useTranslation("printTemplates");
  const f = useTranslation("frame").t;
  const qc = useQueryClient();
  const toast = useToast();
  const remove = useSablonSil();
  const tabs = useBaskiSekmeleri("sablonlar", go);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const q = usePrintTemplates(languageId, showArchived);
  const all = useMemo<PrintTemplateView[]>(() => q.data?.templates ?? [], [q.data]);
  const shown = useMemo(() => filterTemplates(all, { query, kind, showArchived }), [all, kind, query, showArchived]);
  const counts = useMemo(() => {
    const live = all.filter((x) => showArchived || !x.archived);
    return { label: live.filter((x) => x.kind === "label").length, sticker: live.filter((x) => x.kind === "sticker").length };
  }, [all, showArchived]);
  const { creating, create } = useCreate(languageId, go, all);

  const unarchive = async (x: PrintTemplateView) => {
    try {
      const v = await printApi.archiveTemplate(x.id, false);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
      toast({ message: t("toast.unarchived", { name: v.name }) });
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    }
  };

  const crumbs: Crumb[] = [{ label: f("nav.print"), onClick: () => go("baski") }, { label: f("routes.printTemplates") }];
  const newMenu = [
    { label: t("list.newLabel"), onSelect: () => void create("label") },
    { label: t("list.newSticker"), onSelect: () => void create("sticker") },
  ];
  const empty = !q.isLoading && !q.isError && all.length === 0;
  return (
    <AppFrame
      band="work"
      active="baski"
      workRow={<WorkRow crumbs={crumbs} tabs={tabs} actions={empty ? undefined : <BandButton need="edit" cta icon="plus" label={t("list.newTemplate")} menuItems={newMenu} />} />}
    >
      <Workspace>
        <CenterColumn>
          <Liste
            shown={shown}
            total={all.length}
            counts={counts}
            query={query}
            onQuery={setQuery}
            kind={kind}
            onKind={setKind}
            showArchived={showArchived}
            onShowArchived={setShowArchived}
            loading={q.isLoading}
            error={q.isError ? serverText(q.error) : null}
            creating={creating}
            onCreate={(k) => void create(k)}
            onOpen={(id) => go("baski", ["sablonlar", id])}
            onDelete={(x) => void remove(x)}
            onUnarchive={(x) => void unarchive(x)}
            empty={<BosListe creating={creating} onCreate={(k) => void create(k)} />}
          />
        </CenterColumn>
      </Workspace>
    </AppFrame>
  );
}

/** Düzenleyici: arşivdeki şablon da açılır (liste sorgusu arşiv dahil). */
function Acik({ languageId, templateId, go }: { languageId: string; templateId: string; go: Go }) {
  const { t } = useTranslation("printTemplates");
  const f = useTranslation("frame").t;
  const tabs = useBaskiSekmeleri("sablonlar", go);
  const q = usePrintTemplates(languageId, true);
  const current = q.data?.templates.find((x) => x.id === templateId) ?? null;
  const toList = () => go("baski", ["sablonlar"]);
  if (current) {
    return <Duzenleyici key={current.id} template={current} languageId={languageId} tabs={tabs} onOpen={(id) => go("baski", ["sablonlar", id])} onList={toList} />;
  }
  const crumbs: Crumb[] = [{ label: f("nav.print"), onClick: () => go("baski") }, { label: f("routes.printTemplates"), onClick: toList }];
  return (
    <AppFrame band="work" active="baski" workRow={<WorkRow crumbs={crumbs} tabs={tabs} />}>
      <Workspace>
        <CenterColumn>
          {q.isLoading ? (
            <div className="bs-wait" aria-busy="true" />
          ) : (
            <EmptyState
              icon="layout"
              title={t("empty.notFound")}
              body={q.isError ? serverText(q.error) : t("empty.notFoundBody")}
              action={<Button onClick={toList}>{t("empty.toList")}</Button>}
            />
          )}
        </CenterColumn>
      </Workspace>
    </AppFrame>
  );
}

/** Tasarım dili yokken (ya da yüklenirken): sayfa şablonları tasarım diline bağlı. */
function DilYok({ loading, go }: { loading: boolean; go: Go }) {
  const { t } = useTranslation("printTemplates");
  const f = useTranslation("frame").t;
  const tabs = useBaskiSekmeleri("sablonlar", go);
  return (
    <AppFrame band="work" active="baski" workRow={<WorkRow crumbs={[{ label: f("nav.print"), onClick: () => go("baski") }, { label: f("routes.printTemplates") }]} tabs={tabs} />}>
      <Workspace>
        <CenterColumn>
          {loading ? (
            <div className="bs-wait" aria-busy="true" />
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
      </Workspace>
    </AppFrame>
  );
}
