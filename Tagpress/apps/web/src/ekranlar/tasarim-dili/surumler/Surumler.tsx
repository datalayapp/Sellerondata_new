import { API, type ProfileDiff, type ProfileRecord, type ProfileVersionSummary } from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import { api, path, withQuery } from "../../../lib/api.ts";
import { describeChange } from "../mantik/diffView.ts";
import { groupLabel } from "../mantik/formSpec.ts";
import { useVersions, useWork } from "../mantik/work.tsx";
import { Button, CenterColumn, EmptyState, ListRow, Panel, Select, StatusDot, ToolLabel, ToolSpacer, ToolStrip, useConfirm, useToast, Workspace } from "../../../tezgah/index.ts";
import { fmtDate } from "../tarih.ts";
import "./surumler.css";

/**
 * Sürümler: solda geçmiş (kod, not, tarih; etkin olan noktalı), ortanın araç şeridinde karşılaştırılan sürümler ve
 * "Bu sürüme dön" (yeni sürüm olarak yayınlanır; geçmiş silinmez), altında üç sütunlu fark tablosu.
 */
export default function Surumler() {
  const { t } = useTranslation("designLanguage");
  const w = useWork();
  const versions = useVersions(w.languageId);
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.version - a.version), [versions.data]);
  const [to, setTo] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Varsayılan: en yeni sürüm ile bir öncekini karşılaştır.
  useEffect(() => {
    if (to !== null && list.some((v) => v.version === to)) return;
    const first = list[0];
    if (!first) return;
    setTo(first.version);
    setFrom(list.find((v) => v.version < first.version)?.version ?? null);
  }, [list, to]);

  const diff = useQuery({
    queryKey: ["profileDiff", w.languageId, from, to],
    queryFn: () => api.get<ProfileDiff>(withQuery(path(API.profileDiff, { lang: w.languageId }), { from: from ?? undefined, to: to ?? undefined })),
    enabled: from !== null && to !== null && from !== to,
  });
  const changes = useMemo(() => (diff.data?.changes ?? []).map(describeChange), [diff.data]);

  const pick = (v: ProfileVersionSummary) => {
    setTo(v.version);
    setFrom(list.find((x) => x.version < v.version)?.version ?? null);
  };

  const revert = async (v: ProfileVersionSummary) => {
    const ok = await confirm({ title: t("versions.revertTitle", { version: v.version }), body: t("versions.revertBody"), confirmLabel: t("versions.revert") });
    if (!ok) return;
    setBusy(true);
    try {
      const rec = await api.post<ProfileRecord>(path(API.profileRevert, { lang: w.languageId }), { version: v.version, note: t("versions.revertNote", { version: v.version }) });
      qc.setQueryData(["profile", w.languageId], rec);
      void qc.invalidateQueries({ queryKey: ["profileVersions"] });
      void qc.invalidateQueries({ queryKey: ["profileDraft"] });
      void qc.invalidateQueries({ queryKey: ["languages"] });
      setTo(null);
      toast({ message: t("versions.reverted", { from: v.version, to: rec.version }), tone: "success" });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const selected = list.find((v) => v.version === to) ?? null;
  const key = (v: ProfileVersionSummary) => `${v.version}-${v.status}`;
  const name = (n: number | null) => (n === null ? "" : t("versions.version", { n }));
  const canRevert = !!selected && selected.status === "published" && !selected.active;

  return (
    <Workspace
      leftWidth={300}
      left={
        <Panel side="left" title={t("versions.title")} count={list.length || undefined}>
          {versions.isLoading ? (
            <p className="td-sv-not td-sv-pad">
              <StatusDot tone="busy" label={t("loading")} />
            </p>
          ) : versions.isError ? (
            <EmptyState icon="warn" title={t("versions.loadFailed")} action={<Button onClick={() => void versions.refetch()}>{t("versions.retry")}</Button>} />
          ) : list.length === 0 ? (
            <EmptyState icon="refresh" title={t("versions.empty")} />
          ) : (
            <nav aria-label={t("versions.listLabel")}>
              {list.map((v) => {
                const date = fmtDate(v.publishedAt ?? v.createdAt);
                // Not yoksa başlık tarih olur (ayrıca "Not yok" yazılmaz); kod solda soluk mono.
                return (
                  <ListRow
                    key={key(v)}
                    density="auto"
                    leading={
                      <span className="td-sv-kod">
                        {v.status === "draft" ? t("versions.draft") : t("versions.code", { n: v.version })}
                      </span>
                    }
                    title={v.note || date}
                    sub={v.note ? date : undefined}
                    trailing={v.active ? <span className="td-sv-etkin"><StatusDot tone="ok" label={t("versions.active")} /></span> : undefined}
                    current={v.version === to}
                    onClick={() => pick(v)}
                  />
                );
              })}
            </nav>
          )}
        </Panel>
      }
    >
      <CenterColumn
        strip={
          selected ? (
            <ToolStrip label={t("versions.compareTools")}>
              <ToolLabel>{t("versions.previous")}</ToolLabel>
              <span className="td-sv-sec">
                <Select<string>
                  value={from === null ? "" : String(from)}
                  options={list.filter((v) => v.version !== to).map((v) => ({ value: String(v.version), label: `${name(v.version)}${v.status === "draft" ? ` (${t("versions.draftLower")})` : ""}` }))}
                  aria-label={t("versions.compared")}
                  onChange={(x) => setFrom(Number(x))}
                />
              </span>
              <span className="td-sv-sonraki">
                {t("versions.nextArrow")} <b>{name(selected.version)}</b>
              </span>
              <ToolSpacer />
              {canRevert && (
                <Button icon="undo" loading={busy} onClick={() => void revert(selected)}>
                  {t("versions.revert")}
                </Button>
              )}
            </ToolStrip>
          ) : undefined
        }
      >
        <div className="td-sayfa td-sv">
          {selected &&
            (from === null ? (
              <p className="td-sv-not">{t("versions.first")}</p>
            ) : diff.isLoading ? (
              <p className="td-sv-not">
                <StatusDot tone="busy" label={t("loading")} />
              </p>
            ) : diff.isError ? (
              <p className="td-sv-hata">{serverText(diff.error)}</p>
            ) : changes.length === 0 ? (
              <p className="td-sv-not">{t("versions.noDiff")}</p>
            ) : (
              <div className="td-sv-fark">
                <h2 className="td-sv-say">{t("versions.changed", { n: changes.length })}</h2>
                <table className="td-sv-tablo">
                  <thead>
                    <tr>
                      <th scope="col">{t("versions.field")}</th>
                      <th scope="col">{name(from)}</th>
                      <th scope="col">{name(selected.version)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((c) => (
                      <tr key={c.path}>
                        <th scope="row">{`${c.group ? groupLabel(c.group) : t("versions.other")} · ${c.label}`}</th>
                        <td className="td-sv-eski">
                          <s>{c.from}</s>
                        </td>
                        <td className="td-sv-yeni">{c.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          {canRevert && <p className="td-sv-not">{t("versions.revertHint")}</p>}
        </div>
      </CenterColumn>
    </Workspace>
  );
}
