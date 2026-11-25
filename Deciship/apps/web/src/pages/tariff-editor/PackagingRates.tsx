import { useTranslation } from 'react-i18next';
import type { CarrierCode } from '../../api/types';
import { Icon } from '../../components/Icon';
import { WeightChoice } from '../../components/WeightChoice';
import { Affix, Button, Field } from '../../components/ui';
import { parseTrNumber } from '../../lib/format';
import { packagingName } from '../../lib/packaging';
import { weightChoice } from '../../lib/weightChoice';
import { emptyPackRow, pctFieldState, type Draft, type PackRow, type SpecialPackaging } from './draft';
import { Sec, useTariffReadOnly } from './Sec';

/**
 * Taşıyıcı poşeti (Pak) ve zarfı fiyatları: ana fiyat tablosunun bölgeleriyle ayrı küçük tablo, iki indirim alanı. Boşsa bu
 * gönderiler denetlenmez (kapsam dışı). Fiyatlama kuralı (sınır, hangi fiyat) sunucuda; burada yalnız veri.
 */
export function PackagingRatesSection({ d, set, carrier }: { d: Draft; set: (p: Partial<Draft>) => void; carrier?: CarrierCode | null }) {
  const { t } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  const rows = d.packRows ?? [];
  const name = (p: SpecialPackaging) => packagingName(p, carrier);
  const upd = (i: number, patch: Partial<PackRow>) => set({ packRows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const add = (p: SpecialPackaging) => set({ packRows: [...rows, emptyPackRow(p, d.zones.length)] });
  const showDiscounts = rows.length > 0 || d.pakDiscountPct || d.envelopeDiscountPct;
  const discField = (p: SpecialPackaging, key: 'pakDiscountPct' | 'envelopeDiscountPct') => {
    const v = d[key] ?? '';
    const state = pctFieldState(v);
    return (
      <Field
        label={t('pack.discount', { pack: name(p) })}
        htmlFor={`t-${key}`}
        help={t('pack.discountHelp')}
        error={state === 'unreadable' ? t('pricing.unreadable') : state === 'range' ? t('pricing.range') : null}
      >
        <Affix sfx="%" className="w-sm">
          <input
            id={`t-${key}`}
            className="inp num"
            inputMode="decimal"
            aria-invalid={state !== null || undefined}
            placeholder={d.discountPct || '0'}
            value={v}
            onChange={(e) => set({ [key]: e.target.value })}
          />
        </Affix>
      </Field>
    );
  };
  return (
    <Sec
      id="te-pack"
      title={t('pack.title')}
      desc={t('pack.desc')}
      actions={
        <>
          <Button kind="secondary" small icon="plus" onClick={() => add('PAK')}>
            {name('PAK')}
          </Button>
          <Button kind="secondary" small icon="plus" onClick={() => add('ENVELOPE')}>
            {name('ENVELOPE')}
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="t3 s12">{t(readOnly ? 'pack.emptyView' : 'pack.empty')}</p>
      ) : (
        <div className="rg-wrap" role="group" aria-label={t('pack.tableAria')}>
          <table className="rg rg-packs">
            <thead>
              <tr>
                <th scope="col" className="rg-w rg-pack">
                  {t('pack.packaging')}
                </th>
                <th scope="col" className="rg-zt">
                  {t('weight.steps.upto')} <span className="rg-unit">kg</span>
                </th>
                {d.zones.map((z, c) => (
                  <th key={c} scope="col" className="rg-zt">
                    {z || '—'}
                  </th>
                ))}
                {!readOnly && (
                  <th className="rg-act">
                    <span className="sr-only">{t('grid.deleteRow')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const wv = parseTrNumber(r.upto);
                const wBad = (r.upto.trim() !== '' && (wv ?? 0) <= 0) || weightChoice(r.upto) !== null;
                return (
                  <tr key={i}>
                    <td className="rg-w rg-pack">
                      <select
                        aria-label={t('pack.packagingAria', { n: i + 1 })}
                        className="cell"
                        value={r.packaging}
                        onChange={(e) => upd(i, { packaging: e.target.value as SpecialPackaging })}
                      >
                        <option value="PAK">{name('PAK')}</option>
                        <option value="ENVELOPE">{name('ENVELOPE')}</option>
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={t('pack.weightAria', { n: i + 1 })}
                        className={`cell num${wBad ? ' invalid' : ''}`}
                        inputMode="decimal"
                        value={r.upto}
                        placeholder={t('pack.anyWeight')}
                        onChange={(e) => upd(i, { upto: e.target.value })}
                      />
                      {!readOnly && <WeightChoice value={r.upto} onPick={(v) => upd(i, { upto: v })} />}
                    </td>
                    {r.prices.map((p, c) => (
                      <td key={c}>
                        <input
                          aria-label={t('pack.cellAria', { pack: name(r.packaging), weight: r.upto || t('pack.anyWeight'), zone: d.zones[c] })}
                          className={`cell num${p.trim() && parseTrNumber(p) === null ? ' invalid' : ''}`}
                          inputMode="decimal"
                          value={p}
                          onChange={(e) => upd(i, { prices: r.prices.map((x, j) => (j === c ? e.target.value : x)) })}
                        />
                      </td>
                    ))}
                    {!readOnly && (
                      <td className="rg-act">
                        <button
                          type="button"
                          className="rg-x"
                          aria-label={t('grid.deleteRowAria', { n: i + 1 })}
                          title={t('grid.deleteRow')}
                          onClick={() => set({ packRows: rows.filter((_, j) => j !== i) })}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {showDiscounts && (
        <div className="form-grid c3 mt16">
          {discField('PAK', 'pakDiscountPct')}
          {discField('ENVELOPE', 'envelopeDiscountPct')}
        </div>
      )}
    </Sec>
  );
}
