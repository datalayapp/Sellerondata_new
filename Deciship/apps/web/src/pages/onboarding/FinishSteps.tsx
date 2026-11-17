import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { invoices } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { isOrgAdmin } from '../../lib/permissions';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { Button, errorMessage } from '../../components/ui';
import { acceptList, isBlockedPdf } from '../invoice-upload/acceptList';
import { SampleInvoice, useCompareSampleInvoices } from './SampleInvoice';
import { SampleLeft, uploadSamplePdf } from './samplePdf';
import { ReqTag, StepFoot, Why, type StepCtx } from './Onboarding';
import { STEPS, activeCarriers, carriersWithoutTariff, stepState } from './steps';

// ---------- 3. Örnek faturalar (tarifelerden önce) ----------
const SAMPLE_MAX_MB = 20;

export function InvoicesStep({ ctx }: { ctx: StepCtx }) {
  const { t } = useTranslation('onboarding');
  const qc = useQueryClient();
  const { me } = useAuth();
  const carriers = activeCarriers(ctx.status);
  const withTariff = new Set(carriers.filter((c) => c.activeTariffCount > 0).map((c) => c.id));
  const inv = ctx.status.invoices;
  // tarife sonradan eklendiyse (geri dönüldü) faturalar burada da karşılaştırılır
  const comparing = useCompareSampleInvoices(ctx, withTariff);
  const [carrierId, setCarrierId] = useState('');
  const carrier = carriers.find((c) => c.id === carrierId) ?? (carriers.length === 1 ? carriers[0] : undefined);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // adımdan çıkılınca PDF okumasının beklenmesi kesilir (okuma sunucuda sürer; sonuç fatura yükleme sayfasındaki bantta)
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const upload = async (f: File) => {
    setErr(null);
    if (!carrier) {
      setErr(t('invoices.errors.pickCarrier'));
      return;
    }
    if (f.size > SAMPLE_MAX_MB * 1024 * 1024) {
      setErr(t('invoices.errors.tooLarge', { max: SAMPLE_MAX_MB }));
      return;
    }
    if (isBlockedPdf(f, me?.aiAvailable)) {
      setErr(t('invoices.pdfDisabled'));
      return;
    }
    setBusyFile(f.name);
    try {
      // Y80-E3: PDF arka planda okunur (iş), tablo bugünkü gibi tek istekte
      const r = f.name.toLowerCase().endsWith('.pdf') ? await uploadSamplePdf(f, carrier.id, () => aliveRef.current) : await invoices.uploadSample(f, carrier.id);
      if (!aliveRef.current) return;
      toast.ok(t('invoices.toast.read'), t('sample.linesCount', { count: r.lines }));
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
    } catch (e) {
      if (e instanceof SampleLeft) return;
      setErr(errorMessage(e));
    } finally {
      if (aliveRef.current) setBusyFile(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  const remove = async (id: string) => {
    try {
      await invoices.remove(id);
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
    } catch (e) {
      toast.err(t('invoices.toast.removeFailed'), errorMessage(e));
    }
  };

  return (
    <div className="ob-body">
      <Why>
        <Trans t={t} i18nKey="invoices.why" components={{ b: <b /> }} />
      </Why>
      {carriers.length === 0 ? (
        <div className="notif warn" role="status">
          <Icon name="warn" />
          <span>{t('invoices.needCarrier')}</span>
          <button type="button" className="link-btn act" onClick={() => ctx.go('tasiyicilar')}>
            {t('invoices.carriers')}
          </button>
        </div>
      ) : (
        <>
          {carriers.length > 1 && (
            <div className="ob-sample-car" role="radiogroup" aria-label={t('invoices.carrierOf')}>
              <span className="s13 t2">{t('invoices.carrierOfLabel')}</span>
              {carriers.map((c) => (
                <label key={c.id} className={`ob-chip${carrier?.id === c.id ? ' on' : ''}`}>
                  <input type="radio" name="ob-sample-car" checked={carrier?.id === c.id} onChange={() => setCarrierId(c.id)} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            hidden
            accept={acceptList(me?.aiAvailable !== false)}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
          />
          <button
            type="button"
            className={`drop ob-drop${over ? ' over' : ''}`}
            disabled={busyFile != null}
            onClick={() => (carrier ? inputRef.current?.click() : setErr(t('invoices.errors.pickCarrier')))}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) upload(f);
            }}
          >
            <span className="drop-ic">
              <Icon name={busyFile ? 'spin' : 'upload'} className={busyFile ? 'spin' : undefined} size={24} />
            </span>
            {busyFile ? (
              <>
                <b>{t('invoices.reading', { file: busyFile })}</b>
                <span className="muted">
                  {busyFile.toLowerCase().endsWith('.pdf') ? t('invoices.readingPdf') : t('invoices.readingShort')}
                </span>
              </>
            ) : (
              <>
                <b>{inv.length ? t('invoices.dropMore') : t('invoices.drop')}</b>
                <span className="muted">
                  {/* PDF okuma kapalıyken ipucu PDF vaat etmez (kabul listesiyle aynı kural) */}
                  {me?.aiAvailable === false
                    ? carrier
                      ? t('invoices.dropHintCarrierNoPdf', { name: carrier.name })
                      : t('invoices.dropHintNoPdf')
                    : carrier
                      ? t('invoices.dropHintCarrier', { name: carrier.name })
                      : t('invoices.dropHint')}
                </span>
              </>
            )}
          </button>
          {err && (
            <p className="ob-err" role="alert">
              <Icon name="err" /> {err}
            </p>
          )}
          <p className="ob-sample-note">
            <Icon name="eyeoff" /> {t('invoices.note')}
          </p>
          {inv.length > 0 && (
            <ul className="ob-invs mt16">
              {inv.map((i) => (
                <SampleInvoice
                  key={i.id}
                  invoice={i}
                  compared={withTariff.has(i.carrier.id) && !comparing && !i.linesWithoutTariff}
                  onRemove={() => remove(i.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <StepFoot ctx={ctx}>
        {inv.length > 0 ? (
          <Button icon="arrow" loading={ctx.moving} disabled={busyFile != null} onClick={() => ctx.next('done')}>
            {t('invoices.continueTariffs')}
          </Button>
        ) : (
          <Button kind="secondary" icon="arrow" loading={ctx.moving} disabled={busyFile != null} onClick={() => ctx.next('skipped')}>
            {t('invoices.continueWithout')}
          </Button>
        )}
      </StepFoot>
    </div>
  );
}

// ---------- 8. Özet ----------
export function SummaryStep({ ctx }: { ctx: StepCtx }) {
  const { t } = useTranslation('onboarding');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { refreshMe, person } = useAuth();
  const { t: tp } = useTranslation('platform');
  const [busy, setBusy] = useState(false);
  const s = ctx.status;
  const carriers = activeCarriers(s);
  const noTariff = carriersWithoutTariff(s);
  const rows = STEPS.filter((m) => m.key !== 'ozet');
  const missingRequired = rows.filter((m) => m.required && stepState(s, m.key) !== 'ok');

  const detail: Record<string, string> = {
    tasiyicilar: carriers.length ? carriers.map((c) => c.name).join(', ') : t('summary.detail.noCarriers'),
    tarifeler: carriers.length === 0 ? '—' : noTariff.length ? t('summary.detail.withoutTariff', { names: noTariff.map((c) => c.name).join(', ') }) : t('summary.detail.allTariffs'),
    olcum: t('summary.detail.rules'),
    koliler: t(stepState(s, 'koliler') !== 'ok' && s.boxPresets > 0 ? 'summary.detail.presetsUnreviewed' : 'summary.detail.presets', { count: s.boxPresets }),
    faturalar: s.invoices.length ? t('summary.detail.invoices', { count: s.invoices.length }) : t('summary.detail.noInvoices'),
  };

  const finish = async () => {
    setBusy(true);
    try {
      await ctx.patch({ complete: true, done: 'ozet' });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      await refreshMe().catch(() => undefined);
      toast.ok(t('summary.toast.done'), missingRequired.length ? t('summary.toast.doneMissing') : t('summary.toast.doneReady'));
      nav('/');
    } catch (e) {
      toast.err(t('summary.toast.failed'), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ob-body">
      <p className="t2">{t('summary.intro')}</p>
      <ul className="ob-check-list">
        {rows.map((m) => {
          const st = stepState(s, m.key);
          const tone = st === 'ok' ? 'ok' : m.required ? 'bad' : 'skip';
          return (
            <li key={m.key}>
              <button type="button" className={`ob-cl ${tone}`} onClick={() => ctx.go(m.key)}>
                <span className="ob-cl-ic" aria-hidden="true">
                  {st === 'ok' ? <Icon name="check" size={14} /> : m.required ? '!' : '–'}
                </span>
                <span className="grow ob-cl-t">
                  <span className="ob-step-tt">
                    <b>{t(`steps.${m.key}.title`)}</b>
                    <ReqTag required={m.required} />
                  </span>
                  <span>{detail[m.key]}</span>
                </span>
                <span className="ob-cl-st">{t(st === 'todo' && !m.required ? 'summary.state.notDone' : `summary.state.${st}`)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <section className="ds-team" aria-labelledby="ds-team-t">
        <span className="ds-team-ic" aria-hidden="true">
          <Icon name="users" size={20} />
        </span>
        <div className="grow">
          <h3 id="ds-team-t">{tp('team.title')}</h3>
          <p>{isOrgAdmin(person) ? tp('team.body') : tp('team.askAdmin')}</p>
        </div>
        {/* Merkez ayrı uygulama: tam sayfa gezinti */}
        {isOrgAdmin(person) && (
          <a className="btn btn-secondary" href="/account/team">
            {tp('team.link')} <Icon name="arrow" />
          </a>
        )}
      </section>
      {missingRequired.length > 0 && (
        <div className="notif warn mt16" role="status">
          <Icon name="warn" />
          <span>
            <b>{t('summary.missingRequired', { steps: missingRequired.map((m) => t(`steps.${m.key}.title`)).join(', ') })}</b>{' '}
            {noTariff.length > 0 && carriers.length > 0 ? `${t('summary.noTariffNote')} ` : ''}
            {carriers.length > 0 && t('summary.finishAnyway')}
          </span>
        </div>
      )}
      {carriers.length === 0 && (
        <p className="ob-err mt12" role="alert">
          <Icon name="err" /> {t('summary.needCarrier')}
        </p>
      )}
      <StepFoot ctx={ctx}>
        <Button icon="check" loading={busy} disabled={carriers.length === 0 || ctx.moving} onClick={finish}>
          {t('summary.finish')}
        </Button>
      </StepFoot>
    </div>
  );
}
