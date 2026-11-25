import { PROFILE_GROUPS, type ProfileGroup } from "@tagpress/domain";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { docFor } from "../mantik/diffView.ts";
import { groupFields, searchFields } from "../mantik/formSpec.ts";
import { diffLeaves } from "../mantik/profilePath.ts";
import { useWork } from "../mantik/work.tsx";
import { CollapsedGroup, EmptyState, IssueBox, ListRow, Panel, SearchField, Tooltip, Workspace } from "../../../tezgah/index.ts";
import { groupHelp, groupLabel } from "../profilMetni.ts";
import { Alan } from "./Alan.tsx";
import { Onizleme } from "./Onizleme.tsx";
import "./kurallar.css";

/**
 * Kurallar: solda alan araması ve grup listesi, ortada seçili örneğin canlı (ücretsiz) motor önizlemesi, sağda seçili grubun alan formu (PROFILE_DOCS'tan üretilir).
 * Temel alanlar açık, ileri alanlar katlı; alan araması bütün gruplarda. Değişiklikler taslağa kendiliğinden kaydedilir.
 */
export default function Kurallar({ group, onGroup }: { group: ProfileGroup; onGroup: (g: ProfileGroup) => void }) {
  const { t, i18n } = useTranslation("designLanguage");
  const w = useWork();
  const [q, setQ] = useState("");
  const info = PROFILE_GROUPS.find((g) => g.id === group) ?? PROFILE_GROUPS[0]!;
  const fields = useMemo(() => groupFields(info.id), [info.id]);
  const basic = fields.filter((f) => f.doc.level === "temel");
  const advanced = fields.filter((f) => f.doc.level === "ileri");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dil değişince yeniden aranır: searchFields etiket ve yardım metnini ortak i18n örneğinden okur
  const hits = useMemo(() => searchFields(q), [q, i18n.language]);
  const searching = q.trim().length > 0;
  const profile = w.value;

  // Yayınlanmış sürümden farklı alanlar: alan işareti ve grup sayacı.
  const changedPaths = useMemo(() => (w.active && profile ? diffLeaves(w.active.data, profile).map((c) => c.path) : []), [w.active, profile]);
  const isChanged = (path: string) => changedPaths.some((p) => p === path || p.startsWith(`${path}.`));
  const changedByGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of changedPaths) {
      const g = docFor(p)?.doc.group;
      if (g) m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  }, [changedPaths]);
  const hasError = (list: typeof fields) => list.some((f) => Object.keys(w.errors).some((p) => p === f.path || p.startsWith(`${f.path}.`)));

  if (!profile) return null;
  return (
    <Workspace
      leftWidth={260}
      rightWidth={330}
      left={
        <Panel side="left">
          <div className="td-ara">
            <SearchField value={q} onChange={setQ} placeholder={t("rules.searchPlaceholder")} aria-label={t("rules.searchLabel")} />
          </div>
          <nav aria-label={t("rules.groupsLabel")}>
            {PROFILE_GROUPS.map((g) => {
              const n = changedByGroup.get(g.id) ?? 0;
              return (
                <ListRow
                  key={g.id}
                  density="compact"
                  title={groupLabel(g.id)}
                  current={!searching && g.id === group}
                  trailing={n > 0 ? n : undefined}
                  onClick={() => {
                    setQ("");
                    onGroup(g.id);
                  }}
                />
              );
            })}
          </nav>
        </Panel>
      }
      right={
        <Panel
          side="right"
          title={
            searching ? (
              t("rules.search")
            ) : (
              <Tooltip content={groupHelp(info.id)}>
                <span>{groupLabel(info.id)}</span>
              </Tooltip>
            )
          }
        >
          {w.generalError && Object.keys(w.errors).length > 0 && (
            <div className="td-uyari">
              <IssueBox tone="error">{t("rules.saveFailed", { message: w.generalError })}</IssueBox>
            </div>
          )}
          {searching ? (
            hits.length === 0 ? (
              <EmptyState icon="search" title={t("rules.noMatch")} />
            ) : (
              <div className="td-alanlar">
                {hits.map((f) => (
                  <Alan key={f.path} spec={f} groupName={groupLabel(f.doc.group)} changed={isChanged(f.path)} />
                ))}
              </div>
            )
          ) : (
            <>
              <div className="td-alanlar">
                {basic.map((f) => (
                  <Alan key={f.path} spec={f} changed={isChanged(f.path)} />
                ))}
              </div>
              {advanced.length > 0 && (
                <CollapsedGroup title={t("rules.advanced")} summary={t("rules.advancedCount", { n: advanced.length })} defaultOpen={hasError(advanced) || advanced.some((f) => isChanged(f.path))}>
                  <div className="td-alanlar">
                    {advanced.map((f) => (
                      <Alan key={f.path} spec={f} changed={isChanged(f.path)} />
                    ))}
                  </div>
                </CollapsedGroup>
              )}
            </>
          )}
        </Panel>
      }
    >
      <Onizleme />
    </Workspace>
  );
}
