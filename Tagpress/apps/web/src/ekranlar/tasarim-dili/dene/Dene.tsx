import { API, type ProfileTryRequest, type ProfileTryResponse, type Reference } from "@tagpress/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMm, formatUsd } from "../../../i18n/bicim.ts";
import { serverText } from "../../../i18n/sunucu.ts";
import { api, ApiFailure, goToConnections, path } from "../../../lib/api.ts";
import { TemplatePicker } from "../../../ortak/index.ts";
import { type Comparison, compareSides, type SideLines } from "../mantik/compare.ts";
import { isNotConnected } from "../mantik/contract.ts";
import { useReferences, useWork } from "../mantik/work.tsx";
import {
  Artboard,
  Button,
  CanvasViewport,
  CenterColumn,
  Checkbox,
  EmptyState,
  IconButton,
  IssueBadge,
  IssueBox,
  Panel,
  PanelSection,
  Popover,
  SearchField,
  Segmented,
  SelectionBox,
  StatusBar,
  StatusDot,
  Tag,
  TextField,
  ToolLabel,
  ToolSpacer,
  ToolStrip,
  Tooltip,
  useConfirm,
  useViewport,
  Workspace,
  ZoomControl,
} from "../../../tezgah/index.ts";
import { LabelImage } from "../../../ortak/index.ts";
import { pct } from "../dil.ts";
import { labelMm, RefGorsel } from "../ornekler/RefGorsel.tsx";
import { useRefMeta } from "../ornekler/Ornekler.tsx";
import "./dene.css";

type TrialMode = "engine" | "ai";
type Sample = ProfileTryRequest["samples"][number];
type Side = NonNullable<ProfileTryResponse["results"][number]["published"]>;

interface FreeSample {
  id: string;
  text: string;
  templateKey: string | null;
}
interface SetState {
  refIds: string[];
  free: FreeSample[];
}

// Deneme kümesi tarayıcıda dil başına saklanır (bugünkü anahtarla; eski ekranla ortak).
const storeKey = (lang: string) => `studio.dene.${lang}`;
function loadSet(lang: string): SetState {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(lang)) ?? "null") as Partial<SetState> | null;
    return { refIds: Array.isArray(raw?.refIds) ? raw.refIds : [], free: Array.isArray(raw?.free) ? raw.free : [] };
  } catch {
    return { refIds: [], free: [] };
  }
}

const refSide = (r: Reference): SideLines => ({ lines: r.user.map((l) => l.text), sizesPx: r.user.map((l) => l.sizePx) });
/** Karşılaştırma gerçekten fark gösteriyor mu (satır bölmesi ya da %0,5'ten büyük boyut farkı)? */
const differs = (c: Comparison | null) => !!c && (!c.sameBreaks || (c.sizeDiff !== null && c.sizeDiff >= 0.005));

/** Tuval yerleşimi (mm). */
const GAP = 16;
const TITLE = 12;
const ROW_GAP = 30;

interface Ran {
  response: ProfileTryResponse;
  rules: string;
  withDraft: boolean;
  mode: TrialMode;
  samples: Sample[];
}

/**
 * Dene: solda deneme kümesi (bitmiş etiketler ve serbest metin) ve yöntem (Motor ücretsiz / AI ücretli); ortada her örnek
 * için yayınlanmış sürüm, taslak ve örneğin son hâli yan yana, taslağın farkları işaretli. AI denemesinde tahmini maliyet
 * düğmenin üstünde yazar ve tıklayınca bir kez onay istenir.
 */
export default function Dene() {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const refs = useReferences(w.languageId);
  const confirm = useConfirm();
  const [set, setSet] = useState<SetState>(() => loadSet(w.languageId));
  const [text, setText] = useState("");
  const [tpl, setTpl] = useState<string | null>(null);
  // Varsayılan ücretsiz motor: para harcayan AI denemesi bilerek seçilir.
  const [mode, setMode] = useState<TrialMode>("engine");
  const [ran, setRan] = useState<Ran | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey(w.languageId), JSON.stringify(set));
    } catch {
      /* gizli pencere */
    }
  }, [set, w.languageId]);

  const refList = useMemo(() => refs.data ?? [], [refs.data]);
  const samples: Sample[] = useMemo(() => {
    const fromRefs = set.refIds.flatMap((id) => {
      const r = refList.find((x) => x.id === id);
      return r ? [{ id: `ref:${r.id}`, text: r.text, templateKey: r.templateKey, labelSize: null, referenceId: r.id }] : [];
    });
    return [...fromRefs, ...set.free.map((f) => ({ id: `free:${f.id}`, text: f.text, templateKey: f.templateKey, labelSize: null, referenceId: null }))];
  }, [set, refList]);

  const profiles: Array<"published" | "draft"> = w.hasDraft ? ["published", "draft"] : ["published"];
  const sampleKey = samples.map((s) => `${s.id}|${s.templateKey ?? ""}|${s.text}`).join("\n");
  const trialUrl = path(API.profileTry, { lang: w.languageId });

  // Tahmin (dryRun) ücretsizdir ve anahtar istemez; yalnız AI seçiliyken sorulur.
  const estimate = useQuery({
    queryKey: ["trialEstimate", w.languageId, sampleKey, profiles.join()],
    queryFn: () => api.post<ProfileTryResponse>(trialUrl, { samples, profiles, dryRun: true, mode: "ai" } satisfies ProfileTryRequest),
    enabled: samples.length > 0 && mode === "ai",
    retry: false,
    staleTime: 60_000,
  });
  const estimateUsd = estimate.data?.estimateUsd ?? null;

  const run = useMutation({
    mutationFn: async (m: TrialMode) => {
      await w.flush();
      const rules = JSON.stringify(w.value);
      const response = await api.post<ProfileTryResponse>(trialUrl, { samples, profiles, mode: m } satisfies ProfileTryRequest);
      return { response, rules, withDraft: w.hasDraft, mode: m, samples };
    },
    onSuccess: setRan,
  });
  const failure = run.error instanceof ApiFailure ? run.error : null;
  const missingKey = failure?.body.code === "missing-key";
  const notConnected = (mode === "ai" && estimate.error instanceof ApiFailure && isNotConnected(estimate.error.status)) || (!!failure && isNotConnected(failure.status));
  const stale = !!ran && ran.rules !== JSON.stringify(w.value);

  const addFree = () => {
    const v = text.trim();
    if (!v) return;
    setSet((s) => ({ ...s, free: [...s.free, { id: Math.random().toString(36).slice(2, 8), text: v, templateKey: tpl }] }));
    setText("");
  };
  const remove = (s: Sample) =>
    setSet((cur) => (s.referenceId ? { ...cur, refIds: cur.refIds.filter((x) => x !== s.referenceId) } : { ...cur, free: cur.free.filter((f) => `free:${f.id}` !== s.id) }));

  const start = async () => {
    if (mode === "ai") {
      // Önce maliyet, sonra onay: para harcayan çağrı onaysız gitmez.
      const ok = await confirm({
        title: t("dene.confirm.title"),
        body: (
          <div className="td-dn-onay">
            <p>{w.hasDraft ? t("dene.confirm.both", { count: samples.length }) : t("dene.confirm.one", { count: samples.length })}</p>
            <p>{estimateUsd !== null ? t("dene.confirm.cost", { cost: formatUsd(estimateUsd, { approx: true }) }) : t("dene.confirm.noCost")}</p>
          </div>
        ),
        confirmLabel: t("dene.confirm.ok"),
      });
      if (!ok) return;
    }
    run.mutate(mode);
  };

  const costLine =
    mode === "engine"
      ? t("dene.free")
      : estimate.isLoading
        ? t("dene.estimating")
        : estimateUsd !== null
          ? w.hasDraft
            ? t("dene.estimateBoth", { cost: formatUsd(estimateUsd, { approx: true }), count: samples.length })
            : t("dene.estimateOne", { cost: formatUsd(estimateUsd, { approx: true }), count: samples.length })
          : notConnected
            ? t("dene.estimateNotConnected")
            : t("dene.noEstimate");

  const runLabel = mode === "engine" ? (w.hasDraft ? t("dene.runEngineDraft") : t("dene.runEngine")) : w.hasDraft ? t("dene.runAiDraft") : t("dene.runAi");

  return (
    <Workspace
      leftWidth={300}
      left={
        <Panel
          side="left"
          title={t("dene.set")}
          count={samples.length}
          actions={<RefPicker refs={refList} selected={set.refIds} onChange={(refIds) => setSet((s) => ({ ...s, refIds }))} />}
          footer={
            <div className="td-dn-alt">
              <Segmented<TrialMode>
                aria-label={t("dene.method")}
                value={mode}
                onChange={setMode}
                options={[
                  { value: "engine", label: t("dene.engine") },
                  { value: "ai", label: t("dene.ai") },
                ]}
              />
              {mode === "engine" ? (
                <Tooltip content={t("dene.engineNote")}>
                  <p className="td-mut td-dn-maliyet" aria-live="polite">
                    {costLine}
                  </p>
                </Tooltip>
              ) : (
                <p className="td-mut td-dn-maliyet" aria-live="polite">
                  {costLine}
                </p>
              )}
              {missingKey && (
                <IssueBox
                  tone="warn"
                  fixes={
                    <Button size="mini" onClick={goToConnections}>
                      {t("common:actions.goToConnections")}
                    </Button>
                  }
                >
                  {serverText(run.error)}
                </IssueBox>
              )}
              {notConnected && <IssueBox tone="info">{t("dene.notConnected")}</IssueBox>}
              {run.isError && !missingKey && !notConnected && <IssueBox tone="error">{t("dene.failed", { message: serverText(run.error) })}</IssueBox>}
              <Button need="spend" variant="primary" size="page" wide loading={run.isPending} disabled={samples.length === 0 || notConnected} onClick={() => void start()}>
                {runLabel}
              </Button>
            </div>
          }
        >
          {samples.length === 0 ? (
            <p className="td-dn-bos">{t("dene.setEmpty")}</p>
          ) : (
            <ul className="td-dn-liste" aria-label={t("dene.set")}>
              {samples.map((s) => (
                <SampleRow key={s.id} sample={s} reference={s.referenceId ? refList.find((r) => r.id === s.referenceId) : undefined} onRemove={() => remove(s)} />
              ))}
            </ul>
          )}
          <PanelSection heading={t("dene.addFree")}>
            <form
              className="td-dn-ekle"
              onSubmit={(e) => {
                e.preventDefault();
                addFree();
              }}
            >
              <TextField value={text} onChange={setText} placeholder={t("dene.freePlaceholder")} aria-label={t("dene.freeLabel")} />
              <div className="td-dn-satir">
                <TemplatePicker
                  languageId={w.languageId}
                  value={tpl}
                  onChange={setTpl}
                  allowClear
                  trigger={(p) => (
                    <Button {...p} icon="tag" className="td-dn-sablon">
                      {tpl ?? t("dene.pickTemplate")}
                    </Button>
                  )}
                />
                <Button type="submit" disabled={!text.trim()}>
                  {t("dene.add")}
                </Button>
              </div>
            </form>
          </PanelSection>
        </Panel>
      }
    >
      <Sonuclar ran={ran} pending={run.isPending} stale={stale} hasSamples={samples.length > 0} refList={refList} />
    </Workspace>
  );
}

function SampleRow({ sample, reference, onRemove }: { sample: Sample; reference: Reference | undefined; onRemove: () => void }) {
  const { t } = useTranslation("designLanguageLab");
  const tplText = sample.templateKey ?? t("dene.noTemplate");
  return (
    <li className="td-dn-ornek">
      {reference ? <RefGorsel reference={reference} mm={9.5} /> : <span className="td-dn-yer" aria-hidden="true" />}
      <span className="td-dn-ad">
        <b title={sample.text}>{sample.text}</b>
        <small>{reference ? t("dene.fromRef", { template: tplText }) : t("dene.fromFree", { template: tplText })}</small>
      </span>
      <IconButton icon="x" size={26} label={t("dene.remove", { text: sample.text })} onClick={onRemove} />
    </li>
  );
}

/** "Örnek seç": bitmiş etiketlerden aramalı, çok seçimli liste. */
function RefPicker({ refs, selected, onChange }: { refs: Reference[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation("designLanguageLab");
  const meta = useRefMeta();
  const [q, setQ] = useState("");
  const term = q.trim().toLocaleLowerCase("tr");
  const list = refs.filter((r) => !term || `${r.text} ${r.orderNo ?? ""} ${r.templateKey ?? ""}`.toLocaleLowerCase("tr").includes(term)).slice(0, 80);
  return (
    <Popover
      align="end"
      width={380}
      trigger={(p) => (
        <Button {...p} size="mini">
          {t("dene.pick")}
        </Button>
      )}
    >
      {() => (
        <div className="td-dn-sec">
          <SearchField value={q} onChange={setQ} placeholder={t("dene.pickSearch")} aria-label={t("dene.pickSearch")} autoFocus />
          {refs.length === 0 ? (
            <p className="td-dn-bos">{t("dene.pickNone")}</p>
          ) : list.length === 0 ? (
            <p className="td-dn-bos">{t("dene.pickNoMatch")}</p>
          ) : (
            <ul>
              {list.map((r) => {
                const on = selected.includes(r.id);
                return (
                  <li key={r.id}>
                    <Checkbox checked={on} label={r.text} onChange={() => onChange(on ? selected.filter((x) => x !== r.id) : [...selected, r.id])} />
                    {meta(r) && <small>{meta(r)}</small>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Popover>
  );
}

/** Ortadaki tuval: her örnek bir satır; sütunlar yayınlanmış, taslak, son hâl. */
function Sonuclar({ ran, pending, stale, hasSamples, refList }: { ran: Ran | null; pending: boolean; stale: boolean; hasSamples: boolean; refList: Reference[] }) {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const mm = labelMm(w.value);
  const rows = ran?.samples ?? [];
  const withRef = rows.some((s) => s.referenceId);
  const cols = 1 + (ran?.withDraft ? 1 : 0) + (withRef ? 1 : 0);
  const world = useMemo(() => ({ x: 0, y: -TITLE, w: Math.max(1, cols * (mm + GAP) - GAP), h: Math.max(1, rows.length * (mm + TITLE + ROW_GAP) - ROW_GAP) }), [cols, rows.length, mm]);
  const api = useViewport({ world });
  // Sonuç yokken sığdırma yapılmaz (boş dünyada anlamsız yakınlaştırma çıkıyordu).
  useEffect(() => {
    if (ran) api.fit(world);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sığdırma yalnız dünya ölçüsü değişince; api ve world nesnesi her çizimde yeni, kullanıcının yakınlaştırması bozulmasın
  }, [ran, world.w, world.h]);

  const overlay = !hasSamples ? (
    <div className="td-cv-msg">
      <EmptyState icon="spark" title={t("dene.emptyTitle")} body={t("dene.emptyBody")} />
    </div>
  ) : !ran ? (
    <div className="td-cv-msg">{pending ? <StatusDot tone="busy" label={t("dene.running")} /> : <EmptyState icon="spark" title={t("dene.notRun")} body={t("dene.notRunBody")} />}</div>
  ) : undefined;

  const version = w.active?.version ?? null;
  return (
    <CenterColumn
      strip={
        <ToolStrip label={t("dene.results")}>
          <ToolLabel>{t("dene.results")}</ToolLabel>
          {ran && <span className="td-mut">{ran.mode === "engine" ? t("dene.byEngine") : t("dene.byAi", { cost: formatUsd(ran.response.costUsd) })}</span>}
          {pending && ran && <StatusDot tone="busy" label={t("dene.running")} />}
          <ToolSpacer />
          {stale && <StatusDot tone="warn" label={t("dene.stale")} />}
        </ToolStrip>
      }
      status={
        ran ? (
          <StatusBar end={<ZoomControl api={api} presets={["fit", "actual"]} />}>
            <span>{t("dene.status", { count: rows.length, mm: formatMm(mm) })}</span>
          </StatusBar>
        ) : undefined
      }
    >
      <CanvasViewport api={api} overlay={overlay}>
        {ran &&
          rows.map((s, i) => {
            const y = i * (mm + TITLE + ROW_GAP);
            const r = ran.response.results.find((x) => x.sampleId === s.id);
            const reference = s.referenceId ? refList.find((x) => x.id === s.referenceId) : undefined;
            const ref = reference ? refSide(reference) : null;
            const pub = r?.published ?? null;
            const dr = r?.draft ?? null;
            const cDraft = pub && dr ? compareSides(dr, pub) : null;
            let col = 0;
            const x = () => col++ * (mm + GAP);
            return (
              <Fragment key={s.id}>
                <Artboard
                  x={0}
                  y={y - TITLE}
                  name={
                    <>
                      <b>{s.text}</b>
                      <span>{s.templateKey ?? t("dene.noTemplate")}</span>
                    </>
                  }
                >
                  {null}
                </Artboard>
                {!r || r.error ? (
                  <Artboard
                    x={x()}
                    y={y}
                    w={mm}
                    h={mm}
                    name={<span>{version ? t("dene.published", { version }) : t("dene.publishedNoVersion")}</span>}
                    below={<span className="td-dn-neden">{r?.error ? serverText(new Error(r.error)) : t("dene.noResult")}</span>}
                  >
                    <span className="td-dn-hata" style={{ width: `calc(${mm} * var(--tz-mm))`, height: `calc(${mm} * var(--tz-mm))` }} />
                  </Artboard>
                ) : (
                  <>
                    <Yan x={x()} y={y} mm={mm} title={version ? t("dene.published", { version }) : t("dene.publishedNoVersion")} side={pub} alt={t("dene.altPublished", { text: s.text })} dimmed={pending} diffs={[{ label: t("dene.vsRef"), c: ref && pub ? compareSides(pub, ref) : null }]} />
                    {ran.withDraft && (
                      <Yan
                        x={x()}
                        y={y}
                        mm={mm}
                        title={t("dene.draft")}
                        side={dr}
                        alt={t("dene.altDraft", { text: s.text })}
                        dimmed={pending}
                        marked={differs(cDraft)}
                        diffs={[
                          { label: t("dene.vsPublished"), c: cDraft },
                          { label: t("dene.vsRef"), c: ref && dr ? compareSides(dr, ref) : null },
                        ]}
                      />
                    )}
                  </>
                )}
                {reference && (
                  <Artboard x={(cols - 1) * (mm + GAP)} y={y} w={mm} h={mm} name={<span>{t("dene.final")}</span>} below={<span className="td-dn-alti">{t("lines", { count: reference.user.length })}</span>}>
                    <RefGorsel reference={reference} mm={mm} />
                  </Artboard>
                )}
              </Fragment>
            );
          })}
      </CanvasViewport>
    </CenterColumn>
  );
}

/** Bir sütun: önizleme, altında satır ve sorun sayısı ve farklar. `marked`: yayınlanmıştan farklı (mor çerçeve). */
function Yan({ x, y, mm, title, side, alt, dimmed, marked, diffs }: { x: number; y: number; mm: number; title: string; side: Side | null; alt: string; dimmed: boolean; marked?: boolean; diffs: Array<{ label: string; c: Comparison | null }> }) {
  const { t } = useTranslation("designLanguageLab");
  const shown = diffs.filter((d): d is { label: string; c: Comparison } => !!d.c);
  return (
    <Artboard
      x={x}
      y={y}
      w={mm}
      h={mm}
      selected={marked}
      name={<span>{title}</span>}
      below={
        side ? (
          <span className="td-dn-alti">
            <span>{side.issues ? t("lines", { count: side.lines.length }) : t("dene.linesOk", { count: side.lines.length })}</span>
            {side.issues > 0 && <IssueBadge tone="warn">{t("dene.issues", { count: side.issues })}</IssueBadge>}
            {shown.map((d) => (
              <span key={d.label} className="td-dn-fark">
                <small>{d.label}</small>
                <Tag>{d.c.sameBreaks ? t("dene.sameBreaks") : t("dene.diffBreaks")}</Tag>
                {d.c.sizeDiff !== null && <Tag>{d.c.sizeDiff < 0.005 ? t("dene.sameSize") : t("dene.sizeDiff", { pct: pct(d.c.sizeDiff) })}</Tag>}
              </span>
            ))}
          </span>
        ) : (
          <span className="td-dn-neden">{t("dene.notProduced")}</span>
        )
      }
    >
      {side ? (
        <LabelImage src={side.previewUrl} widthMm={mm} heightMm={mm} alt={alt} dimmed={dimmed} />
      ) : (
        <span className="td-dn-hata" style={{ width: `calc(${mm} * var(--tz-mm))`, height: `calc(${mm} * var(--tz-mm))` }} />
      )}
      {marked && <SelectionBox rect={{ x: 0, y: 0, w: mm, h: mm }} />}
    </Artboard>
  );
}
