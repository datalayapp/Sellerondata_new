import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { carriers, settings } from '../../api/endpoints';
import type { CarrierCode } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { Affix, Button, ErrorState, Field, Skel, Tag, errorMessage } from '../../components/ui';
import { desiOf, fmtNum, numToInput, parseMeasure, parseTrNumber } from '../../lib/format';
import { relocalizeFields, useLocaleSwitch } from '../../lib/localeSwitch';
import { CARRIER_OPTIONS } from '../../lib/labels';
import { StepFoot, Why, type StepCtx } from './Onboarding';
import { activeCarriers, currencySymbol } from './steps';

// ---------- 2. Taşıyıcılar ----------
/** Değer: `onboarding` ad alanında `carriers.hint.<değer>` anahtarı. */
const CARRIER_HINT: Partial<Record<CarrierCode, 'express' | 'domestic' | 'other'>> = {
  fedex: 'express',
  ups: 'express',
  dhl: 'express',
  aras: 'domestic',
  yurtici: 'domestic',
  mng: 'domestic',
  ptt: 'domestic',
  generic: 'other',
};

export function CarriersStep({ ctx }: { ctx: StepCtx }) {
  const { t } = useTranslation('onboarding');
  const qc = useQueryClient();
  const { refreshMe } = useAuth();
  const existing = activeCarriers(ctx.status);
  const has = (code: CarrierCode) => existing.some((c) => c.code === code);
  const [sel, setSel] = useState<CarrierCode[]>([]);
  const [otherName, setOtherName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const total = existing.length + sel.length;
  const errs = {
    none: total === 0 ? t('carriers.errors.none') : null,
    other: sel.includes('generic') && !otherName.trim() ? t('carriers.errors.otherName') : null,
  };

  const toggle = (code: CarrierCode) => setSel((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]));

  const save = async () => {
    setTouched(true);
    if (errs.none || errs.other) return;
    setBusy(true);
    try {
      for (const code of sel) {
        await carriers.create({ code, name: code === 'generic' ? otherName.trim() : (CARRIER_OPTIONS.find((o) => o.code === code)?.name ?? code) });
      }
      if (sel.length) toast.ok(t('carriers.added', { count: sel.length }));
      qc.invalidateQueries({ queryKey: ['carriers'] });
      setSel([]);
      await refreshMe().catch(() => undefined);
      await ctx.next('done');
    } catch (e) {
      toast.err(t('carriers.addFailed'), errorMessage(e));
      qc.invalidateQueries({ queryKey: ['onboarding'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ob-body">
      <Why>
        {t('carriers.why')}
      </Why>
      <fieldset className="ob-carriers" aria-describedby={touched && errs.none ? 'ob-car-err' : undefined}>
        <legend className="sr-only">{t('carriers.legend')}</legend>
        {CARRIER_OPTIONS.map((o) => {
          const added = has(o.code) && o.code !== 'generic';
          const on = added || sel.includes(o.code);
          return (
            <label key={o.code} className={`ob-car${on ? ' on' : ''}${added ? ' added' : ''}`}>
              <input type="checkbox" checked={on} disabled={added} onChange={() => toggle(o.code)} />
              <span className="ob-car-t">
                <b>{o.code === 'generic' ? t('carriers.other') : o.name}</b>
                <span>{CARRIER_HINT[o.code] && t(`carriers.hint.${CARRIER_HINT[o.code]}`)}</span>
              </span>
              {added && (
                <Tag tone="green" small>
                  {t('carriers.addedTag')}
                </Tag>
              )}
            </label>
          );
        })}
      </fieldset>
      {sel.includes('generic') && (
        <Field label={t('carriers.otherName')} htmlFor="ob-other" className="req mt16" error={touched ? errs.other : null} help={t('carriers.otherNameHelp')}>
          <input id="ob-other" className="inp w-lg" value={otherName} onChange={(e) => setOtherName(e.target.value)} />
        </Field>
      )}
      {existing.some((c) => c.code === 'generic') && (
        <p className="s13 t3 mt8">
          {t('carriers.otherAdded', { names: existing.filter((c) => c.code === 'generic').map((c) => c.name).join(', ') })}
        </p>
      )}
      {touched && errs.none && (
        <p id="ob-car-err" className="ob-err" role="alert">
          <Icon name="err" /> {errs.none}
        </p>
      )}
      <StepFoot ctx={ctx} note={total > 0 ? t('carriers.count', { count: total }) : undefined}>
        <Button icon="arrow" loading={busy || ctx.moving} onClick={save}>
          {sel.length ? t('carriers.addContinue') : t('common.continue')}
        </Button>
      </StepFoot>
    </div>
  );
}

// ---------- 4. Ölçüm kuralları ----------
type RulesForm = {
  desiDivisor: string;
  requiredBoxPhotos: string;
  edgeTolCm: string;
  weightTolKg: string;
  amountTol: string;
  fxTolerancePct: string;
  unknownSurchargesAsDiff: boolean;
};

export function RulesStep({ ctx }: { ctx: StepCtx }) {
  const { t } = useTranslation('onboarding');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: settings.get });
  const [f, setF] = useState<RulesForm | null>(null);
  // K36 incelemesi: arayüz dili değişince yazılmış sayılar anlamını korur (Türkçe "6.000" İngilizcede 6 olmasın)
  useLocaleSwitch((from, to) => setF((x) => x && relocalizeFields(x, ['amountTol', 'fxTolerancePct'], ['edgeTolCm', 'weightTolKg'], from, to)));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !f)
      setF({
        desiDivisor: String(q.data.desiDivisor ?? 3000),
        requiredBoxPhotos: String(q.data.requiredBoxPhotos ?? 1),
        edgeTolCm: numToInput(q.data.edgeTolCm),
        weightTolKg: numToInput(q.data.weightTolKg),
        amountTol: numToInput(q.data.amountTol, 2),
        fxTolerancePct: numToInput(q.data.fxTolerancePct ?? 1.5, 2),
        unknownSurchargesAsDiff: q.data.unknownSurchargesAsDiff === true,
      });
  }, [q.data, f]);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!f) return <Skel h={320} />;

  // ölçü toleransları (cm, kg) binliksiz okunur; tutar ve yüzde parseTrNumber ile
  const range = (v: string, min: number, max: number, msg: string, parse: (s: string) => number | null = parseTrNumber) => {
    const n = parse(v);
    return n == null || n < min || n > max ? msg : null;
  };
  const errs = {
    desiDivisor: !/^\d+$/.test(f.desiDivisor.trim()) || Number(f.desiDivisor) < 1000 || Number(f.desiDivisor) > 10000 ? t('rules.errors.divisor') : null,
    requiredBoxPhotos: !/^\d+$/.test(f.requiredBoxPhotos.trim()) || Number(f.requiredBoxPhotos) > 10 ? t('rules.errors.photos') : null,
    edgeTolCm: range(f.edgeTolCm, 0, 10, t('rules.errors.range10'), parseMeasure),
    weightTolKg: range(f.weightTolKg, 0, 100, t('rules.errors.range100'), parseMeasure),
    amountTol: range(f.amountTol, 0, 1_000_000, t('rules.errors.amount')),
    fxTolerancePct: range(f.fxTolerancePct, 0, 20, t('rules.errors.pct')),
  };
  const set = (k: keyof RulesForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const inv = (k: keyof typeof errs) => (touched && !!errs[k]) || undefined;
  const sym = currencySymbol(ctx.status.company.currency);
  const div = Number(f.desiDivisor) || 3000;

  const save = async () => {
    setTouched(true);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const s = await settings.update({
        desiDivisor: Number(f.desiDivisor),
        requiredBoxPhotos: Number(f.requiredBoxPhotos),
        edgeTolCm: parseMeasure(f.edgeTolCm)!,
        weightTolKg: parseMeasure(f.weightTolKg)!,
        amountTol: parseTrNumber(f.amountTol)!,
        fxTolerancePct: parseTrNumber(f.fxTolerancePct)!,
        unknownSurchargesAsDiff: f.unknownSurchargesAsDiff,
      });
      qc.setQueryData(['settings'], s);
      await ctx.next('done');
    } catch (e) {
      toast.err(t('common.saveFailed'), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ob-body"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Why>
        <Trans t={t} i18nKey="rules.why" components={{ b: <b /> }} />
      </Why>

      <h3 className="ob-sub">{t('rules.mobile.title')}</h3>
      <div className="form-grid ob-grid">
        <Field
          label={t('rules.mobile.divisor')}
          htmlFor="ob-div"
          className="req"
          error={touched ? errs.desiDivisor : null}
          help={t('rules.mobile.divisorHelp', { desi: fmtNum(desiOf(40, 30, 25, div), 0, 2) })}
        >
          <input id="ob-div" className="inp num w-sm" inputMode="numeric" value={f.desiDivisor} aria-invalid={inv('desiDivisor')} onChange={set('desiDivisor')} />
        </Field>
        <Field
          label={t('rules.mobile.photos')}
          htmlFor="ob-ph"
          className="req"
          error={touched ? errs.requiredBoxPhotos : null}
          help={t('rules.mobile.photosHelp')}
        >
          <Affix sfx={t('rules.mobile.unitPcs')} className="ob-unit">
            <input id="ob-ph" className="inp num" inputMode="numeric" value={f.requiredBoxPhotos} aria-invalid={inv('requiredBoxPhotos')} onChange={set('requiredBoxPhotos')} />
          </Affix>
        </Field>
      </div>

      <h3 className="ob-sub">{t('rules.tol.title')}</h3>
      <p className="s13 t3 ob-sub-desc">{t('rules.tol.desc')}</p>
      <div className="form-grid c3 ob-grid">
        <Field label={t('rules.tol.edge')} htmlFor="ob-edge" error={touched ? errs.edgeTolCm : null} help={t('rules.tol.edgeHelp')}>
          <Affix sfx="cm" className="ob-unit">
            <input id="ob-edge" className="inp num" inputMode="decimal" value={f.edgeTolCm} aria-invalid={inv('edgeTolCm')} onChange={set('edgeTolCm')} />
          </Affix>
        </Field>
        <Field label={t('rules.tol.weight')} htmlFor="ob-wt" error={touched ? errs.weightTolKg : null} help={t('rules.tol.weightHelp')}>
          <Affix sfx="kg" className="ob-unit">
            <input id="ob-wt" className="inp num" inputMode="decimal" value={f.weightTolKg} aria-invalid={inv('weightTolKg')} onChange={set('weightTolKg')} />
          </Affix>
        </Field>
        <Field label={t('rules.tol.amount')} htmlFor="ob-amt" error={touched ? errs.amountTol : null} help={t('rules.tol.amountHelp')}>
          <Affix sfx={sym} className="ob-unit">
            <input id="ob-amt" className="inp num" inputMode="decimal" value={f.amountTol} aria-invalid={inv('amountTol')} onChange={set('amountTol')} />
          </Affix>
        </Field>
        <Field label={t('rules.tol.fx')} htmlFor="ob-fx" error={touched ? errs.fxTolerancePct : null} help={t('rules.tol.fxHelp')}>
          <Affix sfx="%" className="ob-unit">
            <input id="ob-fx" className="inp num" inputMode="decimal" value={f.fxTolerancePct} aria-invalid={inv('fxTolerancePct')} onChange={set('fxTolerancePct')} />
          </Affix>
        </Field>
      </div>
      <label className="check ob-check">
        <input type="checkbox" checked={f.unknownSurchargesAsDiff} onChange={(e) => setF({ ...f, unknownSurchargesAsDiff: e.target.checked })} />
        <span>
          {t('rules.tol.unknownSurcharges')}
          <span className="ob-check-sub">{t('rules.tol.unknownSurchargesHelp')}</span>
        </span>
      </label>
      <StepFoot ctx={ctx}>
        <Button type="submit" icon="arrow" loading={busy || ctx.moving}>
          {t('rules.confirmContinue')}
        </Button>
      </StepFoot>
    </form>
  );
}
