import {
  BUILD_LABEL_TYPES,
  BUILDER_SAMPLE_LIMITS,
  isBuildRunning,
  type Build,
  type BuildEntry,
  type BuildLabelType,
  type BuildMessage,
  type Language,
  type ProfileRecord,
  type Sample,
  type SamplePatch,
  type SampleUploadResponse,
} from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatUsd } from "../../i18n/bicim.ts";
import { useCan } from "../../lib/access.ts";
import { ApiFailure } from "../../lib/api.ts";
import { useLanguage } from "../../lib/language.tsx";
import { type EkranProps, parseHash } from "../../lib/route.ts";
import { SECTIONS, type SectionId, sectionPath } from "../tasarim-dili/mantik/sections.ts";
import { useProposals, useReferences } from "../tasarim-dili/mantik/work.tsx";
import {
  AppFrame,
  BandButton,
  Button,
  EmptyState,
  Field,
  IssueBox,
  type MenuItem,
  StatusDot,
  type DotTone,
  TextField,
  useCommands,
  useConfirm,
  useToast,
  Workspace,
  WorkRow,
} from "../../tezgah/index.ts";
import { AnahtarYok, Baslangic, type Base, Bekle, Giris, Ornekler, Sayfa } from "./Adimlar.tsx";
import { ClaudeCodePenceresi } from "./ClaudeCode.tsx";
import { mergeEntries } from "./akis.ts";
import { builderApi, fileBase64, keys } from "./api.ts";
import { adimMetni, hataMetni, oturumHatasi } from "./metin.ts";
import { OrnekPenceresi } from "./OrnekPenceresi.tsx";
import { Ozet } from "./Ozet.tsx";
import { Sohbet } from "./Sohbet.tsx";
import { failureOf, type Failure, useOlustur } from "./useOlustur.ts";
import { Vitrin } from "./Vitrin.tsx";
import "./kisayollar.ts";
import "./olustur.css";

/**
 * Oluştur (maket 5): sitede yapay zekâ ile tasarım dili oluşturma. Rota `#/tasarim-dili/olustur`; Tasarım dilinin
 * yedi sekmesinden biri. Kurulumdan giriş: `?kurulum=1&turler=wedding,thanks&don=<geri dönülecek adres>`.
 * Akış: başla → (etiket türleri) → örnekler → ölçüm ve ilk taslak → sorular → örnek etiketler → düzeltme (tekrarlı) → yayın.
 */
export default function OlusturEkrani({ route, go }: EkranProps) {
  const { t } = useTranslation("builder");
  const { current, loading } = useLanguage();
  // Sekme sayaçları Tasarım dilinin öbür bölümleriyle aynı: örnek sayısı ve bekleyen öneri sayısı.
  const refs = useReferences(current?.id ?? "");
  const proposals = useProposals(current?.id ?? "", "open");
  const counts: Partial<Record<SectionId, number>> = current ? { ornekler: refs.data?.length, ogren: proposals.data?.length } : {};
  const frame = (children: ReactNode, extra?: { meta?: ReactNode; actions?: ReactNode }) => (
    <AppFrame
      band="work"
      active="tasarim-dili"
      workRow={
        <WorkRow
          crumbs={[{ label: current ? current.name : t("designLanguage:title") }]}
          tabs={{
            items: SECTIONS.map((s) => ({ id: s.id, label: s.label, count: counts[s.id] || undefined })),
            value: "olustur",
            onChange: (id) => go("tasarim-dili", sectionPath(id as SectionId)),
          }}
          meta={extra?.meta}
          actions={extra?.actions}
        />
      }
    >
      {children}
    </AppFrame>
  );
  if (loading) {
    return frame(
      <div className="ol-bos-sayfa">
        <StatusDot tone="busy" label={t("loading")} />
      </div>,
    );
  }
  if (!current) {
    return frame(
      <div className="ol-bos-sayfa">
        <EmptyState icon="stamp" title={t("noLanguage.title")} body={t("noLanguage.body")} action={<Button onClick={() => go("tasarim-dili")}>{t("noLanguage.go")}</Button>} />
      </div>,
    );
  }
  return <Oturum key={current.id} language={current} route={route} go={go} frame={frame} />;
}

type Frame = (children: ReactNode, extra?: { meta?: ReactNode; actions?: ReactNode }) => ReactNode;

const STATE_TONE: Record<Build["state"], DotTone> = {
  intake: "idle",
  samples: "idle",
  analyzing: "busy",
  drafting: "busy",
  revising: "busy",
  "awaiting-user": "warn",
  review: "ok",
  published: "ok",
  closed: "idle",
  interrupted: "warn",
  failed: "error",
};

/** Kurulumdan gelen tür listesi (`turler=wedding,thanks`); bilinmeyen değer atlanır. */
function setupTypes(q: URLSearchParams): BuildLabelType[] {
  const raw = (q.get("turler") ?? "").split(",").map((s) => s.trim());
  return BUILD_LABEL_TYPES.filter((x) => raw.includes(x));
}

function Oturum({ language, route, go, frame }: EkranProps & { language: Language; frame: Frame }) {
  const { t } = useTranslation("builder");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const lang = language.id;
  // Bütçe artırmak harcamayı açar: yapay zekâ izni ister (sunucu `POST …/budget/raise` için `spend` denetler).
  const canSpend = useCan("spend");
  const data = useOlustur(lang);
  const build = data.build;
  const fromSetup = route.query.get("kurulum") === "1";
  const back = route.query.get("don");
  const types = setupTypes(route.query);

  const [base, setBase] = useState<Base>(language.activeVersion !== null && !fromSetup ? "published" : "default");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [startError, setStartError] = useState<ReactNode>(null);
  const [published, setPublished] = useState<ProfileRecord | null>(null);
  const [openSample, setOpenSample] = useState<string | null>(null);
  const [pinnedRev, setPinnedRev] = useState<number | null>(null);
  const [sent, setSent] = useState(0);
  const [intake, setIntake] = useState<ReadonlySet<BuildLabelType> | null>(null);
  const [claudeCode, setClaudeCode] = useState(false);
  const refCount = useReferences(lang).data?.length;
  const fileInput = useRef<HTMLInputElement | null>(null);

  const id = build?.id ?? null;
  const current = build?.currentRev ?? 0;
  useEffect(() => setPinnedRev(null), [current]);
  const shownRev = pinnedRev !== null && pinnedRev <= current ? pinnedRev : current;

  const sampleCount = build?.samples.filter((s) => !s.excluded).length ?? 0;
  const wantEstimate = !build || build.state === "intake" || build.state === "samples";
  const estimate = useQuery({
    queryKey: keys.estimate(lang, sampleCount),
    queryFn: () => builderApi.estimate({ languageId: lang, samples: Math.min(sampleCount, BUILDER_SAMPLE_LIMITS.maxFiles) }),
    enabled: wantEstimate && !published,
    retry: false,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: keys.revision(lang, id ?? "-", shownRev),
    queryFn: () => builderApi.revision(id!, shownRev),
    enabled: !!id,
    staleTime: Infinity,
    retry: false,
  });

  /**
   * Uç çağrısı: hata bildirim olur; bütçe ve anahtar hatası özel kutuda. Bütçede "artır ve devam et" `again`'i
   * (verilmezse aynı çağrıyı) yeniden çalıştırır.
   */
  const act = async <T,>(name: string, fn: () => Promise<T>, again?: () => Promise<unknown>): Promise<T | undefined> => {
    setBusy(name);
    try {
      const r = await fn();
      setFailure(null);
      return r;
    } catch (e) {
      const f = failureOf(e, again ?? (() => act(name, fn)));
      if (f) setFailure(f);
      else toast({ message: hataMetni(e), tone: "error" });
      if (e instanceof ApiFailure && ["build-state", "build-busy", "build-active", "message-kind", "question-unknown"].includes(e.body.code ?? "")) void data.refresh();
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  const withBuild = async (name: string, fn: () => Promise<Build>): Promise<Build | undefined> => {
    const b = await act(name, fn, () => withBuild(name, fn));
    if (b) {
      data.setBuild(b);
      void qc.invalidateQueries({ queryKey: keys.current(lang) });
      if (id) void qc.invalidateQueries({ queryKey: keys.messages(lang, id) });
    }
    return b;
  };

  // ---------------------------------------------------------------- eylemler

  const start = async () => {
    setStartError(null);
    setPublished(null);
    try {
      setBusy("start");
      const b = await builderApi.create(lang, { base, ...(fromSetup ? { fromSetup: true, labelTypes: types } : {}) });
      data.setBuild(b);
    } catch (e) {
      const f = failureOf(e, null);
      if (f?.code === "missing-key") setStartError(<AnahtarYok message={hataMetni(e)} />);
      else if (e instanceof ApiFailure && e.body.code === "build-active") void data.refresh();
      else setStartError(<IssueBox tone="error">{hataMetni(e)}</IssueBox>);
    } finally {
      setBusy(null);
    }
  };

  const send = async (body: BuildMessage): Promise<boolean> => {
    if (!id) return false;
    const r = await act(
      "send",
      () => builderApi.post(id, body),
      () => send(body),
    );
    if (!r) return false;
    qc.setQueryData<BuildEntry[]>(keys.messages(lang, id), (old) => mergeEntries(old ?? [], r.entries));
    void qc.invalidateQueries({ queryKey: keys.current(lang) });
    // Bütçe artırılıp yeniden gönderildiyse de yazı kutusu temizlenir.
    setSent((n) => n + 1);
    return true;
  };

  const upload = async (files: File[]) => {
    if (!id || !build) return;
    const room = BUILDER_SAMPLE_LIMITS.maxFiles - build.samples.length;
    const rejected: Array<{ name: string; code: string }> = [];
    const ok: File[] = [];
    for (const f of files) {
      if (!(BUILDER_SAMPLE_LIMITS.mimeTypes as readonly string[]).includes(f.type)) rejected.push({ name: f.name, code: "sample-type" });
      else if (f.size > BUILDER_SAMPLE_LIMITS.maxFileBytes) rejected.push({ name: f.name, code: "sample-too-large" });
      else if (ok.length >= room) rejected.push({ name: f.name, code: "sample-limit" });
      else ok.push(f);
    }
    // İstek sınırı: base64 dosyayı 4/3 büyütür; sınırı aşmayacak parçalar hâlinde gönderilir.
    const batches: File[][] = [];
    let cur: File[] = [];
    let size = 0;
    for (const f of ok) {
      const s = Math.ceil(f.size / 3) * 4 + 512;
      if (cur.length && size + s > BUILDER_SAMPLE_LIMITS.maxRequestBytes) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(f);
      size += s;
    }
    if (cur.length) batches.push(cur);
    let added = 0;
    for (const batch of batches) {
      const r = await act<SampleUploadResponse>("upload", async () => builderApi.upload(id, { files: await Promise.all(batch.map(async (f) => ({ name: f.name, dataBase64: await fileBase64(f) }))) }));
      if (!r) break;
      added += r.samples.length;
      rejected.push(...r.rejected.map((x) => ({ name: x.name, code: x.code })));
    }
    if (added) toast({ message: t("samples.added", { count: added }), tone: "success" });
    for (const r of rejected) toast({ message: t("samples.rejected", { name: r.name, reason: t(`sampleReject.${r.code}`, { defaultValue: t("sampleReject.unknown") }) }), tone: "error" });
    void qc.invalidateQueries({ queryKey: keys.current(lang) });
  };

  const patchSample = async (sid: string, p: SamplePatch) => {
    if (!id) return false;
    const r = await act("sample", () => builderApi.patchSample(id, sid, p));
    if (r) void qc.invalidateQueries({ queryKey: keys.current(lang) });
    return !!r;
  };
  const deleteSample = async (sid: string) => {
    if (!id) return false;
    const r = await act("sample", () => builderApi.deleteSample(id, sid));
    if (r) void qc.invalidateQueries({ queryKey: keys.current(lang) });
    return !!r;
  };

  const publish = async () => {
    if (!id) return;
    const note = { v: "" };
    const ok = await confirm({ title: t("publish.title"), body: <YayinNotu onChange={(v) => (note.v = v)} />, confirmLabel: t("publish.confirm") });
    if (!ok) return;
    const rec = await act("publish", async () => {
      try {
        return await builderApi.publish(id, note.v);
      } catch (e) {
        // Oturum sürerken dil başka yerden değiştiyse sunucu ezmez (409); kullanıcı açıkça onaylarsa yine de yayınlanır.
        if (!(e instanceof ApiFailure) || e.body.code !== "build-base-changed") throw e;
        const b = e.body as { baseVersion?: number | null; publishedVersion?: number | null };
        const again = await confirm({
          title: t("publish.changedTitle"),
          body: b.publishedVersion !== b.baseVersion ? t("publish.changedPublished", { version: b.publishedVersion }) : t("publish.changedDraft"),
          confirmLabel: t("publish.changedConfirm"),
          tone: "danger",
        });
        return again ? builderApi.publish(id, note.v, true) : null;
      }
    });
    if (!rec) return;
    setPublished(rec);
    toast({ message: t("publish.done", { version: rec.version }), tone: "success" });
    data.setBuild(null);
    void qc.invalidateQueries({ queryKey: ["languages"] });
    void qc.invalidateQueries({ queryKey: ["profile"] });
    void qc.invalidateQueries({ queryKey: ["build", lang] });
  };

  const closeBuild = async () => {
    if (!id) return;
    const ok = await confirm({ title: t("close.title"), body: t("close.body"), confirmLabel: t("close.confirm"), tone: "danger" });
    if (!ok) return;
    const b = await act("close", () => builderApi.close(id));
    if (b) {
      data.setBuild(null);
      void qc.invalidateQueries({ queryKey: ["build", lang] });
    }
  };

  const raise = async () => {
    if (!id || !canSpend) return;
    const f = failure;
    const b = await withBuild("raise", () => builderApi.raise(id));
    if (b) {
      toast({ message: t("budget.raised", { limit: formatUsd(b.budgetUsd) }), tone: "success" });
      if (f?.retry) await f.retry();
    }
  };

  const restore = async (rev: number) => {
    if (!id) return;
    const r = await act("restore", () => builderApi.restore(id, rev));
    if (r) {
      setPinnedRev(null);
      toast({ message: t("restore.done", { n: r.rev }), tone: "success" });
      void qc.invalidateQueries({ queryKey: keys.current(lang) });
      void qc.invalidateQueries({ queryKey: keys.messages(lang, id) });
    }
  };

  const goBack = () => {
    if (!back) return;
    const r = parseHash(back);
    go(r.id, r.rest, Object.fromEntries(r.query));
  };

  const intakeSel: ReadonlySet<BuildLabelType> = intake ?? new Set(build?.labelTypes ?? types);
  const toggleIntake = (x: BuildLabelType) => {
    const n = new Set(intakeSel);
    if (!n.delete(x)) n.add(x);
    setIntake(n);
  };
  const sendIntake = () => {
    if (!build || intakeSel.size === 0) return;
    void withBuild("intake", () => builderApi.intake(build.id, { labelTypes: BUILD_LABEL_TYPES.filter((x) => intakeSel.has(x)) }));
  };

  const state = build?.state ?? null;
  const canPublish = !!build && current > 0 && (state === "review" || state === "awaiting-user") && build.turn === null;
  const retryable = !!build && (state === "interrupted" || (state === "failed" && (build.error?.retryable ?? true)));

  /** Durumun tek birincil eylemi (Ctrl Enter). */
  const primary = (): void => {
    if (published) return back ? goBack() : go("tasarim-dili", ["ozet"]);
    if (!build) return void start();
    if (state === "intake") return sendIntake();
    if (state === "samples" && sampleCount > 0) return void withBuild("analyze", () => builderApi.analyze(build.id));
    if (canPublish) return void publish();
    if (retryable) return void withBuild("resume", () => builderApi.resume(build.id));
  };
  useCommands("tasarimDili", {
    "tasarimDili.primary": () => primary(),
    "tasarimDili.toggleRev": () => {
      if (current > 0) setPinnedRev(shownRev === current ? current - 1 : null);
    },
  });

  // ---------------------------------------------------------------- görünüm

  const fileField = (
    <input
      ref={fileInput}
      type="file"
      hidden
      multiple
      accept={BUILDER_SAMPLE_LIMITS.mimeTypes.join(",")}
      aria-label={t("samples.add")}
      data-testid="ol-dosya"
      onChange={(e) => {
        const files = [...(e.currentTarget.files ?? [])];
        e.currentTarget.value = "";
        if (files.length) void upload(files);
      }}
    />
  );
  const attach = () => fileInput.current?.click();

  if (data.loading) {
    return frame(
      <div className="ol-bos-sayfa">
        <StatusDot tone="busy" label={t("loading")} />
      </div>,
    );
  }

  if (published) {
    return frame(
      <Workspace>
        <Sayfa
          title={t("done.title", { version: published.version })}
          lead={t("done.body")}
          footer={
            <>
              <Button variant="quiet" size="page" onClick={() => setPublished(null)}>
                {t("done.again")}
              </Button>
              <span className="ol-sp" />
              <Button variant="primary" size="page" command="tasarimDili.primary" onClick={primary}>
                {back ? t("done.back") : t("done.summary")}
              </Button>
            </>
          }
        />
      </Workspace>,
    );
  }

  const claudeCodeItem: MenuItem = { label: t("claudeCode.menu"), icon: "info", onSelect: () => setClaudeCode(true) };
  const claudeCodeDialog = claudeCode && (
    <ClaudeCodePenceresi languageId={lang} refCount={refCount} hasDraft={language.hasDraft} onGo={(s) => go("tasarim-dili", sectionPath(s))} onClose={() => setClaudeCode(false)} />
  );

  if (!build) {
    return (
      <>
        {frame(
          <Workspace>
            <Baslangic
              activeVersion={language.activeVersion}
              fromSetup={fromSetup}
              setupTypes={types}
              base={base}
              onBase={setBase}
              estimate={{ data: estimate.data, loading: estimate.isLoading, error: estimate.error }}
              onStart={() => void start()}
              starting={busy === "start"}
              startError={
                <>
                  {startError}
                  {data.loadError ? <IssueBox tone="error">{hataMetni(data.loadError)}</IssueBox> : null}
                </>
              }
            />
          </Workspace>,
          { actions: <BandButton quiet icon="dots" label={t("more")} menuItems={[claudeCodeItem]} /> },
        )}
        {claudeCodeDialog}
      </>
    );
  }

  const running = isBuildRunning(build.state) || build.turn !== null;
  const runningText = running ? (data.step ? adimMetni(data.step) : t(`meta.state.${build.state}`)) : null;
  const sample = openSample ? build.samples.find((s) => s.id === openSample) : undefined;
  const editable = ["samples", "review", "awaiting-user"].includes(build.state) && build.turn === null;

  const alert = (
    <>
      {failure?.code === "budget-exceeded" && <Butce failure={failure} build={build} busy={busy === "raise"} onRaise={() => void raise()} />}
      {failure?.code === "missing-key" && <AnahtarYok message={hataMetni(new ApiFailure(409, failure.body))} />}
      {(build.state === "interrupted" || build.state === "failed") && (
        <IssueBox
          tone={build.state === "failed" ? "error" : "warn"}
          fixes={
            retryable ? (
              <Button variant="primary" size="mini" command="tasarimDili.primary" loading={busy === "resume"} onClick={() => void withBuild("resume", () => builderApi.resume(build.id))}>
                {t("resume.go")}
              </Button>
            ) : (
              <Button size="mini" onClick={() => void closeBuild()}>
                {t("close.confirm")}
              </Button>
            )
          }
        >
          <b>{t(`resume.${build.state}`)}</b> {build.error ? oturumHatasi(build.error) : t("wait.resumeHint")}
        </IssueBox>
      )}
    </>
  );

  let center: ReactNode;
  if (build.state === "intake") center = <Giris sel={intakeSel} onToggle={toggleIntake} busy={busy === "intake"} onNext={sendIntake} />;
  else if (build.state === "samples")
    center = (
      <Ornekler
        build={build}
        estimate={{ data: estimate.data, loading: estimate.isLoading, error: estimate.error }}
        onAttach={attach}
        onDropFiles={(f) => void upload(f)}
        onOpen={(s) => setOpenSample(s.id)}
        onAnalyze={() => void withBuild("analyze", () => builderApi.analyze(build.id))}
        onSkip={() => void withBuild("skip", () => builderApi.skip(build.id))}
        busy={busy}
      />
    );
  else if (current === 0) center = <Bekle build={build} step={runningText} busy={busy === "cancel"} onCancel={() => void withBuild("cancel", () => builderApi.cancel(build.id))} />;
  else
    center = (
      <Vitrin
        lang={lang}
        buildId={build.id}
        rev={shownRev}
        current={current}
        onRev={(r) => setPinnedRev(r === current ? null : r)}
        changeCount={detail.data && detail.data.rev === shownRev ? detail.data.changes.length : null}
        costUsd={build.costUsd}
        budgetUsd={build.budgetUsd}
        running={runningText}
      />
    );

  const restoreTo = shownRev < current ? shownRev : current - 1;
  const footer =
    current > 0 ? (
      <div className="ol-pfoot">
        <Button variant="secondary" size="page" icon="undo" disabled={!canPublish || restoreTo < 0 || busy === "restore"} onClick={() => void restore(restoreTo)}>
          {shownRev < current ? t("restore.this") : t("restore.prev")}
        </Button>
        <Button
          variant={retryable ? "secondary" : "primary"}
          size="page"
          command={retryable ? undefined : "tasarimDili.primary"}
          loading={busy === "publish"}
          disabled={!canPublish}
          onClick={() => void publish()}
        >
          {t("publish.go")}
        </Button>
      </div>
    ) : undefined;

  const menu: MenuItem[] = [
    { label: t("samples.add"), icon: "clip", command: "tasarimDili.attach", disabled: !["intake", "samples", "review", "awaiting-user"].includes(build.state), onSelect: attach },
    ...(!build.budgetRaised ? [{ label: t("budget.raiseMenu"), icon: "plus" as const, disabled: !canSpend, onSelect: () => void raise() }] : []),
    claudeCodeItem,
    { label: t("close.menu"), icon: "x", danger: true, onSelect: () => void closeBuild() },
  ];

  return (
    <>
      {frame(
        <Workspace
          leftWidth={330}
          rightWidth={330}
          left={
            <Sohbet
              data={data}
              build={build}
              busy={busy}
              sent={sent}
              onSend={send}
              onCancel={() => void withBuild("cancel", () => builderApi.cancel(build.id))}
              onAttach={attach}
              onDropFiles={(f) => void upload(f)}
              onOpenSample={(s: Sample) => setOpenSample(s.id)}
              onAnalyze={() => void withBuild("analyze", () => builderApi.analyze(build.id))}
              alert={alert}
            />
          }
          right={<Ozet lang={lang} buildId={build.id} rev={shownRev} current={current} detail={detail.data} loading={detail.isLoading} footer={footer} />}
        >
          {center}
        </Workspace>,
        {
          meta: (
            <span className="ol-meta" aria-live="polite">
              <StatusDot tone={STATE_TONE[build.state]} label={t("meta.line", { state: t(`meta.state.${build.state}`), cost: formatUsd(build.costUsd) })} />
            </span>
          ),
          actions: <BandButton quiet icon="dots" label={t("more")} menuItems={menu} />,
        },
      )}
      {fileField}
      {claudeCodeDialog}
      {sample && (
        <OrnekPenceresi
          key={sample.id}
          sample={sample}
          lang={lang}
          editable={editable}
          onClose={() => setOpenSample(null)}
          onPatch={(p) => patchSample(sample.id, p)}
          onDelete={() => deleteSample(sample.id)}
        />
      )}
    </>
  );
}

/** Bütçe aşıldı: ne kadar harcandı, sınır, bu işin tahmini; oturum sınırıysa bir kez artırma. */
function Butce({ failure, build, busy, onRaise }: { failure: Failure; build: Build; busy: boolean; onRaise: () => void }) {
  const { t } = useTranslation("builder");
  const b = failure.body as { scope?: string; usedUsd?: number; limitUsd?: number; estimateUsd?: number; canRaise?: boolean };
  const month = b.scope === "month";
  const canRaise = !month && b.canRaise !== false && !build.budgetRaised;
  return (
    <IssueBox
      tone="warn"
      fixes={
        canRaise ? (
          <Button need="spend" size="mini" loading={busy} onClick={onRaise}>
            {t("budget.raise")}
          </Button>
        ) : undefined
      }
    >
      <b>{month ? t("budget.monthTitle") : t("budget.sessionTitle")}</b>{" "}
      {t("budget.body", { used: formatUsd(b.usedUsd ?? 0), limit: formatUsd(b.limitUsd ?? 0), estimate: formatUsd(b.estimateUsd ?? 0, { approx: true }) })}
    </IssueBox>
  );
}

function YayinNotu({ onChange }: { onChange: (v: string) => void }) {
  const { t } = useTranslation("builder");
  const [v, setV] = useState("");
  return (
    <div className="ol-yayin">
      <p>{t("publish.body")}</p>
      <Field label={t("publish.noteLabel")}>
        <TextField
          value={v}
          maxLength={500}
          placeholder={t("publish.notePlaceholder")}
          onChange={(x) => {
            setV(x);
            onChange(x);
          }}
        />
      </Field>
    </div>
  );
}
