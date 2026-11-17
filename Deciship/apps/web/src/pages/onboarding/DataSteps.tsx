import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { boxPresets, tariffs } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { Button, Empty, Tag, errorMessage } from '../../components/ui';
import { withReturn } from '../../lib/returnTo';
import { BoxPresets } from '../Settings';
import { StepFoot, Why, type StepCtx } from './Onboarding';
import { SampleInvoice, useCompareSampleInvoices } from './SampleInvoice';
import { activeCarriers, carriersWithoutTariff } from './steps';

const back = (adim: string) => `/setup?adim=${adim}`;

// ---------- 4. Tarifeler ----------
export function TariffsStep({ ctx }: { ctx: StepCtx }) {
  const { t } = useTranslation('onboarding');
  const list = activeCarriers(ctx.status);
  const missing = carriersWithoutTariff(ctx.status);
  const [tplBusy, setTplBusy] = useState(false);
  const ret = back('tarifeler');
  const inv = ctx.status.invoices;
  const withTariff = new Set(list.filter((c) => c.activeTariffCount > 0).map((c) => c.id));
  const comparing = useCompareSampleInvoices(ctx, withTariff);

  return (
    <div className="ob-body">
      <Why>
        <Trans t={t} i18nKey="tariffs.why" components={{ b: <b /> }} />
      </Why>
      {list.length > 0 &&
        (inv.length > 0 ? (
          <div className="notif info" role="status">
            <Icon name="info" />
            <span>
              {t('tariffs.hasSamples', { count: inv.length })}
            </span>
          </div>
        ) : (
          <div className="notif info" role="status">
            <Icon name="info" />
            <span>
              {t('tariffs.tip')}
            </span>
            <button type="button" className="link-btn act" onClick={() => ctx.go('faturalar')}>
              {t('tariffs.uploadSample')}
            </button>
          </div>
        ))}
      {list.length === 0 ? (
        <Empty
          compact
          icon="truck"
          title={t('tariffs.needCarrier')}
          actions={
            <Button kind="secondary" icon="back" onClick={() => ctx.go('tasiyicilar')}>
              {t('tariffs.backToCarriers')}
            </Button>
          }
        >
          {t('tariffs.tariffBound')}
        </Empty>
      ) : (
        <ul className="ob-tariffs">
          {list.map((c) => {
            const newUrl = withReturn(`/tariffs/new?carrierId=${c.id}`, ret);
            return (
              <li key={c.id} className="ob-tr">
                <div className="ob-tr-h">
                  <b>{c.name}</b>
                  {c.activeTariffCount > 0 ? (
                    <Tag tone="green">{t('tariffs.count', { count: c.activeTariffCount })}</Tag>
                  ) : (
                    <Tag tone="yellow">{t('tariffs.none')}</Tag>
                  )}
                </div>
                {c.tariffs.length > 0 && (
                  <ul className="ob-tr-list">
                    {c.tariffs.map((tf) => (
                      <li key={tf.id}>
                        <Link to={withReturn(`/tariffs/${tf.id}`, ret)}>{tf.name}</Link>
                        {tf.isDefault && (
                          <Tag tone="blue" small>
                            {t('tariffs.default')}
                          </Tag>
                        )}
                        {!tf.active && (
                          <Tag tone="gray" small>
                            {t('common.inactive')}
                          </Tag>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="ob-tr-acts">
                  <Link className="btn btn-secondary btn-sm" to={newUrl}>
                    <Icon name="upload" /> {t('tariffs.uploadFile')}
                  </Link>
                  <Link className="btn btn-ghost btn-sm" to={withReturn(`/tariffs/new?carrierId=${c.id}&elle=1`, ret)}>
                    <Icon name="edit" /> {t('tariffs.createManually')}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="s13 t3 mt12">
        {t('tariffs.templateLead')}{' '}
        <button
          type="button"
          className="link-btn"
          disabled={tplBusy}
          onClick={async () => {
            setTplBusy(true);
            try {
              await tariffs.downloadTemplate();
            } catch (e) {
              toast.err(t('tariffs.templateFailed'), errorMessage(e));
            } finally {
              setTplBusy(false);
            }
          }}
        >
          {t('tariffs.templateLink')}
        </button>
        {t('tariffs.templateTail')}
      </p>
      {inv.length > 0 && list.length > 0 && (
        <section className="mt24" aria-labelledby="ob-chk-t">
          <div className="ob-cal-h">
            <b id="ob-chk-t">{t('tariffs.check.title')}</b>
            {comparing && (
              <span className="t3 s13" role="status">
                <Icon name="spin" /> {t('tariffs.check.comparing')}
              </span>
            )}
          </div>
          <p className="s13 t3 ob-sub-desc">
            {t('tariffs.check.desc')}
          </p>
          <ul className="ob-invs">
            {inv.map((i) => (
              <SampleInvoice key={i.id} invoice={i} compared={withTariff.has(i.carrier.id) && !comparing && !i.linesWithoutTariff} />
            ))}
          </ul>
        </section>
      )}
      {list.length > 0 && missing.length > 0 && (
        <div className="notif warn mt16" role="status">
          <Icon name="warn" />
          <span>
            <Trans t={t} i18nKey="tariffs.missing" values={{ names: missing.map((c) => c.name).join(', ') }} components={{ b: <b /> }} />
          </span>
        </div>
      )}
      <StepFoot ctx={ctx}>
        {missing.length === 0 && list.length > 0 ? (
          <Button icon="arrow" loading={ctx.moving} onClick={() => ctx.next('done')}>
            {t('common.continue')}
          </Button>
        ) : (
          <Button kind="secondary" icon="arrow" loading={ctx.moving} onClick={() => ctx.next('skipped')}>
            {t('tariffs.skipNotRecommended')}
          </Button>
        )}
      </StepFoot>
    </div>
  );
}

// ---------- 6. Hazır koliler ----------
export function PresetsStep({ ctx }: { ctx: StepCtx }) {
  const { t } = useTranslation('onboarding');
  // BoxPresets ile aynı önbellek: adımda yapılan ekleme/silme sayıya hemen yansır
  const pq = useQuery({ queryKey: ['box-presets'], queryFn: boxPresets.list });
  const active = pq.data ? pq.data.filter((p) => p.active).length : ctx.status.boxPresets;
  return (
    <div className="ob-body">
      <Why>
        {t('presets.why')}
      </Why>
      <BoxPresets />
      <StepFoot ctx={ctx}>
        <Button kind="ghost" disabled={ctx.moving} onClick={() => ctx.next('skipped')}>
          {t('common.skip')}
        </Button>
        <Button icon="arrow" loading={ctx.moving} onClick={() => ctx.next(active > 0 ? 'done' : 'skipped')}>
          {t('common.continue')}
        </Button>
      </StepFoot>
    </div>
  );
}

