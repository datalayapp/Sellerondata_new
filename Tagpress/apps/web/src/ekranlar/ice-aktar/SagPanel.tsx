import type { ImportField } from "@tagpress/domain";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { fieldStates, mappingSummary } from "./mantik/desk.ts";
import { Button, CollapsedGroup, cx, Icon, IssueBox, Menu, type MenuItem, Panel, PanelSection, PropRow, TextField } from "../../tezgah/index.ts";
import { fieldLabel, formatLabel } from "./metin.ts";
import type { Masa } from "./useMasa.ts";

/** Sağ panel: dosya (parti adı, dosya uyarıları), özet, toplu bağlantılar, kapalı grupta alan eşlemesi; altta gönderim. */
export function SagPanel({ m }: { m: Masa }) {
  const { t } = useTranslation("importDesk");
  const nameId = useId();
  const preview = m.preview;
  if (!preview) return null;
  const { tally, bulk } = m;
  const none = tally.importable === 0;
  const busy = m.committing !== null;
  const summary = mappingSummary(preview);
  const links: Array<{ id: string; label: string; n: number; run(): void }> = [
    { id: "errors", label: t("bulk.excludeErrors", { n: bulk.errors }), n: bulk.errors, run: () => m.excludeWhere("errors") },
    { id: "problems", label: t("bulk.excludeProblems", { n: bulk.problems }), n: bulk.problems, run: () => m.excludeWhere("problems") },
    { id: "duplicates", label: t("bulk.excludeDuplicates", { n: bulk.duplicates }), n: bulk.duplicates, run: () => m.excludeWhere("duplicates") },
    { id: "include", label: t("bulk.includeAll", { n: bulk.excluded }), n: bulk.excluded, run: m.includeAll },
  ];
  if (m.styledCount > 0) links.push({ id: "plain", label: t("bulk.plainLetters", { n: m.styledCount }), n: m.styledCount, run: m.convertStyled });
  // Yalnız yapılabilecek toplu işler (maket "Toplu"); hiçbiri yoksa bölüm çizilmez.
  const doable = links.filter((l) => l.n > 0);

  return (
    <Panel
      side="right"
      title={t("panel.title")}
      count={t("panel.rows", { count: tally.total })}
      footer={
        <>
          <div className="ia-foot-r">
            <Button variant="quiet" size="page" onClick={() => void m.requestClose()} disabled={busy}>
              {t("panel.cancel")}
            </Button>
            <span className="tz-sp" />
            <Button need="edit" size="page" onClick={() => void m.commit(false)} disabled={none} loading={m.committing === "plain"}>
              {t("panel.import")}
            </Button>
          </div>
          <Button
            need="spend"
            variant="primary"
            size="page"
            wide
            command="iceAktar.commitGenerate"
            onClick={() => void m.commit(true)}
            disabled={none}
            loading={m.committing === "generate"}
            title={tally.blocked ? t("panel.blockedHint", { n: tally.importable - tally.blocked }) : undefined}
          >
            {t("panel.importGenerate")}
          </Button>
        </>
      }
    >
      <PanelSection>
        <PropRow label={t("panel.batchName")} htmlFor={nameId}>
          <TextField id={nameId} value={m.batchName} onChange={m.setBatchName} maxLength={120} placeholder={t("panel.batchPlaceholder")} />
        </PropRow>
        {preview.warnings.length > 0 && (
          <IssueBox tone="warn">
            <b>{t("panel.fileWarnings")}</b>
            <ul className="ia-warn-l">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </IssueBox>
        )}
      </PanelSection>

      <PanelSection heading={t("panel.summary")}>
        <dl className="ia-sum" aria-label={t("panel.summary")}>
          <dt className="tz-mono">{tally.importable}</dt>
          <dd>{t("panel.sumImportable")}</dd>
          <dt className="tz-mono">{tally.excluded}</dt>
          <dd>{t("panel.sumExcluded")}</dd>
          {tally.blocked > 0 && (
            <>
              <dt className="tz-mono is-err">{tally.blocked}</dt>
              <dd className="is-err">{t("panel.sumBlocked")}</dd>
            </>
          )}
          {tally.warnings > 0 && (
            <>
              <dt className="tz-mono is-warn">{tally.warnings}</dt>
              <dd className="is-warn">{t("panel.sumWarnings")}</dd>
            </>
          )}
          {tally.duplicates > 0 && (
            <>
              <dt className="tz-mono">{tally.duplicates}</dt>
              <dd>{t("panel.sumDuplicates")}</dd>
            </>
          )}
          {tally.stickers > 0 && (
            <>
              <dt className="tz-mono">{tally.stickers}</dt>
              <dd>{t("panel.sumStickers")}</dd>
            </>
          )}
        </dl>
      </PanelSection>

      {doable.length > 0 && (
        <PanelSection heading={t("panel.bulk")}>
          <div className="ia-links">
            {doable.map((l) => (
              <button key={l.id} type="button" className="ia-link" onClick={l.run}>
                {l.label}
              </button>
            ))}
          </div>
        </PanelSection>
      )}

      <CollapsedGroup
        title={t("mapping.title")}
        summary={summary.textMissing ? t("mapping.textMissing") : t("mapping.summary", { format: formatLabel(preview.format), count: summary.mapped })}
        defaultOpen={summary.textMissing}
        persistKey="ice-aktar.esleme"
      >
        <div className="ia-map">
          <p className="ia-map-f">{t("mapping.format", { format: formatLabel(preview.format) })}</p>
          {fieldStates(preview).map((s) => (
            <EslemeSatiri key={s.field} m={m} field={s.field} current={s.current} source={s.source} missing={s.missing} fields={preview.fields} />
          ))}
        </div>
      </CollapsedGroup>
    </Panel>
  );
}

function EslemeSatiri({
  m,
  field,
  current,
  source,
  missing,
  fields,
}: {
  m: Masa;
  field: ImportField;
  current: string | null;
  source: "name" | "content" | "user" | null;
  missing: boolean;
  fields: readonly string[];
}) {
  const { t } = useTranslation("importDesk");
  const items: (MenuItem | "sep")[] = [
    { label: t("mapping.none"), icon: current === null ? "check" : undefined, onSelect: () => void m.changeMapping(field, null) },
    "sep",
    ...fields.map((name) => ({ label: name, icon: current === name ? ("check" as const) : undefined, onSelect: () => void m.changeMapping(field, name) })),
  ];
  const label = fieldLabel(field);
  const value = current ?? (missing ? t("mapping.notSet") : t("mapping.empty"));
  return (
    <PropRow label={label}>
      <Menu
        align="end"
        items={items}
        trigger={(p) => (
          <button type="button" className={cx("ia-map-b", missing && "is-missing")} {...p} aria-label={t("mapping.pick", { field: label, value })} title={t(`mapping.source.${source ?? "none"}`)}>
            <span className={cx("ia-map-v", current ? "tz-mono" : "is-empty")}>{value}</span>
            {source === "content" && <small>{t("mapping.guess")}</small>}
            <Icon name="chev" size={12} />
          </button>
        )}
      />
    </PropRow>
  );
}
