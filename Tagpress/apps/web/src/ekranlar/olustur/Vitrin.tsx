import type { ProfileTryResponse, ShowcaseItem } from "@tagpress/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatUsd } from "../../i18n/bicim.ts";
import { currentLocale } from "../../i18n/index.ts";
import { LabelImage } from "../../ortak/index.ts";
import { Artboard, Button, CanvasViewport, CenterColumn, EmptyState, Segmented, StatusBar, StatusDot, TextField, ToolSpacer, ToolStrip, useViewport, ZoomControl } from "../../tezgah/index.ts";
import { DEFAULT_LABEL_MM, layoutShowcase } from "./akis.ts";
import { builderApi, keys } from "./api.ts";
import { hataMetni, notMetni, olcuMetni } from "./metin.ts";

export interface VitrinProps {
  lang: string;
  buildId: string;
  /** Gösterilen sürüm ve son sürüm (taslak). */
  rev: number;
  current: number;
  onRev: (rev: number) => void;
  /** Gösterilen sürümde kaç kural değişti (sağdaki ayrıntıdan). */
  changeCount: number | null;
  costUsd: number;
  budgetUsd: number;
  /** Sunucu çalışıyor: görseller soluk, üstte durum. */
  running: string | null;
}

const TRY_ID = "__kendi";

/**
 * Orta (maket 5): dilin türlere göre örnek etiketleri. Değişen örnek mor çerçeveli ve altında kısa not; önceki
 * sürümle tek tıkla karşılaştırılır; kendi metniyle ücretsiz motor denemesi.
 */
export function Vitrin({ lang, buildId, rev, current, onRev, changeCount, costUsd, budgetUsd, running }: VitrinProps) {
  const { t } = useTranslation("builder");
  const locale = currentLocale();
  const show = useQuery({
    queryKey: keys.showcase(lang, buildId, rev, locale),
    queryFn: () => builderApi.showcase(buildId, rev, locale),
    staleTime: Infinity,
    retry: false,
  });
  const [text, setText] = useState("");
  const [tried, setTried] = useState<{ rev: number; text: string; res: ProfileTryResponse } | null>(null);
  const tryRun = useMutation({
    mutationFn: async (v: string) => ({ rev, text: v, res: await builderApi.tryText(buildId, { text: v, rev, mode: "engine" }) }),
    onSuccess: setTried,
  });

  const items: ShowcaseItem[] = useMemo(() => show.data?.items ?? [], [show.data]);
  const trySide = tried && tried.rev === rev ? (tried.res.results[0]?.draft ?? tried.res.results[0]?.published ?? null) : null;
  const all = useMemo(() => [...(trySide ? [{ id: TRY_ID, sizeMm: null }] : []), ...items], [items, trySide]);
  const { boxes, world } = useMemo(() => layoutShowcase(all), [all]);
  const api = useViewport({ world });
  useEffect(() => {
    api.fit(world);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sığdırma yalnız dünya ölçüsü değişince; api ve world nesnesi her çizimde yeni, kullanıcının yakınlaştırması bozulmasın
  }, [world.w, world.h]);

  const prev = current > 0 ? current - 1 : null;
  const revLabel = (n: number) => (n === 0 ? t("rev.base") : n === current ? t("rev.draft", { n }) : t("rev.n", { n }));

  const overlay = show.isLoading ? (
    <div className="ol-cv-msg">
      <StatusDot tone="busy" label={t("showcase.loading")} />
    </div>
  ) : show.isError ? (
    <div className="ol-cv-msg">
      <EmptyState icon="warn" title={t("showcase.failed")} body={hataMetni(show.error)} />
    </div>
  ) : all.length === 0 ? (
    <div className="ol-cv-msg">
      <EmptyState icon="stamp" title={t("showcase.empty")} />
    </div>
  ) : running ? (
    <div className="ol-cv-durum">
      <StatusDot tone="busy" label={running} />
    </div>
  ) : undefined;

  return (
    <CenterColumn
      strip={
        <ToolStrip label={t("showcase.tools")}>
          {prev !== null && (
            <Segmented<string>
              aria-label={t("showcase.compare")}
              value={String(rev)}
              onChange={(v) => onRev(Number(v))}
              options={[
                { value: String(prev), label: revLabel(prev) },
                { value: String(current), label: revLabel(current) },
              ]}
            />
          )}
          <ToolSpacer />
          <form
            className="ol-dene"
            onSubmit={(e) => {
              e.preventDefault();
              const v = text.trim();
              if (v) tryRun.mutate(v);
            }}
          >
            <TextField value={text} onChange={setText} maxLength={500} placeholder={t("showcase.tryPlaceholder")} aria-label={t("showcase.tryLabel")} />
            <Button type="submit" loading={tryRun.isPending} disabled={!text.trim()}>
              {t("showcase.try")}
            </Button>
          </form>
        </ToolStrip>
      }
      status={
        <StatusBar end={<ZoomControl api={api} presets={["fit", "actual"]} />}>
          <span>{rev === 0 ? t("status.base") : changeCount === null ? revLabel(rev) : t("status.changes", { from: revLabel(rev - 1), to: revLabel(rev), count: changeCount })}</span>
          <span className="ol-sb-ara" aria-hidden="true">
            ·
          </span>
          <span>{t("status.free")}</span>
          <span className="ol-sb-ara" aria-hidden="true">
            ·
          </span>
          <span>{t("status.cost", { cost: formatUsd(costUsd), budget: formatUsd(budgetUsd) })}</span>
        </StatusBar>
      }
    >
      {tryRun.isError && (
        <p className="ol-dene-hata" role="alert">
          {hataMetni(tryRun.error)}
        </p>
      )}
      <CanvasViewport api={api} rulers overlay={overlay}>
        {trySide && tried && (
          <Kutu
            box={boxes.find((b) => b.id === TRY_ID)!}
            title={t("showcase.yourText")}
            size={null}
            changed={false}
            below={<span className="ol-alti">{tried.text}</span>}
            image={<LabelImage src={trySide.previewUrl} widthMm={DEFAULT_LABEL_MM} heightMm={DEFAULT_LABEL_MM} alt={t("showcase.alt", { text: tried.text })} dimmed={!!running} />}
          />
        )}
        {items.map((it) => {
          const box = boxes.find((b) => b.id === it.id)!;
          const note = it.changed && it.note.length > 0 ? notMetni(it.note) : null;
          return (
            <Kutu
              key={it.id}
              box={box}
              title={it.labelType ? t(`labelType.${it.labelType}`) : it.sampleId ? t("showcase.fromSample") : t("showcase.example")}
              size={olcuMetni(it.sizeMm)}
              changed={it.changed}
              below={
                it.error ? (
                  <span className="ol-alti is-hata">{t("showcase.itemFailed")}</span>
                ) : note ? (
                  <span className="ol-chg-t">{note}</span>
                ) : it.changed ? (
                  <span className="ol-chg-t">{t("showcase.changed")}</span>
                ) : null
              }
              image={
                it.error ? (
                  <span className="ol-yok" style={{ width: `calc(${box.w} * var(--tz-mm))`, height: `calc(${box.h} * var(--tz-mm))` }} />
                ) : (
                  <LabelImage src={it.previewUrl} widthMm={box.w} heightMm={box.h} alt={t("showcase.alt", { text: it.text })} dimmed={!!running} />
                )
              }
            />
          );
        })}
      </CanvasViewport>
    </CenterColumn>
  );
}

function Kutu({
  box,
  title,
  size,
  changed,
  below,
  image,
}: {
  box: { x: number; y: number; w: number; h: number };
  title: string;
  size: string | null;
  changed: boolean;
  below: React.ReactNode;
  image: React.ReactNode;
}) {
  return (
    <Artboard
      x={box.x}
      y={box.y}
      w={box.w}
      h={box.h}
      selected={changed}
      name={
        <>
          <b>{title}</b>
          {size && <span>{` · ${size}`}</span>}
        </>
      }
      below={below}
    >
      {image}
    </Artboard>
  );
}
