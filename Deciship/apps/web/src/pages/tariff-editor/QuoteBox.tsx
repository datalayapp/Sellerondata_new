import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { tariffs } from '../../api/endpoints';
import type { QuoteResult } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Affix, Button, Field, errorMessage } from '../../components/ui';
import { fmtKg, fmtMoney, parseMeasure } from '../../lib/format';

export function QuoteBox({ tariffId, dirty, currency }: { tariffId?: string; dirty: boolean; currency: string }) {
  const { t } = useTranslation('tariffEditor');
  const [f, setF] = useState({ l: '40', w: '30', h: '25', kg: '4', country: '' });
  const m = useMutation({
    mutationFn: () =>
      tariffs.quote(tariffId!, {
        lengthCm: parseMeasure(f.l) ?? 0,
        widthCm: parseMeasure(f.w) ?? 0,
        heightCm: parseMeasure(f.h) ?? 0,
        weightKg: parseMeasure(f.kg) ?? 0,
        destCountry: f.country.trim().toUpperCase() || undefined,
      }),
  });
  const valid = [f.l, f.w, f.h, f.kg].every((x) => (parseMeasure(x) ?? 0) > 0);
  const r: QuoteResult | undefined = m.data;
  return (
    <section className="card qt" aria-labelledby="qt-h">
      <div className="qt-head">
        <span className="qt-ic" aria-hidden="true">
          <Icon name="calc" />
        </span>
        <div className="grow">
          <h2 className="tt" id="qt-h">
            {t('quote.title')}
          </h2>
          <p className="card-desc">{t('quote.desc')}</p>
        </div>
      </div>
      {!tariffId ? (
        <p className="qt-empty">{t('quote.saveFirst')}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) m.mutate();
          }}
        >
          <div className="qt-grid">
            <Field label={t('quote.length')} htmlFor="q-l">
              <Affix sfx="cm">
                <input id="q-l" data-measure className="inp sm num" inputMode="decimal" value={f.l} onChange={(e) => setF({ ...f, l: e.target.value })} />
              </Affix>
            </Field>
            <Field label={t('quote.width')} htmlFor="q-w">
              <Affix sfx="cm">
                <input id="q-w" data-measure className="inp sm num" inputMode="decimal" value={f.w} onChange={(e) => setF({ ...f, w: e.target.value })} />
              </Affix>
            </Field>
            <Field label={t('quote.height')} htmlFor="q-h">
              <Affix sfx="cm">
                <input id="q-h" data-measure className="inp sm num" inputMode="decimal" value={f.h} onChange={(e) => setF({ ...f, h: e.target.value })} />
              </Affix>
            </Field>
            <Field label={t('quote.weight')} htmlFor="q-kg">
              <Affix sfx="kg">
                <input id="q-kg" data-measure className="inp sm num" inputMode="decimal" value={f.kg} onChange={(e) => setF({ ...f, kg: e.target.value })} />
              </Affix>
            </Field>
            <Field label={t('quote.destCountry')} htmlFor="q-c">
              <input id="q-c" className="inp sm mono" maxLength={2} placeholder="DE" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} />
            </Field>
          </div>
          <Button type="submit" kind="secondary" icon="calc" loading={m.isPending} disabled={!valid} className="btn-block qt-btn">
            {t('quote.calculate')}
          </Button>
          {dirty && (
            <p className="qt-note">
              <Icon name="warn" size={14} /> {t('quote.unsavedNote')}
            </p>
          )}
        </form>
      )}
      {m.isError && <p className="red s12 mt8">{errorMessage(m.error)}</p>}
      {r && (
        <div className={`quote-res${r.ok ? "" : " bad"}`} aria-live="polite">
          {r.ok ? (
            <>
              <div className="qt-res-l">{t('quote.expectedAmount')}</div>
              <div className="quote-total num">{fmtMoney(r.total, currency)}</div>
              <div className="qt-chips">
                <span className="qt-chip">{t('quote.zone', { zone: r.zone })}</span>
                {r.chargeableKg != null && <span className="qt-chip num">{t('quote.billable', { kg: fmtKg(r.chargeableKg) })}</span>}
              </div>
              <table className="pb">
                <tbody>
                  {(r.lines?.length
                    ? r.lines
                    : [
                        { label: t('quote.base'), amount: r.base },
                        { label: t('quote.discount'), amount: -r.discount },
                        { label: t('quote.fuel'), amount: r.fuel },
                        ...(r.surcharges ? [{ label: t('quote.surcharges'), amount: r.surcharges }] : []),
                      ]
                  ).map((x, i) => (
                    <tr key={i}>
                      <td>{x.label}</td>
                      <td>{fmtMoney(x.amount, currency)}</td>
                    </tr>
                  ))}
                  <tr className="tot">
                    <td>{t('quote.expected')}</td>
                    <td>{fmtMoney(r.total, currency)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : (
            <div className="notif warn">
              <Icon name="warn" />
              <span>{r.reason}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
