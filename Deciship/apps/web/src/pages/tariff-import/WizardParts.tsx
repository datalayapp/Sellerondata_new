import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TariffImportDraft } from '../../api/types';
import { Icon } from '../../components/Icon';
import { fmtNum } from '../../lib/format';
import { pagesText } from '../TariffPdfImport';

export function DocChip({ on, label, now, onToggle }: { on: boolean; label: string; now: string; onToggle: () => void }) {
  const { t } = useTranslation('tariffImport');
  return (
    <span className={`iw-chip${on ? ' on' : ''}`}>
      <span>
        <b>{label}</b> <span className="t3">· {now}</span>
      </span>
      <button type="button" className="link-btn" aria-pressed={on} onClick={onToggle}>
        {on ? (
          <>
            <Icon name="check" /> {t('chip.willUse')}
          </>
        ) : (
          t('chip.use')
        )}
      </button>
    </span>
  );
}

export function SourceBody({ draft }: { draft: TariffImportDraft }) {
  const { t } = useTranslation('tariffImport');
  const v = draft.verification ?? null;
  const src = draft.source;
  const [all, setAll] = useState(false);
  const list = v?.unmatched ?? [];
  const shown = all ? list : list.slice(0, 8);
  return (
    <>
      <p className="s13">
        {!v
          ? t('sourceBody.noText')
          : v.method === 'code'
            ? t(list.length ? 'sourceBody.readDirectMissing' : 'sourceBody.readDirect', {
                checked: t('units.prices', { count: v.checked, formatted: fmtNum(v.checked) }),
                missing: t('units.cells', { count: list.length, formatted: fmtNum(list.length) }),
              })
            : t('sourceBody.matched', { checked: fmtNum(v.checked), matched: fmtNum(v.matched) })}
      </p>
      {list.length > 0 && (
        <div className="tbl-wrap mt8">
          <table className="dt compact">
            <thead>
              <tr>
                <th>{t('sourceBody.zone')}</th>
                <th className="r">{t('sourceBody.weight')}</th>
                <th className="r">{t('sourceBody.price')}</th>
                <th className="r">{t('sourceBody.page')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u, i) => (
                <tr key={`${u.zone}-${u.weight}-${i}`}>
                  <td>{u.zone}</td>
                  <td className="r num">{fmtNum(u.weight, 0, 3)} kg</td>
                  <td className="r num">{fmtNum(u.price, 2, 2)}</td>
                  <td className="r num">{u.page != null ? u.page : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 8 && (
            <button type="button" className="link-btn mt8" onClick={() => setAll(!all)}>
              {all ? t('sourceBody.showLess') : t('sourceBody.showAll', { formatted: fmtNum(list.length) })}
            </button>
          )}
        </div>
      )}
      {src && (
        <p className="s12 t3 mt8">
          {t('sourceBody.tables', { titles: src.sectionTitles.join(' · ') || '—' })}
          {src.pages.length > 0 && <> · {t('sourceBody.pageLabel', { pages: pagesText(src.pages) })}</>}
        </p>
      )}
    </>
  );
}
