import { BUILD_LABEL_TYPES, BUILDER_SAMPLE_LIMITS, type Build, type BuildEstimate, type BuildLabelType, type Sample } from "@tagpress/domain";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatUsd, intlLocale } from "../../i18n/bicim.ts";
import { goToConnections } from "../../lib/api.ts";
import { Button, CenterColumn, cx, EmptyState, Icon, IssueBox, Segmented, StatusDot, Tag, Tooltip } from "../../tezgah/index.ts";
import { oturumHatasi } from "./metin.ts";

/**
 * Ortadaki sayfa çerçevesi (tuval yokken: başlangıç, giriş, örnekler, bekleme): Tasarım dilinin öbür bölümleri gibi beyaz
 * zemin ve 17 px başlık. `tip`: başlığın ipucu (ekranda açıklama paragrafı yerine).
 */
export function Sayfa({ title, tip, lead, children, footer }: { title: string; tip?: string; lead?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  const heading = <h1 className="ol-baslik">{title}</h1>;
  return (
    <CenterColumn>
      <div className="ol-sayfa">
        <div className="ol-sayfa-ic">
          {tip ? <Tooltip content={tip}>{heading}</Tooltip> : heading}
          {lead && <p className="ol-lead">{lead}</p>}
          {children}
          {footer && <div className="ol-alt">{footer}</div>}
        </div>
      </div>
    </CenterColumn>
  );
}

/** Aralığın iki ucu aynı basamakla ("$0,70–$1,39"): üst uca göre 2, çok küçük tutarda 3 basamak. */
export function usdRange(low: number, high: number): { low: string; high: string } {
  const digits = high < 0.1 ? 3 : 2;
  const f = (n: number) => `$${n.toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return { low: f(low), high: f(high) };
}

/** Tahmin satırı: aralık, oturum sınırı, ayın harcaması; anahtar yoksa ve ay sınırına yaklaşınca uyarı. */
export function Tahmin({ estimate, loading, error }: { estimate: BuildEstimate | undefined; loading: boolean; error: unknown }) {
  const { t } = useTranslation("builder");
  if (loading) return <StatusDot tone="busy" label={t("estimate.loading")} />;
  if (!estimate) return error ? <p className="ol-not">{t("estimate.unavailable")}</p> : null;
  return (
    <div className="ol-tahmin" aria-live="polite">
      <p>
        {t("estimate.range", usdRange(estimate.lowUsd, estimate.highUsd))}
        <span className="ol-mut">{` · ${t("estimate.cap", { cap: formatUsd(estimate.sessionCapUsd) })}`}</span>
      </p>
      <p className="ol-mut">{t("estimate.month", { used: formatUsd(estimate.monthUsd), limit: formatUsd(estimate.monthLimitUsd) })}</p>
      {estimate.keySource === null && <AnahtarYok />}
      {estimate.monthWarn && <IssueBox tone="warn">{t("estimate.monthWarn")}</IssueBox>}
    </div>
  );
}

export function AnahtarYok({ message }: { message?: string }) {
  const { t } = useTranslation("builder");
  return (
    <IssueBox
      tone="warn"
      fixes={
        <Button size="mini" onClick={goToConnections}>
          {t("common:actions.goToConnections")}
        </Button>
      }
    >
      {message ?? t("estimate.noKey")}
    </IssueBox>
  );
}

export type Base = "published" | "default";

/** Oturum yokken: ne olacağı, maliyet, taban seçimi ve "Başla". */
export function Baslangic({
  activeVersion,
  fromSetup,
  setupTypes,
  base,
  onBase,
  estimate,
  onStart,
  starting,
  startError,
}: {
  activeVersion: number | null;
  fromSetup: boolean;
  setupTypes: BuildLabelType[];
  base: Base;
  onBase: (b: Base) => void;
  estimate: { data: BuildEstimate | undefined; loading: boolean; error: unknown };
  onStart: () => void;
  starting: boolean;
  startError: ReactNode;
}) {
  const { t } = useTranslation("builder");
  const noKey = estimate.data?.keySource === null;
  return (
    <Sayfa
      title={t("start.title")}
      tip={t("start.lead")}
      footer={
        <Button need="spend" variant="primary" size="page" icon="spark" command="tasarimDili.primary" loading={starting} disabled={noKey} onClick={onStart}>
          {t("start.go")}
        </Button>
      }
    >
      {fromSetup && <IssueBox tone="info">{setupTypes.length ? t("start.fromSetupTypes", { list: setupTypes.map((x) => t(`labelType.${x}`)).join(", ") }) : t("start.fromSetup")}</IssueBox>}
      <ol className="ol-adimlar">
        {(["questions", "samples", "review", "publish"] as const).map((k, i) => (
          <li key={k}>
            <span className="ol-adim-no" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <b>{t(`start.steps.${k}.title`)}</b>
              <small>{t(`start.steps.${k}.body`)}</small>
            </span>
          </li>
        ))}
      </ol>
      {activeVersion !== null && !fromSetup && (
        <div className="ol-satir">
          <span className="ol-mut" id="ol-taban">
            {t("start.baseLabel")}
          </span>
          <Segmented<Base>
            aria-labelledby="ol-taban"
            value={base}
            onChange={onBase}
            options={[
              { value: "published", label: t("start.basePublished", { version: activeVersion }) },
              { value: "default", label: t("start.baseDefault") },
            ]}
          />
        </div>
      )}
      <Tahmin estimate={estimate.data} loading={estimate.loading} error={estimate.error} />
      {startError}
      <p className="ol-not">{t("start.privacy")}</p>
    </Sayfa>
  );
}

/** Giriş (`intake`): etiket türleri. */
export function Giris({ sel, onToggle, onNext, busy }: { sel: ReadonlySet<BuildLabelType>; onToggle: (x: BuildLabelType) => void; onNext: () => void; busy: boolean }) {
  const { t } = useTranslation("builder");
  return (
    <Sayfa
      title={t("intake.title")}
      lead={t("intake.lead")}
      footer={
        <Button variant="primary" size="page" command="tasarimDili.primary" loading={busy} disabled={sel.size === 0} onClick={onNext}>
          {t("intake.next")}
        </Button>
      }
    >
      <div className="ol-turler" role="group" aria-label={t("intake.title")}>
        {BUILD_LABEL_TYPES.map((x) => (
          <button key={x} type="button" className={cx("ol-tur", sel.has(x) && "is-on")} aria-pressed={sel.has(x)} onClick={() => onToggle(x)}>
            {sel.has(x) && <Icon name="check" size={12} />}
            {t(`labelType.${x}`)}
          </button>
        ))}
      </div>
    </Sayfa>
  );
}

const STATUS_TONE: Record<Sample["status"], "neutral" | "accent" | "info"> = { uploaded: "neutral", measured: "accent", qualitative: "info", failed: "neutral" };

/** Örnekler (`samples`): yükleme alanı, yüklenenler, "Ölç ve başla" ya da "Örneğim yok". */
export function Ornekler({
  build,
  estimate,
  onAttach,
  onDropFiles,
  onOpen,
  onAnalyze,
  onSkip,
  busy,
}: {
  build: Build;
  estimate: { data: BuildEstimate | undefined; loading: boolean; error: unknown };
  onAttach: () => void;
  onDropFiles: (f: File[]) => void;
  onOpen: (s: Sample) => void;
  onAnalyze: () => void;
  onSkip: () => void;
  busy: string | null;
}) {
  const { t } = useTranslation("builder");
  const [over, setOver] = useState(false);
  const usable = build.samples.filter((s) => !s.excluded).length;
  return (
    <Sayfa
      title={t("samples.title")}
      lead={t("samples.lead", { max: BUILDER_SAMPLE_LIMITS.maxFiles })}
      footer={
        <>
          <Button variant="quiet" size="page" loading={busy === "skip"} disabled={!!busy} onClick={onSkip}>
            {t("samples.skip")}
          </Button>
          <span className="ol-sp" />
          <Button need="spend" variant="primary" size="page" icon="spark" command="tasarimDili.primary" loading={busy === "analyze"} disabled={usable === 0 || (!!busy && busy !== "analyze")} onClick={onAnalyze}>
            {t("samples.analyze")}
          </Button>
        </>
      }
    >
      <div
        className={cx("ol-birak", over && "is-uzerinde")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = [...(e.dataTransfer?.files ?? [])];
          if (files.length) onDropFiles(files);
        }}
      >
        <Icon name="up" />
        <p>{t("samples.drop")}</p>
        <Button icon="filep" loading={busy === "upload"} onClick={onAttach}>
          {t("samples.choose")}
        </Button>
      </div>
      {build.samples.length > 0 && (
        <ul className="ol-kartlar" aria-label={t("samples.yours", { count: build.samples.length })}>
          {build.samples.map((s) => (
            <li key={s.id}>
              <button type="button" className={cx("ol-kart", s.excluded && "is-disi")} onClick={() => onOpen(s)} aria-label={t("samples.open", { name: s.name })}>
                <img src={`${s.imageUrl}?w=240`} alt="" draggable={false} />
                <span className="ol-kart-ad">{s.name}</span>
                <Tag tone={STATUS_TONE[s.status]}>{s.excluded ? t("sample.excluded") : t(`sample.status.${s.status}`)}</Tag>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Tahmin estimate={estimate.data} loading={estimate.loading} error={estimate.error} />
      <p className="ol-not">{t("start.privacy")}</p>
    </Sayfa>
  );
}

/** Revizyon yokken çalışma ya da bekleme sayfası. */
export function Bekle({ build, step, onCancel, busy }: { build: Build; step: string | null; onCancel: () => void; busy: boolean }) {
  const { t } = useTranslation("builder");
  if (build.state === "awaiting-user") return <Sayfa title={t("wait.answerTitle")} lead={t("wait.answerBody")} />;
  if (build.state === "interrupted" || build.state === "failed") {
    return <Sayfa title={t(`wait.${build.state}`)} lead={build.error ? oturumHatasi(build.error) : t("wait.resumeHint")} />;
  }
  return (
    <CenterColumn>
      <div className="ol-cv-msg ol-calisiyor">
        <EmptyState
          icon="spark"
          title={t(`wait.${build.state === "analyzing" ? "analyzing" : "drafting"}`)}
          body={<StatusDot tone="busy" label={step ?? t("step.working")} />}
          action={
            <Button loading={busy} onClick={onCancel}>
              {t("wait.cancel")}
            </Button>
          }
        />
      </div>
    </CenterColumn>
  );
}
