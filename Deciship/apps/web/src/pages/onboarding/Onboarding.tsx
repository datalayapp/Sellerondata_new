import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { demo, onboarding } from '../../api/endpoints';
import type { OnboardingPatch, OnboardingStatus } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { usePageTitle } from '../../components/Brand';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { Button, ErrorState, PageHeader, Skel, errorMessage } from '../../components/ui';
import { FEATURES } from '../../lib/features';
import { markOnboardingRedirected } from '../../lib/onboarding';
import { isOrgAdmin } from '../../lib/permissions';
import { InvoicesStep, SummaryStep } from './FinishSteps';
import { CarriersStep, RulesStep } from './SetupSteps';
import { PresetsStep, TariffsStep } from './DataSteps';
import { companyConfirmed, companyFacts, hubConfirmHref } from './company';
import { CompanyGate, HubCompanyRow, HubCompanyStrip } from './HubCompany';
import { STEPS, resumeStep, stepIndex, stepState, type StepMeta, stepFromParam, type WizardStep } from './steps';

/** Her adım bileşenine verilen bağlam. */
export interface StepCtx {
  status: OnboardingStatus;
  meta: StepMeta;
  /** Adımı işaretleyip (tamamlandı / atlandı) sonrakine geçer. */
  next: (mark?: 'done' | 'skipped') => Promise<void>;
  prev: () => void;
  go: (k: WizardStep) => void;
  /** Sunucudaki ilerlemeyi güncelle (adım değiştirmeden). */
  patch: (b: OnboardingPatch) => Promise<OnboardingStatus>;
  moving: boolean;
}

export function OnboardingPage() {
  const { t } = useTranslation('onboarding');
  usePageTitle(t('page.tabTitle'));
  const qc = useQueryClient();
  const { refreshMe, person } = useAuth();
  const [sp, setSp] = useSearchParams();
  const loc = useLocation();
  const q = useQuery({ queryKey: ['onboarding'], queryFn: onboarding.get, staleTime: 0 });
  const headRef = useRef<HTMLHeadingElement>(null);

  // kurulum sayfası açıldı: bu oturumda Pano bir daha buraya yönlendirmesin
  useEffect(() => markOnboardingRedirected(), []);

  const m = useMutation({
    mutationFn: onboarding.update,
    onSuccess: (s) => {
      qc.setQueryData(['onboarding'], s);
    },
  });
  const patch = (b: OnboardingPatch) => m.mutateAsync(b);

  const status = q.data;
  const param = stepFromParam(sp.get('adim'));
  const current: WizardStep | null = status ? (param ?? resumeStep(status)) : null;
  const idx = stepIndex(current);
  const meta = STEPS[idx];
  // Merkez `/me` olaydan gelen kopyadan tazedir: önce ona bakılır
  const confirmed = status ? companyConfirmed(person?.activeOrg, status) : false;
  const facts = status ? companyFacts(person?.activeOrg, status.company) : null;
  const admin = isOrgAdmin(person);

  const go = (k: WizardStep) => {
    setSp({ adim: k });
    // kaldığı yer sunucuda: sihirbaz yeniden açılınca buradan devam eder
    if (status?.state.step !== k) patch({ step: k }).catch(() => undefined);
    window.scrollTo({ top: 0 });
    setTimeout(() => headRef.current?.focus({ preventScroll: true }), 0);
  };
  const next = async (mark?: 'done' | 'skipped') => {
    const to = STEPS[Math.min(idx + 1, STEPS.length - 1)].key;
    await patch({ ...(mark ? { [mark]: meta.key } : {}), step: to });
    refreshMe().catch(() => undefined);
    go(to);
  };
  const prev = () => go(STEPS[Math.max(0, idx - 1)].key);

  return (
    <>
      <PageHeader
        title={t('page.title')}
        sub={t('page.sub')}
      />
      <div className="content">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !status || !current ? (
          <div className="ob lift">
            <Skel h={360} />
            <Skel h={360} />
          </div>
        ) : (
          <div className="ob lift">
            <Stepper status={status} current={confirmed ? current : null} confirmed={confirmed} onGo={go} />
            {!confirmed ? (
              <section className="ob-main" aria-labelledby="ob-step-title">
                <header className="ob-head">
                  <h2 id="ob-step-title" className="ob-title" ref={headRef} tabIndex={-1}>
                    {t('hub.gateTitle')}
                  </h2>
                </header>
                <CompanyGate facts={facts!} admin={admin} confirmHref={hubConfirmHref(loc.pathname, loc.search)} />
              </section>
            ) : (
              <section className="ob-main" aria-labelledby="ob-step-title">
                <HubCompanyStrip facts={facts!} admin={admin} />
                {idx === 0 && FEATURES.demoTour && status.demo?.available === true && <DemoCard />}
                <header className="ob-head">
                  <div className="grow">
                    <p className="ob-eyebrow mono" aria-hidden="true">
                      {t('progress', { current: idx + 1, total: STEPS.length })}
                    </p>
                    <h2 id="ob-step-title" className="ob-title" ref={headRef} tabIndex={-1}>
                      {t(`steps.${meta.key}.title`)}
                      <span className="sr-only">
                        {' '}
                        · {t('progressSr', { current: idx + 1, total: STEPS.length })}
                      </span>
                    </h2>
                  </div>
                </header>
                {meta.key !== 'ozet' && <ReqNote meta={meta} />}
                <StepBody ctx={{ status, meta, next, prev, go, patch, moving: m.isPending }} />
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Veri girilmemiş firmada ilk adımın üstünde: örnek veriyle deneme (MESAJ-14 §4.3). Başarıda Pano açılır. */
function DemoCard() {
  const { t } = useTranslation('onboarding');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { refreshMe } = useAuth();
  const start = useMutation({
    mutationFn: demo.start,
    onSuccess: async () => {
      await qc.invalidateQueries();
      await refreshMe().catch(() => undefined);
      nav('/');
    },
    onError: (e) => toast.err(errorMessage(e)),
  });
  return (
    <div className="demo-card" aria-live="polite">
      <div className="demo-card-text">
        <b>{t('demo.cardTitle')}</b>
        <p>{start.isPending ? t('demo.loading') : t('demo.startHelp')}</p>
      </div>
      <Button kind="secondary" loading={start.isPending} onClick={() => start.mutate()}>
        {t('demo.start')}
      </Button>
    </div>
  );
}

function StepBody({ ctx }: { ctx: StepCtx }) {
  switch (ctx.meta.key) {
    case 'tasiyicilar':
      return <CarriersStep ctx={ctx} />;
    case 'faturalar':
      return <InvoicesStep ctx={ctx} />;
    case 'tarifeler':
      return <TariffsStep ctx={ctx} />;
    case 'olcum':
      return <RulesStep ctx={ctx} />;
    case 'koliler':
      return <PresetsStep ctx={ctx} />;
    case 'ozet':
      return <SummaryStep ctx={ctx} />;
  }
}

export function ReqTag({ required }: { required: boolean }) {
  const { t } = useTranslation('onboarding');
  return <span className={`ob-req ${required ? 'is-req' : 'is-opt'}`}>{required ? t('req.required') : t('req.optional')}</span>;
}

/** Adımın başında: zorunlu mu, atlanırsa ne olur. */
function ReqNote({ meta }: { meta: StepMeta }) {
  const { t } = useTranslation('onboarding');
  return (
    <p className="ob-need">{t(`steps.${meta.key}.need`)}</p>
  );
}

/** Adım listesi. Firma onaylanmadıysa DeciShip adımları kapalıdır (gövde yalnız "Önce firma bilgileri"). */
function Stepper({ status, current, confirmed, onGo }: { status: OnboardingStatus; current: WizardStep | null; confirmed: boolean; onGo: (k: WizardStep) => void }) {
  const { t } = useTranslation('onboarding');
  const ref = useRef<HTMLElement>(null);
  // telefonda adımlar yatay kayar: geçerli adım görünür kalsın
  useEffect(() => {
    const nav = ref.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!nav || !el || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: Math.max(0, el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2) });
  }, [current]);
  return (
    <nav className="ob-steps" aria-label={t('stepper.label')} ref={ref}>
      <ol>
        <HubCompanyRow confirmed={confirmed} />
        {STEPS.map((s, i) => {
          const st = stepState(status, s.key);
          const on = s.key === current;
          const stLabel = t(`stepper.state.${st}`);
          return (
            <li key={s.key}>
              <button
                type="button"
                className={`ob-step${on ? ' on' : ''} st-${st}`}
                aria-current={on ? 'step' : undefined}
                disabled={!confirmed}
                onClick={() => onGo(s.key)}
              >
                <span className="ob-dot" aria-hidden="true">
                  {st === 'ok' ? <Icon name="check" size={14} /> : st === 'skipped' ? '–' : i + 1}
                </span>
                <span className="ob-step-t">
                  <span className="ob-step-tt">
                    <b>{t(`steps.${s.key}.title`)}</b>
                    {s.key !== 'ozet' && <ReqTag required={s.required} />}
                  </span>
                  <span className="ob-step-s">{t(`steps.${s.key}.short`)}</span>
                </span>
                <span className="sr-only"> ({stLabel})</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** "Neden önemli / ne için kullanılır" kutusu: her adımın başında. */
export function Why({ children }: { children: ReactNode }) {
  return (
    <div className="ob-why">
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}

/** Adımın alt eylem çubuğu: solda Geri, sağda atla + ana eylem. Telefonda tam genişlik. */
export function StepFoot({ ctx, children, note }: { ctx: StepCtx; children: ReactNode; note?: ReactNode }) {
  const { t } = useTranslation('onboarding');
  const first = stepIndex(ctx.meta.key) === 0;
  return (
    <div className="ob-foot">
      {!first ? (
        <Button kind="ghost" icon="back" onClick={ctx.prev} disabled={ctx.moving}>
          {t('foot.back')}
        </Button>
      ) : (
        <span />
      )}
      {note && <span className="ob-foot-note">{note}</span>}
      <div className="ob-foot-acts">{children}</div>
    </div>
  );
}
