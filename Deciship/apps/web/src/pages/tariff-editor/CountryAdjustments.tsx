import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Affix, Button } from '../../components/ui';
import { parseTrNumber } from '../../lib/format';
import { countryNameTr } from '@deciship/core';
import type { Draft } from './draft';
import { Sec, useTariffReadOnly } from './Sec';

type Adj = Draft['adjustments'][number];

/** Ülke adı etkin dile göre: TR için core sözlüğü, diğer diller için Intl. */
function countryLabel(code: string, lang: string): string {
  if (lang.startsWith('tr')) return countryNameTr(code);
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * SPEC §3.8 "Ülke istisnaları": taşıyıcının bazı ülkelere sözleşme tablosundan farklı fiyat uyguladığı durumlar
 * (ör. İspanya'ya ayrı indirim). Yüzde, o ülkenin taşıma bedeline (indirimden sonra, yakıttan önce) uygulanır.
 */
export function CountryAdjustmentsSection({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const { t, i18n } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  const list = d.adjustments ?? [];
  const upd = (i: number, patch: Partial<Adj>) => set({ adjustments: list.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <Sec
      id="te-adj"
      title={t('adjustments.title')}
      desc={t(readOnly ? 'adjustments.descView' : 'adjustments.desc')}
      actions={
        <Button
          kind="secondary"
          small
          icon="plus"
          onClick={() => set({ adjustments: [...list, { country: '', pct: '', note: '', source: 'manual', invoiceId: null }] })}
        >
          {t('adjustments.add')}
        </Button>
      }
    >
      {list.length === 0 ? (
        <p className="te-none">{t('adjustments.empty')}</p>
      ) : (
        <div className="te-mini-wrap">
          <table className="te-mini te-adj">
            <thead>
              <tr>
                <th>{t('adjustments.country')}</th>
                <th>{t('adjustments.diff')}</th>
                <th>{t('adjustments.note')}</th>
                {!readOnly && (
                  <th>
                    <span className="sr-only">{t('common.delete')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => {
                const code = a.country.trim().toUpperCase();
                const badCountry = code !== '' && !/^[A-Z]{2}$/.test(code);
                const pct = parseTrNumber(a.pct);
                const badPct = a.pct.trim() !== '' && (pct === null || pct < -90 || pct > 200);
                const name = /^[A-Z]{2}$/.test(code) ? countryLabel(code, i18n.language) : '';
                return (
                  <tr key={i}>
                    <td className="te-adj-c">
                      <span className="te-adj-cw">
                        <input
                          aria-label={t('adjustments.countryAria', { n: i + 1 })}
                          className={`inp sm mono${badCountry || !code ? ' invalid' : ''}`}
                          maxLength={2}
                          value={a.country}
                          placeholder="ES"
                          onChange={(e) => upd(i, { country: e.target.value.toUpperCase() })}
                        />
                        {name && name !== code && <span className="t2 s13 ellipsis">{name}</span>}
                      </span>
                    </td>
                    <td className="te-adj-p">
                      <Affix sfx="%">
                        <input
                          aria-label={t('adjustments.pctAria', { name: name || code || i + 1 })}
                          className={`inp sm num${badPct || !a.pct.trim() ? ' invalid' : ''}`}
                          inputMode="decimal"
                          value={a.pct}
                          placeholder="-15"
                          onChange={(e) => upd(i, { pct: e.target.value })}
                        />
                      </Affix>
                      {pct != null && !badPct && pct !== 0 && (
                        <span className="te-adj-hint t3 s12">{t(pct < 0 ? 'adjustments.cheaper' : 'adjustments.pricier')}</span>
                      )}
                    </td>
                    <td className="te-adj-n">
                      <input
                        aria-label={t('adjustments.noteAria', { name: name || code || i + 1 })}
                        className="inp sm"
                        value={a.note}
                        placeholder={t('adjustments.notePlaceholder')}
                        onChange={(e) => upd(i, { note: e.target.value })}
                      />
                      {a.source === 'invoice' && (
                        <span className="te-adj-src t3 s12">
                          {t('adjustments.fromInvoice')}
                          {a.invoiceId && (
                            <>
                              {' · '}
                              <Link to={`/invoices/${a.invoiceId}`}>{t('adjustments.openInvoice')}</Link>
                            </>
                          )}
                        </span>
                      )}
                    </td>
                    {!readOnly && (
                      <td>
                        <Button
                          kind="plain"
                          small
                          icon="trash"
                          aria-label={t('adjustments.deleteAria', { name: name || code || i + 1 })}
                          onClick={() => set({ adjustments: list.filter((_, j) => j !== i) })}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Sec>
  );
}
