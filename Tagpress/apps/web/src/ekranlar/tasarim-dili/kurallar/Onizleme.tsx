import { API, type ProfileTryRequest, type ProfileTryResponse } from "@tagpress/domain";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMm } from "../../../i18n/bicim.ts";
import { serverText } from "../../../i18n/sunucu.ts";
import { api, path } from "../../../lib/api.ts";
import { LabelImage } from "../../../ortak/index.ts";
import { useReferences, useWork } from "../mantik/work.tsx";
import {
  Artboard,
  CanvasDock,
  CanvasViewport,
  CenterColumn,
  IssueBadge,
  IssueBox,
  Select,
  StatusBar,
  StatusDot,
  ToolLabel,
  ToolSpacer,
  ToolStrip,
  Tooltip,
  useViewport,
  ZoomControl,
} from "../../../tezgah/index.ts";
import { labelMm } from "../ornekler/RefGorsel.tsx";
import { Sema } from "./Sema.tsx";
import "./onizleme.css";

/** Seçicide "kısa metin" seçeneğinin değeri (örnek kimliği olamaz). */
const FREE = "__metin__";
const GAP = 16;
/** Şema küçük yardımcıdır (karar 9): önizlemenin yarısı kadar. */
const SCHEMA = 0.5;

/**
 * Kurallar ortası: seçili örneğin taslak (yoksa yayınlanmış) profille ÜCRETSİZ motor önizlemesi (Dene'nin Motor yöntemiyle
 * aynı uç, AI çağrılmaz). Alan değişince taslak kaydedilir (bekletmeli); kaydedilen profil değişince önizleme yenilenir.
 * Yüklenirken eski görüntü soluk kalır. Yanında oran şeması küçük yardımcı olarak durur.
 */
export function Onizleme() {
  const { t } = useTranslation("designLanguage");
  const w = useWork();
  const refs = useReferences(w.languageId);
  const list = useMemo(() => (refs.data ?? []).slice(0, 200), [refs.data]);
  const [pick, setPick] = useState<string>("");
  const chosen = pick === FREE ? null : (list.find((r) => r.id === pick) ?? list[0] ?? null);
  const which: "draft" | "published" = w.draft ? "draft" : "published";
  const rec = w.draft ?? w.active;
  const mm = labelMm(rec?.data ?? w.value);

  const sample: ProfileTryRequest["samples"][number] = chosen
    ? { id: `ref:${chosen.id}`, text: chosen.text, templateKey: chosen.templateKey, labelSize: null, referenceId: chosen.id }
    : { id: "metin", text: t("rules.preview.sampleText"), templateKey: null, labelSize: null, referenceId: null };
  // Sunucudaki (kaydedilmiş) profil: yerel düzenleme kaydedilince değişir, önizleme o zaman yenilenir.
  const saved = rec ? JSON.stringify(rec.data) : "";

  const q = useQuery({
    queryKey: ["rulesPreview", w.languageId, which, sample.id, sample.text, saved],
    queryFn: () => api.post<ProfileTryResponse>(path(API.profileTry, { lang: w.languageId }), { samples: [sample], profiles: [which], mode: "engine" } satisfies ProfileTryRequest),
    enabled: !!rec,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: Infinity,
  });
  const result = q.data?.results[0];
  const side = result?.[which] ?? result?.published ?? result?.draft ?? null;

  const world = useMemo(() => ({ x: 0, y: 0, w: mm * (1 + SCHEMA) + GAP, h: mm }), [mm]);
  const api2 = useViewport({ world });
  useEffect(() => {
    api2.fit(world);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sığdırma yalnız dünya genişliği değişince; api2 ve world nesnesi her çizimde yeni, kullanıcının yakınlaştırması bozulmasın
  }, [world.w]);

  const busy = q.isFetching;
  const problem = q.isError ? serverText(q.error) : result?.error ? serverText(new Error(result.error)) : null;
  const options = [...list.map((r) => ({ value: r.id, label: r.text })), { value: FREE, label: t("rules.preview.free") }];
  const value = chosen ? chosen.id : FREE;

  return (
    <CenterColumn
      strip={
        <ToolStrip label={t("rules.preview.tools")}>
          <ToolLabel>{t("rules.preview.sample")}</ToolLabel>
          <span className="td-oz-sec">
            <Select<string> value={value} options={options} onChange={setPick} aria-label={t("rules.preview.sampleLabel")} />
          </span>
          <ToolSpacer />
          {busy ? <StatusDot tone="busy" label={t("rules.preview.refreshing")} /> : <span className="td-oz-not">{which === "draft" ? t("rules.preview.withDraft") : t("rules.preview.withPublished")}</span>}
        </ToolStrip>
      }
      status={
        <StatusBar end={<ZoomControl api={api2} presets={["fit", "actual"]} />}>
          <span>{t("rules.preview.status", { mm: formatMm(mm) })}</span>
        </StatusBar>
      }
    >
      <CanvasViewport
        api={api2}
        rulers
        overlay={
          problem ? (
            <CanvasDock>
              <IssueBox tone="error">{problem}</IssueBox>
            </CanvasDock>
          ) : !side && busy ? (
            <div className="td-cv-msg">
              <StatusDot tone="busy" label={t("rules.preview.loading")} />
            </div>
          ) : undefined
        }
      >
        <Artboard
          x={0}
          y={0}
          w={mm}
          h={mm}
          name={
            <>
              <b>{t("rules.preview.name")}</b> · {which === "draft" ? t("rules.preview.draft") : t("rules.preview.published")}
            </>
          }
          below={
            side ? (
              <span className="td-oz-alti">
                <span>{t("rules.preview.lines", { count: side.lines.length })}</span>
                {side.issues > 0 && <IssueBadge tone="warn">{t("rules.preview.issues", { count: side.issues })}</IssueBadge>}
              </span>
            ) : undefined
          }
        >
          {side ? (
            <LabelImage src={side.previewUrl} widthMm={mm} heightMm={mm} alt={t("rules.preview.alt", { text: sample.text })} dimmed={busy} />
          ) : (
            <span className="td-oz-bos" style={{ width: `calc(${mm} * var(--tz-mm))`, height: `calc(${mm} * var(--tz-mm))` }} />
          )}
        </Artboard>
        <Artboard x={mm + GAP} y={0} w={mm * SCHEMA} h={mm * SCHEMA} name={<span>{t("rules.preview.schema")}</span>}>
          <Tooltip content={t("rules.preview.schemaTip")}>
            <span className="td-oz-sema" style={{ width: `calc(${mm * SCHEMA} * var(--tz-mm))` }}>
              {w.value && <Sema profile={w.value} caption={false} />}
            </span>
          </Tooltip>
        </Artboard>
      </CanvasViewport>
    </CenterColumn>
  );
}
