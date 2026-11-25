import { API, type LearnProposal, type LearnRunStatus, type Reference } from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../../i18n/index.ts";
import { serverText } from "../../../i18n/sunucu.ts";
import { api, path } from "../../../lib/api.ts";
import { LabelImage } from "../../../ortak/index.ts";
import { describeChange } from "../mantik/diffView.ts";
import { type AdjustEvidenceView, type MetricView, metricVerdict, proposalChanges, readAdjustEvidence, readEvidence, shiftText } from "../mantik/learnRead.ts";
import { useProposals, useReferences, useWork } from "../mantik/work.tsx";
import {
  Artboard,
  Button,
  CanvasDock,
  CanvasViewport,
  CenterColumn,
  CollapsedGroup,
  EmptyState,
  Icon,
  IconButton,
  IssueBadge,
  ListRow,
  Panel,
  PanelSection,
  StatusBar,
  StatusDot,
  Tabs,
  Tag,
  useToast,
  useViewport,
  Workspace,
  ZoomControl,
} from "../../../tezgah/index.ts";
import { num, pct } from "../dil.ts";
import { labelMm, RefGorsel } from "../ornekler/RefGorsel.tsx";
import "./ogren.css";

type Filter = "open" | "accepted" | "rejected";
const FILTERS: Filter[] = ["open", "accepted", "rejected"];
const GAP = 14;

interface TemplateEntry {
  key: string;
  field: string;
  from: unknown;
  to: unknown;
}

/** Önerinin şablon değişiklikleri (`{ target: "template", key, field, from, to }`). */
function templateEntries(patch: unknown): TemplateEntry[] {
  if (!Array.isArray(patch)) return [];
  return patch.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const e = x as Record<string, unknown>;
    if (e.target !== "template" || typeof e.key !== "string" || typeof e.field !== "string") return [];
    return [{ key: e.key, field: e.field, from: e.from ?? null, to: e.to ?? null }];
  });
}

/** Koşunun önce/sonra görselleri (`evidence.previews: [{ referenceId, url }]`; her biri [son hâl | önce | sonra]). */
function readPreviews(evidence: unknown): Array<{ referenceId: string; url: string }> {
  const list = evidence && typeof evidence === "object" ? (evidence as { previews?: unknown }).previews : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => (p && typeof p === "object" && typeof (p as { url?: unknown }).url === "string" ? [{ referenceId: String((p as { referenceId?: unknown }).referenceId ?? ""), url: (p as { url: string }).url }] : []));
}

/** Sunucunun Türkçe ilerleme cümlesi: TR'de olduğu gibi, EN'de genel karşılığı (kod gelmiyor). */
const serverNote = (msg: string | null | undefined, fallback: string) => (currentLocale() === "tr" && msg ? msg : fallback);

/**
 * Öğren: düzeltmelerinizden çıkan öneriler. Solda liste (Bekleyen, Uygulanan, Reddedilen) ve "Önerileri yeniden hesapla"
 * (ücretsiz); ortada önce/sonra görselleri ve test kümesindeki ölçüler; sağda değişecek alanlar, dayanağı, Reddet ve
 * "Taslağa uygula". Uygulanan ya da reddedilen öneri geri alınabilir. Onaylamadan hiçbir şey değişmez.
 */
export default function Ogren({ onGo }: { onGo: (section: "dene" | "ornekler") => void }) {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const props = useProposals(w.languageId);
  const [filter, setFilter] = useState<Filter>("open");
  const [sel, setSel] = useState<string | null>(null);
  const all = useMemo(() => props.data ?? [], [props.data]);
  const list = useMemo(() => all.filter((p) => p.status === filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [all, filter]);
  const counts: Record<Filter, number> = { open: 0, accepted: 0, rejected: 0 };
  for (const p of all) counts[p.status]++;
  const current = list.find((p) => p.id === sel) ?? list[0] ?? null;

  const left = (
    <Panel side="left" title={t("ogren.title")} actions={<RunButton languageId={w.languageId} />} footer={<RunStatus languageId={w.languageId} />}>
      {props.isLoading ? (
        <p className="td-og-not">
          <StatusDot tone="busy" label={t("ogren.loading")} />
        </p>
      ) : props.isError ? (
        <EmptyState icon="warn" title={t("ogren.loadFailed")} body={serverText(props.error)} action={<Button onClick={() => void props.refetch()}>{t("ogren.retry")}</Button>} />
      ) : (
        <>
          <div className="td-og-sekme">
            <Tabs label={t("ogren.filterLabel")} value={filter} onChange={(v) => setFilter(v as Filter)} items={FILTERS.map((f) => ({ id: f, label: t(`ogren.filter.${f}`), count: counts[f] }))} />
          </div>
          {list.length === 0 ? (
            // Hiç öneri yokken tek boş metin ortada; burada yalnız süzgeçte boş kalınca kısa not.
            all.length > 0 && <p className="td-og-not">{filter === "open" ? t("ogren.noneOpen") : t("ogren.noneHere")}</p>
          ) : (
            <nav aria-label={t("ogren.listLabel")}>
              {list.map((p) => (
                <ListRow key={p.id} title={p.title} sub={<ListSub proposal={p} />} current={p.id === current?.id} onClick={() => setSel(p.id)} />
              ))}
            </nav>
          )}
        </>
      )}
    </Panel>
  );

  if (!props.isLoading && !props.isError && all.length === 0) {
    return (
      <Workspace leftWidth={280} left={left}>
        <CenterColumn>
          <div className="td-og-bos">
            <EmptyState
              icon="spark"
              title={t("ogren.empty")}
              action={
                <Button variant="primary" title={t("ogren.emptyBody")} onClick={() => onGo("ornekler")}>
                  {t("ogren.toExamples")}
                </Button>
              }
            />
          </div>
        </CenterColumn>
      </Workspace>
    );
  }

  return (
    <Workspace leftWidth={280} rightWidth={330} left={left} right={current ? <Ayrinti key={current.id} proposal={current} onTry={() => onGo("dene")} /> : undefined}>
      {current ? (
        <OnceSonra proposal={current} />
      ) : (
        <CenterColumn>
          <div className="td-og-bos">
            <EmptyState icon="cursor" title={t("ogren.pick")} />
          </div>
        </CenterColumn>
      )}
    </Workspace>
  );
}

function ListSub({ proposal }: { proposal: LearnProposal }) {
  const { t } = useTranslation("designLanguageLab");
  const adjust = readAdjustEvidence(proposal.evidence);
  if (adjust) return <>{t("ogren.list.adjust", { count: adjust.samples })}</>;
  const ev = readEvidence(proposal.evidence);
  return ev.count !== null ? <>{t("ogren.list.count", { count: ev.count })}</> : null;
}

/** Başlıktaki "Önerileri yeniden hesapla": ücretsiz motor koşusu (AI yok); ilerleme sunucudan izlenir. */
function useLearnRun(languageId: string) {
  return useQuery({
    queryKey: ["learnRun", languageId],
    queryFn: () => api.get<LearnRunStatus | null>(path(API.learnRun, { lang: languageId })),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });
}

function RunButton({ languageId }: { languageId: string }) {
  const { t } = useTranslation("designLanguageLab");
  const toast = useToast();
  const run = useLearnRun(languageId);
  const [starting, setStarting] = useState(false);
  const running = run.data?.status === "running";
  const start = async () => {
    setStarting(true);
    try {
      await api.post(path(API.learnRun, { lang: languageId }), { base: "published" });
      await run.refetch();
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    } finally {
      setStarting(false);
    }
  };
  return <IconButton icon="refresh" size={28} label={t("ogren.run.start")} disabled={starting || running} onClick={() => void start()} />;
}

function RunStatus({ languageId }: { languageId: string }) {
  const { t } = useTranslation("designLanguageLab");
  const qc = useQueryClient();
  const run = useLearnRun(languageId);
  const status = run.data ?? null;
  const seen = useRef<string | null>(status && status.status !== "running" ? status.id : null);
  // Koşu bitince öneriler yeniden okunur.
  useEffect(() => {
    if (!status || status.status === "running" || seen.current === status.id) return;
    seen.current = status.id;
    void qc.invalidateQueries({ queryKey: ["proposals"] });
  }, [status, qc]);
  const text =
    status?.status === "running"
      ? serverNote(status.message, t("ogren.run.running"))
      : status?.status === "failed"
        ? t("ogren.run.failed", { error: status.error ? serverText(new Error(status.error)) : t("ogren.run.unknown") })
        : status?.status === "done"
          ? serverNote(status.message, t("ogren.run.done"))
          : t("ogren.run.idle");
  return (
    <p className="td-og-kosu" role="status" aria-live="polite">
      {status?.status === "running" ? <StatusDot tone="busy" label={text} /> : text}
    </p>
  );
}

/** Ortada: önce/sonra görselleri (yoksa elle düzeltilmiş varyasyonlar ya da örnekler) ve altta ölçüm kutusu. */
function OnceSonra({ proposal }: { proposal: LearnProposal }) {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const refs = useReferences(w.languageId);
  const mm = labelMm(w.value);
  const evidence = useMemo(() => readEvidence(proposal.evidence), [proposal.evidence]);
  const adjust = useMemo(() => readAdjustEvidence(proposal.evidence), [proposal.evidence]);
  const previews = useMemo(() => readPreviews(proposal.evidence).slice(0, 4), [proposal.evidence]);
  const variants = (adjust?.variants ?? []).filter((v): v is { variantId: string; url: string } => !!v.url).slice(0, 4);
  const examples = evidence.exampleIds
    .map((id) => refs.data?.find((r) => r.id === id))
    .filter((r): r is Reference => !!r)
    .slice(0, 4);

  // Önce/sonra görseli üç panellidir (son hâl | önce | sonra): genişliği üç etiket kadar.
  const pw = 3 * mm + 8;
  const ph = mm + 6;
  const kind: "previews" | "variants" | "examples" | "none" = previews.length ? "previews" : variants.length ? "variants" : examples.length ? "examples" : "none";
  const n = kind === "previews" ? previews.length : kind === "variants" ? variants.length : examples.length;
  const world = useMemo(
    () => (kind === "previews" ? { x: 0, y: 0, w: pw, h: Math.max(1, n * (ph + 24) - 24) } : { x: 0, y: 0, w: Math.max(1, n * (mm + GAP) - GAP), h: mm }),
    [kind, n, pw, ph, mm],
  );
  const api2 = useViewport({ world });
  useEffect(() => {
    api2.fit(world);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sığdırma yalnız öneri ya da dünya ölçüsü değişince; api2 ve world nesnesi her çizimde yeni, kullanıcının yakınlaştırması bozulmasın
  }, [proposal.id, world.w, world.h]);

  const refName = (id: string) => refs.data?.find((r) => r.id === id)?.text ?? "";
  const heldLabel = adjust ? t("ogren.metrics.heldAdjust") : t("ogren.metrics.held");

  return (
    <CenterColumn
      status={
        <StatusBar end={<ZoomControl api={api2} presets={["fit", "actual"]} />}>
          <span>{kind === "previews" ? t("ogren.canvas.previews") : kind === "variants" ? t("ogren.canvas.variants") : kind === "examples" ? t("ogren.canvas.examples") : t("ogren.canvas.none")}</span>
        </StatusBar>
      }
    >
      <CanvasViewport
        api={api2}
        overlay={
          <>
            {kind === "none" && (
              <div className="td-cv-msg td-cv-msg--ust">
                <EmptyState icon="img" title={t("ogren.canvas.noneTitle")} />
              </div>
            )}
            <CanvasDock>
              <div className="td-og-olcu">
                {evidence.heldOut.length > 0 ? (
                  <>
                    <h3>{heldLabel}</h3>
                    <MetricTable metrics={evidence.heldOut} />
                  </>
                ) : (
                  <p className="td-mut">{adjust ? t("ogren.metrics.noneAdjust") : t("ogren.metrics.none")}</p>
                )}
              </div>
            </CanvasDock>
          </>
        }
      >
        {kind === "previews" &&
          previews.map((p, i) => (
            <Artboard key={p.url} x={0} y={i * (ph + 24)} w={pw} h={ph} name={<span>{refName(p.referenceId) ? t("ogren.canvas.previewOf", { text: refName(p.referenceId) }) : t("ogren.canvas.preview")}</span>}>
              <LabelImage src={p.url} widthMm={pw} heightMm={ph} alt={t("ogren.canvas.previewAlt")} />
            </Artboard>
          ))}
        {kind === "variants" &&
          variants.map((v, i) => (
            <Artboard key={v.variantId} x={i * (mm + GAP)} y={0} w={mm} h={mm} name={<span>{t("ogren.canvas.variant", { n: i + 1 })}</span>}>
              <LabelImage src={v.url} widthMm={mm} heightMm={mm} alt={t("ogren.canvas.variantAlt")} />
            </Artboard>
          ))}
        {kind === "examples" &&
          examples.map((r, i) => (
            <Artboard key={r.id} x={i * (mm + GAP)} y={0} w={mm} h={mm} name={<span>{r.text}</span>}>
              <RefGorsel reference={r} mm={mm} />
            </Artboard>
          ))}
      </CanvasViewport>
    </CenterColumn>
  );
}

function fmtMetric(m: MetricView, v: number): string {
  return m.percent ? pct(v) : num(v, 2);
}

function MetricTable({ metrics }: { metrics: MetricView[] }) {
  const { t } = useTranslation("designLanguageLab");
  return (
    <table className="td-og-tablo">
      <thead>
        <tr>
          <th scope="col">{t("ogren.metrics.metric")}</th>
          <th scope="col">{t("ogren.metrics.before")}</th>
          <th scope="col">{t("ogren.metrics.after")}</th>
          <th scope="col">
            <span className="td-sr">{t("ogren.metrics.verdict")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((m) => {
          const v = metricVerdict(m);
          return (
            <tr key={m.key}>
              <th scope="row">{m.label}</th>
              <td className="td-mono">{fmtMetric(m, m.before)}</td>
              <td className="td-mono">
                <b>{fmtMetric(m, m.after)}</b>
              </td>
              <td>{v === "worse" ? <IssueBadge tone="warn">{t("ogren.verdict.worse")}</IssueBadge> : <Tag tone={v === "better" ? "info" : "neutral"}>{t(`ogren.verdict.${v}`)}</Tag>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Sağ panel: değişecek alanlar, dayanağı, öğrenme örneklerindeki ölçü; altta Reddet ve "Taslağa uygula" ya da Geri al. */
function Ayrinti({ proposal, onTry }: { proposal: LearnProposal; onTry: () => void }) {
  const { t } = useTranslation("designLanguageLab");
  const w = useWork();
  const qc = useQueryClient();
  const toast = useToast();
  const refs = useReferences(w.languageId);
  const [busy, setBusy] = useState<"apply" | "reject" | "revert" | null>(null);
  const open = proposal.status === "open";
  const templateChanges = useMemo(() => templateEntries(proposal.patch), [proposal.patch]);
  const changes = useMemo(() => proposalChanges(proposal.patch, w.value, { keepSame: !open }), [proposal.patch, w.value, open]);
  const evidence = useMemo(() => readEvidence(proposal.evidence), [proposal.evidence]);
  const adjust = useMemo(() => readAdjustEvidence(proposal.evidence), [proposal.evidence]);
  const examples = evidence.exampleIds
    .map((id) => refs.data?.find((r) => r.id === id))
    .filter((r): r is Reference => !!r)
    .slice(0, 4);
  const nothing = changes.length === 0 && templateChanges.length === 0;
  const fieldLabel = (field: string) => (field === "textCenter" ? t("ogren.field.textCenter") : field);
  const fmtValue = (v: unknown): string => {
    if (v === null || v === undefined) return t("ogren.field.unset");
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.x === "number" && typeof o.y === "number") return t("ogren.field.point", { x: num(o.x, 3), y: num(o.y, 3) });
      return JSON.stringify(v);
    }
    return String(v);
  };

  const setStatus = async (status: LearnProposal["status"]) => {
    await api.patch(path(API.learnProposal, { id: proposal.id }), { status });
    void qc.invalidateQueries({ queryKey: ["proposals"] });
  };
  /** Uygulama ve geri alma sunucudadır: taslak ve şablon değişikliklerini birlikte yapar, önceki değerleri kaydeder. */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["proposals"] });
    void qc.invalidateQueries({ queryKey: ["profileDraft"] });
    void qc.invalidateQueries({ queryKey: ["templates"] });
  };
  const revert = async (fromToast = false) => {
    setBusy("revert");
    try {
      await api.post(path(API.learnRevert, { id: proposal.id }), {});
      refresh();
      toast({ message: fromToast ? t("ogren.toast.reverted") : t("ogren.toast.revertedOpen") });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    setBusy("apply");
    try {
      await w.flush();
      await api.post(path(API.learnApply, { id: proposal.id }), {});
      refresh();
      toast({
        message: templateChanges.length ? t("ogren.toast.appliedTemplate") : t("ogren.toast.applied"),
        tone: "success",
        action: templateChanges.length ? { label: t("ogren.undo"), run: () => void revert(true) } : { label: t("ogren.tryIt"), run: onTry },
      });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    setBusy("reject");
    try {
      await setStatus("rejected");
      toast({ message: t("ogren.toast.rejected"), action: { label: t("ogren.undo"), run: () => setStatus("open") } });
    } catch (e) {
      toast({ message: serverText(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const footer = open ? (
    <div className="td-og-alt">
      <p className="td-mut">{templateChanges.length > 0 && changes.length === 0 ? t("ogren.note.template") : t("ogren.note.draft")}</p>
      <div className="td-og-dugmeler">
        <Button size="page" icon="x" loading={busy === "reject"} disabled={busy !== null} onClick={() => void reject()}>
          {t("ogren.reject")}
        </Button>
        <Button need="edit" variant="primary" size="page" icon="check" className="td-og-uygula" loading={busy === "apply"} disabled={busy !== null || nothing} onClick={() => void apply()}>
          {changes.length === 0 ? t("ogren.apply") : t("ogren.applyDraft")}
        </Button>
      </div>
    </div>
  ) : (
    <div className="td-og-alt">
      <StatusDot tone={proposal.status === "accepted" ? "ok" : "idle"} label={proposal.status === "accepted" ? t("ogren.applied") : t("ogren.rejected")} />
      <p className="td-mut">{proposal.status === "accepted" ? t("ogren.note.revertApplied") : t("ogren.note.revertRejected")}</p>
      <Button size="page" icon="undo" wide loading={busy === "revert"} disabled={busy !== null} onClick={() => void revert()}>
        {t("ogren.undo")}
      </Button>
    </div>
  );

  return (
    <Panel side="right" title={proposal.title} footer={footer}>
      {proposal.summary && (
        <PanelSection>
          <p className="td-og-ozet">{proposal.summary}</p>
        </PanelSection>
      )}
      <PanelSection heading={open ? t("ogren.changes") : t("ogren.proposedFields")}>
        {nothing ? (
          <p className="td-mut">{t("ogren.noChanges")}</p>
        ) : changes.length === 0 ? (
          <ul className="td-og-alanlar">
            {templateChanges.map((c) => (
              <li key={`${c.key}.${c.field}`}>
                <span>{t("ogren.templateField", { key: c.key, field: fieldLabel(c.field) })}</span>
                <span className="td-og-deger">
                  {open && (
                    <>
                      <s>{fmtValue(c.from)}</s>
                      <Icon name="right" size={12} />
                    </>
                  )}
                  <b>{fmtValue(c.to)}</b>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="td-og-alanlar">
            {changes.map((c) => {
              const v = describeChange(c);
              return (
                <li key={c.path}>
                  <span>{v.label}</span>
                  <span className="td-og-deger">
                    {open && (
                      <>
                        <s>{v.from}</s>
                        <Icon name="right" size={12} />
                      </>
                    )}
                    <b>{v.to}</b>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
      <PanelSection heading={t("ogren.basis")}>
        {adjust ? <AdjustEvidence adjust={adjust} /> : <p className="td-og-metin">{evidence.count !== null ? t("ogren.basisCount", { count: evidence.count }) : t("ogren.basisUnknown")}</p>}
        {examples.length > 0 && (
          <ul className="td-og-kucuk" aria-label={t("ogren.examples")}>
            {examples.map((r) => (
              <li key={r.id}>
                <RefGorsel reference={r} mm={12.7} />
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      {evidence.train.length > 0 && (
        <CollapsedGroup title={t("ogren.metrics.train")} summary={t("ogren.metrics.count", { count: evidence.train.length })}>
          <div className="td-og-grup">
            <MetricTable metrics={evidence.train} />
          </div>
        </CollapsedGroup>
      )}
    </Panel>
  );
}

/**
 * Elle düzeltmelerden çıkan önerinin açıklaması: kaç varyasyon / iş, ortanca kayma, yayılım, aynı yönde kaydıran işlerin
 * payı. "Kanıt zayıf" gerekçesi sunucunun özetinde zaten var; burada tekrarlanmaz.
 */
function AdjustEvidence({ adjust }: { adjust: AdjustEvidenceView }) {
  const { t } = useTranslation("designLanguageLab");
  const axes = [adjust.x?.systematic ? { id: "x", label: t("ogren.axis.x"), a: adjust.x } : null, adjust.y?.systematic ? { id: "y", label: t("ogren.axis.y"), a: adjust.y } : null].filter(
    (v): v is { id: string; label: string; a: NonNullable<AdjustEvidenceView["x"]> } => v !== null,
  );
  return (
    <div className="td-og-metin">
      <p>{t("ogren.adjust.line", { jobs: adjust.jobs, samples: adjust.samples, shift: shiftText(adjust) || t("ogren.adjust.noShift") })}</p>
      {adjust.usage && adjust.usage.approved > 0 && <p>{t("ogren.adjust.usage", { approved: adjust.usage.approved, adjusted: adjust.usage.adjusted })}</p>}
      {axes.length > 0 && (
        <table className="td-og-tablo">
          <tbody>
            {axes.map(({ id, label, a }) => (
              <tr key={id}>
                <th scope="row">{label}</th>
                <td className="td-mono">{t("ogren.adjust.px", { n: num(a.medianPx, 1) })}</td>
                <td>{t("ogren.adjust.spread", { n: num(a.iqrPx, 1) })}</td>
                <td>{t("ogren.adjust.agreement", { pct: pct(a.agreement) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
