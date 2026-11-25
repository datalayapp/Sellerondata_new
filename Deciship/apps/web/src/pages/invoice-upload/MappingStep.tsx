import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { fmtLongDay, readAmbiguousWeight, type FieldSources, type HeaderField, type MappingDiagnostics } from "@deciship/core";
import type { AiMappingResult, ColumnMapping, InvoicePreviewTable } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Button, Card, Field, StatusPill } from "../../components/ui";
import { fmtNum, numToInput } from "../../lib/format";
import { useLocaleSwitch } from "../../lib/localeSwitch";
import { relocalizeNumberText } from "../../lib/weightChoice";
import { MAPPING_FIELDS, type MappingField } from "../../lib/labels";
import { AiBar, FilePreview } from "./MappingParts";
import { fieldLabel, sourceLabel } from "./uploadUtils";
import { commitVatPct } from "./vatInput";
import { VerificationCard } from "./Verification";

export function MappingStep({
  preview,
  mapping,
  setMapping,
  missing,
  saveMapping,
  canRemember,
  setSaveMapping,
  diag,
  verifying,
  sources,
  setSources,
  ai,
  aiBusy,
  aiError,
  onAi,
  currency,
}: {
  preview: InvoicePreviewTable;
  mapping: ColumnMapping;
  setMapping: (m: ColumnMapping) => void;
  missing: MappingField[];
  saveMapping: boolean;
  /** K3: kayıtlı eşlemeyi değiştirme izni (`deciship.settings.manage`); yoksa kutu kapalı, nedeni altında. */
  canRemember: boolean;
  setSaveMapping: (b: boolean) => void;
  diag?: MappingDiagnostics;
  verifying: boolean;
  sources: FieldSources;
  setSources: (s: FieldSources) => void;
  ai: AiMappingResult | null;
  /** Yapay zekâ eşlemesi sürüyor: sütun seçimleri ve bütün eşleme seçenekleri (tarih sırası, ek ücret, KDV, desi) kapalı (10-B8). */
  aiBusy: boolean;
  aiError: unknown;
  onAi: () => void;
  currency?: string;
}) {
  const { t, i18n } = useTranslation("invoiceUpload");
  const META_ROWS: {
    key: HeaderField;
    label: string;
    hint?: string;
    required?: boolean;
  }[] = [
    { key: "invoiceNo", label: t("map.meta.invoiceNo"), hint: t("map.meta.invoiceNoHint") },
    { key: "invoiceDate", label: t("map.meta.invoiceDate") },
    { key: "invoiceTotal", label: t("map.meta.invoiceTotal"), hint: t("map.meta.invoiceTotalHint") },
  ];
  const META_KEYS = new Set<string>(META_ROWS.map((m) => m.key));
  // Ambalaj sütunu (poşet / zarf): eşleme alanı değil (core `MAPPING_FIELDS` dışı), sunucu başlıktan önerir; yanlışsa buradan düzeltilir
  const PACK_ROW = { key: "packaging" as const, label: t("map.packaging"), hint: t("map.packagingHint") };
  META_KEYS.add(PACK_ROW.key);
  const ver = diag?.verification;
  const headers = preview.headers;
  const mappedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of MAPPING_FIELDS) {
      const h = mapping[f.key];
      if (h) m.set(h, fieldLabel(f.key));
    }
    for (const s of mapping.surchargeColumns)
      m.set(s.header, t("map.surchargeLabel", { code: s.code }));
    if (mapping.packaging) m.set(mapping.packaging, t("map.packaging"));
    return m;
  }, [mapping]);
  const unusedHeaders = headers.filter((h) => !mappedBy.has(h));
  const samplesOf = (h?: string) => {
    if (!h) return [];
    const i = headers.indexOf(h);
    if (i < 0) return [];
    const out: string[] = [];
    for (const r of preview.sampleRows) {
      const v = (r[i] ?? "").trim();
      if (v && !out.includes(v)) out.push(v);
      if (out.length === 3) break;
    }
    return out;
  };
  const required = MAPPING_FIELDS.filter((f) => f.required);
  const optional = MAPPING_FIELDS.filter((f) => !f.required);
  const mappedCount = MAPPING_FIELDS.filter((f) => mapping[f.key]).length;
  // Önce özet: kontrol "Sorun yok" diyorsa uzun eşleme tablosu katlı gelir; sorun çıkarsa açılır.
  const needsReview =
    missing.length > 0 ||
    Boolean(preview.suggestAi && !ai) ||
    (ver ? ver.verdict !== "ok" : false);
  const [mapOpen, setMapOpen] = useState(needsReview);
  useEffect(() => {
    if (needsReview) setMapOpen(true);
  }, [needsReview]);
  // 10-B19: KDV oranı yazılırken metin olarak durur (null = kayıtlı oran gösterilir), kutudan çıkınca sayıya çevrilir.
  const [vatText, setVatText] = useState<string | null>(null);
  // K36 incelemesi: arayüz dili değişince yazılmış sayılar anlamını korur (Türkçe "6.000" İngilizcede 6 olmasın)
  useLocaleSwitch((from, to) => setVatText((v) => (v === null ? v : relocalizeNumberText(v, from, to))));

  const row = (f: {
    key: HeaderField | "packaging";
    label: string;
    required?: boolean;
    hint?: string;
  }) => {
    const hk = f.key as HeaderField;
    const label = META_KEYS.has(f.key) ? f.label : fieldLabel(f.key as MappingField);
    const isMissing = missing.includes(f.key as MappingField);
    const v =
      (mapping[f.key as keyof ColumnMapping] as string | undefined) ?? "";
    const samples = samplesOf(v);
    const fv = v ? ver?.fields[hk] : undefined;
    const src = v ? sources[hk] : undefined;
    const aiPick = src === "ai" ? ai?.aiConfidence[hk] : undefined;
    const pill = !v ? (
      f.required ? (
        <StatusPill tone="red">{t("map.unmapped")}</StatusPill>
      ) : null
    ) : !fv ? null : fv.status === "ok" ? (
      <StatusPill tone="green">{t("map.sure")}</StatusPill>
    ) : (
      <StatusPill tone="yellow">{t("map.check")}</StatusPill>
    );
    const reasons = fv?.reasons.join(" · ");
    return (
      <div
        key={f.key}
        className={`mrow${isMissing ? " missing" : ""}${v ? " mapped" : ""}${fv?.status === "check" ? " check" : ""}`}
      >
        <div className="mf">
          <label htmlFor={`map-${f.key}`}>{label}</label>
          {f.required && (
            <span className={`tag sm ${isMissing ? "red" : "blue"}`}>
              {t("map.required")}
            </span>
          )}
          {f.hint && <span className="mf-hint">{META_KEYS.has(f.key) ? f.hint : t(`map.hint.${f.key}`, { defaultValue: f.hint })}</span>}
          <span className="mstat" data-testid={`map-status-${f.key}`}>
            {pill}
            {src && (
              <span className={`msrc src-${src}`}>{sourceLabel(src)}</span>
            )}
          </span>
        </div>
        <div className="mc">
          <Icon name="back" className="mc-arrow" />
          <select
            id={`map-${f.key}`}
            className={`sel${isMissing ? " invalid" : ""}${v ? "" : " unset"}`}
            value={v}
            aria-invalid={isMissing || undefined}
            aria-describedby={isMissing ? `map-${f.key}-err` : undefined}
            disabled={aiBusy}
            onChange={(e) => {
              setMapping({ ...mapping, [f.key]: e.target.value || undefined });
              const next = { ...sources };
              if (e.target.value) next[hk] = "user";
              else delete next[hk];
              setSources(next);
            }}
          >
            <option value="">{t("map.unmappedOption")}</option>
            {headers.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          {isMissing && (
            <span className="merr" id={`map-${f.key}-err`}>
              {t("map.requiredHint")}
            </span>
          )}
          {v && (reasons || aiPick) && (
            <span
              className={`mreason${fv?.status === "check" ? " bad" : ""}`}
              title={aiPick?.reason}
            >
              {reasons}
              {aiPick && (
                <>
                  {reasons ? " · " : ""}
                  {t("map.aiReason", { reason: aiPick.reason, pct: fmtNum(aiPick.confidence * 100, 0, 0) })}
                </>
              )}
            </span>
          )}
        </div>
        <div className="ms" aria-label={t("map.samplesOf", { field: label })}>
          {samples.length ? (
            samples.map((s, i) => (
              <span key={i} className="sv mono" title={s}>
                {s}
              </span>
            ))
          ) : (
            <span className="t3 s12">{v ? t("map.emptyInSamples") : "—"}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="wiz-two">
      {!ai && (
        <div
          className={`notif ${preview.mappingSource === "saved" ? "ok" : "info"}`}
        >
          <Icon name={preview.mappingSource === "saved" ? "ok" : "info"} />
          <span>
            {preview.mappingSource === "saved" ? (
              <Trans t={t} i18nKey="map.savedApplied" components={{ b: <b /> }} />
            ) : (
              <Trans
                t={t}
                i18nKey="map.suggestedApplied"
                values={{
                  pct: fmtNum(
                    (preview.confidence ?? 0) *
                      (preview.confidence <= 1 ? 100 : 1),
                    0,
                    0,
                  ),
                }}
                components={{ b: <b /> }}
              />
            )}{" "}
            {t("map.fileSize", {
              cols: t("map.cols", { count: headers.length, n: fmtNum(headers.length) }),
              rows: t("map.rows", { count: preview.rowCount, n: fmtNum(preview.rowCount) }),
            })}
          </span>
        </div>
      )}

      <AiBar
        suggest={Boolean(preview.suggestAi) && !ai}
        available={preview.aiAvailable !== false}
        busy={aiBusy}
        error={aiError}
        ai={ai}
        onAi={onAi}
      />

      {preview.diagnostics?.warnings.some(
        (w) => w.code === "SAVED_MAPPING_FALLBACK",
      ) && (
        <div className="notif warn">
          <Icon name="warn" />
          <span>
            {t("map.savedFallback")}
          </span>
        </div>
      )}

      {/* KALANLAR 1.6: Excel'in yalnız bir sayfası okunur; öbürleri adıyla söylenir (gönderi satırı taşıyanı okuma kontrolü ayrıca sorar) */}
      {diag?.sheets && diag.sheets.unread.length > 0 && (
        <div className={`notif ${diag.sheets.unread.some((s) => s.invoiceLike) ? "warn" : "info"}`} data-testid="unread-sheets">
          <Icon name={diag.sheets.unread.some((s) => s.invoiceLike) ? "warn" : "info"} />
          <span>
            {t("map.sheets", { read: diag.sheets.read, unread: diag.sheets.unread.map((s) => `"${s.name}"`).join(", ") })}
          </span>
        </div>
      )}

      {diag?.dateAmbiguity && (
        <div className={`notif ${mapping.dateOrder === "dmy" || mapping.dateOrder === "mdy" ? "info" : "warn"}`} data-testid="date-order">
          <Icon name={mapping.dateOrder === "dmy" || mapping.dateOrder === "mdy" ? "info" : "warn"} />
          <div role="radiogroup" aria-labelledby="date-order-title">
            <b id="date-order-title">{t("map.dateOrder.title")}</b>{" "}
            {t("map.dateOrder.body", { sample: diag.dateAmbiguity.sample })}
            <div className="date-order-opts">
              {(["dmy", "mdy"] as const).map((order) => (
                <label key={order} className="check">
                  <input
                    type="radio"
                    name="date-order"
                    checked={mapping.dateOrder === order}
                    disabled={aiBusy}
                    onChange={() => setMapping({ ...mapping, dateOrder: order })}
                  />
                  {t(`map.dateOrder.${order}`, { date: fmtLongDay(diag.dateAmbiguity![order], i18n.language === "en" ? "en" : "tr") })}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* K36: "1.500" ağırlık 1,5 kg da 1500 kg da olabilir; seçim yalnız ağırlık hücrelerine (tutarlar değişmez), dosya başına */}
      {diag?.weightAmbiguity && (
        <div className={`notif ${mapping.weightFormat ? "info" : "warn"}`} data-testid="weight-format">
          <Icon name={mapping.weightFormat ? "info" : "warn"} />
          <div role="radiogroup" aria-labelledby="weight-format-title">
            <b id="weight-format-title">{t("map.weightFormat.title")}</b>{" "}
            {t("map.weightFormat.body", { sample: [diag.weightAmbiguity.sample, ...(diag.weightAmbiguity.other ? [diag.weightAmbiguity.other] : [])].join(", ") })}
            <div className="date-order-opts">
              {/* seçenek yazım biçimidir; dosyada "1.500" ve "1,500" birlikte varsa ikisi de gösterilir, her biri kendi ayırıcısıyla */}
              {((diag.weightAmbiguity.sample.includes(",") ? ["tr", "en"] : ["en", "tr"]) as ("tr" | "en")[]).map((fmt) => (
                <label key={fmt} className="check">
                  <input
                    type="radio"
                    name="weight-format"
                    checked={mapping.weightFormat === fmt}
                    disabled={aiBusy}
                    onChange={() => setMapping({ ...mapping, weightFormat: fmt })}
                  />
                  {t(`map.weightFormat.${fmt}`, {
                    list: [diag.weightAmbiguity!.sample, ...(diag.weightAmbiguity!.other ? [diag.weightAmbiguity!.other] : [])]
                      .map((text) => t("common:weightChoice.item", { text, value: `${fmtNum(readAmbiguousWeight(text, fmt) ?? 0, 0, 3)} kg` }))
                      .join(", "),
                  })}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="map-cols">
        <div className="map-main">
          {!mapOpen && (
            <button
              type="button"
              className="card map-fold"
              aria-expanded={false}
              aria-controls="map-card"
              onClick={() => setMapOpen(true)}
            >
              <Icon name="table" />
              <span className="grow">
                {t("map.title")}
                <span className="t3 s12">
                  {" "}
                  · {t("map.foldedSummary", { mapped: fmtNum(mappedCount), total: fmtNum(MAPPING_FIELDS.length) })}
                </span>
              </span>
              <span className="link-btn">{t("map.show")}</span>
              <Icon name="chev" className="raw-chev" />
            </button>
          )}
          <div id="map-card" hidden={!mapOpen}>
          <Card
            flush
            className="map-card"
            title={t("map.title")}
            description={t("map.desc")}
            actions={
              <span className="map-count">
                <span className={`tag ${missing.length ? "red" : "green"}`}>
                  {missing.length
                    ? t("map.requiredMissing", { count: missing.length, n: fmtNum(missing.length) })
                    : t("map.requiredDone")}
                </span>
                <span className="t3 s12 num">
                  {t("map.mappedCount", { mapped: fmtNum(mappedCount), total: fmtNum(MAPPING_FIELDS.length) })}
                </span>
                {!needsReview && (
                  <Button kind="ghost" small onClick={() => setMapOpen(false)}>
                    {t("map.hide")}
                  </Button>
                )}
              </span>
            }
          >
            <div className="mapt">
              <div className="mrow h" aria-hidden="true">
                <div>{t("map.colField")}</div>
                <div>{t("map.colInvoice")}</div>
                <div>{t("map.colSamples")}</div>
              </div>
              <div className="mgroup">{t("map.groupRequired")}</div>
              {required.map(row)}
              <div className="mgroup">{t("map.groupOptional")}</div>
              {optional.map(row)}
              {row(PACK_ROW)}
              <div className="mgroup">{t("map.groupMeta")}</div>
              {META_ROWS.map(row)}
            </div>
          </Card>
          </div>

          <FilePreview preview={preview} mappedBy={mappedBy} />
        </div>
        <div className="map-side">
          <VerificationCard diag={diag} verifying={verifying} currency={currency} />
          <Card
            title={t("sur.title")}
            description={t("sur.desc")}
          >
            <div className="map-opts">
              <div className="map-sur">
                <div className="lbl">{t("sur.columns")}</div>
                {mapping.surchargeColumns.length === 0 && (
                  <p className="t3 s12 sur-empty">{t("sur.none")}</p>
                )}
                {mapping.surchargeColumns.map((s, i) => (
                  <div key={i} className="sur-row">
                    <select
                      aria-label={t("sur.column")}
                      className="sel sm"
                      value={s.header}
                      disabled={aiBusy}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          surchargeColumns: mapping.surchargeColumns.map((x, j) =>
                            j === i ? { ...x, header: e.target.value } : x,
                          ),
                        })
                      }
                    >
                      {[s.header, ...unusedHeaders]
                        .filter((v, k, a) => a.indexOf(v) === k)
                        .map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                    </select>
                    <input
                      aria-label={t("sur.code")}
                      className="inp sm mono sur-code"
                      placeholder={t("sur.codePlaceholder")}
                      title={s.code || undefined}
                      value={s.code}
                      disabled={aiBusy}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          surchargeColumns: mapping.surchargeColumns.map((x, j) =>
                            j === i
                              ? { ...x, code: e.target.value.toUpperCase() }
                              : x,
                          ),
                        })
                      }
                    />
                    <Button
                      kind="plain"
                      small
                      icon="trash"
                      aria-label={t("sur.remove")}
                      disabled={aiBusy}
                      onClick={() =>
                        setMapping({
                          ...mapping,
                          surchargeColumns: mapping.surchargeColumns.filter(
                            (_, j) => j !== i,
                          ),
                        })
                      }
                    />
                  </div>
                ))}
                {unusedHeaders.length > 0 && (
                  <Button
                    kind="ghost"
                    small
                    icon="plus"
                    disabled={aiBusy}
                    onClick={() =>
                      setMapping({
                        ...mapping,
                        surchargeColumns: [
                          ...mapping.surchargeColumns,
                          {
                            header: unusedHeaders[0],
                            code: unusedHeaders[0]
                              .replace(/[^A-Za-z0-9]/g, "")
                              .slice(0, 6)
                              .toUpperCase(),
                          },
                        ],
                      })
                    }
                  >
                    {t("sur.add")}
                  </Button>
                )}
              </div>
              <div className="map-flags">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={mapping.amountsIncludeVat}
                    disabled={aiBusy}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        amountsIncludeVat: e.target.checked,
                        ...(e.target.checked ? {} : { componentsIncludeVat: undefined }),
                      })
                    }
                  />
                  {t("sur.vatIncluded")}
                </label>
                {mapping.amountsIncludeVat && (
                  <Field label={t("sur.vatPct")} htmlFor="vat">
                    <input
                      id="vat"
                      className="inp sm num w-xs"
                      inputMode="decimal"
                      value={vatText ?? numToInput(mapping.vatPct)}
                      disabled={aiBusy}
                      onChange={(e) => setVatText(e.target.value)}
                      onBlur={() => {
                        if (vatText === null) return;
                        const vatPct = commitVatPct(vatText, mapping.vatPct);
                        setVatText(null);
                        if (vatPct !== mapping.vatPct) setMapping({ ...mapping, vatPct });
                      }}
                    />
                  </Field>
                )}
                {mapping.amountsIncludeVat && diag?.componentsVat?.hasComponents && (
                  <div>
                    <Field label={t("sur.componentsVat")} htmlFor="comp-vat">
                      <select
                        id="comp-vat"
                        className="sel sm"
                        value={(mapping.componentsIncludeVat ?? diag.componentsVat.value) ? "incl" : "excl"}
                        disabled={aiBusy}
                        onChange={(e) =>
                          setMapping({ ...mapping, componentsIncludeVat: e.target.value === "incl" })
                        }
                      >
                        <option value="excl">{t("sur.componentsVatExcl")}</option>
                        <option value="incl">{t("sur.componentsVatIncl")}</option>
                      </select>
                    </Field>
                    {diag.componentsVat.source !== "mapping" && (
                      <p className={`t3 s12${diag.componentsVat.source === "default" ? " warn-t" : ""}`}>
                        {t(`sur.componentsVatSrc.${diag.componentsVat.source}`)}
                      </p>
                    )}
                  </div>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={mapping.desiAsWeight}
                    disabled={aiBusy}
                    onChange={(e) =>
                      setMapping({ ...mapping, desiAsWeight: e.target.checked })
                    }
                  />
                  {t("sur.desiAsWeight")}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={saveMapping}
                    disabled={!canRemember}
                    aria-describedby={canRemember ? undefined : "remember-locked"}
                    onChange={(e) => setSaveMapping(e.target.checked)}
                  />
                  <b>{t("sur.remember")}</b>
                </label>
                {!canRemember && (
                  <p id="remember-locked" className="t3 s12" data-testid="remember-locked">
                    {t("sur.rememberLocked")}
                  </p>
                )}
              </div>
            </div>
          </Card>

        </div>
      </div>
    </div>
  );
}
