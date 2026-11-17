import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImportIssue, TariffImportDraft } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Affix, Field, Tag } from '../../components/ui';
import { currencySymbol } from '@deciship/core';
import { fmtNum } from '../../lib/format';
import { CURRENCIES } from '../../lib/labels';
import { Detail, IssueList, bandText, fmtD, fmtRatio, isOutlier } from './shared';
import { DocChip, SourceBody } from './WizardParts';

/** Yeni tarife formu (içe aktarma sihirbazında). */
export interface NewForm {
  name: string;
  service: string;
  validFrom: string;
  discountPct: string;
  fuelPct: string;
  divisor: string;
  /** yakıt değişken mi (yeni tarife; varsayılan taşıyıcının kapsamından) */
  fuelMode: 'variable' | 'fixed';
}

/** Yeni tarife: ad, hizmet, para birimi, bölen, yakıt, geçerlilik. */
export function NewTariffFields({
  form,
  edit,
  nameErr,
  onNameTouched,
  divBad,
  fuelBad,
  discountBad,
  tariffCur,
  curBusy,
  onCurrency,
}: {
  form: NewForm;
  edit: (k: keyof NewForm, v: string) => void;
  nameErr: boolean;
  onNameTouched: () => void;
  divBad: boolean;
  fuelBad: boolean;
  discountBad: boolean;
  tariffCur: string;
  curBusy: boolean;
  onCurrency: (c: string) => void;
}) {
  const { t: tr } = useTranslation('tariffImport');
  return (
    <section className="iw-new" aria-labelledby="iw-new-h">
      <h3 id="iw-new-h" className="iw-sec-h">
        {tr('newFields.title')}
      </h3>
      <div className="form-grid c3">
        <Field label={tr('newFields.name')} htmlFor="iw-name" className="span2 req" error={nameErr ? tr('newFields.nameRequired') : null}>
          <input
            id="iw-name"
            className="inp"
            value={form.name}
            placeholder={tr('newFields.namePlaceholder')}
            aria-invalid={nameErr || undefined}
            onBlur={onNameTouched}
            onChange={(e) => {
              onNameTouched();
              edit('name', e.target.value);
            }}
          />
        </Field>
        <Field label={tr('newFields.service')} htmlFor="iw-svc" help={tr('newFields.serviceHelp')}>
          <input id="iw-svc" className="inp" value={form.service} placeholder={tr('newFields.servicePlaceholder')} onChange={(e) => edit('service', e.target.value)} />
        </Field>
        <Field label={tr('newFields.currency')} htmlFor="iw-cur">
          <select id="iw-cur" className="sel w-sm" value={tariffCur} disabled={curBusy} onChange={(e) => onCurrency(e.target.value)}>
            {Array.from(new Set([tariffCur, ...CURRENCIES])).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label={tr('newFields.divisor')} htmlFor="iw-div" className="req" help={tr('newFields.divisorHelp')} error={divBad ? tr('newFields.divisorBad') : null}>
          <input id="iw-div" className="inp num w-sm" inputMode="numeric" value={form.divisor} aria-invalid={divBad || undefined} onChange={(e) => edit('divisor', e.target.value)} />
        </Field>
        <Field label={tr('newFields.discount')} htmlFor="iw-disc" help={tr('newFields.discountHelp')} error={discountBad ? tr('newFields.fuelBad') : null}>
          <Affix sfx="%" className="w-sm">
            <input id="iw-disc" className="inp num" inputMode="decimal" value={form.discountPct} placeholder="0" aria-invalid={discountBad || undefined} onChange={(e) => edit('discountPct', e.target.value)} />
          </Affix>
        </Field>
        <Field label={tr('newFields.fuel')} htmlFor="iw-fuel" error={fuelBad ? tr('newFields.fuelBad') : null}>
          <Affix sfx="%" className="w-sm">
            <input id="iw-fuel" className="inp num" inputMode="decimal" value={form.fuelPct} placeholder="0" aria-invalid={fuelBad || undefined} onChange={(e) => edit('fuelPct', e.target.value)} />
          </Affix>
        </Field>
        <Field label={tr('newFields.fuelMode')} htmlFor="iw-fuelvar" help={tr('newFields.fuelModeHelp')}>
          <select id="iw-fuelvar" className="sel w-md" value={form.fuelMode} onChange={(e) => edit('fuelMode', e.target.value)}>
            <option value="variable">{tr('newFields.fuelVariable')}</option>
            <option value="fixed">{tr('newFields.fuelFixed')}</option>
          </select>
        </Field>
        <Field label={tr('newFields.validFrom')} htmlFor="iw-from">
          <input id="iw-from" type="date" className="inp w-md" value={form.validFrom} onChange={(e) => edit('validFrom', e.target.value)} />
        </Field>
      </div>
    </section>
  );
}

export type DocTake = { fuel: boolean; from: boolean; service: boolean };

/** Mevcut tarife: belgede bulunan, tarifeden farklı bilgiler (hizmet, yakıt, geçerlilik) — "Kullan" ile alınır. */
export function DocInfoRow({
  current,
  docService,
  docFuel,
  docFrom,
  take,
  setTake,
}: {
  current: { service: string | null; validFrom: string | null; fuelPct?: number };
  docService: string | null;
  docFuel: number | null;
  docFrom: string | null;
  take: DocTake;
  setTake: Dispatch<SetStateAction<DocTake>>;
}) {
  const { t: tr } = useTranslation('tariffImport');
  return (
    <div className="iw-docrow" role="group" aria-label={tr('docInfo.title')}>
      <span className="iw-docrow-k">{tr('docInfo.title')}</span>
      {docService && (
        <DocChip
          on={take.service}
          label={tr('docInfo.service', { value: docService })}
          now={current.service ? tr('docInfo.nowValue', { value: current.service }) : tr('docInfo.nowEmpty')}
          onToggle={() => setTake((t) => ({ ...t, service: !t.service }))}
        />
      )}
      {docFuel != null && (
        <DocChip on={take.fuel} label={tr('docInfo.fuel', { value: fmtNum(docFuel, 0, 2) })} now={tr('docInfo.nowFuel', { value: fmtNum(current.fuelPct ?? 0, 0, 2) })} onToggle={() => setTake((t) => ({ ...t, fuel: !t.fuel }))} />
      )}
      {docFrom && (
        <DocChip
          on={take.from}
          label={tr('docInfo.validFrom', { value: fmtD(docFrom) })}
          now={current.validFrom ? tr('docInfo.nowValue', { value: fmtD(current.validFrom.slice(0, 10)) }) : tr('docInfo.nowEmpty')}
          onToggle={() => setTake((t) => ({ ...t, from: !t.from }))}
        />
      )}
    </div>
  );
}

/** Ayrıntılar › Kontroller: hatalar, uyarılar, bilgi notları. */
export function ChecksDetail({ open, errors, warnings, infos }: { open: boolean; errors: ImportIssue[]; warnings: ImportIssue[]; infos: ImportIssue[] }) {
  const { t: tr } = useTranslation('tariffImport');
  return (
    <Detail
      title={tr('checks.title')}
      open={open}
      meta={
        errors.length ? (
          <Tag tone="red" small>
            {tr('checks.errors', { count: errors.length, formatted: fmtNum(errors.length) })}
          </Tag>
        ) : warnings.length ? (
          <Tag tone="yellow" small>
            {tr('checks.warnings', { count: warnings.length, formatted: fmtNum(warnings.length) })}
          </Tag>
        ) : (
          <Tag tone="green" small>
            {tr('checks.none')}
          </Tag>
        )
      }
    >
      {errors.length > 0 && <IssueList items={errors} />}
      {warnings.length > 0 && <IssueList items={warnings} className={errors.length ? 'mt8' : undefined} />}
      {!errors.length && !warnings.length && (
        <p className="iw-okline">
          <Icon name="ok" /> {tr('checks.noneDetail')}
        </p>
      )}
      {infos.length > 0 && <IssueList items={infos} className="muted mt8" />}
    </Detail>
  );
}

/** Ayrıntılar › Fiyat önizlemesi: uzun tablolarda ilk 30 ağırlık + tüm kg başı bantlar. */
export function PricePreview({ draft, unit, priceCur }: { draft: TariffImportDraft; unit: string; priceCur: string }) {
  const { t: tr } = useTranslation('tariffImport');
  const s = draft.summary;
  const zonesInRates = useMemo(() => Array.from(new Set(draft.rates.map((r) => r.zone))), [draft.rates]);
  const weights = useMemo(() => Array.from(new Set(draft.rates.map((r) => r.weightUpto))).sort((a, b) => a - b), [draft.rates]);
  const { priceOf, perKgW } = useMemo(() => {
    const m = new Map<string, number>();
    const pk = new Set<number>();
    draft.rates.forEach((r) => {
      m.set(`${r.zone}|${r.weightUpto}`, r.price);
      if (r.perKg) pk.add(r.weightUpto);
    });
    return { priceOf: m, perKgW: pk };
  }, [draft.rates]);
  // long tables: first 30 weights + every per-kg band
  const shownW = weights.length > 40 ? Array.from(new Set([...weights.slice(0, 30), ...weights.filter((w) => perKgW.has(w))])) : weights;
  const curSym = currencySymbol(priceCur);
  return (
    <Detail
      title={tr('preview.title')}
      meta={`${tr('units.weights', { count: s.weightCount, formatted: fmtNum(s.weightCount) })} × ${tr('units.zones', { count: s.zoneCount, formatted: fmtNum(s.zoneCount) })} · ${priceCur}`}
    >
      {weights.length === 0 ? (
        <p className="t3 s13">{tr('preview.none')}</p>
      ) : (
        <>
          <div className="tbl-wrap imp-prev">
            <table className="dt compact tight">
              <thead>
                <tr>
                  <th>{tr('preview.weightUpto', { unit })}</th>
                  {zonesInRates.map((z) => (
                    <th key={z} className="r">
                      {z}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownW.map((w) => {
                  const pk = perKgW.has(w);
                  const wi = weights.indexOf(w);
                  return (
                    <tr key={w} className={pk ? 'iw-pk' : undefined}>
                      <td className="num nowrap">
                        {pk ? (
                          <>
                            {bandText(wi > 0 ? weights[wi - 1] : 0, w, unit)} <span className="pk-tag">{tr('preview.perKg')}</span>
                          </>
                        ) : (
                          fmtNum(w, 0, 3)
                        )}
                      </td>
                      {zonesInRates.map((z) => {
                        const p = priceOf.get(`${z}|${w}`);
                        return (
                          <td key={z} className="r num nowrap">
                            {fmtNum(p, 2, 2)}
                            {pk && p != null && <span className="pk-u">{curSym}/kg</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="s12 t3 mt8">
            {shownW.length < weights.length && `${tr('preview.showing', { shown: fmtNum(shownW.length), total: fmtNum(weights.length) })} `}
            {tr('preview.counts', {
              countries: tr('units.countryMappings', { count: s.countryCount, formatted: fmtNum(s.countryCount) }),
              surcharges: tr('units.surcharges', { count: s.surchargeCount, formatted: fmtNum(s.surchargeCount) }),
            })}
          </p>
        </>
      )}
    </Detail>
  );
}

/** Ayrıntılar › Mevcut tarifeyle karşılaştırma (bölge ortancaları; 0,5–2 kat dışı kırmızı). */
export function ComparisonDetail({
  comparison,
  outliers,
  currentCurrency,
  priceCur,
}: {
  comparison: NonNullable<TariffImportDraft['comparison']>;
  outliers: number;
  currentCurrency: string;
  priceCur: string;
}) {
  const { t: tr } = useTranslation('tariffImport');
  return (
    <Detail
      title={tr('compare.title')}
      meta={
        outliers > 0 ? (
          <Tag tone="red" small>
            {tr('compare.bigDiff', { count: outliers, formatted: fmtNum(outliers) })}
          </Tag>
        ) : comparison.length > 0 ? (
          <Tag tone="green" small>
            {tr('compare.consistent')}
          </Tag>
        ) : (
          <span className="t3">{tr('compare.noCommonShort')}</span>
        )
      }
    >
      {comparison.length === 0 ? (
        <p className="t3 s13">{tr('compare.noCommon')}</p>
      ) : (
        <>
          <p className="s12 t3 mb8">{tr('compare.hint')}</p>
          <div className="tbl-wrap iw-cmp">
            <table className="dt compact">
              <thead>
                <tr>
                  <th>{tr('compare.zone')}</th>
                  <th className="r">{tr('compare.ratio')}</th>
                  <th className="r">{tr('compare.current', { currency: currentCurrency })}</th>
                  <th className="r">{tr('compare.thisFile', { currency: priceCur })}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((c) => (
                  <tr key={c.zone} className={isOutlier(c.ratio) ? 'iw-out' : undefined}>
                    <td>{c.zone}</td>
                    <td className="r num">{fmtRatio(c.ratio)}</td>
                    <td className="r num">{fmtNum(c.oldMedian, 2, 2)}</td>
                    <td className="r num">{fmtNum(c.newMedian, 2, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Detail>
  );
}

/** Ayrıntılar › Kaynak ve doğrulama (yalnız PDF). */
export function PdfSourceDetail({ draft }: { draft: TariffImportDraft }) {
  const { t: tr } = useTranslation('tariffImport');
  const ver = draft.verification ?? null;
  const unmatchedN = ver ? ver.unmatched.length || Math.max(0, ver.checked - ver.matched) : 0;
  return (
    <Detail
      title={tr('source.title')}
      meta={
        !ver ? (
          <span className="t3">{tr('source.unverified')}</span>
        ) : unmatchedN ? (
          <Tag tone="yellow" small>
            {tr('source.notFound', { count: unmatchedN, formatted: fmtNum(unmatchedN) })}
          </Tag>
        ) : (
          <Tag tone="green" small>
            {tr('source.same')}
          </Tag>
        )
      }
    >
      <SourceBody draft={draft} />
    </Detail>
  );
}
