import { useTranslation } from 'react-i18next';
import type { EdgeRounding } from '../../api/types';
import { Affix, Button, Field } from '../../components/ui';
import { WeightChoice } from '../../components/WeightChoice';
import { fmtKg, fmtMoney, fmtNum, parseTrNumber } from '../../lib/format';
import { weightChoice } from '../../lib/weightChoice';
import { CURRENCIES } from '../../lib/labels';
import { applyScope, curSym, pctFieldState, scopeChoosable, withCarrier, type Draft } from './draft';
import { Sec, useTariffReadOnly } from './Sec';

export function GeneralSection({
  d,
  set,
  carriers: cs,
  isNew,
}: {
  d: Draft;
  set: (p: Partial<Draft>) => void;
  carriers: { id: string; name: string; code: string }[];
  isNew: boolean;
}) {
  const { t } = useTranslation('tariffEditor');
  const carrier = cs.find((c) => c.id === d.carrierId);
  // yeni tarifede PTT ve "Diğer" için yurt içi / yurt dışı seçimi: bölen ve yakıt türünü doldurur (KALANLAR 1.1)
  const showScope = isNew && d.scope !== undefined && scopeChoosable(carrier?.code);
  return (
    <Sec id="te-gen" title={t('general.title')} desc={t('general.desc')}>
      <div className="form-grid c3">
        <Field label={t('general.name')} htmlFor="t-name" className="span2 req">
          <input id="t-name" className="inp" value={d.name} placeholder="FedEx International Economy 2026" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('general.carrier')} htmlFor="t-car" help={isNew ? undefined : t('general.carrierLocked')}>
          <select
            id="t-car"
            className="sel"
            value={d.carrierId}
            disabled={!isNew}
            onChange={(e) => {
              const next = cs.find((c) => c.id === e.target.value);
              set(next ? withCarrier(d, next) : { carrierId: e.target.value });
            }}
          >
            {!d.carrierId && <option value="">{t('general.select')}</option>}
            {cs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('general.service')} htmlFor="t-svc">
          <input id="t-svc" className="inp" value={d.service} placeholder={t('general.servicePlaceholder')} onChange={(e) => set({ service: e.target.value })} />
        </Field>
        <Field label={t('general.currency')} htmlFor="t-cur">
          <select id="t-cur" className="sel w-sm" value={d.currency} onChange={(e) => set({ currency: e.target.value })}>
            {Array.from(new Set([d.currency, ...CURRENCIES])).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {showScope ? (
          <Field label={t('general.scope')} htmlFor="t-scope" help={t('general.scopeHelp')}>
            <select id="t-scope" className="sel w-md" value={d.scope} onChange={(e) => set(applyScope(d, e.target.value === 'domestic' ? 'domestic' : 'international'))}>
              <option value="domestic">{t('general.scopeDomestic')}</option>
              <option value="international">{t('general.scopeInternational')}</option>
            </select>
          </Field>
        ) : (
          <div className="te-gap" aria-hidden="true" />
        )}
        <Field label={t('general.validFrom')} htmlFor="t-from">
          <input id="t-from" type="date" className="inp w-md" value={d.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
        </Field>
        <Field label={t('general.validTo')} htmlFor="t-to" help={t('general.validToHelp')}>
          <input id="t-to" type="date" className="inp w-md" value={d.validTo} onChange={(e) => set({ validTo: e.target.value })} />
        </Field>
      </div>
      <div className="te-checks">
        <label className="check">
          <input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />
          <span>
            {t('general.active')} <span className="te-check-sub">{t('general.activeSub')}</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={d.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} />
          <span>
            {t('general.default')} <span className="te-check-sub">{t('general.defaultSub')}</span>
          </span>
        </label>
      </div>
    </Sec>
  );
}

export function WeightSection({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  const div = parseTrNumber(d.divisor);
  const example = div && div > 0 ? (40 * 30 * 25) / div : null;
  return (
    <Sec
      id="te-w"
      title={t('weight.title')}
      desc={t('weight.desc')}
    >
      <div className="form-grid c3">
        <Field label={t('weight.divisor')} htmlFor="t-div" className="req" help={t('weight.divisorHelp')}>
          <input id="t-div" className="inp num w-sm" inputMode="numeric" value={d.divisor} onChange={(e) => set({ divisor: e.target.value })} />
        </Field>
        <Field label={t('weight.edge')} htmlFor="t-edge" help={t('weight.edgeHelp')}>
          <select id="t-edge" className="sel w-md" value={d.edgeRounding} onChange={(e) => set({ edgeRounding: e.target.value as EdgeRounding })}>
            <option value="CEIL_CM">{t('weight.edgeCeil')}</option>
            <option value="NONE">{t('weight.edgeNone')}</option>
          </select>
        </Field>
        <div className="te-example">
          <span className="te-example-l">{t('weight.example')}</span>
          <span className="num">40 × 30 × 25 cm</span>
          <span className="num sb">{example != null ? `→ ${fmtKg(example)}` : '→ —'}</span>
        </div>
      </div>

      <div className="te-sub">
        <h3 className="te-sub-h">{t('weight.steps.title')}</h3>
        <p className="te-sub-d">{t('weight.steps.desc')}</p>
        <div className="te-mini-wrap">
          <table className="te-mini">
            <thead>
              <tr>
                <th>{t('weight.steps.upto')}</th>
                <th>{t('weight.steps.step')}</th>
                {!readOnly && (
                  <th>
                    <span className="sr-only">{t('common.delete')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {d.steps.map((s, i) => (
                <tr key={i}>
                  <td>
                    <Affix sfx="kg">
                      <input
                        aria-label={t('weight.steps.uptoAria', { n: i + 1 })}
                        className={`inp sm num${(s.upto.trim() && parseTrNumber(s.upto) === null) || weightChoice(s.upto) ? ' invalid' : ''}`}
                        inputMode="decimal"
                        placeholder={t('weight.steps.unlimited')}
                        value={s.upto}
                        onChange={(e) => set({ steps: d.steps.map((x, j) => (j === i ? { ...x, upto: e.target.value } : x)) })}
                      />
                    </Affix>
                    {!readOnly && <WeightChoice value={s.upto} onPick={(v) => set({ steps: d.steps.map((x, j) => (j === i ? { ...x, upto: v } : x)) })} />}
                  </td>
                  <td>
                    <Affix sfx="kg">
                      <input
                        aria-label={t('weight.steps.stepAria', { n: i + 1 })}
                        className={`inp sm num${(s.step && parseTrNumber(s.step) === null) || weightChoice(s.step) ? ' invalid' : ''}`}
                        inputMode="decimal"
                        value={s.step}
                        onChange={(e) => set({ steps: d.steps.map((x, j) => (j === i ? { ...x, step: e.target.value } : x)) })}
                      />
                    </Affix>
                    {!readOnly && <WeightChoice value={s.step} onPick={(v) => set({ steps: d.steps.map((x, j) => (j === i ? { ...x, step: v } : x)) })} />}
                  </td>
                  {!readOnly && (
                    <td>
                      <Button kind="plain" small icon="trash" aria-label={t('weight.steps.deleteAria', { n: i + 1 })} onClick={() => set({ steps: d.steps.filter((_, j) => j !== i) })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <Button kind="ghost" small icon="plus" className="te-add" onClick={() => set({ steps: [...d.steps, { upto: '', step: '1' }] })}>
            {t('weight.steps.add')}
          </Button>
        )}
      </div>
    </Sec>
  );
}

export function PricingSection({ d, set, fuelDefault }: { d: Draft; set: (p: Partial<Draft>) => void; fuelDefault?: boolean }) {
  const { t } = useTranslation('tariffEditor');
  const disc = parseTrNumber(d.discountPct) ?? 0;
  const fuel = parseTrNumber(d.fuelPct) ?? 0;
  // dolu ama okunamayan değer %0 sayılmaz: alan işaretlenir, kayıt durur (10-B6)
  const discState = pctFieldState(d.discountPct);
  const fuelState = pctFieldState(d.fuelPct);
  const badDisc = discState !== null;
  const badFuel = fuelState !== null;
  const fieldError = (s: typeof discState) => (s === 'unreadable' ? t('pricing.unreadable') : s === 'range' ? t('pricing.range') : null);
  return (
    <Sec id="te-p" title={t('pricing.title')} desc={t('pricing.desc')}>
      <div className="form-grid c3">
        <Field label={t('pricing.discount')} htmlFor="t-disc" help={t('pricing.discountHelp')} error={fieldError(discState)}>
          <Affix sfx="%" className="w-sm">
            <input id="t-disc" className="inp num" inputMode="decimal" aria-invalid={badDisc || undefined} value={d.discountPct} onChange={(e) => set({ discountPct: e.target.value })} />
          </Affix>
        </Field>
        <Field label={t('pricing.fuel')} htmlFor="t-fuel" help={t('pricing.fuelHelp')} error={fieldError(fuelState)}>
          <Affix sfx="%" className="w-sm">
            <input id="t-fuel" className="inp num" inputMode="decimal" aria-invalid={badFuel || undefined} value={d.fuelPct} onChange={(e) => set({ fuelPct: e.target.value })} />
          </Affix>
        </Field>
        <Field label={t('pricing.fuelMode')} htmlFor="t-fuelvar" help={t('pricing.fuelModeHelp')}>
          <select
            id="t-fuelvar"
            className="sel w-md"
            value={(d.fuelVariable ?? fuelDefault ?? true) ? 'variable' : 'fixed'}
            onChange={(e) => set({ fuelVariable: e.target.value === 'variable' })}
          >
            <option value="variable">{t('pricing.fuelVariable')}</option>
            <option value="fixed">{t('pricing.fuelFixed')}</option>
          </select>
        </Field>
        <div className="te-example te-formula">
          <span className="te-example-l">{t('pricing.exampleLabel', { sym: curSym(d.currency) })}</span>
          <span className="num">{t('pricing.exampleFormula', { disc: fmtNum(disc, 0, 2), fuel: fmtNum(fuel, 0, 2) })}</span>
          <span className="num sb">→ {fmtMoney(100 * (1 - disc / 100) * (1 + fuel / 100), d.currency)}</span>
        </div>
      </div>
    </Sec>
  );
}
