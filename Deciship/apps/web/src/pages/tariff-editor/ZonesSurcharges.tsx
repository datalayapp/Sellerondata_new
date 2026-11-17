import { useTranslation } from 'react-i18next';
import type { SurchargeKind } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Affix, Button } from '../../components/ui';
import { parseTrNumber } from '../../lib/format';
import { curSym, type Draft } from './draft';
import { Sec, useTariffReadOnly } from './Sec';

export function ZonesSection({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  return (
    <Sec
      id="te-zones"
      title={t('zones.title')}
      desc={t('zones.desc')}
      actions={
        <Button kind="secondary" small icon="plus" onClick={() => set({ countryZones: [...d.countryZones, { country: '', zone: 0 }] })}>
          {t('zones.add')}
        </Button>
      }
    >
      {d.countryZones.length === 0 ? (
        <div className="notif warn">
          <Icon name="warn" />
          <span>{t('zones.empty')}</span>
        </div>
      ) : (
        <ul className="cz-list">
          {d.countryZones.map((cz, i) => {
            const badCountry = cz.country.trim() !== '' && cz.country.trim() !== '*' && !/^[A-Za-z]{2}$/.test(cz.country.trim());
            // eşleme sütuna bağlıdır (draft.ts `countryZones`); -1 = tabloda olmayan bölge
            const known = cz.zone >= 0 && cz.zone < d.zones.length;
            return (
              <li key={i} className="cz">
                <input
                  aria-label={t('zones.countryAria', { n: i + 1 })}
                  className={`inp sm mono cz-c${badCountry ? ' invalid' : ''}`}
                  maxLength={2}
                  value={cz.country}
                  placeholder="DE"
                  onChange={(e) => set({ countryZones: d.countryZones.map((x, j) => (j === i ? { ...x, country: e.target.value.toUpperCase() } : x)) })}
                />
                <Icon name="arrow" className="cz-arr" />
                <select
                  aria-label={t('zones.zoneAria', { n: i + 1 })}
                  className={`sel sm cz-z${!known ? ' invalid' : ''}`}
                  value={known ? String(cz.zone) : ''}
                  onChange={(e) => set({ countryZones: d.countryZones.map((x, j) => (j === i ? { ...x, zone: Number(e.target.value) } : x)) })}
                >
                  {!known && <option value="">—</option>}
                  {d.zones.map((z, c) => (
                    <option key={c} value={String(c)}>
                      {z || '—'}
                    </option>
                  ))}
                </select>
                {!readOnly && <Button kind="plain" small icon="trash" aria-label={t('zones.deleteAria', { name: cz.country || i + 1 })} onClick={() => set({ countryZones: d.countryZones.filter((_, j) => j !== i) })} />}
              </li>
            );
          })}
        </ul>
      )}
    </Sec>
  );
}

export function SurchargesSection({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  const upd = (i: number, patch: Partial<Draft['surcharges'][number]>) => set({ surcharges: d.surcharges.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const unit = (k: SurchargeKind) => (k === 'PCT' ? '%' : k === 'PER_KG' ? `${curSym(d.currency)}/kg` : curSym(d.currency));
  return (
    <Sec
      id="te-sur"
      title={t('surcharges.title')}
      desc={t('surcharges.desc')}
      actions={
        <Button kind="secondary" small icon="plus" onClick={() => set({ surcharges: [...d.surcharges, { code: '', name: '', kind: 'FIXED', amount: '' }] })}>
          {t('surcharges.add')}
        </Button>
      }
    >
      {d.surcharges.length === 0 ? (
        <p className="te-none">{t('surcharges.empty')}</p>
      ) : (
        <div className="te-mini-wrap">
          <table className="te-mini te-sur">
            <thead>
              <tr>
                <th>{t('surcharges.code')}</th>
                <th>{t('surcharges.name')}</th>
                <th>{t('surcharges.kind')}</th>
                <th>{t('surcharges.amount')}</th>
                {!readOnly && (
                  <th>
                    <span className="sr-only">{t('common.delete')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {d.surcharges.map((s, i) => (
                <tr key={i}>
                  <td className="te-sur-code">
                    <input aria-label={t('surcharges.code')} className={`inp sm mono${!s.code.trim() ? ' invalid' : ''}`} value={s.code} title={s.code || undefined} placeholder="RES" onChange={(e) => upd(i, { code: e.target.value.toUpperCase() })} />
                  </td>
                  <td className="te-sur-name">
                    <input aria-label={t('surcharges.name')} className="inp sm" value={s.name} placeholder={t('surcharges.namePlaceholder')} onChange={(e) => upd(i, { name: e.target.value })} />
                  </td>
                  <td className="te-sur-kind">
                    <select aria-label={t('surcharges.kind')} className="sel sm" value={s.kind} onChange={(e) => upd(i, { kind: e.target.value as SurchargeKind })}>
                      {(['FIXED', 'PCT', 'PER_KG'] as SurchargeKind[]).map((k) => (
                        <option key={k} value={k}>
                          {t(`surcharges.kinds.${k}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="te-sur-amt">
                    <Affix sfx={unit(s.kind)} className={s.kind === 'PER_KG' ? 'long' : undefined}>
                      <input
                        aria-label={t('surcharges.amount')}
                        className={`inp sm num${parseTrNumber(s.amount) === null ? ' invalid' : ''}`}
                        inputMode="decimal"
                        value={s.amount}
                        onChange={(e) => upd(i, { amount: e.target.value })}
                      />
                    </Affix>
                  </td>
                  {!readOnly && (
                    <td>
                      <Button kind="plain" small icon="trash" aria-label={t('surcharges.deleteAria')} onClick={() => set({ surcharges: d.surcharges.filter((_, j) => j !== i) })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Sec>
  );
}
